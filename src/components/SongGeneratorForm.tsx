import { useState, useEffect, type FormEvent } from 'react';
import { Sparkles, AudioLines, ArrowRight, SlidersHorizontal, LoaderCircle, Music2 } from 'lucide-react';
import { LANGUAGES } from '../types';
import { resolveSongBrief } from '../utils/songArrangement';
import { DEFAULT_DRAFT, GENRES, MOODS, INSTRUMENTS, parseLyrics, lyricsText, type SongDraft } from '../utils/songDraft';

export const PROMPTS = [
  { title: 'A softer kind of love', style: 'ACOUSTIC · ROMANTIC', genre: 'Acoustic', mood: 'Romantic', prompt: 'A tender acoustic love song about finding home in someone, soft soulful singing, warm guitar and piano, no drums, 72 BPM', className: 'sage' },
  { title: 'After-hours energy', style: 'ELECTRONIC · PARTY', genre: 'Electronic', mood: 'Party', prompt: 'An uplifting electronic dance song about the last night of college, bright synths, bass and drums, powerful singing, 130 BPM', className: 'sand' },
  { title: 'Rain on the window', style: 'LO-FI · RELAX', genre: 'LoFi', mood: 'Relax', prompt: 'A dreamy lo-fi song about watching rain from a quiet cafe, gentle piano, laid-back drums and soft singing, 78 BPM', className: 'rose' },
  { title: 'Just vibing', style: 'ELECTRONIC VIBE · VIBING', genre: 'Electronic Vibe', mood: 'Vibing', prompt: 'A polished electronic vibe for a late-night drive, glowing synth layers, smooth deep bass, crisp drums and a strong singable lead melody, 112 BPM', className: 'aqua' },
];
const KEYS = ['C major', 'C# major', 'D major', 'Eb major', 'E major', 'F major', 'F# major', 'G major', 'Ab major', 'A major', 'Bb major', 'B major', 'C minor', 'C# minor', 'D minor', 'Eb minor', 'E minor', 'F minor', 'F# minor', 'G minor', 'Ab minor', 'A minor', 'Bb minor', 'B minor'];
const GENRE_INSTRUMENTS: Record<string, string[]> = {
  Pop: ['Piano', 'Drums', 'Bass', 'Synth'], Rock: ['Electric Guitar', 'Drums', 'Bass'], 'Hip Hop': ['Drums', 'Bass', 'Synth'],
  Jazz: ['Piano', 'Bass', 'Drums', 'Saxophone'], Classical: ['Piano', 'Strings', 'Violin'], LoFi: ['Piano', 'Bass', 'Drums'],
  Electronic: ['Synth', 'Drums', 'Bass'], 'Electronic Vibe': ['Synth', 'Drums', 'Bass'], Acoustic: ['Acoustic Guitar', 'Piano'], Ambient: ['Strings', 'Flute', 'Synth'],
};
export default function SongGeneratorForm({ onGenerate, isGenerating, initialDraft, onAssistant }: {
  onGenerate: (draft: SongDraft) => void; isGenerating: boolean;
  initialDraft?: SongDraft; onAssistant: () => void;
}) {
  const [draft, setDraft] = useState<SongDraft>({ ...DEFAULT_DRAFT });
  const [customLyrics, setCustomLyrics] = useState('');
  const [followPrompt, setFollowPrompt] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { if (initialDraft) { setDraft({ ...DEFAULT_DRAFT, ...initialDraft }); setCustomLyrics(initialDraft.lyrics ? lyricsText(initialDraft.lyrics) : ''); setFollowPrompt(!initialDraft.description.trim()); setError(''); } }, [initialDraft]);
  const brief = resolveSongBrief(draft, followPrompt);
  const update = (key: keyof SongDraft, value: unknown) => setDraft(previous => ({ ...previous, [key]: value }));
  function generate() {
    if (isGenerating) return;
    if (!draft.description.trim()) { setError('Tell us a little about the song you want to make.'); document.getElementById('song-prompt')?.focus(); return; }
    setError('');
    onGenerate({ ...draft, ...brief, lyrics: customLyrics.trim() ? parseLyrics(customLyrics) : undefined });
  }
  function submit(event: FormEvent) { event.preventDefault(); generate(); }
  return <div className="create-layout"><form className="panel composer" onSubmit={submit} aria-busy={isGenerating}>
    <div className="section-heading"><div><span className="eyebrow">THE START OF SOMETHING GOOD</span><h2>What does your idea sound like?</h2></div><span className="square-icon"><Music2 size={21} /></span></div>
    <label htmlFor="song-prompt">Your song prompt<textarea id="song-prompt" dir="auto" rows={5} maxLength={2000} value={draft.description} onChange={e => update('description', e.target.value)} placeholder="A Punjabi acoustic love song about a rainy evening, gentle guitar, warm vocals, 75 BPM…" /></label>
    <div className="field-hint"><span>Start with a story, a feeling, or a few words.</span><span>{draft.description.length}/2000</span></div>
    <div className="form-grid basics-grid">
      <label>Language<select value={draft.language} onChange={e => { update('language', e.target.value); setFollowPrompt(false); }}>{LANGUAGES.map(item => <option key={item}>{item}</option>)}</select></label>
      <label>Vocal style<select value={draft.singerStyle} onChange={e => update('singerStyle', e.target.value)}>{['Modern Pop', 'Soulful', 'Acoustic', 'Energetic', 'Soft', 'Cinematic', ...(!['Modern Pop', 'Soulful', 'Acoustic', 'Energetic', 'Soft', 'Cinematic'].includes(draft.singerStyle) ? [draft.singerStyle] : [])].map(item => <option key={item}>{item}</option>)}</select></label>
    </div>
    <fieldset className="sound-direction">
      <legend>Shape the music</legend>
      <p>Choose the musical world and the feeling separately. Both choices change the arrangement.</p>
      <div className="sound-direction-grid">
        <label className="sound-choice"><span>Genre</span><select aria-describedby="genre-help" value={draft.genre} onChange={e => { const genre = e.target.value; setDraft(previous => ({ ...previous, genre, instruments: [...(GENRE_INSTRUMENTS[genre] || previous.instruments)] })); setFollowPrompt(false); }}>{GENRES.map(item => <option key={item}>{item}</option>)}</select><small id="genre-help">Sets the rhythm, instruments, and overall production style.</small></label>
        <label className="sound-choice"><span>Mood</span><select aria-describedby="mood-help" value={draft.mood} onChange={e => { update('mood', e.target.value); setFollowPrompt(false); }}>{MOODS.map(item => <option key={item}>{item}</option>)}</select><small id="mood-help">Shapes the energy, tempo, harmony, and melodic movement.</small></label>
      </div>
    </fieldset>
    <details className="advanced"><summary><SlidersHorizontal size={16} /> Fine-tune your sound<span>Optional</span></summary><div className="advanced-body">
      <div className="form-grid"><label>Tempo<input type="number" min={40} max={240} placeholder="Automatic BPM" value={draft.bpm ?? ''} onChange={e => { update('bpm', e.target.value ? Number(e.target.value) : undefined); setFollowPrompt(false); }} /></label><label>Key<select value={draft.key || ''} onChange={e => { update('key', e.target.value || undefined); setFollowPrompt(false); }}><option value="">Automatic key</option>{KEYS.map(item => <option key={item}>{item}</option>)}</select></label><label>Emotion<select value={draft.emotion} onChange={e => update('emotion', e.target.value)}>{Array.from(new Set(['Warm', 'Melancholic', 'Euphoric', 'Nostalgic', 'Fierce', 'Tender', 'Dreamy', draft.emotion])).map(item => <option key={item}>{item}</option>)}</select></label></div>
      <fieldset><legend>Instruments</legend><div className="chips">{INSTRUMENTS.map(item => <button key={item} type="button" className={'chip ' + (draft.instruments.includes(item) ? 'selected' : '')} aria-pressed={draft.instruments.includes(item)} onClick={() => { update('instruments', draft.instruments.includes(item) ? draft.instruments.filter(i => i !== item) : [...draft.instruments, item]); setFollowPrompt(false); }}>{item}</button>)}</div></fieldset>
      <label>Creative freedom <span className="muted">{draft.creativity}%</span><input type="range" min={0} max={100} value={draft.creativity} onChange={e => update('creativity', Number(e.target.value))} /></label>
    </div></details>
    <details className="advanced" open={Boolean(initialDraft?.lyrics?.length)}><summary><Music2 size={16} /> Your lyrics<span>Optional</span></summary><div className="advanced-body"><label htmlFor="custom-lyrics">Write your own, or ask the assistant<textarea id="custom-lyrics" dir="auto" rows={8} maxLength={3500} value={customLyrics} onChange={e => setCustomLyrics(e.target.value)} placeholder={'[Verse]\nYour words here…\n\n[Chorus]\nYour chorus here…'} /></label><p className="small-text muted">Use [Verse] and [Chorus] labels. Leave blank for AI-written lyrics. Supplied lyrics are kept as written.</p></div></details>
    <label className="checkbox-label"><input type="checkbox" checked={followPrompt} onChange={e => setFollowPrompt(e.target.checked)} /> Match musical cues in my prompt</label>
    <div className="resolved-brief"><AudioLines size={16} /><span>{brief.genre} · {brief.mood} · {brief.language} · {brief.bpm ? brief.bpm + ' BPM' : brief.tempo + ' tempo'}{brief.key ? ` · ${brief.key}` : ''}<small>{brief.instruments.join(', ') || 'Minimal arrangement'}</small></span></div>
    {error && <p role="alert" className="notice error">{error}</p>}
    <div className="compose-actions"><button className="button primary" type="submit" disabled={isGenerating}>{isGenerating ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}{isGenerating ? 'Building your song…' : 'Create song & instrumental'}</button></div>
    <p className="small-text muted">Creates lyrics and a local synthesized backing. You can practise with the lyric guide, then record your own vocals in the player.</p>
  </form><aside className="create-aside"><div className="assistant-invite"><span className="square-icon"><Sparkles size={22} /></span><h3>Kavi writes with you,<br />whenever you need it.</h3><p>Find an idea, write a chorus, or give a song a different feeling in your language and script.</p><button className="text-button" onClick={onAssistant}>Meet Kavi <ArrowRight size={16} /></button></div><div className="panel inspiration-list"><span className="eyebrow">NEED A LITTLE SPARK?</span>{PROMPTS.map(item => <button key={item.title} onClick={() => { setDraft(resolveSongBrief({ ...DEFAULT_DRAFT, description: item.prompt, genre: item.genre, mood: item.mood, language: draft.language })); setCustomLyrics(''); setFollowPrompt(false); }}><span>{item.title}<small>{item.style}</small></span><ArrowUpRightIcon /></button>)}</div><p className="aside-note">Good prompts mention a mood, a language, and the sounds you love. A small detail can make a big difference.</p></aside></div>;
}
function ArrowUpRightIcon() { return <ArrowRight size={16} className="diagonal-arrow" />; }


