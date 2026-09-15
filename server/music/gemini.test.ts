import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createMusicProvider } from './providers';
import { initialSongs } from '../../src/utils/initialSongs';
import { LANGUAGES } from '../../src/types';
import { starterLyrics } from '../../src/utils/starterLyrics';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const audioPayload = { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Original lyrics' }, { type: 'audio', mime_type: 'audio/mpeg', data: Buffer.from('ID3-test-audio').toString('base64') }] }] };
const nativeVocalSamples: Partial<Record<typeof LANGUAGES[number], string>> = {
  Assamese: 'জোনাক ভৰা ৰাতি', Tamil: 'மழையில் பாடும் மனம்', Manipuri: 'ꯅꯨꯡꯁꯤꯕꯥꯒꯤ ꯏꯁꯩ',
  Santali: 'ᱥᱮᱫᱟᱭ ᱨᱮᱭᱟᱜ ᱥᱮᱨᱮᱧ', Urdu: 'بارش میں دل گاتا ہے', Tulu: 'ಎನ್ನ ಹೃದಯದ ಪಾಡ್ದನ',
};

test('Lyria submits a background request with original lyrics, then serves the returned audio with seeking', async () => {
  let resolve!: (value: Response) => void;
  let request: RequestInit | undefined;
  const provider = createMusicProvider({ MUSIC_PROVIDER: 'gemini', GEMINI_API_KEY: 'SECRET', GEMINI_MUSIC_MODEL: 'lyria-3.5' }, async (url, init) => {
    assert.equal(String(url), 'https://generativelanguage.googleapis.com/v1beta/interactions');
    request = init;
    return new Promise<Response>(done => { resolve = done; });
  });
  const task = await provider.submit({ ...initialSongs[0], language: 'Punjabi', lyrics: starterLyrics('Punjabi') });
  assert.equal((await provider.poll(task)).status, 'generating');
  const body = JSON.parse(String(request?.body));
  assert.equal(body.model, 'lyria-3.5');
  assert.ok(body.input.includes(starterLyrics('Punjabi')[0].lines[0]));
  assert.match(body.input, /clearly audible singing/);
  assert.match(body.input, /enhanced studio-focused lead vocal/i);
  assert.equal(new Headers(request?.headers).get('x-goog-api-key'), 'SECRET');
  assert.ok(!JSON.stringify(body).includes('SECRET'));
  resolve(json(audioPayload)); await setImmediate();
  const result = await provider.poll(task);
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') throw new Error('Expected recording');
  const full = await provider.audio(result.audioUrl);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await full.text(), 'ID3-test-audio');
  const range = await provider.audio(result.audioUrl, 'bytes=0-2');
  assert.equal(range.status, 206); assert.equal(await range.text(), 'ID3');
  assert.equal(range.headers.get('content-range'), 'bytes 0-2/14');
  assert.equal(await (await provider.audio(result.audioUrl, 'bytes=-5')).text(), 'audio');
  for (const value of ['bytes=999-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'nonsense', 'bytes=0-1,5-6']) assert.equal((await provider.audio(result.audioUrl, value)).status, 416);
});

test('Lyria honors an explicit natural voice choice', async () => {
  let input = '';
  const provider = createMusicProvider({ MUSIC_PROVIDER: 'gemini', GEMINI_API_KEY: 'test' }, async (_url, init) => {
    input = JSON.parse(String(init?.body)).input;
    return json(audioPayload);
  });
  const task = await provider.submit({ ...initialSongs[0], enhancedVoice: false });
  await setImmediate();
  assert.match(input, /natural and expressive/i);
  assert.doesNotMatch(input, /enhanced studio-focused lead vocal/i);
  assert.equal((await provider.poll(task)).status, 'complete');
});

test('Lyria prompts preserve native-script lyrics for every supported app language', async () => {
  for (const language of LANGUAGES) {
    const lyrics = [{ section: 'Verse', lines: [nativeVocalSamples[language] || starterLyrics(language)[0].lines[0]] }];
    const provider = createMusicProvider({ MUSIC_PROVIDER: 'gemini', GEMINI_API_KEY: 'test' }, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).input;
      assert.ok(prompt.includes('Sing in ' + language));
      assert.ok(prompt.includes(lyrics[0].lines[0]));
      assert.match(prompt, /original language and script/);
      return json(audioPayload);
    });
    const task = await provider.submit({ ...initialSongs[0], language, lyrics });
    await setImmediate();
    assert.equal((await provider.poll(task)).status, 'complete');
  }
});

test('Lyria reports missing keys, rejected credentials, quota, missing audio and network failure without leaking credentials', async () => {
  const missing = createMusicProvider({ MUSIC_PROVIDER: 'gemini' });
  assert.equal((await missing.status()).available, false);
  await assert.rejects(missing.submit(initialSongs[0]), /GEMINI_API_KEY/);
  const cases: Array<[() => Promise<Response>, RegExp]> = [
    [async () => json({ error: { message: 'API_KEY_INVALID SECRET' } }, 400), /rejected the Gemini key/],
    [async () => json({ error: 'SECRET' }, 429), /quota/],
    [async () => json({ error: 'SECRET' }, 404), /model is unavailable/],
    [async () => json({ steps: [] }), /without playable audio/],
    [async () => { throw new Error('SECRET'); }, /Could not reach/],
  ];
  for (const [fetcher, pattern] of cases) {
    const provider = createMusicProvider({ MUSIC_PROVIDER: 'gemini', GEMINI_API_KEY: 'SECRET' }, fetcher);
    const task = await provider.submit(initialSongs[0]); await setImmediate();
    const result = await provider.poll(task);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') { assert.match(result.error, pattern); assert.ok(!result.error.includes('SECRET')); }
  }
});

test('Lyria bounds concurrent paid generations', async () => {
  const provider = createMusicProvider({ MUSIC_PROVIDER: 'gemini', GEMINI_API_KEY: 'test' }, async () => new Promise(() => {}));
  await provider.submit(initialSongs[0]); await provider.submit(initialSongs[0]);
  await assert.rejects(provider.submit(initialSongs[0]), /Two songs are already generating/);
});
