// 全局应用状态：当前桥梁、检测期、模型、烘焙纹理缓存、页面间消息。
import type { BridgeModel, BridgeSpec, InspectionEpoch } from './core/types';
import { buildBridge } from './core/bridgeModel';
import {
  kvGet, kvSet, listBridges, loadBridgeArchive, saveBridgeArchive, saveComponent,
  type BridgeArchive,
} from './core/db';

interface AppStateData {
  bridgeId: string | null;
  epochId: string | null;
  model: BridgeModel | null;
  spec: BridgeSpec | null;
  epochs: InspectionEpoch[];
  bakeRevision: number; // 烘焙完成后自增，触发视图刷新
  /** 从报告/评分跳转三维定位的请求 */
  focusRequest: { componentId: string; surfaceId?: string; u?: number; v?: number; nonce: number } | null;
}

const KEY = {
  bridgeId: 'app:bridgeId',
  epochId: 'app:epochId',
};

class AppState {
  data: AppStateData = {
    bridgeId: null,
    epochId: null,
    model: null,
    spec: null,
    epochs: [],
    bakeRevision: 0,
    focusRequest: null,
  };
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    this.listeners.forEach((f) => f());
  }

  async restore(): Promise<void> {
    this.data.bridgeId = (await kvGet<string>(KEY.bridgeId)) ?? null;
    this.data.epochId = (await kvGet<string>(KEY.epochId)) ?? null;
    if (this.data.bridgeId) await this.loadBridge(this.data.bridgeId);
  }

  async listArchives(): Promise<BridgeArchive[]> {
    return listBridges();
  }

  /** 新建桥梁：建模并持久化构件网格与档案 */
  async createBridge(spec: BridgeSpec): Promise<BridgeModel> {
    const model = buildBridge(spec);
    const archive: BridgeArchive = {
      spec,
      componentOrder: model.components.map((c) => c.id),
      fiducials: model.fiducials,
      modelVersion: 1,
    };
    await saveBridgeArchive(archive);
    for (const c of model.components) await saveComponent(c);
    this.data.bridgeId = spec.id;
    this.data.model = model;
    this.data.spec = spec;
    this.data.epochs = [];
    await kvSet(KEY.bridgeId, spec.id);
    this.emit();
    return model;
  }

  async loadBridge(bridgeId: string): Promise<BridgeModel | null> {
    const archive = await loadBridgeArchive(bridgeId);
    if (!archive) return null;
    const model = buildBridge(archive.spec);
    this.data.bridgeId = bridgeId;
    this.data.model = model;
    this.data.spec = archive.spec;
    const { epochRepo } = await import('./core/db');
    this.data.epochs = (await epochRepo.all()).filter((e) => e.bridgeId === bridgeId);
    if (!this.data.epochId || !this.data.epochs.find((e) => e.id === this.data.epochId)) {
      this.data.epochId = this.data.epochs[0]?.id ?? null;
      if (this.data.epochId) await kvSet(KEY.epochId, this.data.epochId);
    }
    await kvSet(KEY.bridgeId, bridgeId);
    this.emit();
    return model;
  }

  async setEpoch(epochId: string | null): Promise<void> {
    this.data.epochId = epochId;
    await kvSet(KEY.epochId, epochId ?? '');
    this.emit();
  }

  async refreshEpochs(): Promise<void> {
    if (!this.data.bridgeId) return;
    const { epochRepo } = await import('./core/db');
    this.data.epochs = (await epochRepo.all()).filter((e) => e.bridgeId === this.data.bridgeId);
    this.emit();
  }

  bumpBake(): void {
    this.data.bakeRevision++;
    this.emit();
  }

  focusComponent(componentId: string, surfaceId?: string, u?: number, v?: number): void {
    this.data.focusRequest = { componentId, surfaceId, u, v, nonce: Date.now() };
    this.emit();
  }

  get model(): BridgeModel {
    if (!this.data.model) throw new Error('尚未选择桥梁');
    return this.data.model;
  }
  get spec(): BridgeSpec {
    if (!this.data.spec) throw new Error('尚未选择桥梁');
    return this.data.spec;
  }
  get epochId(): string | null {
    return this.data.epochId;
  }
}

export const appState = new AppState();
