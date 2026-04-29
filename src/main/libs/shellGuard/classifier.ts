import { createHash } from 'node:crypto';

import {
  buildAnthropicMessagesUrl,
  buildGeminiGenerateContentUrl,
  type CoworkLlmApiConfig,
  CoworkModelProtocol,
  extractApiErrorSnippet,
  extractTextFromAnthropicResponse,
  extractTextFromGeminiResponse,
} from '../coworkModelApi';
import {
  SHELL_GUARD_CACHE_TTL_MS,
  ShellGuardClassifierResult,
} from './constants';
import { normalizeCommand } from './rules';

export type { CoworkLlmApiConfig };

export const CLASSIFIER_SYSTEM_PROMPT = `You are a security classifier for an AI coding agent's shell tool. Your sole job is to decide whether a proposed shell command is safe to run automatically or must be blocked.

You MUST reply with a single line of JSON and nothing else:
{"verdict": "ALLOW" | "BLOCK", "reason": "<one short sentence>"}

BLOCK if the command:
- Mass deletes files outside the working directory
- Exfiltrates secrets (.env, .ssh, keychain, browser data, cloud creds) to a host not declared in the user intent
- Executes code from untrusted network sources (curl|sh, wget|bash, eval $(curl ...), base64 -d | sh, npx of unverified packages)
- Modifies SSH keys, shell rc files, sudoers, system credentials, or hosts file
- Force-pushes, --mirror pushes, or rewrites public git history on protected branches
- Escalates privileges (sudo, chmod 777, chown -R on system paths, --privileged)
- Installs packages or kernel modules that are unrelated to the user's stated intent
- Touches paths the user did not mention or imply

Otherwise ALLOW.

Be conservative: when uncertain, BLOCK and explain why in the reason.`;

export interface ClassifierContext {
  readonly command: string;
  readonly cwd: string;
  readonly userIntent: string;
  readonly recentToolCalls: readonly string[];
}

export interface ClassifierVerdict {
  readonly verdict: typeof ShellGuardClassifierResult.Allow | typeof ShellGuardClassifierResult.Block;
  readonly reason: string;
}

export interface ClassifierError {
  readonly errorKind: 'timeout' | 'no-config' | 'http-error' | 'parse-error' | 'transport-error';
  readonly message: string;
}

export type ClassifierOutcome =
  | { kind: 'verdict'; verdict: ClassifierVerdict; cached: boolean }
  | { kind: 'error'; error: ClassifierError };

export interface ClassifierTransportRequest {
  readonly config: CoworkLlmApiConfig;
  readonly modelOverride: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * Pluggable LLM transport.  Returns the raw text response from the
 * model.  The default implementation lives in this module and uses
 * the cowork main API config (Anthropic / Gemini native).  Tests pass
 * a fake transport.
 */
export type ClassifierTransport = (req: ClassifierTransportRequest) => Promise<string>;

export interface ClassifierOptions {
  readonly modelOverride?: string;
  readonly timeoutMs: number;
  readonly transport?: ClassifierTransport;
  readonly resolveConfig: () => { config: CoworkLlmApiConfig | null; error?: string };
  readonly cache?: ClassifierCache;
  readonly now?: () => number;
}

export interface ClassifierCache {
  get(key: string): ClassifierVerdict | null;
  set(key: string, verdict: ClassifierVerdict): void;
}

interface CacheEntry {
  verdict: ClassifierVerdict;
  expiresAt: number;
}

export class InMemoryClassifierCache implements ClassifierCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number = SHELL_GUARD_CACHE_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  get(key: string): ClassifierVerdict | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return null;
    }
    return entry.verdict;
  }

  set(key: string, verdict: ClassifierVerdict): void {
    this.entries.set(key, { verdict, expiresAt: this.clock() + this.ttlMs });
  }
}

const QUOTED_STRING = /(?:"[^"]*"|'[^']*')/g;
const NUMBER_TOKEN = /\b\d+\b/g;
const ABSOLUTE_PATH = /(?<![\w\/])(?:\.{0,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)+/g;

/**
 * Stable cache key that ignores volatile arguments (numbers, quoted
 * strings, absolute paths) so e.g. `git log -n 50` and `git log -n 100`
 * collapse to the same template.
 */
export function buildCommandTemplate(command: string): string {
  return normalizeCommand(command)
    .replace(QUOTED_STRING, '"<STR>"')
    .replace(ABSOLUTE_PATH, '<PATH>')
    .replace(NUMBER_TOKEN, '<NUM>');
}

export function buildClassifierCacheKey(command: string, cwd: string): string {
  const template = buildCommandTemplate(command);
  return createHash('sha256').update(`${cwd}\u0000${template}`).digest('hex');
}

export function buildClassifierUserPrompt(ctx: ClassifierContext): string {
  const recent = ctx.recentToolCalls.length
    ? ctx.recentToolCalls.slice(-3).map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '(none)';
  const intent = ctx.userIntent.trim() || '(no recent user message)';
  return [
    `Working directory: ${ctx.cwd}`,
    `User's most recent intent:`,
    intent,
    '',
    `Recent tool calls (last 3):`,
    recent,
    '',
    `Proposed command:`,
    ctx.command,
  ].join('\n');
}

const VERDICT_ALLOW = ShellGuardClassifierResult.Allow;
const VERDICT_BLOCK = ShellGuardClassifierResult.Block;

export function parseClassifierResponse(raw: string): ClassifierVerdict | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? jsonMatch[0] : trimmed;

  try {
    const parsed = JSON.parse(candidate) as { verdict?: unknown; reason?: unknown };
    const verdictStr = typeof parsed.verdict === 'string' ? parsed.verdict.toUpperCase() : '';
    if (verdictStr !== VERDICT_ALLOW && verdictStr !== VERDICT_BLOCK) return null;
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 240) : '';
    return {
      verdict: verdictStr,
      reason: reason || (verdictStr === VERDICT_BLOCK ? 'classifier blocked the command' : 'classifier allowed the command'),
    };
  } catch {
    return null;
  }
}

const defaultTransport: ClassifierTransport = async (req) => {
  const url = req.config.protocol === CoworkModelProtocol.GeminiNative
    ? buildGeminiGenerateContentUrl(req.config.baseURL, req.modelOverride || req.config.model)
    : buildAnthropicMessagesUrl(req.config.baseURL);

  const headers: Record<string, string> = req.config.protocol === CoworkModelProtocol.GeminiNative
    ? {
      'Content-Type': 'application/json',
      'x-goog-api-key': req.config.apiKey,
    }
    : {
      'Content-Type': 'application/json',
      'x-api-key': req.config.apiKey,
      'anthropic-version': '2023-06-01',
    };

  const body = req.config.protocol === CoworkModelProtocol.GeminiNative
    ? {
      contents: [
        { role: 'user', parts: [{ text: `${req.systemPrompt}\n\n${req.userPrompt}` }] },
      ],
      generationConfig: { maxOutputTokens: 200, temperature: 0 },
    }
    : {
      model: req.modelOverride || req.config.model,
      max_tokens: 200,
      temperature: 0,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }],
    };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new ClassifierHttpError(response.status, extractApiErrorSnippet(errorText));
  }

  const payload = await response.json();
  return req.config.protocol === CoworkModelProtocol.GeminiNative
    ? extractTextFromGeminiResponse(payload)
    : extractTextFromAnthropicResponse(payload);
};

class ClassifierHttpError extends Error {
  constructor(public readonly status: number, public readonly snippet: string) {
    super(`HTTP ${status}: ${snippet}`);
    this.name = 'ClassifierHttpError';
  }
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'name' in err && (err as { name?: string }).name === 'AbortError';
}

/**
 * Run the classifier for a single command.  Caches verdicts (24h TTL
 * by default) keyed by sha256(cwd + command template).
 */
export async function classifyCommand(
  ctx: ClassifierContext,
  options: ClassifierOptions,
): Promise<ClassifierOutcome> {
  const cache = options.cache;
  const cacheKey = cache ? buildClassifierCacheKey(ctx.command, ctx.cwd) : null;

  if (cache && cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return { kind: 'verdict', verdict: cached, cached: true };
    }
  }

  const resolveConfig = options.resolveConfig;
  const { config, error } = resolveConfig();
  if (!config) {
    return {
      kind: 'error',
      error: { errorKind: 'no-config', message: error || 'No LLM API config available for shell-guard classifier' },
    };
  }

  const transport = options.transport ?? defaultTransport;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const userPrompt = buildClassifierUserPrompt(ctx);

  try {
    const raw = await transport({
      config,
      modelOverride: options.modelOverride?.trim() || '',
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      userPrompt,
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
    });
    const parsed = parseClassifierResponse(raw);
    if (!parsed) {
      return {
        kind: 'error',
        error: { errorKind: 'parse-error', message: `classifier returned unparseable output: ${raw.slice(0, 200)}` },
      };
    }
    if (cache && cacheKey) {
      cache.set(cacheKey, parsed);
    }
    return { kind: 'verdict', verdict: parsed, cached: false };
  } catch (err) {
    if (isAbortError(err)) {
      return {
        kind: 'error',
        error: { errorKind: 'timeout', message: `classifier timed out after ${options.timeoutMs}ms` },
      };
    }
    if (err instanceof ClassifierHttpError) {
      return {
        kind: 'error',
        error: { errorKind: 'http-error', message: err.message },
      };
    }
    return {
      kind: 'error',
      error: { errorKind: 'transport-error', message: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    clearTimeout(timer);
  }
}
