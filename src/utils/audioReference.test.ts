import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePcm } from './audioReference';

test('audio reference analysis finds a steady sung pitch and repeating pulse', () => {
  const sampleRate = 11025; const duration = 8; const samples = new Float32Array(sampleRate * duration);
  for (let index = 0; index < samples.length; index++) {
    const time = index / sampleRate; const beatPhase = time % .5;
    const envelope = .16 + .55 * Math.exp(-beatPhase * 35);
    samples[index] = Math.sin(2 * Math.PI * 220 * time) * envelope;
  }
  const result = analyzePcm(samples, sampleRate);
  assert.ok(Math.abs(result.bpm - 120) <= 3, `expected about 120 BPM, received ${result.bpm}`);
  assert.equal(result.pitchClass, 'A');
  assert.ok(result.pitchConfidence > .5);
});

test('audio reference analysis labels silent audio as uncertain', () => {
  const result = analyzePcm(new Float32Array(11025 * 2), 11025);
  assert.equal(result.bpm, 96);
  assert.equal(result.pitchClass, undefined);
  assert.equal(result.pitchConfidence, 0);
});
