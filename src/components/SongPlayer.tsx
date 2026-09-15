import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Square, Volume2, Download, LoaderCircle, Copy, Check, AudioLines, Sparkles, TimerReset, MousePointer2, Headphones } from 'lucide-react';
import type { SongMetadata } from '../types';
import type { AudioEngine } from '../utils/audioEngine';
import { lyricsText } from '../utils/songDraft';
import { CoverArt } from './LibraryView';
import VocalRecorder from './VocalRecorder';
import type { VocalTake } from '../utils/recordingStore';
import { recordingExtension } from '../utils/vocalRecording';
import { lyricCueAtBeat, type LyricCue } from '../utils/lyricsTiming';
import VocalMixer from './VocalMixer';
import { encodeWave } from '../utils/waveFile';
import { getKaraokeTrack, type KaraokeBackingTrack } from '../utils/karaokeStore';
import type { StudioPhoneMic } from '../utils/phoneCompanion';

const timeLabel = (value: number) => Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0');
export default function SongPlayer({ song, userId, audioEngine, phoneMic, onEdit, onReprocessBacking, onRecordingBusy, onRecorded, onTimingChange }: { song: SongMetadata; userId: string; audioEngine: AudioEngine; phoneMic?: StudioPhoneMic; onEdit: (song: SongMetadata) => void; onReprocessBacking?: () => void; onRecordingBusy: (busy: boolean) => void; onRecorded: (message: string) => void; onTimingChange: (timing: number[] | undefined) => void }) {
  const reference = song.backingTrack;
  const [mode, setMode] = useState<'instrumental' | 'backing' | 'recorded'>(reference ? 'backing' : 'instrumental');
  const [take, setTake] = useState<VocalTake | null>(null);
  const [takeUrl, setTakeUrl] = useState('');
  const [recording, setRecording] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [duration, setDuration] = useState(60);
  const [volume, setVolume] = useState(.5);
  const [bpm, setBpm] = useState(song.bpm);
  const [section, setSection] = useState('Intro');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [karaokeCue, setKaraokeCue] = useState<LyricCue | null>(null);
  const [karaokeActive, setKaraokeActive] = useState(false);
  const [timingMode, setTimingMode] = useState(false);
  const [timingPoints, setTimingPoints] = useState<number[]>([]);
  const [timingNotice, setTimingNotice] = useState('');
  const [mixing, setMixing] = useState(false);
  const [renderingInstrumental, setRenderingInstrumental] = useState(false);
  const [instrumentalDownload, setInstrumentalDownload] = useState('');
  const [instrumentalError, setInstrumentalError] = useState('');
  const [backing, setBacking] = useState<KaraokeBackingTrack | null>(null);
  const [backingUrl, setBackingUrl] = useState('');
  const [backingState, setBackingState] = useState<'none' | 'loading' | 'ready' | 'missing'>(reference ? 'loading' : 'none');
  const audioRef = useRef<HTMLAudioElement>(null);
  const lyricsRef = useRef<HTMLDivElement>(null);
  const lyricLineRefs = useRef(new Map<number, HTMLParagraphElement>());
  const alive = useRef(true);
  const isRecorded = mode === 'recorded' && Boolean(takeUrl);
  const isBacking = mode === 'backing';
  const audioUrl = isRecorded ? takeUrl : isBacking ? backingUrl || undefined : undefined;
  const guideBpm = isBacking ? backing?.bpm || reference?.bpm || song.bpm : bpm;
  const lyricSections = song.lyrics.filter(part => part.lines.length);
  const flatLyrics = lyricSections.flatMap(part => part.lines);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => () => { if (instrumentalDownload) URL.revokeObjectURL(instrumentalDownload); }, [instrumentalDownload]);
  useEffect(() => {
    if (!take) { setTakeUrl(''); return; }
    const url = URL.createObjectURL(take.blob); setTakeUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [take]);
  useEffect(() => {
    let current = true;
    if (!reference?.id) { setBacking(null); setBackingState('none'); return; }
    setBacking(null); setBackingState('loading');
    getKaraokeTrack(userId, song.id, reference.id).then(track => {
      if (!current) return;
      setBacking(track || null); setBackingState(track ? 'ready' : 'missing');
    }).catch(() => { if (current) { setBacking(null); setBackingState('missing'); } });
    return () => { current = false; };
  }, [userId, song.id, reference?.id]);
  useEffect(() => {
    if (!backing) { setBackingUrl(''); return; }
    const url = URL.createObjectURL(backing.blob); setBackingUrl(url);
    return () => { audioRef.current?.pause(); audioEngine.stop(); URL.revokeObjectURL(url); };
  }, [backing?.id, backing?.blob, audioEngine]);
  useEffect(() => {
    const audio = audioRef.current;
    audioEngine.stop(); setPlaying(false); setBuffering(false); setSeconds(0); setDuration(audioUrl ? isRecorded && take ? take.duration : isBacking ? backing?.duration || reference?.duration || 0 : 0 : isBacking ? reference?.duration || 0 : 60); setError(''); setKaraokeCue(null); setKaraokeActive(false);
    return () => { audio?.pause(); audioEngine.stop(); };
  }, [audioUrl, audioEngine, isBacking, backing?.duration, reference?.duration]);
  useEffect(() => { audioEngine.setVolume(volume); if (audioRef.current) audioRef.current.volume = volume; }, [volume, audioUrl, audioEngine]);
  useEffect(() => {
    if (!karaokeActive || !karaokeCue || !lyricsRef.current) return;
    const line = lyricLineRefs.current.get(karaokeCue.flatIndex);
    if (line) lyricsRef.current.scrollTo({ top: Math.max(0, line.offsetTop - lyricsRef.current.clientHeight / 2 + line.clientHeight / 2), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [karaokeActive, karaokeCue?.flatIndex]);
  function followLyrics(cue: LyricCue | null) { setKaraokeActive(Boolean(cue)); setKaraokeCue(cue); }
  function stop() {
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.currentTime = 0; }
    audioEngine.stop(); setPlaying(false); setBuffering(false); setSeconds(0); setSection('Intro'); followLyrics(null);
  }
  async function startTiming() {
    const useBacking = isBacking;
    if (useBacking && (!backing || !backingUrl)) { setError(backingState === 'loading' ? 'Your karaoke backing is still loading.' : 'This karaoke backing is missing from this browser. Restore it in Karaoke Track Lab.'); return; }
    stop(); setError(''); setTimingNotice(''); setTimingPoints([]); setTimingMode(true); onRecordingBusy(true);
    try {
      if (useBacking) {
        const audio = audioRef.current;
        if (!audio) throw new Error();
        audio.currentTime = 0; await audio.play();
      } else {
        audioEngine.start({ ...song, bpm, lyricTiming: undefined }, (_beat, section, _chord, _line, _progress, cue) => { setSection(section); setSeconds(audioEngine.getCurrentTime()); followLyrics(cue); }, () => { setPlaying(false); followLyrics(null); setTimingMode(false); onRecordingBusy(false); setError('The preview ended before every line was timed. Start again and tap each line as you sing it.'); });
      }
      setPlaying(true);
    } catch { setTimingMode(false); onRecordingBusy(false); setError('Your browser could not start the timing preview. Press Try timing again.'); }
  }
  function tapTiming() {
    if (!timingMode || timingPoints.length >= flatLyrics.length) return;
    const currentSeconds = isBacking ? audioRef.current?.currentTime || 0 : audioEngine.getCurrentTime();
    const beat = Math.round(currentSeconds * guideBpm / 60 * 4) / 4;
    if (timingPoints.length && beat <= timingPoints[timingPoints.length - 1]) { setTimingNotice('Wait for the next beat before tapping the next line.'); return; }
    const next = [...timingPoints, beat]; setTimingPoints(next); setTimingNotice('');
    if (next.length === flatLyrics.length) {
      if (isBacking && audioRef.current) audioRef.current.pause(); else audioEngine.stop();
      setPlaying(false); followLyrics(null); setTimingMode(false); onRecordingBusy(false); onTimingChange(next); setTimingNotice(`Custom timing saved. Play the ${isBacking ? 'karaoke backing' : 'instrumental'} to check it.`);
    }
  }
  function cancelTiming() { stop(); setTimingMode(false); setTimingPoints([]); onRecordingBusy(false); setTimingNotice('Timing changes cancelled.'); }
  async function prepareInstrumentalDownload() {
    if (renderingInstrumental || recording || timingMode || mixing) return;
    stop(); setRenderingInstrumental(true); setInstrumentalError(''); onRecordingBusy(true);
    try {
      const rendered = await audioEngine.renderInstrumental({ ...song, bpm }, 60);
      const url = URL.createObjectURL(encodeWave(rendered));
      if (!alive.current) { URL.revokeObjectURL(url); return; }
      setInstrumentalDownload(previous => { if (previous) URL.revokeObjectURL(previous); return url; });
      onRecorded('Prepared an instrumental WAV for “' + song.title + '”');
    } catch (failure) {
      if (alive.current) setInstrumentalError(failure instanceof Error ? failure.message : 'The instrumental download could not be prepared.');
    } finally { if (alive.current) { setRenderingInstrumental(false); onRecordingBusy(false); } }
  }
  async function toggle() {
    setError('');
    if (recording) return;
    if (isBacking && !backingUrl) { setError(backingState === 'loading' ? 'Your karaoke backing is still loading.' : 'This karaoke backing is missing from this browser. Restore it in Karaoke Track Lab.'); return; }
    if (audioUrl && audioRef.current) {
      const audio = audioRef.current;
      if (!audio.paused) { audio.pause(); return; }
      audioEngine.stop();
      try { if (audio.ended) audio.currentTime = 0; await audio.play(); }
      catch (error) { if (audioRef.current === audio && !(error instanceof DOMException && error.name === 'AbortError')) { setError(isBacking ? 'The karaoke backing could not start. Restore it in Karaoke Track Lab or choose the local instrumental.' : 'Audio could not start. Try again or switch to the instrumental preview.'); setBuffering(false); setPlaying(false); } }
    } else if (playing) stop();
    else {
      try {
        audioEngine.setVolume(volume);
        audioEngine.start({ ...song, bpm }, (_beat, section, _chord, _line, _progress, cue) => { setSection(section); setSeconds(audioEngine.getCurrentTime()); followLyrics(cue); }, () => { setPlaying(false); setSeconds(60); followLyrics(null); });
        setPlaying(true); setSeconds(0);
      } catch { setError('Your browser could not start audio. Please press Play again.'); }
    }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(lyricsText(song.lyrics)); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setError('Clipboard access is unavailable. Select the lyrics to copy them.'); }
  }
  function updateAudio(audio: HTMLAudioElement) {
    setSeconds(audio.currentTime);
    if (isBacking && backing && (!audio.paused || timingMode)) followLyrics(lyricCueAtBeat(song, audio.currentTime * backing.bpm / 60));
  }
  function audioEnded() {
    setPlaying(false); setBuffering(false); followLyrics(null);
    if (timingMode && timingPoints.length < flatLyrics.length) {
      setTimingMode(false); onRecordingBusy(false);
      setError('The karaoke backing ended before every line was timed. Start again and tap each line as you sing it.');
    }
  }
  const selectedAudioLabel = isBacking ? 'karaoke backing' : isRecorded ? 'recording' : 'instrumental';
  const selectedDownloadName = isBacking && backing ? (backing.name.toLowerCase().endsWith('.wav') ? backing.name : backing.name + '.wav') : song.title + (take ? '-my-take.' + recordingExtension(take.blob.type) : '-recording.webm');
  return <section className="panel player-panel" aria-label={'Player for ' + song.title}>
    {audioUrl && <audio key={audioUrl} ref={audioRef} src={audioUrl} preload="metadata" onLoadedMetadata={e => { const value = e.currentTarget.duration; if (Number.isFinite(value)) setDuration(value); }} onTimeUpdate={e => updateAudio(e.currentTarget)} onPlaying={e => { setPlaying(true); setBuffering(false); updateAudio(e.currentTarget); }} onPause={() => { setPlaying(false); setBuffering(false); followLyrics(null); }} onWaiting={() => setBuffering(true)} onCanPlay={() => setBuffering(false)} onEnded={audioEnded} onError={() => { setPlaying(false); setBuffering(false); followLyrics(null); setError(isBacking ? 'This karaoke backing is no longer playable. Restore it in Karaoke Track Lab.' : 'This recording could not be played. Try another take or the instrumental preview.'); }} />}
    <div className="section-heading"><span className="eyebrow">YOUR LISTENING ROOM</span><AudioLines size={18} /></div>
    <div className="player-art"><CoverArt song={song} large /><span className="badge">{isRecorded ? 'My vocal take' : isBacking ? 'Karaoke backing' : 'Instrumental preview'}</span></div>
    <h2 dir="auto">{song.title}</h2><p className="player-meta">{song.genre} · {song.language} · {guideBpm} BPM</p>
    <div className="segmented"><button aria-pressed={mode === 'instrumental'} disabled={recording || timingMode || mixing} onClick={() => setMode('instrumental')}>Instrumental</button><button aria-pressed={isBacking} disabled={recording || timingMode || mixing || !reference} onClick={() => setMode('backing')}><Headphones size={13} />Karaoke</button><button aria-pressed={isRecorded} disabled={recording || timingMode || mixing || !takeUrl} onClick={() => setMode('recorded')}>My take</button></div>
    <div className="playback-progress">{audioUrl ? <input type="range" aria-label={'Seek ' + selectedAudioLabel} min={0} max={duration || 1} step={.1} value={Math.min(seconds, duration || 1)} disabled={recording || !duration} onChange={e => { if (audioRef.current) { audioRef.current.currentTime = Number(e.target.value); updateAudio(audioRef.current); } }} /> : <progress aria-label={isBacking ? 'Karaoke backing progress' : 'Instrumental progress'} max={isBacking ? reference?.duration || 1 : 60} value={seconds} />}<div><span>{timeLabel(seconds)}</span><span>{duration ? timeLabel(duration) : backingState === 'loading' ? 'Loading…' : '0:00'}</span></div></div>
    <div className="player-controls"><button className="icon-button" disabled={recording || timingMode || mixing} onClick={stop} aria-label="Stop playback"><Square size={18} /></button><button className="play-button" disabled={recording || timingMode || mixing || (isBacking && backingState === 'loading')} onClick={() => void toggle()} aria-label={playing ? audioUrl ? `Pause ${selectedAudioLabel}` : 'Stop instrumental' : audioUrl || isBacking ? `Play ${selectedAudioLabel}` : 'Play instrumental'}>{buffering || (isBacking && backingState === 'loading') ? <LoaderCircle size={26} className="spin" /> : playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}</button>{audioUrl ? <a className="icon-button" href={audioUrl} download={selectedDownloadName} aria-label={isBacking ? 'Download karaoke backing' : 'Download selected recording'}><Download size={19} /></a> : <span className="control-spacer" />}</div>
    <div className="volume-control"><Volume2 size={16} /><input aria-label="Volume" type="range" min={0} max={1} step={.01} value={volume} onChange={e => setVolume(Number(e.target.value))} /><span>{Math.round(volume * 100)}%</span></div>
    {mode === 'instrumental' && <div className="preview-caption"><p>Local synthesized music · no singing</p><label>Preview tempo<input aria-label="Instrumental tempo" disabled={recording || renderingInstrumental} type="number" value={bpm} min={40} max={240} onChange={e => { const value = Math.max(40, Math.min(240, Number(e.target.value))); setBpm(value); audioEngine.setBpm(value); setInstrumentalDownload(''); }} /><span>BPM</span></label>{playing && <span>{section}</span>}<div className="instrumental-export">{instrumentalDownload ? <a className="button secondary small" href={instrumentalDownload} download={song.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() + '-instrumental.wav'}><Download size={15} />Download instrumental WAV</a> : <button className="button secondary small" disabled={renderingInstrumental || recording || timingMode || mixing} onClick={() => void prepareInstrumentalDownload()}>{renderingInstrumental ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{renderingInstrumental ? 'Rendering 60-second WAV…' : 'Prepare instrumental download'}</button>}</div>{instrumentalError && <p className="notice error" role="alert">{instrumentalError}</p>}</div>}
    {isBacking && backing && <div className="preview-caption"><p><Headphones size={15} />{backing.name} · full {timeLabel(backing.duration)} track · saved speed and key</p><span>{backing.bpm} BPM lyric guide</span></div>}
    {isBacking && backingState === 'missing' && <p className="notice error" role="alert">This song’s exact karaoke backing is missing from this browser. SoundProof will not replace it with a different instrumental. Restore it in Karaoke Track Lab.</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {!!lyricSections.length && <section className={'karaoke-guide' + (karaokeActive ? ' active' : '')} aria-label="Synchronized lyric guide">
      <div className="karaoke-top"><span>{karaokeActive ? 'NOW SINGING' : 'LYRIC & BEAT GUIDE'}</span>{karaokeActive ? <strong>{karaokeCue?.section}</strong> : <strong>{guideBpm} BPM</strong>}</div>
      <p className="karaoke-current" dir="auto" aria-live="polite" aria-atomic="true">{karaokeActive ? karaokeCue?.countIn ? 'Get ready — enter after 4' : karaokeCue?.line : `Press ${isBacking ? 'Karaoke' : 'Instrumental'} Play or start a vocal take.`}</p>
      <div className="karaoke-bottom"><div className="beat-count" aria-label={karaokeActive ? 'Beat ' + ((karaokeCue?.beatInBar || 0) + 1) + ' of 4' : 'Four beat count'}>{[0, 1, 2, 3].map(beat => <span key={beat} className={karaokeActive && karaokeCue?.beatInBar === beat ? 'on' : ''}>{beat + 1}</span>)}</div><p dir="auto">{karaokeActive ? <><span>Next</span>{karaokeCue?.nextLine}</> : 'Each lyric line follows the colored beat.'}</p></div>
    </section>}
    {!!flatLyrics.length && <section className={'timing-editor' + (timingMode ? ' active' : '')} aria-label="Manual lyric timing editor"><div className="section-heading"><h3><TimerReset size={17} />Lyric timing</h3>{song.lyricTiming?.length === flatLyrics.length && <span className="badge">Custom</span>}</div>{timingMode ? <><p className="timing-instruction">Sing along, then tap when this line should begin:</p><strong className="timing-target" dir="auto">{flatLyrics[timingPoints.length]}</strong><button className="button timing-tap full" onClick={tapTiming}><MousePointer2 size={17} />Tap line {timingPoints.length + 1} of {flatLyrics.length}</button><div className="timing-progress"><progress max={flatLyrics.length} value={timingPoints.length} /><span>{flatLyrics.length - timingPoints.length} lines remaining</span></div><button className="text-button" onClick={cancelTiming}>Cancel timing</button></> : <><p className="small-text muted">The automatic guide uses even phrases. Tap each line once to match your own phrasing{isBacking ? ' over this karaoke backing' : ''}.</p><div className="button-row"><button className="button secondary small" disabled={recording || (isBacking && backingState !== 'ready')} onClick={() => void startTiming()}>{song.lyricTiming ? 'Time lyrics again' : 'Set custom timing'}</button>{song.lyricTiming && <button className="text-button" disabled={recording} onClick={() => { onTimingChange(undefined); setTimingNotice('Automatic timing restored.'); }}>Use automatic timing</button>}</div></>}{timingNotice && <p className="small-text" role="status">{timingNotice}</p>}</section>}
    <VocalRecorder disabled={timingMode || mixing} externalTake={take} phoneMic={phoneMic} song={song} userId={userId} engine={audioEngine} bpm={bpm} backingTrack={isBacking ? backing : null} backingLoading={isBacking && Boolean(reference) && backingState === 'loading'} backingUnavailable={isBacking && Boolean(reference) && backingState === 'missing'} onPrepare={stop} onBusy={value => { setRecording(value); if (!value) followLyrics(null); onRecordingBusy(value); }} onBackingBeat={followLyrics} onSelect={(value, activate) => { setTake(value); if (activate && value) setMode('recorded'); else if (!value && mode === 'recorded') setMode(reference ? 'backing' : 'instrumental'); }} onSaved={onRecorded} />
    {take && <VocalMixer take={take} song={song} engine={audioEngine} playerVolume={volume} onPrepare={stop} onBeat={followLyrics} onTakeUpdate={setTake} onBusy={value => { setMixing(value); onRecordingBusy(value); }} onActivity={onRecorded} />}
    <div className="lyrics-heading"><h3>Lyrics</h3><button className="icon-button" onClick={() => void copy()} aria-label={copied ? 'Lyrics copied' : 'Copy lyrics'}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
    <p className="small-text muted">{song.lyricsSource === 'template' ? 'Starter lyrics · edit or ask the assistant for original lyrics.' : isBacking ? 'Lyrics follow the karaoke backing at its saved BPM. Use custom timing to match the singer’s exact phrasing.' : isRecorded ? 'Lyrics reference · timing may differ from your recording.' : 'During the instrumental, each line is highlighted for its four-beat phrase.'}</p>
    <div className={'lyrics-content guided' + (karaokeActive ? ' is-following' : '')} ref={lyricsRef} dir={song.language === 'Arabic' ? 'rtl' : 'auto'}>{lyricSections.length ? lyricSections.map((part, index) => { const offset = lyricSections.slice(0, index).reduce((total, item) => total + item.lines.length, 0); return <div key={index} className={karaokeActive && karaokeCue?.sectionIndex === index ? 'current-section' : ''}><h4>{part.section}</h4>{part.lines.map((line, n) => { const flatIndex = offset + n; const current = karaokeActive && karaokeCue?.flatIndex === flatIndex; const done = karaokeActive && karaokeCue !== null && flatIndex < karaokeCue.flatIndex; return <p key={n} ref={element => { if (element) lyricLineRefs.current.set(flatIndex, element); else lyricLineRefs.current.delete(flatIndex); }} aria-current={current ? 'true' : undefined} className={current ? 'lyric-line current' : done ? 'lyric-line done' : 'lyric-line'} style={current ? { '--line-progress': karaokeCue.lineProgress } as React.CSSProperties : undefined}><span className="line-number">{String(flatIndex + 1).padStart(2, '0')}</span><span>{line}</span></p>; })}</div>; }) : <p className="muted">Add your lyrics or ask the assistant to write them.</p>}</div>{reference && onReprocessBacking ? <button className="button secondary full" disabled={recording} onClick={onReprocessBacking}><Headphones size={16} />Reprocess in Karaoke Track Lab</button> : <button className="button secondary full" disabled={recording} onClick={() => onEdit(song)}><Sparkles size={16} />Edit this song in Create</button>}
  </section>;
}

