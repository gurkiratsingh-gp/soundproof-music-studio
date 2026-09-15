import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MusicError, validateSong, type MusicProvider, type ProviderTask, type ProviderResult } from './providers';

type Job = { owner?: string; task?: ProviderTask; createdAt: number; result: ProviderResult; poll?: Promise<void> };

export function createMusicRouter(provider: MusicProvider, options: { timeoutMs?: number; now?: () => number } = {}) {
  const router = Router();
  const jobs = new Map<string, Job>();
  const requests = new Map<string, { fingerprint: string; response: Promise<string> }>();
  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs || 600_000;
  const retentionMs = Math.max(timeoutMs, 3_600_000);
  const errorMessage = (error: unknown) => error instanceof MusicError ? error.message : 'Music generation is unavailable. Please try again later.';
  const cleanup = () => {
    for (const [id, job] of jobs) if (now() - job.createdAt > retentionMs) { jobs.delete(id); requests.delete(id); }
  };
  const publicJob = (id: string, job: Job) => job.result.status === 'complete'
    ? { status: 'complete', message: 'AI vocal song ready. Press Play.', audioUrl: `/api/music/jobs/${id}/audio`, provider: provider.name }
    : { ...job.result, provider: provider.name };

  router.get('/status', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...await provider.status(), timeoutMs });
  });

  router.post('/jobs', async (req, res) => {
    cleanup();
    try {
      const song = validateSong(req.body);
      const key = req.get('Idempotency-Key') || randomUUID();
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new MusicError('Invalid request key.', 400);
      const fingerprint = JSON.stringify(song);
      const prior = requests.get(key);
      if (prior && jobs.get(key)?.owner !== res.locals.user?.id) throw new MusicError('This request key is already in use.', 409);
      if (prior && prior.fingerprint !== fingerprint) throw new MusicError('This request key was already used for a different song.', 409);
      if (prior) return res.status(202).json({ taskId: await prior.response, timeoutMs });
      if (jobs.size >= 100) throw new MusicError('The demo server has reached its job limit. Restart it or wait an hour.', 503);
      const job: Job = { owner: res.locals.user?.id, createdAt: now(), result: { status: 'queued', message: 'Submitting song to the music provider.' } };
      jobs.set(key, job);
      const response = provider.submit(song).then(task => { job.task = task; return key; }).catch(error => {
        job.result = { status: 'failed', error: errorMessage(error) };
        throw error;
      });
      requests.set(key, { fingerprint, response });
      res.status(202).json({ taskId: await response, timeoutMs });
    } catch (error) { res.status(error instanceof MusicError ? error.httpStatus : 502).json({ error: errorMessage(error) }); }
  });

  router.get('/jobs/:id', async (req, res) => {
    cleanup();
    res.setHeader('Cache-Control', 'no-store');
    const job = jobs.get(req.params.id);
    if (!job || job.owner !== res.locals.user?.id) return res.status(404).json({ error: 'This vocal job expired or the server restarted. Generate the vocal again.' });
    if (job.result.status !== 'complete' && job.result.status !== 'failed') {
      if (now() - job.createdAt >= timeoutMs) {
        job.result = { status: 'failed', error: 'Vocal generation timed out. The provider may still finish and charge for it; check its dashboard before retrying. Instrumental preview is available.' };
      } else if (job.task) {
        // One upstream poll per job even when more than one browser checks it.
        job.poll ||= provider.poll(job.task).then(result => { job.result = result; }).catch(error => {
          job.result = { status: 'failed', error: errorMessage(error) };
        }).finally(() => { job.poll = undefined; });
        await job.poll;
      }
    }
    res.json(publicJob(req.params.id, job));
  });

  router.get('/jobs/:id/audio', async (req, res) => {
    cleanup();
    const job = jobs.get(req.params.id);
    if (!job || job.owner !== res.locals.user?.id || job.result.status !== 'complete') return res.status(404).json({ error: 'Vocal audio expired or is not ready. Use the instrumental preview or generate again.' });
    try {
      const upstream = await provider.audio(job.result.audioUrl, req.get('range'));
      if (upstream.status === 416) {
        if (upstream.headers.has('content-range')) res.setHeader('Content-Range', upstream.headers.get('content-range')!);
        await upstream.body?.cancel();
        return res.sendStatus(416);
      }
      const type = upstream.headers.get('content-type') || '';
      if (!upstream.ok || !upstream.body || !/^(audio\/|application\/octet-stream)/i.test(type)) {
        await upstream.body?.cancel();
        throw new MusicError('The generated audio could not be loaded.');
      }
      res.status(upstream.status);
      for (const header of ['content-length', 'content-range', 'accept-ranges']) {
        if (upstream.headers.has(header)) res.setHeader(header, upstream.headers.get(header)!);
      }
      res.setHeader('Content-Type', type.startsWith('audio/') ? type : 'audio/mpeg');
      res.setHeader('Content-Disposition', 'inline; filename="ai-vocal.mp3"');
      res.setHeader('Cache-Control', 'private, max-age=300');
      await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), res);
    } catch {
      if (!res.headersSent) res.status(502).json({ error: 'Vocal audio could not be downloaded. Use the instrumental preview or generate again.' });
      else res.destroy();
    }
  });
  return router;
}
