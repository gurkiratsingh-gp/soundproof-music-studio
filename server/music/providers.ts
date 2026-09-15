import { LANGUAGES, type SongMetadata, type MusicProviderStatus } from '../../src/types';
import { createGeminiMusicProvider } from './gemini';

export type MusicInput = Pick<SongMetadata, 'description' | 'genre' | 'mood' | 'singerStyle' | 'enhancedVoice' | 'emotion' | 'language' | 'instruments' | 'bpm' | 'key' | 'lyrics'>;
export type ProviderTask = { id: string; statusUrl?: string; resultUrl?: string };
export type ProviderResult =
  | { status: 'queued' | 'generating'; message: string; queuePosition?: number }
  | { status: 'complete'; audioUrl: string }
  | { status: 'failed'; error: string };

export interface MusicProvider {
  name: string;
  status(): Promise<MusicProviderStatus>;
  submit(song: MusicInput): Promise<ProviderTask>;
  poll(task: ProviderTask): Promise<ProviderResult>;
  audio(url: string, range?: string): Promise<Response>;
}

export class MusicError extends Error {
  constructor(message: string, public httpStatus = 502) { super(message); }
}

export function validateSong(value: unknown): MusicInput {
  if (!value || typeof value !== 'object') throw new MusicError('A song is required.', 400);
  const song = value as Record<string, unknown>;
  for (const field of ['description', 'genre', 'mood', 'singerStyle', 'emotion', 'language', 'key']) {
    if (typeof song[field] !== 'string' || !(song[field] as string).trim() || (song[field] as string).length > 2000) {
      throw new MusicError(`Invalid song ${field}.`, 400);
    }
  }
  if (!LANGUAGES.includes(song.language as typeof LANGUAGES[number])) throw new MusicError('Choose a supported song language.', 400);
  if (!Number.isFinite(song.bpm) || Number(song.bpm) < 40 || Number(song.bpm) > 240) {
    throw new MusicError('BPM must be between 40 and 240.', 400);
  }
  if (song.enhancedVoice !== undefined && typeof song.enhancedVoice !== 'boolean') {
    throw new MusicError('Invalid voice quality.', 400);
  }
  if (!Array.isArray(song.instruments) || song.instruments.length > 20 || song.instruments.some(v => typeof v !== 'string' || v.length > 100)) {
    throw new MusicError('Invalid instruments.', 400);
  }
  if (!Array.isArray(song.lyrics) || !song.lyrics.length || song.lyrics.length > 30 || song.lyrics.some(part =>
    !part || typeof part.section !== 'string' || part.section.length > 80 || !Array.isArray(part.lines) ||
    part.lines.length > 50 || part.lines.some((line: unknown) => typeof line !== 'string' || line.length > 1000)
  )) throw new MusicError('Provide structured lyrics before generating vocals.', 400);
  if (!song.lyrics.some(part => part.lines.some((line: string) => line.trim() && !/^\[.*\]$/.test(line.trim())))) {
    throw new MusicError('Provide some words to sing before generating vocals.', 400);
  }
  return { ...song, enhancedVoice: song.enhancedVoice !== false } as MusicInput;
}

// Keep every lyric; reject oversized submissions instead of silently cutting a song short.
export const lyricsToText = (song: MusicInput) => song.lyrics.map(part => {
  const section = part.section.replace(/\s+\d+$/, '').replace(/[\[\]\r\n]/g, '');
  return `[${section}]\n${part.lines.join('\n')}`;
}).join('\n\n');

const stylePrompt = (song: MusicInput) => [
  `${song.genre}, ${song.mood} mood, ${song.emotion} emotion`,
  song.enhancedVoice === false
    ? `Natural expressive ${song.singerStyle} singing vocals in ${song.language}; sing the supplied Unicode lyrics rather than speaking them and preserve their native script and language`
    : `Enhanced studio-focused ${song.singerStyle} lead vocal in ${song.language}: prominent over the mix, clean diction, stable pitch, controlled dynamics, and tasteful chorus doubling; sing the supplied Unicode lyrics rather than speaking them and preserve their native script and language`,
  `${song.bpm} BPM, ${song.key}, ${song.instruments.join(', ')}`,
  song.description,
].join('. ').slice(0, 2000);

const providerFailure = (status: number) => {
  if (status === 401 || status === 403) return 'The music provider rejected its API key. Check the server credentials and model access.';
  if (status === 402) return 'The music provider has insufficient credits. Add credits to the provider account.';
  if (status === 429) return 'The music provider is busy or rate limited. Wait a little before retrying.';
  if (status === 400 || status === 422) return 'The music provider rejected this song. Check the lyrics length and try a simpler description.';
  if (status === 404) return 'The provider job or model is unavailable. Check the server configuration.';
  return 'The music provider is temporarily unavailable. Please try again later.';
};

async function request(fetcher: typeof fetch, url: string, init: RequestInit = {}) {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new MusicError(providerFailure(response.status));
    return await response.json();
  } catch (error) {
    if (error instanceof MusicError) throw error;
    // Never relay upstream bodies/URLs/credentials to the browser.
    throw new MusicError('Could not reach the music provider, or it returned an invalid response. Please try again later.');
  }
}

function falUrl(value: unknown, kind: 'queue' | 'audio'): string {
  try {
    const url = new URL(String(value));
    const allowed = kind === 'queue' ? url.hostname === 'queue.fal.run' : url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed) throw new Error();
    return url.href;
  } catch { throw new MusicError('The music provider returned an invalid result URL.'); }
}

export function createMusicProvider(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): MusicProvider {
  const selected = env.MUSIC_PROVIDER?.trim().toLowerCase() || 'fal';
  if (selected === 'gemini') return createGeminiMusicProvider(env, fetcher);
  if (selected === 'fal' && env.FAL_KEY?.trim()) {
    const headers = { Authorization: `Key ${env.FAL_KEY.trim()}`, 'Content-Type': 'application/json' };
    const model = 'fal-ai/minimax-music/v2.6';
    return {
      name: 'MiniMax Music 2.6 via fal',
      async status() { return { provider: 'fal', available: true, message: 'MiniMax Music 2.6 configured. Generate AI vocals from a song; provider access is checked on submission.' }; },
      async submit(song) {
        const lyrics = lyricsToText(song);
        if (lyrics.length > 3500) throw new MusicError('MiniMax accepts up to 3,500 lyric characters including section labels. Use a shorter song.', 400);
        const result = await request(fetcher, `https://queue.fal.run/${model}`, {
          method: 'POST', headers,
          body: JSON.stringify({ prompt: stylePrompt(song), lyrics, is_instrumental: false, lyrics_optimizer: false,
            audio_setting: { format: 'mp3', sample_rate: 44100, bitrate: 128000 } }),
        });
        if (typeof result?.request_id !== 'string' || !result.request_id) throw new MusicError('The music provider did not return a job ID.');
        // Use returned operation URLs: queue paths need not match the model's subpath.
        return { id: result.request_id, statusUrl: falUrl(result.status_url, 'queue'), resultUrl: falUrl(result.response_url, 'queue') };
      },
      async poll(task) {
        const result = await request(fetcher, falUrl(task.statusUrl, 'queue'), { headers });
        if (result.error || result.status === 'FAILED') return { status: 'failed', error: 'The provider could not generate this song. Try simpler lyrics or a different description.' };
        if (result.status === 'IN_QUEUE') {
          const queuePosition = Number.isInteger(result.queue_position) && result.queue_position >= 0 ? result.queue_position : undefined;
          return { status: 'queued', message: 'Waiting for the music provider.', queuePosition };
        }
        if (result.status === 'IN_PROGRESS') return { status: 'generating', message: 'Creating singing vocals and accompaniment. This can take several minutes.' };
        if (result.status !== 'COMPLETED') throw new MusicError('The music provider returned an unknown job state.');
        const output = await request(fetcher, falUrl(task.resultUrl, 'queue'), { headers });
        return { status: 'complete', audioUrl: falUrl(output?.audio?.url, 'audio') };
      },
      audio(url, range) {
        // CDN downloads are public; never attach the API key here.
        return fetcher(falUrl(url, 'audio'), { headers: range ? { Range: range } : {}, redirect: 'error', signal: AbortSignal.timeout(60_000) });
      },
    };
  }
  if (selected === 'acestep') {
    let base: URL;
    try {
      base = new URL(env.ACESTEP_API_URL || 'http://127.0.0.1:8001');
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error();
    } catch { throw new Error('ACESTEP_API_URL must be an HTTP(S) server URL without credentials.'); }
    const origin = base.origin;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (env.ACESTEP_API_KEY) headers.Authorization = `Bearer ${env.ACESTEP_API_KEY}`;
    const audioUrl = (file: unknown) => {
      if (typeof file !== 'string' || !file.startsWith('/v1/audio?') || file.includes('#')) throw new MusicError('ACE-Step returned an invalid audio path.');
      return `${origin}${file}`;
    };
    return {
      name: 'ACE-Step',
      async status() {
        try {
          const response = await fetcher(`${origin}/health`, { headers, signal: AbortSignal.timeout(8000), redirect: 'error' });
          if (!response.ok) throw new Error();
          return { provider: 'acestep', available: true, message: 'ACE-Step connected. Generate AI vocals from a song.' };
        } catch { return { provider: 'acestep', available: false, message: 'ACE-Step is unavailable. Start the GPU server and check ACESTEP_API_URL. Instrumental preview is available.' }; }
      },
      async submit(song) {
        // ACE-Step's documented language enum is smaller than Kavi's writing
        // catalog. Use its automatic detection mode instead of falsely marking
        // an unsupported Indian language as English.
        const languageCodes: Record<string, string> = {
          english: 'en', hindi: 'hi', bengali: 'bn', nepali: 'ne', punjabi: 'pa',
          sanskrit: 'sa', tamil: 'ta', telugu: 'te', urdu: 'ur', spanish: 'es',
          french: 'fr', arabic: 'ar', korean: 'ko', japanese: 'ja',
        };
        const result = await request(fetcher, `${origin}/release_task`, { method: 'POST', headers, body: JSON.stringify({
          prompt: stylePrompt(song), lyrics: lyricsToText(song), thinking: false, use_cot_caption: false, use_cot_language: false,
          vocal_language: languageCodes[song.language.toLowerCase()] || 'unknown', audio_format: 'mp3', audio_duration: 30,
          bpm: song.bpm, key_scale: song.key, time_signature: '4', inference_steps: 8, batch_size: 1, model: 'acestep-v15-turbo',
        }) });
        if (typeof result?.data?.task_id !== 'string' || result.error) throw new MusicError('ACE-Step did not accept the song.');
        return { id: result.data.task_id };
      },
      async poll(task) {
        const payload = await request(fetcher, `${origin}/query_result`, { method: 'POST', headers, body: JSON.stringify({ task_id_list: [task.id] }) });
        const result = payload?.data?.[0];
        if (!result) throw new MusicError('ACE-Step task was not found.');
        if (result.status === 2) return { status: 'failed', error: 'ACE-Step could not generate this song. Check the GPU server and retry.' };
        if (result.status !== 1) return { status: 'generating', message: 'ACE-Step is creating a 30-second vocal preview.' };
        try {
          const files = typeof result.result === 'string' ? JSON.parse(result.result) : result.result;
          return { status: 'complete', audioUrl: audioUrl(files?.[0]?.file) };
        } catch { throw new MusicError('ACE-Step finished without a valid audio file.'); }
      },
      audio(url, range) {
        const parsed = new URL(url);
        if (parsed.origin !== origin || parsed.pathname !== '/v1/audio') throw new MusicError('Invalid ACE-Step audio URL.');
        return fetcher(url, { headers: { ...headers, ...(range ? { Range: range } : {}) }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
      },
    };
  }
  const message = selected === 'none' ? 'AI vocals are disabled. Instrumental preview is available.'
    : selected === 'fal' ? 'AI vocals need a server FAL_KEY. Add it to .env.local and restart. Instrumental preview is available.'
    : 'Unknown MUSIC_PROVIDER. Choose gemini, fal, acestep, or none in the server environment.';
  return { name: selected, async status() { return { provider: selected, available: false, message }; },
    async submit() { throw new MusicError(message, 503); }, async poll() { throw new MusicError(message, 503); }, async audio() { throw new MusicError(message, 503); } };
}
