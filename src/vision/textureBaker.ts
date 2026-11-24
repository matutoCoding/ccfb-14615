// 纹理烘焙：把配准照片投影到构件表面的米制 UV 纹理上。
// 对每个表面的每个纹素，从表面解析反投射线 -> 与全桥做三角形遮挡测试 ->
// 投影到照片（含畸变）-> 按入射角余弦与拍摄距离加权累积，多照片融合无色缝。
import type { BridgeModel, ComponentDef, PhotoRecord, SurfaceDef } from '../core/types';
import type { CameraIntrinsics, CameraPose } from '../core/camera';
import { pixelToNormalized, projectPoint } from '../core/camera';
import { surfaceNormalAt, surfacePoint } from '../core/geometry';
import { cameraCenter, distanceToCamera, worldToCamera } from '../core/camera';
import { cross, dot, norm, sub, type Vec3 } from '../core/mathTypes';

/** 射线与三角形（Möller–Trumbore），返回 t 或 null */
function rayTri(origin: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = sub(b, a), e2 = sub(c, a);
  const p = cross(dir, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const f = 1 / det;
  const s = sub(origin, a);
  const u = f * dot(s, p);
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1);
  const v = f * dot(dir, q);
  if (v < 0 || u + v > 1) return null;
  const t = f * dot(e2, q);
  return t > 1e-7 ? t : null;
}

interface TriCache {
  comp: ComponentDef;
  a: Vec3; b: Vec3; c: Vec3;
  mid: Vec3;
  min: Vec3;
  max: Vec3;
}

let triCache: TriCache[] | null = null;
let triCacheModel: BridgeModel | null = null;
/** 空间均匀哈希网格：cell 索引 -> 三角形下标，遮挡查询只遍历射线穿过的 cell */
let triGrid: Map<string, number[]> | null = null;
const CELL = 1.2; // 网格边长（米）

const cellKey = (ix: number, iy: number, iz: number): string => `${ix},${iy},${iz}`;

function buildTriCache(model: BridgeModel): TriCache[] {
  if (triCacheModel === model && triCache) return triCache;
  const out: TriCache[] = [];
  for (const comp of model.components) {
    const p = comp.positions, idx = comp.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const ia = idx[i] * 3, ib = idx[i + 1] * 3, ic = idx[i + 2] * 3;
      const a = { x: p[ia], y: p[ia + 1], z: p[ia + 2] };
      const b = { x: p[ib], y: p[ib + 1], z: p[ib + 2] };
      const c = { x: p[ic], y: p[ic + 1], z: p[ic + 2] };
      out.push({
        comp, a, b, c,
        mid: { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 },
        min: { x: Math.min(a.x, b.x, c.x), y: Math.min(a.y, b.y, c.y), z: Math.min(a.z, b.z, c.z) },
        max: { x: Math.max(a.x, b.x, c.x), y: Math.max(a.y, b.y, c.y), z: Math.max(a.z, b.z, c.z) },
      });
    }
  }
  triCache = out;
  triCacheModel = model;
  // 建网格：三角形登记到其包围盒覆盖的所有 cell
  const grid = new Map<string, number[]>();
  out.forEach((tr, ti) => {
    const ix0 = Math.floor(tr.min.x / CELL), ix1 = Math.floor(tr.max.x / CELL);
    const iy0 = Math.floor(tr.min.y / CELL), iy1 = Math.floor(tr.max.y / CELL);
    const iz0 = Math.floor(tr.min.z / CELL), iz1 = Math.floor(tr.max.z / CELL);
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iy = iy0; iy <= iy1; iy++)
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = cellKey(ix, iy, iz);
          const arr = grid.get(k);
          if (arr) arr.push(ti); else grid.set(k, [ti]);
        }
  });
  triGrid = grid;
  return out;
}

/** DDA 遍历射线穿过的 cell，对其中三角形做精确求交 */
function occludedGrid(origin: Vec3, dir: Vec3, target: number, selfCompId: string): boolean {
  const tris = triCache!;
  const grid = triGrid!;
  let ix = Math.floor(origin.x / CELL), iy = Math.floor(origin.y / CELL), iz = Math.floor(origin.z / CELL);
  const stepX = dir.x > 0 ? 1 : -1, stepY = dir.y > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
  // 到下一网格边界的距离
  const tDeltaX = Math.abs(CELL / dir.x), tDeltaY = Math.abs(CELL / dir.y), tDeltaZ = Math.abs(CELL / dir.z);
  const boundary = (o: number, i: number, s: number) => (s > 0 ? (i + 1) * CELL - o : o - i * CELL);
  let tMaxX = dir.x === 0 ? Infinity : boundary(origin.x, ix, stepX) / Math.abs(dir.x);
  let tMaxY = dir.y === 0 ? Infinity : boundary(origin.y, iy, stepY) / Math.abs(dir.y);
  let tMaxZ = dir.z === 0 ? Infinity : boundary(origin.z, iz, stepZ) / Math.abs(dir.z);
  const visited = new Set<number>();
  let t = 0;
  let guard = 0;
  while (t <= target && guard++ < 256) {
    const arr = grid.get(cellKey(ix, iy, iz));
    if (arr) {
      for (const ti of arr) {
        if (visited.has(ti)) continue;
        visited.add(ti);
        const tr = tris[ti];
        if (tr.comp.id === selfCompId) continue;
        const hit = rayTri(origin, dir, tr.a, tr.b, tr.c);
        if (hit !== null && hit < target) return true;
      }
    }
    // 推进到下一 cell
    if (tMaxX < tMaxY && tMaxX < tMaxZ) { ix += stepX; t = tMaxX; tMaxX += tDeltaX; }
    else if (tMaxY < tMaxZ) { iy += stepY; t = tMaxY; tMaxY += tDeltaY; }
    else { iz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
  }
  return false;
}

export interface BakedSurface {
  surfaceId: string;
  widthPx: number;
  heightPx: number;
  /** 米/像素（比例尺） */
  metersPerPixel: number;
  color: ImageData;
  weight: Float32Array;
  /** 参与该表面的照片 id 及权重贡献 */
  contributors: { photoId: string; weight: number }[];
}

export interface BakeOptions {
  /** 目标分辨率（米/像素），默认 0.0025 = 2.5mm/px */
  metersPerPixel?: number;
  /** 表面纹理最大边（像素） */
  maxTexSide?: number;
  /** 入射角余弦下限（掠射剔除） */
  minCosine?: number;
  /** 遮挡偏置（米），防止自遮挡误判 */
  bias?: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

interface LoadedPhoto {
  record: PhotoRecord;
  K: CameraIntrinsics;
  pose: CameraPose;
  image: ImageBitmap;
  /** 解码后的像素（懒加载，全烘焙过程只解码一次） */
  rgba?: Uint8ClampedArray;
}

function intrinsicsOf(ph: PhotoRecord): CameraIntrinsics {
  const z = ph.intrinsics!;
  return { ...z };
}
function poseOf(ph: PhotoRecord): CameraPose {
  return {
    R: new Float64Array(ph.R!) as unknown as import('../core/mathTypes').Mat3,
    t: { x: ph.t![0], y: ph.t![1], z: ph.t![2] },
  };
}

async function loadImages(photos: PhotoRecord[], getBlob: (k: string) => Promise<Blob | undefined>): Promise<LoadedPhoto[]> {
  const out: LoadedPhoto[] = [];
  for (const ph of photos) {
    if (!ph.R || !ph.t || !ph.intrinsics) continue;
    const blob = await getBlob(ph.imageBlobKey ?? '');
    if (!blob) continue;
    const bmp = await createImageBitmap(blob);
    // 一次性解码到像素数组，供所有表面复用
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    out.push({ record: ph, K: intrinsicsOf(ph), pose: poseOf(ph), image: bmp, rgba });
  }
  return out;
}

/** 遮挡测试：空间网格加速，从 p 沿视线是否先碰到别的构件 */
function occluded(model: BridgeModel, origin: Vec3, dir: Vec3, dist: number, selfCompId: string, bias: number): boolean {
  buildTriCache(model);
  return occludedGrid(origin, dir, dist - bias, selfCompId);
}

/** 单张照片对单个表面的烘焙（在 2D canvas 上逐纹素计算，表面通常 ≤1024²，照片数多时分批） */
function bakeOne(
  model: BridgeModel,
  comp: ComponentDef,
  surf: SurfaceDef,
  lp: LoadedPhoto,
  metersPerPixel: number,
  wPx: number,
  hPx: number,
  color: Uint8ClampedArray,
  weight: Float32Array,
  opts: Required<Pick<BakeOptions, 'minCosine' | 'bias'>>,
): number {
  const { K, pose } = lp;
  const imgData = lp.rgba!;

  const cam = cameraCenter(pose);
  let contribution = 0;
  const step = 1;
  for (let py = 0; py < hPx; py += step) {
    for (let px = 0; px < wPx; px += step) {
      const u = (px + 0.5) * metersPerPixel;
      const v = (py + 0.5) * metersPerPixel;
      if (u > surf.width || v > surf.height) continue;
      const p = surfacePoint(surf, u, v);
      const n = surfaceNormalAt(surf, u);
      const toCam = norm(sub(cam, p));
      const cosine = dot(n, toCam);
      if (cosine < opts.minCosine) continue;
      const dist = distanceToCamera(pose, p);
      // 遮挡
      if (occluded(model, p, toCam, dist, comp.id, opts.bias)) continue;
      // 必须在相机前方且落在像内
      const xc = worldToCamera(pose, p);
      if (xc.z >= -0.05) continue;
      const proj = projectPoint(K, pose, p);
      if (!proj) continue;
      const ix = Math.round(proj.x), iy = Math.round(proj.y);
      if (ix < 1 || iy < 1 || ix >= K.width - 1 || iy >= K.height - 1) continue;
      // 双线性采样
      const fx = proj.x - Math.floor(proj.x), fy = proj.y - Math.floor(proj.y);
      const x0 = Math.floor(proj.x), y0 = Math.floor(proj.y);
      const idx = (y0 * K.width + x0) * 4;
      const idxR = idx + 4, idxD = idx + K.width * 4, idxDR = idxD + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const r = imgData[idx] * w00 + imgData[idxR] * w10 + imgData[idxD] * w01 + imgData[idxDR] * w11;
      const g = imgData[idx + 1] * w00 + imgData[idxR + 1] * w10 + imgData[idxD + 1] * w01 + imgData[idxDR + 1] * w11;
      const b = imgData[idx + 2] * w00 + imgData[idxR + 2] * w10 + imgData[idxD + 2] * w01 + imgData[idxDR + 2] * w11;
      // 权重：入射角余弦² × 距离衰减（近大远小的曝光补偿）
      const w = cosine * cosine * Math.min(1, 3.5 / dist);
      const oi = (py * wPx + px) * 4;
      const wi = py * wPx + px;
      const wOld = weight[wi];
      const wNew = wOld + w;
      color[oi] = (color[oi] * wOld + r * w) / wNew;
      color[oi + 1] = (color[oi + 1] * wOld + g * w) / wNew;
      color[oi + 2] = (color[oi + 2] * wOld + b * w) / wNew;
      color[oi + 3] = 255;
      weight[wi] = wNew;
      contribution += w;
    }
  }
  return contribution;
}

/** 烘焙整座桥：只烘焙指定构件（或全部），照片为已配准集合 */
export async function bakeModel(
  model: BridgeModel,
  photos: PhotoRecord[],
  getBlob: (k: string) => Promise<Blob | undefined>,
  options: BakeOptions = {},
  componentFilter?: Set<string>,
): Promise<Map<string, BakedSurface>> {
  const metersPerPixel = options.metersPerPixel ?? 0.004;
  const maxTexSide = options.maxTexSide ?? 512;
  const minCosine = options.minCosine ?? 0.18;
  const bias = options.bias ?? 0.03;
  const loaded = await loadImages(photos, getBlob);
  const result = new Map<string, BakedSurface>();
  const comps = componentFilter ? model.components.filter((c) => componentFilter.has(c.id)) : model.components;
  let done = 0;
  const total = comps.reduce((a, c) => a + c.surfaces.length, 0);

  for (const comp of comps) {
    for (const surf of comp.surfaces) {
      const wPx = Math.min(maxTexSide, Math.max(32, Math.round(surf.width / metersPerPixel)));
      const hPx = Math.min(maxTexSide, Math.max(32, Math.round(surf.height / metersPerPixel)));
      const effMppX = surf.width / wPx, effMppY = surf.height / hPx;
      const canvas = document.createElement('canvas');
      canvas.width = wPx; canvas.height = hPx;
      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.createImageData(wPx, hPx);
      // 混凝土底色（未覆盖区）
      for (let i = 0; i < imageData.data.length; i += 4) {
        imageData.data[i] = 150; imageData.data[i + 1] = 146; imageData.data[i + 2] = 136; imageData.data[i + 3] = 255;
      }
      const weight = new Float32Array(wPx * hPx);
      const contributors: BakedSurface['contributors'] = [];
      // 视锥粗筛：表面中心在相机前方且距离合理
      for (const lp of loaded) {
        const center = surfacePoint(surf, surf.width / 2, surf.height / 2);
        const xc = worldToCamera(lp.pose, center);
        if (xc.z >= -0.05) continue;
        if (distanceToCamera(lp.pose, center) > 12) continue;
        const cw = bakeOne(model, comp, surf, lp, effMppX, wPx, hPx, imageData.data, weight, { minCosine, bias });
        if (cw > 0) contributors.push({ photoId: lp.record.id, weight: cw });
      }
      ctx.putImageData(imageData, 0, 0);
      result.set(surf.id, {
        surfaceId: surf.id, widthPx: wPx, heightPx: hPx,
        metersPerPixel: (effMppX + effMppY) / 2,
        color: imageData, weight, contributors,
      });
      done++;
      options.onProgress?.(done, total, `${comp.code} / ${surf.name}`);
      // 让出主线程，避免长任务卡死 UI
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return result;
}

/** 把烘焙结果上传为 WebGL 纹理（运行期贴图用） */
export function uploadBakeTexture(gl: WebGL2RenderingContext, baked: BakedSurface): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, baked.widthPx, baked.heightPx, 0, gl.RGBA, gl.UNSIGNED_BYTE, baked.color.data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.generateMipmap(gl.TEXTURE_2D);
  return tex;
}

export { pixelToNormalized };
