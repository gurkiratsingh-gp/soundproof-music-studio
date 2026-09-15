import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express, type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { createMemoryRateLimit } from './rateLimit';

async function runApp(configure: (app: Express) => void, run: (url: string) => Promise<void>) {
  const app = express();
  app.set('trust proxy', true);
  app.use((req, res, next) => {
    const id = req.get('X-Test-User');
    if (id) res.locals.user = { id };
    next();
  });
  configure(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

const request = (url: string, route: string, user: string, ip: string) => fetch(url + route, {
  method: 'POST',
  headers: { 'X-Test-User': user, 'X-Forwarded-For': ip },
});
const ok: RequestHandler = (_req, res) => { res.json({ ok: true }); };

test('account limits follow an account across IP addresses', async () => {
  const limiter = createMemoryRateLimit({ accountLimit: 2, ipLimit: 10, windowMs: 60_000, message: 'limited' });
  await runApp(app => app.post('/limited', limiter, ok), async url => {
    const first = await request(url, '/limited', 'account-a', '198.51.100.1');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('ratelimit-limit'), '2');
    assert.equal(first.headers.get('ratelimit-remaining'), '1');
    assert.equal((await request(url, '/limited', 'account-a', '198.51.100.1')).status, 200);
    const movedNetwork = await request(url, '/limited', 'account-a', '198.51.100.2');
    assert.equal(movedNetwork.status, 429);
    assert.match(movedNetwork.headers.get('retry-after') || '', /^\d+$/);
    assert.equal((await movedNetwork.json()).error, 'limited');
    assert.equal((await request(url, '/limited', 'account-b', '198.51.100.1')).status, 200);
  });
});

test('IP limits are shared by different accounts on the same address', async () => {
  const limiter = createMemoryRateLimit({ accountLimit: 10, ipLimit: 2, windowMs: 60_000, message: 'limited' });
  await runApp(app => app.post('/limited', limiter, ok), async url => {
    assert.equal((await request(url, '/limited', 'account-a', '203.0.113.7')).status, 200);
    assert.equal((await request(url, '/limited', 'account-b', '203.0.113.7')).status, 200);
    assert.equal((await request(url, '/limited', 'account-c', '203.0.113.7')).status, 429);
    assert.equal((await request(url, '/limited', 'account-c', '203.0.113.8')).status, 200);
  });
});

test('route-specific buckets stay independent while a shared global limiter spans routes', async () => {
  const compose = createMemoryRateLimit({ accountLimit: 1, ipLimit: 10, windowMs: 60_000, message: 'compose limited' });
  const chat = createMemoryRateLimit({ accountLimit: 1, ipLimit: 10, windowMs: 60_000, message: 'chat limited' });
  const global = createMemoryRateLimit({ globalLimit: 3, windowMs: 60_000, message: 'global limited' });
  await runApp(app => {
    app.post('/compose', compose, global, ok);
    app.post('/chat', chat, global, ok);
  }, async url => {
    assert.equal((await request(url, '/compose', 'account-a', '192.0.2.1')).status, 200);
    assert.equal((await request(url, '/chat', 'account-a', '192.0.2.1')).status, 200);
    assert.equal((await request(url, '/compose', 'account-a', '192.0.2.1')).status, 429);
    assert.equal((await request(url, '/chat', 'account-b', '192.0.2.2')).status, 200);
    const globallyLimited = await request(url, '/compose', 'account-c', '192.0.2.3');
    assert.equal(globallyLimited.status, 429);
    assert.equal((await globallyLimited.json()).error, 'global limited');
  });
});

test('invalid limiter configuration fails at startup', () => {
  assert.throws(() => createMemoryRateLimit({ windowMs: 60_000, message: 'limited' }));
  assert.throws(() => createMemoryRateLimit({ globalLimit: 0, windowMs: 60_000, message: 'limited' }));
  assert.throws(() => createMemoryRateLimit({ globalLimit: 1, windowMs: 0, message: 'limited' }));
});
