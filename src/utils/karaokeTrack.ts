/** Browser-local processing for a user-supplied stereo song. No samples leave the device. */
export const ARTIST_AUDIO_LIMITS = Object.freeze({
  maxFileBytes: 50 * 1024 * 1024,
  minDurationSeconds: 1,
  maxDurationSeconds: 5 * 60,
  minSampleRate: 8_000,
  maxSampleRate: 96_000,
  maxDecodedPcmBytes: 128 * 1024 * 1024,
  maxTransposeSemitones: 12,
});

export type ArtistAudioErrorCode =
  | 'empty-file' | 'file-too-large' | 'unsupported-file' | 'decode-unavailable'
  | 'decode-failed' | 'mono-audio' | 'duration-out-of-range' | 'sample-rate-out-of-range'
  | 'decoded-audio-too-large' | 'invalid-pcm' | 'invalid-key' | 'unsupported-key-change'
  | 'transpose-out-of-range' | 'cancelled';

export class ArtistAudioError extends Error {
  constructor(public readonly code: ArtistAudioErrorCode, message: string) { super(message); this.name = 'ArtistAudioError'; }
}

export interface StereoPcm {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}

export interface ArtistAudioDescriptor { size: number; type?: string; name?: string }

const extensions = new Set(['wav', 'mp3', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'webm', 'flac']);

/** Fast checks suitable for a file picker. Decoding remains the authoritative codec check. */
export function validateArtistAudioDescriptor(file: ArtistAudioDescriptor): void {
  if (!Number.isFinite(file.size) || file.size <= 0) throw new ArtistAudioError('empty-file', 'Choose a non-empty audio file.');
  if (file.size > ARTIST_AUDIO_LIMITS.maxFileBytes) throw new ArtistAudioError('file-too-large', 'Choose an audio file no larger than 50 MB.');
  const type = (file.type || '').toLowerCase().split(';')[0].trim();
  const extension = (file.name || '').split('.').pop()?.toLowerCase() || '';
  if ((type && !type.startsWith('audio/')) || (!type && file.name && !extensions.has(extension))) {
    throw new ArtistAudioError('unsupported-file', 'Choose a WAV, MP3, M4A, AAC, Ogg, WebM, or FLAC audio file.');
  }
}

export function validateStereoPcm(audio: StereoPcm): void {
  if (!(audio.left instanceof Float32Array) || !(audio.right instanceof Float32Array) || !audio.left.length || audio.left.length !== audio.right.length ||
      !Number.isFinite(audio.sampleRate) || audio.sampleRate < 1_000 || audio.sampleRate > 384_000) {
    throw new ArtistAudioError('invalid-pcm', 'The decoded stereo audio is invalid.');
  }
}

/** Decode and copy exactly two channels so downstream processing has stable stereo PCM. */
export async function decodeArtistAudio(file: Blob, fileName = ''): Promise<StereoPcm> {
  validateArtistAudioDescriptor({ size: file.size, type: file.type, name: fileName || ('name' in file ? String((file as File).name || '') : '') });
  const scope = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const Context = scope.AudioContext || scope.webkitAudioContext;
  if (!Context) throw new ArtistAudioError('decode-unavailable', 'This browser cannot decode audio. Try a current Chrome, Edge, or Safari browser.');
  const context = new Context();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (decoded.numberOfChannels !== 2) throw new ArtistAudioError('mono-audio', 'Choose a stereo version of the song. Vocal reduction needs distinct left and right channels.');
    if (!Number.isFinite(decoded.duration) || decoded.duration < ARTIST_AUDIO_LIMITS.minDurationSeconds || decoded.duration > ARTIST_AUDIO_LIMITS.maxDurationSeconds) {
      throw new ArtistAudioError('duration-out-of-range', 'Choose a stereo song between 1 second and 5 minutes long.');
    }
    if (decoded.sampleRate < ARTIST_AUDIO_LIMITS.minSampleRate || decoded.sampleRate > ARTIST_AUDIO_LIMITS.maxSampleRate) {
      throw new ArtistAudioError('sample-rate-out-of-range', 'Choose audio with a sample rate from 8 kHz to 96 kHz.');
    }
    if (decoded.length * 2 * Float32Array.BYTES_PER_ELEMENT > ARTIST_AUDIO_LIMITS.maxDecodedPcmBytes) {
      throw new ArtistAudioError('decoded-audio-too-large', 'This song expands to too much audio data for safe browser processing. Try a shorter or 44.1/48 kHz file.');
    }
    return { sampleRate: decoded.sampleRate, left: new Float32Array(decoded.getChannelData(0)), right: new Float32Array(decoded.getChannelData(1)) };
  } catch (error) {
    if (error instanceof ArtistAudioError) throw error;
    throw new ArtistAudioError('decode-failed', 'This audio could not be decoded. Try WAV, MP3, M4A, AAC, Ogg, WebM, or FLAC in a current browser.');
  } finally { await context.close().catch(() => {}); }
}

const finiteSample = (value: number) => Number.isFinite(value) ? Math.max(-4, Math.min(4, value)) : 0;
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

function finishAudio(left: Float32Array, right: Float32Array, sampleRate: number, options: { targetPeak?: number; maxBoost?: number; fadeMs?: number } = {}): StereoPcm {
  const fadeFrames = Math.min(Math.floor(left.length / 2), Math.max(0, Math.round(sampleRate * clamp(options.fadeMs ?? 12, 0, 250) / 1000)));
  let peak = 0;
  for (let index = 0; index < left.length; index++) {
    let fade = 1;
    if (fadeFrames && index < fadeFrames) fade = Math.sin(index / fadeFrames * Math.PI / 2) ** 2;
    else if (fadeFrames && index >= left.length - fadeFrames) fade = Math.sin((left.length - 1 - index) / fadeFrames * Math.PI / 2) ** 2;
    left[index] = finiteSample(left[index]) * fade;
    right[index] = finiteSample(right[index]) * fade;
    peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
  }
  const target = clamp(options.targetPeak ?? .92, .1, .98);
  const gain = peak > 1e-9 ? Math.min(clamp(options.maxBoost ?? 2.5, 1, 4), target / peak) : 1;
  for (let index = 0; index < left.length; index++) { left[index] *= gain; right[index] *= gain; }
  return { sampleRate, left, right };
}

export interface CenterReductionOptions {
  /** 0 keeps the center, 1 performs full mid cancellation. Default 1. */
  reduction?: number;
  /** Amount of low-frequency center restored after cancellation. 0 disables it. Default .65. */
  bassPreservation?: number;
  bassCutoffHz?: number;
  targetPeak?: number;
  maxBoost?: number;
  fadeMs?: number;
}

/**
 * Reduce centered vocals with mid/side subtraction. Stereo-only side content is
 * retained; an optional low-passed center restores kick and bass fundamentals.
 */
export function reduceCenterChannel(audio: StereoPcm, options: CenterReductionOptions = {}): StereoPcm {
  validateStereoPcm(audio);
  const reduction = clamp(options.reduction ?? 1, 0, 1);
  const bassPreservation = clamp(options.bassPreservation ?? .65, 0, 1);
  const cutoff = clamp(options.bassCutoffHz ?? 140, 50, Math.min(320, audio.sampleRate * .4));
  const smoothing = 1 - Math.exp(-2 * Math.PI * cutoff / audio.sampleRate);
  const left = new Float32Array(audio.left.length); const right = new Float32Array(audio.right.length);
  let bass = 0;
  for (let index = 0; index < left.length; index++) {
    const sourceLeft = finiteSample(audio.left[index]); const sourceRight = finiteSample(audio.right[index]);
    const middle = (sourceLeft + sourceRight) * .5; const side = (sourceLeft - sourceRight) * .5;
    bass += smoothing * (middle - bass);
    const retainedCenter = middle * (1 - reduction) + bass * bassPreservation * reduction;
    left[index] = side + retainedCenter; right[index] = -side + retainedCenter;
  }
  return finishAudio(left, right, audio.sampleRate, options);
}

export interface PitchTransposeOptions {
  grainMs?: number;
  overlap?: number;
  targetPeak?: number;
  maxBoost?: number;
  fadeMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

const cancelled = () => new ArtistAudioError('cancelled', 'Audio processing was cancelled.');
const interpolate = (data: Float32Array, position: number) => {
  const lower = Math.floor(position); const fraction = position - lower;
  const first = finiteSample(data[lower]); const second = finiteSample(data[Math.min(data.length - 1, lower + 1)]);
  return first + (second - first) * fraction;
};
const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * Pitch-shift with synchronous stereo grains and Hann-window overlap/add.
 * Grain centers follow the original timeline, so output length and broad tempo
 * remain unchanged while samples inside each grain are read at the pitch ratio.
 */
export async function transposePitchPreservingDuration(audio: StereoPcm, semitones: number, options: PitchTransposeOptions = {}): Promise<StereoPcm> {
  validateStereoPcm(audio);
  if (!Number.isFinite(semitones) || Math.abs(semitones) > ARTIST_AUDIO_LIMITS.maxTransposeSemitones) {
    throw new ArtistAudioError('transpose-out-of-range', 'Transpose by no more than 12 semitones up or down.');
  }
  if (options.signal?.aborted) throw cancelled();
  if (Math.abs(semitones) < .001) return finishAudio(new Float32Array(audio.left), new Float32Array(audio.right), audio.sampleRate, { ...options, maxBoost: options.maxBoost ?? 1 });

  const ratio = 2 ** (semitones / 12);
  const grainMs = clamp(options.grainMs ?? 46, 20, 100);
  let grainSize = Math.max(256, Math.round(audio.sampleRate * grainMs / 1000));
  if (grainSize % 2) grainSize++;
  const overlap = Math.round(clamp(options.overlap ?? 4, 2, 8));
  const hop = Math.max(1, Math.floor(grainSize / overlap)); const half = grainSize / 2;
  const centers: number[] = [];
  for (let center = 0; center < audio.left.length; center += hop) centers.push(center);
  if (centers[centers.length - 1] !== audio.left.length - 1) centers.push(audio.left.length - 1);
  const left = new Float32Array(audio.left.length); const right = new Float32Array(audio.right.length);
  options.onProgress?.(0);

  for (let grain = 0; grain < centers.length; grain++) {
    if (options.signal?.aborted) throw cancelled();
    const center = centers[grain]; const first = Math.max(0, Math.ceil(center - half)); const last = Math.min(left.length - 1, Math.floor(center + half));
    for (let outputIndex = first; outputIndex <= last; outputIndex++) {
      const relative = outputIndex - center; const sourcePosition = center + relative * ratio;
      if (sourcePosition < 0 || sourcePosition > audio.left.length - 1) continue;
      const phase = (relative + half) / grainSize;
      const window = .5 - .5 * Math.cos(2 * Math.PI * clamp(phase, 0, 1));
      left[outputIndex] += interpolate(audio.left, sourcePosition) * window;
      right[outputIndex] += interpolate(audio.right, sourcePosition) * window;
    }
    if (grain && grain % 128 === 0) { options.onProgress?.(grain / centers.length); await yieldToBrowser(); }
  }

  // Recompute the small overlap weight per output frame instead of retaining a
  // full third song-sized buffer, which saves substantial memory on mobile.
  let firstCenter = 0;
  for (let outputIndex = 0; outputIndex < left.length; outputIndex++) {
    while (firstCenter + 1 < centers.length && centers[firstCenter] < outputIndex - half) firstCenter++;
    let weight = 0;
    for (let grain = Math.max(0, firstCenter - 1); grain < centers.length && centers[grain] <= outputIndex + half; grain++) {
      const center = centers[grain]; const relative = outputIndex - center; const sourcePosition = center + relative * ratio;
      if (Math.abs(relative) > half || sourcePosition < 0 || sourcePosition > audio.left.length - 1) continue;
      const phase = (relative + half) / grainSize;
      weight += .5 - .5 * Math.cos(2 * Math.PI * clamp(phase, 0, 1));
    }
    if (weight > 1e-7) { left[outputIndex] /= weight; right[outputIndex] /= weight; }
  }
  if (options.signal?.aborted) throw cancelled();
  options.onProgress?.(1);
  return finishAudio(left, right, audio.sampleRate, { ...options, maxBoost: options.maxBoost ?? 1.25 });
}

const pitchClasses: Record<string, number> = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11 };

function parseKey(value: string) {
  const match = /^\s*([A-Ga-g])([#b]?)(?:\s+(major|minor))?\s*$/i.exec(value);
  if (!match) throw new ArtistAudioError('invalid-key', 'Use a key such as C major, F# minor, or Bb major.');
  const root = `${match[1].toUpperCase()}${match[2]}`.toUpperCase();
  return { pitch: pitchClasses[root], mode: match[3]?.toLowerCase() || '' };
}

/** Shortest global pitch shift between two compatible major/minor keys. */
export function semitonesBetweenKeys(sourceKey: string, targetKey: string): number {
  const source = parseKey(sourceKey); const target = parseKey(targetKey);
  if (source.mode && target.mode && source.mode !== target.mode) {
    throw new ArtistAudioError('unsupported-key-change', 'Pitch shifting can move the root key, but it cannot turn a major arrangement into minor or minor into major.');
  }
  let distance = (target.pitch - source.pitch + 12) % 12;
  if (distance > 6) distance -= 12;
  return distance;
}

export async function transposeBetweenKeys(audio: StereoPcm, sourceKey: string, targetKey: string, options: PitchTransposeOptions = {}) {
  const semitones = semitonesBetweenKeys(sourceKey, targetKey);
  return { audio: await transposePitchPreservingDuration(audio, semitones, options), semitones };
}

/** Encode interleaved stereo, signed 16-bit little-endian PCM in a RIFF/WAVE container. */
export function encodeStereoPcm16Wave(audio: StereoPcm): Blob {
  validateStereoPcm(audio);
  const dataBytes = audio.left.length * 4;
  if (dataBytes + 36 > 0xffffffff) throw new ArtistAudioError('invalid-pcm', 'This audio is too long for a standard PCM WAV file.');
  const output = new ArrayBuffer(44 + dataBytes); const view = new DataView(output);
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, 'RIFF'); view.setUint32(4, output.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let index = 0; index < audio.left.length; index++) for (const source of [audio.left, audio.right]) {
    const sample = clamp(finiteSample(source[index]), -1, 1);
    view.setInt16(offset, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true); offset += 2;
  }
  return new Blob([output], { type: 'audio/wav' });
}

