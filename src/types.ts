export interface User { id: string; username: string }
export const SCHEDULED_INDIAN_LANGUAGES = [
  'Assamese', 'Bengali', 'Bodo', 'Dogri', 'Gujarati', 'Hindi', 'Kannada', 'Kashmiri',
  'Konkani', 'Maithili', 'Malayalam', 'Manipuri', 'Marathi', 'Nepali', 'Odia',
  'Punjabi', 'Sanskrit', 'Santali', 'Sindhi', 'Tamil', 'Telugu', 'Urdu',
] as const;
export const ADDITIONAL_INDIAN_LANGUAGES = ['Bhojpuri', 'Tulu', 'Pahadi'] as const;
export const INTERNATIONAL_LANGUAGES = ['English', 'Spanish', 'French', 'Arabic', 'Korean', 'Japanese'] as const;
export const LANGUAGES = [
  'English', ...SCHEDULED_INDIAN_LANGUAGES, ...ADDITIONAL_INDIAN_LANGUAGES,
  'Spanish', 'French', 'Arabic', 'Korean', 'Japanese',
] as const;
export type Language = typeof LANGUAGES[number];

export interface KaraokeBackingMetadata {
  /** IndexedDB identifier. The audio Blob is deliberately not stored in localStorage. */
  id: string;
  name: string;
  duration: number;
  bpm: number;
  sampleRate: number;
  processing: {
    centerReduction: number;
    bassPreservation: number;
    semitones: number;
    sourceKey?: string;
    targetKey?: string;
  };
}

export interface SongMetadata {
  id: string;
  title: string;
  description: string;
  mood: string;
  genre: string;
  language: string;
  tempo: string;
  bpm: number;
  key: string;
  emotion: string;
  singerStyle: string;
  /** Requests a cleaner, more prominent studio-style lead vocal from AI music providers. */
  enhancedVoice?: boolean;
  theme?: string;
  instruments: string[];
  creativity: number;
  createdAt: string;
  coverArtSeed: string; // Used to draw unique visual graphics
  visualizerTheme: {
    primary: string;
    secondary: string;
    glow: string;
    background: string;
  };
  lyrics: {
    section: string; // "Intro", "Verse 1", "Chorus", "Verse 2", "Chorus", "Outro"
    lines: string[];
  }[];
  chordProgression: {
    verse: string[];
    chorus: string[];
    bridge?: string[];
  };
  melodySeed: number; // Seed to reliably generate the same beautiful melody for this song
  audioUrl?: string; // Same-origin URL for the generated vocal song
  lyricsSource?: 'ai' | 'template' | 'user';
  vocalGeneration?: VocalGeneration;
  /** Quarter-note positions captured by the manual lyric timing editor. */
  lyricTiming?: number[];
  /** Metadata for a user-supplied, locally processed karaoke backing. */
  backingTrack?: KaraokeBackingMetadata;
}

export interface MusicProviderStatus {
  provider: string;
  available: boolean;
  message: string;
  timeoutMs?: number;
}

export interface VocalGeneration {
  status: 'submitting' | 'queued' | 'generating' | 'complete' | 'failed';
  message: string;
  taskId?: string;
  queuePosition?: number;
  provider?: string;
}
