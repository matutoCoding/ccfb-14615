// 应用状态仓库：当前桥梁/期次/几何 + 订阅通知
import { BridgeRecord, BridgeSpec, ComponentRecord, EpochRecord, PhotoRecord, DefectRecord } from '../types';
import { buildBridge, BridgeGeometry } from './geometry';
import { db, saveGeometry } from './db';

type Listener = () => void;

class AppStore {
  bridge: BridgeRecord | null = null;
  geometry: BridgeGeometry | null = null;
  components: ComponentRecord[] = [];
  epochs: EpochRecord[] = [];
  photos: PhotoRecord[] = [];
  defects: DefectRecord[] = [];
  currentEpochId: string | null = null;
  selectedComponentId: string | null = null;
  selectedPhotoId: string | null = null;
  private listeners = new Set<Listener>();
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  async createBridge(spec: BridgeSpec): Promise<BridgeRecord> {
    const id = `B${Date.now().toString(36)}`;
    const rec: BridgeRecord = { id, spec, createdAt: Date.now() };
    const geometry = buildBridge(spec, id);
    await db.saveBridge(rec);
    await db.saveComponents(id, geometry.components.map((c) => c.component));
    await saveGeometry(id, geometry);
    await this.loadBridge(id);
    return rec;
  }

  async loadBridge(id: string): Promise<void> {
    const rec = await db.getBridge(id);
    if (!rec) throw new Error('桥梁档案不存在');
    this.bridge = rec;
    this.geometry = buildBridge(rec.spec, id);
    this.components = this.geometry.components.map((c) => c.component);
    this.epochs = await db.listEpochs(id);
    this.photos = await db.listPhotos(id);
    this.defects = await db.listDefects(id);
    this.currentEpochId = this.epochs[0]?.id ?? null;
    this.selectedComponentId = null;
    this.selectedPhotoId = null;
    this.emit();
  }

  async refresh(): Promise<void> {
    if (!this.bridge) return;
    const id = this.bridge.id;
    this.epochs = await db.listEpochs(id);
    this.photos = await db.listPhotos(id);
    this.defects = await db.listDefects(id);
    this.emit();
  }

  async addEpoch(name: string, date: string, note: string): Promise<EpochRecord> {
    if (!this.bridge) throw new Error('未选择桥梁');
    const rec: EpochRecord = {
      id: `E${Date.now().toString(36)}`,
      bridgeId: this.bridge.id, name, date, note, createdAt: Date.now(),
    };
    await db.saveEpoch(rec);
    this.epochs.push(rec);
    this.currentEpochId = rec.id;
    this.emit();
    return rec;
  }

  get currentEpoch(): EpochRecord | null {
    return this.epochs.find((e) => e.id === this.currentEpochId) ?? null;
  }

  componentById(id: string | null): ComponentRecord | null {
    if (!id) return null;
    return this.components.find((c) => c.id === id) ?? null;
  }

  geometryById(id: string) {
    return this.geometry?.components.find((c) => c.component.id === id) ?? null;
  }

  photosOfEpoch(epochId: string): PhotoRecord[] {
    return this.photos.filter((p) => p.epochId === epochId);
  }

  defectsOfEpoch(epochId: string): DefectRecord[] {
    return this.defects.filter((d) => d.epochId === epochId);
  }

  selectComponent(id: string | null): void {
    this.selectedComponentId = id;
    this.emit();
  }
  selectPhoto(id: string | null): void {
    this.selectedPhotoId = id;
    this.emit();
  }
  setEpoch(id: string): void {
    this.currentEpochId = id;
    this.emit();
  }
}

// HMR 安全：热重载时保留同一 store 实例，避免调试中状态丢失
interface StoreHolder { __bridgeStore?: AppStore }
const g = globalThis as unknown as StoreHolder;
export const store: AppStore = g.__bridgeStore ?? (g.__bridgeStore = new AppStore());
