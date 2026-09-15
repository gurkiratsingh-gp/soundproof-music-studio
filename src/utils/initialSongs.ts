import { SongMetadata } from "../types";

export const initialSongs: SongMetadata[] = [
  {
    id: "neon-reverie",
    title: "Neon Reverie",
    description: "A late-night drive under city lights, remembering someone I lost.",
    mood: "Romantic",
    genre: "Pop",
    language: "English",
    tempo: "Medium",
    bpm: 115,
    key: "A Minor",
    emotion: "Melancholic",
    singerStyle: "Modern Pop",
    theme: "Chasing dreams",
    instruments: ["Piano", "Drums", "Bass", "Synth", "Strings"],
    creativity: 80,
    createdAt: new Date().toISOString(),
    coverArtSeed: "neon_sunset",
    visualizerTheme: {
      primary: "#ff007f", // Neon Magenta
      secondary: "#00f0ff", // Cyan
      glow: "#a855f7", // Violet
      background: "#080315" // Midnight space
    },
    chordProgression: {
      verse: ["Am", "F", "C", "G"],
      chorus: ["F", "G", "Am", "Em"]
    },
    melodySeed: 42,
    lyrics: [
      {
        section: "Intro",
        lines: [
          "[Soft piano chords playing...]",
          "[Synth pads fading in...]",
          "Drive into the purple haze...",
          "Watching the tail lights drift away."
        ]
      },
      {
        section: "Verse 1",
        lines: [
          "Beneath the neon towers, high above the ground",
          "I cruise the empty streets, trying not to make a sound",
          "Your portrait is reflected in the raindrops on the glass",
          "Another quiet midnight, wishing this would pass."
        ]
      },
      {
        section: "Chorus",
        lines: [
          "Oh, we were running on the skyline, chasing down the sun",
          "A beautiful collision, before the night was done",
          "Now you are just an echo in a synthesizer song",
          "A neon reverie, where we used to belong."
        ]
      },
      {
        section: "Verse 2",
        lines: [
          "The radio is playing our favorite melody",
          "But every drum machine just sounds like agony",
          "I grip the steering wheel and let the engine roar",
          "Searching for a silhouette that is not there anymore."
        ]
      },
      {
        section: "Chorus",
        lines: [
          "Oh, we were running on the skyline, chasing down the sun",
          "A beautiful collision, before the night was done",
          "Now you are just an echo in a synthesizer song",
          "A neon reverie, where we used to belong."
        ]
      },
      {
        section: "Outro",
        lines: [
          "Neon reverie...",
          "Fading in the morning light...",
          "Drive safe...",
          "[Chords slowly decay into silence...]"
        ]
      }
    ]
  },
  {
    id: "sitar-aurora",
    title: "Sitar Aurora",
    description: "A peaceful spiritual journey across the Himalayas under a starry night.",
    mood: "Relax",
    genre: "Classical",
    language: "Hindi",
    tempo: "Slow",
    bpm: 85,
    key: "E Minor",
    emotion: "Dreamy",
    singerStyle: "Acoustic",
    theme: "Spiritual awakening",
    instruments: ["Sitar", "Piano", "Flute", "Strings", "Bass"],
    creativity: 95,
    createdAt: new Date().toISOString(),
    coverArtSeed: "himalayan_sky",
    visualizerTheme: {
      primary: "#10b981", // Emerald green
      secondary: "#34d399", // Mint green
      glow: "#059669", // Darker emerald glow
      background: "#040e0b" // Forest dark
    },
    chordProgression: {
      verse: ["Em", "D", "C", "D"],
      chorus: ["G", "D", "Am", "Em"]
    },
    melodySeed: 108,
    lyrics: [
      {
        section: "Intro",
        lines: [
          "[Sitar resonance humming...]",
          "[Gentle Himalayan flute echoes...]",
          "Shanti, shanti, shanti...",
          "Peace of the mountains."
        ]
      },
      {
        section: "Verse 1",
        lines: [
          "Taaron se bhari is rath mein hum chale hain",
          "Himalay ke shikhar par, naye khwaab bune hain",
          "Thandi hawayein chooti hain is badan ko",
          "Ek alag hi shanti milti hai is mann ko."
        ]
      },
      {
        section: "Chorus",
        lines: [
          "He Ganga ki dhara, beh rhi hai jo door",
          "Sitar ki yeh jhankaron mein ghula hai suroor",
          "Aurora chamak rhi hai, rath ki god mein",
          "Hum kho gye hain ek gehre prem ki hod mein."
        ]
      },
      {
        section: "Verse 2",
        lines: [
          "Mandir ki ghanti door kahin baji hai",
          "Srishti ki sundarta har disha mein saji hai",
          "Kohre ke peeche chupa hai suraj ka rath",
          "Dhoond rhi hai aatma ab moksha ka path."
        ]
      },
      {
        section: "Chorus",
        lines: [
          "He Ganga ki dhara, beh rhi hai jo door",
          "Sitar ki yeh jhankaron mein ghula hai suroor",
          "Aurora chamak rhi hai, rath ki god mein",
          "Hum kho gye hain ek gehre prem ki hod mein."
        ]
      },
      {
        section: "Outro",
        lines: [
          "Spiritual hum...",
          "Sitar echoing...",
          "Pranayam...",
          "[Fading into deep meditation...]"
        ]
      }
    ]
  },
  {
    id: "gotham-groove",
    title: "Gotham Groove",
    description: "An energetic dark cyberbeat for fighting crime or driving fast.",
    mood: "Motivational",
    genre: "Electronic",
    language: "English",
    tempo: "Fast",
    bpm: 140,
    key: "D Minor",
    emotion: "Fierce",
    singerStyle: "Energetic",
    theme: "Chasing dreams",
    instruments: ["Synth", "Drums", "Bass", "Saxophone", "Trumpet"],
    creativity: 70,
    createdAt: new Date().toISOString(),
    coverArtSeed: "cyber_city",
    visualizerTheme: {
      primary: "#e11d48", // Crimson red
      secondary: "#f43f5e", // Light red
      glow: "#be123c", // Dark red glow
      background: "#0d0208" // Pitch black synthwave
    },
    chordProgression: {
      verse: ["Dm", "Bb", "C", "Am"],
      chorus: ["Dm", "Gm", "F", "C"]
    },
    melodySeed: 777,
    lyrics: [
      {
        section: "Intro",
        lines: [
          "[Aggressive drum machines hitting...]",
          "[Screaming synth wave...]",
          "Wake up, Gotham...",
          "The shadow rises."
        ]
      },
      {
        section: "Verse 1",
        lines: [
          "Shadows stretching in the narrow brick alleyway",
          "Gears are spinning, we are fighting till the light of day",
          "Heavy boots are stepping on the concrete floors",
          "Break the barricades and shatter down the iron doors."
        ]
      },
      {
        section: "Chorus",
        lines: [
          "This is our city, this is our throne!",
          "No more running, we are fully in the zone",
          "Feel the bass hitting, cyber drums collide",
          "With the power of the neon on our side!"
        ]
      },
      {
        section: "Verse 2",
        lines: [
          "Electric pulses racing down through my veins",
          "No more shackles, we are cutting all the rusty chains",
          "With a brass section blazing, saxophone in flight",
          "We are the knights that own the dark Gotham night."
        ]
      },
      {
        section: "Chorus",
        lines: [
          "This is our city, this is our throne!",
          "No more running, we are fully in the zone",
          "Feel the bass hitting, cyber drums collide",
          "With the power of the neon on our side!"
        ]
      },
      {
        section: "Outro",
        lines: [
          "Rise up...",
          "The cyber city lives...",
          "Gotham groove...",
          "[Drums cut, synth trails off...]"
        ]
      }
    ]
  }
];
