// IndexedDB 持久化：元数据对象仓 + Blob 仓 + 二进制构件网格仓。
import type {
  BridgeRating, BridgeSpec, ComponentDef, DefectRecord, EpochComparison,
  InspectionEpoch, PhotoRecord,
} from './types';

const DB_NAME = 'bridge-inspection-db';
const DB_VERSION = 1;
const STORES = {
  kv: 'kv',
  blobs: 'blobs',
  components: 'components',
  photos: 'photos',
  defects: 'defects',
  epochs: 'epochs',
  ratings: 'ratings',
  comparisons: 'comparisons',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.kv)) db.createObjectStore(STORES.kv);
      if (!db.objectStoreNames.contains(STORES.blobs)) db.createObjectStore(STORES.blobs);
      if (!db.objectStoreNames.contains(STORES.components)) db.createObjectStore(STORES.components);
      if (!db.objectStoreNames.contains(STORES.photos)) db.createObjectStore(STORES.photos, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.defects)) db.createObjectStore(STORES.defects, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.epochs)) db.createObjectStore(STORES.epochs, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.ratings)) db.createObjectStore(STORES.ratings, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.comparisons)) db.createObjectStore(STORES.comparisons, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return tx(STORES.kv, 'readonly', (s) => s.get(key) as IDBRequest<T>);
}
export async function kvSet(key: string, value: unknown): Promise<void> {
  await tx(STORES.kv, 'readwrite', (s) => s.put(value as object, key));
}
export async function kvDelete(key: string): Promise<void> {
  await tx(STORES.kv, 'readwrite', (s) => s.delete(key));
}

export async function putBlob(key: string, blob: Blob): Promise<void> {
  await tx(STORES.blobs, 'readwrite', (s) => s.put(blob, key));
}
export async function getBlob(key: string): Promise<Blob | undefined> {
  return tx(STORES.blobs, 'readonly', (s) => s.get(key) as IDBRequest<Blob | undefined>);
}
export async function deleteBlob(key: string): Promise<void> {
  await tx(STORES.blobs, 'readwrite', (s) => s.delete(key));
}

// ---------- 构件网格二进制序列化 ----------

interface StoredComponent {
  meta: Omit<ComponentDef, 'positions' | 'normals' | 'uvs' | 'indices' | 'triSurfaceIndex' | 'bakeTexture'>;
  buffers: ArrayBuffer[];
}

export async function saveComponent(comp: ComponentDef): Promise<void> {
  const { positions, normals, uvs, indices, triSurfaceIndex, bakeTexture, ...meta } = comp;
  const stored: StoredComponent = {
    meta,
    buffers: [
      positions.buffer.slice(0), normals.buffer.slice(0), uvs.buffer.slice(0),
      indices.buffer.slice(0), triSurfaceIndex.buffer.slice(0),
    ] as ArrayBuffer[],
  };
  await tx(STORES.components, 'readwrite', (s) => s.put(stored as object, comp.id));
}

export async function loadComponent(id: string): Promise<ComponentDef | undefined> {
  const stored = await tx(STORES.components, 'readonly', (s) => s.get(id) as IDBRequest<StoredComponent | undefined>);
  if (!stored) return undefined;
  const [p, n, uv, idx, tri] = stored.buffers;
  return {
    ...stored.meta,
    positions: new Float32Array(p),
    normals: new Float32Array(n),
    uvs: new Float32Array(uv),
    indices: new Uint32Array(idx),
    triSurfaceIndex: new Uint16Array(tri),
    bakeVersion: stored.meta.bakeVersion ?? 0,
  };
}

export async function listComponents(bridgeId: string): Promise<ComponentDef[]> {
  const all = await tx(STORES.components, 'readonly', (s) => s.getAll() as IDBRequest<StoredComponent[]>);
  return all
    .filter((c) => c.meta.id.startsWith(bridgeId) || true)
    .map((stored) => {
      const [p, n, uv, idx, tri] = stored.buffers;
      return {
        ...stored.meta,
        positions: new Float32Array(p),
        normals: new Float32Array(n),
        uvs: new Float32Array(uv),
        indices: new Uint32Array(idx),
        triSurfaceIndex: new Uint16Array(tri),
      } as ComponentDef;
    });
}

export async function clearComponents(): Promise<void> {
  await tx(STORES.components, 'readwrite', (s) => s.clear());
}

// ---------- 通用表 ----------

function repo<T extends { id: string }>(store: string) {
  return {
    async put(item: T): Promise<void> {
      await tx(store, 'readwrite', (s) => s.put(item as object));
    },
    async get(id: string): Promise<T | undefined> {
      return tx(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
    },
    async all(): Promise<T[]> {
      return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
    },
    async remove(id: string): Promise<void> {
      await tx(store, 'readwrite', (s) => s.delete(id));
    },
    async clear(): Promise<void> {
      await tx(store, 'readwrite', (s) => s.clear());
    },
  };
}

export const photoRepo = repo<PhotoRecord>(STORES.photos);
export const defectRepo = repo<DefectRecord>(STORES.defects);
export const epochRepo = repo<InspectionEpoch>(STORES.epochs);
export const ratingRepo = repo<BridgeRating>(STORES.ratings);
export const comparisonRepo = repo<EpochComparison>(STORES.comparisons);

export interface BridgeArchive {
  spec: BridgeSpec;
  componentOrder: string[];
  fiducials: unknown;
  modelVersion: number;
}

export async function saveBridgeArchive(archive: BridgeArchive): Promise<void> {
  await kvSet(`bridge:${archive.spec.id}`, archive);
}
export async function loadBridgeArchive(id: string): Promise<BridgeArchive | undefined> {
  return kvGet(`bridge:${id}`);
}
export async function listBridges(): Promise<BridgeArchive[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORES.kv, 'readonly');
    const req = t.objectStore(STORES.kv).getAllKeys();
    req.onsuccess = () => {
      const keys = (req.result as string[]).filter((k) => k.startsWith('bridge:'));
      Promise.all(keys.map((k) => kvGet<BridgeArchive>(k))).then((v) =>
        resolve(v.filter((x): x is BridgeArchive => !!x)),
      );
    };
    req.onerror = () => reject(req.error);
  });
}

export async function wipeAll(): Promise<void> {
  const db = await openDB();
  await Promise.all(Object.values(STORES).map((name) => tx(name, 'readwrite', (s) => s.clear())));
  void db;
}
