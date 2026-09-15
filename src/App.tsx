import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Home, Plus, LayoutDashboard, Library, Activity, Sparkles, Settings, Search, ArrowUpRight, ArrowRight, LogOut, AudioLines, Music2, Mic2, Globe2, Menu, X, LoaderCircle, CheckCircle2, Clock3, AlertCircle, ChevronRight, Disc3 } from 'lucide-react';
import { initialSongs } from './utils/initialSongs';
import { generateProceduralSong } from './utils/proceduralFallback';
import { AudioEngine } from './utils/audioEngine';
import { DEFAULT_DRAFT, parseLyrics, validateDraft, type SongDraft } from './utils/songDraft';
import { starterLyrics } from './utils/starterLyrics';
import { resolveSongBrief } from './utils/songArrangement';
import { countTakes } from './utils/recordingStore';
import { saveKaraokeTrack } from './utils/karaokeStore';
import { processKaraokeTrack } from './utils/karaokeProcessor';
import { LANGUAGES, type KaraokeBackingMetadata, type SongMetadata, type User } from './types';
import SongGeneratorForm, { PROMPTS } from './components/SongGeneratorForm';
import SongPlayer from './components/SongPlayer';
import LibraryView from './components/LibraryView';
import ChatAssistant from './components/ChatAssistant';
import Login, { Brand } from './components/Login';
import ThemeSettings from './components/ThemeSettings';
import KaraokeTrackLab, { type KaraokeTrackPayload } from './components/KaraokeTrackLab';
import { applyTheme, initialThemePreference, resolveTheme, systemPrefersDark, type Theme, type ThemePreference } from './utils/theme';
import PhoneCompanionPage from './components/PhoneCompanionPage';
import PhoneMicPanel from './components/PhoneMicPanel';
import { StudioPhoneMic } from './utils/phoneCompanion';

const PAGES = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'create', label: 'Create a song', icon: Plus },
  { id: 'karaoke', label: 'Karaoke track lab', icon: Disc3 },
  { id: 'library', label: 'My library', icon: Library },
  { id: 'assistant', label: 'Kavi assistant', icon: Sparkles },
  { id: 'activity', label: 'Activity', icon: Activity },
] as const;
type Page = typeof PAGES[number]['id'] | 'settings';
type Event = { id: string; text: string; at: string; kind: 'created' | 'vocals' | 'chat' | 'error' };
type Notice = { type: 'info' | 'warning' | 'success' | 'error'; message: string };
const samples = initialSongs.map(song => ({ ...song, lyricsSource: 'template' as const }));

function validBackingMetadata(value: unknown): value is KaraokeBackingMetadata {
  if (!value || typeof value !== 'object') return false;
  const item = value as KaraokeBackingMetadata;
  const processing = item.processing;
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128 &&
    typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 255 &&
    Number.isFinite(item.duration) && item.duration >= 1 && item.duration <= 300 &&
    Number.isFinite(item.bpm) && item.bpm >= 40 && item.bpm <= 240 &&
    Number.isFinite(item.sampleRate) && item.sampleRate >= 8_000 && item.sampleRate <= 96_000 &&
    Boolean(processing) && Number.isFinite(processing.centerReduction) && processing.centerReduction >= 0 && processing.centerReduction <= 1 &&
    Number.isFinite(processing.bassPreservation) && processing.bassPreservation >= 0 && processing.bassPreservation <= 1 &&
    Number.isFinite(processing.semitones) && Math.abs(processing.semitones) <= 12 &&
    (processing.sourceKey === undefined || (typeof processing.sourceKey === 'string' && processing.sourceKey.length <= 32)) &&
    (processing.targetKey === undefined || (typeof processing.targetKey === 'string' && processing.targetKey.length <= 32));
}

function loadSongs(user: User): SongMetadata[] {
  try {
    const data = JSON.parse(localStorage.getItem('svara:songs:' + user.id) || 'null');
    if (!Array.isArray(data)) return samples;
    return data.filter(song => { try { validateDraft(song); return typeof song.id === 'string' && typeof song.title === 'string' && song.chordProgression?.verse?.length && song.chordProgression?.chorus?.length && Array.isArray(song.lyrics) && (song.backingTrack === undefined || validBackingMetadata(song.backingTrack)); } catch { return false; } }).slice(0, 100).map(song => ({ ...song, audioUrl: undefined, vocalGeneration: undefined }));
  } catch { return samples; }
}
export default function App() {
  const phonePage = window.location.pathname.replace(/\/+$/, '') === '/phone';
  const [themePreference, setThemePreference] = useState<ThemePreference>(initialThemePreference);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [sessionError, setSessionError] = useState('');
  async function checkSession() {
    setChecking(true); setSessionError('');
    try {
      const response = await fetch('/api/auth/session', { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const data = await response.json(); setUser(data.user);
    } catch { setSessionError('Could not connect to the studio. Check that the server is running, then try again.'); }
    finally { setChecking(false); }
  }
  const theme = resolveTheme(themePreference, prefersDark);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const update = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  useEffect(() => { applyTheme(themePreference, prefersDark); }, [themePreference, prefersDark]);
  useEffect(() => { if (!phonePage) void checkSession(); }, [phonePage]);
  if (phonePage) return <PhoneCompanionPage />;
  if (checking) return <div className="app-loading"><Brand /><LoaderCircle className="spin" /><p>Opening your studio…</p></div>;
  if (sessionError) return <div className="app-loading"><Brand /><p role="alert">{sessionError}</p><button className="button primary" onClick={() => void checkSession()}>Try again</button></div>;
  if (!user) return <Login onLogin={value => { window.scrollTo({ top: 0 }); setUser(value); }} />;
  return <Studio key={user.id} user={user} onLogout={() => setUser(null)} themePreference={themePreference} resolvedTheme={theme} onThemePreferenceChange={setThemePreference} />;
}

function Studio({ user, onLogout, themePreference, resolvedTheme, onThemePreferenceChange }: { user: User; onLogout: () => void; themePreference: ThemePreference; resolvedTheme: Theme; onThemePreferenceChange: (theme: ThemePreference) => void }) {
  const [page, setPage] = useState<Page>('home');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [songs, setSongs] = useState<SongMetadata[]>(() => loadSongs(user));
  const [selectedId, setSelectedId] = useState<string | null>(songs[0]?.id || null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<SongDraft>();
  const [composing, setComposing] = useState(false);
  const [notification, setNotification] = useState<Notice | null>(null);
  const [events, setEvents] = useState<Event[]>(() => { try { const items = JSON.parse(localStorage.getItem('svara:activity:' + user.id) || '[]'); return Array.isArray(items) ? items.filter(item => typeof item.text === 'string' && typeof item.at === 'string').slice(0,100) : []; } catch { return []; } });
  const engine = useMemo(() => new AudioEngine(), []);
  const phoneMic = useMemo(() => new StudioPhoneMic(), []);
  const composeRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const storageWarning = useRef(false);
  const recordingBusy = useRef(false);
  const [takeCount, setTakeCount] = useState(0);
  const activeSong = songs.find(song => song.id === selectedId) || songs[0] || null;
  const createdSongs = songs.filter(song => !initialSongs.some(sample => sample.id === song.id));
  function canLeaveRecording() {
    if (!recordingBusy.current) return true;
    setNotification({ type: 'info', message: 'Finish or cancel the current recording, mix, timing, or audio export before leaving this song.' }); return false;
  }
  function navigate(value: Page) { if (!canLeaveRecording()) return; setPage(value); setMobileMenu(false); setSearch(''); window.scrollTo({ top: 0 }); }
  function selectSong(id: string) { if (canLeaveRecording()) setSelectedId(id); }
  function refreshTakeCount() { void countTakes(user.id).then(count => { if (mounted.current) setTakeCount(count); }).catch(() => {}); }
  function activity(text: string, kind: Event['kind'] = 'created') { setEvents(previous => [{ id: crypto.randomUUID(), text, kind, at: new Date().toISOString() }, ...previous].slice(0, 100)); }
  useEffect(() => {
    mounted.current = true; refreshTakeCount();
    return () => { mounted.current = false; composeRequest.current?.abort(); engine.stop(); void phoneMic.disconnect(); };
  }, []);
  useEffect(() => {
    try { localStorage.setItem('svara:songs:' + user.id, JSON.stringify(songs)); localStorage.setItem('svara:activity:' + user.id, JSON.stringify(events)); }
    catch { if (!storageWarning.current) { storageWarning.current = true; setNotification({ type: 'warning', message: 'Browser storage is full or disabled. New work will last for this session only.' }); } }
  }, [songs, events, user.id]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileMenu(false); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, []);
  function publish(song: SongMetadata, text: string) {
    setSongs(previous => [song, ...previous].slice(0, 100)); if (!recordingBusy.current) { setSelectedId(song.id); navigate('library'); } activity(text);
  }
  function localSong(input: SongDraft): SongMetadata {
    const base = generateProceduralSong(input);
    return { ...base, id: crypto.randomUUID(), title: input.title || input.description.split(/\s+/).slice(0, 7).join(' '), lyrics: input.lyrics?.length ? input.lyrics : starterLyrics(input.language), lyricsSource: input.lyrics?.length ? 'user' : 'template', audioUrl: undefined, vocalGeneration: undefined };
  }

  function shiftedKey(sourceKey: string | undefined, semitones: number) {
    if (!sourceKey) return undefined;
    const match = /^([A-G](?:#|b)?)\s+(major|minor)$/i.exec(sourceKey.trim());
    if (!match) return undefined;
    const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    const root = roots.findIndex(item => item.toLowerCase() === match[1].toLowerCase());
    return root < 0 ? undefined : `${roots[(root + semitones + 24) % 12]} ${match[2].toLowerCase()}`;
  }

  async function createKaraokeBacking({ file, options, result, lyricsText: rawLyrics, language }: KaraokeTrackPayload) {
    const duration = Number(result.analysis.durationSeconds);
    const sampleRate = Number(result.analysis.sampleRate);
    if (!Number.isFinite(duration) || !Number.isFinite(sampleRate)) throw new Error('The processed track is missing duration or sample-rate information. Create the preview again.');
    const bpm = Math.max(40, Math.min(240, Math.round(result.analysis.bpm || 100)));
    const sourceKey = options.originalKey === 'auto' ? result.analysis.detectedKey : options.originalKey;
    const targetKey = shiftedKey(sourceKey, options.semitoneShift);
    const key = targetKey || sourceKey || 'C major';
    const lyrics = rawLyrics ? parseLyrics(rawLyrics) : [];
    const baseTitle = file.name.replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 92) || 'My karaoke track';
    const title = `${baseTitle} · Karaoke`;
    const songId = crypto.randomUUID(); const backingId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const name = (result.suggestedFilename || `${baseTitle}-karaoke.wav`).slice(0, 255);
    const processing = {
      centerReduction: Math.max(0, Math.min(1, options.vocalReduction / 100)),
      bassPreservation: options.preserveBass ? .68 : 0,
      semitones: options.semitoneShift,
      ...(sourceKey ? { sourceKey } : {}),
      ...(targetKey ? { targetKey } : {}),
    };
    await saveKaraokeTrack({ id: backingId, userId: user.id, songId, name, createdAt, blob: result.wav, duration, bpm, sampleRate, processing });
    const tempo = bpm < 86 ? 'Slow' : bpm > 126 ? 'Fast' : 'Medium';
    const safeLanguage = LANGUAGES.includes(language as typeof LANGUAGES[number]) ? language : 'English';
    const scaffold = generateProceduralSong({
      ...DEFAULT_DRAFT,
      description: `Local karaoke backing created from ${baseTitle}.`,
      mood: 'Vibing',
      genre: 'Pop',
      language: safeLanguage,
      tempo,
      bpm,
      key,
      emotion: 'Focused',
      singerStyle: 'Your own voice',
      enhancedVoice: false,
      instruments: ['Drums', 'Bass', 'Synth'],
      creativity: 50,
    });
    const backingTrack: KaraokeBackingMetadata = { id: backingId, name, duration, bpm, sampleRate, processing };
    const song: SongMetadata = {
      ...scaffold,
      id: songId,
      title,
      description: `A private karaoke backing processed locally from ${file.name}.`,
      genre: 'Karaoke',
      language: safeLanguage,
      tempo,
      bpm,
      key,
      emotion: 'Focused',
      singerStyle: 'Your own voice',
      enhancedVoice: false,
      createdAt,
      lyrics,
      lyricsSource: lyrics.length ? 'user' : undefined,
      backingTrack,
      audioUrl: undefined,
      vocalGeneration: undefined,
      lyricTiming: undefined,
    };
    publish(song, `Created karaoke backing “${title}”`);
    setNotification({ type: 'success', message: `Your ${key} karaoke backing is in the library. Play the full track or record your own vocals over it.` });
    return 'Karaoke backing saved to your library.';
  }
  async function compose(input: SongDraft) {
    if (composeRequest.current) return;
    let valid: SongDraft;
    try { valid = validateDraft(input); } catch (error) { setNotification({ type: 'error', message: (error as Error).message }); return; }
    setComposing(true); setNotification(null);
    const controller = new AbortController(); composeRequest.current = controller;
    let song = localSong(valid);
    try {
      if (!valid.lyrics?.length) {
        const response = await fetch('/api/compose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
        const data = await response.json();
        if (response.status === 401) { setNotification({ type: 'error', message: 'Your session expired. Sign out and sign in again to continue.' }); return; }
        if (!response.ok) throw new Error(data.error || 'AI songwriting is unavailable.');
        if (!Array.isArray(data.lyrics) || !data.lyrics.length || !data.chordProgression?.verse?.length || !data.chordProgression?.chorus?.length) throw new Error('AI returned an incomplete song.');
        song = { ...song, title: data.title || song.title, lyrics: data.lyrics, bpm: valid.bpm || data.bpm || song.bpm, key: data.key || song.key, chordProgression: data.chordProgression, lyricsSource: 'ai' };
      }
      if (controller.signal.aborted) return;
      setNotification({ type: 'success', message: 'Your song and instrumental preview are ready. Press Play to listen.' });
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = error instanceof Error && error.name === 'Error' ? error.message : 'AI songwriting timed out or lost connection.';
      setNotification({ type: 'warning', message: reason + ' Created a local instrumental with starter lyrics. Add your own lyrics or try songwriting again when connected.' });
    } finally { if (!controller.signal.aborted) setComposing(false); composeRequest.current = null; }
    if (controller.signal.aborted || !mounted.current) return;
    publish(song, 'Created “' + song.title + '”');
  }
  function openDraft(value: SongDraft) {
    if ((value as SongMetadata).backingTrack) {
      setNotification({ type: 'info', message: 'To change this imported backing, open Karaoke Track Lab and process the source file again.' });
      navigate('karaoke'); return;
    }
    setDraft({ ...value }); navigate('create');
  }
  function createAudioInstrumental(value: SongDraft) {
    try {
      const valid = validateDraft(value); const song = localSong(valid);
      publish(song, 'Matched an instrumental to a sung audio reference');
      setNotification({ type: 'success', message: `Matched instrumental ready at ${song.bpm} BPM in ${song.key}. Press Play to compare it with your sung idea.` });
    } catch (error) { setNotification({ type: 'error', message: error instanceof Error ? error.message : 'The audio-matched instrumental could not be created.' }); }
  }
  function applyRevision(value: SongDraft, id: string) {
    const original = songs.find(song => song.id === id);
    if (!original) { setNotification({ type: 'error', message: 'The original song is no longer in this library. Open the draft in Create instead.' }); return; }
    if (original.backingTrack) { setNotification({ type: 'info', message: 'Imported karaoke audio cannot be rewritten by the assistant. Process the source again in Karaoke Track Lab to change its key or vocal reduction.' }); return; }
    try {
      const valid = validateDraft(value);
      const revision: SongMetadata = {
        ...original, ...valid, id: crypto.randomUUID(), createdAt: new Date().toISOString(),
        title: valid.title || original.title + ' (revision)',
        lyrics: valid.lyrics?.length ? valid.lyrics : original.lyrics,
        lyricsSource: valid.lyrics?.length ? 'ai' : original.lyricsSource,
        // Preserve the original harmony and melody seed; revised style/BPM still
        // alter the procedural arrangement. Old audio cannot sing new lyrics.
        audioUrl: undefined, vocalGeneration: undefined,
        lyricTiming: valid.lyrics?.length ? undefined : original.lyricTiming,
      };
      publish(revision, 'Saved a revision of “' + original.title + '”');
      setNotification({ type: 'success', message: 'Revision saved. Your original is still in the library. Play the new instrumental and record your own vocals when you are ready.' });
    } catch (error) { setNotification({ type: 'error', message: (error as Error).message }); }
  }
  async function logout() {
    if (!canLeaveRecording()) return;
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error();
      await phoneMic.disconnect();
      onLogout();
    } catch { setNotification({ type: 'error', message: 'Could not sign out. Check the connection and try again.' }); }
  }
  // Optional browser-agent interface uses the same local-song publisher as the UI fallback.
  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: unknown, options: { signal: AbortSignal }) => Promise<void> | void } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try { Promise.resolve(context.registerTool({
      name: 'create_local_instrumental_preview', title: 'Create an instrumental preview',
      description: 'Create and save a local synthesized song preview with labelled starter lyrics. Does not call a paid provider or generate singing.',
      inputSchema: { type: 'object', properties: { description: { type: 'string', minLength: 1, maxLength: 2000 }, language: { type: 'string', enum: [...LANGUAGES] } }, required: ['description', 'language'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute(input: unknown) {
        if (!input || typeof input !== 'object') throw new Error('A song description and language are required.');
        const value = input as { description: string; language: string };
        const brief = validateDraft({ ...DEFAULT_DRAFT, description: value.description, language: value.language });
        const song = localSong(resolveSongBrief(brief));
        flushSync(() => { publish(song, 'Created local preview “' + song.title + '”'); setNotification({ type: 'info', message: 'Local instrumental preview ready. These starter lyrics are not AI generated.' }); });
        return { songId: song.id, title: song.title, type: 'instrumental-preview' };
      },
    }, { signal: lifecycle.signal })).catch(() => {}); } catch { /* Optional browser capability. */ }
    return () => lifecycle.abort();
  }, []);
  const title = page === 'settings' ? 'Settings' : PAGES.find(item => item.id === page)?.label;
  const languageCount = new Set(createdSongs.map(song => song.language)).size;
  return <div className="studio-shell">
    <a className="skip-link" href="#studio-main">Skip to content</a>
    {mobileMenu && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
    <aside className={'sidebar ' + (mobileMenu ? 'open' : '')}><button className="brand-button" onClick={() => navigate('home')} aria-label="SoundProof home"><Brand /></button><span className="sidebar-label">YOUR STUDIO</span><nav aria-label="Main navigation">{PAGES.map(item => <button key={item.id} className={page === item.id ? 'nav-item active' : 'nav-item'} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={18} strokeWidth={1.8} /><span>{item.label}</span>{item.id === 'assistant' && <span className="nav-new">KAVI</span>}</button>)}</nav><div className="sidebar-bottom"><div className="sidebar-note"><AudioLines size={23} /><h4>A thought becomes a song.</h4><p>Give your next idea a place to begin.</p><button onClick={() => { setDraft({ ...DEFAULT_DRAFT }); navigate('create'); }}>Make something new <ArrowUpRight size={15} /></button></div><button className={'nav-item ' + (page === 'settings' ? 'active' : '')} onClick={() => navigate('settings')} aria-current={page === 'settings' ? 'page' : undefined}><Settings size={18} />Settings</button><div className="sidebar-user"><span className="avatar">{user.username.charAt(0).toUpperCase()}</span><span><strong>{user.username}</strong><small>Your personal studio</small></span><button className="icon-button" onClick={() => void logout()} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button></div></div></aside>
    <div className="studio-workspace"><header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Toggle navigation" aria-expanded={mobileMenu}><Menu size={21} /></button><span>Workspace</span><ChevronRight size={13} /><strong>{title}</strong></div><div className="topbar-actions"><button className="avatar avatar-small" onClick={() => navigate('settings')} aria-label="Account and appearance settings">{user.username.charAt(0).toUpperCase()}</button></div></header>
    <main id="studio-main" className="studio-main">
      {notification && <div className={'notice app-notice ' + notification.type} role={notification.type === 'error' ? 'alert' : 'status'}><span>{notification.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotification(null)}><X size={16} /></button></div>}
      {page === 'home' && <><div className="page-heading"><div><span className="eyebrow">A LITTLE SPACE FOR YOUR NEXT BIG IDEA</span><h1>Hello, {user.username.split(' ')[0]}<span className="greeting-dot">.</span></h1><p>What will you create today?</p></div><span className="date-label">{new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(new Date())}</span></div><section className="home-hero"><div><span className="eyebrow light">FROM A FEELING TO A FIRST LISTEN</span><h2>You bring the idea.<br />Let’s find its sound.</h2><p>Write in your language. Shape your lyrics.<br />Create a song that feels like you.</p><button className="button light" onClick={() => { setDraft({ ...DEFAULT_DRAFT }); navigate('create'); }}>Create your song <ArrowUpRight size={17} /></button></div><img src="/soundproof-studio.svg" alt="SoundProof waveform shield beside a vinyl record" /></section><div className="section-heading home-section"><div><h2>Start with a feeling</h2><p>A few little sparks to get you going.</p></div><span className="small-text muted">MAKE IT YOUR OWN</span></div><div className="inspiration-grid">{PROMPTS.map((item, index) => <button key={item.title} className={'inspiration-card ' + item.className} onClick={() => openDraft(resolveSongBrief({ ...DEFAULT_DRAFT, description: item.prompt, genre: item.genre, mood: item.mood }))}><span className="inspiration-top"><span className="mood-number">0{index + 1}</span><ArrowUpRight size={19} /></span><AudioLines size={36} strokeWidth={1.2} /><h3>{item.title}</h3><small>{item.style}</small></button>)}</div><div className="home-lower"><section className="panel recent-panel"><div className="section-heading"><div><h2>Pick up where you left off</h2><p>Your recent songs and starter tracks.</p></div><button className="text-button" onClick={() => navigate('library')}>View library <ArrowRight size={15} /></button></div><LibraryView songs={songs.slice(0, 3)} onSelectSong={id => { selectSong(id); navigate('library'); }} /></section><section className="home-assistant"><span className="assistant-avatar"><Sparkles size={23} /></span><span className="eyebrow">MEET KAVI, YOUR CO-WRITER</span><h3>Stuck on the<br />next line?</h3><p>Ask Kavi for a fresh idea, a better chorus, or an entirely new direction in your language.</p><button className="text-button" onClick={() => navigate('assistant')}>Talk with Kavi <ArrowRight size={16} /></button></section></div></>}
      <div hidden={page !== 'create'}><div className="page-heading"><div><span className="eyebrow">MAKE ROOM FOR YOUR SOUND</span><h1>Create something yours.</h1><p>A prompt, a few choices, and a song waiting to happen.</p></div></div><SongGeneratorForm initialDraft={draft} onGenerate={input => void compose(input)} isGenerating={composing} onAssistant={() => navigate('assistant')} /></div>
      <div hidden={page !== 'karaoke'}><div className="page-heading"><div><span className="eyebrow">BRING THE SONG INTO YOUR RANGE</span><h1>Make a karaoke track.</h1><p>Reduce a centered lead vocal, choose your key, and sing over the saved backing.</p></div><span className="badge"><Disc3 size={13} />Local audio lab</span></div><KaraokeTrackLab processTrack={processKaraokeTrack} onCreateBacking={createKaraokeBacking} /></div>
      {page === 'library' && <><div className="page-heading"><div><span className="eyebrow">EVERY IDEA HAS A HOME</span><h1>My library.</h1><p>{songs.length} songs, drafts, instrumental previews, and karaoke backings.</p></div><button className="button primary" onClick={() => { setDraft({ ...DEFAULT_DRAFT }); navigate('create'); }}><Plus size={17} />New song</button></div><div className="library-layout"><section className="panel library-panel"><div className="library-toolbar"><label className="search-field"><Search size={17} /><input aria-label="Search your library" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search songs, genres, languages…" /></label></div><LibraryView songs={songs} searchQuery={search} selectedSongId={activeSong?.id} onSelectSong={selectSong} /><p className="library-note">Includes starter tracks to explore. Your library is saved in this browser.</p></section>{activeSong && <SongPlayer key={activeSong.id} song={activeSong} userId={user.id} phoneMic={phoneMic} onRecordingBusy={value => { recordingBusy.current = value; }} onRecorded={text => { activity(text, 'vocals'); refreshTakeCount(); }} onTimingChange={timing => { setSongs(previous => previous.map(item => item.id === activeSong.id ? { ...item, lyricTiming: timing } : item)); activity((timing ? 'Saved' : 'Reset') + ' lyric timing for “' + activeSong.title + '”'); }} audioEngine={engine} onEdit={song => openDraft(song)} onReprocessBacking={() => navigate('karaoke')} />}</div></>}
      <div hidden={page !== 'assistant'}><div className="page-heading"><div><span className="eyebrow">GOOD MUSIC STARTS WITH A CONVERSATION</span><h1>Write with Kavi.</h1><p>Your multilingual songwriting partner for 31 languages and native scripts.</p></div><span className="badge"><Sparkles size={13} />Kavi assistant</span></div><ChatAssistant song={activeSong} userId={user.id} onDraft={openDraft} onApply={applyRevision} onAudioInstrumental={createAudioInstrumental} onActivity={text => activity(text, 'chat')} /></div>
      {page === 'dashboard' && <><div className="page-heading"><div><span className="eyebrow">LOOK AT WHAT YOU’RE MAKING</span><h1>Your creative rhythm.</h1><p>A simple view of your work in this studio.</p></div><button className="button primary" onClick={() => navigate('create')}><Plus size={17} />Create a song</button></div><div className="stats-grid">{[{ title: 'Songs created', value: createdSongs.length, icon: Music2 }, { title: 'Recorded takes', value: takeCount, icon: Mic2 }, { title: 'Languages explored', value: languageCount, icon: Globe2 }, { title: 'Karaoke backings', value: createdSongs.filter(song => song.backingTrack).length, icon: Disc3 }].map(item => <section className="panel stat" key={item.title}><item.icon size={20} /><strong>{item.value.toString().padStart(2, '0')}</strong><span>{item.title}</span></section>)}</div><div className="dashboard-grid"><section className="panel"><div className="section-heading"><h2>Your latest creations</h2><button className="text-button" onClick={() => navigate('library')}>View all <ArrowRight size={15} /></button></div><LibraryView songs={createdSongs.slice(0, 5)} onSelectSong={id => { selectSong(id); navigate('library'); }} /></section><section className="panel"><div className="section-heading"><h2>Recent activity</h2><button className="text-button" onClick={() => navigate('activity')}>View all</button></div><ActivityList events={events.slice(0, 5)} /></section></div><p className="small-text muted">Starter tracks are excluded from your creation counts. Your own takes and karaoke backings are saved in this browser, including takes on starter tracks. Download the recordings and mixes you want to keep.</p></>}
      {page === 'activity' && <><div className="page-heading"><div><span className="eyebrow">THE LITTLE STEPS ADD UP</span><h1>Your creative journey.</h1><p>Song drafts, assistant conversations, recordings, and karaoke updates.</p></div></div><section className="panel activity-panel"><div className="section-heading"><h2>Studio activity</h2><span className="badge neutral">{events.length} updates</span></div><ActivityList events={events} /></section></>}
      {page === 'settings' && <><div className="page-heading"><div><span className="eyebrow">SET UP YOUR SPACE</span><h1>Make yourself at home.</h1><p>Your account, phone microphone, and appearance settings.</p></div></div><div className="settings-grid"><section className="panel"><div className="section-heading"><h2>Your account</h2><span className="avatar">{user.username.charAt(0).toUpperCase()}</span></div><h3>{user.username}</h3><p className="muted">Signed in to this SoundProof installation.</p><p className="small-text muted">Your library, microphone takes, and karaoke backings stay in this browser for this account. Download backups; clearing browser data removes them.</p><button className="button secondary" onClick={() => void logout()}><LogOut size={16} />Sign out</button></section><ThemeSettings preference={themePreference} resolvedTheme={resolvedTheme} onChange={onThemePreferenceChange} /></div><PhoneMicPanel phoneMic={phoneMic} /><section className="panel settings-languages"><h2>Kavi speaks your language.</h2><p className="muted">Write prompts in native script or mixed language. Choose the lyric and reply language in Kavi.</p><div className="chips">{LANGUAGES.map(language => <span className="badge neutral" key={language}>{language}</span>)}</div><p className="small-text muted">Local previews synthesize instruments and never sing. Karaoke processing and your microphone recordings stay on this device.</p></section></>}
      <footer className="studio-footer"><span>Made of little moments. Made by you.</span><span>SOUNDPROOF / YOUR PERSONAL MUSIC STUDIO</span></footer>
    </main></div>
  </div>;
}
function ActivityList({ events }: { events: Event[] }) {
  if (!events.length) return <div className="empty-state"><Clock3 size={28} /><h3>A fresh beginning</h3><p>Your activity will appear here as you create songs and explore ideas.</p></div>;
  return <ol className="activity-list">{events.map(event => <li key={event.id}><span className={'activity-icon ' + event.kind}>{event.kind === 'error' ? <AlertCircle size={17} /> : event.kind === 'chat' ? <Sparkles size={17} /> : event.kind === 'vocals' ? <Mic2 size={17} /> : <CheckCircle2 size={17} />}</span><div><p>{event.text}</p><time dateTime={event.at}>{new Date(event.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div></li>)}</ol>;
}


