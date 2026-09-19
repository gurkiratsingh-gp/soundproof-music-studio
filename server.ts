import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { validateSong } from "./server/music/providers";
import { createAuth, sameOrigin } from './server/auth';
import { createChatRouter } from './server/chat';
import { createPhoneCompanionRouter, parsePhoneMicIceServers } from './server/phoneCompanion';
import { createMemoryRateLimit } from './server/rateLimit';
import { validateDraft } from './src/utils/songDraft';

// Local development secrets and deployed environment variables stay server-side.
// Existing process variables win, then .env.local, then .env.
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const app = express();
const PORT = Number(process.env.PORT) || 3000;
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  if (req.path === '/phone') res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; script-src 'self' 'sha256-b6A+obcXTQcKBpOFEcGessRFXU+pmJJGiLAQrk/swLk='; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  }
  next();
});
const requestOrigin = (req: express.Request) => {
  const configured = process.env.PUBLIC_SITE_URL?.trim();
  try { return new URL(configured || `${req.protocol}://${req.get('host')}`).origin; } catch { return ''; }
};
app.get('/healthz', (_req, res) => res.status(200).type('text/plain').send('ok'));
app.get('/robots.txt', (req, res) => {
  const origin = requestOrigin(req);
  res.type('text/plain').send(`User-agent: *\nAllow: /\n${origin ? `Sitemap: ${origin}/sitemap.xml\n` : ''}`);
});
app.get('/sitemap.xml', (req, res) => {
  const origin = requestOrigin(req);
  if (!origin) return res.sendStatus(404);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url><url><loc>${origin}/privacy.html</loc><changefreq>monthly</changefreq></url><url><loc>${origin}/terms.html</loc><changefreq>monthly</changefreq></url></urlset>`);
});
app.use(express.json({ limit: '64kb' }));
const auth = createAuth({
  secureCookies: process.env.COOKIE_SECURE === 'true',
  publicOrigin: process.env.PUBLIC_SITE_URL,
  environment: process.env,
});
// Authentication owns its callback protections because Apple returns a state-bound
// form_post. Every other state-changing API remains JSON-only and same-origin.
app.use('/api/auth', auth.router);
app.use('/api', sameOrigin);
app.use('/api/phone', createPhoneCompanionRouter({
  requireUser: auth.requireUser,
  iceServers: parsePhoneMicIceServers(process.env.PHONE_MIC_ICE_SERVERS),
  publicSiteUrl: process.env.PUBLIC_SITE_URL,
}));
app.use('/api', auth.requireUser);

// Initialize Gemini client safely
const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("WARNING: GEMINI_API_KEY environment variable is missing.");
  }
  return new GoogleGenAI({
    apiKey: apiKey || "MOCK_API_KEY",
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
};

const ai = getGeminiClient();
const configuredGeminiGlobalLimit = Number(process.env.GEMINI_GLOBAL_REQUESTS_PER_HOUR || 240);
if (!Number.isInteger(configuredGeminiGlobalLimit) || configuredGeminiGlobalLimit < 10 || configuredGeminiGlobalLimit > 10_000) {
  throw new Error('GEMINI_GLOBAL_REQUESTS_PER_HOUR must be an integer between 10 and 10000.');
}
const limitGeminiGlobally = createMemoryRateLimit({
  globalLimit: configuredGeminiGlobalLimit,
  windowMs: 60 * 60_000,
  message: 'SoundProof has reached its hourly AI demo limit. Try again later.',
});
app.use('/api/chat', createChatRouter(ai, process.env, { globalLimiter: limitGeminiGlobally }));

// Helper to perform content generation with retry and model fallback to handle 503 errors gracefully
async function generateContentWithRetryAndFallback(prompt: string, responseSchema: any, creativity?: number) {
  const modelsToTry = [process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash'];
  let lastError: any = null;

  for (const model of modelsToTry) {
    console.log(`[Gemini Engine] Attempting composition with model: ${model}`);
    
    // Retry up to 3 times for each model in case of temporary high demand (503) or 429 rate limit
    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: model,
          contents: prompt,
          config: {
            httpOptions: { timeout: 25000 },
            systemInstruction: "You are a professional musical composition engine that outputs songwriting metadata in JSON.",
            responseMimeType: "application/json",
            responseSchema: responseSchema,
            temperature: creativity ? creativity / 100 : 0.7
          }
        });
        
        if (response && response.text) {
          console.log(`[Gemini Engine] Success on model ${model}, attempt ${attempt}`);
          return response;
        }
        throw new Error("Empty response received from Gemini API");
      } catch (err: any) {
        lastError = err;
        console.warn(`[Gemini Engine] Attempt ${attempt} failed. Provider details are withheld.`);
        
        const errMsg = (err.message || "").toLowerCase();
        // If it's a client authentication or bad request error (not 429), don't retry because the schema/prompt is invalid or key is wrong
        const isClientError = errMsg.includes("400") || errMsg.includes("bad request") || errMsg.includes("403") || errMsg.includes("unauthorized");
        if (isClientError && !errMsg.includes("429")) {
          console.warn(`[Gemini Engine] Client error detected. Skipping further retries for ${model}.`);
          break;
        }

        if (attempt < maxRetries) {
          // Exponential backoff: 800ms, 1600ms, 3200ms
          const delay = Math.pow(2, attempt) * 400;
          console.log(`[Gemini Engine] Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  throw lastError || new Error("Failed to generate content with all attempted models");
}

// API Endpoint to compose a song using Gemini
const limitCompose = createMemoryRateLimit({ accountLimit: 20, ipLimit: 60, windowMs: 60 * 60_000, message: 'Songwriting has reached an hourly demo limit. Try again later.' });
app.post("/api/compose", limitCompose, limitGeminiGlobally, async (req, res) => {
  try { req.body = validateDraft(req.body); }
  catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid song description.' }); }
  try {
    const {
      description,
      mood,
      genre,
      language,
      tempo,
      emotion,
      singerStyle,
      enhancedVoice,
      theme,
      instruments,
      creativity
    } = req.body;

    if (!description) {
      return res.status(400).json({ error: "Description is required" });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is not configured on the server. Please add it to your Secrets."
      });
    }

    const prompt = `
      You are an expert music composer and songwriter. Create a complete song based on these inputs:
      - Description: "${description}"
      - Mood: "${mood}"
      - Genre: "${genre}"
      - Language: "${language}"
      - Tempo Speed: "${tempo}"
      ${req.body.bpm ? `- Exact requested tempo: ${req.body.bpm} BPM` : ''}
      - Emotion: "${emotion}"
      - Singer Vocal Style: "${singerStyle}"
      - Vocal production: ${enhancedVoice ? 'Enhanced studio lead vocal with clear diction, stable pitch, controlled dynamics, and room for tasteful chorus doubling' : 'Natural, intimate vocal character'}
      ${theme ? `- Theme overlay: "${theme}"` : ""}
      - Key Instruments: ${instruments ? instruments.join(", ") : "Piano, Synth, Drums"}
      - Creativity Level: ${creativity}%

      Treat the song description as the main creative direction. Genre and mood are separate controls: genre sets the rhythmic and instrumental vocabulary, while mood changes tempo, harmony, note density, brightness and energy even when the genre stays the same. Write a singable melody concept and varied arrangement that fit those explicit choices. For Electronic Vibe, favor a smooth groove, warm low end, airy synth layers, crisp drums and space around the lead vocal; keep it distinct from a high-energy Electronic dance arrangement. Do not reuse a generic pop arrangement for every request.
      Write concise, natural lyrics with a memorable chorus, not instructions about making music. Keep all lyrics and section labels below 3,000 characters so they can be sung by the music provider. Avoid putting stage directions in lines to be sung.

      Compose the following details:
      1. An expressive and catchy title.
      2. Structured lyrics: split the song into at least 5 sections: Intro, Verse 1, Chorus, Verse 2, Chorus (or Outro). Make the lyrics expressive, emotional, and authentic to the description. Ensure lyrics are in the selected language (${language}).
      3. A beautiful 4-chord progression for the verse and a separate 4-chord progression for the chorus (e.g. C, G, Am, F or similar standard chords) that fit the mood and key.
      4. A logical tempo BPM matching the requested tempo speed.
      5. A fitting musical key (e.g. A minor, C major, E minor).
      6. A visualizer color theme in hexadecimal format with teal greens, warm beige, and dark green backgrounds.
    `;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        title: {
          type: Type.STRING,
          description: "Evocative, poetic song title."
        },
        bpm: {
          type: Type.INTEGER,
          description: "Beats Per Minute matching the tempo speed."
        },
        key: {
          type: Type.STRING,
          description: "Musical key (e.g. 'C Major', 'A Minor', 'G Minor')."
        },
        chordProgression: {
          type: Type.OBJECT,
          properties: {
            verse: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "4-chord progression for the verse (e.g. ['Am', 'F', 'C', 'G'])"
            },
            chorus: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "4-chord progression for the chorus (e.g. ['C', 'G', 'Am', 'F'])"
            },
            bridge: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "Optional 4-chord progression for the bridge"
            }
          },
          required: ["verse", "chorus"]
        },
        lyrics: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              section: { type: Type.STRING, description: "e.g. Intro, Verse 1, Chorus, Verse 2, Chorus, Outro" },
              lines: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "4 to 6 lines of lyrics for this section."
              }
            },
            required: ["section", "lines"]
          },
          description: "The complete structured lyrics of the song."
        },
        visualizerTheme: {
          type: Type.OBJECT,
          properties: {
            primary: { type: Type.STRING, description: "Vibrant yellow or golden hex color (e.g. #facc15)" },
            secondary: { type: Type.STRING, description: "Warm amber or bronze-orange hex color (e.g. #d97706)" },
            glow: { type: Type.STRING, description: "Glowing yellow or bright honey hex color (e.g. #eab308)" },
            background: { type: Type.STRING, description: "Very deep espresso dark brown background hex color (e.g. #0e0601)" }
          },
          required: ["primary", "secondary", "glow", "background"]
        }
      },
      required: ["title", "bpm", "key", "chordProgression", "lyrics", "visualizerTheme"]
    };

    const response = await generateContentWithRetryAndFallback(prompt, responseSchema, creativity);

    const songData = JSON.parse(response.text || "{}");
    validateSong({ ...req.body, ...songData });
    if (typeof songData.title !== 'string' || songData.title.length > 120 || !songData.chordProgression ||
      !['verse', 'chorus'].every(section => Array.isArray(songData.chordProgression[section]) && songData.chordProgression[section].length >= 1 && songData.chordProgression[section].length <= 8 && songData.chordProgression[section].every((chord: unknown) => typeof chord === 'string' && /^[A-G][#b]?(?:m|maj|min|dim|aug|sus)?[0-9]?$/.test(chord)))) throw new Error('Invalid generated song.');
    res.json(songData);

  } catch (error: any) {
    const rawMessage = String(error?.message || '');
    const message = /api.?key|API_KEY_INVALID|expired/i.test(rawMessage)
      ? 'Google rejected the songwriting API key. Update GEMINI_API_KEY in .env.local and restart the server.'
      : /429|quota|resource.exhausted/i.test(rawMessage)
      ? 'AI songwriting has reached its quota. Check the Google account quota or try again later.'
      : 'AI songwriting could not be reached. Check the server connection and try again.';
    console.warn(`Songwriting failed: ${message}`);
    res.status(500).json({ error: message });
  }
});

app.use('/api', (_req, res) => { res.status(404).json({ error: 'This API route does not exist.' }); });

// Configure Vite or Static File Serving
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.get(['/server.cjs', '/server.cjs.map'], (_req, res) => { res.sendStatus(404); });
    app.use('/assets', express.static(path.join(distPath, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(distPath, { etag: true, maxAge: '1h', setHeaders: (res, file) => { if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

