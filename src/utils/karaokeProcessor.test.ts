import test from 'node:test';
import assert from 'node:assert/strict';
import { processKaraokeTrack } from './karaokeProcessor';

test('karaoke processor runs every local stage and returns playable metadata', async () => {
  const sampleRate = 8_000; const length = sampleRate * 4;
  const left = new Float32Array(length); const right = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const time = index / sampleRate;
    const center = Math.sin(2 * Math.PI * 220 * time) * .24;
    const side = Math.sin(2 * Math.PI * 261.63 * time) * .18;
    const pulse = index % Math.round(sampleRate * .5) < 80 ? .15 : 0;
    left[index] = center + side + pulse; right[index] = center - side + pulse;
  }

  const previous = globalThis.AudioContext;
  class FakeAudioContext {
    decodeAudioData = async () => ({
      numberOfChannels: 2,
      duration: length / sampleRate,
      sampleRate,
      length,
      getChannelData: (channel: number) => channel === 0 ? left : right,
    }) as AudioBuffer;
    close = async () => {};
  }
  Object.assign(globalThis, { AudioContext: FakeAudioContext });
  try {
    const progress: { stage: string; percent: number }[] = [];
    const file = new File([new Uint8Array([82, 73, 70, 70])], 'practice.wav', { type: 'audio/wav' });
    const output = await processKaraokeTrack({
      file,
      options: { originalKey: 'C major', semitoneShift: 2, vocalReduction: 85, preserveBass: true },
      signal: new AbortController().signal,
      onProgress: update => progress.push(update),
    });

    assert.deepEqual([...new Set(progress.map(item => item.stage))], ['analyzing', 'separating', 'pitching', 'rendering']);
    assert.ok(progress.every((item, index) => index === 0 || item.percent >= progress[index - 1].percent));
    assert.equal(progress.at(-1)?.percent, 100);
    assert.equal(output.wav.type, 'audio/wav');
    assert.ok(output.wav.size > 44);
    assert.equal(output.analysis.durationSeconds, 4);
    assert.equal(output.analysis.sampleRate, sampleRate);
    assert.equal(output.analysis.channels, 2);
    assert.ok((output.analysis.bpm || 0) >= 40 && (output.analysis.bpm || 0) <= 240);
    assert.match(output.analysis.detectedKey || '', /^[A-G](?:#|b)? (?:major|minor)$/);
    assert.match(output.suggestedFilename || '', /karaoke-plus-2\.wav$/);
  } finally {
    Object.assign(globalThis, { AudioContext: previous });
  }
});

