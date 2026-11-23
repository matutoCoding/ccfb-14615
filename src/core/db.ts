// IndexedDB 持久层：桥梁档案/构件/期次/照片/病害/评分/几何缓存
import {
  BridgeRecord, ComponentRecord, EpochRecord, PhotoRecord, DefectRecord, BridgeScore,
} from '../types';
import { BridgeGeometry } from './geometry';

const DB_NAME = 'bridge-inspection-db';
const DB_VERSION = 1;
export const STORES = {
  bridges: 'bridges',
  components: 'components',
  epochs: 'epochs',
  photos: 'photos',
  defects: 'defects',
  scores: 'scores',
  geometry: 'geometry',
  blobs: 'blobs',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function idbPut<T>(store: string, key: string, value: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbClear(store: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 照片本身(含低清缩略图)以 Blob 存，避免主记录过大
export async function putImageBlob(key: string, blob: Blob): Promise<void> {
  await idbPut(STORES.blobs, key, blob);
}
export async function getImageBlob(key: string): Promise<Blob | undefined> {
  return idbGet<Blob>(STORES.blobs, key);
}

// 几何重建成本低但仍缓存一份
export async function saveGeometry(bridgeId: string, geo: BridgeGeometry): Promise<void> {
  await idbPut(STORES.geometry, bridgeId, JSON.parse(JSON.stringify(geo)));
}

// 类型化便捷 API
export const db = {
  saveBridge: (r: BridgeRecord) => idbPut(STORES.bridges, r.id, r),
  listBridges: () => idbGetAll<BridgeRecord>(STORES.bridges),
  getBridge: (id: string) => idbGet<BridgeRecord>(STORES.bridges, id),
  deleteBridge: async (id: string) => {
    await idbDelete(STORES.bridges, id);
    await idbDelete(STORES.geometry, id);
  },
  saveComponents: (bridgeId: string, list: ComponentRecord[]) => idbPut(STORES.components, bridgeId, list),
  getComponents: (bridgeId: string) => idbGet<ComponentRecord[]>(STORES.components, bridgeId),
  saveEpoch: (r: EpochRecord) => idbPut(STORES.epochs, r.id, r),
  listEpochs: (bridgeId: string) =>
    idbGetAll<EpochRecord>(STORES.epochs).then((xs) => xs.filter((e) => e.bridgeId === bridgeId)),
  deleteEpoch: (id: string) => idbDelete(STORES.epochs, id),
  savePhoto: (r: PhotoRecord) => idbPut(STORES.photos, r.id, r),
  listPhotos: (bridgeId: string, epochId?: string) =>
    idbGetAll<PhotoRecord>(STORES.photos).then((xs) =>
      xs.filter((p) => p.bridgeId === bridgeId && (!epochId || p.epochId === epochId))
    ),
  getPhoto: (id: string) => idbGet<PhotoRecord>(STORES.photos, id),
  deletePhoto: (id: string) =>
    Promise.all([idbDelete(STORES.photos, id), idbDelete(STORES.blobs, `thumb:${id}`), idbDelete(STORES.blobs, `full:${id}`)]),
  saveDefect: (r: DefectRecord) => idbPut(STORES.defects, r.id, r),
  listDefects: (bridgeId: string, epochId?: string, componentId?: string) =>
    idbGetAll<DefectRecord>(STORES.defects).then((xs) =>
      xs.filter(
        (d) =>
          d.bridgeId === bridgeId &&
          (!epochId || d.epochId === epochId) &&
          (!componentId || d.componentId === componentId)
      )
    ),
  getDefect: (id: string) => idbGet<DefectRecord>(STORES.defects, id),
  deleteDefect: (id: string) => idbDelete(STORES.defects, id),
  saveScore: (r: BridgeScore) => idbPut(STORES.scores, r.epochId, r),
  getScore: (epochId: string) => idbGet<BridgeScore>(STORES.scores, epochId),
};
