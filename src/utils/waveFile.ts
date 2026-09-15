export function encodeWave(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const output = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(output);
  const write = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, output.byteLength - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const sample = Math.max(-1, Math.min(1, data[channel][frame]));
    view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true); offset += 2;
  }
  return new Blob([output], { type: 'audio/wav' });
}

export function waveformPeaks(buffer: AudioBuffer, bars = 72): number[] {
  const data = buffer.getChannelData(0);
  const width = Math.max(1, Math.floor(data.length / bars));
  return Array.from({ length: bars }, (_, bar) => {
    let peak = 0;
    for (let index = bar * width; index < Math.min(data.length, (bar + 1) * width); index++) peak = Math.max(peak, Math.abs(data[index]));
    return peak;
  });
}
