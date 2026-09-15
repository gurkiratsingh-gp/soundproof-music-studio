import { randomUUID } from 'node:crypto';
import { MusicError, lyricsToText, type MusicProvider, type ProviderResult } from './providers';

export function googleError(status: number, reason = ''): string {
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid|API_KEY_EXPIRED/i.test(reason)) return 'Google rejected the Gemini key or model access. Replace GEMINI_API_KEY with a valid key that has access to the selected model, then restart the server.';
  if (status === 429) return 'Google quota is exhausted or requests are arriving too quickly. Check billing and quota in Google AI Studio before retrying.';
  if (status === 404) return 'This Google model is unavailable for your project. Check the configured model and your project access.';
  if (status === 400) return 'Google could not accept this request. Try shorter lyrics or a simpler song description.';
  return 'Google could not finish this request. Please try again later.';
}

// Lyria returns inline audio through the Interactions API. Keep the long request
// off the HTTP response path; the existing job API can poll this adapter.
export function createGeminiMusicProvider(env: NodeJS.ProcessEnv, fetcher: typeof fetch): MusicProvider {
  const key = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MUSIC_MODEL?.trim() || 'lyria-3.5';
  const timeoutMs = Number(env.MUSIC_JOB_TIMEOUT_MS) || 600000;
  type Entry = { createdAt: number; result: ProviderResult; bytes?: Buffer; mime?: string };
  const jobs = new Map<string, Entry>();
  const retentionMs = Math.max(timeoutMs, 3600000);
  const cleanup = () => { for (const [id, job] of jobs) if (Date.now() - job.createdAt > retentionMs) jobs.delete(id); };
  return {
    name: `Google Lyria (${model})`,
    async status() {
      return { provider: 'gemini', available: Boolean(key), message: key
        ? `Google Lyria is configured for singing. Key, billing and model access are checked when you generate a song.`
        : 'Add GEMINI_API_KEY to .env.local and restart to enable the AI songwriter and Google Lyria singing.' };
    },
    async submit(song) {
      if (!key) throw new MusicError('GEMINI_API_KEY is not configured.', 503);
      const lyrics = lyricsToText(song);
      if (lyrics.length > 3500) throw new MusicError('Keep the lyrics under 3,500 characters for this demo.', 400);
      cleanup();
      // Bounded audio cache: at most 12 recordings (each at most 16 MB).
      if (jobs.size >= 12) throw new MusicError('The local vocal cache is full. Download your songs, then restart the server or wait an hour.', 503);
      if ([...jobs.values()].filter(job => job.result.status === 'generating').length >= 2) throw new MusicError('Two songs are already generating. Wait for one to finish before starting another.', 429);
      const id = randomUUID();
      const entry: Entry = { createdAt: Date.now(), result: { status: 'generating', message: 'Lyria is composing and singing your lyrics. This can take several minutes.' } };
      jobs.set(id, entry);
      const input = [
        'Create an original complete song with an expressive, clearly audible singing voice and musical accompaniment. Do not narrate or speak the lyrics.',
        `Sing in ${song.language}. Style: ${song.genre}, ${song.mood}, ${song.emotion}. Vocal delivery: ${song.singerStyle}.`,
        song.enhancedVoice === false
          ? 'Keep the lead vocal natural and expressive, with an unprocessed intimate character.'
          : 'Use an enhanced studio-focused lead vocal: keep it prominent over the mix with clean diction, stable pitch, controlled dynamics, and tasteful chorus doubling.',
        `Tempo: ${song.bpm} BPM. Key: ${song.key}. Instruments: ${song.instruments.join(', ')}.`,
        `Creative direction: ${song.description}`,
        'Sing the following supplied Unicode lyrics in their original language and script. Do not translate or transliterate them. Use a short intro, verses, chorus and a natural ending. Follow these section labels:', lyrics,
      ].join('\n\n');
      void (async () => {
        try {
          const response = await fetcher('https://generativelanguage.googleapis.com/v1beta/interactions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ model, input }), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new MusicError(googleError(response.status, JSON.stringify(error)));
          }
          // Bound streamed JSON before decoding base64, including chunked responses.
          if (!response.body) throw new MusicError('Google returned an empty song response.');
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = []; let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 24 * 1024 * 1024) { await reader.cancel(); throw new MusicError('The generated song exceeded the demo audio size limit. Request a shorter song.'); }
            chunks.push(value);
          }
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const audio = result.steps?.filter((step: { type: string }) => step.type === 'model_output')
            .flatMap((step: { content?: unknown[] }) => step.content || []).find((block: { type: string }) => block.type === 'audio');
          if (!audio || typeof audio.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio.data)) throw new MusicError('Google finished without playable audio. Try a simpler song prompt.');
          const mime = audio.mime_type || 'audio/mpeg';
          if (!['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav'].includes(mime)) throw new MusicError('Google returned an unsupported audio format.');
          const bytes = Buffer.from(audio.data, 'base64');
          if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new MusicError('The returned audio is empty or too large for this demo.');
          entry.bytes = bytes;
          entry.mime = mime === 'audio/mp3' ? 'audio/mpeg' : mime;
          entry.result = { status: 'complete', audioUrl: id };
        } catch (error) {
          entry.result = { status: 'failed', error: error instanceof MusicError ? error.message
            : error instanceof Error && /Timeout|Abort/.test(error.name) ? 'Lyria generation timed out. Check your Google usage before retrying; the request may still be billed.'
            : 'Could not reach Google Lyria or read its response. Check the server connection and try again.' };
        }
      })();
      return { id };
    },
    async poll(task) {
      cleanup();
      return jobs.get(task.id)?.result || { status: 'failed', error: 'This recording expired. Please generate it again.' };
    },
    async audio(id, range) {
      cleanup();
      const job = jobs.get(id);
      if (!job?.bytes) throw new MusicError('The recording expired. Generate it again.', 404);
      const bytes = job.bytes;
      const headers = { 'Content-Type': job.mime!, 'Accept-Ranges': 'bytes' };
      if (!range) return new Response(new Uint8Array(bytes), { headers: { ...headers, 'Content-Length': String(bytes.length) } });
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = 0; let end = bytes.length - 1;
      if (match?.[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
      else if (match?.[2]) start = Math.max(0, bytes.length - Number(match[2]));
      if (!match || (!match[1] && !match[2]) || start > end || start >= bytes.length) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } });
      return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
    },
  };
}
