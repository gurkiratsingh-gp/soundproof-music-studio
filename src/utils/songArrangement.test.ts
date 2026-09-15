import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSongBrief, createArrangement, arrangementStep } from './songArrangement';
import { generateProceduralSong } from './proceduralFallback';
import { initialSongs } from './initialSongs';
import { AudioEngine, instrumentPartsForStep } from './audioEngine';
import { INSTRUMENTS } from './songDraft';

test('prompt cues change a default pop brief into acoustic, dance, vibe and lo-fi arrangements', () => {
  const base = initialSongs[0];
  const acoustic = resolveSongBrief({ ...base, bpm: undefined, description: 'A slow Punjabi acoustic love song with guitar and piano, no drums, 72 BPM' });
  const dance = resolveSongBrief({ ...base, bpm: undefined, description: 'An energetic electronic dance anthem with synth and drums, 132 BPM' });
  const vibe = resolveSongBrief({ ...base, bpm: undefined, description: 'A smooth electronic vibe for just vibing after class with warm synth and bass' });
  const calmVibe = resolveSongBrief({ ...base, bpm: undefined, description: 'A calm deep house instrumental with a late-night pulse' });
  const lofi = resolveSongBrief({ ...base, bpm: undefined, description: 'A lo-fi song about rain at night, piano, 78 BPM' });
  assert.equal(acoustic.genre, 'Acoustic');
  assert.equal(acoustic.language, 'Punjabi');
  assert.equal(acoustic.bpm, 72);
  assert.deepEqual(acoustic.instruments, ['Acoustic Guitar', 'Piano']);
  assert.equal(dance.genre, 'Electronic');
  assert.equal(dance.bpm, 132);
  assert.ok(dance.instruments.includes('Drums'));
  assert.equal(vibe.genre, 'Electronic Vibe');
  assert.equal(vibe.mood, 'Vibing');
  assert.equal(vibe.bpm, 116);
  assert.deepEqual(vibe.instruments, ['Synth', 'Drums', 'Bass']);
  assert.equal(calmVibe.genre, 'Electronic Vibe');
  assert.equal(calmVibe.mood, 'Relax');
  assert.equal(calmVibe.bpm, 104);
  assert.equal(lofi.genre, 'LoFi');
  assert.equal(lofi.bpm, 78);
  assert.deepEqual(resolveSongBrief(base, false), base);
});

test('different genres produce different drum/bass timelines, with sparse intros and chorus changes', () => {
  const grooves = ['Pop', 'Rock', 'Hip Hop', 'Jazz', 'LoFi', 'Electronic', 'Electronic Vibe', 'Acoustic', 'Ambient'];
  const signatures = grooves.map(genre => {
    const arrangement = createArrangement({ ...initialSongs[0], genre });
    return JSON.stringify(Array.from({ length: 16 }, (_, step) => {
      const event = arrangementStep(arrangement, step, 'Verse');
      return [event.kick, event.snare, event.hat, event.bass, event.delayBeats];
    }));
  });
  assert.equal(new Set(signatures).size, grooves.length);
  const arrangement = createArrangement(initialSongs[0]);
  const intro = Array.from({ length: 16 }, (_, step) => arrangementStep(arrangement, step, 'Intro'));
  assert.ok(intro.every(event => !event.snare && !event.hat));
  assert.ok(arrangementStep(arrangement, 0, 'Chorus').velocity > intro[0].velocity);
});

test('mood changes density, dynamics and tone without making a saved arrangement unstable', () => {
  const base = { ...initialSongs[0], genre: 'Electronic Vibe', description: 'A smooth late-night electronic loop', emotion: 'Dreamy' };
  const relaxed = createArrangement({ ...base, mood: 'Relax' });
  const party = createArrangement({ ...base, mood: 'Party' });
  const relaxedEvents = Array.from({ length: 64 }, (_, step) => arrangementStep(relaxed, step, step < 16 ? 'Intro' : step >= 48 ? 'Chorus' : 'Verse'));
  const partyEvents = Array.from({ length: 64 }, (_, step) => arrangementStep(party, step, step < 16 ? 'Intro' : step >= 48 ? 'Chorus' : 'Verse'));
  const audibleEvents = (events: typeof relaxedEvents) => events.reduce((count, event) => count + Number(event.kick) + Number(event.snare) + Number(event.hat) + Number(event.bass) + Number(event.chord) + Number(event.lead), 0);
  assert.ok(audibleEvents(partyEvents) > audibleEvents(relaxedEvents));
  assert.ok(partyEvents[20].velocity > relaxedEvents[20].velocity);
  assert.ok(partyEvents[20].brightness > relaxedEvents[20].brightness);
  assert.deepEqual(relaxedEvents, Array.from({ length: 64 }, (_, step) => arrangementStep(createArrangement({ ...base, mood: 'Relax' }), step, step < 16 ? 'Intro' : step >= 48 ? 'Chorus' : 'Verse')));
  assert.notDeepEqual(relaxed.motif, party.motif);
});

test('a saved song repeats its motif, while changing the prompt or take changes its melody', () => {
  const base = initialSongs[0];
  assert.deepEqual(createArrangement(base).motif, createArrangement(base).motif);
  assert.notDeepEqual(createArrangement(base).motif, createArrangement({ ...base, description: 'A calm walk through a forest' }).motif);
  assert.notDeepEqual(createArrangement(base).motif, createArrangement({ ...base, melodySeed: base.melodySeed + 1 }).motif);
  const fallback = generateProceduralSong(resolveSongBrief({ ...base, description: 'solo piano ballad 68 BPM' }));
  assert.equal(fallback.bpm, 68);
  assert.deepEqual(fallback.instruments, ['Piano']);
  assert.equal(fallback.genre, 'Acoustic');
});

test('the actual scheduler gives default instruments a melody and honors drumless arrangements', () => {
  // Observe instrument dispatch without needing a browser or rendering audio in the test runner.
  const engine = new AudioEngine() as any;
  engine.ctx = {};
  engine.masterGain = {};
  let leads = 0, drums = 0;
  engine.playLeadMelody = () => { leads++; };
  engine.playDrums = () => { drums++; };
  engine.playBass = () => {};
  engine.playChord = () => {};
  engine.songData = { ...initialSongs[0], instruments: ['Piano', 'Synth', 'Drums', 'Bass'] };
  engine.arrangement = createArrangement(engine.songData);
  const guideBeats: number[] = [];
  engine.onBeatCallback = (beat: number) => guideBeats.push(beat);
  for (let step = 0; step < 16; step++) engine.scheduleBeat(step, step / 8);
  assert.deepEqual(guideBeats, [0, 1, 2, 3], 'Lyric beat guide must update on every quarter note');
  engine.onBeatCallback = null;
  assert.ok(leads >= 4, 'Default piano/synth selection must play a melody');
  assert.ok(drums > 0);
  drums = 0;
  engine.songData = { ...initialSongs[0], instruments: ['Piano'] };
  for (let step = 0; step < 16; step++) engine.scheduleBeat(step, step / 8);
  assert.equal(drums, 0);
  engine.nextNoteTime = 0;
  engine.tempoBpm = 120;
  engine.currentBeat = 0;
  engine.advanceBeat();
  assert.equal(engine.nextNoteTime, 0.125, 'Scheduler must advance sixteenth notes instead of whole beats');
});

test('every selectable instrument receives its own deterministic part without default-instrument leakage', () => {
  for (const genre of ['Pop', 'Ambient']) {
    const arrangement = createArrangement({ ...initialSongs[0], genre, mood: 'Happy' });
    for (const instrument of INSTRUMENTS) {
      const timeline = Array.from({ length: 32 }, (_, step) =>
        instrumentPartsForStep([instrument], arrangementStep(arrangement, step, 'Verse'), step),
      ).flat();
      assert.ok(timeline.length > 0, `${instrument} must receive an audible part within two bars of ${genre}`);
      assert.ok(timeline.every(part => part.instrument === instrument), `${instrument} must not trigger an unselected voice`);
    }
  }

  const arrangement = createArrangement({ ...initialSongs[0], genre: 'Pop', mood: 'Happy' });
  const selected = ['Tabla', 'Sitar'];
  const timeline = Array.from({ length: 32 }, (_, step) =>
    instrumentPartsForStep(selected, arrangementStep(arrangement, step, 'Verse'), step),
  ).flat();
  assert.deepEqual(new Set(timeline.map(part => part.instrument)), new Set(selected));
  assert.ok(timeline.some(part => part.instrument === 'Tabla' && part.role === 'tabla'));
  assert.ok(!timeline.some(part => part.role === 'drums'), 'Tabla must not fall back to the drum-kit voice');
  assert.ok(timeline.some(part => part.instrument === 'Sitar' && part.role === 'lead'));
});

test('the scheduler dispatches tabla and sitar to their dedicated voices', () => {
  const engine = new AudioEngine() as any;
  engine.ctx = {};
  engine.masterGain = {};
  const calls = { tabla: 0, sitar: 0, drums: 0, bass: 0, chord: 0, guitar: 0, otherLead: 0 };
  engine.playTabla = () => { calls.tabla++; };
  engine.playSitar = () => { calls.sitar++; };
  engine.playDrums = () => { calls.drums++; };
  engine.playBass = () => { calls.bass++; };
  engine.playChord = () => { calls.chord++; };
  engine.playGuitarChord = () => { calls.guitar++; };
  engine.playLeadMelody = () => { calls.otherLead++; };
  engine.songData = { ...initialSongs[0], instruments: ['Tabla', 'Sitar'] };
  engine.arrangement = createArrangement(engine.songData);
  for (let step = 0; step < 32; step++) engine.scheduleBeat(step, step / 8);
  assert.ok(calls.tabla > 0, 'Tabla must reach its hand-drum synthesizer');
  assert.ok(calls.sitar > 0, 'Sitar must reach its plucked-string synthesizer');
  assert.deepEqual({ drums: calls.drums, bass: calls.bass, chord: calls.chord, guitar: calls.guitar, otherLead: calls.otherLead }, { drums: 0, bass: 0, chord: 0, guitar: 0, otherLead: 0 });
});

test('explicit drums and tabla remain audible in a sparse ambient arrangement', () => {
  const engine = new AudioEngine() as any;
  engine.ctx = {};
  engine.masterGain = {};
  const downbeats = { drums: 0, tabla: 0 };
  engine.playDrums = (kick: boolean) => { if (kick) downbeats.drums++; };
  engine.playTabla = (bayan: boolean) => { if (bayan) downbeats.tabla++; };
  engine.playBass = () => {};
  engine.playChord = () => {};
  engine.playGuitarChord = () => {};
  engine.playSitar = () => {};
  engine.playLeadMelody = () => {};
  engine.songData = { ...initialSongs[0], genre: 'Ambient', instruments: ['Drums', 'Tabla'] };
  engine.arrangement = createArrangement(engine.songData);
  for (let step = 0; step < 32; step++) engine.scheduleBeat(step, step / 8);
  assert.deepEqual(downbeats, { drums: 2, tabla: 2 });
});

test('chord roots use one continuous octave from C through B', () => {
  const engine = new AudioEngine() as any;
  const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'].map(note => engine.getRootMidiNote(note));
  assert.deepEqual(roots, [36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]);
  assert.ok(roots.every((value, index) => index === 0 || value > roots[index - 1]), 'Chord roots must rise smoothly instead of jumping octaves at E');
});

test('a delayed audio scheduler skips missed notes instead of playing a burst of stale beats', () => {
  const engine = new AudioEngine() as any;
  engine.ctx = { currentTime: 3.6 };
  engine.isEngineRunning = true;
  engine.tempoBpm = 120;
  engine.startTime = 0;
  engine.nextNoteTime = 0.125;
  engine.currentBeat = 1;
  const scheduled: Array<{ step: number; time: number }> = [];
  engine.scheduleBeat = (step: number, time: number) => scheduled.push({ step, time });
  try {
    engine.scheduler();
    assert.deepEqual(scheduled, [{ step: 29, time: 3.625 }]);
    assert.equal(engine.getCurrentTime(), 3.6, 'Playback progress follows the audio clock, not timer tick counts');
  } finally { clearTimeout(engine.schedulerTimer); }
});

test('a sung-audio reference can set the backing tempo and harmony key', () => {
  const song = generateProceduralSong({ description: 'Backing for my sung idea', mood: 'Happy', genre: 'Pop', language: 'English', tempo: 'Medium', emotion: 'Warm', singerStyle: 'Modern Pop', instruments: ['Piano', 'Drums', 'Bass'], creativity: 70, bpm: 123, key: 'D major' });
  assert.equal(song.bpm, 123);
  assert.equal(song.key, 'D major');
  assert.deepEqual(song.chordProgression.verse, ['D', 'A', 'Bm', 'G']);
});

test('automatic tempo follows genre and mood deterministically while explicit BPM wins', () => {
  const base = { description: 'A flowing instrumental for the evening', genre: 'Electronic Vibe', language: 'English', tempo: 'Medium', emotion: 'Dreamy', singerStyle: 'Polished Electronic', instruments: ['Synth', 'Drums', 'Bass'], creativity: 72 };
  const relaxed = generateProceduralSong({ ...base, mood: 'Relax' });
  const party = generateProceduralSong({ ...base, mood: 'Party' });
  const vibing = generateProceduralSong({ ...base, mood: 'Vibing' });
  const repeated = generateProceduralSong({ ...base, mood: 'Vibing' });
  assert.ok(relaxed.bpm < vibing.bpm && vibing.bpm < party.bpm);
  assert.equal(vibing.bpm, repeated.bpm);
  assert.equal(vibing.melodySeed, repeated.melodySeed);
  assert.deepEqual(vibing.chordProgression, repeated.chordProgression);
  assert.match(vibing.key, /minor$/i);
  assert.equal(vibing.enhancedVoice, true);
  assert.equal(generateProceduralSong({ ...base, mood: 'Vibing', enhancedVoice: false }).enhancedVoice, false);
  assert.equal(generateProceduralSong({ ...base, mood: 'Relax', bpm: 123 }).bpm, 123);
});
