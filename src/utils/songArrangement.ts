import type { SongMetadata } from '../types';

export type SongBrief = Pick<SongMetadata, 'description' | 'mood' | 'genre' | 'language' | 'tempo' | 'emotion' | 'singerStyle' | 'theme' | 'instruments' | 'creativity'> & { bpm?: number; key?: string };
export type Groove = 'Pop' | 'Rock' | 'Hip Hop' | 'Jazz' | 'LoFi' | 'Electronic' | 'Electronic Vibe' | 'Acoustic' | 'Ambient';

const styleRules: Array<{ pattern: RegExp; genre: Groove; bpm: number; instruments: string[] }> = [
  { pattern: /\b(electronic vibe|vibing|chill electronic|deep house|future bass)\b/i, genre: 'Electronic Vibe', bpm: 116, instruments: ['Synth', 'Drums', 'Bass'] },
  { pattern: /\b(hip[ -]?hop|rap|trap)\b/i, genre: 'Hip Hop', bpm: 88, instruments: ['Drums', 'Bass', 'Synth'] },
  { pattern: /\b(jazz|swing)\b/i, genre: 'Jazz', bpm: 104, instruments: ['Piano', 'Bass', 'Drums', 'Saxophone'] },
  { pattern: /\b(lo[ -]?fi|chillhop)\b/i, genre: 'LoFi', bpm: 76, instruments: ['Piano', 'Bass', 'Drums'] },
  { pattern: /\b(rock|metal|punk)\b/i, genre: 'Rock', bpm: 142, instruments: ['Electric Guitar', 'Drums', 'Bass'] },
  { pattern: /\b(edm|electronic|techno|house|dance|disco|club)\b/i, genre: 'Electronic', bpm: 128, instruments: ['Synth', 'Drums', 'Bass'] },
  { pattern: /\b(ambient|meditation|meditative|soundscape)\b/i, genre: 'Ambient', bpm: 64, instruments: ['Strings', 'Flute'] },
  { pattern: /\b(acoustic|ballad|lullaby|folk)\b/i, genre: 'Acoustic', bpm: 76, instruments: ['Acoustic Guitar', 'Piano'] },
  { pattern: /\bpop\b/i, genre: 'Pop', bpm: 112, instruments: ['Piano', 'Drums', 'Bass', 'Synth'] },
];
const promptMoodBpmOffsets: Record<string, number> = { Romantic: -4, Happy: 6, Sad: -10, Motivational: 8, Emotional: -6, Party: 12, Relax: -12, Vibing: 0 };

/** Small, visible prompt cues, not a replacement for the AI songwriter. */
export function resolveSongBrief(brief: SongBrief, followPrompt = true): SongBrief {
  if (!followPrompt) return { ...brief, instruments: [...brief.instruments] };
  const text = brief.description;
  const rule = styleRules.find(rule => rule.pattern.test(text));
  const resolved = { ...brief, instruments: [...(rule?.instruments || brief.instruments)] };
  if (rule) { resolved.genre = rule.genre; resolved.bpm = rule.bpm; }
  const mentions: Array<[RegExp, string]> = [
    [/\belectric guitar\b/i, 'Electric Guitar'], [/\b(acoustic guitar|guitar)\b/i, 'Acoustic Guitar'],
    [/\bpiano\b/i, 'Piano'], [/\bsynth(?:esizer)?s?\b/i, 'Synth'], [/\bviolin\b/i, 'Violin'],
    [/\bflute\b/i, 'Flute'], [/\bsax(?:ophone)?\b/i, 'Saxophone'], [/\btabla\b/i, 'Tabla'],
    [/\bsitar\b/i, 'Sitar'], [/\bstrings\b/i, 'Strings'], [/\btrumpet\b/i, 'Trumpet'],
  ];
  let named = mentions.filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
  if (named.includes('Electric Guitar')) named = named.filter(name => name !== 'Acoustic Guitar');
  if (named.length) resolved.instruments = [...new Set([...named, ...resolved.instruments.filter(i => ['Bass', 'Drums'].includes(i))])].slice(0, 5);
  if (/\b(no drums|without drums|drumless)\b/i.test(text)) resolved.instruments = resolved.instruments.filter(i => i !== 'Drums' && i !== 'Tabla');
  if (/\b(solo|only)\b/i.test(text) && named.length) resolved.instruments = named.slice(0, 1);
  if (/\b(sad|heartbreak|melanchol)/i.test(text)) { resolved.mood = 'Sad'; resolved.emotion = 'Melancholic'; }
  else if (/\b(happy|joyful|cheerful)\b/i.test(text)) { resolved.mood = 'Happy'; resolved.emotion = 'Euphoric'; }
  else if (/\b(romantic|love song)\b/i.test(text)) { resolved.mood = 'Romantic'; resolved.emotion = 'Tender'; }
  else if (/\b(party|celebration|dance floor)\b/i.test(text)) { resolved.mood = 'Party'; resolved.emotion = 'Euphoric'; }
  else if (/\b(relax(?:ed|ing)?|calm|peaceful|meditative)\b/i.test(text)) { resolved.mood = 'Relax'; resolved.emotion = 'Dreamy'; }
  else if (/\b(vibing|good vibes?|chill groove|laid[ -]?back groove|chill electronic|deep house)\b/i.test(text)) { resolved.mood = 'Vibing'; resolved.emotion = 'Dreamy'; }
  else if (/\b(motivational|inspiring|triumphant)\b/i.test(text)) { resolved.mood = 'Motivational'; resolved.emotion = 'Fierce'; }
  else if (/\b(emotional|heartfelt|moving)\b/i.test(text)) { resolved.mood = 'Emotional'; resolved.emotion = 'Tender'; }
  if (/\b(soft|gentle|whispery)\b/i.test(text)) resolved.singerStyle = 'Soft';
  if (/\b(energetic|powerful)\b/i.test(text)) resolved.singerStyle = 'Energetic';
  const language = ['English', 'Hindi', 'Spanish', 'French', 'Punjabi', 'Arabic', 'Korean', 'Japanese'].find(l => new RegExp(`\\b${l}\\b`, 'i').test(text));
  if (language) resolved.language = language;
  const explicitBpm = text.match(/\b(\d{2,3})\s*bpm\b/i);
  const speedCue = /\b(slow|gentle|sleepy|fast|energetic|upbeat)\b/i.test(text);
  if (rule && !explicitBpm && !speedCue) resolved.bpm = Math.max(40, Math.min(240, rule.bpm + (promptMoodBpmOffsets[resolved.mood] || 0)));
  if (/\b(slow|gentle|sleepy)\b/i.test(text)) { resolved.bpm = 72; resolved.tempo = 'Slow'; }
  else if (/\b(fast|energetic|upbeat)\b/i.test(text)) { resolved.bpm = 140; resolved.tempo = 'Fast'; }
  if (explicitBpm) resolved.bpm = Math.max(40, Math.min(240, Number(explicitBpm[1])));
  if (resolved.bpm) resolved.tempo = resolved.bpm < 90 ? 'Slow' : resolved.bpm < 120 ? 'Medium' : resolved.bpm < 140 ? 'Upbeat' : 'Fast';
  return resolved;
}

export function hashText(text: string): number {
  let hash = 2166136261;
  for (const ch of text) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return hash >>> 0;
}

type Pattern = { kick: number[]; snare: number[]; hat: number[]; bass: number[]; chords: number[]; melody: number[]; swing: number };
const patterns: Record<Groove, Pattern> = {
  Pop: { kick: [0, 6, 8], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], bass: [0, 6, 8, 14], chords: [0, 8], melody: [0, 3, 6, 8, 10, 14], swing: 0 },
  Rock: { kick: [0, 2, 8, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], bass: [0, 2, 4, 6, 8, 10, 12, 14], chords: [0, 4, 8, 12], melody: [0, 4, 6, 8, 11, 12, 14], swing: 0 },
  'Hip Hop': { kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 3, 6, 8, 10, 11, 14, 15], bass: [0, 7, 10], chords: [0], melody: [0, 6, 10, 14], swing: 0.08 },
  Electronic: { kick: [0, 4, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14], bass: [2, 6, 10, 14], chords: [0, 6, 10], melody: [0, 2, 4, 6, 8, 10, 12, 14], swing: 0 },
  'Electronic Vibe': { kick: [0, 4, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14], bass: [0, 3, 6, 8, 11, 14], chords: [0, 8], melody: [2, 5, 7, 10, 13, 15], swing: 0.035 },
  Jazz: { kick: [0, 10], snare: [4, 14], hat: [0, 2, 4, 6, 8, 10, 12, 14], bass: [0, 4, 8, 12], chords: [0, 6, 12], melody: [0, 2, 6, 8, 10, 14], swing: 0.16 },
  LoFi: { kick: [0, 9], snare: [4, 12], hat: [2, 6, 10, 14], bass: [0, 9], chords: [0, 10], melody: [0, 6, 10, 14], swing: 0.12 },
  Acoustic: { kick: [0], snare: [8], hat: [4, 12], bass: [0, 8], chords: [0], melody: [0, 2, 4, 6, 8, 10, 12, 14], swing: 0 },
  Ambient: { kick: [], snare: [], hat: [], bass: [0], chords: [0], melody: [0, 6, 12], swing: 0 },
};

type MoodProfile = {
  energy: number;
  density: number;
  brightness: number;
  swing: number;
  sustain: number;
  bassMotion: number;
};

const moodProfiles: Record<string, MoodProfile> = {
  Romantic: { energy: .72, density: .7, brightness: .58, swing: .018, sustain: 1.08, bassMotion: .55 },
  Happy: { energy: .9, density: .86, brightness: .84, swing: 0, sustain: .92, bassMotion: .72 },
  Sad: { energy: .5, density: .48, brightness: .3, swing: .035, sustain: 1.18, bassMotion: .35 },
  Motivational: { energy: .96, density: .92, brightness: .72, swing: 0, sustain: .88, bassMotion: .86 },
  Emotional: { energy: .62, density: .58, brightness: .42, swing: .025, sustain: 1.2, bassMotion: .46 },
  Party: { energy: 1, density: 1, brightness: .94, swing: 0, sustain: .82, bassMotion: 1 },
  Relax: { energy: .44, density: .4, brightness: .4, swing: .07, sustain: 1.28, bassMotion: .3 },
  Vibing: { energy: .74, density: .72, brightness: .7, swing: .04, sustain: 1.02, bassMotion: .76 },
};

const neutralMood: MoodProfile = { energy: .74, density: .7, brightness: .58, swing: .02, sustain: 1, bassMotion: .58 };
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

function moodProfile(mood = '', emotion = ''): MoodProfile {
  if (moodProfiles[mood]) return moodProfiles[mood];
  const text = `${mood} ${emotion}`;
  if (/party|euphori|energetic|fierce/i.test(text)) return moodProfiles.Party;
  if (/happy|joy|bright|hope/i.test(text)) return moodProfiles.Happy;
  if (/sad|melanchol|heartbreak/i.test(text)) return moodProfiles.Sad;
  if (/relax|calm|dream|soft|gentle/i.test(text)) return moodProfiles.Relax;
  if (/vib|groove|chill/i.test(text)) return moodProfiles.Vibing;
  return neutralMood;
}

export function createArrangement(song: Pick<SongMetadata, 'genre' | 'description' | 'melodySeed'> & Partial<Pick<SongMetadata, 'mood' | 'emotion' | 'creativity'>>) {
  const groove: Groove = song.genre in patterns ? song.genre as Groove : song.genre === 'Classical' ? 'Acoustic' : 'Pop';
  const profile = moodProfile(song.mood, song.emotion);
  const seed = hashText(`${song.description}|${song.melodySeed}|${groove}|${song.mood || ''}|${song.emotion || ''}|${song.creativity ?? 75}`);
  const randomAt = (index: number) => hashText(`${seed}:${index}`) / 4294967296;
  const pattern = patterns[groove];
  // A saved song repeats its own motif; different prompts/takes change it.
  const motif = Array.from({ length: 8 }, (_, i) => Math.floor(randomAt(i) * 6));
  const pickup = [3, 7, 11, 15][seed % 4];
  return { groove, ...pattern, motif, pickup, profile, randomAt };
}

/** A bar of events, shared by playback and behavior tests. One step is a sixteenth note. */
export function arrangementStep(arrangement: ReturnType<typeof createArrangement>, step: number, section: string) {
  const position = step % 16;
  const bar = Math.floor(step / 16);
  const intro = /intro|outro/i.test(section);
  const chorus = /chorus/i.test(section);
  const fill = !intro && bar % 4 === 3;
  const { profile } = arrangement;
  const sectionLevel = intro ? .58 : chorus ? 1 : .8;
  const probability = (floor: number, weight: number, salt: number) =>
    arrangement.randomAt(step * 17 + salt) < clamp(floor + profile.density * weight + (chorus ? .08 : 0), 0, 1);
  const kickCandidate = arrangement.kick.includes(position) || (!intro && profile.density > .88 && [2, 10, 14].includes(position));
  const hatCandidate = arrangement.hat.includes(position) || (chorus && position % 2 === 0);
  const bassCandidate = arrangement.bass.includes(position) || (!intro && profile.bassMotion > .82 && [4, 12].includes(position));
  return {
    kick: kickCandidate && (!intro || position === 0) && (position === 0 || probability(.48, .58, 1)),
    snare: !intro && (arrangement.snare.includes(position) || (fill && position === 15)) && probability(.56, .5, 2),
    hat: !intro && hatCandidate && probability(.14, .88, 3),
    bass: bassCandidate && (position === 0 || probability(.28, .78, 4)),
    chord: arrangement.chords.includes(position) && (position === 0 || probability(.62, .42, 5)),
    lead: (arrangement.melody.includes(position) || (!intro && position === arrangement.pickup)) && probability(.1, .9, 6),
    degree: arrangement.motif[(Math.floor(step / 2) + (chorus ? 2 : 0)) % arrangement.motif.length],
    bassOffset: arrangement.groove === 'Jazz' ? [0, 4, 7, 12][Math.floor(position / 4)] : (profile.bassMotion > .7 && bar % 2 && position > 8 ? 7 : 0),
    velocity: clamp(profile.energy * sectionLevel, .28, 1),
    brightness: profile.brightness,
    sustain: profile.sustain,
    delayBeats: position % 4 === 2 ? clamp(arrangement.swing + profile.swing, 0, .18) : 0,
  };
}
