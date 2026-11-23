// 合成测试数据：三跨小箱梁 + 已知长度裂缝 + 两期离屏渲染照片 + POS 噪声 + 异常照片
import { BridgeSpec, DefectKind, DefectRecord, EpochRecord, PhotoFlag, PhotoRecord, SerializedCamera, TiePoint } from '../types';
import { Renderer } from '../render/renderer';
import { CameraModel, serializeCamera, projectPoint, gimbalFromRotation } from './camera';
import { EnuFrame } from './geo';
import { Vec3, v3dist, v3lerp, v3norm, v3sub, lookAtRotation, rad, deg } from './math';
import { buildBridge, BridgeGeometry, pointToSurface, ComponentGeometry, SurfaceDef } from './geometry';
import { crackWidthPx, polylineLengthMm } from './defectUtils';
import { db, putImageBlob } from './db';

// 确定性随机
export class Rng {
  private s: number;
  constructor(seed = 1234567) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s * 1664525 + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  gauss(sigma: number): number {
    const u = Math.max(this.next(), 1e-9), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
  }
}

export const SYNTH_BRIDGE_ID = 'B-SYNTH-001';
const IMG_W = 1024;
const IMG_H = 768;

export function synthSpec(): BridgeSpec {
  return {
    type: 'BOX_SMALL',
    name: '合成试验桥(三跨小箱梁)',
    spanCount: 3,
    spanLengths: [20, 20, 20],
    girderCount: 4,
    bridgeWidth: 12,
    pierHeight: 6,
    origin: { lon: 118.78, lat: 32.06, height: 12 },
    bearingGap: 0.08,
    columnCount: 2,
  };
}

interface GroundTruthDefect {
  kind: DefectKind;
  points: Vec3[];
  widthMm: number | null;
  lengthMm: number;
  componentId: string;
  surface: string;
  epoch: 1 | 2;
  code: string;
}

// 在构件表面沿 u 方向生成一条裂缝，真实长度已知
function makeCrack(
  geo: BridgeGeometry, componentId: string, surfaceName: string,
  uStart: number, lengthM: number, rng: Rng, epoch: 1 | 2, code: string, widthMm = 0.18
): GroundTruthDefect {
  const cg = geo.components.find((c) => c.component.id === componentId)!;
  const surf = cg.surfaces.find((s) => s.name === surfaceName)!;
  const vMid = (surf.vRange[0] + surf.vRange[1]) / 2;
  const pts: Vec3[] = [];
  const steps = 9;
  for (let i = 0; i <= steps; i++) {
    const u = uStart + (lengthM * i) / steps;
    const jitter = (i === 0 || i === steps) ? 0 : rng.gauss(0.012);
    pts.push(surf.toWorld(u, vMid + jitter));
  }
  return {
    kind: 'crack', points: pts, widthMm,
    lengthMm: polylineLengthMm(pts.map((p) => ({ world: p }))),
    componentId, surface: surfaceName, epoch, code,
  };
}

export interface SynthPlan {
  geometry: BridgeGeometry;
  frame: EnuFrame;
  defects: GroundTruthDefect[];
  cameras: { epoch: 1 | 2; cam: CameraModel; target: Vec3 }[];
}

// 规划两期拍摄机位：桥下两侧斜向上覆盖，每跨每侧 2 个机位(每期 12 张)
export function planShooting(geometry: BridgeGeometry, rng: Rng): SynthPlan['cameras'] {
  const cams: SynthPlan['cameras'] = [];
  const spanX = [10, 30, 50];
  const sides = [-1, 1];
  let idx = 0;
  for (const epoch of [1, 2] as const) {
    for (const sx of spanX) {
      for (const side of sides) {
        for (const lane of [0, 1]) {
          idx++;
          const along = lane === 0 ? -3.2 : 3.2;
          const target: Vec3 = [sx + rng.range(-1.0, 1.0), side * 2.2, -0.2];
          const eye: Vec3 = [
            sx + along + rng.range(-1.2, 1.2) + (epoch === 2 ? 0.4 : 0),
            side * (7.5 + rng.range(-0.6, 0.6)),
            -3.2 + rng.range(-0.5, 0.5),
          ];
          const R = lookAtRotation(eye, target);
          const fx = 980 + rng.range(-15, 15);
          const cam: CameraModel = {
            width: IMG_W, height: IMG_H, fx, fy: fx,
            cx: IMG_W / 2 + rng.range(-6, 6), cy: IMG_H / 2 + rng.range(-6, 6),
            k1: rng.range(-0.08, -0.05), k2: rng.range(0.004, 0.012),
            R, C: eye,
          };
          cams.push({ epoch, cam, target });
        }
      }
    }
  }
  return cams;
}

export function buildGroundTruth(geometry: BridgeGeometry, rng: Rng): GroundTruthDefect[] {
  const defects: GroundTruthDefect[] = [];
  // 选第 2 跨 3 号梁腹板(用户场景同款描述)
  const s2g3 = geometry.components.find(
    (c) => c.component.part === 'main_girder' && c.component.spanNo === 2 && c.component.girderNo === 3
  )!;
  defects.push(makeCrack(geometry, s2g3.component.id, 'webNegY', 2.0, 1.25, rng, 1, 'LF-S2-#3-01', 0.18));
  // 第 1 跨 2 号梁
  const s1g2 = geometry.components.find(
    (c) => c.component.part === 'main_girder' && c.component.spanNo === 1 && c.component.girderNo === 2
  )!;
  defects.push(makeCrack(geometry, s1g2.component.id, 'webPosY', 4.0, 0.9, rng, 1, 'LF-S1-#2-01', 0.12));
  // 盖梁背面裂缝
  const cap = geometry.components.find((c) => c.component.part === 'cap_beam' && c.component.pierNo === 1)!;
  defects.push(makeCrack(geometry, cap.component.id, 'sideNegY', 0.2, 0.7, rng, 1, 'LF-P1-GL-01', 0.15));
  // 第二期：S2-#3 裂缝延伸 + 一条新增
  const extended = extendCrack(defects[0], s2g3, 0.45, rng);
  defects.push(extended);
  defects.push(makeCrack(geometry, s1g2.component.id, 'bottom', 6.0, 0.6, rng, 2, 'LF-S1-#2-02', 0.1));
  return defects;
}

function extendCrack(prev: GroundTruthDefect, cg: ComponentGeometry, extraM: number, rng: Rng): GroundTruthDefect {
  const surf = cg.surfaces.find((s) => s.name === prev.surface)!;
  const last = prev.points[prev.points.length - 1];
  const mapped = pointToSurface(cg, last, 0.05)!;
  const pts = [...prev.points];
  for (let i = 1; i <= 4; i++) {
    const u = mapped.local[0] + (extraM * i) / 4;
    const v = mapped.local[1] + rng.gauss(0.012);
    pts.push(surf.toWorld(u, v));
  }
  return {
    ...prev,
    points: pts,
    epoch: 2,
    code: prev.code + '-E2',
    lengthMm: polylineLengthMm(pts.map((p) => ({ world: p }))),
  };
}

// ---------- 主生成流程 ----------
export interface GenerateOptions {
  posNoiseM: number; // POS 平面噪声 σ
  angleNoiseDeg: number; // 云台角噪声 σ
  focalBiasPct: number; // 标称焦距偏差
}

export async function generateSyntheticDataset(
  renderer: Renderer,
  opts: GenerateOptions = { posNoiseM: 0.6, angleNoiseDeg: 1.5, focalBiasPct: 3 }
): Promise<{ bridgeId: string; epochIds: string[]; groundTruth: GroundTruthDefect[]; photoCount: number }> {
  const rng = new Rng(20261123);
  const spec = synthSpec();
  const geometry = buildBridge(spec, SYNTH_BRIDGE_ID);
  renderer.loadBridge(geometry);
  const frame = new EnuFrame(spec.origin);

  // 桥梁档案 + 构件入库
  await db.saveBridge({ id: SYNTH_BRIDGE_ID, spec, createdAt: Date.now() });
  await db.saveComponents(SYNTH_BRIDGE_ID, geometry.components.map((c) => c.component));

  // 期次
  const epochs: EpochRecord[] = [
    { id: 'E-SYNTH-1', bridgeId: SYNTH_BRIDGE_ID, name: '2025年初检', date: '2025-04-12', note: '合成数据第一期', createdAt: Date.now() },
    { id: 'E-SYNTH-2', bridgeId: SYNTH_BRIDGE_ID, name: '2026年复检', date: '2026-05-08', note: '合成数据第二期', createdAt: Date.now() },
  ];
  for (const e of epochs) await db.saveEpoch(e);

  const gtDefects = buildGroundTruth(geometry, rng);
  const cameras = planShooting(geometry, rng);
  let photoCount = 0;

  for (const shot of cameras) {
    const { epoch, cam } = shot;
    const epochId = epoch === 1 ? epochs[0].id : epochs[1].id;
    const overexposed = rng.next() < 0.08;
    // 离屏渲染 + 畸变
    const { canvas } = renderer.renderSyntheticPhoto(cam, overexposed);
    drawCracksOnCanvas(canvas, cam, gtDefects.filter((d) => d.epoch === epoch), geometry);

    const photoId = `P-SYNTH-${String(photoCount + 1).padStart(3, '0')}`;
    // POS 加噪
    const trueGeo = frame.toGeo(cam.C);
    const noisyPos = {
      lon: trueGeo.lon + rng.gauss(opts.posNoiseM) / 111000,
      lat: trueGeo.lat + rng.gauss(opts.posNoiseM) / 111000,
      height: trueGeo.height + rng.gauss(opts.posNoiseM * 0.5),
    };
    const trueGimbal = gimbalFromRotation(cam.R);
    const gimbal = {
      yaw: trueGimbal.yaw + rng.gauss(opts.angleNoiseDeg),
      pitch: trueGimbal.pitch + rng.gauss(opts.angleNoiseDeg),
      roll: trueGimbal.roll + rng.gauss(opts.angleNoiseDeg * 0.5),
    };
    const focalMm = 8.8 * (1 + opts.focalBiasPct / 100 + rng.gauss(0.01));
    const flags: PhotoFlag[] = [];
    let pos = noisyPos;
    let gimbalStored: typeof gimbal | null = gimbal;
    // 约每 10 张抽 1 张缺 POS(避开最后一张)
    const noPos = photoCount > 0 && photoCount % 10 === 4;
    if (noPos) {
      pos = null as never;
      gimbalStored = null;
      flags.push('no_pos');
    }
    if (overexposed) flags.push('overexposed');

    // 自动同名点：把可见的裂缝点+表面网格点投影回照片，作为"人工点选"的模拟真值
    const ties = simulateTiePoints(cam, geometry, gtDefects.filter((d) => d.epoch === epoch), rng);

    const record: PhotoRecord = {
      id: photoId,
      bridgeId: SYNTH_BRIDGE_ID,
      epochId,
      fileName: `DJI_${photoCount + 1001}.jpg`,
      width: IMG_W,
      height: IMG_H,
      pos: noPos ? null : pos,
      gimbal: gimbalStored,
      focalMm: noPos ? null : focalMm,
      camera: null,
      status: noPos ? 'pending' : 'coarse',
      flags,
      rms: null,
      tiePoints: ties,
      createdAt: Date.now(),
      synthetic: true,
    };
    await db.savePhoto(record);
    // 缩略图(1/4)与原图都存 Blob
    const fullBlob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.92));
    const thumb = await downscale(canvas, 0.25);
    await putImageBlob(`full:${photoId}`, fullBlob);
    await putImageBlob(`thumb:${photoId}`, thumb);
    photoCount++;
  }

  // 病害登记(两期)
  for (const epoch of [1, 2] as const) {
    const epochId = epoch === 1 ? epochs[0].id : epochs[1].id;
    const list = gtDefects.filter((d) => d.epoch === epoch);
    let n = 0;
    for (const gt of list) {
      n++;
      const cg = geometry.components.find((c) => c.component.id === gt.componentId)!;
      const points = gt.points.map((p) => ({
        world: p,
        local: pointToSurface(cg, p, 0.05)?.local ?? [0, 0],
      }));
      const rec: DefectRecord = {
        id: `D-SYNTH-${epoch}-${n}`,
        bridgeId: SYNTH_BRIDGE_ID,
        componentId: gt.componentId,
        epochId,
        kind: gt.kind,
        code: gt.code,
        surface: gt.surface,
        points,
        widthMm: gt.widthMm,
        lengthMm: gt.lengthMm,
        areaM2: null,
        severity: gt.lengthMm > 1000 ? 2 : 1,
        photoId: null,
        note: '合成已知长度裂缝',
        predecessorId: epoch === 2 && gt.code.endsWith('-E2') ? 'D-SYNTH-1-1' : null,
        createdAt: Date.now(),
      };
      await db.saveDefect(rec);
    }
  }

  return { bridgeId: SYNTH_BRIDGE_ID, epochIds: epochs.map((e) => e.id), groundTruth: gtDefects, photoCount };
}

// 在合成照片上画裂缝(像素折线，宽度按物距换算)
function drawCracksOnCanvas(canvas: HTMLCanvasElement, cam: CameraModel, defects: GroundTruthDefect[], geometry: BridgeGeometry): void {
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const d of defects) {
    const projected = d.points.map((p) => projectPoint(cam, p));
    if (projected.some(([u, v]) => u < 0 || u > cam.width || v < 0 || v > cam.height)) {
      // 部分可见也画，clip 到画布
    }
    ctx.strokeStyle = 'rgba(20,18,16,0.92)';
    const w = d.widthMm ? crackWidthPx(d.widthMm, cam, d.points[0]) : 1.4;
    ctx.lineWidth = Math.max(1.1, w);
    ctx.beginPath();
    projected.forEach(([u, v], i) => {
      // 图像原点在左上，canvas 已是常规方向，projectPoint 用 y 下相机系 -> 直接使用
      if (i === 0) ctx.moveTo(u, v);
      else ctx.lineTo(u, v);
    });
    ctx.stroke();
  }
  ctx.restore();
}

// 模拟人工同名点：选裂缝点 + 构件表面规则采样点，投影到照片并加 0.3px 点击噪声，保证在画面内
function simulateTiePoints(cam: CameraModel, geometry: BridgeGeometry, defects: GroundTruthDefect[], rng: Rng): TiePoint[] {
  const ties: TiePoint[] = [];
  const seen = new Set<string>();
  const pushPoint = (p: Vec3) => {
    const [u, v] = projectPoint(cam, p);
    if (u < 40 || u > cam.width - 40 || v < 40 || v > cam.height - 40) return;
    const key = p.map((x) => x.toFixed(2)).join(',');
    if (seen.has(key)) return;
    seen.add(key);
    ties.push({
      id: `tp-${ties.length}`,
      image: [u + rng.gauss(0.3), v + rng.gauss(0.3)],
      world: [p[0], p[1], p[2]],
    });
  };
  for (const d of defects) d.points.forEach(pushPoint);
  // 表面采样补充到 >= 8 个点
  const girders = geometry.components.filter((c) => c.component.part === 'main_girder');
  for (const cg of girders) {
    for (const surf of cg.surfaces) {
      if (surf.name.includes('top')) continue;
      for (let i = 0; i < 4; i++) {
        const u = surf.uRange[0] + (surf.uRange[1] - surf.uRange[0]) * rng.range(0.15, 0.85);
        const v = surf.vRange[0] + (surf.vRange[1] - surf.vRange[0]) * rng.range(0.2, 0.8);
        pushPoint(surf.toWorld(u, v));
      }
    }
  }
  return ties.slice(0, 24);
}

async function downscale(source: HTMLCanvasElement, scale: number): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = Math.max(64, Math.round(source.width * scale));
  c.height = Math.max(64, Math.round(source.height * scale));
  const ctx = c.getContext('2d')!;
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.75));
}

// 供 UI 展示真实相机(验收对比用)
export function trueCameraOf(photo: PhotoRecord): SerializedCamera | null {
  return photo.camera;
}

export { v3dist, v3lerp, v3norm, v3sub, rad, deg };
