import {
  type ClassifierCache,
  type ClassifierContext,
  type ClassifierOutcome,
  type ClassifierTransport,
  classifyCommand,
  type CoworkLlmApiConfig,
  InMemoryClassifierCache,
} from './classifier';
import { buildCommandTemplate } from './classifier';
import {
  SHELL_GUARD_DEFAULT_CLASSIFIER_TIMEOUT_MS,
  SHELL_GUARD_DEFAULT_ESCALATE_THRESHOLD,
  ShellGuardClassifierResult,
  ShellGuardMode,
  ShellGuardSource,
  ShellGuardVerdict,
} from './constants';
import { evaluateHardRules } from './rules';
import { matchUserRules, type UserRule } from './userRules';

export interface ShellGuardEvaluation {
  readonly verdict: ShellGuardVerdict;
  readonly source: ShellGuardSource;
  readonly reason: string;
  readonly ruleId?: string;
  readonly classifierCached?: boolean;
  readonly classifierError?: string;
  readonly escalationCount?: number;
  readonly suggestedAlternative?: string;
  readonly mode: ShellGuardMode;
}

export interface ShellGuardEvaluateOptions {
  readonly mode: ShellGuardMode;
  readonly command: string;
  readonly cwd: string;
  readonly userIntent: string;
  readonly recentToolCalls: readonly string[];
  readonly classifierModel?: string;
  readonly classifierTimeoutMs?: number;
  readonly escalateThreshold?: number;
  readonly userDenyRules?: readonly UserRule[];
  readonly userAllowRules?: readonly UserRule[];
  readonly resolveConfig: () => { config: CoworkLlmApiConfig | null; error?: string };
  readonly transport?: ClassifierTransport;
  readonly cache?: ClassifierCache;
  readonly escalation?: EscalationCounter;
}

/**
 * Per-session counter for repeated classifier BLOCK verdicts.  When
 * the same command template is blocked `threshold` times in a row,
 * the next attempt escalates to a manual permission prompt instead of
 * silently denying the agent (the agent may genuinely need it).
 */
export class EscalationCounter {
  private readonly counts = new Map<string, number>();

  bump(template: string): number {
    const next = (this.counts.get(template) ?? 0) + 1;
    this.counts.set(template, next);
    return next;
  }

  reset(template: string): void {
    this.counts.delete(template);
  }

  get(template: string): number {
    return this.counts.get(template) ?? 0;
  }
}

const sharedCache = new InMemoryClassifierCache();

export function getSharedClassifierCache(): ClassifierCache {
  return sharedCache;
}

/**
 * Decide what to do with a single proposed shell command.
 *
 * The result drives the OpenClaw permission response:
 *   - allow    → respond { behavior: 'allow' }
 *   - deny     → respond { behavior: 'deny', message: reason }
 *   - escalate → defer to the existing manual permission prompt UI
 */
export async function evaluateShellGuard(
  options: ShellGuardEvaluateOptions,
): Promise<ShellGuardEvaluation> {
  const { mode, command } = options;

  if (mode === ShellGuardMode.SkipAll) {
    return {
      verdict: ShellGuardVerdict.Allow,
      source: ShellGuardSource.ModeSkipAll,
      reason: 'shell-guard mode is skip-all',
      mode,
    };
  }

  if (mode === ShellGuardMode.AskAlways) {
    return {
      verdict: ShellGuardVerdict.Escalate,
      source: ShellGuardSource.ModeAskAlways,
      reason: 'shell-guard mode is ask-always',
      mode,
    };
  }

  // ShellGuardMode.Auto from here on.
  // Evaluation order: UserHardDeny → HardDeny → UserHardAllow → HardAllow → classifier.
  // User deny wins over everything (even classifier ESCALATE);
  // hard deny wins over user allow (we never let users disable
  // built-in rm-rf-/ rules); user allow wins over hard allow.
  const userDeny = matchUserRules(command, options.userDenyRules ?? []);
  if (userDeny) {
    return {
      verdict: ShellGuardVerdict.Deny,
      source: ShellGuardSource.UserHardDeny,
      reason: `matched user deny rule (${userDeny.syntax}): ${userDeny.raw}`,
      mode,
    };
  }

  const hard = evaluateHardRules(command);
  if (hard.kind === 'deny') {
    return {
      verdict: ShellGuardVerdict.Deny,
      source: ShellGuardSource.HardDeny,
      reason: hard.reason,
      ruleId: hard.ruleId,
      mode,
    };
  }

  const userAllow = matchUserRules(command, options.userAllowRules ?? []);
  if (userAllow) {
    return {
      verdict: ShellGuardVerdict.Allow,
      source: ShellGuardSource.UserHardAllow,
      reason: `matched user allow rule (${userAllow.syntax}): ${userAllow.raw}`,
      mode,
    };
  }

  if (hard.kind === 'allow') {
    return {
      verdict: ShellGuardVerdict.Allow,
      source: ShellGuardSource.HardAllow,
      reason: hard.reason,
      ruleId: hard.ruleId,
      mode,
    };
  }

  const ctx: ClassifierContext = {
    command,
    cwd: options.cwd,
    userIntent: options.userIntent,
    recentToolCalls: options.recentToolCalls,
  };
  const outcome: ClassifierOutcome = await classifyCommand(ctx, {
    modelOverride: options.classifierModel,
    timeoutMs: options.classifierTimeoutMs ?? SHELL_GUARD_DEFAULT_CLASSIFIER_TIMEOUT_MS,
    transport: options.transport,
    resolveConfig: options.resolveConfig,
    cache: options.cache ?? sharedCache,
  });

  if (outcome.kind === 'error') {
    return {
      verdict: ShellGuardVerdict.Escalate,
      source: ShellGuardSource.ClassifierFallback,
      reason: `classifier unavailable (${outcome.error.errorKind}); falling back to manual approval`,
      classifierError: outcome.error.message,
      mode,
    };
  }

  const classifierVerdict = outcome.verdict.verdict;
  const alternative = outcome.verdict.suggestedAlternative;

  if (classifierVerdict === ShellGuardClassifierResult.Allow) {
    if (options.escalation) {
      options.escalation.reset(buildCommandTemplate(command));
    }
    return {
      verdict: ShellGuardVerdict.Allow,
      source: ShellGuardSource.Classifier,
      reason: outcome.verdict.reason,
      classifierCached: outcome.cached,
      mode,
    };
  }

  if (classifierVerdict === ShellGuardClassifierResult.Escalate) {
    // Classifier itself asked for human approval — bypass the BLOCK
    // counter (this isn't a refusal we want the agent to retry).
    if (options.escalation) {
      options.escalation.reset(buildCommandTemplate(command));
    }
    return {
      verdict: ShellGuardVerdict.Escalate,
      source: ShellGuardSource.ClassifierEscalate,
      reason: outcome.verdict.reason,
      classifierCached: outcome.cached,
      ...(alternative ? { suggestedAlternative: alternative } : {}),
      mode,
    };
  }

  // BLOCK verdict.
  const threshold = Math.max(1, options.escalateThreshold ?? SHELL_GUARD_DEFAULT_ESCALATE_THRESHOLD);
  const escalation = options.escalation;
  if (escalation) {
    const template = buildCommandTemplate(command);
    const count = escalation.bump(template);
    if (count >= threshold) {
      escalation.reset(template);
      return {
        verdict: ShellGuardVerdict.Escalate,
        source: ShellGuardSource.Escalate,
        reason: `agent has been blocked ${count} times for the same command pattern; asking the user`,
        classifierCached: outcome.cached,
        escalationCount: count,
        ...(alternative ? { suggestedAlternative: alternative } : {}),
        mode,
      };
    }
    return {
      verdict: ShellGuardVerdict.Deny,
      source: ShellGuardSource.Classifier,
      reason: outcome.verdict.reason,
      classifierCached: outcome.cached,
      escalationCount: count,
      ...(alternative ? { suggestedAlternative: alternative } : {}),
      mode,
    };
  }

  return {
    verdict: ShellGuardVerdict.Deny,
    source: ShellGuardSource.Classifier,
    reason: outcome.verdict.reason,
    classifierCached: outcome.cached,
    ...(alternative ? { suggestedAlternative: alternative } : {}),
    mode,
  };
}

/**
 * Format the deny reason that gets sent back to the agent so it can
 * pick a different approach.  Kept short to avoid bloating tool-call
 * transcripts.
 */
export function formatDenyMessageForAgent(evaluation: ShellGuardEvaluation): string {
  const tag =
    evaluation.source === ShellGuardSource.HardDeny
      ? 'shell-guard:hard-deny'
      : evaluation.source === ShellGuardSource.UserHardDeny
        ? 'shell-guard:user-deny'
        : 'shell-guard:classifier';
  const altLine = evaluation.suggestedAlternative
    ? ` Suggested alternative: ${evaluation.suggestedAlternative}.`
    : '';
  return `[${tag}] BLOCKED: ${evaluation.reason}.${altLine} Take a different approach to accomplish the user's goal — do NOT retry this exact command. If you believe the block is wrong, ask the user to confirm before retrying.`;
}
