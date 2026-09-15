import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest, type ChatMessage } from './chatConversation';
import { initialSongs } from './initialSongs';
import { validateDraft } from './songDraft';

test('follow-up requests retain the latest full draft, without original audio or another song’s draft', () => {
  const original = initialSongs[0];
  const draft = { ...validateDraft(original), title: 'Changed chorus', lyrics: [{ section: 'Chorus', lines: ['A brand new line'] }] };
  const messages: ChatMessage[] = [
    { role: 'assistant', text: 'Here is your revision.', sourceId: original.id, result: { reply: '', ideas: [], draft } },
    { role: 'assistant', text: 'Another song.', sourceId: 'other', result: { reply: '', ideas: [], draft: { ...draft, title: 'Other song' } } },
  ];
  const request = buildChatRequest(messages, 'Shorten the chorus', 'Hindi', 'revise', { ...original, audioUrl: '/private/audio' });
  assert.deepEqual(request.payload.latestDraft, draft);
  assert.equal(request.sourceId, original.id);
  assert.equal(request.payload.language, 'Hindi');
  assert.ok(!JSON.stringify(request).includes('/private/audio'));
  assert.equal(buildChatRequest(messages, 'Write something new', 'English', 'lyrics').payload.latestDraft, undefined);
  const snapshot = JSON.stringify(request);
  messages.push({ role: 'user', text: 'Unrelated next message' });
  assert.equal(JSON.stringify(request), snapshot, 'retry payload must remain a stable snapshot');
});

test('chat keeps an unlinked draft for follow-ups and bounds text history', () => {
  const draft = validateDraft(initialSongs[1]);
  const messages: ChatMessage[] = Array.from({ length: 30 }, () => ({ role: 'user', text: 'a'.repeat(6000) }));
  messages.push({ role: 'assistant', text: 'Draft ready', result: { reply: '', ideas: [], draft } });
  const request = buildChatRequest(messages, 'Keep the verses', 'Japanese', 'co-write');
  assert.deepEqual(request.payload.latestDraft, draft);
  assert.equal(request.payload.history.length, 8);
  assert.ok(request.payload.history.every(item => item.text.length <= 2000));
  assert.ok(new TextEncoder().encode(JSON.stringify(request)).length < 64000);
});
