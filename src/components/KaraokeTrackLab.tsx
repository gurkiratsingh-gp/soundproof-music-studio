import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileAudio2,
  FileText,
  Gauge,
  Headphones,
  LoaderCircle,
  Music2,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  UploadCloud,
  X,
} from 'lucide-react';
import { LANGUAGES } from '../types';

export const KARAOKE_TRACK_MAX_BYTES = 25 * 1024 * 1024;
export const KARAOKE_TRACK_ACCEPT = '.mp3,.wav,.m4a,.aac,.ogg,.webm,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac,audio/ogg,audio/webm';

const KEYS = [
  'C major', 'C# major', 'D major', 'Eb major', 'E major', 'F major', 'F# major', 'G major', 'Ab major', 'A major', 'Bb major', 'B major',
  'C minor', 'C# minor', 'D minor', 'Eb minor', 'E minor', 'F minor', 'F# minor', 'G minor', 'Ab minor', 'A minor', 'Bb minor', 'B minor',
] as const;
const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
const EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'webm']);
const AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/webm']);
export const KARAOKE_TRACK_LANGUAGES = LANGUAGES;

export type KaraokeTrackStage = 'analyzing' | 'separating' | 'pitching' | 'rendering';

export type KaraokeTrackOptions = {
  /** `auto` asks the local processor to detect the source key. */
  originalKey: 'auto' | string;
  /** Pitch movement applied to the instrumental output, from -6 to +6 semitones. */
  semitoneShift: number;
  /** Vocal-reduction amount from 0 to 100. */
  vocalReduction: number;
  preserveBass: boolean;
};

export type KaraokeTrackProgress = {
  stage: KaraokeTrackStage;
  percent: number;
  message?: string;
};

export type KaraokeTrackAnalysis = {
  detectedKey?: string;
  keyConfidence?: number;
  bpm?: number;
  durationSeconds?: number;
  sampleRate?: number;
  channels?: number;
  qualityNote?: string;
};

export type KaraokeTrackResult = {
  /** A browser-playable PCM WAV containing the reduced-vocal backing. */
  wav: Blob;
  analysis: KaraokeTrackAnalysis;
  suggestedFilename?: string;
};

export type KaraokeTrackProcessRequest = {
  file: File;
  options: KaraokeTrackOptions;
  signal: AbortSignal;
  onProgress: (progress: KaraokeTrackProgress) => void;
};

export type KaraokeTrackPayload = {
  file: File;
  options: KaraokeTrackOptions;
  result: KaraokeTrackResult;
  /** User-supplied text only. Section labels such as [Verse] remain unchanged for the existing lyric parser. */
  lyricsText: string;
  language: string;
};

export type KaraokeTrackLabProps = {
  /** Must process entirely on-device. The component never uploads or reads the file itself. */
  processTrack: (request: KaraokeTrackProcessRequest) => Promise<KaraokeTrackResult>;
  onSave?: (payload: KaraokeTrackPayload) => void | string | Promise<void | string>;
  onCreateBacking?: (payload: KaraokeTrackPayload) => void | string | Promise<void | string>;
  onBusyChange?: (busy: boolean) => void;
  maxFileBytes?: number;
  disabled?: boolean;
  className?: string;
};

type Phase = 'idle' | KaraokeTrackStage | 'ready' | 'failed';
type Action = 'save' | 'backing' | null;

const STAGE_LABELS: Record<KaraokeTrackStage, string> = {
  analyzing: 'Analyzing your track',
  separating: 'Reducing the lead vocal',
  pitching: 'Moving the track into your key',
  rendering: 'Preparing the WAV preview',
};

function normalizedKey(value?: string) {
  if (!value) return '';
  const match = /^([A-G](?:#|b)?)\s+(major|minor)$/i.exec(value.trim());
  if (!match) return '';
  const root = ROOTS.find(item => item.toLowerCase() === match[1].toLowerCase());
  return root ? `${root} ${match[2].toLowerCase()}` : '';
}

function transposeKey(key: string, semitones: number) {
  const match = /^([A-G](?:#|b)?)\s+(major|minor)$/i.exec(key);
  if (!match) return '';
  const root = ROOTS.findIndex(item => item.toLowerCase() === match[1].toLowerCase());
  if (root < 0) return '';
  return `${ROOTS[(root + semitones + 24) % 12]} ${match[2].toLowerCase()}`;
}

function shiftBetween(from: string, to: string) {
  const source = /^([A-G](?:#|b)?)\s+(major|minor)$/i.exec(from);
  const target = /^([A-G](?:#|b)?)\s+(major|minor)$/i.exec(to);
  if (!source || !target || source[2].toLowerCase() !== target[2].toLowerCase()) return 0;
  const fromIndex = ROOTS.findIndex(item => item.toLowerCase() === source[1].toLowerCase());
  const toIndex = ROOTS.findIndex(item => item.toLowerCase() === target[1].toLowerCase());
  let distance = (toIndex - fromIndex + 12) % 12;
  if (distance > 6) distance -= 12;
  return distance;
}

function fileError(file: File, maxFileBytes: number) {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  if (!EXTENSIONS.has(extension) && !AUDIO_MIME_TYPES.has(file.type.toLowerCase())) return 'Choose an MP3, WAV, M4A, AAC, Ogg, or WebM audio file.';
  if (!file.size) return 'This audio file is empty. Choose another file.';
  if (file.size > maxFileBytes) return `This file is larger than ${Math.round(maxFileBytes / 1024 / 1024)} MB. Choose a smaller track.`;
  return '';
}

function clock(seconds?: number) {
  if (!Number.isFinite(seconds)) return 'Not available';
  const value = Math.max(0, seconds || 0);
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
}

function bytes(value: number) {
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
}

function safeFilename(file: File, suggestion?: string) {
  const candidate = (suggestion || file.name.replace(/\.[^.]+$/, '') + '-karaoke').replace(/\.wav$/i, '');
  const clean = candidate.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 100) || 'karaoke-backing';
  return `${clean}.wav`;
}

function friendlyError(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  const message = error instanceof Error ? error.message.trim() : '';
  return message && message.length <= 240 ? message : 'The track could not be processed in this browser. Try a shorter WAV or MP3 file.';
}

export default function KaraokeTrackLab({
  processTrack,
  onSave,
  onCreateBacking,
  onBusyChange,
  maxFileBytes = KARAOKE_TRACK_MAX_BYTES,
  disabled = false,
  className = '',
}: KaraokeTrackLabProps) {
  const fileInputId = useId();
  const strengthHelpId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [result, setResult] = useState<KaraokeTrackResult | null>(null);
  const [resultUrl, setResultUrl] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<KaraokeTrackProgress>({ stage: 'analyzing', percent: 0 });
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [lyricsText, setLyricsText] = useState('');
  const [language, setLanguage] = useState<string>('English');
  const [renderedSignature, setRenderedSignature] = useState('');
  const [options, setOptions] = useState<KaraokeTrackOptions>({ originalKey: 'auto', semitoneShift: 0, vocalReduction: 85, preserveBass: true });
  const controller = useRef<AbortController | null>(null);
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  const job = useRef(0);
  const busy = ['analyzing', 'separating', 'pitching', 'rendering'].includes(phase) || action !== null;
  const signature = `${options.originalKey}|${options.semitoneShift}|${options.vocalReduction}|${options.preserveBass}`;
  const stale = Boolean(result && signature !== renderedSignature);
  const effectiveOriginalKey = options.originalKey === 'auto' ? normalizedKey(result?.analysis.detectedKey) : normalizedKey(options.originalKey);
  const targetKey = useMemo(() => effectiveOriginalKey ? transposeKey(effectiveOriginalKey, options.semitoneShift) : '', [effectiveOriginalKey, options.semitoneShift]);
  const targetKeys = useMemo(() => effectiveOriginalKey.endsWith(' minor') ? KEYS.filter(key => key.endsWith(' minor')) : KEYS.filter(key => key.endsWith(' major')), [effectiveOriginalKey]);

  useEffect(() => {
    if (!file) { setSourceUrl(''); return; }
    const url = URL.createObjectURL(file); setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    if (!result?.wav) { setResultUrl(''); return; }
    const url = URL.createObjectURL(result.wav); setResultUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result]);
  useEffect(() => { busyCallback.current?.(busy); }, [busy]);
  useEffect(() => () => { job.current++; controller.current?.abort(); busyCallback.current?.(false); }, []);

  function resetOutput() {
    job.current++;
    controller.current?.abort(); controller.current = null;
    setResult(null); setRenderedSignature(''); setProgress({ stage: 'analyzing', percent: 0 }); setAction(null);
  }

  function chooseFile(next: File | null) {
    if (!next) return;
    const validation = fileError(next, maxFileBytes);
    resetOutput(); setNotice(''); setActionError('');
    setLyricsText(''); setLanguage('English');
    if (validation) { setFile(null); setError(validation); setPhase('failed'); return; }
    setFile(next); setError(''); setPhase('idle');
    setOptions(previous => ({ ...previous, originalKey: 'auto', semitoneShift: 0 }));
  }

  function changeFile(event: ChangeEvent<HTMLInputElement>) {
    chooseFile(event.target.files?.[0] || null);
    event.target.value = '';
  }

  function dropFile(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault(); setDragging(false);
    if (!disabled && !busy) chooseFile(event.dataTransfer.files?.[0] || null);
  }

  function clearFile() {
    resetOutput(); setFile(null); setError(''); setActionError(''); setNotice(''); setPhase('idle'); setLyricsText(''); setLanguage('English');
    setOptions(previous => ({ ...previous, originalKey: 'auto', semitoneShift: 0 }));
  }

  function updateOption<K extends keyof KaraokeTrackOptions>(key: K, value: KaraokeTrackOptions[K]) {
    setOptions(previous => ({ ...previous, [key]: value }));
    setNotice(''); setActionError('');
  }

  async function process() {
    if (!file || busy || disabled) return;
    const activeJob = ++job.current;
    const activeController = new AbortController(); controller.current?.abort(); controller.current = activeController;
    const processingOptions = { ...options };
    const processingSignature = signature;
    setResult(null); setRenderedSignature(''); setError(''); setActionError(''); setNotice('');
    setProgress({ stage: 'analyzing', percent: 3, message: 'Reading tempo, key, and channel information locally.' }); setPhase('analyzing');
    try {
      const output = await processTrack({
        file,
        options: processingOptions,
        signal: activeController.signal,
        onProgress(update) {
          if (activeController.signal.aborted || activeJob !== job.current) return;
          const stage = update.stage in STAGE_LABELS ? update.stage : 'separating';
          setProgress({ stage, percent: Math.max(0, Math.min(100, Number(update.percent) || 0)), message: update.message?.slice(0, 180) });
          setPhase(stage);
        },
      });
      if (activeController.signal.aborted || activeJob !== job.current) return;
      if (!(output?.wav instanceof Blob) || !output.wav.size) throw new Error('The processor finished without a playable WAV. Try the track again.');
      setResult(output); setRenderedSignature(processingSignature); setProgress({ stage: 'rendering', percent: 100 }); setPhase('ready');
      setNotice('Karaoke preview ready. Compare it with the original before saving or downloading.');
    } catch (failure) {
      if (activeController.signal.aborted || activeJob !== job.current) return;
      const message = friendlyError(failure);
      if (!message) { setPhase('idle'); setProgress({ stage: 'analyzing', percent: 0 }); return; }
      setError(message); setPhase('failed');
    } finally {
      if (activeJob === job.current) controller.current = null;
    }
  }

  function cancel() {
    job.current++; controller.current?.abort(); controller.current = null;
    setPhase('idle'); setProgress({ stage: 'analyzing', percent: 0 }); setNotice('Processing cancelled. Your original file is still selected.');
  }

  async function runAction(kind: Exclude<Action, null>, callback: NonNullable<KaraokeTrackLabProps['onSave']>) {
    if (!file || !result || stale || busy) return;
    setAction(kind); setActionError(''); setNotice('');
    try {
      const message = await callback({ file, options: { ...options }, result, lyricsText: lyricsText.trim(), language });
      setNotice(typeof message === 'string' && message.trim() ? message : kind === 'save' ? 'Karaoke backing saved.' : 'Backing is ready to use in your song.');
    } catch (failure) {
      setActionError(friendlyError(failure) || (kind === 'save' ? 'The backing could not be saved.' : 'A song could not be created from this backing.'));
    } finally { setAction(null); }
  }

  const confidence = result?.analysis.keyConfidence;
  const confidenceLabel = Number.isFinite(confidence) ? `${Math.round(Math.max(0, Math.min(1, confidence!)) * 100)}% confidence` : 'Estimate';
  const processLabel = result ? stale ? 'Update karaoke preview' : 'Create preview again' : phase === 'failed' ? 'Try this track again' : 'Create karaoke preview';

  return <section className={`karaoke-track-lab panel ${className}`.trim()} aria-labelledby={`${fileInputId}-title`}>
    <header className="track-lab-heading">
      <span className="track-lab-mark"><Headphones size={23} /></span>
      <div><span className="eyebrow">KARAOKE TRACK LAB</span><h2 id={`${fileInputId}-title`}>Turn a song into your practice backing.</h2><p>Reduce the lead vocal, move the key, preview the result, and keep a WAV copy.</p></div>
      <span className="badge"><ShieldCheck size={13} />On-device</span>
    </header>

    <div className="track-lab-layout">
      <div className="track-lab-workspace">
        <input className="track-lab-file-input" id={fileInputId} type="file" accept={KARAOKE_TRACK_ACCEPT} disabled={disabled || busy} onChange={changeFile} />
        {!file ? <label htmlFor={fileInputId} className={`track-lab-dropzone${dragging ? ' dragging' : ''}${disabled ? ' disabled' : ''}`} onDragEnter={event => { event.preventDefault(); if (!disabled) setDragging(true); }} onDragOver={event => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={dropFile}>
          <UploadCloud size={31} /><strong>Choose a song or drop it here</strong><span>MP3, WAV, M4A, AAC, Ogg, or WebM · up to {Math.round(maxFileBytes / 1024 / 1024)} MB</span><span className="button secondary small">Browse audio</span>
        </label> : <section className="track-lab-source" aria-label="Selected source track">
          <div className="track-lab-file"><span><FileAudio2 size={20} /></span><div><strong>{file.name}</strong><small>{bytes(file.size)} · original audio</small></div><button type="button" className="icon-button" disabled={busy} onClick={clearFile} aria-label="Remove selected audio"><X size={17} /></button></div>
          {sourceUrl && <div className="track-preview"><span><strong>Original</strong><small>Use this to compare vocal reduction and pitch.</small></span><audio aria-label="Original song preview" controls src={sourceUrl} preload="metadata" /></div>}
        </section>}

        {busy && action === null && <div className="track-lab-progress" role="status" aria-live="polite"><LoaderCircle className="spin" size={20} /><div><strong>{STAGE_LABELS[progress.stage]}</strong><span>{progress.message || 'This may take a moment on longer songs.'}</span><progress aria-label="Karaoke track processing progress" max={100} value={progress.percent} /></div><output>{Math.round(progress.percent)}%</output><button type="button" className="text-button" onClick={cancel}>Cancel</button></div>}
        {phase === 'failed' && error && <div className="notice error track-lab-failure" role="alert"><AlertTriangle size={18} /><div><strong>We couldn’t make this backing.</strong><p>{error}</p></div>{file && <button type="button" className="text-button" onClick={() => void process()}>Try again</button>}</div>}
        {stale && <div className="notice warning" role="status">Your settings changed. Update the preview before saving or downloading this version.</div>}

        <details className="track-lab-lyrics">
          <summary><FileText size={17} /><span><strong>Add lyrics for the singing guide</strong><small>Optional · use your own or licensed words</small></span></summary>
          <div className="track-lab-lyrics-fields">
            <label>Song language<select value={language} disabled={busy || disabled} onChange={event => setLanguage(event.target.value)}>{KARAOKE_TRACK_LANGUAGES.map(item => <option key={item}>{item}</option>)}</select></label>
            <label htmlFor={`${fileInputId}-lyrics`}>Lyrics<textarea id={`${fileInputId}-lyrics`} dir="auto" rows={7} maxLength={3500} value={lyricsText} disabled={busy || disabled} onChange={event => setLyricsText(event.target.value)} placeholder={'[Verse]\nWrite or paste lyrics you have permission to use…\n\n[Chorus]\nAdd the chorus here…'} /></label>
            <div className="track-lyrics-help"><span>Keep labels such as [Verse] and [Chorus] on their own lines.</span><span>{lyricsText.length}/3500</span></div>
            <p>SoundProof does not fetch or extract lyrics from the uploaded recording. Add only lyrics you wrote or have permission to use.</p>
          </div>
        </details>

        {result && resultUrl && file && <section className={`track-lab-result${stale ? ' stale' : ''}`} aria-label="Processed karaoke backing">
          <div className="track-result-title"><span><CheckCircle2 size={20} /></span><div><strong>Karaoke backing</strong><small>{stale ? 'Preview uses your previous settings' : 'Ready to practice, save, or download'}</small></div></div>
          <div className="track-analysis" aria-label="Track analysis">
            <span><small>DETECTED KEY</small><strong>{normalizedKey(result.analysis.detectedKey) || 'Not clear'}</strong><em>{confidenceLabel}</em></span>
            <span><small>TARGET KEY</small><strong>{targetKey || 'Original pitch'}</strong><em>{options.semitoneShift > 0 ? `+${options.semitoneShift}` : options.semitoneShift} semitones</em></span>
            <span><small>LENGTH</small><strong>{clock(result.analysis.durationSeconds)}</strong><em>{result.analysis.sampleRate ? `${Math.round(result.analysis.sampleRate / 100) / 10} kHz` : 'WAV output'}</em></span><span><small>TEMPO GUIDE</small><strong>{result.analysis.bpm ? `${Math.round(result.analysis.bpm)} BPM` : 'Not clear'}</strong><em>Local estimate</em></span>
          </div>
          <div className="track-preview processed"><span><strong>Reduced-vocal preview</strong><small>Some backing vocals or reverb may remain.</small></span><audio aria-label="Karaoke backing preview" controls src={resultUrl} preload="metadata" /></div>
          {result.analysis.qualityNote && <p className="track-quality-note"><Gauge size={15} />{result.analysis.qualityNote}</p>}
          <div className="track-result-actions">
            {onSave && <button type="button" className="button secondary" disabled={stale || busy} onClick={() => void runAction('save', onSave)}>{action === 'save' ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}{action === 'save' ? 'Saving…' : 'Save karaoke backing'}</button>}
            {onCreateBacking && <button type="button" className="button primary" disabled={stale || busy} onClick={() => void runAction('backing', onCreateBacking)}>{action === 'backing' ? <LoaderCircle className="spin" size={17} /> : <Music2 size={17} />}{action === 'backing' ? 'Creating…' : 'Create song with backing'}</button>}
            {!stale && <a className="button track-download" href={resultUrl} download={safeFilename(file, result.suggestedFilename)}><Download size={17} />Download WAV</a>}
          </div>
        </section>}

        {notice && <p className="notice success track-lab-notice" role="status">{notice}</p>}
        {actionError && <p className="notice error" role="alert">{actionError}</p>}
      </div>

      <aside className="track-lab-controls" aria-label="Karaoke processing settings">
        <div className="track-control-heading"><SlidersHorizontal size={18} /><div><strong>Shape the backing</strong><small>Adjust before creating the preview.</small></div></div>
        <label>Original key<select value={options.originalKey} disabled={busy || disabled} onChange={event => updateOption('originalKey', event.target.value)}><option value="auto">Detect automatically</option>{KEYS.map(key => <option key={key}>{key}</option>)}</select><small>{options.originalKey === 'auto' ? result?.analysis.detectedKey ? `Detected ${normalizedKey(result.analysis.detectedKey) || result.analysis.detectedKey}` : 'We will estimate this during analysis.' : 'Choose this if you already know the song key.'}</small></label>
        <label>Target key<select value={targetKey} disabled={!effectiveOriginalKey || busy || disabled} onChange={event => updateOption('semitoneShift', shiftBetween(effectiveOriginalKey, event.target.value))}>{!effectiveOriginalKey && <option value="">Analyze or choose the original key first</option>}{targetKeys.map(key => <option key={key}>{key}</option>)}</select><small>The major/minor feel stays the same.</small></label>
        <label className="track-range">Pitch shift <output>{options.semitoneShift > 0 ? '+' : ''}{options.semitoneShift} semitones</output><span><button type="button" className="icon-button" disabled={busy || disabled || options.semitoneShift <= -6} onClick={() => updateOption('semitoneShift', Math.max(-6, options.semitoneShift - 1))} aria-label="Lower target by one semitone">−</button><input aria-label="Pitch shift in semitones" type="range" min={-6} max={6} step={1} value={options.semitoneShift} disabled={busy || disabled} onChange={event => updateOption('semitoneShift', Number(event.target.value))} /><button type="button" className="icon-button" disabled={busy || disabled || options.semitoneShift >= 6} onClick={() => updateOption('semitoneShift', Math.min(6, options.semitoneShift + 1))} aria-label="Raise target by one semitone">+</button></span></label>
        <label className="track-range">Vocal reduction <output>{options.vocalReduction}%</output><input aria-describedby={strengthHelpId} type="range" min={20} max={100} step={5} value={options.vocalReduction} disabled={busy || disabled} onChange={event => updateOption('vocalReduction', Number(event.target.value))} /><small id={strengthHelpId}>Higher settings remove more center vocal, but can also soften lead instruments.</small></label>
        <label className="track-bass-toggle"><input type="checkbox" checked={options.preserveBass} disabled={busy || disabled} onChange={event => updateOption('preserveBass', event.target.checked)} /><span><strong>Preserve bass and kick</strong><small>Protect low frequencies while reducing centered vocals.</small></span></label>
        <button type="button" className="button primary full" disabled={!file || busy || disabled} onClick={() => void process()}>{busy && action === null ? <LoaderCircle className="spin" size={17} /> : result ? <RotateCcw size={17} /> : <Headphones size={17} />}{busy && action === null ? 'Processing locally…' : processLabel}</button>
        <p className="track-quality"><strong>For the cleanest result</strong>Stereo studio tracks with centered lead vocals work best. Mono audio, live recordings, heavy reverb, and layered harmonies can leave audible vocal traces.</p>
      </aside>
    </div>

    <footer className="track-lab-footer">
      <p><ShieldCheck size={16} /><span><strong>Private by design</strong>SoundProof processes this track on your device. Your song stays in this browser and is not sent to a server.</span></p>
      <p><AlertTriangle size={16} /><span><strong>Respect music rights</strong>Use tracks you created or have permission to transform. This practice tool does not grant rights to distribute the source or backing.</span></p>
    </footer>
  </section>;
}
