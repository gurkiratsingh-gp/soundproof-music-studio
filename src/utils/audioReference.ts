export type AudioReferenceAnalysis = {
  duration: number;
  bpm: number;
  bpmConfidence: number;
  pitchClass?: string;
  pitchConfidence: number;
};

const PITCHES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function downsample(input: Float32Array, sourceRate: number, targetRate = 11025) {
  if (sourceRate <= targetRate) return { data: input, sampleRate: sourceRate };
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index++) {
    const from = Math.floor(index * ratio); const to = Math.max(from + 1, Math.floor((index + 1) * ratio)); let sum = 0;
    for (let source = from; source < Math.min(input.length, to); source++) sum += input[source];
    output[index] = sum / Math.max(1, to - from);
  }
  return { data: output, sampleRate: targetRate };
}

function estimateTempo(data: Float32Array, sampleRate: number) {
  const hop = 512; const frame = 1024; const energy: number[] = [];
  for (let start = 0; start + frame < data.length; start += hop) {
    let sum = 0; for (let index = start; index < start + frame; index++) sum += data[index] * data[index];
    energy.push(Math.sqrt(sum / frame));
  }
  const novelty = energy.map((value, index) => index ? Math.max(0, value - energy[index - 1] * .96) : 0);
  const mean = novelty.reduce((sum, value) => sum + value, 0) / Math.max(1, novelty.length);
  const centered = novelty.map(value => Math.max(0, value - mean * .65));
  let bestBpm = 96; let bestLag = 0; let bestScore = 0;
  for (let bpm = 55; bpm <= 190; bpm++) {
    const lag = Math.round(60 * sampleRate / hop / bpm); let cross = 0; let left = 0; let right = 0;
    for (let index = lag; index < centered.length; index++) { const a = centered[index]; const b = centered[index - lag]; cross += a * b; left += a * a; right += b * b; }
    const score = cross / Math.sqrt(Math.max(1e-12, left * right));
    if (score > bestScore) { bestScore = score; bestBpm = bpm; bestLag = lag; }
  }
  // Very sparse vocals do not contain a trustworthy pulse. A neutral tempo is
  // safer than presenting random noise as a confident measurement.
  if (bestScore >= .08 && bestLag) bestBpm = Math.round(60 * sampleRate / hop / bestLag);
  return { bpm: bestScore < .08 ? 96 : Math.max(55, Math.min(190, bestBpm)), confidence: Math.max(0, Math.min(1, bestScore)) };
}

function estimatePitch(data: Float32Array, sampleRate: number) {
  const frame = 4096; const usable = Math.min(data.length, sampleRate * 45); const votes = new Array(12).fill(0) as number[];
  let confidenceTotal = 0; let windows = 0;
  for (let part = 0; part < 14; part++) {
    const start = Math.floor((usable - frame) * (part + 1) / 15); if (start < 0 || start + frame > data.length) continue;
    let mean = 0; for (let index = 0; index < frame; index++) mean += data[start + index]; mean /= frame;
    let energy = 0; for (let index = 0; index < frame; index++) { const value = data[start + index] - mean; energy += value * value; }
    const rms = Math.sqrt(energy / frame); if (rms < .008) continue;
    const minLag = Math.floor(sampleRate / 520); const maxLag = Math.min(Math.floor(sampleRate / 75), frame / 2);
    let bestLag = 0; let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let cross = 0; let left = 0; let right = 0;
      for (let index = 0; index < frame - lag; index++) { const a = data[start + index] - mean; const b = data[start + index + lag] - mean; cross += a * b; left += a * a; right += b * b; }
      const correlation = cross / Math.sqrt(Math.max(1e-12, left * right));
      if (correlation > best) { best = correlation; bestLag = lag; }
    }
    if (!bestLag || best < .35) continue;
    const frequency = sampleRate / bestLag; const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
    votes[((midi % 12) + 12) % 12] += best * rms; confidenceTotal += best; windows++;
  }
  const pitchIndex = votes.indexOf(Math.max(...votes));
  return { pitchClass: windows && votes[pitchIndex] > 0 ? PITCHES[pitchIndex] : undefined, confidence: windows ? Math.max(0, Math.min(1, confidenceTotal / windows)) : 0 };
}

export function analyzePcm(input: Float32Array, sampleRate: number, duration = input.length / sampleRate): AudioReferenceAnalysis {
  const { data, sampleRate: reducedRate } = downsample(input, sampleRate);
  const tempo = estimateTempo(data, reducedRate); const pitch = estimatePitch(data, reducedRate);
  return { duration, bpm: tempo.bpm, bpmConfidence: tempo.confidence, pitchClass: pitch.pitchClass, pitchConfidence: pitch.confidence };
}

export async function analyzeAudioReference(blob: Blob): Promise<AudioReferenceAnalysis> {
  if (!blob.size || blob.size > 25 * 1024 * 1024) throw new Error('Choose an audio file smaller than 25 MB.');
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('This browser cannot analyze audio. Try a current Chrome or Edge browser.');
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (!Number.isFinite(decoded.duration) || decoded.duration < .5) throw new Error('Choose a recording longer than half a second.');
    if (decoded.duration > 300) throw new Error('Choose a recording no longer than five minutes.');
    return analyzePcm(decoded.getChannelData(0), decoded.sampleRate, decoded.duration);
  } catch (error) {
    if (error instanceof Error && /Choose a recording/.test(error.message)) throw error;
    throw new Error('This audio could not be read. Try WAV, MP3, M4A, Ogg, or WebM in Chrome or Edge.');
  } finally { await context.close().catch(() => {}); }
}
