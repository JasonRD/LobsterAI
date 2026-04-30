/**
 * Shell Guard module constants.
 *
 * Centralized values for shell-execution safety: operating modes, classifier
 * verdicts, block reasons, and IPC channels.  All consumers (main, renderer,
 * tests) must import from here rather than using bare string literals.
 */

export const ShellGuardMode = {
  AskAlways: 'ask-always',
  Auto: 'auto',
  SkipAll: 'skip-all',
} as const;

export type ShellGuardMode = typeof ShellGuardMode[keyof typeof ShellGuardMode];

export const ShellGuardVerdict = {
  Allow: 'allow',
  Deny: 'deny',
  Escalate: 'escalate',
} as const;

export type ShellGuardVerdict = typeof ShellGuardVerdict[keyof typeof ShellGuardVerdict];

export const ShellGuardSource = {
  HardAllow: 'hard-allow',
  HardDeny: 'hard-deny',
  UserHardAllow: 'user-hard-allow',
  UserHardDeny: 'user-hard-deny',
  Classifier: 'classifier',
  ClassifierEscalate: 'classifier-escalate',
  ClassifierFallback: 'classifier-fallback',
  Escalate: 'escalate',
  ModeSkipAll: 'mode-skip-all',
  ModeAskAlways: 'mode-ask-always',
} as const;

export type ShellGuardSource = typeof ShellGuardSource[keyof typeof ShellGuardSource];

export const ShellGuardClassifierResult = {
  Allow: 'ALLOW',
  Escalate: 'ESCALATE',
  Block: 'BLOCK',
} as const;

export type ShellGuardClassifierResult =
  typeof ShellGuardClassifierResult[keyof typeof ShellGuardClassifierResult];

export const SHELL_GUARD_DEFAULT_MODE: ShellGuardMode = ShellGuardMode.Auto;
export const SHELL_GUARD_DEFAULT_CLASSIFIER_PROVIDER = '';
export const SHELL_GUARD_DEFAULT_CLASSIFIER_MODEL = '';
export const SHELL_GUARD_DEFAULT_CLASSIFIER_TIMEOUT_MS = 8000;
export const SHELL_GUARD_DEFAULT_ESCALATE_THRESHOLD = 3;

export const SHELL_GUARD_MIN_CLASSIFIER_TIMEOUT_MS = 1000;
export const SHELL_GUARD_MAX_CLASSIFIER_TIMEOUT_MS = 60000;
export const SHELL_GUARD_MIN_ESCALATE_THRESHOLD = 1;
export const SHELL_GUARD_MAX_ESCALATE_THRESHOLD = 20;

export const SHELL_GUARD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizeShellGuardMode(value: string | undefined | null): ShellGuardMode {
  switch (value) {
    case ShellGuardMode.AskAlways:
    case ShellGuardMode.Auto:
    case ShellGuardMode.SkipAll:
      return value;
    default:
      return SHELL_GUARD_DEFAULT_MODE;
  }
}

export function clampClassifierTimeoutMs(value: number | undefined | null): number {
  const n = typeof value === 'number' && Number.isFinite(value)
    ? value
    : SHELL_GUARD_DEFAULT_CLASSIFIER_TIMEOUT_MS;
  return Math.max(
    SHELL_GUARD_MIN_CLASSIFIER_TIMEOUT_MS,
    Math.min(SHELL_GUARD_MAX_CLASSIFIER_TIMEOUT_MS, Math.round(n)),
  );
}

export function clampEscalateThreshold(value: number | undefined | null): number {
  const n = typeof value === 'number' && Number.isFinite(value)
    ? value
    : SHELL_GUARD_DEFAULT_ESCALATE_THRESHOLD;
  return Math.max(
    SHELL_GUARD_MIN_ESCALATE_THRESHOLD,
    Math.min(SHELL_GUARD_MAX_ESCALATE_THRESHOLD, Math.round(n)),
  );
}
