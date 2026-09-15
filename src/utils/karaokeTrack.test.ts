import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIST_AUDIO_LIMITS, ArtistAudioError, encodeStereoPcm16Wave, reduceCenterChannel,
  semitonesBetweenKeys, transposePitchPreservingDuration, validateArtistAudioDescriptor,
  type StereoPcm,
} from './karaokeTrack';

const tone = (frequency: number, seconds = 1, sampleRate = 8_000, amplitude = .5) =>
  Float32Array.from({ length: Math.floor(seconds * sampleRate) }, (_, index) => Math.sin(2 * Math.PI * frequency * index / sampleRate) * amplitude);
const stereo = (left: Float32Array, right = new Float32Array(left), sampleRate = 8_000): StereoPcm => ({ sampleRate, left, right });
const rms = (data: Float32Array, start = 0) => Math.sqrt(data.slice(start).reduce((sum, value) => sum + value * value, 0) / Math.max(1, data.length - start));

test('artist-song validation rejects empty, oversized and non-audio files before decoding', () => {
  assert.throws(() => validateArtistAudioDescriptor({ size: 0, name: 'empty.wav', type: 'audio/wav' }), (error: unknown) => error instanceof ArtistAudioError && error.code === 'empty-file');
  assert.throws(() => validateArtistAudioDescriptor({ size: ARTIST_AUDIO_LIMITS.maxFileBytes + 1, name: 'huge.wav', type: 'audio/wav' }), (error: unknown) => error instanceof ArtistAudioError && error.code === 'file-too-large');
  assert.throws(() => validateArtistAudioDescriptor({ size: 10, name: 'notes.txt', type: 'text/plain' }), (error: unknown) => error instanceof ArtistAudioError && error.code === 'unsupported-file');
  assert.doesNotThrow(() => validateArtistAudioDescriptor({ size: 10, name: 'song.MP3' }));
});

test('L-R reduction cancels centered content, retains stereo sides and can preserve centered bass', () => {
  const center = tone(440); const side = tone(220, 1, 8_000, .2);
  const left = Float32Array.from(center, (value, index) => value + side[index]);
  const right = Float32Array.from(center, (value, index) => value - side[index]);
  const reduced = reduceCenterChannel(stereo(left, right), { bassPreservation: 0, maxBoost: 1, fadeMs: 0 });
  assert.ok(rms(reduced.left) > .12);
  for (let index = 50; index < 100; index++) assert.ok(Math.abs(reduced.left[index] + reduced.right[index]) < 1e-6);
  const centered = reduceCenterChannel(stereo(center), { bassPreservation: 0, maxBoost: 1, fadeMs: 0 });
  assert.ok(rms(centered.left) < 1e-7);

  const low = reduceCenterChannel(stereo(tone(80)), { bassPreservation: .8, bassCutoffHz: 140, maxBoost: 1, fadeMs: 0 });
  const high = reduceCenterChannel(stereo(tone(1_200)), { bassPreservation: .8, bassCutoffHz: 140, maxBoost: 1, fadeMs: 0 });
  assert.ok(rms(low.left, 1_600) > rms(high.left, 1_600) * 5);
});

test('processed audio is finite, peak-safe and faded at both edges', () => {
  const left = Float32Array.from({ length: 2_000 }, (_, index) => index === 700 ? Number.NaN : index % 2 ? 3 : -3);
  const result = reduceCenterChannel(stereo(left, Float32Array.from(left, value => -value)), { bassPreservation: 0, targetPeak: .8, fadeMs: 20 });
  const peak = Math.max(...result.left.map(value => Math.abs(value)), ...result.right.map(value => Math.abs(value)));
  assert.ok(result.left.every(Number.isFinite));
  assert.ok(peak <= .800001);
  assert.equal(Math.abs(result.left[0]), 0); assert.equal(Math.abs(result.left[result.left.length - 1]), 0);
});

function strongestFrequency(data: Float32Array, sampleRate: number) {
  let winner = 0; let best = -Infinity;
  for (let frequency = 650; frequency <= 1_050; frequency += 5) {
    let real = 0; let imaginary = 0;
    for (let index = 800; index < data.length - 800; index++) {
      const angle = 2 * Math.PI * frequency * index / sampleRate;
      real += data[index] * Math.cos(angle); imaginary -= data[index] * Math.sin(angle);
    }
    const power = real * real + imaginary * imaginary;
    if (power > best) { best = power; winner = frequency; }
  }
  return winner;
}

test('granular OLA transposes pitch while preserving frame count and broad tempo', async () => {
  const input = stereo(tone(440, 1.5)); const progress: number[] = [];
  const shifted = await transposePitchPreservingDuration(input, 12, { fadeMs: 5, onProgress: value => progress.push(value) });
  assert.equal(shifted.left.length, input.left.length);
  assert.equal(shifted.right.length, input.right.length);
  assert.ok(Math.abs(strongestFrequency(shifted.left, shifted.sampleRate) - 880) <= 20);
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), 1);
  assert.ok(Math.max(...shifted.left.map(value => Math.abs(value))) <= .920001);
});

test('key helpers choose the shortest compatible root transposition', () => {
  assert.equal(semitonesBetweenKeys('C major', 'D major'), 2);
  assert.equal(semitonesBetweenKeys('B major', 'C major'), 1);
  assert.equal(semitonesBetweenKeys('C major', 'B major'), -1);
  assert.equal(semitonesBetweenKeys('F# minor', 'Bb minor'), 4);
  assert.throws(() => semitonesBetweenKeys('C major', 'C minor'), (error: unknown) => error instanceof ArtistAudioError && error.code === 'unsupported-key-change');
});

test('PCM WAV export writes a stereo 16-bit header and interleaves safely', async () => {
  const blob = encodeStereoPcm16Wave(stereo(Float32Array.from([-2, .5]), Float32Array.from([2, -.5])));
  const bytes = new Uint8Array(await blob.arrayBuffer()); const view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(22, true), 2); assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getInt16(44, true), -32768); assert.equal(view.getInt16(46, true), 32767);
  assert.equal(view.getInt16(48, true), Math.round(.5 * 32767)); assert.equal(view.getInt16(50, true), -16384);
});
