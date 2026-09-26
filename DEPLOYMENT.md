# Deploy SoundProof for a college or internship demo

This path uses Render because the project has an Express server, server-side sessions, WebRTC signaling routes, and a Vite frontend. The included `render.yaml` starts with free local instrumentals, phone/computer recording, the lyric guide, mixer, and WAV export. Gemini is optional and used only by Kavi and AI songwriting.

## Share the existing public demo

The visitor address is [https://soundproof-music-studio.onrender.com/](https://soundproof-music-studio.onrender.com/). Share this URL in a class group, project submission, or a QR code on your final slide. Your development computer does not need to remain on. Do not share the Render dashboard, your password, an API key, or a private phone-pairing QR code as the app’s public invitation.

Each visitor should create their own account with **Continue with email**, or use Google when the deployed OAuth configuration is ready for public access. Verify Google with a different account in a private browser window; Apple needs its separate configuration. No verification email is sent by SoundProof’s current password-account flow. Test with a few classmates first and ask for the device/browser, steps, and expected versus actual result when something fails.

Complete the deployed checks in section 6 before a college demonstration. [COLLEGE_DEMO.md](./COLLEGE_DEMO.md) includes the presentation sequence and a short technical explanation.

## 1. Prepare a GitHub repository

Initialize the repository, then confirm `.env.local` is ignored and never commit an API key:

~~~powershell
git init
git check-ignore .env.local
git add .
git status
git commit -m "Build SoundProof music studio demo"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/soundproof-music-studio.git
git push -u origin main
~~~

Create the empty repository on GitHub before the final two commands. Read `git status` before committing. It should not list `.env.local` or `.data/`. If a key was ever pasted into chat, a screenshot, a commit, or a public page, revoke it and create a new one before deployment.

## 2. Create the Render service

1. Sign in at [Render](https://dashboard.render.com/) and choose **New > Blueprint**.
2. Connect the GitHub repository and select the repository containing `render.yaml`.
3. Apply the Blueprint. It uses Node 22, runs `npm ci && npm run build`, starts with `npm start`, and checks `/healthz`.
4. Wait for the first deployment. This SoundProof service uses `https://soundproof-music-studio.onrender.com` as its HTTPS origin. A fork deployed at another hostname must substitute its own assigned origin throughout this guide.
5. In the service’s **Environment** page, set `PUBLIC_SITE_URL` to `https://soundproof-music-studio.onrender.com` with no trailing slash. Trigger **Manual Deploy > Deploy latest commit**. This second build creates the canonical and social-image URLs.

AI singing has been removed from the interface and the server does not mount `/api/music`, so no music-provider environment setting can enable it accidentally. The free instrumental, lyric guide, phone/computer microphone recorder, Vocal Studio mixer, and WAV export work without music-provider billing. HTTPS gives browsers the secure context required for microphone permission.

## 3. Optional Gemini text assistant

To enable live Gemini songwriting and chatbot replies, add this secret in Render’s Environment page:

~~~dotenv
GEMINI_API_KEY=your_new_server_side_key
~~~

Environment values stay on the server; never use a `VITE_` prefix for a key. `GEMINI_GLOBAL_REQUESTS_PER_HOUR` defaults to 240 and provides a shared cap across Kavi and AI composition in addition to the separate account and IP limits.

## 4. Optional Google and Apple sign-in

Password sign-in needs no external provider. The **Continue with email** path accepts an email or an existing studio name and remains available when social login is disabled.

For Google, create a **Web application** OAuth client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Configure these exact fields for this deployment:

~~~text
Authorized JavaScript origin: https://soundproof-music-studio.onrender.com
Authorized redirect URI: https://soundproof-music-studio.onrender.com/api/auth/google/callback
~~~

Enter both values exactly, with no trailing slash. For local testing, add `http://localhost:3000/api/auth/google/callback` as another authorized redirect URI.

Before publishing Google login, use these public **Branding** links: home page `https://soundproof-music-studio.onrender.com/`, privacy policy `https://soundproof-music-studio.onrender.com/privacy.html`, and terms of service `https://soundproof-music-studio.onrender.com/terms.html`. Deploy and verify those pages first. Google may require domain ownership and brand verification; a custom domain you control can be needed for review.

If the OAuth consent screen has an **External** audience and remains in **Testing**, only listed **Test users** can sign in. The owner successfully signing in does not establish that everyone can. For broader access, complete Google's branding or verification requirements and use **Publish app** to move to **In production**.

Add these values in Render’s **Environment** page, using the client ID and secret from that Web application client:

~~~dotenv
PUBLIC_SITE_URL="https://soundproof-music-studio.onrender.com"
COOKIE_SECURE="true"
GOOGLE_CLIENT_ID="YOUR_WEB_CLIENT_ID.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="YOUR_GOOGLE_CLIENT_SECRET"
~~~

Restart or redeploy, then confirm the login page reports Google as ready.

Apple requires an Apple Developer account, a Sign in with Apple-enabled primary App ID, an associated Services ID, and a Sign in with Apple private key. Configure the deployed domain `soundproof-music-studio.onrender.com` and exact return URL `https://soundproof-music-studio.onrender.com/api/auth/apple/callback` in Certificates, Identifiers & Profiles. Apple does not accept localhost or IP-address return URLs, so test this provider only on the deployed HTTPS site. Set these Render secrets:

~~~dotenv
APPLE_CLIENT_ID="YOUR_SERVICES_ID"
APPLE_TEAM_ID="YOUR_10_CHARACTER_TEAM_ID"
APPLE_KEY_ID="YOUR_10_CHARACTER_KEY_ID"
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_P8_DATA\n-----END PRIVATE KEY-----"
~~~

Keep `PUBLIC_SITE_URL` equal to the deployed origin and `COOKIE_SECURE=true`. Store the `.p8` content as a one-line secret with literal `\n` separators. Do not put any OAuth secret into `render.yaml`, a `VITE_` variable, source control, screenshots, or browser code.

The login page calls `/api/auth/providers` and disables incomplete providers with a setup message. After setup, test success, cancellation, a repeated callback, and logout. Google and Apple accounts with the same reported email remain separate by design; there is no silent account merge.

Official setup references: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Apple web environment](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple), and [Apple web configuration](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web).

## 5. Configure phone microphone pairing

`PUBLIC_SITE_URL` must match the deployed HTTPS origin so the QR code opens the reachable site instead of localhost. SoundProof uses a public STUN server by default. If a campus network, mobile carrier, or strict NAT blocks direct WebRTC, add a TURN service’s JSON as one line in Render:

~~~json
[{"urls":"stun:stun.example.com:3478"},{"urls":"turns:turn.example.com:5349","username":"TURN_USERNAME","credential":"TURN_CREDENTIAL"}]
~~~

Use `PHONE_MIC_ICE_SERVERS` as the environment variable name. Use short-lived credentials for a production TURN service.

## 6. Check the deployed demo

Open these URLs and confirm they return successfully:

- `/healthz` shows `ok`.
- `/robots.txt` includes the public sitemap URL.
- `/sitemap.xml` contains the public home-page URL.
- `/site.webmanifest`, `/icon.svg`, and `/og.png` load.

Then test this exact visitor flow in a private browser window:

1. Confirm **Continue with email** can create and sign in to an account. If configured, complete one real Google sign-in and one real Apple sign-in.
2. Create two songs from different prompts and confirm their instrumentals differ.
3. Play the instrumental and confirm the lyric line and beat indicators advance.
4. Set custom lyric timing by tapping each line.
5. Use the same deployed HTTPS origin on both devices. Open a song’s **Sing it yourself** recorder, create a phone connection there, scan it on a real iPhone/iPad/Android device, and allow the microphone. Keep the phone page visible and its screen unlocked; use headphones connected to the computer.
6. Select **Phone microphone**, press **Check phone microphone**, and speak into the phone. Confirm the input meter on the computer moves. Clear **Include the backing in my saved take**, arm remote controls on the computer, and start/stop a five-second take from the phone. Play it back and verify your voice is audible. Repeat a second take; a Connected label or working Start/Stop buttons alone is insufficient.
7. Balance voice and instrumental in Vocal Studio, preview it, and download the final WAV.
8. Attach that saved take in Kavi and generate an audio-matched instrumental.
9. If Gemini is configured, test native-script Kavi input and output, then prepare and download the new instrumental WAV. Otherwise verify the unavailable-provider message and continue with instrumental and recording features; do not present fallback text as a live AI result.
10. Check Home, Dashboard, Create, Karaoke Track Lab, My library, Kavi assistant, Activity, and Settings at phone, tablet, and laptop widths.

Free Render services sleep while idle and lose local files on spin-down, restart, or redeploy. SoundProof stores accounts in `.data/accounts.json`, so accounts can disappear. Songs and recordings remain browser-local, but a new account ID cannot automatically access the old library. Download backups and describe this as a demo limitation. Durable account storage is required before promising persistent public accounts.

Official references: [deploy an Express app](https://render.com/docs/deploy-node-express-app), [Blueprint specification](https://render.com/docs/blueprint-spec), [health checks](https://render.com/docs/health-checks), [free instance limits](https://render.com/docs/free), and [persistent disks](https://render.com/docs/disks).

## 7. Security gate

Before sharing the deployment:

~~~powershell
npm audit
npm run lint
npm test
npm run build
~~~

Confirm the audit reports zero vulnerabilities, `.env.local` is ignored, production responses include CSP/HSTS/no-referrer/frame-denial headers, `/phone` has `X-Robots-Tag: noindex`, cross-origin JSON mutations receive 403, unauthenticated studio session creation receives 401, authenticated `/api/music/*` requests receive 404, and a phone invitation cannot be joined twice. Confirm incomplete social providers are disabled, OAuth callbacks are registered to the exact `PUBLIC_SITE_URL`, replaying a callback fails, and no provider tokens, client secrets, or Apple keys appear in `.data`, browser storage, source files, or logs. Phone tokens and audio must never appear in server logs.

## 8. Submit the site for search discovery

1. Add the public HTTPS site as a property in [Google Search Console](https://search.google.com/search-console/about).
2. Submit `https://soundproof-music-studio.onrender.com/sitemap.xml` in **Sitemaps**.
3. Inspect the home URL and request indexing after the final deployment.
4. Test the page in Google’s [Rich Results Test](https://search.google.com/test/rich-results). The page includes `SoftwareApplication` structured data with a free offer.
5. Share a test link in a social-preview debugger and confirm the 1200×630 `og.png` image appears.

Google requires structured-data pages to be publicly accessible and recommends a sitemap for discovery. Metadata improves how the project can be understood and shared; it does not guarantee ranking. See Google’s [Software app structured-data guide](https://developers.google.com/search/docs/appearance/structured-data/software-app).

## 9. Update after future changes

~~~powershell
npm run lint
npm test
npm run build
git add .
git commit -m "Describe the completed change"
git push
~~~

After pushing, check the Render service’s **Deploys** page. If the new commit has not deployed automatically, choose **Manual Deploy > Deploy latest commit**. Wait for the successful deployment and verify its commit matches the fix before asking phone users to reload and pair again. Auto-deploy depends on the service’s Git connection and settings; a successful push alone does not prove the public app changed. See [Render deployment options](https://render.com/docs/deploys).

Before an interview, open the site once, create or sign in to a demo account, generate one song, and complete the microphone check and recorded-voice playback on the actual presentation network. Keep a downloaded instrumental, vocal take, and short screen recording as presentation backups.
