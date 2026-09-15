import { useEffect, useRef, useState } from 'react';
import { Mic2, Square, LoaderCircle, Download, Trash2, Headphones, Play, Laptop, ShieldCheck, Smartphone } from 'lucide-react';
import type { SongMetadata } from '../types';
import type { AudioEngine } from '../utils/audioEngine';
import { VocalCapture, microphoneError, recordingExtension, type RecordingPhase } from '../utils/vocalRecording';
import { listTakes, saveTake, deleteTake, MAX_TAKES_PER_SONG, type VocalTake } from '../utils/recordingStore';
import type { KaraokeBackingTrack } from '../utils/karaokeStore';
import type { LyricCue } from '../utils/lyricsTiming';
import type { PhoneMicState, StudioPhoneMic } from '../utils/phoneCompanion';
import PhoneMicPanel from './PhoneMicPanel';

const clock = (value: number) => Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0');
const NO_PHONE: PhoneMicState = { phase: 'idle', armed: false };

export default function VocalRecorder({ song, userId, engine, bpm, backingTrack, backingLoading = false, backingUnavailable = false, onPrepare, onBusy, onSelect, onSaved, onBackingBeat, disabled = false, externalTake, phoneMic }: {
  song: SongMetadata; userId: string; engine: AudioEngine; bpm: number;
  backingTrack?: KaraokeBackingTrack | null; backingLoading?: boolean; backingUnavailable?: boolean;
  onPrepare: () => void; onBusy: (busy: boolean) => void;
  onSelect: (take: VocalTake | null, activate: boolean) => void; onSaved: (message: string) => void;
  onBackingBeat: (cue: LyricCue | null) => void;
  disabled?: boolean;
  externalTake?: VocalTake | null;
  phoneMic?: StudioPhoneMic;
}) {
  const [phase, setPhase] = useState<RecordingPhase | 'idle'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [includeInstrumental, setIncludeInstrumental] = useState(true);
  const [takes, setTakes] = useState<VocalTake[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [unsaved, setUnsaved] = useState<string>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [phoneState, setPhoneState] = useState<PhoneMicState>(() => phoneMic?.getSnapshot() || NO_PHONE);
  const [usePhoneMic, setUsePhoneMic] = useState(false);
  const capture = useRef<VocalCapture | null>(null);
  const alive = useRef(true);
  const callbacks = useRef({ onBusy, onSelect, onSaved }); callbacks.current = { onBusy, onSelect, onSaved };
  const take = takes.find(item => item.id === selected);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [backingUrl, setBackingUrl] = useState('');
  const busy = phase !== 'idle';
  const phoneConnected = phoneState.phase === 'connected' && Boolean(phoneState.stream?.getAudioTracks().some(track => track.readyState === 'live'));
  useEffect(() => {
    alive.current = true;
    listTakes(userId, song.id).then(items => {
      if (!alive.current) return;
      setTakes(items); setSelected(items[0]?.id || ''); callbacks.current.onSelect(items[0] || null, false);
    }).catch(() => { if (alive.current) setError('Saved takes could not be loaded. You can still record and download a take.'); })
      .finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; capture.current?.cancel(); callbacks.current.onBusy(false); };
  }, [userId, song.id]);
  useEffect(() => {
    if (!take) { setDownloadUrl(''); return; }
    const url = URL.createObjectURL(take.blob); setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [take]);
  useEffect(() => {
    if (!backingTrack) { setBackingUrl(''); return; }
    const url = URL.createObjectURL(backingTrack.blob); setBackingUrl(url);
    return () => { engine.stop(); URL.revokeObjectURL(url); };
  }, [backingTrack?.id, backingTrack?.blob, engine]);
  useEffect(() => { if (externalTake) setTakes(previous => previous.map(item => item.id === externalTake.id ? externalTake : item)); }, [externalTake]);
  useEffect(() => {
    if (!busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const hidden = () => { if (document.hidden) capture.current?.stop(true); };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('visibilitychange', hidden); };
  }, [busy]);
  useEffect(() => {
    if (!phoneMic) { setPhoneState(NO_PHONE); return; }
    const update = () => setPhoneState(phoneMic.getSnapshot()); update();
    return phoneMic.subscribe(update);
  }, [phoneMic]);
  useEffect(() => {
    if (!phoneConnected && usePhoneMic) setUsePhoneMic(false);
    if (!phoneConnected && phoneState.armed) phoneMic?.setArmed(false);
  }, [phoneConnected, phoneState.armed, phoneMic, usePhoneMic]);
  const recordAction = useRef<() => void>(() => undefined);
  useEffect(() => phoneMic?.subscribeCommand(command => {
    if (command === 'record-start') recordAction.current();
    else capture.current?.stop();
  }), [phoneMic]);
  useEffect(() => () => { phoneMic?.setArmed(false); phoneMic?.sendStatus('idle'); }, [phoneMic]);

  async function record() {
    if (capture.current || busy || unsaved || backingLoading || backingUnavailable || (backingTrack && !backingUrl) || (usePhoneMic && !phoneConnected)) return;
    onPrepare(); setError(''); setNotice(''); setSeconds(0); setLevel(0); setPhase('permission'); onBusy(true);
    const session = new VocalCapture(engine, {
      includeInstrumental,
      getMicrophone: usePhoneMic ? phoneMic?.getMicrophoneStream : undefined,
      onState: (state, value) => { if (alive.current && capture.current === session) { setPhase(state); setSeconds(value); phoneMic?.sendStatus(state === 'permission' ? 'countdown' : state); } },
      onLevel: value => { if (alive.current && capture.current === session) setLevel(value); },
      startBacking: () => {
        if (backingUnavailable) throw new Error('The selected karaoke backing is missing from this browser.');
        if (backingTrack) {
          if (!backingUrl) throw new Error('The selected karaoke backing is still loading.');
          return engine.startImportedBacking(backingUrl, { ...song, bpm: backingTrack.bpm }, (_beat, _section, _chord, _line, _progress, cue) => onBackingBeat(cue), () => session.stop());
        }
        engine.start({ ...song, bpm }, (_beat, _section, _chord, _line, _progress, cue) => onBackingBeat(cue), () => session.stop());
      },
    });
    capture.current = session;
    try {
      const audio = await session.record();
      if (!audio || !alive.current || capture.current !== session) return;
      const newTake: VocalTake = { id: crypto.randomUUID(), userId, songId: song.id, createdAt: new Date().toISOString(), blob: audio.blob, duration: audio.duration, includesInstrumental: includeInstrumental, bpm: backingTrack?.bpm || bpm, ...(backingTrack ? { backingTrackId: backingTrack.id } : {}) };
      setPhase('saving');
      let saved = true;
      try { await saveTake(newTake); } catch (error) { saved = false; if (alive.current) { setUnsaved(newTake.id); setError(microphoneError(error)); } }
      if (!alive.current) return;
      setTakes(previous => [newTake, ...previous]); setSelected(newTake.id); onSelect(newTake, true);
      setNotice((audio.interrupted ? 'Recording was interrupted; your captured audio is ready. ' : '') + (saved ? 'Take saved in this browser. Press Play to listen.' : 'This take is only in memory. Download it before leaving.'));
      if (saved) onSaved('Recorded a vocal take for “' + song.title + '”');
    } catch (error) { if (alive.current && capture.current === session) setError(microphoneError(error)); }
    finally { if (alive.current && capture.current === session) { capture.current = null; setPhase('idle'); setLevel(0); phoneMic?.sendStatus('idle'); onBusy(false); } }
  }
  recordAction.current = () => { void record(); };
  function cancel() { capture.current?.cancel(); capture.current = null; setPhase('idle'); setLevel(0); phoneMic?.sendStatus('idle'); setNotice('Recording cancelled. Your saved takes are unchanged.'); onBusy(false); }
  async function togglePhoneArm() {
    if (!phoneMic || !phoneConnected || busy) return;
    if (!phoneState.armed) {
      setUsePhoneMic(true);
      try {
        await engine.prepare();
        if (!alive.current || capture.current || phoneMic.getSnapshot().phase !== 'connected') return;
        phoneMic.setArmed(true); setNotice('Phone controls armed. Start the take from either device.');
      }
      catch { setError('Audio could not be prepared. Press Play once, then arm phone controls again.'); }
    } else { phoneMic.setArmed(false); setNotice('Phone controls disarmed.'); }
  }
  async function remove() {
    if (!take || busy) return;
    setError('');
    try {
      if (take.id !== unsaved) await deleteTake(userId, song.id, take.id);
      const remaining = takes.filter(item => item.id !== take.id); setTakes(remaining); setSelected(remaining[0]?.id || '');
      if (take.id === unsaved) setUnsaved('');
      onSelect(remaining[0] || null, false); onSaved('Deleted a vocal take for “' + song.title + '”'); setNotice('Take deleted.');
    } catch { setError('Could not delete this take. Try again.'); }
  }
  async function retrySave() {
    const item = takes.find(item => item.id === unsaved); if (!item) return;
    setPhase('saving'); onBusy(true); setError('');
    try { await saveTake(item); setUnsaved(''); setNotice('Take saved in this browser.'); onSaved('Saved a vocal take for “' + song.title + '”'); }
    catch (error) { setError(microphoneError(error)); }
    finally { setPhase('idle'); onBusy(false); }
  }
  return <section className="vocal-recorder" aria-label="Record your vocals">
    <div className="section-heading"><h3><Mic2 size={18} />Sing it yourself</h3><span className="badge">Free · no API key</span></div>
    <p className="small-text">Your voice, your song. Record up to 60 seconds in any language{backingTrack ? ` with “${backingTrack.name}”` : ''}.</p>
    {phoneMic && <PhoneMicPanel phoneMic={phoneMic} compact />}
    <div className="phone-recorder-source">
      <div><strong><Smartphone size={16} />Recording source</strong><span className={'badge ' + (phoneConnected ? '' : 'neutral')}>{phoneConnected ? (phoneState.deviceName || 'Phone connected') : 'Phone not paired'}</span></div>
      <div className="phone-source-options" aria-label="Choose recording microphone">
        <button type="button" aria-pressed={!usePhoneMic} disabled={busy} onClick={() => { setUsePhoneMic(false); phoneMic?.setArmed(false); }}><Laptop size={15} /> This computer</button>
        <button type="button" aria-pressed={usePhoneMic} disabled={busy || !phoneConnected} onClick={() => setUsePhoneMic(true)}><Smartphone size={15} /> Phone microphone</button>
      </div>
      {usePhoneMic && phoneConnected && <button type="button" className={'button secondary small phone-arm-button ' + (phoneState.armed ? 'armed' : '')} disabled={busy} onClick={() => void togglePhoneArm()}><ShieldCheck size={15} />{phoneState.armed ? 'Phone controls armed' : 'Arm start / stop on phone'}</button>}
      <p className="muted">{phoneConnected ? 'Choose the phone for its microphone. The computer still plays the instrumental and saves the take.' : 'Create a connection above to pair an iPhone, iPad, Android phone, or tablet without leaving this recorder.'}</p>
    </div>
    <label className="checkbox-label"><input type="checkbox" checked={includeInstrumental} disabled={busy || disabled || backingLoading || backingUnavailable} onChange={e => setIncludeInstrumental(e.target.checked)} />Include the backing in my saved take</label>
    {!includeInstrumental && !backingUnavailable && <p className="small-text muted">The backing still plays in your headphones, while the saved take keeps your voice separate for mixing.</p>}
    {backingLoading && <p className="small-text" role="status"><LoaderCircle size={14} className="spin" />Loading this song’s karaoke backing…</p>}
    {backingUnavailable && <p className="notice error" role="alert">This song’s karaoke backing is missing from this browser. Restore it in Karaoke Track Lab before recording with it.</p>}
    <p className="recording-tip"><Headphones size={15} />Wear headphones to keep the backing track out of your microphone. Your mic is not played through speakers.</p>
    {busy && <div className="recording-live"><div role="status"><span className={phase === 'recording' ? 'record-dot live' : 'record-dot'} />{phase === 'permission' ? 'Allow microphone access in your browser…' : phase === 'countdown' ? 'Get ready… ' + seconds : phase === 'saving' ? 'Finishing your take…' : 'Recording · ' + clock(seconds) + ' / 1:00'}</div>{['countdown', 'recording'].includes(phase) && <><meter aria-label="Microphone input level" min={0} max={1} high={.85} value={level} /><p className="small-text">{level > .85 ? 'Too loud — move a little away from the mic.' : level < .01 ? 'Listening… sing a line to check the microphone.' : 'Your microphone is picking up sound.'}</p></>}</div>}
    {phase === 'idle' ? <button className="button primary full" disabled={disabled || loading || backingLoading || backingUnavailable || Boolean(backingTrack && !backingUrl) || Boolean(unsaved) || takes.length >= MAX_TAKES_PER_SONG} onClick={() => void record()}><Mic2 size={17} />{takes.length ? 'Record a new take' : 'Record my vocals'}</button> : phase === 'recording' ? <button className="button record-stop full" onClick={() => capture.current?.stop()}><Square size={17} fill="currentColor" />Stop & save take</button> : phase === 'saving' ? <button className="button secondary full" disabled><LoaderCircle size={17} className="spin" />Saving take…</button> : <button className="button secondary full" onClick={cancel}>Cancel</button>}
    {takes.length >= MAX_TAKES_PER_SONG && <p className="small-text">10 takes saved. Download and delete an older take to make room.</p>}
    {notice && <p className="small-text" role="status">{notice}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {!!takes.length && <div className="saved-takes"><label>My takes<select aria-label="Choose a saved vocal take" value={selected} disabled={busy} onChange={e => { setSelected(e.target.value); onSelect(takes.find(item => item.id === e.target.value) || null, true); }}>{takes.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })} · {clock(item.duration)}{item.id === unsaved ? ' · Not saved' : ''}</option>)}</select></label>
      {take && <><p className="small-text muted">{take.includesInstrumental ? 'Voice + backing · ' + take.bpm + ' BPM' : 'Voice only'}{take.backingTrackId ? ' · Imported karaoke track' : ''} · {recordingExtension(take.blob.type).toUpperCase()}</p><div className="button-row"><button className="button secondary small" disabled={busy} onClick={() => onSelect(take, true)}><Play size={14} />Use in player</button><a className={'icon-button' + (busy ? ' disabled-link' : '')} href={downloadUrl} download={song.title + '-my-take.' + recordingExtension(take.blob.type)} aria-label="Download my vocal take"><Download size={17} /></a><button className="icon-button" aria-label="Delete selected vocal take" disabled={busy} onClick={() => void remove()}><Trash2 size={16} /></button></div></>}
      {unsaved && <button className="text-button" disabled={busy} onClick={() => void retrySave()}>Try saving this take again</button>}
    </div>}
    <p className="small-text muted">Takes stay in this browser for your account. Nothing is uploaded. Download a backup before clearing browser data.</p>
  </section>;
}
