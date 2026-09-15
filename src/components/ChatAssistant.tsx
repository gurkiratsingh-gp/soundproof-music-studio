import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowRight, Sparkles, Music2, PenLine, LoaderCircle, RotateCcw, AudioLines, Mic2, Copy, Square, Paperclip, Upload, X } from 'lucide-react';
import { ADDITIONAL_INDIAN_LANGUAGES, INTERNATIONAL_LANGUAGES, SCHEDULED_INDIAN_LANGUAGES, type SongMetadata } from '../types';
import { DEFAULT_DRAFT, lyricsText, type SongDraft, type ChatMode, type ChatReply } from '../utils/songDraft';
import { buildChatRequest, latestWorkingDraft, type ChatMessage, type ChatRequest } from '../utils/chatConversation';
import { listTakes, type VocalTake } from '../utils/recordingStore';
import { analyzeAudioReference, type AudioReferenceAnalysis } from '../utils/audioReference';

const MODES: { id: ChatMode; label: string }[] = [{ id: 'co-write', label: 'Co-write' }, { id: 'ideas', label: 'Song ideas' }, { id: 'lyrics', label: 'Write lyrics' }, { id: 'revise', label: 'Revise a song' }, { id: 'practice', label: 'Singing tips' }];
export default function ChatAssistant({ song, userId, onDraft, onApply, onAudioInstrumental, onActivity }: { song: SongMetadata | null; userId: string; onDraft: (draft: SongDraft) => void; onApply: (draft: SongDraft, id: string) => void; onAudioInstrumental: (draft: SongDraft) => void; onActivity: (text: string) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [language, setLanguage] = useState('English');
  const [mode, setMode] = useState<ChatMode>('co-write');
  const [useSong, setUseSong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [failedRequest, setFailedRequest] = useState<ChatRequest | null>(null);
  const [audioOpen, setAudioOpen] = useState(false);
  const [takes, setTakes] = useState<VocalTake[]>([]);
  const [selectedTake, setSelectedTake] = useState('');
  const [audioName, setAudioName] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [audioAnalysis, setAudioAnalysis] = useState<AudioReferenceAnalysis | null>(null);
  const [analyzingAudio, setAnalyzingAudio] = useState(false);
  const [audioError, setAudioError] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const pending = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const audioUrlRef = useRef('');
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => () => { if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current); }, []);
  useEffect(() => {
    let active = true;
    if (!song) { setTakes([]); setSelectedTake(''); return; }
    listTakes(userId, song.id).then(items => { if (active) { setTakes(items); setSelectedTake(items[0]?.id || ''); } }).catch(() => { if (active) setTakes([]); });
    return () => { active = false; };
  }, [song?.id, userId]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }, [messages, busy, error]);
  const workingDraft = latestWorkingDraft(messages, useSong ? song?.id : undefined);

  function clearAudio() {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = ''; setAudioUrl(''); setAudioName(''); setAudioAnalysis(null); setAudioError(''); setAnalyzingAudio(false);
    if (fileInput.current) fileInput.current.value = '';
  }
  async function readAudio(blob: Blob, name: string) {
    if (analyzingAudio || busy) return;
    clearAudio(); setAudioOpen(true); setAnalyzingAudio(true); setAudioName(name);
    const url = URL.createObjectURL(blob); audioUrlRef.current = url; setAudioUrl(url);
    try {
      const analysis = await analyzeAudioReference(blob); setAudioAnalysis(analysis);
      const summary = `Create an instrumental backing for this sung idea at about ${analysis.bpm} BPM${analysis.pitchClass ? ` around ${analysis.pitchClass}` : ''}.`;
      setInput(previous => previous.trim() ? previous : summary);
      onActivity('Analyzed a sung audio reference locally');
    } catch (failure) { setAudioError(failure instanceof Error ? failure.message : 'This audio could not be analyzed.'); }
    finally { setAnalyzingAudio(false); }
  }
  function referenceDraft(): SongDraft {
    const base = workingDraft || song || DEFAULT_DRAFT; const bpm = audioAnalysis?.bpm || base.bpm || 96;
    const minor = /minor$/i.test(base.key || '') || ['Sad', 'Relax'].includes(base.mood);
    const key = audioAnalysis?.pitchClass ? `${audioAnalysis.pitchClass} ${minor ? 'minor' : 'major'}` : base.key || (minor ? 'A minor' : 'C major');
    return {
      ...DEFAULT_DRAFT, ...base,
      title: `${base.title || audioName.replace(/\.[^.]+$/, '') || 'Sung idea'} backing`,
      description: `An instrumental backing shaped around my sung reference at ${bpm} BPM in ${key}. ${base.description || 'Leave space for the lead vocal and follow its natural phrasing.'}`.slice(0, 2000),
      bpm, key, tempo: bpm < 90 ? 'Slow' : bpm < 120 ? 'Medium' : bpm < 140 ? 'Upbeat' : 'Fast',
      lyrics: base.lyrics,
    };
  }

  async function send(text: string, retry?: ChatRequest) {
    if (!text.trim() || pending.current) return;
    let request: ChatRequest;
    const attachment = audioAnalysis ? `Local audio analysis: estimated ${audioAnalysis.bpm} BPM${audioAnalysis.pitchClass ? `; pitch center ${audioAnalysis.pitchClass}` : ''}. The audio stays in the browser.` : '';
    const requestText = retry ? text : attachment ? `${text.trim().slice(0, Math.max(1, 1995 - attachment.length))}\n\n${attachment}` : text;
    try { request = retry || buildChatRequest(messages, requestText, language, mode, useSong && song ? song : undefined); }
    catch { setError('The selected draft could not be read. Start a new conversation or turn off Use selected song.'); return; }
    if (!retry) setMessages(previous => [...previous, { role: 'user', text: text.trim() + (attachment ? `\nAudio reference: ${audioName} · ${audioAnalysis!.bpm} BPM${audioAnalysis!.pitchClass ? ` · ${audioAnalysis!.pitchClass} center` : ''}` : '') }]);
    setInput(''); setError(''); setNotice(''); setFailedRequest(null); setBusy(true);
    const controller = new AbortController(); pending.current = controller;
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.payload), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Kavi could not answer. Please try again.');
      if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('Kavi returned an empty answer. Please try again.');
      if (controller.signal.aborted) return;
      setMessages(previous => [...previous, { role: 'assistant', text: data.reply, result: data as ChatReply, sourceId: request.sourceId, language: request.payload.language }]);
      onActivity(data.draft ? 'Wrote a song draft with Kavi' : 'Explored music with Kavi');
    } catch (error) {
      if (!controller.signal.aborted) { setFailedRequest(request); setError(error instanceof Error && error.name === 'Error' ? error.message : 'Kavi took too long to respond. Please try again.'); }
    } finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }
  function stop() { pending.current?.abort(); pending.current = null; setBusy(false); setNotice('Stopped waiting for this answer. You can edit your request and send it again.'); }
  async function copyDraft(draft: SongDraft) {
    try { await navigator.clipboard.writeText((draft.title || '') + '\n\n' + lyricsText(draft.lyrics || []) + '\n\nProduction prompt: ' + draft.description); setNotice('Lyrics and production prompt copied.'); }
    catch { setNotice('Clipboard access is unavailable. Select the draft text to copy it.'); }
  }
  const quickActions = [
    { icon: Sparkles, title: 'Find a song idea', mode: 'ideas' as const, text: 'Suggest three original song ideas for a memorable college farewell. Give each a different musical direction.' },
    { icon: PenLine, title: 'Write some lyrics', mode: 'lyrics' as const, text: 'Write a short verse and a catchy chorus about chasing a dream. Include a production prompt.' },
    { icon: AudioLines, title: 'Change the feeling', mode: 'revise' as const, text: 'Make my selected song softer and more acoustic. Keep its lyrics and language unchanged.' },
    { icon: Mic2, title: 'Prepare to sing', mode: 'practice' as const, text: 'Help me prepare to record this song myself. Suggest phrasing, breathing points and how to count in.' },
  ];
  return <div className="chat-layout"><section className="panel chat-panel">
    <div className="chat-heading"><span className="assistant-avatar"><Sparkles size={22} /></span><div><h2>Kavi, your songwriting co-writer</h2><p className="small-text muted">Write naturally in your language and script, then shape the song together.</p></div><button className="icon-button" aria-label="Start a new conversation with Kavi" title="Start a new conversation" disabled={busy || (!messages.length && !audioAnalysis)} onClick={() => { setMessages([]); setFailedRequest(null); setError(''); setInput(''); setNotice(''); clearAudio(); setAudioOpen(false); }}><RotateCcw size={17} /></button></div>
    <div className="chat-modes" role="group" aria-label="Songwriting task">{MODES.map(item => <button key={item.id} type="button" className="chip" aria-pressed={mode === item.id} disabled={busy} onClick={() => { setMode(item.id); if (item.id === 'revise' && song) setUseSong(true); }}>{item.label}</button>)}</div>
    <div className="chat-messages" ref={scroll} role="log" aria-label="Conversation" aria-live="polite">
      {!messages.length && <div className="chat-welcome"><span className="eyebrow">LET’S MAKE SOMETHING THAT SOUNDS LIKE YOU</span><h3>Where should we begin?</h3><p>Bring a feeling, a half-written line, or a song you want to reimagine. I can build on drafts we write here.</p><div className="chat-starters">{quickActions.map(item => <button key={item.title} onClick={() => { setInput(item.text); setMode(item.mode); if (['revise', 'practice'].includes(item.mode) && song) setUseSong(true); }}><item.icon size={20} /><span>{item.title}</span><ArrowRight size={16} /></button>)}</div></div>}
      {messages.map((message, index) => <article key={index} className={'chat-message ' + message.role}><span className="message-author">{message.role === 'user' ? 'You' : 'Kavi'}</span><p dir="auto">{message.text}</p>
        {message.result?.ideas?.map((idea, n) => <button className="chat-idea" key={n} onClick={() => onDraft({ ...DEFAULT_DRAFT, language: message.language || language, description: idea.prompt, title: idea.title })}><Music2 size={17} /><span>{idea.title}<small>Use this song idea</small></span><ArrowRight size={16} /></button>)}
        {message.result?.draft && <div className="chat-draft"><div className="section-heading"><span className="eyebrow">SONG DRAFT</span><span className="badge">{message.result.draft.language}</span></div><h4 dir="auto">{message.result.draft.title || 'Your new idea'}</h4><p className="small-text muted">{message.result.draft.genre} · {message.result.draft.bpm || 'Auto'} BPM{message.result.draft.key ? ` · ${message.result.draft.key}` : ''} · {message.result.draft.instruments.join(', ')}</p><p dir="auto" className="draft-prompt">{message.result.draft.description}</p>
          {!!message.result.changes?.length && <ul className="draft-changes">{message.result.changes.map((change, i) => <li key={i} dir="auto">{change}</li>)}</ul>}
          {Boolean(message.result.draft.lyrics?.length) && <pre dir="auto">{lyricsText(message.result.draft.lyrics!)}</pre>}
          <div className="button-row"><button className="button primary small" onClick={() => onDraft(message.result!.draft!)}>Open in composer <ArrowRight size={14} /></button>{message.sourceId && <button className="button secondary small" onClick={() => onApply(message.result!.draft!, message.sourceId!)}>Save revised song</button>}<button className="icon-button" aria-label="Copy draft lyrics and production prompt" onClick={() => void copyDraft(message.result!.draft!)}><Copy size={16} /></button></div></div>}
        {index === messages.length - 1 && !!message.result?.followUps?.length && <div className="chat-followups" aria-label="Suggested next steps">{message.result.followUps.map((prompt, i) => <button key={i} type="button" disabled={busy} onClick={() => { setInput(prompt); }} dir="auto">{prompt}<ArrowRight size={13} /></button>)}</div>}
      </article>)}
      {busy && <div className="thinking" role="status"><LoaderCircle className="spin" size={18} />{mode === 'practice' ? 'Preparing your singing tips…' : mode === 'revise' ? 'Shaping your revision…' : 'Finding the right words…'}<button type="button" className="text-button" onClick={stop}><Square size={13} />Stop</button></div>}
      {error && <div className="notice error" role="alert"><p>{error}</p>{failedRequest && <div className="button-row"><button className="text-button" disabled={busy} onClick={() => void send(failedRequest.payload.message, failedRequest)}>Try again</button><button className="text-button" onClick={() => onDraft({ ...DEFAULT_DRAFT, language: failedRequest.payload.language, description: failedRequest.payload.message })}>Use my message as a song prompt <ArrowRight size={14} /></button></div>}</div>}
    </div>
    {notice && <p className="chat-notice small-text" role="status">{notice}</p>}
    <form className="chat-input-wrap" onSubmit={e => { e.preventDefault(); void send(input); }}><div className="chat-context"><label>Kavi’s reply language<select aria-label="Kavi reply language" value={language} disabled={busy} onChange={e => setLanguage(e.target.value)}><optgroup label="International languages">{INTERNATIONAL_LANGUAGES.map(item => <option key={item}>{item}</option>)}</optgroup><optgroup label="India’s 22 scheduled languages">{SCHEDULED_INDIAN_LANGUAGES.map(item => <option key={item}>{item}</option>)}</optgroup><optgroup label="Additional Indian languages">{ADDITIONAL_INDIAN_LANGUAGES.map(item => <option key={item}>{item}</option>)}</optgroup></select></label><label className="checkbox-label"><input type="checkbox" checked={useSong} disabled={!song || busy} onChange={e => setUseSong(e.target.checked)} />Use selected song</label><button type="button" className="text-button audio-attach-button" aria-expanded={audioOpen} onClick={() => setAudioOpen(value => !value)}><Paperclip size={15} />Add sung audio</button></div>
      {audioOpen && <section className="audio-reference" aria-label="Sung audio reference"><div className="audio-reference-head"><div><strong>Match an instrumental to your voice</strong><p>Choose a saved take or an audio file. Analysis stays on this device.</p></div><button type="button" className="icon-button" aria-label="Close sung audio attachment" onClick={() => setAudioOpen(false)}><X size={15} /></button></div><input ref={fileInput} hidden type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm" onChange={event => { const file = event.target.files?.[0]; if (file) void readAudio(file, file.name); }} />
        <div className="audio-source-actions"><button type="button" className="button secondary small" disabled={busy || analyzingAudio} onClick={() => fileInput.current?.click()}><Upload size={15} />Choose audio file</button>{takes.length > 0 && <><select aria-label="Choose a saved vocal take for audio matching" value={selectedTake} disabled={busy || analyzingAudio} onChange={event => setSelectedTake(event.target.value)}>{takes.map(take => <option key={take.id} value={take.id}>{new Date(take.createdAt).toLocaleString()} · {take.includesInstrumental ? 'voice + music' : 'voice only'}</option>)}</select><button type="button" className="button secondary small" disabled={!selectedTake || busy || analyzingAudio} onClick={() => { const take = takes.find(item => item.id === selectedTake); if (take) void readAudio(take.blob, `${song?.title || 'Saved song'} vocal take`); }}><Mic2 size={15} />Use saved take</button></>}</div>
        {analyzingAudio && <p className="audio-analysis-status" role="status"><LoaderCircle className="spin" size={15} />Listening for tempo and pitch…</p>}{audioUrl && <audio className="audio-reference-player" controls src={audioUrl} preload="metadata" />}{audioAnalysis && <div className="audio-analysis"><span><small>ESTIMATED PULSE</small><strong>{audioAnalysis.bpm} BPM</strong></span><span><small>PITCH CENTER</small><strong>{audioAnalysis.pitchClass || 'Not clear'}</strong></span><span><small>LENGTH</small><strong>{Math.floor(audioAnalysis.duration / 60)}:{String(Math.floor(audioAnalysis.duration % 60)).padStart(2, '0')}</strong></span><div className="button-row"><button type="button" className="button primary small" onClick={() => onAudioInstrumental(referenceDraft())}><AudioLines size={15} />Generate matched instrumental</button><button type="button" className="text-button" onClick={() => onDraft(referenceDraft())}>Fine-tune in Create <ArrowRight size={14} /></button></div><p>{audioAnalysis.bpmConfidence < .08 ? 'No clear pulse was found, so SoundProof used a neutral 96 BPM starting point. ' : ''}Tempo and pitch are estimates. Compare the result with your voice and adjust BPM or key if needed.</p></div>}{audioError && <p className="notice error" role="alert">{audioError}</p>}
      </section>}
      {(workingDraft || (useSong && song)) && <p className="context-caption">Working with: <strong>{workingDraft?.title || song?.title}</strong>{workingDraft ? ' · latest chat draft' : ' · selected library song'}</p>}
      <div className="chat-input"><textarea aria-label="Message Kavi" dir="auto" rows={2} value={input} maxLength={2000} onChange={e => setInput(e.target.value)} placeholder={mode === 'revise' ? 'Shorten the chorus; keep the verses and tempo…' : mode === 'practice' ? 'Where should I breathe while singing this chorus?' : 'Write a Punjabi chorus about a summer evening…'} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input); } }} /><button className="send-button" aria-label="Send message to Kavi" disabled={busy || !input.trim()}>{busy ? <LoaderCircle size={20} className="spin" /> : <ArrowUp size={21} />}</button></div><p className="chat-disclaimer">Write in native script, transliteration, or a mix of languages. Audio is analyzed on this device; Gemini receives only the written tempo/pitch summary. Enter to send · Shift + Enter for a new line.</p></form>
  </section><aside className="chat-aside"><span className="eyebrow">MEET KAVI</span><h3>A good song<br />starts with a conversation.</h3><div><span>01</span><h4>Find your direction</h4><p>Choose a task and describe the story or feeling you want.</p></div><div><span>02</span><h4>Keep shaping it</h4><p>Ask “make the chorus shorter.” Your latest draft stays in context while you chat.</p></div><div><span>03</span><h4>Make a free vocal take</h4><p>Open the song in My library. Use headphones, press Record my vocals, wait for the countdown, then sing. Stop & save lets you keep your take.</p></div><p className="aside-note">India’s 22 scheduled languages · Bhojpuri · Tulu · Pahadi · international options</p><p className="small-text muted">Recording needs no AI credits. Kavi still needs a working Gemini connection.</p></aside></div>;
}
