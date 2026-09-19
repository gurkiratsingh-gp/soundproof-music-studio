# SoundProof

SoundProof is a mobile-friendly songwriting and vocal practice studio. It creates varied procedural instrumentals, keeps lyrics in time with the beat, records and mixes the singer’s own voice, turns a permitted stereo recording into a pitch-shifted karaoke backing, and lets a phone or tablet act as a wireless microphone and recording remote.

The current interface deliberately does **not** offer paid AI vocal generation. Instrumentals, lyric timing, recording, mixing, karaoke processing, and WAV downloads work without a music-provider account. Gemini is used only for optional songwriting and Kavi chat replies.

## Main features

- **Kavi songwriting assistant:** native-script, transliterated, and mixed-language input; song ideas, complete lyrics, revisions, production prompts, singing tips, and audio-matched instrumental drafts.
- **31 languages:** English; all 22 scheduled Indian languages (Assamese, Bengali, Bodo, Dogri, Gujarati, Hindi, Kannada, Kashmiri, Konkani, Maithili, Malayalam, Manipuri, Marathi, Nepali, Odia, Punjabi, Sanskrit, Santali, Sindhi, Tamil, Telugu, Urdu); Bhojpuri, Tulu, and Pahadi; plus Spanish, French, Arabic, Korean, and Japanese.
- **Phone microphone companion:** pair an iPhone, iPad, Android phone, or tablet with a one-time QR link or six-digit code; stream its microphone over encrypted WebRTC; arm start/stop controls from the computer.
- **Instrumental studio:** distinct genre and mood arrangements, Electronic Vibe, tempo control, synchronized lyric highlighting, manual lyric timing, and 60-second WAV export.
- **Your own vocals:** computer or paired-phone microphone, countdown, level meter, voice-only or voice-plus-backing takes, saved takes, mixer effects, and final WAV export.
- **Karaoke Track Lab:** browser-only center-vocal reduction and ±12-semitone pitch shifting for audio the user owns or has permission to use.
- **Responsive UI:** light, dark, and System appearance choices in Settings; phone, tablet, and desktop layouts; touch-size controls and accessible status messages.

Kavi is prompt-engineered with validated structured output. This project does not fine-tune or train Gemini model weights. Review generated lyrics before publishing them.

## Local setup

Requirements: Node.js 22 or newer and a current Chrome, Edge, Firefox, or Safari browser.

~~~powershell
npm install
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm run dev
~~~

Open [http://localhost:3000](http://localhost:3000), choose **Continue with email**, and create an account with a valid email or a 2–32 character studio name plus a password of at least eight characters. Existing studio-name accounts keep working.

The app is fully usable with this free configuration:

~~~dotenv
GEMINI_API_KEY=""
GEMINI_TEXT_MODEL="gemini-3.5-flash"
GEMINI_GLOBAL_REQUESTS_PER_HOUR="240"
PORT="3000"
COOKIE_SECURE="false"
PUBLIC_SITE_URL=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
APPLE_CLIENT_ID=""
APPLE_TEAM_ID=""
APPLE_KEY_ID=""
APPLE_PRIVATE_KEY=""
PHONE_MIC_ICE_SERVERS=""
~~~

To enable live Kavi replies and AI-written lyrics, create a key in [Google AI Studio](https://aistudio.google.com/apikey), put it in `GEMINI_API_KEY`, and restart the server. The key stays on the Express server and must never use a `VITE_` prefix. `GEMINI_GLOBAL_REQUESTS_PER_HOUR` sets one shared hourly ceiling across Kavi and composition requests; each route also enforces separate account and IP limits.

SoundProof does not mount `/api/music` in the running server, so environment variables cannot re-enable AI singing. The legacy provider adapters remain isolated under `server/music` for fixtures, tests, and possible future evaluation.

When Gemini is unavailable or out of quota, SoundProof reports the failure and keeps the message available as a composer prompt. All recording and instrumental features still work.

## Optional Google and Apple sign-in

The startup page always offers **Continue with email**. It uses SoundProof’s existing local password account and accepts either a valid email address or the older studio-name format. Social buttons only become active when the matching server credentials and callback origin are valid; an inactive button explains exactly what is missing.

### Google

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), configure the OAuth consent screen and create an **OAuth client ID > Web application**.
2. Configure this deployment's Web application client with **Authorized JavaScript origin** `https://soundproof-music-studio.onrender.com` and **Authorized redirect URI** `https://soundproof-music-studio.onrender.com/api/auth/google/callback`. Enter both exactly, with no trailing slash. For local testing, add `http://localhost:3000/api/auth/google/callback` as another authorized redirect URI.
3. In **Branding**, set the application home page to `https://soundproof-music-studio.onrender.com/`, the privacy policy to `https://soundproof-music-studio.onrender.com/privacy.html`, and the terms of service to `https://soundproof-music-studio.onrender.com/terms.html`. These pages must be live before you submit them. Google may require domain ownership and brand verification; a custom domain you control can be needed for that review.
4. If the consent screen uses the **External** audience and its publishing status is **Testing**, only listed **Test users** can sign in. For broader access, complete Google's branding or verification requirements and use **Publish app** to move to **In production**. A working button for the project owner does not establish public Google access.
5. Set these server-only Render variables and restart SoundProof:

   ~~~dotenv
   PUBLIC_SITE_URL="https://soundproof-music-studio.onrender.com"
   COOKIE_SECURE="true"
   GOOGLE_CLIENT_ID="YOUR_WEB_CLIENT_ID.apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="YOUR_GOOGLE_CLIENT_SECRET"
   ~~~

Google uses the server Authorization Code flow with a one-use state cookie, nonce, and PKCE. SoundProof verifies the signed Google ID token against Google’s published keys and does not save provider access or refresh tokens.

### Apple

Apple web sign-in cannot use `localhost` or an IP-address return URL. It requires a deployed HTTPS domain and an [Apple Developer Program](https://developer.apple.com/programs/) account. The Apple button therefore stays unavailable during ordinary localhost development.

1. In Apple Certificates, Identifiers & Profiles, enable **Sign in with Apple** for a primary App ID.
2. Create a **Services ID**, associate it with that App ID, and configure the deployed domain `soundproof-music-studio.onrender.com` and exact return URL `https://soundproof-music-studio.onrender.com/api/auth/apple/callback`.
3. Create a Sign in with Apple private key and download the `.p8` file. Record its Key ID and your ten-character Team ID.
4. Set the Services ID as `APPLE_CLIENT_ID`. Put the private key in the environment as one line with literal `\n` separators, then restart:

   ~~~dotenv
   PUBLIC_SITE_URL="https://soundproof-music-studio.onrender.com"
   APPLE_CLIENT_ID="com.example.soundproof.web"
   APPLE_TEAM_ID="YOURTEAMID"
   APPLE_KEY_ID="YOURKEYID1"
   APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_DATA\n-----END PRIVATE KEY-----"
   ~~~

SoundProof creates Apple’s short-lived ES256 client-secret JWT on the server, accepts Apple’s state-bound `form_post`, and verifies the returned RS256 ID token against Apple’s published keys. The private key and returned provider tokens are never sent to the browser or written to the account file.

Google and Apple identities use the provider’s stable `sub` claim together with the provider name. A returning identity reopens the same SoundProof library; identities from different providers remain isolated even if they report the same email. SoundProof does not silently merge a social identity into a password account. Explicit account linking would require a separate authenticated confirmation flow and is outside this demo.

## Use a phone or tablet as the microphone

Phone microphone permission requires a secure browser context. `localhost` is trusted only on the same computer, so a physical phone cannot use the computer’s `http://localhost:3000` address. For a real phone test, use the deployed HTTPS site described below or a trusted HTTPS development tunnel.

1. Open the same deployed SoundProof site on the computer and sign in.
2. Open a song in **My library**, scroll to **Sing it yourself**, and choose **Create phone connection** inside the recorder. The same connection controls also remain available in Settings.
3. Scan the QR code with the phone camera. Alternatively, open `/phone` on the same SoundProof site and enter the six-digit code.
4. On the phone, choose whether to reduce room noise, then press **Allow mic & connect** and approve microphone permission.
5. Back in **Sing it yourself**, select **Phone microphone**.
6. Press **Arm start / stop on phone** on the computer. This deliberate local gesture also satisfies browser audio policies.
7. Press **Start recording** or **Stop & save** on either device. The computer plays the backing and stores the take; the phone is not used as a loudspeaker.

Wear headphones connected to the computer to prevent backing-track leakage. The phone requests a mono 48 kHz capture when supported, disables browser auto-gain and echo cancellation, and offers optional room-noise reduction.

The QR invitation uses a 256-bit one-time token stored in the URL fragment, so it is not sent in HTTP access logs or referrer headers. The manual code is single-use and rate-limited. Invitations expire after ten minutes; a successful connection lasts up to one hour. The signaling server stores only bounded offer/answer/ICE messages in memory. Audio is encrypted by WebRTC and travels directly where networking allows, or through the configured TURN relay; SoundProof never stores phone audio on the server.

### Bluetooth and USB-C

A normal web page cannot turn a phone into a raw Bluetooth or USB audio device. Bluetooth tethering, USB tethering, Wi-Fi, or a phone hotspot can provide the network path used by SoundProof’s WebRTC connection. If separate native software exposes the phone as an operating-system microphone, choose it through **This computer** in the recorder; that driver is outside SoundProof.

### STUN and TURN configuration

The demo defaults to `stun:stun.l.google.com:19302`, which works on many home, campus, and mobile networks. Some strict or symmetric NATs require TURN. Set `PHONE_MIC_ICE_SERVERS` to a JSON array supplied by your TURN service, then restart:

~~~dotenv
PHONE_MIC_ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"},{"urls":"turns:turn.example.com:5349","username":"TURN_USERNAME","credential":"TURN_CREDENTIAL"}]'
~~~

The parser accepts one to four `stun:`, `stuns:`, `turn:`, or `turns:` entries, requires credentials for TURN, rejects unexpected fields, and never sends those credentials anywhere except the paired browsers. Use short-lived TURN credentials for a public production service.

## Deploy on Render

SoundProof needs an Express web service, so the included `render.yaml` uses Render rather than static-site hosting.

1. Run all release checks:

   ~~~powershell
   npm run lint
   npm test
   npm run test:audio
   npm run test:recording
   npm run build
   ~~~

2. Create a GitHub repository. Confirm secrets and local data are ignored before the first push:

   ~~~powershell
   git init
   git check-ignore .env.local
   git add .
   git status
   git commit -m "Build SoundProof studio"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/soundproof-music-studio.git
   git push -u origin main
   ~~~

3. In the [Render Dashboard](https://dashboard.render.com/), choose **New > Blueprint**, connect that repository, and apply `render.yaml`. It builds with `npm ci && npm run build`, starts with `npm start`, binds the Express server to Render’s `PORT`, and checks `/healthz`.
4. This deployment's HTTPS origin is `https://soundproof-music-studio.onrender.com`. In the Render service’s **Environment** page, set `PUBLIC_SITE_URL` to that exact origin with no trailing slash. Redeploy so QR invitations, canonical metadata, Open Graph URLs, and the sitemap use the public address. A fork deployed at another hostname must use its own assigned origin everywhere these instructions show the SoundProof URL.
5. Add `GEMINI_API_KEY` only if Kavi should use live Gemini. Keep `COOKIE_SECURE=true`; adjust `GEMINI_GLOBAL_REQUESTS_PER_HOUR` only if the provider quota and expected demo traffic justify it.
6. To enable Google sign-in, add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then register the deployed callback shown above. To enable Apple sign-in, complete the Apple Developer setup and add all four `APPLE_*` values. Keep every secret out of `render.yaml` and source control.
7. If cross-network phone pairing fails, add the `PHONE_MIC_ICE_SERVERS` TURN JSON described above and redeploy.

Post-deploy checks:

- `/healthz` returns `ok`.
- `/robots.txt`, `/sitemap.xml`, `/site.webmanifest`, `/icon.svg`, and `/og.png` load.
- Create and sign in to a demo account.
- Create two different songs and verify the beats differ.
- Pair a phone, select it in a song recorder, arm it, and save a short take.
- Test Kavi with Hindi, Punjabi, Marathi, Telugu, Malayalam, or another native script.
- Check Home, Dashboard, Create, Karaoke Track Lab, My library, Kavi assistant, Activity, and Settings at phone, tablet, and desktop widths.

Render’s free web services are suitable for this college demonstration, but they spin down when idle and use an ephemeral filesystem. Server account hashes can disappear on a restart or redeploy; songs, backings, and recordings remain in each browser’s local storage/IndexedDB. A public multi-user product should use managed identity, a durable database/object store, shared rate limiting, spending limits, and managed TURN.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the release checklist and [PORTFOLIO.md](./PORTFOLIO.md) for an internship demo script.

## Security review

Controls implemented for this demo:

- Passwords use salted scrypt hashes. Sessions use random server-memory tokens in `HttpOnly`, `SameSite=Strict` cookies; production cookies are `Secure`.
- Google and Apple use server-side authorization-code flows with ten-minute one-use state and nonce values, fixed same-origin callbacks, signed ID-token verification, bounded responses, and rate limits. Provider access and refresh tokens are discarded after identity verification.
- State-changing APIs require JSON and a same-origin `Origin`; AI routes require an authenticated session.
- Authentication, Kavi, composition, phone pairing, and signaling have bounded in-memory rate/size limits. Kavi and composition use independent account and IP buckets plus a shared server-wide Gemini ceiling. Phone sessions also cap active sessions and retained messages.
- The live app does not mount the legacy AI-vocal provider routes, so `/api/music/*` cannot submit or retrieve provider jobs.
- Pairing secrets and phone credentials are HMAC-digested in memory, single-use where applicable, and never written to disk. Phone audio is not uploaded to the Express server.
- Production sends CSP, HSTS, MIME-sniffing protection, frame denial, same-origin resource policy, a restrictive permissions policy, and `no-referrer`. `/phone` is marked `noindex`.
- Uploaded karaoke audio and vocal takes remain local to IndexedDB and have file, duration, count, and storage limits. React renders model text without raw HTML injection.
- API keys stay in ignored server environment files. `.env.local` and `.data` are excluded by `.gitignore`.
- `npm audit` reports zero known dependency vulnerabilities after installing the locked dependency tree.

Known demo limits: sessions, OAuth attempts, and rate limits are in one server process; accounts use an ephemeral local JSON file; local email addresses are account identifiers rather than verified mailboxes, and there is no password reset, moderation service, or server-side backup. Social accounts are intentionally isolated and there is no account-linking UI. WebRTC peers and the configured STUN/TURN service can observe network addresses, and a TURN service relays encrypted audio. These are acceptable for a portfolio demo, not a claim of production readiness.

If any key was pasted into chat, a screenshot, source control, or a public page, revoke it in the provider dashboard and create a new one before deployment.

## Development commands

~~~sh
npm run dev
npm run lint
npm test
npm run test:audio
npm run test:recording
npm run build
npm start
~~~

The automated suite covers password and social authentication, OAuth state/replay/isolation, Kavi’s structured multilingual context, the 31-language validation contract, provider fixtures, varied procedural arrangements, audio click/clipping regressions, local recording/mixing, karaoke processing and quotas, synchronized lyrics, phone pairing abuse cases, credential separation, expiry, signal bounds, and ICE configuration. Browser audio tests use synthetic tones rather than real microphones, identity providers, or paid APIs.
