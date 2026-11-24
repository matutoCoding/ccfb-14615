// 合成测试数据：三跨小箱梁桥、已知长度裂缝、两期离屏渲染照片、带噪 POS、异常照片。
import type {
  BridgeModel, DefectRecord, FiducialPoint, InspectionEpoch, PhotoRecord, POSData,
} from '../core/types';
import { buildBridge, spanStartX, girderY } from '../core/bridgeModel';
import type { BridgeSpec } from '../core/types';
import { defaultIntrinsics, type CameraIntrinsics, type CameraPose } from '../core/camera';
import { poseFromPOS } from '../core/geo';
import { v3, type Vec3 } from '../core/mathTypes';
import { surfacePoint } from '../core/geometry';
import { SceneRenderer, type CrackOverlay } from '../render/sceneRenderer';
import { detectMarkers, measureOverexposure } from './markerDetect';
import { putBlob } from '../core/db';

export interface SyntheticOptions {
  bridgeId: string;
  photosPerSpan: number; // 每跨每个拍摄面的照片数
  posNoise: { xy: number; z: number; angle: number }; // POS 噪声（米、度）
  seed: number;
}

/** 可复现随机数（mulberry32） */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gauss(): number {
    const u = Math.max(1e-9, this.next()), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
}

const W = 1024, H = 768;

/** 控制点标志圆盘半径（米），检测端与渲染端共用 */
export const FIDUCIAL_RADIUS_M = 0.09;

export function defaultBridgeSpec(id: string): BridgeSpec {
  return {
    id,
    name: '测试桥·三跨预应力小箱梁中桥',
    code: 'K12+340-XSX-01',
    type: 'simply-supported-box',
    spanCount: 3,
    spanLengths: [20, 20, 20],
    girderCount: 4,
    deckWidth: 12.0,
    girderHeight: 1.2,
    boxTopWidth: 2.7,
    boxBottomWidth: 1.5,
    flangeWidth: 2.6,
    webThickness: 0.18,
    diaphragmCount: 2,
    pierHeight: [4.5, 4.2],
    pierColumns: 2,
    columnDiameter: 1.1,
    capWidth: 1.6,
    capHeight: 1.3,
    originLon: 116.391,
    originLat: 39.907,
    createdAt: 0,
  };
}

/** 生成已知长度的裂缝（端点给定，米制 UV 折线） */
export function makeCrack(
  id: string, bridgeId: string, epochId: string, componentId: string, surfaceId: string,
  startUV: { u: number; v: number }, du: number, dv: number, segments: number,
  jitter: number, widthMm: number, severity: 1 | 2 | 3 | 4 | 5, rng: Rng,
): DefectRecord {
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    points.push({
      surfaceId,
      u: startUV.u + du * t + (i > 0 && i < segments ? rng.gauss() * jitter : 0),
      v: startUV.v + dv * t + (i > 0 && i < segments ? rng.gauss() * jitter : 0),
    });
  }
  let lengthM = 0;
  for (let i = 1; i < points.length; i++) {
    lengthM += Math.hypot(points[i].u - points[i - 1].u, points[i].v - points[i - 1].v);
  }
  return {
    id, bridgeId, epochId, componentId, type: 'crack',
    points, lengthM, areaM2: 0, widthMm, severity,
    description: `合成裂缝（设计长度 ${Math.hypot(du, dv).toFixed(3)} m）`,
    createdAt: 0,
  };
}

function makeOtherDefect(
  id: string, bridgeId: string, epochId: string, componentId: string, surfaceId: string,
  center: { u: number; v: number }, w: number, h: number,
  type: DefectRecord['type'], severity: 1 | 2 | 3 | 4 | 5,
): DefectRecord {
  const pts = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    pts.push({ surfaceId, u: center.u + Math.cos(a) * w / 2, v: center.v + Math.sin(a) * h / 2 });
  }
  return {
    id, bridgeId, epochId, componentId, type, points: pts,
    lengthM: 0, areaM2: Math.PI * (w / 2) * (h / 2), widthMm: 0, severity,
    description: '合成面状病害', createdAt: 0,
  };
}

/** 在模型上布置两期病害（一期建立，二期延伸+新增） */
export function buildSyntheticDefects(
  model: BridgeModel, bridgeId: string, epochA: string, epochB: string, rng: Rng,
): { epochA: DefectRecord[]; epochB: DefectRecord[]; truths: { id: string; designedM: number; componentId: string; surfaceId: string }[] } {
  const truths: { id: string; designedM: number; componentId: string; surfaceId: string }[] = [];
  const g12 = model.components.find((c) => c.code === '1-2#主梁')!;
  const g23 = model.components.find((c) => c.code === '2-3#主梁')!;
  const g31 = model.components.find((c) => c.code === '3-1#主梁')!;
  const webL = (g: typeof g12) => g.surfaces.find((s) => s.name === '左侧腹板')!;
  const bottom = (g: typeof g12) => g.surfaces.find((s) => s.name === '底板底面')!;

  // 一期：三条裂缝，长度已知
  const a1 = makeCrack('d-a1', bridgeId, epochA, g12.id, webL(g12).id,
    { u: 3.0, v: 0.25 }, 0.0, 0.62, 10, 0.012, 0.18, 3, rng);
  const a2 = makeCrack('d-a2', bridgeId, epochA, g23.id, bottom(g23).id,
    { u: 5.0, v: 0.25 }, 1.25, 0.0, 12, 0.01, 0.12, 2, rng);
  const a3 = makeCrack('d-a3', bridgeId, epochA, g31.id, webL(g31).id,
    { u: 12.0, v: 0.2 }, 0.0, 0.45, 8, 0.012, 0.25, 4, rng);
  truths.push(
    { id: a1.id, designedM: 0.62, componentId: g12.id, surfaceId: webL(g12).id },
    { id: a2.id, designedM: 1.25, componentId: g23.id, surfaceId: bottom(g23).id },
    { id: a3.id, designedM: 0.45, componentId: g31.id, surfaceId: webL(g31).id },
  );
  const a4 = makeOtherDefect('d-a4', bridgeId, epochA, g12.id, bottom(g12).id,
    { u: 15, v: 0.75 }, 0.5, 0.35, 'spalling', 3);
  const a5 = makeOtherDefect('d-a5', bridgeId, epochA, g23.id, webL(g23).id,
    { u: 8, v: 0.5 }, 0.8, 0.5, 'seepage', 2);

  // 二期：a1 延伸 0.21m，a2 延伸 0.30m，a3 不变；新增一条裂缝 b1
  const b1extend = makeCrack('d-b1', bridgeId, epochB, g12.id, webL(g12).id,
    { u: 3.0, v: 0.25 }, 0.0, 0.83, 13, 0.012, 0.2, 3, new Rng(rng.next() * 1e9));
  const b2extend = makeCrack('d-b2', bridgeId, epochB, g23.id, bottom(g23).id,
    { u: 5.0, v: 0.25 }, 1.55, 0.0, 14, 0.01, new Rng(rng.next() * 1e9).next() * 0 + 0.14, 2, new Rng(99));
  const b3same = makeCrack('d-b3', bridgeId, epochB, g31.id, webL(g31).id,
    { u: 12.0, v: 0.2 }, 0.0, 0.45, 8, 0.012, 0.25, 4, new Rng(7));
  const b4new = makeCrack('d-b4', bridgeId, epochB, g31.id, bottom(g31).id,
    { u: 4.0, v: 0.4 }, 0.7, 0.0, 8, 0.01, 0.15, 2, new Rng(13));
  truths.push(
    { id: b1extend.id, designedM: 0.83, componentId: g12.id, surfaceId: webL(g12).id },
    { id: b2extend.id, designedM: 1.55, componentId: g23.id, surfaceId: bottom(g23).id },
    { id: b3same.id, designedM: 0.45, componentId: g31.id, surfaceId: webL(g31).id },
    { id: b4new.id, designedM: 0.7, componentId: g31.id, surfaceId: bottom(g31).id },
  );
  const b5 = makeOtherDefect('d-b5', bridgeId, epochB, g12.id, bottom(g12).id,
    { u: 15, v: 0.75 }, 0.55, 0.38, 'spalling', 3);

  return {
    epochA: [a1, a2, a3, a4, a5],
    epochB: [b1extend, b2extend, b3same, b4new, b5],
    truths,
  };
}

interface PlannedShot {
  cam: Vec3;
  yaw: number; pitch: number; roll: number;
  target: string; // bottom / web-l / web-r / cap
  spanNo: number;
  overexpose: boolean;
  missingPos: boolean;
}

/** 规划无人机航线：桥下仰拍，覆盖底板与两侧腹板 */
function planFlights(spec: BridgeSpec, rng: Rng, includeFaults: boolean): PlannedShot[] {
  const shots: PlannedShot[] = [];
  for (let span = 1; span <= spec.spanCount; span++) {
    const x0 = spanStartX(spec, span);
    const L = spec.spanLengths[span - 1];
    const stations = 4;
    // 沿桥宽布置多条垂直航线，保证每片主梁底板都被仰拍覆盖
    const laneYs = [-4.5, -1.5, 1.5, 4.5];
    for (let k = 0; k < stations; k++) {
      const x = x0 + L * ((k + 0.5) / stations);
      for (const laneY of laneYs) {
        // 底板正下方仰拍：垂直向上(pitch=-90)，相机在桥底 3~4m
        shots.push({
          cam: v3(x + rng.range(-0.3, 0.3), laneY + rng.range(-0.4, 0.4), -spec.girderHeight - rng.range(3.0, 4.0)),
          yaw: 90 + rng.range(-3, 3), pitch: -90 + rng.range(-2, 2), roll: rng.range(-3, 3),
          target: 'bottom', spanNo: span, overexpose: false, missingPos: false,
        });
      }
      // 两侧斜拍腹板（相机在 +Y 侧看向 -Y：小 yaw；在 -Y 侧看向 +Y：大 yaw）
      for (const side of [-1, 1]) {
        shots.push({
          cam: v3(x + rng.range(-0.4, 0.4), side * (spec.deckWidth / 2 + 0.5 + rng.range(-0.2, 0.3)),
            -spec.girderHeight - rng.range(1.6, 2.4)),
          yaw: side > 0 ? 35 + rng.range(-5, 5) : 145 + rng.range(-5, 5),
          pitch: -38 + rng.range(-6, 6), roll: rng.range(-4, 4),
          target: side > 0 ? 'web-r' : 'web-l', spanNo: span,
          overexpose: false, missingPos: false,
        });
      }
    }
  }
  // 盖梁斜拍（每个墩 2 张）
  let cum = 0;
  for (let p = 1; p < spec.spanCount; p++) {
    cum += spec.spanLengths[p - 1];
    for (const side of [-1, 1]) {
      shots.push({
        cam: v3(cum + side * 1.2, rng.range(-1, 1), -spec.girderHeight - 2.6),
        yaw: side > 0 ? 70 : 110, pitch: -40 + rng.range(-5, 5), roll: rng.range(-3, 3),
        target: 'cap', spanNo: p, overexpose: false, missingPos: false,
      });
    }
  }
  if (includeFaults) {
    // 一张过曝、一张缺 POS（都放在第 1 跨）
    shots[2] = { ...shots[2], overexpose: true };
    shots[5] = { ...shots[5], missingPos: true };
  }
  return shots;
}

function noisyPose(shot: PlannedShot, spec: BridgeSpec, rng: Rng, noise: SyntheticOptions['posNoise']): { pose: CameraPose; pos: POSData } {
  const cam = v3(
    shot.cam.x + rng.gauss() * noise.xy,
    shot.cam.y + rng.gauss() * noise.xy,
    shot.cam.z + rng.gauss() * noise.z,
  );
  const yaw = shot.yaw + rng.gauss() * noise.angle;
  const pitch = shot.pitch + rng.gauss() * noise.angle;
  const roll = shot.roll + rng.gauss() * noise.angle * 0.5;
  const pose = poseFromPOS(cam, yaw, pitch, roll);
  // 反算经纬度 POS（局部系即 ENU，原点为桥址）
  const lon = spec.originLon + cam.x / (111320 * Math.cos((spec.originLat * Math.PI) / 180));
  const lat = spec.originLat + cam.y / 110540;
  const pos: POSData = {
    lon, lat, altitude: cam.z, yaw, pitch, roll, hasPOS: !shot.missingPos,
  };
  return { pose, pos };
}

export interface GeneratedEpoch {
  epoch: InspectionEpoch;
  photos: PhotoRecord[];
  defects: DefectRecord[];
  /** 真值相机（自测用，不入库） */
  groundTruth: { photoId: string; K: CameraIntrinsics; pose: CameraPose }[];
}

export interface GeneratedDataset {
  spec: BridgeSpec;
  model: BridgeModel;
  epochs: GeneratedEpoch[];
  truths: { id: string; designedM: number; componentId: string; surfaceId: string }[];
}

/** 完整生成两期数据集并入库（照片 Blob 存 IndexedDB） */
export async function generateSyntheticDataset(
  renderer: SceneRenderer,
  opts: SyntheticOptions,
): Promise<GeneratedDataset> {
  const rng = new Rng(opts.seed);
  const spec = defaultBridgeSpec(opts.bridgeId);
  spec.createdAt = Date.now();
  const model = buildBridge(spec);
  renderer.loadModel(model);
  renderer.buildMarkers(model.fiducials, FIDUCIAL_RADIUS_M);

  const epochAId = `${opts.bridgeId}-epoch-1`;
  const epochBId = `${opts.bridgeId}-epoch-2`;
  const defects = buildSyntheticDefects(model, opts.bridgeId, epochAId, epochBId, rng);
  const cracksA = renderer.buildCrackOverlays(model, defects.epochA);
  const cracksB = renderer.buildCrackOverlays(model, defects.epochB);

  const epochs: GeneratedEpoch[] = [];
  const fTrue = Math.max(W, H) * 1.15; // 真实焦距
  const k1True = -0.12, k2True = 0.035, p1True = 0.002, p2True = -0.0015;

  const epochSpecs: { id: string; date: string; name: string; cracks: CrackOverlay[]; defects: DefectRecord[] }[] = [
    { id: epochAId, date: '2025-05-18', name: '一期（初次）定检', cracks: cracksA, defects: defects.epochA },
    { id: epochBId, date: '2026-05-22', name: '二期（复检）定检', cracks: cracksB, defects: defects.epochB },
  ];

  for (let ei = 0; ei < epochSpecs.length; ei++) {
    const es = epochSpecs[ei];
    const epoch: InspectionEpoch = {
      id: es.id, bridgeId: opts.bridgeId, name: es.name, date: es.date, note: es.name, createdAt: Date.now(),
    };
    const shots = planFlights(spec, new Rng(opts.seed + ei + 1), true);
    const photos: PhotoRecord[] = [];
    const groundTruth: GeneratedEpoch['groundTruth'] = [];
    for (let si = 0; si < shots.length; si++) {
      const shot = shots[si];
      const { pose, pos } = noisyPose(shot, spec, new Rng(opts.seed * 7 + ei * 1000 + si), opts.posNoise);
      const K: CameraIntrinsics = {
        ...defaultIntrinsics(W, H, fTrue),
        k1: k1True, k2: k2True, p1: p1True, p2: p2True,
      };
      const canvas = renderer.renderPhoto(K, pose, {
        markers: model.fiducials,
        cracks: es.cracks,
        overexpose: shot.overexpose ? 0.78 : 0,
      });
      void canvas;
      const blob = await renderer.snapshot();
      const id = `${es.id}-ph-${String(si + 1).padStart(3, '0')}`;
      const blobKey = `blob:photo:${id}`;
      const thumbKey = `blob:thumb:${id}`;
      await putBlob(blobKey, blob);
      await putBlob(thumbKey, blob); // 缩略同图，前端按需缩放
      const over = shot.overexpose ? await measureOverexposure(blob) : 0;
      let status: PhotoRecord['status'];
      if (shot.missingPos) status = 'pending-pos';
      else if (shot.overexpose && over > 0.35) status = 'rejected-overexposed';
      else status = 'coarse';
      photos.push({
        id, bridgeId: opts.bridgeId, epochId: es.id,
        filename: `DJI_${ei + 1}${String(si + 1).padStart(4, '0')}.jpg`,
        width: W, height: H, pos, status, overexposure: over,
        imageBlobKey: blobKey, thumbBlobKey: thumbKey, importedAt: Date.now(),
      });
      groundTruth.push({ photoId: id, K, pose });
    }
    epochs.push({
      epoch,
      photos,
      defects: es.defects,
      groundTruth,
    });
  }

  return { spec, model, epochs, truths: defects.truths };
}

/**
 * 自动配准：对每张 coarse 照片用粗位姿找标志、检测圆心、解 PnP。
 * 缺 POS / 过曝照片不参与，留给人工流程。
 */
export async function autoRegister(
  photos: PhotoRecord[],
  fids: FiducialPoint[],
  getBlob: (key: string) => Promise<Blob | undefined>,
  fGuess: number,
): Promise<{ photoId: string; gcps: { fiducialId: number; image: { x: number; y: number }; object: Vec3 }[]; rms?: number; error?: string }[]> {
  const { solvePnP } = await import('../core/pnp');
  const results = [];
  for (const ph of photos) {
    if (ph.status !== 'coarse') {
      results.push({ photoId: ph.id, gcps: [], error: `状态为 ${ph.status}，跳过自动配准` });
      continue;
    }
    const blob = await getBlob(ph.thumbBlobKey ?? ph.imageBlobKey ?? '');
    if (!blob) { results.push({ photoId: ph.id, gcps: [], error: '图像缺失' }); continue; }
    // 用 POS 反算局部相机位置（局部系即 ENU，原点为桥址，合成数据原点固定；真实数据从 spec 取）
    const localCam = v3(
      (ph.pos.lon - 116.391) * (111320 * Math.cos((39.907 * Math.PI) / 180)),
      (ph.pos.lat - 39.907) * 110540,
      ph.pos.altitude,
    );
    const pose0 = poseFromPOS(localCam, ph.pos.yaw, ph.pos.pitch, ph.pos.roll);
    const K0 = defaultIntrinsics(ph.width, ph.height, fGuess);
    // 预期标志半径（像素）：f * R / Z
    const detected = await detectMarkers(blob, fids, K0, pose0, (fGuess * FIDUCIAL_RADIUS_M) / 3.2);
    if (detected.length < 4) {
      results.push({ photoId: ph.id, gcps: [], error: `仅检测到 ${detected.length} 个标志，不足 4 个` });
      continue;
    }
    const gcps = detected.map((d) => {
      const fid = fids.find((f) => f.id === d.fiducialId)!;
      return { fiducialId: d.fiducialId, image: { x: d.x, y: d.y }, object: fid.position };
    });
    try {
      const res = solvePnP(gcps.map((g) => ({ object: g.object, image: g.image })), ph.width, ph.height, {
        fGuess,
        initialPose: pose0,
      });
      results.push({ photoId: ph.id, gcps, rms: res.rms });
    } catch (e) {
      results.push({ photoId: ph.id, gcps, error: (e as Error).message });
    }
  }
  return results;
}

export { surfacePoint, girderY };
