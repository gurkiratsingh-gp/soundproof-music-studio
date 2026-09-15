import { SongMetadata } from "../types";
import { hashText } from './songArrangement';

const MOOD_LYRICS_VOCAB: { [key: string]: { lines: string[], titles: string[] } } = {
  Romantic: {
    titles: ["Crimson Glow", "Satin Whispers", "Eternal Orbit", "Love in Neon", "Heartbeat Echo"],
    lines: [
      "I see your face in every passing stranger",
      "We were flying too close to the edge of time",
      "Every heartbeat feels like a gentle sweet reminder",
      "Holding hands under the shimmering starlight",
      "You are the rhythm that keeps my heart aligned",
      "Let's write our name on the wet city windows",
      "Your touch is a melody I can never forget",
      "Walking together down this avenue of hope"
    ]
  },
  Happy: {
    titles: ["Sunshine Pulse", "Golden Horizon", "Dance with Me", "Skyline Spark", "Euphoria Rise"],
    lines: [
      "Waking up to a brand new glowing morning",
      "We are dancing on top of the world today",
      "Feel the sunshine washing all our worries away",
      "Laughter echoing down through the crowded streets",
      "Every single moment is a celebration",
      "Throw your hands up and reach for the blue sky",
      "We are running free with no looking back",
      "Nothing can stop this wonderful groove inside"
    ]
  },
  Sad: {
    titles: ["Raindrops on Concrete", "Hollow Echoes", "Shadow of You", "Fading Sparks", "Silent Drift"],
    lines: [
      "Staring at the ceiling in this empty cold room",
      "The silence is louder than the pouring rain outside",
      "Looking at old polaroids of when we used to smile",
      "You left a shadow where your heart used to reside",
      "Another lonely evening drifting in the dark",
      "Every tick of the clock is a heavy sigh",
      "I am searching for pieces of what we left behind",
      "Trying to find a reason to say goodbye"
    ]
  },
  Motivational: {
    titles: ["Iron Will", "Phoenix Flight", "Break the Cage", "Summit Calling", "Apex Bound"],
    lines: [
      "Rise up from the ashes and seize the day",
      "They said we'd fail, but we will prove them wrong",
      "With every single drop of sweat, we grow stronger",
      "This is our time, this is where we belong",
      "Step after step, climbing up the mountain steep",
      "No more excuses, we are breaking all the chains",
      "Feel the burning passion deep inside your core",
      "Victory is waiting just beyond the pain"
    ]
  },
  Emotional: {
    titles: ["Open Letters", "Falling Slowly", "After the Echo", "Unsaid Things", "Between the Lines"],
    lines: [
      "I kept the words I could not say beside me",
      "Every quiet memory pulls me back again",
      "There is a light still moving through the distance",
      "I hear our story breathing underneath the rain",
      "Some feelings stay when every sound has faded",
      "I am learning how to carry what remains",
      "The truth arrives in waves across the silence",
      "I will meet the morning softer than before"
    ]
  },
  Party: {
    titles: ["Midnight Motion", "Neon Weekend", "All Night Signal", "Electric Crowd", "Lights Up"],
    lines: [
      "City lights are flashing to the rhythm",
      "Everybody moves when the low end drops",
      "We are writing memories across the dance floor",
      "Turn the night up loud and let the whole room glow",
      "Hands in the air while the colors keep spinning",
      "Every beat is pulling us into the sound",
      "Leave the clock behind until the morning",
      "We came alive when the music found us"
    ]
  },
  Vibing: {
    titles: ["Easy Current", "Green Light Groove", "Late Day Loop", "Floating Downtown", "Soft Neon"],
    lines: [
      "Let the easy rhythm carry us forward",
      "Windows down and nowhere we need to be",
      "A little bass is rolling through the evening",
      "We move together naturally with the beat",
      "Soft neon colors drift across the dashboard",
      "Every small moment settles into time",
      "No need to hurry while the groove keeps turning",
      "This simple feeling fits the night just right"
    ]
  },
  Relax: {
    titles: ["Quiet Tides", "Drifting Clouds", "Zenith Breeze", "Mist in the Pines", "Velvet Pillow"],
    lines: [
      "Breathing in the calm cool mountain air",
      "Let your shoulders drop and let the thoughts float by",
      "The river flows so gently down to the blue ocean",
      "Staring at the birds drifting in the soft sky",
      "A peaceful quiet settles on the sleepy forest",
      "Unwind your mind and listen to the cricket's song",
      "The world can wait, just rest your weary head",
      "In this quiet pocket of peace is where we belong"
    ]
  }
};

const GENRE_CHORDS: { [key: string]: { verse: string[], chorus: string[] } } = {
  Pop: { verse: ["C", "G", "Am", "F"], chorus: ["F", "G", "Am", "C"] },
  Rock: { verse: ["Am", "G", "D", "Am"], chorus: ["C", "G", "D", "Am"] },
  "Hip Hop": { verse: ["Am", "Dm", "F", "E"], chorus: ["Am", "F", "Dm", "E"] },
  Jazz: { verse: ["C", "Am", "Dm", "G"], chorus: ["Dm", "G", "C", "Am"] },
  Classical: { verse: ["Em", "C", "G", "D"], chorus: ["G", "D", "Em", "C"] },
  LoFi: { verse: ["Am", "F", "C", "G"], chorus: ["Am", "F", "C", "G"] },
  Electronic: { verse: ["Dm", "Bb", "F", "C"], chorus: ["Bb", "C", "Dm", "Am"] },
  "Electronic Vibe": { verse: ["F#m", "D", "A", "E"], chorus: ["D", "E", "F#m", "A"] },
  Acoustic: { verse: ['C', 'Em', 'F', 'G'], chorus: ['Am', 'F', 'C', 'G'] },
  Ambient: { verse: ['Dm', 'Am', 'C', 'G'], chorus: ['F', 'C', 'G', 'Dm'] }
};

export function generateProceduralSong(formData: {
  description: string;
  mood: string;
  genre: string;
  language: string;
  tempo: string;
  emotion: string;
  singerStyle: string;
  enhancedVoice?: boolean;
  theme?: string;
  instruments: string[];
  creativity: number;
  bpm?: number;
  key?: string;
}): SongMetadata {
  const { description, mood, genre, language, tempo, emotion, singerStyle, theme, instruments, creativity } = formData;

  // 1. Select Title based on description keywords or mood templates
  const vocab = MOOD_LYRICS_VOCAB[mood] || MOOD_LYRICS_VOCAB["Romantic"];
  let title = vocab.titles[Math.floor(Math.random() * vocab.titles.length)];
  
  // Try to grab a word from description
  const words = description.split(/\s+/).filter(w => w.length > 4);
  if (words.length > 1) {
    const cleanWord1 = words[Math.floor(Math.random() * words.length)].replace(/[^a-zA-Z]/g, "");
    const cleanWord2 = words[Math.floor(Math.random() * words.length)].replace(/[^a-zA-Z]/g, "");
    if (cleanWord1 && cleanWord2 && cleanWord1 !== cleanWord2) {
      title = `${cleanWord1.charAt(0).toUpperCase() + cleanWord1.slice(1)} ${cleanWord2.charAt(0).toUpperCase() + cleanWord2.slice(1)}`;
    }
  }

  // 2. Map BPM
  const bpmMap: { [key: string]: number } = {
    Slow: 80,
    Medium: 110,
    Upbeat: 130,
    Fast: 150
  };
  const genreCenters: Record<string, number> = { Pop: 112, Rock: 138, 'Hip Hop': 90, Jazz: 104, Classical: 78, LoFi: 78, Electronic: 128, 'Electronic Vibe': 116, Acoustic: 82, Ambient: 68 };
  const moodOffsets: Record<string, number> = { Romantic: -4, Happy: 6, Sad: -10, Motivational: 8, Emotional: -6, Party: 12, Relax: -12, Vibing: 0 };
  // Stable musical choices make the same saved idea repeat reliably. Prompt,
  // mood, instruments and creative freedom still lead to a different result.
  const seed = hashText([description, genre, mood, tempo, emotion, singerStyle, instruments.join(','), creativity, formData.key || ''].join('|'));
  const tempoCenter = bpmMap[tempo] || genreCenters[genre] || 110;
  const genrePull = Math.round(((genreCenters[genre] || tempoCenter) - tempoCenter) * .35);
  const automaticBpm = tempoCenter + genrePull + (moodOffsets[mood] || 0) + (seed % 9) - 4;
  const bpm = formData.bpm === undefined ? Math.max(52, Math.min(180, automaticBpm)) : Math.max(40, Math.min(240, formData.bpm));

  // 3. Map Key
  const baseKeys: Record<string, string> = { Pop: 'C major', Rock: 'A minor', 'Hip Hop': 'A minor', Jazz: 'C major', Classical: 'E minor', LoFi: 'A minor', Electronic: 'D minor', 'Electronic Vibe': 'F# minor', Acoustic: 'C major', Ambient: 'D minor' };
  const baseKey = baseKeys[genre] || 'A minor';
  const pitches = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const shift = [0, 2, 5, 7][seed % 4];
  const transpose = (name: string) => name.replace(/^[A-G](?:#|b)?/, root => pitches[(pitches.indexOf(root) + shift) % 12]);
  const requestedKey = typeof formData.key === 'string' && /^[A-G](?:#|b)? (?:major|minor)$/i.test(formData.key) ? formData.key : '';
  const key = requestedKey || transpose(baseKey);

  // 4. Map Chords
  const baseChords = GENRE_CHORDS[genre] || { verse: ["Am", "F", "C", "G"], chorus: ["C", "G", "Am", "F"] };
  const rotation = (seed >>> 4) % 4;
  let chords = { verse: [...baseChords.verse.slice(rotation), ...baseChords.verse.slice(0, rotation)].map(transpose), chorus: baseChords.chorus.map(transpose) };
  if (requestedKey) {
    const root = requestedKey.match(/^[A-G](?:#|b)?/)![0];
    const enharmonic: Record<string, string> = { Db: 'C#', 'D#': 'Eb', Gb: 'F#', 'G#': 'Ab', 'A#': 'Bb', Cb: 'B', 'B#': 'C', Fb: 'E', 'E#': 'F' };
    const rootIndex = pitches.indexOf(enharmonic[root] || root);
    const note = (semitones: number) => pitches[(rootIndex + semitones + 12) % 12];
    if (/minor$/i.test(requestedKey)) chords = { verse: [`${note(0)}m`, note(8), note(3), note(10)], chorus: [note(8), note(10), `${note(0)}m`, note(7)] };
    else chords = { verse: [note(0), note(7), `${note(9)}m`, note(5)], chorus: [note(5), note(7), `${note(9)}m`, note(0)] };
  }

  // 5. Build Lyrics sections using vocab
  const availableLines = [...vocab.lines];
  // Shuffle lines helper
  const drawLine = () => {
    if (availableLines.length === 0) {
      availableLines.push(...vocab.lines);
    }
    const idx = Math.floor(Math.random() * availableLines.length);
    const line = availableLines[idx];
    availableLines.splice(idx, 1);
    return line;
  };

  const lyrics = [
    {
      section: "Intro",
      lines: [
        `[Melodic ${instruments[0] || "Piano"} intro plays...]`,
        `[Tempo locked at ${bpm} BPM]`,
        `Feeling the ${mood.toLowerCase()} vibe take over...`,
        "Let the rhythm flow."
      ]
    },
    {
      section: "Verse 1",
      lines: [
        drawLine(),
        drawLine(),
        drawLine(),
        drawLine()
      ]
    },
    {
      section: "Chorus",
      lines: [
        `This is our song of ${emotion.toLowerCase()} light`,
        `We are ${singerStyle.toLowerCase()} in the deep night`,
        drawLine(),
        "And we'll carry this tune together."
      ]
    },
    {
      section: "Verse 2",
      lines: [
        `Through the ${genre.toLowerCase()} chords we find our way`,
        "No matter what the shadows say",
        drawLine(),
        drawLine()
      ]
    },
    {
      section: "Chorus",
      lines: [
        `This is our song of ${emotion.toLowerCase()} light`,
        `We are ${singerStyle.toLowerCase()} in the deep night`,
        drawLine(),
        "And we'll carry this tune together."
      ]
    },
    {
      section: "Outro",
      lines: [
        "Fading away in the distance...",
        `[${instruments.join(", ")} fading...]`,
        "Shining forever...",
        "[Chords slowly fade to silence]"
      ]
    }
  ];

  // 6. Generate vibrant colors based on mood (focusing on warm yellow, luxury gold, and deep brown tones)
  const visualizerThemes: { [key: string]: any } = {
    Romantic: { primary: "#f59e0b", secondary: "#fbbf24", glow: "#fbbf24", background: "#0f0501" },
    Happy: { primary: "#fbbf24", secondary: "#facc15", glow: "#fde047", background: "#0e0600" },
    Sad: { primary: "#b45309", secondary: "#ca8a04", glow: "#d97706", background: "#0c0400" },
    Motivational: { primary: "#ca8a04", secondary: "#f97316", glow: "#fbbf24", background: "#140700" },
    Emotional: { primary: "#8b5cf6", secondary: "#60a5fa", glow: "#a78bfa", background: "#080b1c" },
    Party: { primary: "#ec4899", secondary: "#22d3ee", glow: "#f472b6", background: "#11051a" },
    Vibing: { primary: "#2dd4bf", secondary: "#84cc16", glow: "#5eead4", background: "#041714" },
    Relax: { primary: "#d97706", secondary: "#fbbf24", glow: "#fef08a", background: "#0a0300" }
  };
  const visualizerTheme = visualizerThemes[mood] || visualizerThemes["Romantic"];

  return {
    id: `procedural-${Date.now()}`,
    title,
    description,
    mood,
    genre,
    language,
    tempo,
    bpm,
    key,
    emotion,
    singerStyle,
    enhancedVoice: formData.enhancedVoice !== false,
    theme,
    instruments,
    creativity,
    createdAt: new Date().toISOString(),
    coverArtSeed: `proc_${mood.toLowerCase()}`,
    visualizerTheme,
    chordProgression: chords,
    melodySeed: seed,
    lyrics
  };
}
