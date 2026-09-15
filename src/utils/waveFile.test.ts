import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWave, waveformPeaks } from './waveFile';

const fakeBuffer = (channels: number[][], sampleRate = 8000) => ({
  numberOfChannels: channels.length,
  length: channels[0].length,
  sampleRate,
  getChannelData: (channel: number) => Float32Array.from(channels[channel]),
}) as AudioBuffer;

test('WAV export writes a valid PCM header and clamps samples', async () => {
  const blob = encodeWave(fakeBuffer([[-2, -.5, 0, .5, 2]]));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(52, true), 32767);
});

test('waveform peaks summarize the strongest sample in each visual bar', () => {
  const peaks = waveformPeaks(fakeBuffer([[0, .2, -.8, .1, .4, -.3]]), 3);
  assert.deepEqual(peaks.map(value => Number(value.toFixed(2))), [.2, .8, .4]);
});
