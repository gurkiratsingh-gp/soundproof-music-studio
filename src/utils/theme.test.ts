import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeThemePreference, resolveTheme } from './theme';

test('explicit light and dark preferences override the system appearance', () => {
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
});

test('system preference follows light and dark operating-system changes', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('missing and unsupported saved values safely migrate to system', () => {
  assert.equal(normalizeThemePreference(null), 'system');
  assert.equal(normalizeThemePreference('unsupported'), 'system');
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme('unsupported', false), 'light');
});
