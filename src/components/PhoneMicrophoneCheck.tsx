import { useEffect, useRef, useState } from 'react';
import { AudioLines, LoaderCircle } from 'lucide-react';
import type { AudioEngine } from '../utils/audioEngine';
import type { StudioPhoneMic } from '../utils/phoneCompanion';
import { microphoneError } from '../utils/vocalRecording';

/** Checks the received audio on the computer, without recording or monitoring it. */
export default function PhoneMicrophoneCheck({ engine, phoneMic, stream, disabled }: {
  engine: AudioEngine; phoneMic: StudioPhoneMic; stream?: MediaStream; disabled: boolean;
}) {
  const [phase, setPhase] = useState<'idle' | 'checking' | 'ready' | 'failed'>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => {
    cleanup.current(); setPhase('idle'); setLevel(0); setError('');
    return () => cleanup.current();
  }, [engine, phoneMic, stream, disabled]);

  async function check() {
    cleanup.current();
    let cancelled = false;
    let microphone: MediaStream | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    let tap: ReturnType<AudioEngine['createRecordingTap']> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => {
      if (cancelled) return;
      cancelled = true; clearInterval(timer); clearTimeout(timeout);
      source?.disconnect(); analyser?.disconnect(); tap?.disconnect();
      microphone?.getTracks().forEach(track => track.stop());
    };
    cleanup.current = dispose;
    setPhase('checking'); setLevel(0); setError('');
    timeout = setTimeout(() => {
      dispose(); setPhase('failed'); setError('The audio check did not start. Click Check phone microphone again. If it still cannot start, reconnect your phone.');
    }, 10000);
    try {
      // Start both operations in the button gesture to satisfy autoplay policy.
      await Promise.all([engine.prepare(), phoneMic.getMicrophoneStream().then(incoming => {
        microphone = incoming;
        if (cancelled) incoming.getTracks().forEach(track => track.stop());
      })]);
      if (cancelled) return;
      tap = engine.createRecordingTap();
      source = tap.context.createMediaStreamSource(microphone!);
      analyser = tap.context.createAnalyser(); analyser.fftSize = 2048;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const started = performance.now();
      let heard = 0;
      timer = setInterval(() => {
        analyser!.getFloatTimeDomainData(samples);
        let peak = 0; for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        setLevel(Math.min(1, peak));
        if (peak > .001) heard++;
        if (heard >= 3) { dispose(); setPhase('ready'); }
        else if (performance.now() - started > 6000) {
          dispose(); setPhase('failed'); setError('No sound received. Keep the phone page open and unlocked, allow its microphone, and speak near it. If its own meter moves but this one does not, reconnect both devices and try again.');
        }
      }, 100);
    } catch (failure) {
      if (!cancelled) { dispose(); setPhase('failed'); setError(microphoneError(failure)); }
    }
  }

  return <div className="phone-meter">
    <span><AudioLines size={15} />Sound arriving on this computer</span>
    <meter aria-label="Received phone microphone level" min={0} max={1} value={level} />
    <p className="small-text" role="status">{phase === 'checking' ? 'Speak or sing into your phone now…' : phase === 'ready' ? 'Sound received. Your phone microphone is working. You can record now.' : 'Check the audio connection before your first take. Your voice stays off the speakers.'}</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    <button type="button" className="button secondary small" disabled={disabled || phase === 'checking'} onClick={() => void check()}>{phase === 'checking' ? <LoaderCircle size={15} className="spin" /> : <AudioLines size={15} />}{phase === 'checking' ? 'Checking phone microphone…' : 'Check phone microphone'}</button>
  </div>;
}
