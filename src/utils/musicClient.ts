import type { SongMetadata, VocalGeneration } from '../types';

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function readJson(response: Response) {
  let result;
  try { result = await response.json(); } catch { throw new Error('The app server returned an invalid response. Check its connection.'); }
  if (!response.ok) throw new Error(result.error || 'The app server could not process the vocal request.');
  return result;
}

export async function generateVocalSong(
  song: SongMetadata,
  onUpdate: (state: VocalGeneration) => void,
  signal: AbortSignal,
  options: { fetcher?: typeof fetch; pollMs?: number } = {},
): Promise<string> {
  const fetcher = options.fetcher || fetch;
  onUpdate({ status: 'submitting', message: 'Sending lyrics to the music provider…' });
  // A submission is never automatically retried: it can incur a provider charge.
  const created = await readJson(await fetcher('/api/music/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(song), signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
  }));
  if (typeof created.taskId !== 'string' || !created.taskId) throw new Error('The app server did not return a vocal job ID.');
  const taskId = created.taskId;
  const timeoutMs = Number.isFinite(created.timeoutMs) ? Math.min(Math.max(created.timeoutMs, 30_000), 1_800_000) : 600_000;
  const deadline = Date.now() + timeoutMs;
  onUpdate({ status: 'queued', taskId, message: 'Song submitted. Waiting for the music provider…' });
  while (Date.now() < deadline) {
    await delay(options.pollMs ?? 3000, signal);
    const result = await readJson(await fetcher(`/api/music/jobs/${encodeURIComponent(taskId)}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(45_000, Math.max(1, deadline - Date.now())))]),
    }));
    signal.throwIfAborted();
    if (result.status === 'failed') throw new Error(result.error || 'Vocal generation failed.');
    if (result.status === 'complete') {
      if (typeof result.audioUrl !== 'string' || !result.audioUrl.startsWith('/api/music/jobs/') || !result.audioUrl.endsWith('/audio')) {
        throw new Error('The music provider finished without a playable audio file.');
      }
      onUpdate({ status: 'complete', taskId, message: 'AI vocal song ready. Press Play.', provider: result.provider });
      return result.audioUrl;
    }
    if (!['queued', 'generating'].includes(result.status)) throw new Error('The app server returned an unknown generation state.');
    onUpdate({ status: result.status, taskId, message: result.message || 'Generating AI vocals…', queuePosition: result.queuePosition, provider: result.provider });
  }
  throw new Error('Vocal generation timed out. The provider may still finish and charge for it; check its dashboard before retrying.');
}
