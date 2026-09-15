import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPhoneConnection, PHONE_RECONNECT_GRACE_MS } from './phoneCompanion';

test('phone connection health requires transport, live audio, and controls', () => {
  assert.equal(assessPhoneConnection('connected', true, true), 'connected');
  assert.equal(assessPhoneConnection('connected', false, true), 'reconnecting');
  assert.equal(assessPhoneConnection('connected', true, false), 'reconnecting');
  assert.equal(assessPhoneConnection('disconnected', true, true), 'reconnecting');
  assert.equal(assessPhoneConnection('connecting', true, true), 'reconnecting');
  assert.equal(assessPhoneConnection('failed', true, true), 'failed');
  assert.equal(assessPhoneConnection('closed', true, true), 'failed');
  assert.equal(PHONE_RECONNECT_GRACE_MS, 8_000);
});
