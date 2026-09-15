export type VocalTake = {
  id: string; userId: string; songId: string; createdAt: string;
  blob: Blob; duration: number; includesInstrumental: boolean; bpm: number;
  /** Exact imported backing used for this performance; absent means procedural. */
  backingTrackId?: string;
  mix?: MixSettings;
};
export type MixSettings = { voiceVolume: number; instrumentalVolume: number; syncMs: number; tone: number; reverb: number; trimStart: number; trimEnd: number };
export const MAX_TAKES_PER_SONG = 10;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('svara-vocal-takes', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('takes', { keyPath: ['userId', 'songId', 'id'] });
      store.createIndex('song', ['userId', 'songId']);
      store.createIndex('user', 'userId');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other SoundProof tabs and try again to open recording storage.'));
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}
async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('takes', mode);
      const request = operation(tx.objectStore('takes'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error('Recording storage is unavailable.'));
    });
  } finally { db.close(); }
}
export async function listTakes(userId: string, songId: string): Promise<VocalTake[]> {
  const takes = await transaction<VocalTake[]>('readonly', store => store.index('song').getAll([userId, songId]));
  return takes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function saveTake(take: VocalTake) {
  // Check and insert in one transaction so simultaneous tabs cannot exceed the cap.
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('takes', 'readwrite');
      const store = tx.objectStore('takes');
      const count = store.index('song').count([take.userId, take.songId]);
      let full = false;
      count.onsuccess = () => { if (count.result >= MAX_TAKES_PER_SONG) { full = true; tx.abort(); } else store.put(take); };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(full ? new Error('This song has 10 saved takes. Download and delete an older take, then save this one.') : new Error('Browser storage is full or unavailable. Download this take before leaving.'));
    });
  } finally { db.close(); }
}
export const deleteTake = (userId: string, songId: string, id: string) => transaction('readwrite', store => store.delete([userId, songId, id]));
export const countTakes = (userId: string) => transaction('readonly', store => store.index('user').count(userId));
export async function updateTake(take: VocalTake) {
  const existing = await transaction<VocalTake | undefined>('readonly', store => store.get([take.userId, take.songId, take.id]));
  if (!existing) throw new Error('This take is not saved in the browser.');
  await transaction('readwrite', store => store.put(take));
}
