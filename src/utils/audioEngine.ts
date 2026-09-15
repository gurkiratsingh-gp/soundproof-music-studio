import { SongMetadata } from "../types";
import { createArrangement, arrangementStep } from './songArrangement';
import { lyricCueAtBeat, type LyricCue } from './lyricsTiming';

type Voice = { sources: AudioScheduledSourceNode[]; gain: GainNode; nodes: AudioNode[] };

type ArrangementEvent = ReturnType<typeof arrangementStep>;
export type InstrumentPart = {
  instrument: string;
  role: 'drums' | 'tabla' | 'bass' | 'chord' | 'guitar-chord' | 'lead';
  degreeOffset: number;
};

const CHORD_INSTRUMENTS = new Set(['Piano', 'Synth', 'Strings']);
const GUITAR_INSTRUMENTS = new Set(['Acoustic Guitar', 'Electric Guitar']);
const PITCHED_INSTRUMENTS = [
  'Piano', 'Acoustic Guitar', 'Electric Guitar', 'Synth', 'Violin',
  'Flute', 'Saxophone', 'Sitar', 'Strings', 'Trumpet',
];
const LEAD_ANCHORS: Record<string, number> = {
  Piano: 0, 'Acoustic Guitar': 2, 'Electric Guitar': 4, Synth: 6, Violin: 8,
  Flute: 10, Saxophone: 12, Sitar: 14, Strings: 1, Trumpet: 15,
};

/** Turn an arrangement step into the exact selected-instrument parts that sound. */
export function instrumentPartsForStep(instruments: string[], event: ArrangementEvent, step: number): InstrumentPart[] {
  const selected = [...new Set(instruments)];
  const parts: InstrumentPart[] = [];
  const position = ((step % 16) + 16) % 16;
  const hasPercussionHit = event.kick || event.snare || event.hat;
  // Ambient grooves intentionally have no stock percussion pattern. If the
  // user explicitly adds Drums or Tabla, still give that selection one quiet
  // downbeat per bar instead of silently ignoring it.
  const percussionEntrance = hasPercussionHit || position === 0;
  if (selected.includes('Drums') && percussionEntrance) parts.push({ instrument: 'Drums', role: 'drums', degreeOffset: 0 });
  if (selected.includes('Tabla') && percussionEntrance) parts.push({ instrument: 'Tabla', role: 'tabla', degreeOffset: 0 });
  if (selected.includes('Bass') && event.bass) parts.push({ instrument: 'Bass', role: 'bass', degreeOffset: 0 });

  for (const instrument of selected) {
    if (event.chord && CHORD_INSTRUMENTS.has(instrument)) parts.push({ instrument, role: 'chord', degreeOffset: 0 });
    if (event.chord && GUITAR_INSTRUMENTS.has(instrument)) parts.push({ instrument, role: 'guitar-chord', degreeOffset: 0 });
  }

  const melodic = selected.filter(instrument => PITCHED_INSTRUMENTS.includes(instrument));
  if (melodic.length) {
    const sharedLead = event.lead ? (Math.floor(step / 2) % melodic.length + melodic.length) % melodic.length : -1;
    melodic.forEach((instrument, index) => {
      // Every color gets one guaranteed entrance per bar; other melody notes
      // rotate between the selected voices so a large ensemble stays clear.
      if (position === LEAD_ANCHORS[instrument] || index === sharedLead) {
        parts.push({ instrument, role: 'lead', degreeOffset: (index * 2 + Math.floor(step / 16)) % 6 });
      }
    });
  }
  return parts;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private isEngineRunning = false;
  private tempoBpm = 110;
  private masterGain: GainNode | null = null;
  private mixGain: GainNode | null = null;
  private recordingOutput: AudioNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private voices = new Set<Voice>();
  private currentVolume = 0.5;
  private arrangement: ReturnType<typeof createArrangement> | null = null;
  private importedAudio: HTMLAudioElement | null = null;
  private importedSource: MediaElementAudioSourceNode | null = null;
  private importedFrame: number | null = null;
  private playbackGeneration = 0;

  // Background playback scheduling state
  private schedulerTimer: any = null;
  private startTime = 0;
  private currentBeat = 0;
  private nextNoteTime = 0.0;
  private scheduleAheadTime = 0.15; // Keep a small buffer against main-thread jitter.
  private lookahead = 25.0; // How frequently to call scheduler (ms)

  private songData: SongMetadata | null = null;
  private totalDuration = 60; // 60 seconds of procedural play
  private elapsedTime = 0;
  private timerInterval: any = null;

  // Callback to update UI on beat/lyrics changes
  private onBeatCallback: ((beat: number, section: string, chord: string, lyricsLine: string, progress: number, lyricCue: LyricCue | null) => void) | null = null;

  constructor() {}

  public init() {
    if (this.ctx) return;
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioContextClass();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.currentVolume;
    this.mixGain = this.ctx.createGain();
    this.mixGain.gain.value = 0.75;
    const dcBlock = this.ctx.createBiquadFilter();
    dcBlock.type = 'highpass';
    dcBlock.frequency.value = 25;
    dcBlock.Q.value = 0.707;
    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -8;
    compressor.knee.value = 6;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;
    this.mixGain.connect(dcBlock);
    dcBlock.connect(compressor);
    this.recordingOutput = compressor;
    compressor.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Reuse a noise sample instead of allocating a buffer on every drum hit.
    this.noiseBuffer = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const noise = this.noiseBuffer.getChannelData(0);
    let seed = 0x5a17;
    for (let i = 0; i < noise.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noise[i] = seed / 2147483648 - 1;
    }
  }

  public getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /** Unlock audio from a deliberate UI gesture before a paired phone sends a
   * later remote record command. Mobile and desktop autoplay policies require
   * this one local gesture. */
  public async prepare() {
    this.init();
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }

  // A separate post-compressor tap keeps recording balance independent of the
  // listening volume. The microphone must never be connected to the speakers.
  public createRecordingTap() {
    this.init();
    const output = this.ctx!.createGain();
    this.recordingOutput!.connect(output);
    return { context: this.ctx!, output, disconnect: () => { this.recordingOutput!.disconnect(output); output.disconnect(); } };
  }

  /** Render the same deterministic preview graph to a downloadable buffer. */
  public async renderInstrumental(song: SongMetadata, duration = 60, sampleRate = 44100): Promise<AudioBuffer> {
    const OfflineContext = window.OfflineAudioContext || (window as typeof window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!OfflineContext) throw new Error('This browser cannot render an instrumental file. Try a current Chrome or Edge browser.');
    const seconds = Math.max(5, Math.min(60, duration));
    const offline = new OfflineContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const renderer = new AudioEngine();
    // Audio scheduling methods use the shared BaseAudioContext surface. The
    // realtime-only start/stop methods are never called on this renderer.
    renderer.ctx = offline as unknown as AudioContext;
    renderer.songData = song;
    renderer.arrangement = createArrangement(song);
    renderer.tempoBpm = Math.max(40, Math.min(240, song.bpm || 110));
    renderer.totalDuration = seconds;
    renderer.mixGain = offline.createGain(); renderer.mixGain.gain.value = .75;
    const dcBlock = offline.createBiquadFilter(); dcBlock.type = 'highpass'; dcBlock.frequency.value = 25; dcBlock.Q.value = .707;
    const compressor = offline.createDynamicsCompressor(); compressor.threshold.value = -8; compressor.knee.value = 6; compressor.ratio.value = 8; compressor.attack.value = .003; compressor.release.value = .15;
    renderer.masterGain = offline.createGain(); renderer.masterGain.gain.value = .88;
    renderer.masterGain.gain.setValueAtTime(.88, Math.max(0, seconds - .12)); renderer.masterGain.gain.linearRampToValueAtTime(0, seconds);
    renderer.mixGain.connect(dcBlock); dcBlock.connect(compressor); compressor.connect(renderer.masterGain); renderer.masterGain.connect(offline.destination);
    renderer.noiseBuffer = offline.createBuffer(1, sampleRate, sampleRate);
    const noise = renderer.noiseBuffer.getChannelData(0); let seed = 0x5a17;
    for (let index = 0; index < noise.length; index++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; noise[index] = seed / 2147483648 - 1; }
    const stepDuration = 60 / renderer.tempoBpm / 4;
    for (let step = 0, time = .035; time < seconds; step++, time += stepDuration) renderer.scheduleBeat(step, time);
    return offline.startRendering();
  }

  public isPlaying(): boolean {
    return this.isEngineRunning;
  }

  public getProgress(): number {
    if (!this.isEngineRunning) return 0;
    return Math.min(this.elapsedTime / this.totalDuration, 1);
  }

  public getCurrentTime(): number {
    return this.elapsedTime;
  }

  public getTotalDuration(): number {
    return this.totalDuration;
  }

  public setVolume(volume: number) {
    this.currentVolume = Math.max(0, Math.min(1, volume));
    if (this.masterGain && this.ctx) {
      this.smoothGain(this.masterGain.gain, this.isEngineRunning ? this.currentVolume : 0, this.ctx.currentTime, 0.025);
    }
  }

  public setBpm(bpm: number) {
    this.tempoBpm = Math.max(40, Math.min(240, bpm));
  }

  public start(
    song: SongMetadata, 
    onBeat: (beat: number, section: string, chord: string, lyricsLine: string, progress: number, lyricCue: LyricCue | null) => void,
    onEnded?: () => void,
    startOffsetSeconds = 0,
  ) {
    this.stop();
    this.init();

    if (!this.ctx) return;
    if (this.masterGain) this.smoothGain(this.masterGain.gain, this.currentVolume, this.ctx.currentTime, 0.015);

    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }

    this.songData = song;
    this.arrangement = createArrangement(song);
    this.tempoBpm = song.bpm || 110;
    this.onBeatCallback = onBeat;
    this.isEngineRunning = true;
    this.elapsedTime = Math.max(0, Math.min(this.totalDuration - .1, startOffsetSeconds));
    this.currentBeat = Math.floor(this.elapsedTime * this.tempoBpm / 60 * 4);
    
    this.nextNoteTime = this.ctx.currentTime + 0.035;
    this.startTime = this.nextNoteTime - this.elapsedTime;

    // Start background audio scheduler
    this.scheduler();

    // Start real-time UI stopwatch (every 1 second)
    this.timerInterval = setInterval(() => {
      if (!this.isEngineRunning) return;
      this.elapsedTime = Math.max(0, this.ctx!.currentTime - this.startTime);
      if (this.elapsedTime >= this.totalDuration) {
        this.stop();
        onEnded?.();
      }
    }, 1000);
  }

  /**
   * Play browser-local backing audio through the same compressor, monitor and
   * recording tap as the procedural engine. The caller owns (and revokes) the
   * object URL after stop/unmount.
   */
  public async startImportedBacking(
    url: string,
    song: SongMetadata,
    onBeat: (beat: number, section: string, chord: string, lyricsLine: string, progress: number, lyricCue: LyricCue | null) => void,
    onEnded?: () => void,
    startOffsetSeconds = 0,
  ): Promise<void> {
    this.stop();
    this.init();
    if (!this.ctx || !this.mixGain || !url) throw new Error('The imported backing could not be opened.');
    const generation = this.playbackGeneration;
    const audio = new Audio();
    audio.preload = 'auto';
    audio.playbackRate = 1;
    if ('preservesPitch' in audio) audio.preservesPitch = true;
    audio.src = url;
    this.importedAudio = audio;
    this.songData = song;
    this.tempoBpm = Math.max(40, Math.min(240, song.bpm || 110));
    this.onBeatCallback = onBeat;
    try {
      if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve, reject) => {
          const loaded = () => { clear(); resolve(); };
          const failed = () => { clear(); reject(new Error('This imported backing could not be decoded by the browser.')); };
          const clear = () => { audio.removeEventListener('loadedmetadata', loaded); audio.removeEventListener('error', failed); };
          audio.addEventListener('loadedmetadata', loaded, { once: true });
          audio.addEventListener('error', failed, { once: true });
          audio.load();
        });
      }
      if (generation !== this.playbackGeneration || this.importedAudio !== audio) throw new DOMException('Playback was interrupted.', 'AbortError');
      this.totalDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 60;
      const offset = Math.max(0, Math.min(Math.max(0, this.totalDuration - .05), startOffsetSeconds));
      audio.currentTime = offset;
      this.elapsedTime = offset;
      this.currentBeat = -1;
      this.importedSource = this.ctx.createMediaElementSource(audio);
      this.importedSource.connect(this.mixGain);
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (this.masterGain) this.smoothGain(this.masterGain.gain, this.currentVolume, this.ctx.currentTime, .015);
      audio.onended = () => {
        if (this.importedAudio !== audio) return;
        const complete = onEnded;
        this.stop();
        complete?.();
      };
      await audio.play();
      if (generation !== this.playbackGeneration || this.importedAudio !== audio) { audio.pause(); throw new DOMException('Playback was interrupted.', 'AbortError'); }
      this.isEngineRunning = true;
      const update = () => {
        if (!this.isEngineRunning || this.importedAudio !== audio) return;
        this.elapsedTime = Math.max(0, Math.min(this.totalDuration, audio.currentTime));
        const beat = Math.floor(this.elapsedTime * this.tempoBpm / 60);
        if (beat !== this.currentBeat) {
          this.currentBeat = beat;
          const { sectionName, chord, line, cue } = this.getPlaybackState(beat);
          this.onBeatCallback?.(beat, sectionName, chord, line, this.elapsedTime / this.totalDuration, cue);
        }
        this.importedFrame = requestAnimationFrame(update);
      };
      update();
    } catch (error) {
      if (this.importedAudio === audio) this.stop();
      throw error;
    }
  }

  public stop() {
    this.playbackGeneration++;
    this.isEngineRunning = false;
    if (this.importedFrame !== null) cancelAnimationFrame(this.importedFrame);
    this.importedFrame = null;
    if (this.importedAudio) {
      this.importedAudio.onended = null;
      this.importedAudio.pause();
      this.importedAudio.removeAttribute('src');
      this.importedAudio.load();
    }
    this.importedSource?.disconnect();
    this.importedSource = null;
    this.importedAudio = null;
    if (this.ctx) {
      const now = this.ctx.currentTime;
      if (this.masterGain) this.smoothGain(this.masterGain.gain, 0, now, 0.012);
      // Fade and stop the actual sources, so queued notes and old tails cannot
      // reappear when a new song opens the master volume again.
      for (const voice of this.voices) {
        this.smoothGain(voice.gain.gain, 0, now, 0.01);
        for (const source of voice.sources) source.stop(now + 0.012);
      }
    }
    
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    this.elapsedTime = 0;
    this.currentBeat = 0;
  }

  private scheduler() {
    if (!this.isEngineRunning || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.elapsedTime = Math.max(0, now - this.startTime);
    // A delayed timer must skip missed beats, not fire them together in a burst.
    const stepDuration = 60 / this.tempoBpm / 4;
    if (this.nextNoteTime < now + 0.005) {
      const missed = Math.ceil((now + 0.005 - this.nextNoteTime) / stepDuration);
      this.currentBeat += missed;
      this.nextNoteTime += missed * stepDuration;
    }
    while (this.nextNoteTime < now + this.scheduleAheadTime && this.nextNoteTime < this.startTime + this.totalDuration) {
      this.scheduleBeat(this.currentBeat, this.nextNoteTime);
      this.advanceBeat();
    }

    this.schedulerTimer = setTimeout(() => this.scheduler(), this.lookahead);
  }

  private advanceBeat() {
    if (!this.ctx) return;
    const secondsPerBeat = 60.0 / this.tempoBpm;
    this.nextNoteTime += secondsPerBeat / 4;
    this.currentBeat++;
  }

  // Get active chord, lyrics, and section based on current beat
  private getPlaybackState(beat: number) {
    if (!this.songData) return { sectionName: "Intro", chord: "Am", line: "", cue: null };

    const cue = lyricCueAtBeat(this.songData, beat);
    if (!cue) return { sectionName: 'Instrumental', chord: this.songData.chordProgression.verse[0] || 'Am', line: '', cue: null };
    const sectionName = cue.section;

    // Get active chords for this section (recycles 4 chords)
    const isChorus = sectionName.toLowerCase().includes("chorus");
    const chords = isChorus 
      ? this.songData.chordProgression.chorus 
      : this.songData.chordProgression.verse;
    
    const measure = Math.floor(beat / 4) % 4; // 0 to 3
    const chord = chords[measure % chords.length] || "Am";

    return { sectionName, chord, line: cue.line, cue };
  }

  private scheduleBeat(step: number, time: number) {
    if (!this.ctx || !this.songData || !this.masterGain || !this.arrangement) return;
    const beat = Math.floor(step / 4);
    const { sectionName, chord, line, cue } = this.getPlaybackState(beat);
    const event = arrangementStep(this.arrangement, step, sectionName);
    const noteTime = time + event.delayBeats * 60 / this.tempoBpm;
    // A callback on each quarter note drives an accurate four-beat count and
    // lyric highlighting without updating React on every sixteenth note.
    if (step % 4 === 0) this.onBeatCallback?.(beat, sectionName, chord, line, this.elapsedTime / this.totalDuration, cue);
    const beatInMeasure = (step % 16) / 4;
    const fallbackDownbeat = !event.kick && !event.snare && !event.hat && ((step % 16) + 16) % 16 === 0;
    const parts = instrumentPartsForStep(this.songData.instruments, event, step);
    const percussionLayers = Number(this.songData.instruments.includes('Drums')) + Number(this.songData.instruments.includes('Tabla'));
    const pitchedLayers = this.songData.instruments.filter(instrument => PITCHED_INSTRUMENTS.includes(instrument)).length;
    const percussionScale = percussionLayers > 1 ? .72 : 1;
    const pitchedScale = Math.min(1, 1.18 / Math.sqrt(Math.max(1, pitchedLayers)));
    for (const part of parts) {
      const velocity = event.velocity * (part.role === 'drums' || part.role === 'tabla' ? percussionScale : pitchedScale);
      if (part.role === 'drums') this.playDrums(event.kick || fallbackDownbeat, event.snare, event.hat, noteTime, velocity, event.brightness);
      else if (part.role === 'tabla') this.playTabla(event.kick || fallbackDownbeat, event.snare, event.hat, noteTime, velocity, event.brightness);
      else if (part.role === 'bass') this.playBass(chord, beatInMeasure, noteTime, event.bassOffset, velocity, event.brightness);
      else if (part.role === 'chord') this.playChord(chord, part.instrument.toLowerCase() as 'piano' | 'synth' | 'strings', beatInMeasure, noteTime, velocity, event.brightness, event.sustain);
      else if (part.role === 'guitar-chord') this.playGuitarChord(chord, part.instrument === 'Electric Guitar', noteTime, velocity, event.brightness, event.sustain);
      else if (part.instrument === 'Sitar') this.playSitar(chord, noteTime, event.degree + part.degreeOffset, velocity, event.brightness, event.sustain);
      else this.playLeadMelody(chord, part.instrument, noteTime, event.degree + part.degreeOffset, velocity, event.brightness, event.sustain, this.arrangement.groove);
    }
  }

  // --- SYNTHESIZERS AND INSTRUMENTS ---

  private smoothGain(param: AudioParam, value: number, time: number, seconds: number) {
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(time);
    else { const held = param.value; param.cancelScheduledValues(time); param.setValueAtTime(held, time); }
    param.linearRampToValueAtTime(value, time + seconds);
  }

  private envelope(gain: GainNode, time: number, peak: number, duration: number, attack = 0.005) {
    // GainNode defaults to 1. Set silence before *any* source can start, including
    // the delayed notes of rolled piano chords. End at zero before stopping.
    gain.gain.value = 0;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration - 0.008);
    gain.gain.linearRampToValueAtTime(0, time + duration);
  }

  private voice(sources: AudioScheduledSourceNode[], gain: GainNode, nodes: AudioNode[], time: number, duration: number) {
    gain.connect(this.mixGain!);
    const voice = { sources, gain, nodes: [...sources, gain, ...nodes] };
    this.voices.add(voice);
    let remaining = sources.length;
    for (const source of sources) {
      source.onended = () => {
        if (--remaining) return;
        for (const node of voice.nodes) node.disconnect();
        this.voices.delete(voice);
      };
      source.start(time);
      source.stop(time + duration);
    }
  }

  private getRootMidiNote(chordName: string): number {
    const root = chordName.match(/^[A-G](?:#|b)?/)?.[0] || 'A';
    
    const noteMap: { [key: string]: number } = {
      "C": 36, "C#": 37, "Db": 37, "D": 38, "D#": 39, "Eb": 39,
      "E": 40, "F": 41, "F#": 42, "Gb": 42, "G": 43, "G#": 44,
      "Ab": 44, "A": 45, "A#": 46, "Bb": 46, "B": 47
    };
    return noteMap[root] || 45; // Default A
  }

  private midiToFreq(midiNote: number): number {
    return 440 * Math.pow(2, (midiNote - 69) / 12);
  }

  // Drums use short, rounded attacks instead of instantaneous gain jumps.
  private playDrums(kick: boolean, snare: boolean, hat: boolean, time: number, velocity: number, brightness = .58) {
    if (!this.ctx || !this.mixGain) return;
    if (kick) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, time);
      osc.frequency.exponentialRampToValueAtTime(50, time + 0.12);
      osc.frequency.exponentialRampToValueAtTime(43, time + 0.28);
      this.envelope(gain, time, 0.55 * velocity, 0.3, 0.004);
      osc.connect(gain);
      this.voice([osc], gain, [], time, 0.3);
    }
    if (snare && this.noiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1200 + brightness * 900;
      filter.Q.value = 0.7;
      const gain = this.ctx.createGain();
      this.envelope(gain, time, 0.28 * velocity, 0.2, 0.004);
      noise.connect(filter);
      filter.connect(gain);
      this.voice([noise], gain, [filter], time, 0.2);
    }
    if (hat && this.noiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 4600 + brightness * 2600;
      filter.Q.value = 0.8;
      const gain = this.ctx.createGain();
      this.envelope(gain, time, 0.12 * velocity, 0.075, 0.003);
      noise.connect(filter);
      filter.connect(gain);
      this.voice([noise], gain, [filter], time, 0.075);
    }
  }

  // Tabla uses three tuned hand-drum articulations: a bending bayan bass, a
  // ringing dayan stroke, and a dry muted tap. It deliberately does not reuse
  // the drum-kit kick/snare/hat voices.
  private playTabla(bayan: boolean, dayan: boolean, muted: boolean, time: number, velocity: number, brightness = .58) {
    if (!this.ctx || !this.mixGain) return;
    if (bayan) {
      const body = this.ctx.createOscillator();
      const skin = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();
      body.type = 'sine'; skin.type = 'triangle';
      body.frequency.setValueAtTime(135, time); body.frequency.exponentialRampToValueAtTime(58, time + .16);
      skin.frequency.setValueAtTime(218, time); skin.frequency.exponentialRampToValueAtTime(88, time + .11);
      filter.type = 'lowpass'; filter.frequency.value = 520 + brightness * 260; filter.Q.value = 1.5;
      this.envelope(gain, time, .36 * velocity, .38, .003);
      body.connect(filter); skin.connect(filter); filter.connect(gain);
      this.voice([body, skin], gain, [filter], time, .38);
    }
    if (dayan) {
      const tone = this.ctx.createOscillator();
      const ring = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();
      const center = 285 + brightness * 115;
      tone.type = 'sine'; ring.type = 'triangle';
      tone.frequency.setValueAtTime(center, time); ring.frequency.setValueAtTime(center * 1.54, time);
      filter.type = 'bandpass'; filter.frequency.value = center * 1.18; filter.Q.value = 2.5;
      this.envelope(gain, time, .25 * velocity, .27, .0025);
      tone.connect(filter); ring.connect(filter);
      const sources: AudioScheduledSourceNode[] = [tone, ring];
      const nodes: AudioNode[] = [filter];
      if (this.noiseBuffer) {
        const noise = this.ctx.createBufferSource(); noise.buffer = this.noiseBuffer;
        const noiseFilter = this.ctx.createBiquadFilter(); noiseFilter.type = 'highpass'; noiseFilter.frequency.value = 1050;
        noise.connect(noiseFilter); noiseFilter.connect(filter); sources.push(noise); nodes.push(noiseFilter);
      }
      filter.connect(gain);
      this.voice(sources, gain, nodes, time, .27);
    }
    if (muted) {
      const tap = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      tap.type = 'triangle'; tap.frequency.setValueAtTime(780 + brightness * 260, time);
      tap.frequency.exponentialRampToValueAtTime(490, time + .065);
      filter.type = 'bandpass'; filter.frequency.value = 900 + brightness * 650; filter.Q.value = 1.1;
      this.envelope(gain, time, .105 * velocity, .075, .002);
      tap.connect(filter); filter.connect(gain);
      this.voice([tap], gain, [filter], time, .075);
    }
  }

  private playBass(chord: string, beatInMeasure: number, time: number, offset = 0, velocity = .74, brightness = .58) {
    if (!this.ctx || !this.mixGain) return;
    const freq = this.midiToFreq(this.getRootMidiNote(chord) + offset);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(150 + brightness * 100, time);
    filter.frequency.exponentialRampToValueAtTime(65 + brightness * 35, time + 0.35);
    let duration = 0.25;
    let volume = 0.4;
    if (beatInMeasure === 0) { duration = 0.4; volume = 0.55; }
    else if (beatInMeasure === 2.5) { duration = 0.15; volume = 0.3; }
    volume *= .72 + velocity * .28;
    this.envelope(gain, time, volume, duration, 0.008);
    osc.connect(filter);
    filter.connect(gain);
    this.voice([osc], gain, [filter], time, duration);
  }

  private playChord(chord: string, type: 'piano' | 'synth' | 'strings', beatInMeasure: number, time: number, velocity = .74, brightness = .58, sustain = 1) {
    if (!this.ctx || !this.mixGain) return;
    const root = this.getRootMidiNote(chord) + 12;
    const isMinor = chord.includes('m') && !chord.includes('maj');
    const chordNotes = [root, root + (isMinor ? 3 : 4), root + 7, root + 12];
    const duration = (beatInMeasure === 0 ? 1.8 : 0.8) * sustain;
    chordNotes.forEach((midiNote, idx) => {
      if (!this.ctx) return;
      const freq = this.midiToFreq(midiNote);
      const osc = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const nodes: AudioNode[] = [];
      const noteTime = time + (type === 'piano' ? idx * 0.02 : 0);
      if (type === 'piano') {
        osc.type = 'triangle'; osc2.type = 'sine';
        this.envelope(gain, noteTime, 0.12 * (.72 + velocity * .28), duration, 0.006);
      } else if (type === 'strings') {
        osc.type = 'sawtooth'; osc2.type = 'sawtooth';
        osc2.detune.setValueAtTime(15, noteTime);
        this.envelope(gain, noteTime, 0.06 * (.72 + velocity * .28), duration, 0.3);
      } else {
        osc.type = 'sawtooth'; osc2.type = 'triangle';
        osc.detune.setValueAtTime(-10, noteTime);
        this.envelope(gain, noteTime, 0.08 * (.72 + velocity * .28), duration, 0.012);
      }
      osc.frequency.setValueAtTime(freq, noteTime);
      osc2.frequency.setValueAtTime(freq, noteTime);
      if (type === 'synth') {
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass'; filter.Q.value = 1.2 + brightness * 1.8;
        filter.frequency.setValueAtTime(850 + brightness * 3400, noteTime);
        filter.frequency.exponentialRampToValueAtTime(500 + brightness * 1300, noteTime + duration);
        osc.connect(filter); osc2.connect(filter); filter.connect(gain); nodes.push(filter);
      } else { osc.connect(gain); osc2.connect(gain); }
      // Rolled notes start when their envelope starts, never 20–60 ms early.
      this.voice([osc, osc2], gain, nodes, noteTime, duration);
    });
  }

  private playGuitarChord(chord: string, electric: boolean, time: number, velocity = .74, brightness = .58, sustain = 1) {
    if (!this.ctx || !this.mixGain) return;
    const root = this.getRootMidiNote(chord) + 12;
    const isMinor = chord.includes('m') && !chord.includes('maj');
    const notes = [root, root + (isMinor ? 3 : 4), root + 7, root + 12];
    notes.forEach((midi, index) => {
      if (!this.ctx) return;
      const noteTime = time + index * (electric ? .018 : .027);
      const duration = (electric ? .72 : .52) * sustain;
      const fundamental = this.ctx.createOscillator();
      const overtone = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();
      const frequency = this.midiToFreq(midi);
      fundamental.type = electric ? 'sawtooth' : 'triangle'; overtone.type = electric ? 'triangle' : 'sine';
      fundamental.frequency.setValueAtTime(frequency, noteTime);
      overtone.frequency.setValueAtTime(frequency * 2, noteTime); overtone.detune.value = electric ? -5 : 3;
      filter.type = 'lowpass'; filter.frequency.value = (electric ? 1650 : 2250) + brightness * 1700; filter.Q.value = electric ? 1.7 : .7;
      this.envelope(gain, noteTime, (electric ? .052 : .065) * velocity, duration, .003);
      const nodes: AudioNode[] = [filter];
      if (electric) {
        const drive = this.ctx.createWaveShaper();
        drive.curve = Float32Array.from({ length: 128 }, (_, i) => Math.tanh(((i / 127) * 2 - 1) * 1.7));
        drive.oversample = '2x';
        fundamental.connect(drive); overtone.connect(drive); drive.connect(filter); nodes.push(drive);
      } else { fundamental.connect(filter); overtone.connect(filter); }
      filter.connect(gain);
      this.voice([fundamental, overtone], gain, nodes, noteTime, duration);
    });
  }

  private playSitar(chord: string, time: number, degree: number, velocity: number, brightness = .58, sustain = 1) {
    if (!this.ctx || !this.mixGain) return;
    const root = this.getRootMidiNote(chord) + 24;
    const isMinor = chord.includes('m') && !chord.includes('maj');
    const scale = isMinor ? [0, 3, 5, 7, 10, 12] : [0, 2, 4, 7, 9, 12];
    const frequency = this.midiToFreq(root + scale[((degree % scale.length) + scale.length) % scale.length]);
    const duration = Math.max(.52, 60 / this.tempoBpm * 1.25) * sustain;
    const string = this.ctx.createOscillator();
    const overtone = this.ctx.createOscillator();
    const sympathetic = this.ctx.createOscillator();
    const stringLevel = this.ctx.createGain(); const overtoneLevel = this.ctx.createGain(); const sympatheticLevel = this.ctx.createGain();
    const bridge = this.ctx.createBiquadFilter(); const body = this.ctx.createBiquadFilter(); const gain = this.ctx.createGain();
    string.type = 'sawtooth'; overtone.type = 'triangle'; sympathetic.type = 'sine';
    const approach = degree % 2 ? .975 : 1.018;
    string.frequency.setValueAtTime(frequency * approach, time); string.frequency.exponentialRampToValueAtTime(frequency, time + .075);
    overtone.frequency.setValueAtTime(frequency * 2.01, time); sympathetic.frequency.setValueAtTime(this.midiToFreq(root + 7), time);
    stringLevel.gain.value = .68; overtoneLevel.gain.value = .2; sympatheticLevel.gain.value = .11;
    bridge.type = 'peaking'; bridge.frequency.value = 1050 + brightness * 950; bridge.Q.value = 7; bridge.gain.value = 9;
    body.type = 'lowpass'; body.frequency.value = 2600 + brightness * 2100; body.Q.value = .9;
    this.envelope(gain, time, .145 * velocity, duration, .0025);
    string.connect(stringLevel); overtone.connect(overtoneLevel); sympathetic.connect(sympatheticLevel);
    stringLevel.connect(bridge); overtoneLevel.connect(bridge); sympatheticLevel.connect(bridge); bridge.connect(body); body.connect(gain);
    this.voice([string, overtone, sympathetic], gain, [stringLevel, overtoneLevel, sympatheticLevel, bridge, body], time, duration);
  }

  private playLeadMelody(chord: string, instrument: string, time: number, degree: number, velocity: number, brightness = .58, sustain = 1, groove = '') {
    if (!this.ctx || !this.mixGain) return;
    const root = this.getRootMidiNote(chord) + 24;
    const isMinor = chord.includes('m') && !chord.includes('maj');
    const scale = isMinor ? [0, 3, 5, 7, 10, 12] : [0, 2, 4, 7, 9, 12];
    const freq = this.midiToFreq(root + scale[degree % scale.length]);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    let duration = Math.max(0.18, 60 / this.tempoBpm * (instrument === 'Strings' ? 1.8 : 0.7)) * sustain;
    const volume = 0.13 * velocity;
    let peak = volume, attack = 0.006;
    const sources: AudioScheduledSourceNode[] = [osc];
    const nodes: AudioNode[] = [filter];
    filter.type = 'lowpass'; filter.frequency.value = 1100 + brightness * 4800;

    const vibrato = (rate: number, depth: number) => {
      const lfo = this.ctx!.createOscillator();
      const amount = this.ctx!.createGain();
      lfo.frequency.value = rate; amount.gain.value = depth;
      lfo.connect(amount); amount.connect(osc.frequency);
      sources.push(lfo); nodes.push(amount);
    };
    if (instrument === 'Piano' || instrument === 'Synth') {
      osc.type = instrument === 'Piano' ? 'triangle' : groove === 'Electronic Vibe' ? 'sawtooth' : 'sine';
      if (instrument === 'Synth' && groove === 'Electronic Vibe') {
        const companion = this.ctx.createOscillator();
        companion.type = 'triangle'; companion.detune.value = 7;
        companion.frequency.setValueAtTime(freq, time);
        companion.connect(filter); sources.push(companion);
        peak *= .55; duration *= .8;
        filter.Q.value = 2.4;
        filter.frequency.setValueAtTime(900 + brightness * 3000, time);
        filter.frequency.exponentialRampToValueAtTime(500 + brightness * 1200, time + duration);
      }
    } else if (instrument === 'Flute') {
      osc.type = 'sine'; vibrato(6, 4);
      filter.type = 'bandpass'; filter.frequency.value = 1500;
      peak = volume * 0.8; attack = 0.05;
    } else if (instrument === 'Acoustic Guitar') {
      osc.type = 'triangle'; filter.type = 'lowpass'; filter.frequency.value = 2500 + brightness * 1200;
      peak = volume; duration *= .7;
    } else if (instrument === 'Electric Guitar') {
      osc.type = 'sawtooth'; filter.type = 'lowpass'; filter.frequency.value = 1400 + brightness * 1700; filter.Q.value = 1.6;
      const companion = this.ctx.createOscillator(); companion.type = 'triangle'; companion.detune.value = -7;
      companion.frequency.setValueAtTime(freq, time); companion.connect(filter); sources.push(companion);
      peak = volume * .72; duration *= .9;
    } else if (instrument === 'Violin' || instrument === 'Strings') {
      osc.type = 'sawtooth'; vibrato(7, 5);
      peak = volume * 0.6; attack = 0.1;
    } else if (instrument === 'Saxophone') {
      osc.type = 'sawtooth'; filter.type = 'bandpass'; filter.frequency.value = 760 + brightness * 850; filter.Q.value = .85;
      const reed = this.ctx.createOscillator(); reed.type = 'square'; reed.detune.value = -9;
      reed.frequency.setValueAtTime(freq, time); reed.connect(filter); sources.push(reed); vibrato(5.2, 2.2);
      peak = volume * .57; attack = .032; duration *= 1.15;
    } else if (instrument === 'Trumpet') {
      osc.type = 'sawtooth'; filter.type = 'lowpass'; filter.frequency.value = 1350 + brightness * 2100; filter.Q.value = 2;
      const brass = this.ctx.createOscillator(); brass.type = 'square'; brass.detune.value = 5;
      brass.frequency.setValueAtTime(freq, time); brass.connect(filter); sources.push(brass); vibrato(5.7, 1.5);
      peak = volume * .52; attack = .025; duration *= .95;
    } else {
      osc.type = 'sawtooth'; filter.type = 'bandpass';
      filter.frequency.setValueAtTime(800, time);
      filter.frequency.exponentialRampToValueAtTime(1600, time + duration);
      peak = volume * 0.8;
    }
    this.envelope(gain, time, peak, duration, attack);
    osc.frequency.setValueAtTime(freq, time);
    osc.connect(filter); filter.connect(gain);
    this.voice(sources, gain, nodes, time, duration);
  }
}

