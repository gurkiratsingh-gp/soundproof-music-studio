import type { SongMetadata } from '../types';
import { validateDraft, type ChatMode, type ChatReply, type SongDraft } from './songDraft';

export type ChatMessage = { role: 'user' | 'assistant'; text: string; result?: ChatReply; sourceId?: string; language?: string };
export type ChatRequest = { sourceId?: string; payload: { message: string; language: string; mode: ChatMode; history: { role: string; text: string }[]; song?: SongDraft; latestDraft?: SongDraft } };
export function latestWorkingDraft(messages: ChatMessage[], sourceId?: string) {
  return [...messages].reverse().find(item => item.role === 'assistant' && item.result?.draft && item.sourceId === sourceId)?.result?.draft;
}
export function buildChatRequest(messages: ChatMessage[], message: string, language: string, mode: ChatMode, song?: SongMetadata): ChatRequest {
  const sourceId = song?.id;
  const latest = latestWorkingDraft(messages, sourceId);
  return { sourceId, payload: { message: message.trim(), language, mode,
    // Draft-card lyrics must be retained separately from the conversation text.
    history: messages.slice(-8).map(item => ({ role: item.role, text: item.text.slice(0, 2000) })),
    ...(song ? { song: validateDraft(song) } : {}), ...(latest ? { latestDraft: validateDraft(latest) } : {}),
  } };
}
