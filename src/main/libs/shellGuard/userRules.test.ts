import { describe, expect, test } from 'vitest';

import {
  matchUserRules,
  parseUserRuleLine,
  parseUserRules,
} from './userRules';

describe('parseUserRuleLine', () => {
  test('skips blank and comment lines', () => {
    expect(parseUserRuleLine('')).toBeNull();
    expect(parseUserRuleLine('   ')).toBeNull();
    expect(parseUserRuleLine('# a comment')).toBeNull();
  });

  test('parses slash-delimited regex with flags', () => {
    const rule = parseUserRuleLine('/^docker\\s+rm\\b/i');
    expect(rule?.syntax).toBe('regex');
    expect(rule?.pattern.test('docker rm foo')).toBe(true);
    expect(rule?.pattern.test('DOCKER RM bar')).toBe(true); // i flag
  });

  test('parses glob with * and ?', () => {
    const rule = parseUserRuleLine('git push * --force');
    expect(rule?.syntax).toBe('glob');
    expect(rule?.pattern.test('git push origin --force')).toBe(true);
    expect(rule?.pattern.test('git push origin main --force')).toBe(true);
    expect(rule?.pattern.test('git pull origin --force')).toBe(false);
  });

  test('parses literal as token-aligned prefix', () => {
    const rule = parseUserRuleLine('pnpm');
    expect(rule?.syntax).toBe('prefix');
    expect(rule?.pattern.test('pnpm install')).toBe(true);
    expect(rule?.pattern.test('pnpm')).toBe(true);
    // Token-aligned: no false match on similar names.
    expect(rule?.pattern.test('pnpmx install')).toBe(false);
    expect(rule?.pattern.test('git pnpm')).toBe(false);
  });

  test('rejects malformed regex', () => {
    expect(parseUserRuleLine('/[unclosed/')).toBeNull();
  });
});

describe('parseUserRules', () => {
  test('handles empty input', () => {
    expect(parseUserRules('')).toEqual([]);
    expect(parseUserRules(null)).toEqual([]);
    expect(parseUserRules(undefined)).toEqual([]);
  });

  test('parses multi-line text and skips invalid lines', () => {
    const rules = parseUserRules('# header\n\n/^rm\\b/\ngit push *\n  ');
    expect(rules.length).toBe(2);
    expect(rules[0].syntax).toBe('regex');
    expect(rules[1].syntax).toBe('glob');
  });
});

describe('matchUserRules', () => {
  test('returns first matching rule', () => {
    const rules = parseUserRules('pnpm\n/^docker\\s+rm/');
    const match = matchUserRules('docker rm container', rules);
    expect(match?.raw).toBe('/^docker\\s+rm/');
    expect(match?.syntax).toBe('regex');
  });

  test('returns null when no rule matches', () => {
    const rules = parseUserRules('pnpm\n/^docker\\s+rm/');
    expect(matchUserRules('ls -la', rules)).toBeNull();
  });

  test('handles empty rules and empty command', () => {
    expect(matchUserRules('ls', [])).toBeNull();
    expect(matchUserRules('   ', parseUserRules('ls'))).toBeNull();
  });

  test('normalizes whitespace before matching', () => {
    const rules = parseUserRules('git  push'.replace(/\s+/g, ' '));
    expect(matchUserRules('git\tpush  origin', rules)?.raw).toBe('git push');
  });
});
