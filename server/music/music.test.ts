import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createMusicProvider, MusicError, validateSong, type MusicProvider } from './providers';
import { createMusicRouter } from './routes';
import { initialSongs } from '../../src/utils/initialSongs';

const song = initialSongs[0];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const queueUrls = { request_id: 'remote-123', status_url: 'https://queue.fal.run/fal-ai/minimax-music/requests/remote-123/status', response_url: 'https://queue.fal.run/fal-ai/minimax-music/requests/remote-123' };

test('fal submits the actual lyrics and vocal settings, normalizes progress and uses returned URLs', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [json(queueUrls), json({ status: 'IN_QUEUE', queue_position: 2 }), json({ status: 'IN_PROGRESS' }), json({ status: 'COMPLETED' }), json({ audio: { url: 'https://v3b.fal.media/files/demo.mp3' } }), new Response('mp3', { headers: { 'Content-Type': 'audio/mpeg' } })];
  const provider = createMusicProvider({ FAL_KEY: 'private-test-key', MUSIC_PROVIDER: 'fal' }, async (url, init) => {
    calls.push({ url: String(url), init });
    return responses.shift()!;
  });
  const task = await provider.submit(validateSong(song));
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(calls[0].url, 'https://queue.fal.run/fal-ai/minimax-music/v2.6');
  assert.equal(body.is_instrumental, false);
  assert.equal(body.lyrics_optimizer, false);
  assert.ok(body.lyrics.includes(song.lyrics[1].lines[0]));
  assert.ok(body.prompt.includes(song.language));
  assert.match(body.prompt, /enhanced studio-focused/i);
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), 'Key private-test-key');
  assert.deepEqual(await provider.poll(task), { status: 'queued', message: 'Waiting for the music provider.', queuePosition: 2 });
  assert.equal((await provider.poll(task)).status, 'generating');
  assert.deepEqual(await provider.poll(task), { status: 'complete', audioUrl: 'https://v3b.fal.media/files/demo.mp3' });
  assert.equal(calls[1].url, queueUrls.status_url);
  assert.equal(calls[4].url, queueUrls.response_url);
  await provider.audio('https://v3b.fal.media/files/demo.mp3', 'bytes=0-100');
  assert.equal(new Headers(calls[5].init?.headers).get('Authorization'), null);
  assert.equal(new Headers(calls[5].init?.headers).get('Range'), 'bytes=0-100');
});

test('provider prompts honor an explicit natural voice choice', async () => {
  let body: any;
  const provider = createMusicProvider({ FAL_KEY: 'private-test-key', MUSIC_PROVIDER: 'fal' }, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return json(queueUrls);
  });
  await provider.submit(validateSong({ ...song, enhancedVoice: false }));
  assert.match(body.prompt, /natural expressive/i);
  assert.doesNotMatch(body.prompt, /enhanced studio-focused/i);
});

test('missing configuration is explicit and never sends requests', async () => {
  const provider = createMusicProvider({}, async () => { throw new Error('Should not fetch'); });
  assert.equal((await provider.status()).available, false);
  await assert.rejects(provider.submit(song), /FAL_KEY/);
  assert.equal((await createMusicProvider({ MUSIC_PROVIDER: 'none', FAL_KEY: 'ignored' }).status()).available, false);
  assert.match((await createMusicProvider({ MUSIC_PROVIDER: 'typo' }).status()).message, /Unknown/);
});

test('reject malformed input and oversized lyrics before paid submission', async () => {
  assert.equal(validateSong(song).enhancedVoice, true);
  assert.equal(validateSong({ ...song, enhancedVoice: false }).enhancedVoice, false);
  for (const input of [null, {}, { ...song, lyrics: [] }, { ...song, lyrics: [{ section: 'Verse', lines: [45] }] }, { ...song, bpm: -1 }, { ...song, instruments: 'piano' }, { ...song, enhancedVoice: 'yes' }, { ...song, language: 'Unsupported' }]) {
    assert.throws(() => validateSong(input), MusicError);
  }
  const provider = createMusicProvider({ FAL_KEY: 'key' }, async () => { throw new Error('Must not submit'); });
  await assert.rejects(provider.submit({ ...song, lyrics: [{ section: 'Verse', lines: Array(5).fill('x'.repeat(900)) }] }), /3,500/);
});

test('provider auth, credit, rate-limit, invalid payload and connection errors are sanitized', async () => {
  for (const [status, expected] of [[401, /API key/], [402, /credits/], [429, /rate limited/], [422, /rejected this song/], [500, /unavailable/]] as const) {
    const provider = createMusicProvider({ FAL_KEY: 'SECRET' }, async () => json({ error: 'SECRET raw upstream text' }, status));
    await assert.rejects(provider.submit(song), error => error instanceof Error && expected.test(error.message) && !error.message.includes('SECRET'));
  }
  for (const fetcher of [async () => new Response('<html>Bad gateway</html>'), async () => { throw new Error('SECRET network detail'); }]) {
    await assert.rejects(createMusicProvider({ FAL_KEY: 'SECRET' }, fetcher).submit(song), /invalid response/);
  }
});

test('failure or missing audio cannot become a completed job; untrusted URLs are rejected', async () => {
  const task = { id: 'remote', statusUrl: queueUrls.status_url, resultUrl: queueUrls.response_url };
  const failed = createMusicProvider({ FAL_KEY: 'key' }, async () => json({ status: 'COMPLETED', error: 'upstream secret' }));
  assert.equal((await failed.poll(task)).status, 'failed');
  for (const url of [undefined, 'http://127.0.0.1/private', 'https://fal.media.evil.test/track.mp3', 'https://user:pass@fal.media/track.mp3']) {
    const responses = [json({ status: 'COMPLETED' }), json({ audio: { url } })];
    const provider = createMusicProvider({ FAL_KEY: 'key' }, async () => responses.shift()!);
    await assert.rejects(provider.poll(task), /invalid result URL/);
  }
  const maliciousQueue = createMusicProvider({ FAL_KEY: 'key' }, async () => json({ ...queueUrls, status_url: 'https://evil.test/steal' }));
  await assert.rejects(maliciousQueue.submit(song), /invalid result URL/);
});

test('ACE-Step remains supported, uses correct language codes and authenticated audio', async () => {
  const calls: RequestInit[] = [];
  const responses = [json({}), json({ data: { task_id: 'ace123' } }), json({ data: [{ status: 1, result: JSON.stringify([{ file: '/v1/audio?path=result.mp3' }]) }] }), new Response('mp3')];
  const provider = createMusicProvider({ MUSIC_PROVIDER: 'acestep', ACESTEP_API_URL: 'http://localhost:8001', ACESTEP_API_KEY: 'secret' }, async (_url, init) => { calls.push(init!); return responses.shift()!; });
  assert.equal((await provider.status()).available, true);
  const task = await provider.submit({ ...song, language: 'Japanese' });
  const submitted = JSON.parse(String(calls[1].body));
  assert.equal(submitted.vocal_language, 'ja');
  assert.match(submitted.prompt, /enhanced studio-focused/i);
  const result = await provider.poll(task);
  assert.deepEqual(result, { status: 'complete', audioUrl: 'http://localhost:8001/v1/audio?path=result.mp3' });
  await provider.audio('http://localhost:8001/v1/audio?path=result.mp3');
  assert.equal(new Headers(calls[3].headers).get('Authorization'), 'Bearer secret');
});

test('ACE-Step preserves native-script prompts and uses detection for languages outside its documented enum', async () => {
  const bodies: any[] = [];
  const provider = createMusicProvider({ MUSIC_PROVIDER: 'acestep', ACESTEP_API_URL: 'http://localhost:8001' }, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return json({ data: { task_id: 'ace-' + bodies.length } });
  });
  const tamil = 'மழையில் பாடும் மனம்';
  const manipuri = 'ꯅꯨꯡꯁꯤꯕꯥꯒꯤ ꯏꯁꯩ';
  await provider.submit(validateSong({ ...song, language: 'Tamil', lyrics: [{ section: 'Verse', lines: [tamil] }] }));
  await provider.submit(validateSong({ ...song, language: 'Manipuri', lyrics: [{ section: 'Verse', lines: [manipuri] }] }));
  assert.equal(bodies[0].vocal_language, 'ta');
  assert.equal(bodies[1].vocal_language, 'unknown');
  assert.match(bodies[0].prompt, /preserve their native script and language/);
  assert.ok(bodies[0].lyrics.includes(tamil));
  assert.ok(bodies[1].lyrics.includes(manipuri));
});

async function serve(provider: MusicProvider, run: (url: string) => Promise<void>, options = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/music', createMusicRouter(provider, options));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/music`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

const stubProvider = (): MusicProvider => ({
  name: 'test-provider', async status() { return { available: true, provider: 'test', message: 'Test only' }; },
  async submit() { return { id: 'remote123' }; },
  async poll() { return { status: 'complete', audioUrl: 'https://v3.fal.media/file.mp3' }; },
  async audio() { return new Response('abc', { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 0-2/10', 'Accept-Ranges': 'bytes', 'Content-Length': '3' } }); },
});
const createJob = (url: string, key = 'unique-request-123') => fetch(`${url}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(song) });

test('HTTP lifecycle deduplicates submissions, completes once and proxies range audio', async () => {
  const provider = stubProvider();
  let submissions = 0, polls = 0;
  provider.submit = async () => { submissions++; return { id: 'remote123' }; };
  provider.poll = async () => { polls++; return { status: 'complete', audioUrl: 'https://v3.fal.media/file.mp3' }; };
  await serve(provider, async url => {
    const responses = await Promise.all([createJob(url), createJob(url)]);
    assert.equal(responses[0].status, 202);
    const first = await responses[0].json(), second = await responses[1].json();
    assert.equal(first.taskId, second.taskId);
    assert.equal(submissions, 1);
    const completed = await (await fetch(`${url}/jobs/${first.taskId}`)).json();
    assert.equal(completed.status, 'complete');
    assert.equal(completed.audioUrl, `/api/music/jobs/${first.taskId}/audio`);
    assert.ok(!JSON.stringify(completed).includes('fal.media'));
    await fetch(`${url}/jobs/${first.taskId}`);
    assert.equal(polls, 1);
    const audio = await fetch(`${url}/jobs/${first.taskId}/audio`, { headers: { Range: 'bytes=0-2' } });
    assert.equal(audio.status, 206);
    assert.equal(audio.headers.get('content-range'), 'bytes 0-2/10');
    assert.equal(await audio.text(), 'abc');
    assert.equal((await fetch(`${url}/jobs/missing`)).status, 404);
    const conflict = await fetch(`${url}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'unique-request-123' }, body: JSON.stringify({ ...song, bpm: 90 }) });
    assert.equal(conflict.status, 409);
  });
});

test('HTTP timeout and retention are bounded; no completion or audio on failed jobs', async () => {
  let time = 1000;
  const provider = stubProvider();
  provider.poll = async () => ({ status: 'generating', message: 'Working' });
  await serve(provider, async url => {
    const { taskId } = await (await createJob(url)).json();
    assert.equal((await (await fetch(`${url}/jobs/${taskId}`)).json()).status, 'generating');
    time += 100;
    const failed = await (await fetch(`${url}/jobs/${taskId}`)).json();
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /timed out/);
    assert.equal((await fetch(`${url}/jobs/${taskId}/audio`)).status, 404);
    time += 3_600_001;
    assert.equal((await fetch(`${url}/jobs/${taskId}`)).status, 404);
  }, { timeoutMs: 100, now: () => time });
});

test('HTTP missing key and malformed songs fail clearly; bad audio receives 502', async () => {
  await serve(createMusicProvider({ MUSIC_PROVIDER: 'none' }), async url => {
    assert.equal((await createJob(url)).status, 503);
    assert.equal((await fetch(`${url}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  });
  const provider = stubProvider();
  provider.audio = async () => new Response('<html>expired</html>', { headers: { 'Content-Type': 'text/html' } });
  await serve(provider, async url => {
    const { taskId } = await (await createJob(url)).json();
    await fetch(`${url}/jobs/${taskId}`);
    assert.equal((await fetch(`${url}/jobs/${taskId}/audio`)).status, 502);
  });
});
