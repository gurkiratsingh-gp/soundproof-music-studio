import type {
  KaraokeTrackAnalysis,
  KaraokeTrackProcessRequest,
  KaraokeTrackResult,
} from '../components/KaraokeTrackLab';
import {
  decodeArtistAudio,
  encodeStereoPcm16Wave,
  reduceCenterChannel,
  transposePitchPreservingDuration,
  type StereoPcm,
} from './karaokeTrack';

const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

type AnalysisResult = Pick<KaraokeTrackAnalysis, 'detectedKey' | 'keyConfidence' | 'bpm'>;

function abortIfNeeded(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Audio processing was cancelled.', 'AbortError');
}

function correlation(chroma: number[], profile: number[], root: number) {
  const chromaMean = chroma.reduce((sum, value) => sum + value, 0) / 12;
  const profileMean = profile.reduce((sum, value) => sum + value, 0) / 12;
  let numerator = 0; let chromaSquare = 0; let profileSquare = 0;
  for (let index = 0; index < 12; index++) {
    const left = chroma[(index + root) % 12] - chromaMean;
    const right = profile[index] - profileMean;
    numerator += left * right; chromaSquare += left * left; profileSquare += right * right;
  }
  return numerator / Math.max(1e-12, Math.sqrt(chromaSquare * profileSquare));
}

function estimateTempo(audio: StereoPcm) {
  const envelopeRate = 200;
  const block = Math.max(1, Math.round(audio.sampleRate / envelopeRate));
  const frames = Math.min(Math.floor(audio.left.length / block), envelopeRate * 90);
  if (frames < envelopeRate * 3) return 100;
  const onset = new Float32Array(frames);
  let previous = 0;
  for (let frame = 0; frame < frames; frame++) {
    let energy = 0;
    const first = frame * block; const last = Math.min(audio.left.length, first + block);
    for (let index = first; index < last; index++) energy += Math.abs((audio.left[index] + audio.right[index]) * .5);
    energy /= Math.max(1, last - first);
    onset[frame] = Math.max(0, energy - previous); previous = energy;
  }
  let bestBpm = 100; let bestScore = -1;
  for (let bpm = 60; bpm <= 180; bpm++) {
    const lag = Math.round(envelopeRate * 60 / bpm);
    let score = 0; let normalizer = 0;
    for (let index = lag; index < frames; index++) {
      score += onset[index] * onset[index - lag];
      normalizer += onset[index] * onset[index] + onset[index - lag] * onset[index - lag];
    }
    score /= Math.max(1e-12, normalizer * .5);
    // A small bias toward a singable mid-tempo interpretation avoids selecting
    // double-time from dense hi-hats when the two scores are nearly identical.
    score *= 1 - Math.abs(bpm - 110) / 2200;
    if (score > bestScore) { bestScore = score; bestBpm = bpm; }
  }
  return bestBpm;
}

async function estimateKeyAndTempo(
  audio: StereoPcm,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<AnalysisResult> {
  const targetAnalysisRate = 11_025;
  const step = Math.max(1, Math.round(audio.sampleRate / targetAnalysisRate));
  const analysisRate = audio.sampleRate / step;
  const windowFrames = Math.max(1024, Math.round(.7 * audio.sampleRate / step));
  const available = Math.max(1, Math.floor(audio.left.length / step) - windowFrames);
  const windows = Math.min(10, Math.max(3, Math.floor(audio.left.length / audio.sampleRate / 8)));
  const chroma = Array<number>(12).fill(0);

  for (let windowIndex = 0; windowIndex < windows; windowIndex++) {
    abortIfNeeded(signal);
    const position = windows === 1 ? 0 : Math.round(available * windowIndex / (windows - 1));
    const samples = new Float32Array(windowFrames);
    let mean = 0;
    for (let index = 0; index < windowFrames; index++) {
      const source = Math.min(audio.left.length - 1, (position + index) * step);
      const value = (audio.left[source] + audio.right[source]) * .5;
      samples[index] = value; mean += value;
    }
    mean /= windowFrames;
    for (let midi = 36; midi <= 83; midi++) {
      const frequency = 440 * 2 ** ((midi - 69) / 12);
      const omega = 2 * Math.PI * frequency / analysisRate;
      const coefficient = 2 * Math.cos(omega);
      let first = 0; let second = 0;
      for (let index = 0; index < windowFrames; index++) {
        const hann = .5 - .5 * Math.cos(2 * Math.PI * index / Math.max(1, windowFrames - 1));
        const next = (samples[index] - mean) * hann + coefficient * first - second;
        second = first; first = next;
      }
      const power = Math.max(0, first * first + second * second - coefficient * first * second);
      chroma[midi % 12] += Math.log1p(power) / Math.sqrt(frequency);
    }
    onProgress((windowIndex + 1) / windows);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }

  const total = chroma.reduce((sum, value) => sum + value, 0);
  const bpm = estimateTempo(audio);
  if (!Number.isFinite(total) || total < 1e-7) return { bpm };
  const candidates: { key: string; score: number }[] = [];
  for (let root = 0; root < 12; root++) {
    candidates.push({ key: `${ROOTS[root]} major`, score: correlation(chroma, MAJOR_PROFILE, root) });
    candidates.push({ key: `${ROOTS[root]} minor`, score: correlation(chroma, MINOR_PROFILE, root) });
  }
  candidates.sort((left, right) => right.score - left.score);
  const lead = Math.max(0, candidates[0].score - candidates[1].score);
  const confidence = Math.max(.18, Math.min(.86, .3 + lead * 1.8 + Math.max(0, candidates[0].score) * .18));
  return { detectedKey: candidates[0].key, keyConfidence: confidence, bpm };
}

function suggestedName(name: string, semitones: number) {
  const base = name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 80) || 'song';
  const shift = semitones ? `-${semitones > 0 ? 'plus' : 'minus'}-${Math.abs(semitones)}` : '';
  return `${base}-karaoke${shift}.wav`;
}

/** Process a user-selected song entirely in the browser. */
export async function processKaraokeTrack({ file, options, signal, onProgress }: KaraokeTrackProcessRequest): Promise<KaraokeTrackResult> {
  abortIfNeeded(signal);
  onProgress({ stage: 'analyzing', percent: 4, message: 'Decoding the stereo mix in this browser.' });
  let working = await decodeArtistAudio(file, file.name);
  abortIfNeeded(signal);
  const durationSeconds = working.left.length / working.sampleRate;
  const analysis = await estimateKeyAndTempo(working, signal, fraction => onProgress({
    stage: 'analyzing', percent: 12 + fraction * 18,
    message: 'Estimating the musical key and tempo. You can override the key.',
  }));

  abortIfNeeded(signal);
  onProgress({ stage: 'separating', percent: 34, message: 'Reducing audio shared by the left and right channels.' });
  working = reduceCenterChannel(working, {
    reduction: Math.max(0, Math.min(1, options.vocalReduction / 100)),
    bassPreservation: options.preserveBass ? .68 : 0,
    targetPeak: .9,
    maxBoost: 1.7,
  });
  abortIfNeeded(signal);
  onProgress({ stage: 'separating', percent: 54, message: 'Centered lead vocal reduced; stereo instruments retained.' });

  onProgress({ stage: 'pitching', percent: 58, message: options.semitoneShift ? 'Pitch-shifting while keeping the song length.' : 'Keeping the original pitch and timing.' });
  if (options.semitoneShift) {
    working = await transposePitchPreservingDuration(working, options.semitoneShift, {
      signal,
      targetPeak: .9,
      maxBoost: 1.2,
      onProgress: fraction => onProgress({ stage: 'pitching', percent: 58 + fraction * 32, message: 'Pitch-shifting while keeping the song length.' }),
    });
  }
  abortIfNeeded(signal);
  onProgress({ stage: 'rendering', percent: 94, message: 'Encoding a playable stereo WAV.' });
  const wav = encodeStereoPcm16Wave(working);
  abortIfNeeded(signal);
  onProgress({ stage: 'rendering', percent: 100, message: 'Your karaoke backing is ready.' });
  return {
    wav,
    analysis: {
      ...analysis,
      durationSeconds,
      sampleRate: working.sampleRate,
      channels: 2,
      qualityNote: 'Key and tempo are local estimates. Centered instruments may soften, and reverb or off-center vocals may remain.',
    },
    suggestedFilename: suggestedName(file.name, options.semitoneShift),
  };
}
