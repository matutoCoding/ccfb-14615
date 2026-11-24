// 病害服务：长度/面积计算、裂缝宽度像素->毫米换算、两期对比。
import type {
  BridgeModel, ComparisonChange, DefectRecord, DefectType, SeverityClass,
} from '../core/types';
import { surfacePoint } from '../core/geometry';
import type { CameraIntrinsics, CameraPose } from '../core/camera';
import { cameraCenter } from '../core/camera';
import { dist, sub } from '../core/mathTypes';

/** 折线长度（米），沿表面米制 UV 直接量取 */
export function polylineLength(d: DefectRecord): number {
  let L = 0;
  for (let i = 1; i < d.points.length; i++) {
    if (d.points[i].surfaceId !== d.points[i - 1].surfaceId) continue;
    L += Math.hypot(d.points[i].u - d.points[i - 1].u, d.points[i].v - d.points[i - 1].v);
  }
  return L;
}

/** 多边形面积（平方米，Shoelace，同一表面内） */
export function polygonArea(d: DefectRecord): number {
  if (d.points.length < 3) return 0;
  const s0 = d.points[0].surfaceId;
  const pts = d.points.filter((p) => p.surfaceId === s0);
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.u * q.v - q.u * p.v;
  }
  return Math.abs(a) / 2;
}

/**
 * 裂缝宽度：像素宽度 -> 毫米。
 * 针孔相机下地面采样距离 GSD = S / f（米/像素），S 为物距，f 为像素焦距。
 */
export function pixelWidthToMm(
  pixelWidth: number,
  surfacePoint: { x: number; y: number; z: number },
  K: CameraIntrinsics,
  pose: CameraPose,
): number {
  const S = dist(cameraCenter(pose), surfacePoint);
  const gsdM = S / K.f;
  return pixelWidth * gsdM * 1000;
}

/** 反算：毫米宽度在给定照片上占多少像素（绘制辅助线用） */
export function mmWidthToPx(
  widthMm: number,
  p: { x: number; y: number; z: number },
  K: CameraIntrinsics,
  pose: CameraPose,
): number {
  const S = dist(cameraCenter(pose), p);
  return (widthMm / 1000) * K.f / S;
}

/** 计算并回填长度/面积 */
export function finalizeDefect(d: DefectRecord): DefectRecord {
  return {
    ...d,
    lengthM: d.type === 'crack' ? polylineLength(d) : 0,
    areaM2: d.type === 'crack' ? 0 : polygonArea(d),
  };
}

/** 沿裂缝按间隔采样世界坐标（用于三维视图叠加） */
export function defectWorldSamples(model: BridgeModel, d: DefectRecord, stepM = 0.02): { x: number; y: number; z: number }[] {
  const comp = model.components.find((c) => c.id === d.componentId);
  if (!comp) return [];
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 1; i < d.points.length; i++) {
    const a = d.points[i - 1], b = d.points[i];
    if (a.surfaceId !== b.surfaceId) continue;
    const surf = comp.surfaces.find((s) => s.id === a.surfaceId);
    if (!surf) continue;
    const segLen = Math.hypot(b.u - a.u, b.v - a.v);
    const n = Math.max(1, Math.round(segLen / stepM));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const p = surfacePoint(surf, a.u + (b.u - a.u) * t, a.v + (b.v - a.v) * t);
      out.push(p);
    }
  }
  const last = d.points[d.points.length - 1];
  const surf = comp.surfaces.find((s) => s.id === last.surfaceId);
  if (surf) out.push(surfacePoint(surf, last.u, last.v));
  return out;
}

// ---------- 两期对比 ----------

interface FlatCrack {
  defect: DefectRecord;
  componentId: string;
  surfaceId: string;
  /** 表面内采样点（米） */
  samples: { u: number; v: number }[];
}

function flatten(model: BridgeModel, defects: DefectRecord[]): FlatCrack[] {
  return defects
    .filter((d) => d.type === 'crack')
    .map((d) => {
      const bySurf = new Map<string, { u: number; v: number }[]>();
      for (const p of d.points) {
        const arr = bySurf.get(p.surfaceId) ?? [];
        arr.push({ u: p.u, v: p.v });
        bySurf.set(p.surfaceId, arr);
      }
      const [surfaceId, samples] = [...bySurf.entries()][0] ?? ['', []];
      return { defect: d, componentId: d.componentId, surfaceId, samples };
    })
    .filter((f) => f.samples.length > 1);
}

function pointSegDist(p: { u: number; v: number }, a: { u: number; v: number }, b: { u: number; v: number }): number {
  const dx = b.u - a.u, dy = b.v - a.v;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return Math.hypot(p.u - a.u, p.v - a.v);
  let t = ((p.u - a.u) * dx + (p.v - a.v) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.u - (a.u + t * dx), p.v - (a.v + t * dy));
}

function distToPolyline(p: { u: number; v: number }, samples: { u: number; v: number }[]): number {
  let best = Infinity;
  for (let i = 1; i < samples.length; i++) {
    best = Math.min(best, pointSegDist(p, samples[i - 1], samples[i]));
  }
  return best;
}

/** 匹配阈值：3cm（表面米制坐标） */
const MATCH_TOL = 0.03;

export function compareEpochs(
  model: BridgeModel,
  id: string,
  bridgeId: string,
  epochA: string,
  epochB: string,
  defectsA: DefectRecord[],
  defectsB: DefectRecord[],
): { comparison: { id: string; bridgeId: string; epochA: string; epochB: string; changes: ComparisonChange[]; createdAt: number }; stats: { matched: number; extended: number; newCount: number } } {
  const cracksA = flatten(model, defectsA);
  const cracksB = flatten(model, defectsB);
  const changes: ComparisonChange[] = [];
  const matchedB = new Set<string>();
  let extended = 0;

  for (const ca of cracksA) {
    // 找同构件同表面、距离最匹配的 B
    let best: { cb: FlatCrack; mean: number } | null = null;
    for (const cb of cracksB) {
      if (cb.componentId !== ca.componentId || cb.surfaceId !== ca.surfaceId) continue;
      const mean = ca.samples.reduce((s, p) => s + distToPolyline(p, cb.samples), 0) / ca.samples.length;
      if (mean < MATCH_TOL && (!best || mean < best.mean)) best = { cb, mean };
    }
    if (!best) continue;
    matchedB.add(best.cb.defect.id);
    const lenA = ca.defect.lengthM;
    const lenB = best.cb.defect.lengthM;
    const delta = lenB - lenA;
    if (delta > 0.02) {
      extended++;
      changes.push({
        componentId: ca.componentId, surfaceId: ca.surfaceId,
        kind: 'extended',
        defectIdA: ca.defect.id, defectIdB: best.cb.defect.id,
        extensionM: delta,
        description: `裂缝由 ${lenA.toFixed(3)} m 延伸至 ${lenB.toFixed(3)} m，增长 ${(delta * 1000).toFixed(0)} mm`,
      });
    } else {
      changes.push({
        componentId: ca.componentId, surfaceId: ca.surfaceId,
        kind: 'unchanged',
        defectIdA: ca.defect.id, defectIdB: best.cb.defect.id,
        extensionM: 0,
        description: `裂缝长度基本不变（${lenA.toFixed(3)} m → ${lenB.toFixed(3)} m）`,
      });
    }
  }

  let newCount = 0;
  for (const cb of cracksB) {
    if (matchedB.has(cb.defect.id)) continue;
    newCount++;
    changes.push({
      componentId: cb.componentId, surfaceId: cb.surfaceId,
      kind: 'new', defectIdB: cb.defect.id,
      extensionM: 0,
      description: `新发现裂缝，长度 ${cb.defect.lengthM.toFixed(3)} m，宽度 ${cb.defect.widthMm.toFixed(2)} mm`,
    });
  }

  // 面状病害：同构件同类型的新增
  const areaB = defectsB.filter((d) => d.type !== 'crack');
  for (const db of areaB) {
    const twin = defectsA.find(
      (da) => da.componentId === db.componentId && da.type === db.type &&
        Math.hypot(da.points[0].u - db.points[0].u, da.points[0].v - db.points[0].v) < 0.3,
    );
    if (!twin) {
      newCount++;
      changes.push({
        componentId: db.componentId, surfaceId: db.points[0].surfaceId,
        kind: 'new', defectIdB: db.id, extensionM: 0,
        description: `新发现${db.type === 'spalling' ? '剥落露筋' : db.type === 'seepage' ? '渗水泛白' : '蜂窝麻面'}，面积 ${db.areaM2.toFixed(2)} m²`,
      });
    }
  }

  return {
    comparison: { id, bridgeId, epochA, epochB, changes, createdAt: Date.now() },
    stats: { matched: matchedB.size, extended, newCount },
  };
}

export const DEFECT_SEVERITY_HINT: Record<DefectType, (d: DefectRecord) => SeverityClass> = {
  crack: (d) => (d.widthMm >= 0.25 ? 4 : d.widthMm >= 0.15 ? 3 : d.widthMm >= 0.08 ? 2 : 1) as SeverityClass,
  spalling: () => 3,
  seepage: () => 2,
  honeycomb: () => 2,
};

export { sub, dist };
