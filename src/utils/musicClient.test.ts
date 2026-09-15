import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVocalSong } from './musicClient';
import { initialSongs } from './initialSongs';
import type { VocalGeneration } from '../types';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

test('client reports submission, queue, generation, completion and returns playable audio', async () => {
  const updates: VocalGeneration[] = [];
  const responses = [json({ taskId: 'job123', timeoutMs: 60000 }), json({ status: 'queued', queuePosition: 3 }), json({ status: 'generating' }), json({ status: 'complete', audioUrl: '/api/music/jobs/job123/audio', provider: 'fal' })];
  const url = await generateVocalSong(initialSongs[0], state => updates.push(state), new AbortController().signal, { pollMs: 0, fetcher: async () => responses.shift()! });
  assert.equal(url, '/api/music/jobs/job123/audio');
  assert.deepEqual(updates.map(v => v.status), ['submitting', 'queued', 'queued', 'generating', 'complete']);
  assert.equal(updates[2].queuePosition, 3);
});

test('client never retries paid submissions and surfaces provider failures or invalid output', async () => {
  let requests = 0;
  await assert.rejects(generateVocalSong(initialSongs[0], () => {}, new AbortController().signal, { pollMs: 0, fetcher: async () => { requests++; return json({ error: 'Missing credits' }, 503); } }), /Missing credits/);
  assert.equal(requests, 1);
  for (const result of [{ status: 'failed', error: 'Provider failed' }, { status: 'complete' }, { status: 'complete', audioUrl: 'https://evil.test/file.mp3' }, { status: 'surprise' }]) {
    const responses = [json({ taskId: 'job123' }), json(result)];
    await assert.rejects(generateVocalSong(initialSongs[0], () => {}, new AbortController().signal, { pollMs: 0, fetcher: async () => responses.shift()! }));
  }
});

test('aborting during polling prevents stale song completion', async () => {
  const controller = new AbortController();
  const updates: string[] = [];
  await assert.rejects(generateVocalSong(initialSongs[0], state => {
    updates.push(state.status);
    if (state.status === 'queued') controller.abort();
  }, controller.signal, { pollMs: 0, fetcher: async () => json({ taskId: 'job123' }) }), error => error instanceof Error && error.name === 'AbortError');
  assert.deepEqual(updates, ['submitting', 'queued']);
});
