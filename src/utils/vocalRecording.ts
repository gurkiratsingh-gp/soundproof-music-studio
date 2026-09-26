import type { AudioEngine } from './audioEngine';

export const MAX_TAKE_SECONDS = 60;
export type RecordedAudio = { blob: Blob; duration: number; interrupted: boolean };
export type RecordingPhase = 'permission' | 'countdown' | 'recording' | 'saving';
export function recordingExtension(mime: string) {
  return mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
}
export function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was blocked. Allow the microphone in your browser’s site settings, then try again.';
  if (name === 'NotFoundError') return 'No microphone was found. Connect a microphone and try again.';
  if (name === 'NotReadableError') return 'The microphone is unavailable. Close other apps using it and try again.';
  return error instanceof Error && name === 'Error' ? error.message : 'Recording stopped unexpectedly. Check your microphone and try again.';
}

// One capture owns every node, track and timer it creates. Stopping also works
// while browser permission is pending; a late permission grant is released.
export class VocalCapture {
  private cancelled = false;
  private finishing = false;
  private cleaned = false;
  private mic?: MediaStream;
  private tap?: ReturnType<AudioEngine['createRecordingTap']>;
  private destination?: MediaStreamAudioDestinationNode;
  private recorder?: MediaRecorder;
  private nodes: AudioNode[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private meterTimer?: ReturnType<typeof setInterval>;
  private resolveDelay?: () => void;
  private resolvePermissionCancel?: () => void;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private stoppedAt = 0;
  private interrupted = false;
  private microphonePeak = 0;
  private failure?: string;
  private done?: Promise<RecordedAudio | null>;
  private resolveDone?: (audio: RecordedAudio | null) => void;
  private rejectDone?: (error: Error) => void;

  constructor(private engine: AudioEngine, private options: {
    includeInstrumental: boolean;
    onState: (phase: RecordingPhase, seconds: number) => void;
    onLevel: (level: number) => void;
    startBacking: () => void | Promise<void>;
    getMicrophone?: () => Promise<MediaStream>; // A paired phone, or a synthetic test source.
    requireMicrophoneSignal?: boolean;
    countdownSeconds?: number;
  }) {}

  async record(): Promise<RecordedAudio | null> {
    if (this.cancelled) return null;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Recording needs a supported browser on localhost or HTTPS. Open this studio in Chrome, Edge, Firefox, or Safari.');
    this.options.onState('permission', 0);
    try {
      this.tap = this.engine.createRecordingTap();
      // Resume inside the Record button gesture, before waiting for permission.
      const resumed = this.tap.context.resume();
      const microphone = this.options.getMicrophone || (() => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false }, video: false }));
      const incoming = microphone().then(stream => {
        if (this.cancelled) stream.getTracks().forEach(track => track.stop());
        else this.mic = stream;
        return stream;
      });
      await Promise.race([Promise.all([resumed, incoming]), new Promise<void>(resolve => { this.resolvePermissionCancel = resolve; })]);
      this.resolvePermissionCancel = undefined;
      if (this.cancelled) return null;
      if (!this.mic?.getAudioTracks().some(track => track.readyState === 'live')) throw new Error('The microphone disconnected. Reconnect it and try again.');
      const context = this.tap.context;
      const microphoneSource = context.createMediaStreamSource(this.mic);
      const analyser = context.createAnalyser(); analyser.fftSize = 1024;
      const micGain = context.createGain(); micGain.gain.value = .85;
      const backingGain = context.createGain(); backingGain.gain.value = this.options.includeInstrumental ? .35 : 0;
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -6; compressor.knee.value = 6; compressor.ratio.value = 12;
      compressor.attack.value = .003; compressor.release.value = .15;
      const headroom = context.createGain(); headroom.gain.value = .8;
      this.destination = context.createMediaStreamDestination();
      microphoneSource.connect(analyser); analyser.connect(micGain); micGain.connect(compressor);
      this.tap.output.connect(backingGain); backingGain.connect(compressor);
      compressor.connect(headroom); headroom.connect(this.destination);
      this.nodes = [microphoneSource, analyser, micGain, backingGain, compressor, headroom];
      // This graph ends at the recording stream, never at context.destination.
      const samples = new Float32Array(analyser.fftSize);
      this.meterTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let peak = 0; for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        if (this.startedAt && !this.finishing) this.microphonePeak = Math.max(this.microphonePeak, peak);
        this.options.onLevel(Math.min(1, peak));
        if (this.startedAt && !this.finishing) this.options.onState('recording', Math.min(MAX_TAKE_SECONDS, (performance.now() - this.startedAt) / 1000));
      }, 100);
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      this.recorder = new MediaRecorder(this.destination.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 128000 });
      this.done = new Promise((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
      this.recorder.ondataavailable = event => { if (event.data.size) this.chunks.push(event.data); };
      this.recorder.onerror = () => { this.failure = 'The browser could not finish recording. Please try a new take.'; if (!this.startedAt) this.rejectDone?.(new Error(this.failure)); this.stop(true); };
      this.recorder.onstop = () => { void this.complete(); };
      this.recorder.onstart = () => {
        if (this.cancelled) return;
        this.startedAt = performance.now();
        this.options.onState('recording', 0);
        try {
          // The backing is always monitored so a voice-only take can still be
          // sung in time. backingGain decides whether it is baked into the file.
          const starting = this.options.startBacking();
          if (starting && typeof starting.then === 'function') starting.catch(() => {
            if (this.cancelled || this.finishing) return;
            this.failure = 'The backing track could not start. Try it in the player, or choose the local instrumental.';
            this.stop();
          });
        }
        catch { this.failure = 'The backing track could not start. Try it in the player, or choose the local instrumental.'; this.stop(); return; }
        this.timers.push(setTimeout(() => this.stop(), MAX_TAKE_SECONDS * 1000));
      };
      this.mic.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
        if (this.startedAt) this.stop(true);
        else { this.failure = 'The microphone disconnected before recording started.'; this.cancel(); }
      }, { once: true }));
      for (let count = this.options.countdownSeconds ?? 3; count > 0; count--) {
        this.options.onState('countdown', count);
        await new Promise<void>(resolve => { this.resolveDelay = resolve; this.timers.push(setTimeout(resolve, 1000)); });
        this.resolveDelay = undefined;
        if (this.cancelled) { if (this.failure) throw new Error(this.failure); return null; }
      }
      this.recorder.start(250);
      this.timers.push(setTimeout(() => { if (!this.startedAt && !this.cancelled) { this.rejectDone?.(new Error('The browser could not start recording. Please try again.')); this.cancel(); } }, 5000));
      return await this.done;
    } catch (error) { this.cancelled = true; throw error; }
    finally { this.cleanup(); }
  }

  stop(interrupted = false) {
    if (this.finishing || this.cancelled) return;
    if (!this.startedAt) { this.cancel(); return; }
    this.finishing = true; this.interrupted = interrupted; this.stoppedAt = performance.now();
    this.options.onState('saving', 0);
    this.engine.stop();
    // Stop mic tracks immediately; MediaRecorder flushes its buffered data in
    // dataavailable before onstop, so do not build the Blob in this method.
    this.mic?.getTracks().forEach(track => track.stop());
    if (this.recorder?.state !== 'inactive') this.recorder?.stop();
    this.timers.push(setTimeout(() => { this.rejectDone?.(new Error('The browser could not finalize this take. Please try again.')); }, 5000));
  }

  cancel() {
    this.cancelled = true;
    this.resolvePermissionCancel?.(); this.resolvePermissionCancel = undefined;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.resolveDone?.(null);
    this.cleanup();
  }

  private async complete() {
    if (this.cancelled) { this.resolveDone?.(null); return; }
    const blob = new Blob(this.chunks, { type: this.recorder?.mimeType || this.chunks[0]?.type || 'audio/webm' });
    let duration = Math.min(MAX_TAKE_SECONDS, ((this.stoppedAt || performance.now()) - this.startedAt) / 1000);
    // Some browsers omit WebM duration. Measure the actual encoded audio for
    // seeking, rather than including microphone/encoder startup latency.
    try { if (blob.size && this.tap) duration = (await this.tap.context.decodeAudioData(await blob.arrayBuffer())).duration; } catch { /* Retain the capture clock if this browser cannot decode its output here. */ }
    // Measure the microphone branch, not the encoded mix: a loud backing must
    // never make a silent phone microphone look like a successful vocal take.
    if (this.options.requireMicrophoneSignal && this.microphonePeak < .0001 && !this.failure) {
      this.failure = 'No sound reached the computer from your phone during this take. Keep the phone page open and unlocked, allow its microphone, then use Check phone microphone and speak before recording again.';
    }
    if (this.failure || !blob.size || duration < .3) this.rejectDone?.(new Error(this.failure || 'That take was too short. Record for at least one second, then stop.'));
    else this.resolveDone?.({ blob, duration, interrupted: this.interrupted });
  }

  private cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    this.engine.stop();
    this.resolveDelay?.(); this.resolveDelay = undefined;
    this.timers.forEach(clearTimeout); this.timers = [];
    clearInterval(this.meterTimer);
    this.mic?.getTracks().forEach(track => track.stop());
    this.destination?.stream.getTracks().forEach(track => track.stop());
    this.nodes.forEach(node => node.disconnect()); this.nodes = [];
    this.tap?.disconnect(); this.tap = undefined;
  }
}
