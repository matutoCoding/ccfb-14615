// 二维标志点检测：在合成照片上找同心圆环标志的圆心（亚像素质心）。
// 用低分辨率网格 + 连通域，避免逐像素扫描几千张照片时卡顿。
import type { FiducialPoint } from '../core/types';
import { projectPoint, type CameraIntrinsics, type CameraPose } from '../core/camera';

export interface DetectedMarker {
  fiducialId: number;
  x: number;
  y: number;
  /** 检测置信度（环带对比度） */
  score: number;
}

/** 取图像像素（drawImage 到离屏 canvas 后读像素） */
function toImageData(blob: Blob, maxSide: number): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(ctx.getImageData(0, 0, w, h));
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

interface BlobCC {
  pixels: number[];
  minX: number; maxX: number; minY: number; maxY: number;
  sumX: number; sumY: number;
}

/** 连通域（4 邻域，游程简化版），输入二值图 */
function connectedComponents(bin: Uint8Array, w: number, h: number): BlobCC[] {
  const labels = new Int32Array(w * h).fill(-1);
  const blobs: BlobCC[] = [];
  const parent: number[] = [];
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!bin[i]) continue;
      const up = y > 0 ? labels[i - w] : -1;
      const lf = x > 0 ? labels[i - 1] : -1;
      let lab: number;
      if (up < 0 && lf < 0) {
        lab = blobs.length;
        parent.push(lab);
        blobs.push({ pixels: [], minX: x, maxX: x, minY: y, maxY: y, sumX: 0, sumY: 0 });
      } else if (up >= 0 && lf < 0) lab = find(up);
      else if (up < 0 && lf >= 0) lab = find(lf);
      else {
        lab = find(up);
        const b = find(lf);
        if (b !== lab) parent[b] = lab;
      }
      labels[i] = lab;
    }
  }
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] < 0) continue;
    const root = find(labels[i]);
    const x = i % w, y = (i / w) | 0;
    const b = blobs[root];
    b.pixels.push(i);
    b.sumX += x; b.sumY += y;
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  }
  return blobs.filter((b) => b.pixels.length >= 4);
}

/**
 * 检测照片中的标志点。
 * 策略：全图找暗核连通域 -> 环带对比度验证 -> 用粗位姿投影做最近邻身份匹配。
 * 全图搜索不依赖粗投影精度，因此 POS 噪声达亚米级仍可定位。
 */
export async function detectMarkers(
  blob: Blob,
  fids: FiducialPoint[],
  K: CameraIntrinsics,
  coarsePose: CameraPose,
  expectedRadiusPx: number,
): Promise<DetectedMarker[]> {
  const data = await toImageData(blob, K.width);
  const scale = data.width / K.width;
  const { width: w, height: h, data: px } = data;
  const expect = Math.max(3, expectedRadiusPx * 0.55 * scale);
  const lumAt = (x: number, y: number): number => {
    const i = (y * w + x) * 4;
    return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  };

  // 亚像素暗度加权质心（在给定中心附近）
  const refine = (mx: number, my: number, coreR: number): { x: number; y: number } => {
    let fx = mx, fy = my;
    const r = Math.max(2, coreR);
    for (let pass = 0; pass < 2; pass++) {
      const qx0 = Math.max(0, Math.floor(fx - r)), qx1 = Math.min(w, Math.ceil(fx + r));
      const qy0 = Math.max(0, Math.floor(fy - r)), qy1 = Math.min(h, Math.ceil(fy + r));
      let sw = 0, sx = 0, sy = 0;
      for (let y = qy0; y < qy1; y++) {
        for (let x = qx0; x < qx1; x++) {
          if (Math.hypot(x - fx, y - fy) > r) continue;
          const wgt = Math.max(0, 90 - lumAt(x, y));
          if (wgt <= 0) continue;
          sw += wgt; sx += x * wgt; sy += y * wgt;
        }
      }
      if (sw > 0) { fx = sx / sw; fy = sy / sw; }
    }
    return { x: fx / scale, y: fy / scale };
  };

  const raw: { x: number; y: number }[] = [];

  // 检测器 A：亮环连通域（适合混凝土亮背景上的垂直仰拍）
  {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (lumAt(i % w, (i / w) | 0) > 115) bin[i] = 1;
    for (const cc of connectedComponents(bin, w, h)) {
      const bw = cc.maxX - cc.minX, bh = cc.maxY - cc.minY;
      if (bw < 6 || bw > Math.max(60, expect * 5) || bh < 6) continue;
      if (Math.abs(bw - bh) / Math.max(bw, bh) > 0.85) continue;
      const mx = cc.sumX / cc.pixels.length, my = cc.sumY / cc.pixels.length;
      const cr = Math.max(1.8, Math.min(bw, bh) * 0.28);
      let dark = 0, n = 0, coreLum = 0;
      for (let y = Math.max(0, Math.floor(my - cr)); y < Math.min(h, Math.ceil(my + cr)); y++)
        for (let x = Math.max(0, Math.floor(mx - cr)); x < Math.min(w, Math.ceil(mx + cr)); x++) {
          if (Math.hypot(x - mx, y - my) > cr) continue;
          coreLum += lumAt(x, y); n++; if (lumAt(x, y) < 100) dark++;
        }
      if (n && dark / n >= 0.45 && coreLum / n <= 125) raw.push(refine(mx, my, Math.min(bw, bh) * 0.3));
    }
  }

  // 检测器 B：暗核连通域 + 外围亮环验证（适合暗背景、斜拍椭圆、近距粘连）
  {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (lumAt(i % w, (i / w) | 0) < 78) bin[i] = 1;
    const minCore = Math.max(2, expect * 0.28), maxCore = Math.max(20, expect * 2.2);
    for (const cc of connectedComponents(bin, w, h)) {
      const bw = cc.maxX - cc.minX, bh = cc.maxY - cc.minY;
      if (bw < minCore || bw > maxCore || bh < minCore || bh > maxCore) continue;
      if (Math.abs(bw - bh) / Math.max(bw, bh) > 0.85) continue;
      const mx = cc.sumX / cc.pixels.length, my = cc.sumY / cc.pixels.length;
      const rIn = Math.max(2, Math.min(bw, bh) * 0.7), rOut = Math.min(bw, bh) * 2.6;
      let ringN = 0, ringBright = 0, ringLum = 0, coreLum = 0, coreN = 0;
      for (let y = Math.max(0, Math.floor(my - rOut)); y < Math.min(h, Math.ceil(my + rOut)); y++) {
        for (let x = Math.max(0, Math.floor(mx - rOut)); x < Math.min(w, Math.ceil(mx + rOut)); x++) {
          const d = Math.hypot(x - mx, y - my), lum = lumAt(x, y);
          if (d < rIn) { coreLum += lum; coreN++; }
          else if (d < rOut) { ringN++; ringLum += lum; if (lum > 110) ringBright++; }
        }
      }
      if (!ringN || !coreN) continue;
      const brightPct = ringBright / ringN;
      if (brightPct < 0.35 && ringLum / ringN - coreLum / coreN < 35) continue;
      raw.push(refine(mx, my, Math.min(bw, bh) * 0.6));
    }
  }

  // 融合去重（两检测器对同一标志的中心应在 4px 内）
  const candidates: { x: number; y: number; score: number }[] = [];
  for (const p of raw) {
    if (!candidates.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 4 / scale)) {
      candidates.push({ x: p.x, y: p.y, score: 1 });
    }
  }

  // 用粗位姿投影给每个候选匹配 fiducial 身份：全局一对一贪心（按距离升序）+ 严格门限
  const projected = fids
    .map((fid) => ({ fid, proj: projectPoint(K, coarsePose, fid.position) }))
    .filter((x): x is { fid: FiducialPoint; proj: { x: number; y: number } } => x.proj !== null);
  const usedFid = new Set<number>();
  const usedCand = new Set<number>();
  const out: DetectedMarker[] = [];
  const pairs: { candIdx: number; fid: number; d: number }[] = [];
  candidates.forEach((cand, ci) => {
    for (const pp of projected) {
      const d = Math.hypot(pp.proj.x - cand.x, pp.proj.y - cand.y);
      pairs.push({ candIdx: ci, fid: pp.fid.id, d });
    }
  });
  pairs.sort((a, b) => a.d - b.d);
  // 门限：斜拍时 POS 角度误差经距离放大可达 ~150px，取 200px；
  // 个别误配身份由下游 solvePnPRobust 的 Huber 核与内点门限兜底
  const MATCH_LIMIT = 200;
  for (const p of pairs) {
    if (p.d > MATCH_LIMIT) break;
    if (usedFid.has(p.fid) || usedCand.has(p.candIdx)) continue;
    const cand = candidates[p.candIdx];
    usedFid.add(p.fid);
    usedCand.add(p.candIdx);
    out.push({ fiducialId: p.fid, x: cand.x, y: cand.y, score: cand.score });
  }
  return out;
}

/** 过曝比例：白色削顶像素占比 */
export async function measureOverexposure(blob: Blob): Promise<number> {
  const data = await toImageData(blob, 256);
  const px = data.data;
  let n = 0, hot = 0;
  for (let i = 0; i < px.length; i += 4) {
    n++;
    if (px[i] > 244 && px[i + 1] > 244 && px[i + 2] > 240) hot++;
  }
  return hot / n;
}
