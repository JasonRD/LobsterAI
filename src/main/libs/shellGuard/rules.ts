/**
 * Hard deny/allow regex rules for the shell-guard.
 *
 * These rules run before the LLM classifier in `auto` mode:
 *   - HARD_DENY  → command is rejected immediately, never executed
 *   - HARD_ALLOW → command is approved immediately, no model call
 *   - neither   → falls through to the classifier
 *
 * Patterns are intentionally conservative: false positives waste a
 * classifier call (cheap), false negatives mean a destructive command
 * runs (expensive).  When in doubt, do NOT add it to HARD_ALLOW.
 *
 * Whitespace handling: every command is collapsed to single spaces
 * before matching, so patterns can assume `\s+` between tokens.
 */

export interface ShellRulePattern {
  readonly id: string;
  readonly pattern: RegExp;
  readonly reason: string;
}

const RM_RECURSIVE_FORCE = /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+/;

export const HARD_DENY_RULES: readonly ShellRulePattern[] = [
  {
    id: 'rm-rf-root',
    // Matches recursive force-rm targeting filesystem root in any of the
    // common dangerous spellings:  / , /* , /. , /.* , /./* , ./* , "/"
    // Trailing context allows shell separators (; & |) too so e.g.
    // `rm -rf /;ls` doesn't sneak past.
    pattern: new RegExp(
      `${RM_RECURSIVE_FORCE.source}`
      + `(?:`
      + `(?:"\\s*/\\s*"|'\\s*/\\s*')` // "/" or '/'
      + `|\\.?/(?:\\.\\*?|\\*)?` // /, /*, /., /.*, ./*
      + `)`
      + `(?:\\s|$|/|[;&|])`,
    ),
    reason: 'recursive delete targeting filesystem root',
  },
  {
    id: 'rm-rf-home',
    pattern: new RegExp(`${RM_RECURSIVE_FORCE.source}(?:\\$HOME|~|/Users/[^/\\s]+|/home/[^/\\s]+)(?:\\s|/|$)`),
    reason: 'recursive delete targeting user home directory',
  },
  {
    id: 'rm-rf-system-path',
    pattern: new RegExp(`${RM_RECURSIVE_FORCE.source}(?:/etc|/var|/usr|/bin|/sbin|/boot|/sys|/proc)(?:/|\\s|$)`),
    reason: 'recursive delete targeting system path',
  },
  {
    id: 'dd-to-device',
    pattern: /\bdd\b[^|;&]*\bof=\/dev\//,
    reason: 'dd writing to a raw device node',
  },
  {
    id: 'mkfs',
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\//,
    reason: 'filesystem creation on a device',
  },
  {
    id: 'fork-bomb',
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: 'classic fork bomb',
  },
  {
    id: 'ssh-authorized-keys-write',
    pattern: /(?:>>?|tee\s+(?:-a\s+)?)[^|;&\n]*\.ssh\/authorized_keys/,
    reason: 'writing to SSH authorized_keys',
  },
  {
    id: 'ssh-private-key-write',
    pattern: /(?:>>?|tee\s+(?:-a\s+)?)[^|;&\n]*\.ssh\/id_(?:rsa|dsa|ecdsa|ed25519)\b/,
    reason: 'writing to a private SSH key',
  },
  {
    id: 'chmod-777-root',
    pattern: /\bchmod\s+(?:-R\s+)?(?:0)?777\s+\//,
    reason: 'chmod 777 on a root path',
  },
  {
    id: 'chown-recursive-root',
    pattern: /\bchown\s+-R\s+[^\s]+\s+\//,
    reason: 'recursive chown on a root path',
  },
  {
    id: 'curl-pipe-shell',
    pattern: /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/,
    reason: 'piping network download into a shell',
  },
  {
    id: 'base64-pipe-shell',
    pattern: /\bbase64\s+-d\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/,
    reason: 'decoding base64 payload directly into a shell',
  },
  {
    id: 'eval-curl',
    pattern: /\beval\s+(?:"\$\(|\$\(|`)\s*(?:curl|wget)\b/,
    reason: 'eval of network-fetched payload',
  },
  {
    id: 'docker-privileged',
    pattern: /\bdocker\s+(?:container\s+)?run\b[^|;&\n]*--privileged\b/,
    reason: 'docker run with --privileged',
  },
  {
    id: 'git-force-push-main',
    pattern: /\bgit\s+push\b[^|;&\n]*(?:--force\b|--force-with-lease\b|-f\b)[^|;&\n]*\b(?:main|master|trunk|release(?:-[\w.-]+)?)\b/,
    reason: 'force-pushing to a protected branch',
  },
  {
    id: 'git-history-rewrite-push',
    pattern: /\bgit\s+push\b[^|;&\n]*--mirror\b/,
    reason: 'git push --mirror rewrites remote history',
  },
];

export const HARD_ALLOW_RULES: readonly ShellRulePattern[] = [
  { id: 'pwd', pattern: /^pwd$/, reason: 'print working directory' },
  { id: 'whoami', pattern: /^whoami$/, reason: 'print current user' },
  { id: 'hostname', pattern: /^hostname$/, reason: 'print hostname' },
  { id: 'date', pattern: /^date(?:\s+[+-][\w%:.-]+)?$/, reason: 'print date' },
  { id: 'uname', pattern: /^uname(?:\s+-[amrsnpviol]+)?$/, reason: 'print system info' },
  { id: 'echo-literal', pattern: /^echo\s+(?:[\w./:=,@+-]+|"[^"`$]*"|'[^'`$]*')(?:\s+(?:[\w./:=,@+-]+|"[^"`$]*"|'[^'`$]*'))*$/, reason: 'echo of literal text' },
  { id: 'ls', pattern: /^ls(?:\s+-[aAlhFRtSr1]+)?(?:\s+[\w./@+-]+)*$/, reason: 'list directory' },
  { id: 'tree', pattern: /^tree(?:\s+-[adL\d]+)?(?:\s+[\w./@+-]+)?$/, reason: 'tree view' },
  { id: 'which', pattern: /^which\s+[\w./-]+$/, reason: 'locate executable' },
  { id: 'type', pattern: /^type\s+[\w./-]+$/, reason: 'shell builtin lookup' },
  { id: 'command-version', pattern: /^[\w.+-]+\s+(?:--version|-V|-v|version)$/, reason: 'tool version probe' },
  { id: 'cat-relative', pattern: /^cat(?:\s+-[nE]+)?(?:\s+[\w./@+-]+)+$/, reason: 'cat of relative paths' },
  { id: 'head-tail', pattern: /^(?:head|tail)(?:\s+-[nFc]\s*\d+)?(?:\s+[\w./@+-]+)+$/, reason: 'head/tail of files' },
  { id: 'wc', pattern: /^wc(?:\s+-[lwcm]+)?(?:\s+[\w./@+-]+)+$/, reason: 'word count' },
  { id: 'file', pattern: /^file\s+[\w./@+-]+$/, reason: 'file type probe' },
  { id: 'stat', pattern: /^stat\s+[\w./@+-]+$/, reason: 'stat probe' },
  { id: 'git-status', pattern: /^git\s+status(?:\s+-[suvb]+)?$/, reason: 'git status' },
  { id: 'git-diff', pattern: /^git\s+(?:diff|diff\s+--stat|diff\s+--cached|diff\s+HEAD)(?:\s+[\w./@+-]+)*$/, reason: 'git diff (read-only)' },
  { id: 'git-log', pattern: /^git\s+log(?:\s+(?:--oneline|--graph|--stat|--pretty=[\w:%-]+|-n\s*\d+|-\d+|--all))*(?:\s+[\w./@+-]+)*$/, reason: 'git log (read-only)' },
  { id: 'git-show', pattern: /^git\s+show(?:\s+--stat|--name-only)?(?:\s+[\w./@+-]+)*$/, reason: 'git show (read-only)' },
  { id: 'git-branch-list', pattern: /^git\s+branch(?:\s+(?:-a|-r|-v|-vv|--list))*$/, reason: 'list branches' },
  { id: 'git-remote-list', pattern: /^git\s+remote(?:\s+-v)?$/, reason: 'list remotes' },
  { id: 'git-config-get', pattern: /^git\s+config\s+--get\s+[\w.-]+$/, reason: 'read git config value' },
  { id: 'git-rev-parse', pattern: /^git\s+rev-parse(?:\s+--[a-z-]+)?\s+[\w./@+-]+$/, reason: 'git rev-parse' },
  { id: 'env-list', pattern: /^env$/, reason: 'list env vars (no execution)' },
  { id: 'printenv', pattern: /^printenv(?:\s+\w+)?$/, reason: 'print env var' },
  { id: 'ps', pattern: /^ps(?:\s+-[aefxlu]+)?$/, reason: 'list processes' },
  { id: 'df', pattern: /^df(?:\s+-[hHk]+)?$/, reason: 'disk free' },
  { id: 'du', pattern: /^du(?:\s+-[hsa]+)?(?:\s+[\w./@+-]+)?$/, reason: 'disk usage' },
];

const WHITESPACE = /\s+/g;

/** Collapse internal whitespace so rules can assume single-space tokenisation. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(WHITESPACE, ' ');
}

export type HardRuleVerdict =
  | { kind: 'deny'; ruleId: string; reason: string }
  | { kind: 'allow'; ruleId: string; reason: string }
  | { kind: 'unknown' };

/**
 * Match a shell command against the hard rules.
 *
 * Deny rules win over allow rules: if a command would be both
 * (e.g. "echo hi && rm -rf /"), the deny verdict is returned.
 */
export function evaluateHardRules(command: string): HardRuleVerdict {
  const normalized = normalizeCommand(command);
  if (!normalized) {
    return { kind: 'unknown' };
  }

  for (const rule of HARD_DENY_RULES) {
    if (rule.pattern.test(normalized)) {
      return { kind: 'deny', ruleId: rule.id, reason: rule.reason };
    }
  }

  for (const rule of HARD_ALLOW_RULES) {
    if (rule.pattern.test(normalized)) {
      return { kind: 'allow', ruleId: rule.id, reason: rule.reason };
    }
  }

  return { kind: 'unknown' };
}
