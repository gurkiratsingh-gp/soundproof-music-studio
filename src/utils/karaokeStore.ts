/** Per-account browser persistence for processed backing tracks. */
export const IMPORTED_BACKING_LIMITS = Object.freeze({
  maxBytesPerTrack: 64 * 1024 * 1024,
  maxTracksPerSong: 3,
  maxTracksPerUser: 12,
  maxBytesPerUser: 256 * 1024 * 1024,
});

export type ImportedBackingProcessing = {
  centerReduction: number;
  bassPreservation: number;
  semitones: number;
  sourceKey?: string;
  targetKey?: string;
};

export type ImportedBackingTrack = {
  id: string;
  userId: string;
  songId: string;
  name: string;
  createdAt: string;
  blob: Blob;
  duration: number;
  bpm: number;
  sampleRate: number;
  processing: ImportedBackingProcessing;
};

export class ImportedBackingStoreError extends Error {
  constructor(public readonly code: 'invalid' | 'track-too-large' | 'song-limit' | 'user-limit' | 'user-size-limit' | 'unavailable', message: string) {
    super(message); this.name = 'ImportedBackingStoreError';
  }
}

const validText = (value: unknown, maximum: number) => typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum;

export function validateImportedBacking(track: ImportedBackingTrack): void {
  if (!track || !validText(track.id, 128) || !validText(track.userId, 128) || !validText(track.songId, 128) || !validText(track.name, 255)) {
    throw new ImportedBackingStoreError('invalid', 'This backing track is missing its song, account, or file name.');
  }
  if (!(track.blob instanceof Blob) || !track.blob.size || (track.blob.type && !track.blob.type.toLowerCase().startsWith('audio/'))) {
    throw new ImportedBackingStoreError('invalid', 'Choose a valid processed audio backing.');
  }
  if (track.blob.size > IMPORTED_BACKING_LIMITS.maxBytesPerTrack) {
    throw new ImportedBackingStoreError('track-too-large', 'Keep each saved backing track under 64 MB. Download it instead if it is larger.');
  }
  if (!Number.isFinite(track.duration) || track.duration < 1 || track.duration > 300 || !Number.isFinite(track.bpm) || track.bpm < 40 || track.bpm > 240 || !Number.isFinite(track.sampleRate) || track.sampleRate < 8_000 || track.sampleRate > 96_000 || Number.isNaN(Date.parse(track.createdAt))) {
    throw new ImportedBackingStoreError('invalid', 'This backing track has invalid duration, tempo, sample-rate, or date information.');
  }
  const processing = track.processing;
  if (!processing || !Number.isFinite(processing.centerReduction) || processing.centerReduction < 0 || processing.centerReduction > 1 ||
      !Number.isFinite(processing.bassPreservation) || processing.bassPreservation < 0 || processing.bassPreservation > 1 ||
      !Number.isFinite(processing.semitones) || Math.abs(processing.semitones) > 12 ||
      (processing.sourceKey !== undefined && !validText(processing.sourceKey, 32)) || (processing.targetKey !== undefined && !validText(processing.targetKey, 32))) {
    throw new ImportedBackingStoreError('invalid', 'This backing track has invalid processing settings.');
  }
}

/** Pure quota check shared by the IndexedDB writer and unit tests. */
export function importedBackingQuotaError(candidate: ImportedBackingTrack, existing: ImportedBackingTrack[]): ImportedBackingStoreError | null {
  const retained = existing.filter(item => item.userId === candidate.userId && !(item.songId === candidate.songId && item.id === candidate.id));
  if (retained.filter(item => item.songId === candidate.songId).length >= IMPORTED_BACKING_LIMITS.maxTracksPerSong) {
    return new ImportedBackingStoreError('song-limit', 'This song already has 3 imported backings. Delete one before saving another.');
  }
  if (retained.length >= IMPORTED_BACKING_LIMITS.maxTracksPerUser) {
    return new ImportedBackingStoreError('user-limit', 'This account already has 12 imported backings in this browser. Delete an older one before saving.');
  }
  const total = retained.reduce((bytes, item) => bytes + (item.blob instanceof Blob ? item.blob.size : 0), candidate.blob.size);
  if (total > IMPORTED_BACKING_LIMITS.maxBytesPerUser) {
    return new ImportedBackingStoreError('user-size-limit', 'Saved backing tracks would exceed the 256 MB browser limit. Download and delete an older backing first.');
  }
  return null;
}

const DATABASE = 'soundproof-imported-backings'; const STORE = 'backings';

function databaseFactory(): IDBFactory {
  if (!globalThis.indexedDB) throw new ImportedBackingStoreError('unavailable', 'Backing-track storage is unavailable in this browser or private session.');
  return globalThis.indexedDB;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = databaseFactory().open(DATABASE, 1); }
    catch { reject(new ImportedBackingStoreError('unavailable', 'Backing-track storage is unavailable in this browser or private session.')); return; }
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: ['userId', 'songId', 'id'] });
      store.createIndex('song', ['userId', 'songId']); store.createIndex('user', 'userId');
    };
    request.onerror = () => reject(new ImportedBackingStoreError('unavailable', 'SoundProof could not open backing-track storage.'));
    request.onblocked = () => reject(new ImportedBackingStoreError('unavailable', 'Close other SoundProof tabs and try opening backing-track storage again.'));
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(STORE, mode); const request = operation(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new ImportedBackingStoreError('unavailable', 'Browser storage is full or unavailable. Download the backing before leaving this page.'));
    });
  } finally { database.close(); }
}

export async function saveImportedBacking(track: ImportedBackingTrack): Promise<void> {
  validateImportedBacking(track);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE, 'readwrite'); const store = tx.objectStore(STORE);
      const existing = store.index('user').getAll(track.userId); let failure: ImportedBackingStoreError | null = null;
      existing.onsuccess = () => {
        failure = importedBackingQuotaError(track, existing.result as ImportedBackingTrack[]);
        if (failure) tx.abort(); else store.put(track);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(failure || new ImportedBackingStoreError('unavailable', 'Browser storage is full or unavailable. Download the backing before leaving this page.'));
    });
  } finally { database.close(); }
}

export async function listImportedBackings(userId: string, songId: string): Promise<ImportedBackingTrack[]> {
  if (!validText(userId, 128) || !validText(songId, 128)) throw new ImportedBackingStoreError('invalid', 'Choose an account and song before loading imported backings.');
  const result = await transaction<ImportedBackingTrack[]>('readonly', store => store.index('song').getAll([userId, songId]));
  return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function getImportedBacking(userId: string, songId: string, id: string): Promise<ImportedBackingTrack | undefined> {
  if (![userId, songId, id].every(value => validText(value, 128))) throw new ImportedBackingStoreError('invalid', 'Choose a valid saved backing track.');
  return transaction<ImportedBackingTrack | undefined>('readonly', store => store.get([userId, songId, id]));
}

export async function deleteImportedBacking(userId: string, songId: string, id: string): Promise<void> {
  if (![userId, songId, id].every(value => validText(value, 128))) throw new ImportedBackingStoreError('invalid', 'Choose a valid saved backing track.');
  await transaction('readwrite', store => store.delete([userId, songId, id]));
}

export async function countImportedBackings(userId: string): Promise<number> {
  if (!validText(userId, 128)) throw new ImportedBackingStoreError('invalid', 'Choose a valid account before counting imported backings.');
  return transaction<number>('readonly', store => store.index('user').count(userId));
}

// Karaoke-facing names keep component integrations concise. The imported names
// remain aliases for compatibility with early local prototypes.
export const KARAOKE_TRACK_LIMITS = IMPORTED_BACKING_LIMITS;
export type KaraokeTrackProcessing = ImportedBackingProcessing;
export type KaraokeBackingTrack = ImportedBackingTrack;
export { ImportedBackingStoreError as KaraokeStoreError };
export const validateKaraokeTrack = validateImportedBacking;
export const karaokeTrackQuotaError = importedBackingQuotaError;
export const saveKaraokeTrack = saveImportedBacking;
export const listKaraokeTracks = listImportedBackings;
export const getKaraokeTrack = getImportedBacking;
export const deleteKaraokeTrack = deleteImportedBacking;
export const countKaraokeTracks = countImportedBackings;
