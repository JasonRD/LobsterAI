/**
 * User-defined shell-guard deny/allow patterns.
 *
 * Each line in the user's textarea is one pattern.  Three syntaxes
 * are supported (in this order of detection):
 *
 *   1. Slash-delimited regex:  /^docker\s+rm\b/  /pattern/i
 *   2. Glob:                   git push * --force   (`*` matches a
 *                              run of non-newline chars including
 *                              spaces, `?` matches a single char)
 *   3. Prefix (default):       pnpm install        (matches any
 *                              command that starts with this string,
 *                              token-aligned: `pnpm` does NOT match
 *                              `pnpmx`)
 *
 * Lines starting with `#` are treated as comments and ignored.
 * Blank lines are ignored.
 */

import { normalizeCommand } from './rules';

export type UserRuleSyntax = 'regex' | 'glob' | 'prefix';

export interface UserRule {
  readonly raw: string;
  readonly syntax: UserRuleSyntax;
  readonly pattern: RegExp;
}

const REGEX_SYNTAX = /^\/(.+)\/([gimsuy]*)$/;

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function compileGlob(pattern: string): RegExp {
  // `*` → `.*`, `?` → `.`, everything else escaped.  Anchored full-match.
  let out = '^';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += escapeRegex(ch);
  }
  out += '$';
  return new RegExp(out);
}

function compilePrefix(pattern: string): RegExp {
  // Token-aligned prefix: must match start AND be followed by a word
  // boundary or end of string.  Prevents `pnpm` matching `pnpmx`.
  return new RegExp(`^${escapeRegex(pattern)}(?:\\s|$)`);
}

/** Parse one pattern line into a compiled rule, or null if invalid. */
export function parseUserRuleLine(line: string): UserRule | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const regexMatch = trimmed.match(REGEX_SYNTAX);
  if (regexMatch) {
    try {
      return {
        raw: trimmed,
        syntax: 'regex',
        pattern: new RegExp(regexMatch[1], regexMatch[2]),
      };
    } catch {
      return null;
    }
  }

  if (trimmed.includes('*') || trimmed.includes('?')) {
    try {
      return { raw: trimmed, syntax: 'glob', pattern: compileGlob(trimmed) };
    } catch {
      return null;
    }
  }

  return { raw: trimmed, syntax: 'prefix', pattern: compilePrefix(trimmed) };
}

/** Parse a multi-line text blob into compiled rules.  Invalid lines are dropped. */
export function parseUserRules(text: string | null | undefined): readonly UserRule[] {
  if (!text) return [];
  const out: UserRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const rule = parseUserRuleLine(line);
    if (rule) out.push(rule);
  }
  return out;
}

export interface UserRuleMatch {
  readonly raw: string;
  readonly syntax: UserRuleSyntax;
}

/** Return the first matching rule, or null. */
export function matchUserRules(
  command: string,
  rules: readonly UserRule[],
): UserRuleMatch | null {
  if (!rules.length) return null;
  const normalized = normalizeCommand(command);
  if (!normalized) return null;
  for (const rule of rules) {
    if (rule.pattern.test(normalized)) {
      return { raw: rule.raw, syntax: rule.syntax };
    }
  }
  return null;
}
