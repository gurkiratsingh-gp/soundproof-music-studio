# Present SoundProof as an internship project

## One-sentence description

SoundProof is a responsive 31-language songwriting studio that turns prompts or a sung reference into downloadable browser-generated instrumentals, synchronizes lyrics to the beat, pairs a phone as an encrypted WebRTC microphone and remote, records the singer locally, and exports a mixed WAV. Its light, dark, and System themes adapt the complete studio.

## 60-second recruiter demo

1. Start on Home and explain that the free workflow needs no AI billing.
2. Create a lo-fi or acoustic song from a specific prompt and show the generated arrangement.
3. Play it and point to the synchronized lyric line, progress color, and four-beat guide.
4. Open custom timing and explain that a singer can tap the real start of each line.
5. Select a saved voice-only take. Adjust voice, backing, timing, tone, room effect, and trim; preview and export the WAV.
6. In Kavi, use native-script input, attach that saved take, show the locally estimated BPM/pitch center, and generate a matching instrumental draft.
7. In a song’s **Sing it yourself** recorder, create a phone connection, scan the one-time QR link, and show the connected microphone state without leaving the recording flow.
8. Select Phone microphone in the recorder, arm it on the computer, and start/stop a short take from the phone.

Keep a prerecorded take and exported WAV ready. Do not make the interview depend on microphone permission, network speed, or paid AI quota.

## Architecture to explain

- **React 19 + TypeScript + Vite:** stateful composer, player, recorder, mixer, chatbot, dashboard, and responsive navigation.
- **Express server:** authentication, same-origin API protection, Gemini text routes, ephemeral WebRTC signaling, health/SEO routes, rate limits, and production security headers.
- **WebRTC:** one-time HMAC-digested invitations, separated studio/phone credentials, bounded signaling, encrypted audio transport, and a data channel for armed recording controls.
- **Web Audio API:** deterministic arrangements derived from the prompt, safe note envelopes, mixer gains, EQ, room delay, compression, timing offset, and recording taps.
- **MediaRecorder + IndexedDB:** microphone capture and up to ten browser-local takes per user/song; audio is not uploaded for this feature.
- **Kavi:** schema-validated Gemini responses, bounded conversation context, 31 language choices, native-script preservation, and a clear fallback when the text quota is unavailable.
- **Quality gates:** TypeScript, Node tests, dependency audit, an offline audio-render test, and a headless Chromium recording/mixer test.

## Strong interview talking points

- The first instrumental implementation sounded similar for every prompt, so the arrangement now derives rhythm, motif, instrumentation, density, and structure from validated prompt cues and the song seed.
- Short attack/release envelopes, scheduling cleanup, compressor headroom, and stale-note skipping removed clicks and bursts in the procedural audio.
- Browser recording needed microphone lifecycle handling, late permission cancellation, disconnect recovery, local Blob storage, and account/song isolation.
- Voice-only recording preserves separate control in the mixer. A recording made with the backing track is correctly described as inseparable instead of pretending source separation exists.
- Manual lyric timing stores beat positions rather than wall-clock seconds, so the guide follows the song tempo.
- Phone pairing keeps the secret in the URL fragment, consumes it once, separates phone and studio credentials, rate-limits short codes, and never stores the audio on the application server.
- Responsive design is part of the feature: large touch targets, mobile-safe inputs, stacked studio panels, readable lyrics, and safe-area padding support phones and tablets.

## Honest résumé bullets

- Built a responsive 31-language music studio with React, TypeScript, Express, Web Audio, MediaRecorder, and IndexedDB, supporting prompt-based instrumentals, synchronized lyrics, local vocal capture, mixing, and WAV export.
- Implemented secure phone-as-microphone pairing with WebRTC audio, one-time QR/code invitations, authenticated bounded signaling, microphone source switching, and armed remote recording controls.
- Improved browser audio stability with click-free envelopes, compressor headroom, deterministic scheduling, cancellation cleanup, and automated 44.1/48 kHz audio regression checks.
- Implemented secure demo authentication using salted scrypt hashes, HttpOnly SameSite cookies, rate limits, same-origin checks, HMAC-digested pairing tokens, and production response headers.

Use only bullets you can explain in your own words. Call this a portfolio or college demo, not a production music service. The assistant uses structured prompting and context; it is not a model you trained.

## GitHub project checklist

- Add the deployed HTTPS URL near the top of `README.md` after it works.
- Add three clean screenshots: mobile composer, synchronized lyrics, and Vocal Studio mixer.
- Record a 30–60 second silent-screen walkthrough or narrated demo GIF/video.
- Keep `.env.local`, `.data/`, recordings, and keys out of Git.
- Make 3–5 meaningful commits with specific messages instead of one vague upload commit when possible.
- Pin the repository on your GitHub profile and add topics such as `react`, `typescript`, `web-audio`, `mediarecorder`, `express`, and `music`.
- Put the project link on the résumé and prepare to explain one bug, one tradeoff, and one next step.

The strongest next production step is durable Postgres-backed identity and metadata plus object storage for opt-in cloud audio. That directly addresses the free-deployment persistence limitation without overstating the current demo.
