import test from 'node:test';
import assert from 'node:assert/strict';
import { lyricCueAtBeat, BEATS_PER_LYRIC_SECTION, COUNT_IN_BEATS } from './lyricsTiming';

test('lyric guide gives every line an even part of its four-bar section', () => {
  const song = { lyrics: [
    { section: 'Verse', lines: ['one', 'two'] },
    { section: 'Chorus', lines: ['a', 'b', 'c', 'd'] },
  ] };
  assert.equal(lyricCueAtBeat(song, 0)?.countIn, true);
  assert.equal(lyricCueAtBeat(song, COUNT_IN_BEATS)?.line, 'one');
  assert.equal(lyricCueAtBeat(song, 11.99)?.line, 'one');
  assert.equal(lyricCueAtBeat(song, 12)?.line, 'two');
  assert.equal(lyricCueAtBeat(song, COUNT_IN_BEATS + BEATS_PER_LYRIC_SECTION)?.line, 'a');
  assert.equal(lyricCueAtBeat(song, 24)?.line, 'b');
  assert.equal(lyricCueAtBeat(song, 32)?.line, 'd');
  assert.equal(lyricCueAtBeat(song, 36)?.countIn, true, 'lyrics repeat with a new count-in if the preview is longer than one cycle');
});

test('lyric guide reports section, completed-line order, next line and four-beat count', () => {
  const song = { lyrics: [
    { section: 'Empty', lines: [] },
    { section: 'Verse', lines: ['first', 'second', 'third', 'fourth'] },
    { section: 'Chorus', lines: ['sing', 'again'] },
  ] };
  const cue = lyricCueAtBeat(song, 25.5)!;
  assert.equal(cue.section, 'Chorus');
  assert.equal(cue.sectionIndex, 1);
  assert.equal(cue.line, 'sing');
  assert.equal(cue.nextLine, 'again');
  assert.equal(cue.flatIndex, 4);
  assert.equal(cue.beatInBar, 1);
  assert.equal(cue.lineProgress, .6875);
  assert.equal(cue.countIn, false);
  assert.equal(lyricCueAtBeat({ lyrics: [] }, 0), null);
});

test('saved custom timing overrides even phrases and keeps line order', () => {
  const song = {
    lyrics: [{ section: 'Verse', lines: ['early', 'hold this line', 'finish'] }],
    lyricTiming: [2, 5, 9],
  };
  assert.equal(lyricCueAtBeat(song, 1)?.countIn, true);
  assert.equal(lyricCueAtBeat(song, 2)?.line, 'early');
  assert.equal(lyricCueAtBeat(song, 4.99)?.line, 'early');
  assert.equal(lyricCueAtBeat(song, 5)?.line, 'hold this line');
  assert.equal(lyricCueAtBeat(song, 9)?.line, 'finish');
});
