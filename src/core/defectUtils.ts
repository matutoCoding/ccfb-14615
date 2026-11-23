// 病害几何度量：折线长度、面积、裂缝宽度(像素+物距换算)
import { DefectRecord, DefectPoint } from '../types';
import { CameraModel, projectPoint } from './camera';
import { v3dist } from './math';

export function polylineLengthMm(points: { world: [number, number, number] }[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += v3dist(points[i - 1].world, points[i].world);
  return len * 1000;
}

export function polygonAreaM2(points: { world: [number, number, number] }[]): number | null {
  if (points.length < 3) return null;
  // 投影到最佳拟合平面后用鞋带公式
  const n = fitPlaneNormal(points.map((p) => p.world));
  const ref = points[0].world;
  let ax: number[] = [], ay: number[] = [];
  const e1 = normalize3(sub3(points[1].world, ref));
  const e2 = cross3(n, e1);
  ax = points.map((p) => dot3(sub3(p.world, ref), e1));
  ay = points.map((p) => dot3(sub3(p.world, ref), e2));
  let area = 0;
  for (let i = 0; i < ax.length; i++) {
    const j = (i + 1) % ax.length;
    area += ax[i] * ay[j] - ax[j] * ay[i];
  }
  return Math.abs(area) / 2;
}

// 裂缝宽度：照片上量得的像素宽度 pxWidth，按针孔模型 w_mm = pxWidth * 物距 / fx * 1000
export function crackWidthMm(pxWidth: number, cam: CameraModel, surfacePoint: [number, number, number]): number {
  const dist = v3dist(cam.C, surfacePoint);
  return (pxWidth * dist) / cam.fx * 1000;
}

// 反算：给定真实毫米宽度，求像素宽度(供合成器画裂缝)
export function crackWidthPx(widthMm: number, cam: CameraModel, surfacePoint: [number, number, number]): number {
  const dist = v3dist(cam.C, surfacePoint);
  return (widthMm / 1000) * cam.fx / dist;
}

// 世界折线 -> 照片像素折线(带畸变)
export function projectPolyline(cam: CameraModel, pts: DefectPoint[]): [number, number][] {
  return pts.map((p) => projectPoint(cam, p.world));
}

function fitPlaneNormal(pts: [number, number, number][]): [number, number, number] {
  const c = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((x) => x / pts.length) as [number, number, number];
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of pts) {
    const d = sub3(p, c);
    xx += d[0] * d[0]; xy += d[0] * d[1]; xz += d[0] * d[2];
    yy += d[1] * d[1]; yz += d[1] * d[2]; zz += d[2] * d[2];
  }
  // 最小特征向量近似：取协方差阵最小对角方向叉乘
  const n = cross3([xx, xy, xz], [xy, yy, yz]);
  return normalize3(n);
}
const sub3 = (a: number[], b: number[]): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: number[], b: number[]): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const normalize3 = (a: number[]): [number, number, number] => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function summarizeDefect(d: DefectRecord): string {
  switch (d.kind) {
    case 'crack':
      return `裂缝 长${(d.lengthMm / 1000).toFixed(2)}m${d.widthMm ? ` 宽${d.widthMm.toFixed(2)}mm` : ''}`;
    case 'spall':
      return `剥落露筋 ${d.areaM2 ? d.areaM2.toFixed(2) + 'm²' : ''}`;
    case 'seepage':
      return `渗水泛白 ${d.areaM2 ? d.areaM2.toFixed(2) + 'm²' : ''}`;
    case 'honeycomb':
      return `蜂窝麻面 ${d.areaM2 ? d.areaM2.toFixed(2) + 'm²' : ''}`;
  }
}
