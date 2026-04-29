import { describe, expect, test } from 'vitest';

import {
  clampClassifierTimeoutMs,
  clampEscalateThreshold,
  normalizeShellGuardMode,
  SHELL_GUARD_DEFAULT_CLASSIFIER_TIMEOUT_MS,
  SHELL_GUARD_DEFAULT_ESCALATE_THRESHOLD,
  SHELL_GUARD_DEFAULT_MODE,
  SHELL_GUARD_MAX_CLASSIFIER_TIMEOUT_MS,
  SHELL_GUARD_MAX_ESCALATE_THRESHOLD,
  SHELL_GUARD_MIN_CLASSIFIER_TIMEOUT_MS,
  SHELL_GUARD_MIN_ESCALATE_THRESHOLD,
  ShellGuardMode,
} from './constants';

describe('normalizeShellGuardMode', () => {
  test('accepts each known mode unchanged', () => {
    expect(normalizeShellGuardMode(ShellGuardMode.AskAlways)).toBe(ShellGuardMode.AskAlways);
    expect(normalizeShellGuardMode(ShellGuardMode.Auto)).toBe(ShellGuardMode.Auto);
    expect(normalizeShellGuardMode(ShellGuardMode.SkipAll)).toBe(ShellGuardMode.SkipAll);
  });

  test('falls back to default for unknown / empty / null / undefined', () => {
    expect(normalizeShellGuardMode(undefined)).toBe(SHELL_GUARD_DEFAULT_MODE);
    expect(normalizeShellGuardMode(null)).toBe(SHELL_GUARD_DEFAULT_MODE);
    expect(normalizeShellGuardMode('')).toBe(SHELL_GUARD_DEFAULT_MODE);
    expect(normalizeShellGuardMode('garbage')).toBe(SHELL_GUARD_DEFAULT_MODE);
  });
});

describe('clampClassifierTimeoutMs', () => {
  test('keeps in-range values', () => {
    expect(clampClassifierTimeoutMs(5000)).toBe(5000);
  });

  test('clamps to min/max', () => {
    expect(clampClassifierTimeoutMs(0)).toBe(SHELL_GUARD_MIN_CLASSIFIER_TIMEOUT_MS);
    expect(clampClassifierTimeoutMs(99999999)).toBe(SHELL_GUARD_MAX_CLASSIFIER_TIMEOUT_MS);
  });

  test('uses default for non-finite / undefined', () => {
    expect(clampClassifierTimeoutMs(undefined)).toBe(SHELL_GUARD_DEFAULT_CLASSIFIER_TIMEOUT_MS);
    expect(clampClassifierTimeoutMs(Number.NaN)).toBe(SHELL_GUARD_DEFAULT_CLASSIFIER_TIMEOUT_MS);
    expect(clampClassifierTimeoutMs(Number.POSITIVE_INFINITY)).toBe(SHELL_GUARD_DEFAULT_CLASSIFIER_TIMEOUT_MS);
  });

  test('rounds fractional input', () => {
    expect(clampClassifierTimeoutMs(1234.6)).toBe(1235);
  });
});

describe('clampEscalateThreshold', () => {
  test('keeps in-range values', () => {
    expect(clampEscalateThreshold(5)).toBe(5);
  });

  test('clamps to min/max', () => {
    expect(clampEscalateThreshold(0)).toBe(SHELL_GUARD_MIN_ESCALATE_THRESHOLD);
    expect(clampEscalateThreshold(9999)).toBe(SHELL_GUARD_MAX_ESCALATE_THRESHOLD);
  });

  test('uses default for non-finite / undefined', () => {
    expect(clampEscalateThreshold(undefined)).toBe(SHELL_GUARD_DEFAULT_ESCALATE_THRESHOLD);
    expect(clampEscalateThreshold(null)).toBe(SHELL_GUARD_DEFAULT_ESCALATE_THRESHOLD);
    expect(clampEscalateThreshold(Number.NaN)).toBe(SHELL_GUARD_DEFAULT_ESCALATE_THRESHOLD);
  });
});
