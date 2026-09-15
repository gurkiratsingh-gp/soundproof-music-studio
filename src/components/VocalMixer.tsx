import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, Play, Save, SlidersHorizontal, Square, WandSparkles } from 'lucide-react';
import type { SongMetadata } from '../types';
import type { AudioEngine } from '../utils/audioEngine';
import { updateTake, type MixSettings, type VocalTake } from '../utils/recordingStore';
import { getKaraokeTrack, type KaraokeBackingTrack } from '../utils/karaokeStore';
import type { LyricCue } from '../utils/lyricsTiming';
import { encodeWave, waveformPeaks } from '../utils/waveFile';

const defaults = (take: VocalTake): MixSettings => ({ voiceVolume: 85, instrumentalVolume: 55, syncMs: 0, tone: 0, reverb: 12, trimStart: 0, trimEnd: Math.max(.5, take.duration), ...take.mix });
export const enhancedVoicePreset = (settings: MixSettings, includesInstrumental: boolean): MixSettings => ({
  ...settings,
  voiceVolume: 100,
  instrumentalVolume: includesInstrumental ? settings.instrumentalVolume : 45,
  tone: 4,
  reverb: 10,
});
const time = (seconds: number) => Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
type Graph = { tap: ReturnType<AudioEngine['createRecordingTap']>; nodes: AudioNode[]; output: AudioNode; destination?: MediaStreamAudioDestinationNode };

export default function VocalMixer({ take, song, engine, playerVolume, onPrepare, onBeat, onTakeUpdate, onActivity, onBusy }: {
  take: VocalTake; song: SongMetadata; engine: AudioEngine; playerVolume: number;
  onPrepare: () => void; onBeat: (cue: LyricCue | null) => void;
  onTakeUpdate: (take: VocalTake) => void; onActivity: (message: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [settings, setSettings] = useState(() => defaults(take));
  const [peaks, setPeaks] = useState<number[]>([]);
  const [playing, setPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [exportUrl, setExportUrl] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [backing, setBacking] = useState<KaraokeBackingTrack | null>(null);
  const [backingUrl, setBackingUrl] = useState('');
  const [backingState, setBackingState] = useState<'none' | 'loading' | 'ready' | 'missing'>('none');
  const audio = useRef<HTMLAudioElement>(null);
  const source = useRef<MediaElementAudioSourceNode | undefined>(undefined);
  const graph = useRef<Graph | undefined>(undefined);
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const chunks = useRef<Blob[]>([]);
  const cancelExport = useRef(false);
  const finishing = useRef(false);
  const tailTimer = useRef<number | undefined>(undefined);
  const settingsRef = useRef(settings); settingsRef.current = settings;

  useEffect(() => {
    const url = URL.createObjectURL(take.blob); setSourceUrl(url); setSettings(defaults(take)); setSeconds(0); setPeaks([]); setNotice(''); setError('');
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext; const context = new AudioContextClass() as AudioContext; let cancelled = false;
    take.blob.arrayBuffer().then(data => context.decodeAudioData(data)).then(buffer => { if (!cancelled) setPeaks(waveformPeaks(buffer)); }).catch(() => {}).finally(() => void context.close());
    return () => { cancelled = true; URL.revokeObjectURL(url); };
  }, [take.id, take.blob]);
  useEffect(() => {
    let current = true;
    if (!take.backingTrackId || take.includesInstrumental) { setBacking(null); setBackingState('none'); return; }
    setBacking(null); setBackingState('loading');
    getKaraokeTrack(take.userId, take.songId, take.backingTrackId).then(track => {
      if (!current) return;
      setBacking(track || null); setBackingState(track ? 'ready' : 'missing');
    }).catch(() => { if (current) { setBacking(null); setBackingState('missing'); } });
    return () => { current = false; };
  }, [take.userId, take.songId, take.backingTrackId, take.includesInstrumental]);
  useEffect(() => {
    if (!backing) { setBackingUrl(''); return; }
    const url = URL.createObjectURL(backing.blob); setBackingUrl(url);
    return () => { engine.stop(); URL.revokeObjectURL(url); };
  }, [backing?.id, backing?.blob, engine]);
  useEffect(() => () => finish(true), []);
  useEffect(() => () => { if (exportUrl) URL.revokeObjectURL(exportUrl); }, [exportUrl]);

  function set<K extends keyof MixSettings>(key: K, value: MixSettings[K]) { setSettings(previous => ({ ...previous, [key]: value })); }
  function connectGraph(forExport: boolean): Graph {
    const tap = engine.createRecordingTap(); const context = tap.context; const element = audio.current!;
    source.current ||= context.createMediaElementSource(element);
    const voice = context.createGain(); voice.gain.value = settings.voiceVolume / 100;
    const instrumental = context.createGain(); instrumental.gain.value = take.includesInstrumental ? 0 : settings.instrumentalVolume / 100;
    const vocalSync = context.createDelay(1); vocalSync.delayTime.value = take.includesInstrumental ? 0 : Math.max(0, settings.syncMs) / 1000;
    const backingSync = context.createDelay(1); backingSync.delayTime.value = take.includesInstrumental ? 0 : Math.max(0, -settings.syncMs) / 1000;
    const tone = context.createBiquadFilter(); tone.type = 'peaking'; tone.frequency.value = 2800; tone.Q.value = .7; tone.gain.value = settings.tone;
    const dry = context.createGain(); dry.gain.value = 1;
    const delay = context.createDelay(.5); delay.delayTime.value = .13;
    const wet = context.createGain(); wet.gain.value = settings.reverb / 100 * .65;
    const feedback = context.createGain(); feedback.gain.value = Math.min(.35, settings.reverb / 250);
    const mix = context.createGain();
    const compressor = context.createDynamicsCompressor(); compressor.threshold.value = -8; compressor.knee.value = 8; compressor.ratio.value = 8; compressor.attack.value = .003; compressor.release.value = .18;
    const master = context.createGain(); master.gain.value = .82;
    source.current.connect(voice); voice.connect(tone); tone.connect(vocalSync); vocalSync.connect(dry); dry.connect(mix); vocalSync.connect(delay); delay.connect(wet); wet.connect(mix); delay.connect(feedback); feedback.connect(delay);
    tap.output.connect(instrumental); instrumental.connect(backingSync); backingSync.connect(mix); mix.connect(compressor); compressor.connect(master); master.connect(context.destination);
    const destination = forExport ? context.createMediaStreamDestination() : undefined;
    if (destination) master.connect(destination);
    return { tap, nodes: [voice, instrumental, vocalSync, backingSync, tone, dry, delay, wet, feedback, mix, compressor, master], output: master, destination };
  }
  async function start(forExport = false) {
    if (playing || !audio.current) return;
    if (!take.includesInstrumental && take.backingTrackId && (backingState !== 'ready' || !backing || !backingUrl)) {
      setError(backingState === 'loading' ? 'The imported backing is still loading.' : 'The imported backing used for this take is missing from this browser. Restore it before mixing this voice-only take.');
      return;
    }
    onPrepare(); onBusy(true); setError(''); setNotice(''); finishing.current = false; cancelExport.current = false; chunks.current = []; window.clearTimeout(tailTimer.current); tailTimer.current = undefined;
    const current = audio.current; const trimEnd = Math.min(take.duration, Math.max(settings.trimStart + .5, settings.trimEnd));
    current.currentTime = Math.min(settings.trimStart, Math.max(0, trimEnd - .1));
    try {
      graph.current = connectGraph(forExport); await graph.current.tap.context.resume(); engine.setVolume(0);
      if (forExport) {
        if (!window.MediaRecorder || !graph.current.destination) throw new Error('This browser cannot export the mix. Open the app in a current Chrome or Edge browser.');
        const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
        const active = new MediaRecorder(graph.current.destination.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 192000 }); recorder.current = active;
        active.ondataavailable = event => { if (event.data.size) chunks.current.push(event.data); };
        active.onstop = () => { void finalizeExport(active.mimeType); };
        active.start(250); setExporting(true);
      }
      let backingStart: void | Promise<void> = undefined;
      if (!take.includesInstrumental) {
        backingStart = backing && backingUrl
          ? engine.startImportedBacking(backingUrl, { ...song, bpm: backing.bpm }, (_beat, _section, _chord, _line, _progress, cue) => onBeat(cue), () => finish(false), settings.trimStart)
          : engine.start({ ...song, bpm: take.bpm }, (_beat, _section, _chord, _line, _progress, cue) => onBeat(cue), () => finish(false), settings.trimStart);
      }
      await Promise.all([current.play(), backingStart]); setPlaying(true); setSeconds(settings.trimStart);
    } catch (failure) { finish(true); setError(failure instanceof Error ? failure.message : 'The mixer could not start. Please try again.'); }
  }
  function finish(cancel = false) {
    if (finishing.current) return; finishing.current = true;
    window.clearTimeout(tailTimer.current); tailTimer.current = undefined;
    cancelExport.current ||= cancel;
    audio.current?.pause(); engine.stop(); engine.setVolume(playerVolume); onBeat(null); onBusy(false); setPlaying(false);
    const active = recorder.current; if (active && active.state !== 'inactive') active.stop();
    else if (!active) setExporting(false);
    source.current?.disconnect(); graph.current?.nodes.forEach(node => node.disconnect()); graph.current?.tap.disconnect(); graph.current?.destination?.stream.getTracks().forEach(track => track.stop()); graph.current = undefined;
  }
  function finishAfterTail() {
    if (tailTimer.current !== undefined || finishing.current) return;
    audio.current?.pause();
    const tail = 220 + (take.includesInstrumental ? 0 : Math.abs(settingsRef.current.syncMs));
    tailTimer.current = window.setTimeout(() => finish(false), tail);
  }
  async function finalizeExport(mime: string) {
    recorder.current = undefined; setExporting(false);
    if (cancelExport.current || !chunks.current.length) { setNotice(cancelExport.current ? 'Export cancelled.' : 'The export was empty. Try again.'); return; }
    try {
      setNotice('Preparing the WAV download…');
      const encoded = new Blob(chunks.current, { type: mime || 'audio/webm' });
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext; const context = new AudioContextClass() as AudioContext; const decoded = await context.decodeAudioData(await encoded.arrayBuffer()); const wave = encodeWave(decoded); await context.close();
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      const url = URL.createObjectURL(wave); setExportUrl(url); setNotice('Final WAV is ready to download.'); onActivity('Exported a final vocal mix for “' + song.title + '”');
    } catch { setError('The recording finished, but this browser could not convert it to WAV. Try Chrome or Edge.'); }
  }
  async function savePreset() {
    try { const changed = { ...take, mix: settings }; await updateTake(changed); onTakeUpdate(changed); setNotice('Mix settings saved with this take.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Mix settings could not be saved.'); }
  }
  function enhanceVoice() {
    setSettings(previous => enhancedVoicePreset(previous, take.includesInstrumental));
    setError('');
    setNotice(take.includesInstrumental
      ? 'Voice enhancement applied to this mixed recording. For separate voice control, record a voice-only take.'
      : 'Enhanced voice preset applied. Preview the mix, then save it if you like the result.');
  }
  const updateTime = () => {
    if (!audio.current) return; const current = audio.current.currentTime; setSeconds(current);
    if (current >= settingsRef.current.trimEnd - .03) finishAfterTail();
  };
  return <section className="vocal-mixer" aria-label="Vocal Studio Mixer">
    <div className="section-heading"><div><span className="eyebrow">VOCAL STUDIO</span><h3><SlidersHorizontal size={18} />Mix your take</h3></div><span className="badge">Local studio</span></div>
    <audio ref={audio} src={sourceUrl} preload="metadata" onTimeUpdate={updateTime} onEnded={finishAfterTail} />
    <div className="mix-waveform" aria-label="Recording waveform">{peaks.length ? peaks.map((peak, index) => <span key={index} style={{ height: Math.max(5, peak * 42) }} />) : <span className="waveform-loading">Reading waveform…</span>}<i style={{ left: settings.trimStart / take.duration * 100 + '%' }} /><i style={{ left: settings.trimEnd / take.duration * 100 + '%' }} /></div>
    <div className="mix-clock"><span>{time(seconds)}</span><span>{time(settings.trimStart)}–{time(settings.trimEnd)}</span></div>
    <div className="mix-controls">
      <label>{take.includesInstrumental ? 'Recording volume' : 'Voice volume'} <strong>{settings.voiceVolume}%</strong><input type="range" min="0" max="120" value={settings.voiceVolume} disabled={playing} onChange={event => set('voiceVolume', Number(event.target.value))} /></label>
      <label className={take.includesInstrumental ? 'disabled-control' : ''}>Instrumental <strong>{take.includesInstrumental ? 'Already mixed' : settings.instrumentalVolume + '%'}</strong><input type="range" min="0" max="100" value={settings.instrumentalVolume} disabled={playing || take.includesInstrumental} onChange={event => set('instrumentalVolume', Number(event.target.value))} /></label>
      <label>Vocal tone <strong>{settings.tone > 0 ? '+' + settings.tone : settings.tone} dB</strong><input type="range" min="-8" max="8" step="1" value={settings.tone} disabled={playing} onChange={event => set('tone', Number(event.target.value))} /></label>
      <label>Room effect <strong>{settings.reverb}%</strong><input type="range" min="0" max="50" value={settings.reverb} disabled={playing} onChange={event => set('reverb', Number(event.target.value))} /></label>
      <label className={take.includesInstrumental ? 'disabled-control' : ''}>Vocal timing <strong>{settings.syncMs > 0 ? '+' : ''}{settings.syncMs} ms</strong><input type="range" min="-800" max="800" step="20" value={settings.syncMs} disabled={playing || take.includesInstrumental} onChange={event => set('syncMs', Number(event.target.value))} /></label>
      <label>Trim start <strong>{time(settings.trimStart)}</strong><input type="range" min="0" max={Math.max(0, settings.trimEnd - .5)} step=".1" value={settings.trimStart} disabled={playing} onChange={event => set('trimStart', Number(event.target.value))} /></label>
      <label>Trim end <strong>{time(settings.trimEnd)}</strong><input type="range" min={Math.min(take.duration, settings.trimStart + .5)} max={take.duration} step=".1" value={settings.trimEnd} disabled={playing} onChange={event => set('trimEnd', Number(event.target.value))} /></label>
    </div>
    {take.includesInstrumental && <p className="small-text muted">This take already contains the backing track. Record a voice-only take to control voice and instrumental levels separately.</p>}
    {!take.includesInstrumental && take.backingTrackId && backingState === 'loading' && <p className="small-text" role="status"><LoaderCircle size={14} className="spin" />Loading the imported backing used for this take…</p>}
    {!take.includesInstrumental && take.backingTrackId && backingState === 'missing' && <p className="notice error" role="alert">The imported backing used for this voice-only take is missing. SoundProof will not replace it with a different instrumental.</p>}
    <div className="mix-actions"><button className="button secondary" disabled={playing} onClick={enhanceVoice}><WandSparkles size={16} />Enhance voice</button>{playing ? <button className="button record-stop" onClick={() => finish(exporting)}><Square size={16} />{exporting ? 'Cancel export' : 'Stop preview'}</button> : <><button className="button secondary" disabled={backingState === 'loading' || backingState === 'missing'} onClick={() => void start(false)}><Play size={16} />Preview mix</button><button className="button primary" disabled={backingState === 'loading' || backingState === 'missing'} onClick={() => void start(true)}><WandSparkles size={16} />Export final WAV</button></>}<button className="icon-button" disabled={playing} onClick={() => void savePreset()} aria-label="Save mix settings" title="Save mix settings"><Save size={17} /></button></div>
    {exporting && <p className="export-status" role="status"><LoaderCircle size={15} className="spin" />Creating the export in real time · {time(seconds - settings.trimStart)}</p>}
    {exportUrl && !exporting && <a className="button download-mix full" href={exportUrl} download={song.title + '-final-mix.wav'}><Download size={17} />Download final WAV</a>}
    {notice && <p className="small-text" role="status">{notice}</p>}{error && <p className="notice error" role="alert">{error}</p>}
  </section>;
}
