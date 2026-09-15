import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KARAOKE_TRACK_LIMITS, KaraokeStoreError, karaokeTrackQuotaError, listKaraokeTracks,
  validateKaraokeTrack, type KaraokeBackingTrack,
} from './karaokeStore';

function sizedBlob(bytes: number, type = 'audio/wav') {
  const blob = new Blob(['audio'], { type });
  Object.defineProperty(blob, 'size', { value: bytes });
  return blob;
}

function backing(id: string, songId = 'song-1', bytes = 1024): KaraokeBackingTrack {
  return {
    id, userId: 'user-1', songId, name: `${id}.wav`, createdAt: new Date(1_750_000_000_000 + Number(id.replace(/\D/g, '') || 0)).toISOString(),
    blob: sizedBlob(bytes), duration: 180, bpm: 116, sampleRate: 44_100,
    processing: { centerReduction: 1, bassPreservation: .65, semitones: 0, sourceKey: 'C major', targetKey: 'C major' },
  };
}

test('karaoke backing validation enforces audio metadata and per-track size', () => {
  assert.doesNotThrow(() => validateKaraokeTrack(backing('one')));
  assert.throws(() => validateKaraokeTrack({ ...backing('bad'), bpm: 300 }), (error: unknown) => error instanceof KaraokeStoreError && error.code === 'invalid');
  assert.throws(() => validateKaraokeTrack({ ...backing('bad'), blob: sizedBlob(100, 'text/plain') }), (error: unknown) => error instanceof KaraokeStoreError && error.code === 'invalid');
  assert.throws(() => validateKaraokeTrack(backing('huge', 'song-1', KARAOKE_TRACK_LIMITS.maxBytesPerTrack + 1)), (error: unknown) => error instanceof KaraokeStoreError && error.code === 'track-too-large');
});

test('quota checks isolate users, allow replacement, and enforce song and account caps', () => {
  const perSong = [backing('1'), backing('2'), backing('3'), { ...backing('other-user'), userId: 'user-2' }];
  assert.equal(karaokeTrackQuotaError(backing('4'), perSong)?.code, 'song-limit');
  assert.equal(karaokeTrackQuotaError(backing('1'), perSong), null, 'replacing the same composite key must not consume another slot');
  const perUser = Array.from({ length: KARAOKE_TRACK_LIMITS.maxTracksPerUser }, (_, index) => backing(String(index), `song-${index}`));
  assert.equal(karaokeTrackQuotaError(backing('new', 'different-song'), perUser)?.code, 'user-limit');
  const large = Array.from({ length: 5 }, (_, index) => backing(String(index), `song-${index}`, 50 * 1024 * 1024));
  assert.equal(karaokeTrackQuotaError(backing('new', 'different-song', 20 * 1024 * 1024), large)?.code, 'user-size-limit');
});

test('storage reports a clear unavailable error when IndexedDB is absent', async () => {
  if (globalThis.indexedDB) return;
  await assert.rejects(listKaraokeTracks('user-1', 'song-1'), (error: unknown) => error instanceof KaraokeStoreError && error.code === 'unavailable');
});
