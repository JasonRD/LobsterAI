# Shell Command Safety Guard

LobsterAI's cowork agents can run arbitrary shell commands.  Before this
feature, the only command that triggered an approval prompt was a
file-deletion (`rm`/`rmdir`) — `git push --force`, `kill`, `chmod 777`,
`curl … | sh`, `npm install`, base64-decoded payloads, etc. were all
auto-approved.  That is a very large blast radius for a desktop AI.

`src/main/libs/shellGuard/` adds a layered guard inspired by
[Anthropic's Claude Code auto-mode](https://claude.com/blog/auto-mode):

```
ApprovalRequest
  │
  ├── mode = skip-all   → ALLOW
  ├── mode = ask-always → ESCALATE (always prompt user)
  └── mode = auto:
         ├── hard DENY rule hit  → DENY  (e.g. rm -rf /, force-push to main)
         ├── hard ALLOW rule hit → ALLOW (e.g. ls, git status)
         └── otherwise → LLM classifier
                ├── ALLOW → allow
                ├── BLOCK → DENY (reason fed back to the agent)
                │           if the same template gets blocked N times,
                │           ESCALATE so the user can decide
                └── error → ESCALATE (safe fallback)
```

## Modes

Set in **Settings → Cowork → Shell Command Safety Guard**:

| Mode | When to use |
|---|---|
| **Auto** *(default)* | Day-to-day use.  Layered rules + LLM classifier. |
| **Ask Always** | Maximum control; every shell command prompts.  Equivalent to the pre-feature behaviour for non-channel sessions. |
| **Skip All** | Sandboxed environments only.  Skips every check.  Marked dangerous in the UI. |

## Hard rule layer

`src/main/libs/shellGuard/rules.ts` ships an opinionated default set:

- **Hard DENY** (~16 rules): `rm -rf /`, `dd of=/dev/...`, `mkfs`,
  fork bomb, writes to `~/.ssh/authorized_keys` or `id_*`,
  `chmod 777 /`, `curl|sh`, `wget|bash`, `base64 -d | sh`,
  `docker run --privileged`, force-pushes to `main`/`master`.
- **Hard ALLOW** (~30 rules): read-only inspection commands
  (`ls`, `pwd`, `cat`, `head`, `tail`, `git status`, `git diff`,
  `git log`, version probes like `node --version`, etc.).

Hard DENYs apply in `auto` mode; they do **not** override `skip-all`
(opt-out is opt-out).  Hard ALLOWs short-circuit the LLM classifier to
keep latency and token cost low for the most common commands.

## LLM classifier

`src/main/libs/shellGuard/classifier.ts` calls the cowork model
(or a user-selected provider/model override) with a tight system prompt
that returns `{ verdict: "ALLOW" | "ESCALATE" | "BLOCK", reason: "..." }`.

The classifier sees:
- the proposed `command`
- the working directory
- the user's most recent message (`userIntent`)
- up to 3 recent tool calls

Verdicts are cached for 24h keyed by `sha256(commandTemplate + cwd + userIntent)`,
where `commandTemplate` replaces numbers, quoted strings, and paths
with placeholders so structurally identical commands share a cache
entry. Commands that wrap quoted/encoded executable payloads are not
cached, because the template can hide materially different behaviour.

Failure modes (timeout, network error, unparseable response) escalate
to a manual prompt rather than silently allowing.

## Escalation counter

`EscalationCounter` is per-session, keyed by `commandTemplate`.  When
the classifier blocks the same template `shellGuardEscalateThreshold`
times in a row (default 3), the next attempt escalates to the user
prompt instead.  This prevents the agent from looping on a blocked
command, while still giving the user the final say.  A successful
ALLOW resets the counter for that template.

## Channel sessions

IM bot sessions and scheduled tasks have no UI to prompt the user, so
they keep the previous auto-approve behaviour.  This is intentional;
restrict those by configuring the bot's working directory and skill
allowlist instead.

## Configuration keys

Stored in `cowork_config`:

| Key | Type | Default |
|---|---|---|
| `shellGuardMode` | `'auto' \| 'ask-always' \| 'skip-all'` | `'auto'` |
| `shellGuardClassifierProvider` | string (provider key) | `''` (use main provider) |
| `shellGuardClassifierModel` | string (provider-scoped model name) | `''` (use main model) |
| `shellGuardClassifierTimeoutMs` | number, 1000–60000 | `8000` |
| `shellGuardEscalateThreshold` | number, 1–20 | `3` |

## Testing

`src/main/libs/shellGuard/*.test.ts` covers:
- 9 constants and clamping helpers
- 69 hard rules (deny + allow + unknown)
- 19 classifier behaviours (cache, transport injection, JSON parsing,
  timeouts, fallbacks)
- 12 orchestration cases (mode switching, escalation, deny formatting)

Run with `./node_modules/.bin/vitest run src/main/libs/shellGuard/`.

## Future work

- OS-level sandboxing (macOS Seatbelt, Linux bwrap) for defence-in-depth.
- Shell AST parsing for safer detection of `&&`/`||`/subshell evasion.
- Aggregated guard event log + per-rule statistics in the UI.
