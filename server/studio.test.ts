import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { GoogleGenAI } from '@google/genai';
import { createAuth, sameOrigin } from './auth';
import { createChatRouter } from './chat';
import { createMusicRouter } from './music/routes';
import type { MusicProvider } from './music/providers';
import { initialSongs } from '../src/utils/initialSongs';
import { LANGUAGES } from '../src/types';
import { starterLyrics } from '../src/utils/starterLyrics';
import { DEFAULT_DRAFT } from '../src/utils/songDraft';

const nativeChatSamples: Partial<Record<typeof LANGUAGES[number], string>> = {
  Assamese: 'জোনাক ভৰা ৰাতিৰ বাবে এটা গীত লিখা',
  Tamil: 'மழையில் பாடும் மனதைப் பற்றி ஒரு பாடல் எழுதுங்கள்',
  Manipuri: 'ꯅꯨꯡꯁꯤꯕꯥꯒꯤ ꯏꯁꯩ ꯑꯃꯥ ꯏꯕꯤꯌꯨ',
  Santali: 'ᱥᱮᱨᱮᱧ ᱢᱤᱫ ᱚᱞ ᱢᱮ',
  Urdu: 'بارش کے بارے میں ایک گیت لکھیں',
  Tulu: 'ಪಿರವು ಬತ್ತಿನ ಕಥೆದ ಪಾಡ್ದನ ಬರೆಯಿರಿ',
  Pahadi: 'पहाड़ों की शाम पर गीत लिखो',
};

test('real sign-in rejects wrong passwords; sessions and vocal jobs are isolated between accounts', async () => {
  const base = path.resolve('.data'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'auth-test-'));
  const auth = createAuth({ directory });
  const app = express(); app.use(express.json()); app.use(sameOrigin); app.use('/auth', auth.router);
  const provider: MusicProvider = { name: 'fixture', async status() { return { provider: 'test', available: true, message: 'Test only' }; }, async submit() { return { id: 'test' }; }, async poll() { return { status: 'complete', audioUrl: 'test' }; }, async audio() { return new Response('ID3', { headers: { 'Content-Type': 'audio/mpeg' } }); } };
  app.use('/music', auth.requireUser, createMusicRouter(provider));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const post = (route: string, body: unknown, cookie = '', extra = {}) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/music/jobs', initialSongs[0])).status, 401);
    assert.equal((await post('/auth/register', { username: 'Test', password: 'short' })).status, 400);
    const credentials = { username: 'Studio Test A', password: 'only-a-test-password' };
    const register = await post('/auth/register', credentials);
    assert.equal(register.status, 200);
    const cookie = register.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const token = cookie.split(';')[0];
    assert.equal((await (await fetch(url + '/auth/session', { headers: { Cookie: token } })).json()).user.username, credentials.username);
    const saved = await readFile(path.join(directory, 'accounts.json'), 'utf8');
    assert.ok(!saved.includes(credentials.password)); assert.match(saved, /"salt"/);
    assert.equal((await post('/auth/register', credentials)).status, 409);
    assert.equal((await post('/auth/login', { ...credentials, password: 'wrong-password' })).status, 401);
    const job = await (await post('/music/jobs', initialSongs[0], token, { 'Idempotency-Key': 'private-request-1' })).json();
    const second = await post('/auth/register', { username: 'Studio Test B', password: 'another-test-password' });
    const tokenB = second.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(url + '/music/jobs/' + job.taskId, { headers: { Cookie: tokenB } })).status, 404);
    assert.equal((await post('/music/jobs', initialSongs[0], tokenB, { 'Idempotency-Key': 'private-request-1' })).status, 409);
    assert.equal((await fetch(url + '/music/jobs/' + job.taskId, { headers: { Cookie: token } })).status, 200);
    assert.equal((await fetch(url + '/music/jobs/' + job.taskId + '/audio', { headers: { Cookie: tokenB } })).status, 404);
    assert.equal((await fetch(url + '/music/jobs/' + job.taskId + '/audio', { headers: { Cookie: token } })).status, 200);
    assert.equal((await post('/auth/logout', {}, token, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(url + '/auth/logout', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await post('/auth/logout', {}, token)).status, 200);
    assert.equal((await (await fetch(url + '/auth/session', { headers: { Cookie: token } })).json()).user, null);
    assert.equal((await post('/auth/login', credentials)).status, 200);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(path.resolve(directory).startsWith(base + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Kavi accepts every supported language and preserves native-script input and output', async () => {
  let fail = false; let callCount = 0;
  const ai = { models: { async generateContent(request: any) {
    callCount++;
    if (fail) throw Object.assign(new Error('API_KEY_INVALID SECRET'), { status: 400 });
    const input = JSON.parse(request.contents);
    assert.ok(request.config.systemInstruction.includes('Never claim you generated audio'));
    assert.match(request.config.systemInstruction, /You are Kavi/);
    assert.match(request.config.systemInstruction, /Meitei Mayek/);
    assert.match(request.config.systemInstruction, /Ol Chiki/);
    assert.deepEqual(request.config.responseSchema.properties.draft.properties.language.enum, [...LANGUAGES]);
    const lyrics = [{ section: 'Verse', lines: [input.userMessage] }];
    return { text: JSON.stringify({ reply: input.userMessage, ideas: [{ title: 'A new song', prompt: 'A gentle acoustic song' }], draft: { ...DEFAULT_DRAFT, description: input.userMessage, title: 'A revised song', language: input.responseLanguage, lyrics } }) };
  } } } as unknown as GoogleGenAI;
  const app = express(); app.use(express.json()); app.use('/chat', createChatRouter(ai, { GEMINI_API_KEY: 'SECRET' }));
  app.use('/offline', createChatRouter(ai, {}));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const post = (body: unknown, route = '/chat') => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const language of LANGUAGES) {
      const message = nativeChatSamples[language] || `Write an original song in ${language}`;
      const response = await post({ language, message, song: initialSongs[0] });
      assert.equal(response.status, 200);
      const result = await response.json(); assert.equal(result.reply, message); assert.equal(result.draft.language, language); assert.equal(result.draft.description, message); assert.deepEqual(result.draft.lyrics, [{ section: 'Verse', lines: [message] }]);
    }
    assert.equal((await post({ language: 'Invalid', message: 'hi' })).status, 400);
    assert.equal(callCount, LANGUAGES.length);
    assert.equal((await post({ language: 'English', message: 'hi' }, '/offline')).status, 503);
    fail = true;
    const response = await post({ language: 'English', message: 'hi' });
    assert.equal(response.status, 502);
    const text = await response.text(); assert.ok(!text.includes('SECRET')); assert.match(text, /rejected the Gemini key/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Kavi receives full working drafts, bounds history and validates follow-ups without exposing extra fields', async () => {
  let calls = 0;
  const latest = { ...DEFAULT_DRAFT, description: 'Gentle piano ballad', language: 'Punjabi', title: 'Working chorus', bpm: 80, lyrics: starterLyrics('Punjabi') };
  const ai = { models: { async generateContent(request: any) {
    calls++;
    const input = JSON.parse(request.contents);
    assert.deepEqual(input.latestDraft, latest);
    assert.equal(input.currentSong.title, initialSongs[0].title);
    assert.equal(input.responseLanguage, 'English');
    assert.equal(input.mode, 'revise');
    assert.equal(input.conversation.length, 8);
    assert.ok(input.conversation.every((item: any) => item.text.length <= 2000 && !('secret' in item)));
    assert.ok(!request.contents.includes('/private/audio'));
    assert.match(request.config.systemInstruction, /change ONLY the chorus/);
    assert.match(request.config.systemInstruction, /Preserve enhancedVoice/);
    assert.equal(input.latestDraft.enhancedVoice, true);
    assert.ok(request.config.responseSchema.properties.draft.required.includes('enhancedVoice'));
    return { text: JSON.stringify({ reply: 'I shortened the chorus and kept the Punjabi verses.', ideas: [{ title: 'Idea', prompt: 'A soft piano song', extra: 'discard' }], draft: latest,
      followUps: ['Prepare a count-in', 7, '', 'x'.repeat(181), 'Add a bridge', 'Make it acoustic', 'Too many'], changes: ['Shorter chorus', null] }) };
  } } } as unknown as GoogleGenAI;
  const app = express(); app.use(express.json()); app.use('/chat', createChatRouter(ai, { GEMINI_API_KEY: 'fixture' }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/chat';
  const request = { message: 'Shorten the chorus', language: 'English', mode: 'revise', song: { ...initialSongs[0], audioUrl: '/private/audio' }, latestDraft: latest,
    history: Array.from({ length: 12 }, () => ({ role: 'assistant', text: 'a'.repeat(2500), secret: 'discard' })) };
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const response = await post(request); assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.draft.language, 'Punjabi');
    assert.deepEqual(reply.followUps, ['Prepare a count-in', 'Add a bridge', 'Make it acoustic']);
    assert.deepEqual(reply.changes, ['Shorter chorus']);
    assert.deepEqual(reply.ideas, [{ title: 'Idea', prompt: 'A soft piano song' }]);
    assert.equal((await post({ ...request, latestDraft: { lyrics: 'bad' } })).status, 400);
    assert.equal((await post({ ...request, mode: 'unknown' })).status, 400);
    assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
