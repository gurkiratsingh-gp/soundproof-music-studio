import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createAuth, verifyProviderToken, type OAuthExchangeRequest } from './auth';

async function startApp(auth: ReturnType<typeof createAuth>, trustProxy = false) {
  const app = express();
  if (trustProxy) app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', auth.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url };
}

const close = (server: ReturnType<express.Express['listen']>) => new Promise<void>(resolve => server.close(() => resolve()));

test('email identifiers and legacy studio names share the safe local-password flow', async () => {
  const base = path.resolve('.data'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'email-auth-test-'));
  const auth = createAuth({ directory, environment: {} });
  const { server, url } = await startApp(auth);
  const post = (route: string, body: unknown) => fetch(`${url}/api/auth/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const email = await post('register', { username: 'singer@example.com', password: 'strong-test-password' });
    assert.equal(email.status, 200);
    assert.equal((await email.json()).user.username, 'singer@example.com');
    assert.equal((await post('register', { username: 'Legacy Singer', password: 'strong-test-password' })).status, 200);
    assert.equal((await post('register', { username: 'not-an-email@local', password: 'strong-test-password' })).status, 400);
    assert.equal((await post('login', { username: 'SINGER@EXAMPLE.COM', password: 'strong-test-password' })).status, 200);
    const saved = await readFile(path.join(directory, 'accounts.json'), 'utf8');
    assert.ok(!saved.includes('strong-test-password'));
    assert.match(saved, /"authProvider":"password"/);
    assert.match(saved, /"email":"singer@example.com"/);
  } finally { await close(server); await rm(directory, { recursive: true, force: true }); }
});

test('Google uses state, nonce and PKCE; callbacks are one-use and provider subjects stay isolated', async () => {
  const base = path.resolve('.data'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'google-auth-test-'));
  const exchanges: OAuthExchangeRequest[] = [];
  const auth = createAuth({
    directory,
    environment: { GOOGLE_CLIENT_ID: 'fixture-client-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-client-secret' },
    async exchangeOAuthIdentity(request) {
      exchanges.push(request);
      if (request.code === 'provider-secret-error') throw new Error('PROVIDER_SECRET_MUST_NOT_LEAK');
      return { subject: request.code, displayName: 'Test Singer', email: 'singer@example.com', emailVerified: true };
    },
  });
  const { server, url } = await startApp(auth);
  async function begin() {
    const response = await fetch(`${url}/api/auth/google/start`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location')!);
    assert.equal(location.origin, 'https://accounts.google.com');
    assert.equal(location.searchParams.get('redirect_uri'), `${url}/api/auth/google/callback`);
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('scope'), 'openid email profile');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.match(location.searchParams.get('code_challenge') || '', /^[A-Za-z0-9_-]{43}$/);
    assert.match(location.searchParams.get('nonce') || '', /^[A-Za-z0-9_-]{43}$/);
    const cookie = response.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i);
    return { state: location.searchParams.get('state')!, cookie: cookie.split(';')[0] };
  }
  async function finish(code: string) {
    const attempt = await begin();
    const callbackUrl = `${url}/api/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(attempt.state)}`;
    const response = await fetch(callbackUrl, { headers: { Cookie: attempt.cookie }, redirect: 'manual' });
    return { ...attempt, callbackUrl, response };
  }
  try {
    const providers = await (await fetch(`${url}/api/auth/providers`)).json();
    assert.equal(providers.google.configured, true);
    assert.equal(providers.apple.configured, false);
    assert.match(providers.apple.message, /localhost|HTTPS domain/i);

    const guarded = await begin();
    const unrelated = await fetch(`${url}/api/auth/google/callback?code=ignored&state=${'x'.repeat(43)}`, { headers: { Cookie: guarded.cookie }, redirect: 'manual' });
    assert.equal(new URL(unrelated.headers.get('location')!).searchParams.get('auth_error'), 'expired');
    assert.ok(!unrelated.headers.get('set-cookie'));
    const callbackUrl = `${url}/api/auth/google/callback?code=google-subject-one&state=${encodeURIComponent(guarded.state)}`;
    const first = { ...guarded, callbackUrl, response: await fetch(callbackUrl, { headers: { Cookie: guarded.cookie }, redirect: 'manual' }) };
    assert.equal(first.response.status, 303);
    assert.equal(first.response.headers.get('location'), `${url}/`);
    const sessionCookie = first.response.headers.get('set-cookie')!.match(/svara_session=[a-f0-9]{64}/)?.[0];
    assert.ok(sessionCookie);
    const firstUser = (await (await fetch(`${url}/api/auth/session`, { headers: { Cookie: sessionCookie! } })).json()).user;
    assert.equal(firstUser.username, 'Test Singer');
    assert.ok(exchanges[0].codeVerifier);
    assert.equal(exchanges[0].config.provider, 'google');

    const replay = await fetch(first.callbackUrl, { headers: { Cookie: first.cookie }, redirect: 'manual' });
    assert.equal(new URL(replay.headers.get('location')!).searchParams.get('auth_error'), 'expired');
    assert.equal(exchanges.length, 1);

    const again = await finish('google-subject-one');
    const againSession = again.response.headers.get('set-cookie')!.match(/svara_session=[a-f0-9]{64}/)?.[0];
    const againUser = (await (await fetch(`${url}/api/auth/session`, { headers: { Cookie: againSession! } })).json()).user;
    assert.equal(againUser.id, firstUser.id);

    const second = await finish('google-subject-two');
    const secondSession = second.response.headers.get('set-cookie')!.match(/svara_session=[a-f0-9]{64}/)?.[0];
    const secondUser = (await (await fetch(`${url}/api/auth/session`, { headers: { Cookie: secondSession! } })).json()).user;
    assert.notEqual(secondUser.id, firstUser.id);
    assert.equal(secondUser.username, 'Test Singer 2');

    const failure = await finish('provider-secret-error');
    const failureLocation = failure.response.headers.get('location')!;
    assert.equal(new URL(failureLocation).searchParams.get('auth_error'), 'unavailable');
    assert.ok(!failureLocation.includes('PROVIDER_SECRET'));
    const saved = await readFile(path.join(directory, 'accounts.json'), 'utf8');
    assert.equal(JSON.parse(saved).length, 2);
    assert.ok(!saved.includes('provider-secret-error'));
    assert.ok(!saved.includes('fixture-client-secret'));
  } finally { await close(server); await rm(directory, { recursive: true, force: true }); }
});

test('Apple is HTTPS-only, uses secure form_post state, and rejects other callback content types', async () => {
  const base = path.resolve('.data'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'apple-auth-test-'));
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exchanges: OAuthExchangeRequest[] = [];
  const origin = 'https://soundproof.example';
  const auth = createAuth({
    directory, publicOrigin: origin, secureCookies: true,
    environment: {
      NODE_ENV: 'production', APPLE_CLIENT_ID: 'com.example.soundproof.web', APPLE_TEAM_ID: 'TEAMID1234', APPLE_KEY_ID: 'KEYID12345',
      APPLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
    async exchangeOAuthIdentity(request) {
      exchanges.push(request);
      return { subject: 'apple-subject', displayName: request.profileName, email: 'private@privaterelay.appleid.com', emailVerified: true };
    },
  });
  const { server, url } = await startApp(auth, true);
  const proxyHeaders = { Host: 'soundproof.example', 'X-Forwarded-Proto': 'https' };
  try {
    const providers = await (await fetch(`${url}/api/auth/providers`, { headers: proxyHeaders })).json();
    assert.equal(providers.apple.configured, true);
    const start = await fetch(`${url}/api/auth/apple/start`, { headers: proxyHeaders, redirect: 'manual' });
    const authorization = new URL(start.headers.get('location')!);
    assert.equal(authorization.origin, 'https://appleid.apple.com');
    assert.equal(authorization.searchParams.get('response_mode'), 'form_post');
    assert.equal(authorization.searchParams.get('redirect_uri'), `${origin}/api/auth/apple/callback`);
    assert.equal(authorization.searchParams.get('scope'), 'name email');
    const state = authorization.searchParams.get('state')!;
    const cookieHeader = start.headers.get('set-cookie')!;
    assert.match(cookieHeader, /SameSite=None/i); assert.match(cookieHeader, /Secure/i); assert.match(cookieHeader, /HttpOnly/i);
    const cookie = cookieHeader.split(';')[0];

    const rejected = await fetch(`${url}/api/auth/apple/callback`, { method: 'POST', headers: { ...proxyHeaders, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ state, code: 'apple-code' }), redirect: 'manual' });
    assert.equal(rejected.status, 415);

    const secondStart = await fetch(`${url}/api/auth/apple/start`, { headers: proxyHeaders, redirect: 'manual' });
    const secondAuthorization = new URL(secondStart.headers.get('location')!);
    const secondCookie = secondStart.headers.get('set-cookie')!.split(';')[0];
    const body = new URLSearchParams({ state: secondAuthorization.searchParams.get('state')!, code: 'apple-code', user: JSON.stringify({ name: { firstName: 'Asha', lastName: 'Rao' }, ignored: 'discard' }) });
    const local = new URL(url);
    const callback = await new Promise<{ status: number; location: string }>((resolve, reject) => {
      const encoded = body.toString();
      const request = httpRequest({ hostname: local.hostname, port: Number(local.port), path: '/api/auth/apple/callback', method: 'POST', headers: { Host: 'soundproof.example', 'X-Forwarded-Proto': 'https', Cookie: secondCookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(encoded) } }, response => {
        response.resume(); response.on('end', () => resolve({ status: response.statusCode || 0, location: String(response.headers.location || '') }));
      });
      request.on('error', reject); request.end(encoded);
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.location, `${origin}/`);
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0].provider, 'apple');
    assert.equal(exchanges[0].profileName, 'Asha Rao');
  } finally { await close(server); await rm(directory, { recursive: true, force: true }); }
});

function signedToken(privateKey: Parameters<typeof sign>[2], kid: string, claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

test('ID-token verification checks azp and refreshes a rotated JWKS key once', async () => {
  const first = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = (publicKey: typeof first.publicKey, kid: string) => ({ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
  let keys = [jwk(first.publicKey, 'first')]; let fetches = 0;
  const fetchImpl = (async () => { fetches++; return Response.json({ keys }); }) as typeof fetch;
  const jwksUri = `https://issuer.example/${randomUUID()}`;
  const validation = { issuers: ['https://issuer.example'], audience: 'soundproof-client', nonce: 'one-use-nonce', jwksUri };
  const claims = { iss: 'https://issuer.example', aud: 'soundproof-client', sub: 'user-one', nonce: 'one-use-nonce', iat: 100, exp: 900 };
  await verifyProviderToken(signedToken(first.privateKey, 'first', claims), validation, fetchImpl, 200_000);
  assert.equal(fetches, 1);

  keys = [jwk(second.publicKey, 'second')];
  const rotated = { ...claims, aud: ['soundproof-client', 'another-audience'], azp: 'soundproof-client' };
  await verifyProviderToken(signedToken(second.privateKey, 'second', rotated), validation, fetchImpl, 261_000);
  assert.equal(fetches, 2);

  const wrongParty = { ...rotated, azp: 'another-audience' };
  await assert.rejects(() => verifyProviderToken(signedToken(second.privateKey, 'second', wrongParty), validation, fetchImpl, 262_000), /another application/);
  assert.equal(fetches, 2);
});
