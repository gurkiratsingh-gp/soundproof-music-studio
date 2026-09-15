// Local UI verification only. Never imported by the application or production build.
// This deliberately returns a test tone, not AI singing, and never calls a paid API.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createMusicRouter } from '../server/music/routes';
import type { MusicProvider, MusicInput } from '../server/music/providers';
import { initialSongs } from '../src/utils/initialSongs';
import { createAuth, sameOrigin } from '../server/auth';
import { DEFAULT_DRAFT } from '../src/utils/songDraft';
import { starterLyrics } from '../src/utils/starterLyrics';
import path from 'node:path';

const sampleRate = 8000;
const dataSize = sampleRate * 12 * 2;
const wav = Buffer.alloc(44 + dataSize);
wav.write('RIFF'); wav.writeUInt32LE(36 + dataSize, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
for (let i = 0; i < dataSize / 2; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / sampleRate) * 1000), 44 + i * 2);

const tasks = new Map<string, { count: number; song: MusicInput }>();
const provider: MusicProvider = {
  name: 'TEST FIXTURE — tone, not singing',
  async status() { return { provider: 'test', available: true, message: 'TEST FIXTURE: no paid calls. Returned audio is a test tone. Descriptions containing fail or broken simulate errors.' }; },
  async submit(song) { const id = randomUUID(); tasks.set(id, { count: 0, song }); return { id }; },
  async poll(task) {
    const entry = tasks.get(task.id)!;
    entry.count++;
    if (entry.count < 2) return { status: 'queued', queuePosition: 1, message: 'Test queue: waiting.' };
    if (entry.count < 4) return { status: 'generating', message: 'Test generation in progress.' };
    if (entry.song.description.includes('fail')) return { status: 'failed', error: 'Simulated provider failure.' };
    return { status: 'complete', audioUrl: entry.song.description.includes('broken') ? 'broken' : 'fixture' };
  },
  async audio(url, range) {
    if (url === 'broken') return new Response('Gone', { status: 502 });
    const match = range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), wav.length - 1) : wav.length - 1;
    return new Response(wav.subarray(start, end + 1), { status: match ? 206 : 200, headers: {
      'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}),
    } });
  },
};
const app = express();
app.use(express.json());
app.use('/api', sameOrigin);
const auth = createAuth({ directory: path.resolve('.data/browser-fixture') });
app.use('/api/auth', auth.router);
app.use('/api', (req, res, next) => req.path === '/music/status' ? next() : auth.requireUser(req, res, next));
app.use('/api/music', createMusicRouter(provider));
app.post('/api/compose', (req, res) => res.json({ ...initialSongs[0], title: `Test: ${req.body.description.slice(0, 60)}`, lyrics: starterLyrics(req.body.language) }));
app.post('/api/chat', (req, res) => {
  if (req.body.message?.includes('fail')) return res.status(502).json({ error: 'Simulated assistant failure.' });
  res.json({ reply: 'TEST FIXTURE: this is a scripted response, not AI. Open the draft or save a revision to check the workflow.', ideas: [{ title: 'Test acoustic idea', prompt: 'A soft acoustic song, 75 BPM' }], draft: { ...DEFAULT_DRAFT, ...req.body.song, title: 'Test revision', language: req.body.language, description: 'A soft acoustic song, 75 BPM', lyrics: starterLyrics(req.body.language) } });
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown fixture route.' }));
app.get(['/server.cjs', '/server.cjs.map'], (_req, res) => { res.sendStatus(404); });
app.use(express.static('dist'));
app.listen(3001, '127.0.0.1', () => console.log('Test-only browser fixture: http://127.0.0.1:3001 (no real AI calls)'));
