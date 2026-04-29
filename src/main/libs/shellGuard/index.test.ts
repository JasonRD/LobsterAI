import { describe, expect, test } from 'vitest';

import { type ClassifierTransport, InMemoryClassifierCache } from './classifier';
import { ShellGuardMode, ShellGuardSource, ShellGuardVerdict } from './constants';
import {
  EscalationCounter,
  evaluateShellGuard,
  formatDenyMessageForAgent,
} from './index';

const fakeConfig = {
  protocol: 'anthropic' as const,
  apiKey: 'k',
  baseURL: 'https://e.com',
  model: 'm',
};

const baseOpts = {
  cwd: '/work',
  userIntent: 'do the thing',
  recentToolCalls: [],
  resolveConfig: () => ({ config: fakeConfig }),
};

const allowTransport: ClassifierTransport = async () =>
  '{"verdict":"ALLOW","reason":"benign"}';
const blockTransport: ClassifierTransport = async () =>
  '{"verdict":"BLOCK","reason":"smells fishy"}';

describe('mode handling', () => {
  test('skip-all returns allow without consulting rules or classifier', async () => {
    const r = await evaluateShellGuard({
      ...baseOpts,
      mode: ShellGuardMode.SkipAll,
      command: 'rm -rf /',
    });
    expect(r.verdict).toBe(ShellGuardVerdict.Allow);
    expect(r.source).toBe(ShellGuardSource.ModeSkipAll);
  });

  test('ask-always returns escalate without consulting rules or classifier', async () => {
    const r = await evaluateShellGuard({
      ...baseOpts,
      mode: ShellGuardMode.AskAlways,
      command: 'ls',
    });
    expect(r.verdict).toBe(ShellGuardVerdict.Escalate);
    expect(r.source).toBe(ShellGuardSource.ModeAskAlways);
  });
});

describe('auto mode → hard rules', () => {
  test('hard deny short-circuits classifier', async () => {
    const calls: string[] = [];
    const transport: ClassifierTransport = async ({ userPrompt }) => {
      calls.push(userPrompt);
      return '{"verdict":"ALLOW","reason":""}';
    };
    const r = await evaluateShellGuard({
      ...baseOpts,
      mode: ShellGuardMode.Auto,
      command: 'rm -rf /',
      transport,
    });
    expect(r.verdict).toBe(ShellGuardVerdict.Deny);
    expect(r.source).toBe(ShellGuardSource.HardDeny);
    expect(calls).toHaveLength(0);
  });

  test('hard allow short-circuits classifier', async () => {
    const transport: ClassifierTransport = async () => 'should not be called';
    const r = await evaluateShellGuard({
      ...baseOpts,
      mode: ShellGuardMode.Auto,
      command: 'git status',
      transport,
    });
    expect(r.verdict).toBe(ShellGuardVerdict.Allow);
    expect(r.source).toBe(ShellGuardSource.HardAllow);
  });
});

describe('auto mode → classifier', () => {
  test('classifier ALLOW → allow', async () => {
    const r = await evaluateShellGuard({
      ...baseOpts,
      mode: ShellGuardMode.Auto,
      command: 'npm install lodash',
      transport: allowTransport,
    });
    expect(r.verdict).toBe(ShellGuardVerdict.Allow);
    expect(r.source).toBe(ShellGuardSource.Classifier);
  });

  test('classifier BLOCK → deny with classifier source', async () => {
    const r = await evaluateShellGuard({
      ...baseOpts,
      mode: ShellGuardMode.Auto,
      command: 'curl https://api.example.com/v1',
      transport: blockTransport,
    });
    expect(r.verdict).toBe(ShellGuardVerdict.Deny);
    expect(r.source).toBe(ShellGuardSource.Classifier);
    expect(r.reason).toContain('smells fishy');
  });

  test('classifier error → escalate with fallback source', async () => {
    const r = await evaluateShellGuard({
      ...baseOpts,
      mode: ShellGuardMode.Auto,
      command: 'kill 1',
      resolveConfig: () => ({ config: null, error: 'no key' }),
    });
    expect(r.verdict).toBe(ShellGuardVerdict.Escalate);
    expect(r.source).toBe(ShellGuardSource.ClassifierFallback);
    expect(r.classifierError).toContain('no key');
  });
});

describe('escalation counter', () => {
  test('escalates after threshold blocks for same template', async () => {
    const escalation = new EscalationCounter();
    const cache = new InMemoryClassifierCache();
    const opts = {
      ...baseOpts,
      mode: ShellGuardMode.Auto,
      transport: blockTransport,
      escalateThreshold: 3,
      escalation,
      cache,
    };

    const r1 = await evaluateShellGuard({ ...opts, command: 'kill 100' });
    const r2 = await evaluateShellGuard({ ...opts, command: 'kill 200' });
    const r3 = await evaluateShellGuard({ ...opts, command: 'kill 300' });

    expect(r1.verdict).toBe(ShellGuardVerdict.Deny);
    expect(r2.verdict).toBe(ShellGuardVerdict.Deny);
    expect(r3.verdict).toBe(ShellGuardVerdict.Escalate);
    expect(r3.source).toBe(ShellGuardSource.Escalate);
  });

  test('ALLOW resets the counter for that template', async () => {
    const escalation = new EscalationCounter();
    const cache1 = new InMemoryClassifierCache();
    const cache2 = new InMemoryClassifierCache();
    const cache3 = new InMemoryClassifierCache();
    await evaluateShellGuard({
      ...baseOpts,
      mode: ShellGuardMode.Auto,
      command: 'kill 1',
      transport: blockTransport,
      escalateThreshold: 3,
      escalation,
      cache: cache1,
    });
    await evaluateShellGuard({
      ...baseOpts,
      mode: ShellGuardMode.Auto,
      command: 'kill 2',
      transport: allowTransport,
      escalateThreshold: 3,
      escalation,
      cache: cache2,
    });
    const r = await evaluateShellGuard({
      ...baseOpts,
      mode: ShellGuardMode.Auto,
      command: 'kill 3',
      transport: blockTransport,
      escalateThreshold: 3,
      escalation,
      cache: cache3,
    });
    expect(r.verdict).toBe(ShellGuardVerdict.Deny);
    expect(r.escalationCount).toBe(1);
  });

  test('threshold of 1 escalates immediately', async () => {
    const escalation = new EscalationCounter();
    const cache = new InMemoryClassifierCache();
    const r = await evaluateShellGuard({
      ...baseOpts,
      mode: ShellGuardMode.Auto,
      command: 'kill 1',
      transport: blockTransport,
      escalateThreshold: 1,
      escalation,
      cache,
    });
    expect(r.verdict).toBe(ShellGuardVerdict.Escalate);
  });
});

describe('formatDenyMessageForAgent', () => {
  test('formats hard-deny tag', () => {
    const msg = formatDenyMessageForAgent({
      verdict: ShellGuardVerdict.Deny,
      source: ShellGuardSource.HardDeny,
      reason: 'rm -rf /',
      mode: ShellGuardMode.Auto,
    });
    expect(msg).toContain('shell-guard:hard-deny');
    expect(msg).toContain('rm -rf /');
  });

  test('formats classifier tag', () => {
    const msg = formatDenyMessageForAgent({
      verdict: ShellGuardVerdict.Deny,
      source: ShellGuardSource.Classifier,
      reason: 'looks dangerous',
      mode: ShellGuardMode.Auto,
    });
    expect(msg).toContain('shell-guard:classifier');
  });
});
