// 运行期内存缓存（不持久化）：烘焙表面纹理、当前期病害、数据集真值等跨页面共享。
import type { DefectRecord, PhotoRecord } from './core/types';
import type { BakedSurface } from './vision/textureBaker';

interface RuntimeCache {
  baked: Map<string, BakedSurface>;
  bakedEpochId: string | null;
  defects: DefectRecord[];
  defectsEpochId: string | null;
  photos: PhotoRecord[];
  /** 合成数据集真值（自测用） */
  groundTruth?: unknown;
  crackTruths?: unknown;
}

export const runtime: RuntimeCache = {
  baked: new Map(),
  bakedEpochId: null,
  defects: [],
  defectsEpochId: null,
  photos: [],
};

export function setBaked(epochId: string, baked: Map<string, BakedSurface>): void {
  runtime.baked = baked;
  runtime.bakedEpochId = epochId;
}

export function setRuntimeDefects(epochId: string, defects: DefectRecord[]): void {
  runtime.defects = defects;
  runtime.defectsEpochId = epochId;
}
