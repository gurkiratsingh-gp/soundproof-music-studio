import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAuth, sameOrigin } from './auth';
import {
  DEFAULT_PHONE_MIC_ICE_SERVERS,
  PHONE_COMPANION_LIMITS,
  createPhoneCompanionRouter,
  parsePhoneMicIceServers,
} from './phoneCompanion';

async function testServer(options: { now?: () => number; sessionTtlMs?: number } = {}) {
  const base = path.resolve('.data'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'phone-test-'));
  const auth = createAuth({ directory });
  const app = express(); app.set('trust proxy', 1); app.use(express.json({ limit: '64kb' })); app.use(sameOrigin);
  app.use('/auth', auth.router);
  app.use('/phone', createPhoneCompanionRouter({ requireUser: auth.requireUser, now: options.now, sessionTtlMs: options.sessionTtlMs }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const json = (route: string, body: unknown, cookie = '', headers: Record<string, string> = {}) => fetch(origin + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body),
  });
  const register = async (username: string) => {
    const response = await json('/auth/register', { username, password: 'phone-test-password' });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const close = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(path.resolve(directory).startsWith(base + path.sep));
    await rm(directory, { recursive: true, force: true });
  };
  return { origin, json, register, close };
}

test('phone companion pairs once and isolates signaling by studio owner and phone credential', async () => {
  const fixture = await testServer();
  try {
    const studioA = await fixture.register('Phone Studio A');
    const studioB = await fixture.register('Phone Studio B');
    assert.equal((await fixture.json('/phone/sessions', {})).status, 401);

    const createdResponse = await fixture.json('/phone/sessions', {}, studioA);
    assert.equal(createdResponse.status, 201);
    assert.equal(createdResponse.headers.get('cache-control'), 'no-store');
    const created = await createdResponse.json() as any;
    assert.match(created.sessionId, /^[0-9a-f-]{36}$/i);
    assert.match(created.pairingCode, /^\d{6}$/);
    assert.deepEqual(created.iceServers, DEFAULT_PHONE_MIC_ICE_SERVERS);
    assert.equal(created.status, 'waiting');
    const inviteUrl = new URL(created.inviteUrl);
    const inviteToken = new URLSearchParams(inviteUrl.hash.slice(1)).get('inviteToken')!;
    assert.equal(inviteUrl.pathname, '/phone');
    assert.equal(inviteUrl.search, '');
    assert.match(inviteToken, /^[A-Za-z0-9_-]{43}$/);

    assert.equal((await fetch(`${fixture.origin}/phone/sessions/${created.sessionId}`, { headers: { Cookie: studioB } })).status, 404);
    assert.equal((await fixture.json('/phone/join', { inviteToken: 'x'.repeat(43) })).status, 404);
    const joinedResponse = await fixture.json('/phone/join', { inviteToken });
    assert.equal(joinedResponse.status, 200);
    const joined = await joinedResponse.json() as any;
    assert.match(joined.deviceToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(joined.status, 'connected');
    assert.ok(!JSON.stringify(joined).includes(inviteToken));
    assert.equal((await fixture.json('/phone/join', { inviteToken })).status, 404);

    const sessionResponse = await fetch(`${fixture.origin}/phone/sessions/${created.sessionId}`, { headers: { Cookie: studioA } });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json() as any;
    assert.equal(session.status, 'connected');
    assert.equal(session.inviteToken, undefined);
    assert.equal(session.pairingCode, undefined);
    assert.equal(session.deviceToken, undefined);

    const offer = { role: 'studio', type: 'offer', payload: { sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=SoundProof\r\nt=0 0\r\n' } };
    assert.equal((await fixture.json(`/phone/sessions/${created.sessionId}/signals`, offer, studioB)).status, 404);
    const offered = await fixture.json(`/phone/sessions/${created.sessionId}/signals`, offer, studioA);
    assert.equal(offered.status, 202);
    assert.equal((await fetch(`${fixture.origin}/phone/sessions/${created.sessionId}/signals?role=phone`)).status, 401);
    assert.equal((await fetch(`${fixture.origin}/phone/sessions/${created.sessionId}/signals?role=phone`, { headers: { Authorization: `Bearer ${'a'.repeat(43)}` } })).status, 401);

    const phonePoll = await fetch(`${fixture.origin}/phone/sessions/${created.sessionId}/signals?role=phone`, { headers: { Authorization: `Bearer ${joined.deviceToken}` } });
    assert.equal(phonePoll.status, 200);
    const phoneMessages = await phonePoll.json() as any;
    assert.equal(phoneMessages.signals.length, 1);
    assert.deepEqual(phoneMessages.signals[0], { sequence: 1, type: 'offer', payload: offer.payload });
    assert.equal(phoneMessages.truncated, false);
    const emptyPhonePoll = await fetch(`${fixture.origin}/phone/sessions/${created.sessionId}/signals?role=phone&after=${phoneMessages.next}`, { headers: { Authorization: `Bearer ${joined.deviceToken}` } });
    assert.equal((await emptyPhonePoll.json() as any).signals.length, 0);

    const phoneHeaders = { Authorization: `Bearer ${joined.deviceToken}` };
    const answer = { role: 'phone', type: 'answer', payload: { sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=Phone\r\nt=0 0\r\n' } };
    const ice = { role: 'phone', type: 'ice', payload: { candidate: { candidate: 'candidate:1 1 udp 2122260223 192.0.2.10 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'demo' } } };
    assert.equal((await fixture.json(`/phone/sessions/${created.sessionId}/signals`, answer, studioA)).status, 401);
    assert.equal((await fixture.json(`/phone/sessions/${created.sessionId}/signals`, offer, '', phoneHeaders)).status, 401);
    assert.equal((await fixture.json(`/phone/sessions/${created.sessionId}/signals`, answer, '', phoneHeaders)).status, 202);
    assert.equal((await fixture.json(`/phone/sessions/${created.sessionId}/signals`, ice, '', phoneHeaders)).status, 202);
    assert.equal((await fixture.json(`/phone/sessions/${created.sessionId}/signals`, { role: 'phone', type: 'control', payload: { action: 'ready' } }, '', phoneHeaders)).status, 202);
    const studioPoll = await fetch(`${fixture.origin}/phone/sessions/${created.sessionId}/signals?role=studio`, { headers: { Cookie: studioA } });
    assert.equal(studioPoll.status, 200);
    const studioMessages = await studioPoll.json() as any;
    assert.deepEqual(studioMessages.signals.map((message: any) => message.type), ['answer', 'ice', 'control']);

    assert.equal((await fixture.json(`/phone/sessions/${created.sessionId}/signals`, { role: 'studio', type: 'offer', payload: { sdp: 'not-sdp' } }, studioA)).status, 400);
    assert.equal((await fixture.json(`/phone/sessions/${created.sessionId}/signals`, { role: 'phone', type: 'ice', payload: { candidate: { candidate: 'bad\ncandidate' } } }, '', phoneHeaders)).status, 400);
    assert.equal((await fixture.json(`/phone/sessions/${created.sessionId}/signals`, { role: 'phone', type: 'control', payload: { action: 'record-everything' } }, '', phoneHeaders)).status, 400);
    assert.equal((await fixture.json(`/phone/sessions/${created.sessionId}/signals`, { role: 'phone', type: 'control', payload: { action: 'ready' }, audio: 'data' }, '', phoneHeaders)).status, 400);
    assert.equal((await fixture.json(`/phone/sessions/${created.sessionId}/signals`, { role: 'studio', type: 'offer', payload: { sdp: `v=0\n${'a'.repeat(17 * 1024)}` } }, studioA)).status, 400);

    for (let index = 0; index <= PHONE_COMPANION_LIMITS.maxSignalsPerSession; index++) {
      assert.equal((await fixture.json(`/phone/sessions/${created.sessionId}/signals`, { role: 'studio', type: 'control', payload: { action: 'ping' } }, studioA)).status, 202);
    }
    const cappedPoll = await fetch(`${fixture.origin}/phone/sessions/${created.sessionId}/signals?role=phone&after=0`, { headers: phoneHeaders });
    const cappedMessages = await cappedPoll.json() as any;
    assert.equal(cappedMessages.signals.length, PHONE_COMPANION_LIMITS.maxSignalsPerPoll);
    assert.equal(cappedMessages.hasMore, true);
    assert.equal(cappedMessages.truncated, true);

    assert.equal((await fetch(`${fixture.origin}/phone/sessions/${created.sessionId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: studioB }, body: '{}' })).status, 404);
    assert.equal((await fetch(`${fixture.origin}/phone/sessions/${created.sessionId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: studioA }, body: '{}' })).status, 204);
    assert.equal((await fetch(`${fixture.origin}/phone/sessions/${created.sessionId}/signals?role=phone`, { headers: phoneHeaders })).status, 404);

    const phoneOwned = await (await fixture.json('/phone/sessions', {}, studioA)).json() as any;
    const phoneInvite = new URLSearchParams(new URL(phoneOwned.inviteUrl).hash.slice(1)).get('inviteToken')!;
    const phoneJoined = await (await fixture.json('/phone/join', { inviteToken: phoneInvite })).json() as any;
    const phoneDeleteUrl = `${fixture.origin}/phone/sessions/${phoneOwned.sessionId}/phone`;
    const jsonHeaders = { 'Content-Type': 'application/json' };
    assert.equal((await fetch(phoneDeleteUrl, { method: 'DELETE', headers: jsonHeaders, body: '{}' })).status, 401);
    assert.equal((await fetch(phoneDeleteUrl, { method: 'DELETE', headers: { ...jsonHeaders, Authorization: `Bearer ${'b'.repeat(43)}` }, body: '{}' })).status, 401);
    assert.equal((await fetch(phoneDeleteUrl, { method: 'DELETE', headers: { ...jsonHeaders, Cookie: studioA }, body: '{}' })).status, 401);
    assert.equal((await fetch(phoneDeleteUrl, { method: 'DELETE', headers: { ...jsonHeaders, Authorization: `Bearer ${phoneJoined.deviceToken}` }, body: '{}' })).status, 204);
    assert.equal((await fetch(`${fixture.origin}/phone/sessions/${phoneOwned.sessionId}`, { headers: { Cookie: studioA } })).status, 404);
    assert.equal((await fetch(phoneDeleteUrl, { method: 'DELETE', headers: { ...jsonHeaders, Authorization: `Bearer ${phoneJoined.deviceToken}` }, body: '{}' })).status, 404);
  } finally { await fixture.close(); }
});

test('short pairing codes are single-use, tightly rate limited, and sessions expire', async () => {
  let clock = 1_000_000;
  const fixture = await testServer({ now: () => clock, sessionTtlMs: 60_000 });
  try {
    const studio = await fixture.register('Pairing Studio');
    const created = await (await fixture.json('/phone/sessions', {}, studio)).json() as any;
    const formattedCode = `${created.pairingCode.slice(0, 3)}-${created.pairingCode.slice(3)}`;
    const joined = await fixture.json('/phone/join', { pairingCode: formattedCode }, '', { 'X-Forwarded-For': '203.0.113.10' });
    assert.equal(joined.status, 200);
    assert.match((await joined.json() as any).deviceToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await fixture.json('/phone/join', { pairingCode: created.pairingCode }, '', { 'X-Forwarded-For': '203.0.113.10' })).status, 404);

    for (let attempt = 0; attempt < PHONE_COMPANION_LIMITS.pairingAttemptsPerTenMinutes; attempt++) {
      assert.equal((await fixture.json('/phone/join', { pairingCode: '999999' }, '', { 'X-Forwarded-For': '203.0.113.11' })).status, 404);
    }
    const limited = await fixture.json('/phone/join', { pairingCode: '999999' }, '', { 'X-Forwarded-For': '203.0.113.11' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);

    const expiring = await (await fixture.json('/phone/sessions', {}, studio)).json() as any;
    const expiringToken = new URLSearchParams(new URL(expiring.inviteUrl).hash.slice(1)).get('inviteToken')!;
    clock = expiring.expiresAt;
    assert.equal((await fetch(`${fixture.origin}/phone/sessions/${expiring.sessionId}`, { headers: { Cookie: studio } })).status, 404);
    assert.equal((await fixture.json('/phone/join', { inviteToken: expiringToken }, '', { 'X-Forwarded-For': '203.0.113.12' })).status, 404);

    for (let active = 0; active < PHONE_COMPANION_LIMITS.maxActiveSessionsPerOwner; active++) {
      assert.equal((await fixture.json('/phone/sessions', {}, studio)).status, 201);
    }
    assert.equal((await fixture.json('/phone/sessions', {}, studio)).status, 429);
  } finally { await fixture.close(); }
});

test('ICE configuration is bounded and returns only supported STUN/TURN fields', () => {
  assert.deepEqual(parsePhoneMicIceServers(), DEFAULT_PHONE_MIC_ICE_SERVERS);
  assert.deepEqual(parsePhoneMicIceServers(JSON.stringify([
    { urls: ['stun:stun.example.test:3478', 'turns:turn.example.test:5349?transport=tcp'], username: 'demo-user', credential: 'demo-secret' },
  ])), [{ urls: ['stun:stun.example.test:3478', 'turns:turn.example.test:5349?transport=tcp'], username: 'demo-user', credential: 'demo-secret' }]);
  assert.throws(() => parsePhoneMicIceServers('{bad json'), /valid JSON/);
  assert.throws(() => parsePhoneMicIceServers(JSON.stringify([{ urls: 'https://example.test/ice' }])), /invalid STUN or TURN URL/);
  assert.throws(() => parsePhoneMicIceServers(JSON.stringify([{ urls: 'turn:turn.example.test:3478' }])), /invalid username/);
  assert.throws(() => parsePhoneMicIceServers(JSON.stringify([{ urls: 'stun:user@example.test:3478' }])), /invalid STUN or TURN URL/);
});
