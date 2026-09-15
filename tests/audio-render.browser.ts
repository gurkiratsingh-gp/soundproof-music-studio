import { AudioEngine } from '../src/utils/audioEngine';
import { createArrangement } from '../src/utils/songArrangement';
import { initialSongs } from '../src/utils/initialSongs';
import { INSTRUMENTS } from '../src/utils/songDraft';

const baseline = new URLSearchParams(location.search).has('baseline');
const cases = [
  { name: 'piano-attacks', genre: 'Pop', bpm: 120, instruments: ['Piano'], isolated: true },
  { name: 'pop-full-mix', genre: 'Pop', bpm: 112, instruments: ['Piano', 'Synth', 'Drums', 'Bass'] },
  { name: 'fast-rock-mix', genre: 'Rock', bpm: 240, instruments: ['Piano', 'Drums', 'Bass'] },
  { name: 'electronic-mix', genre: 'Electronic', bpm: 140, instruments: ['Synth', 'Drums', 'Bass'] },
  { name: 'electronic-vibe-relax', genre: 'Electronic Vibe', mood: 'Relax', bpm: 108, instruments: ['Synth', 'Drums', 'Bass'] },
  { name: 'electronic-vibe-party', genre: 'Electronic Vibe', mood: 'Party', bpm: 124, instruments: ['Synth', 'Drums', 'Bass'] },
  { name: 'acoustic-mix', genre: 'Acoustic', bpm: 72, instruments: ['Acoustic Guitar', 'Piano', 'Drums', 'Bass'] },
  { name: 'snare-and-hat', genre: 'Pop', bpm: 120, instruments: ['Drums'] },
  { name: 'tabla-solo', genre: 'Classical', bpm: 96, instruments: ['Tabla'] },
  { name: 'ambient-selected-percussion', genre: 'Ambient', bpm: 72, instruments: ['Drums', 'Tabla'] },
  { name: 'sitar-solo', genre: 'Classical', bpm: 88, instruments: ['Sitar'] },
  { name: 'guitar-colors', genre: 'Rock', bpm: 112, instruments: ['Acoustic Guitar', 'Electric Guitar'] },
  { name: 'horn-and-bow-colors', genre: 'Jazz', bpm: 104, instruments: ['Violin', 'Flute', 'Saxophone', 'Strings', 'Trumpet'] },
  { name: 'all-instruments', genre: 'Pop', bpm: 118, instruments: [...INSTRUMENTS] },
];

function wav(samples: Float32Array, rate: number) {
  const bytes = new ArrayBuffer(44 + samples.length * 2); const data = new DataView(bytes);
  const text = (offset: number, value: string) => [...value].forEach((char, i) => data.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); data.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVEfmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, rate, true); data.setUint32(28, rate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  text(36, 'data'); data.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => data.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
  return bytes;
}

async function main() {
  const results = [];
  for (const sampleRate of [44100, 48000]) for (const item of cases) {
    const seconds = 9;
    const context = new OfflineAudioContext(1, seconds * sampleRate, sampleRate);
    // Exercise the real browser audio graph and synthesizers without a speaker,
    // server-side AI requests, or browser-user session state.
    const original = window.AudioContext;
    (window as any).AudioContext = function () { return context; };
    const engine = new AudioEngine() as any;
    try { engine.init(); } finally { window.AudioContext = original; }
    engine.isEngineRunning = true;
    engine.setVolume(1);
    const song = { ...initialSongs[0], ...item, description: 'Audio regression test', lyrics: [{ section: 'Chorus', lines: ['Audio test'] }] };
    engine.songData = song; engine.arrangement = createArrangement(song); engine.tempoBpm = item.bpm;
    if (item.isolated) {
      for (let time = .1; time < 7; time += 1) engine.playChord('C', 'piano', 0, time);
    } else {
      const stepDuration = 60 / item.bpm / 4;
      for (let step = 0; .1 + step * stepDuration < 7; step++) engine.scheduleBeat(step, .1 + step * stepDuration);
    }
    const rendered = await context.startRendering();
    const data = rendered.getChannelData(0);
    let peak = 0, clipped = 0, maxJump = 0, energy = 0;
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i])) throw new Error('Non-finite audio sample');
      peak = Math.max(peak, Math.abs(data[i]));
      if (Math.abs(data[i]) >= 1) clipped++;
      if (i) maxJump = Math.max(maxJump, Math.abs(data[i] - data[i - 1]));
      energy += data[i] * data[i];
    }
    const result = { name: item.name, sampleRate, peak: +peak.toFixed(4), clippedSamples: clipped, largestSampleJump: +maxJump.toFixed(4), rms: +Math.sqrt(energy / data.length).toFixed(4) };
    results.push(result);
    if (!baseline && (clipped || peak > .95 || result.rms < .002 || (item.isolated && maxJump > .06))) throw new Error('Audio quality regression: ' + JSON.stringify(result));
    if (sampleRate === 48000 && item.name === 'pop-full-mix') await fetch('/audio', { method: 'POST', body: wav(data, sampleRate) });
  }
  if (!baseline) {
    const sampleRate = 48000;
    const context = new OfflineAudioContext(1, sampleRate * 3, sampleRate);
    const original = window.AudioContext;
    (window as any).AudioContext = function () { return context; };
    const engine = new AudioEngine() as any;
    try { engine.init(); } finally { window.AudioContext = original; }
    engine.isEngineRunning = true;
    engine.setVolume(1);
    engine.playChord('C', 'piano', 0, .1);
    engine.playDrums(true, true, true, .8, 1); // Already queued when Stop is pressed.
    const paused = context.suspend(.4);
    const rendering = context.startRendering();
    await paused;
    engine.stop();
    engine.isEngineRunning = true;
    engine.setVolume(1);
    engine.playChord('G', 'piano', 0, 1.2);
    await context.resume();
    const data = (await rendering).getChannelData(0);
    let silentPeak = 0, restartedPeak = 0;
    for (let i = .6 * sampleRate; i < 1.1 * sampleRate; i++) silentPeak = Math.max(silentPeak, Math.abs(data[i]));
    for (let i = 1.2 * sampleRate; i < 1.8 * sampleRate; i++) restartedPeak = Math.max(restartedPeak, Math.abs(data[i]));
    if (silentPeak > .001 || restartedPeak < .05) throw new Error('Stop/restart leaked old notes or silenced the new song: ' + JSON.stringify({ silentPeak, restartedPeak }));
    results.push({ name: 'stop-restart-isolation', sampleRate, silentPeak: +silentPeak.toFixed(6), restartedPeak: +restartedPeak.toFixed(4) } as any);
  }
  return results;
}
main().then(results => fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, results }) }))
  .catch(error => fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: String(error) }) }));
