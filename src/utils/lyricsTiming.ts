import type { SongMetadata } from '../types';

export const BEATS_PER_LYRIC_SECTION = 16;
export const COUNT_IN_BEATS = 4;
export type LyricCue = {
  sectionIndex: number;
  lineIndex: number;
  flatIndex: number;
  beatInBar: number;
  lineProgress: number;
  section: string;
  line: string;
  nextLine: string;
  countIn: boolean;
};

/**
 * The procedural preview gives every lyric section four bars. Lines divide
 * those bars evenly, so four-line sections get one full bar per line while
 * shorter or longer sections still use the whole musical phrase.
 */
export function lyricCueAtBeat(song: Pick<SongMetadata, 'lyrics' | 'lyricTiming'>, beat: number): LyricCue | null {
  const sections = song.lyrics.filter(section => section.lines.length);
  if (!sections.length) return null;
  const flattenedRows = sections.flatMap((section, sectionIndex) => section.lines.map((line, lineIndex) => ({ section, sectionIndex, line, lineIndex })));
  const timing = Array.isArray(song.lyricTiming) && song.lyricTiming.length === flattenedRows.length && song.lyricTiming.every((value, index, list) => Number.isFinite(value) && value >= 0 && (index === 0 || value > list[index - 1])) ? song.lyricTiming : null;
  if (timing) {
    if (beat < timing[0]) return { sectionIndex: -1, lineIndex: -1, flatIndex: -1, beatInBar: Math.floor(Math.max(0, beat)) % 4, lineProgress: timing[0] ? Math.max(0, beat) / timing[0] : 0, section: 'Count in', line: 'Get ready…', nextLine: flattenedRows[0].line, countIn: true };
    let flatIndex = -1;
    for (let index = timing.length - 1; index >= 0; index--) if (timing[index] <= beat) { flatIndex = index; break; }
    if (flatIndex < 0) flatIndex = 0;
    const row = flattenedRows[flatIndex];
    const typicalLength = timing.length > 1 ? Math.max(1, timing[timing.length - 1] - timing[timing.length - 2]) : 4;
    const end = timing[flatIndex + 1] ?? timing[flatIndex] + typicalLength;
    return { sectionIndex: row.sectionIndex, lineIndex: row.lineIndex, flatIndex, beatInBar: Math.floor(beat) % 4,
      lineProgress: Math.max(0, Math.min(1, (beat - timing[flatIndex]) / Math.max(.25, end - timing[flatIndex]))),
      section: row.section.section, line: row.line, nextLine: flattenedRows[Math.min(flattenedRows.length - 1, flatIndex + 1)].line, countIn: false };
  }
  const cycleBeats = COUNT_IN_BEATS + sections.length * BEATS_PER_LYRIC_SECTION;
  const wrappedBeat = ((beat % cycleBeats) + cycleBeats) % cycleBeats;
  const flattened = sections.flatMap(item => item.lines);
  if (wrappedBeat < COUNT_IN_BEATS) return {
    sectionIndex: -1, lineIndex: -1, flatIndex: -1,
    beatInBar: Math.floor(wrappedBeat), lineProgress: wrappedBeat / COUNT_IN_BEATS,
    section: 'Count in', line: 'Get ready…', nextLine: flattened[0], countIn: true,
  };
  const lyricBeat = wrappedBeat - COUNT_IN_BEATS;
  const sectionIndex = Math.min(sections.length - 1, Math.floor(lyricBeat / BEATS_PER_LYRIC_SECTION));
  const sectionBeat = lyricBeat - sectionIndex * BEATS_PER_LYRIC_SECTION;
  const section = sections[sectionIndex];
  const linePosition = sectionBeat * section.lines.length / BEATS_PER_LYRIC_SECTION;
  const lineIndex = Math.min(section.lines.length - 1, Math.floor(linePosition));
  const flatIndex = sections.slice(0, sectionIndex).reduce((total, item) => total + item.lines.length, 0) + lineIndex;
  return {
    sectionIndex, lineIndex, flatIndex,
    beatInBar: Math.floor(wrappedBeat) % 4,
    lineProgress: linePosition - lineIndex,
    section: section.section,
    line: section.lines[lineIndex],
    nextLine: flattened[(flatIndex + 1) % flattened.length],
    countIn: false,
  };
}
