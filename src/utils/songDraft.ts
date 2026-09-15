import { LANGUAGES, type SongMetadata } from '../types';
import type { SongBrief } from './songArrangement';

export type SongDraft = SongBrief & { title?: string; lyrics?: SongMetadata['lyrics']; enhancedVoice?: boolean };
export const CHAT_MODES = ['co-write', 'ideas', 'lyrics', 'revise', 'practice'] as const;
export type ChatMode = typeof CHAT_MODES[number];
export type ChatReply = { reply: string; ideas: { title: string; prompt: string }[]; draft?: SongDraft; followUps?: string[]; changes?: string[] };
export const DEFAULT_DRAFT: SongDraft = { description: '', mood: 'Romantic', genre: 'Pop', language: 'English', tempo: 'Medium', emotion: 'Warm', singerStyle: 'Modern Pop', enhancedVoice: true, instruments: ['Piano', 'Drums', 'Bass'], creativity: 75 };
export const GENRES = ['Pop', 'Rock', 'Hip Hop', 'Jazz', 'Classical', 'LoFi', 'Electronic', 'Electronic Vibe', 'Acoustic', 'Ambient'];
const STORED_GENRES = [...GENRES, 'Karaoke'];
export const MOODS = ['Romantic', 'Happy', 'Sad', 'Motivational', 'Emotional', 'Party', 'Relax', 'Vibing'];
export const INSTRUMENTS = ['Piano', 'Acoustic Guitar', 'Electric Guitar', 'Drums', 'Bass', 'Synth', 'Violin', 'Flute', 'Saxophone', 'Tabla', 'Sitar', 'Strings', 'Trumpet'];
export const lyricsText = (lyrics: SongMetadata['lyrics']) => lyrics.map(part => '[' + part.section + ']\n' + part.lines.join('\n')).join('\n\n');
export function parseLyrics(text: string): SongMetadata['lyrics'] {
  const result: SongMetadata['lyrics'] = [];
  for (const line of text.split('\n')) {
    const heading = /^\[([^\]]{1,80})\]$/.exec(line.trim());
    if (heading) result.push({ section: heading[1], lines: [] });
    else if (line.trim()) { if (!result.length) result.push({ section: 'Verse', lines: [] }); result[result.length - 1].lines.push(line.trim()); }
  }
  return result.filter(part => part.lines.length > 0);
}
export function validateDraft(value: unknown): SongDraft {
  if (!value || typeof value !== 'object') throw new Error('Provide a song draft.');
  const draft = value as SongDraft;
  if (typeof draft.description !== 'string' || !draft.description.trim() || draft.description.length > 2000) throw new Error('Describe your song in 1–2,000 characters.');
  if (!LANGUAGES.includes(draft.language as typeof LANGUAGES[number])) throw new Error('Choose a supported songwriting language.');
  // Karaoke is an internal library type. Keeping it out of GENRES prevents the
  // original-song composer from presenting it as a generative music genre.
  if (!STORED_GENRES.includes(draft.genre) || !MOODS.includes(draft.mood)) throw new Error('Choose a supported genre and mood.');
  if (draft.bpm !== undefined && (!Number.isFinite(draft.bpm) || draft.bpm < 40 || draft.bpm > 240)) throw new Error('Tempo must be between 40 and 240 BPM.');
  if (draft.key !== undefined && (typeof draft.key !== 'string' || !/^[A-G](?:#|b)? (?:major|minor)$/i.test(draft.key))) throw new Error('Choose a musical key such as C major or A minor.');
  for (const field of ['tempo', 'emotion', 'singerStyle'] as const) if (typeof draft[field] !== 'string' || !draft[field].trim() || draft[field].length > 100) throw new Error('Check the song style settings.');
  if (draft.enhancedVoice !== undefined && typeof draft.enhancedVoice !== 'boolean') throw new Error('Choose a valid voice quality.');
  if (!Array.isArray(draft.instruments) || draft.instruments.length > 13 || draft.instruments.some(item => typeof item !== 'string' || !INSTRUMENTS.includes(item))) throw new Error('Choose supported instruments.');
  if (draft.lyrics !== undefined) {
    if (!Array.isArray(draft.lyrics) || draft.lyrics.length > 20 || draft.lyrics.some(part => !part || typeof part.section !== 'string' || part.section.length > 80 || !Array.isArray(part.lines) || part.lines.some(line => typeof line !== 'string' || line.length > 1000))) throw new Error('The lyrics format is invalid.');
    if (lyricsText(draft.lyrics).length > 3500) throw new Error('Keep lyrics under 3,500 characters.');
  }
  return { description: draft.description.trim(), mood: draft.mood, genre: draft.genre, language: draft.language, tempo: draft.tempo, emotion: draft.emotion, singerStyle: draft.singerStyle, enhancedVoice: draft.enhancedVoice !== false, instruments: [...draft.instruments], creativity: Number.isFinite(draft.creativity) ? Math.max(0, Math.min(100, draft.creativity)) : 75, ...(draft.bpm !== undefined ? { bpm: draft.bpm } : {}), ...(draft.key ? { key: draft.key } : {}), ...(draft.lyrics ? { lyrics: draft.lyrics } : {}), ...(typeof draft.title === 'string' ? { title: draft.title.slice(0, 120) } : {}) };
}
