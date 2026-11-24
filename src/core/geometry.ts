// 参数化构件几何：平面/圆柱表面的解析映射、网格生成、射线求交。
// 全部表面满足：UV 即米制局部坐标，三维点 <-> (surface,u,v) 双向解析可算。
import type { ComponentDef, SurfaceDef } from './types';
import {
  add, cross, dot, m3fromCols, m3mulv, norm, scl, sub,
  type Mat3, type Vec3, v3,
} from './mathTypes';

export interface Ray {
  origin: Vec3;
  dir: Vec3; // 单位向量
}

export interface SurfaceHit {
  surface: SurfaceDef;
  u: number;
  v: number;
  point: Vec3;
  t: number;
}

// ---------- 平面表面 ----------

export function makePlanarSurface(
  id: string, name: string, origin: Vec3, uAxis: Vec3, vAxis: Vec3,
  width: number, height: number, triStart: number, normalHint?: Vec3,
): SurfaceDef {
  const u = norm(uAxis), v = norm(vAxis);
  const n = normalHint ? norm(normalHint) : norm(cross(u, v));
  return { id, name, kind: 'planar', origin, uAxis: u, vAxis: v, normal: n, width, height, triStart, triCount: 0 };
}

export function planarPoint(s: SurfaceDef, u: number, v: number): Vec3 {
  return add(add(s.origin, scl(s.uAxis, u)), scl(s.vAxis, v));
}

export function planarUV(s: SurfaceDef, p: Vec3): { u: number; v: number } {
  const d = sub(p, s.origin);
  return { u: dot(d, s.uAxis), v: dot(d, s.vAxis) };
}

export function rayPlane(ray: Ray, s: SurfaceDef): SurfaceHit | null {
  const denom = dot(ray.dir, s.normal);
  if (Math.abs(denom) < 1e-10) return null;
  const t = dot(sub(s.origin, ray.origin), s.normal) / denom;
  if (t <= 0) return null;
  const p = add(ray.origin, scl(ray.dir, t));
  const { u, v } = planarUV(s, p);
  // 向平面外放宽 2mm 容差
  const eps = 0.002;
  if (u < -eps || v < -eps || u > s.width + eps || v > s.height + eps) return null;
  return { surface: s, u: Math.max(0, Math.min(s.width, u)), v: Math.max(0, Math.min(s.height, v)), point: p, t };
}

// ---------- 圆柱表面 ----------

export function makeCylindricalSurface(
  id: string, name: string, baseCenter: Vec3, axis: Vec3, radial0: Vec3,
  radius: number, arcLength: number, height: number, triStart: number,
): SurfaceDef {
  const ax = norm(axis);
  const r0 = norm(sub(radial0, scl(ax, dot(radial0, ax))));
  const circum = norm(cross(ax, r0));
  return {
    id, name, kind: 'cylindrical',
    origin: baseCenter, uAxis: r0, vAxis: ax, normal: r0,
    width: arcLength, height, radius, axis: ax, arcLength, triStart, triCount: 0,
  };
}

/** 圆柱：u 为沿环向展开弧长（米），v 为轴向高度（米） */
export function cylinderPoint(s: SurfaceDef, u: number, v: number): Vec3 {
  const theta = u / (s.radius as number);
  const r0 = s.uAxis, circum = norm(cross(s.axis as Vec3, r0));
  const radial = add(scl(r0, Math.cos(theta)), scl(circum, Math.sin(theta)));
  return add(add(s.origin, scl(s.axis as Vec3, v)), scl(radial, s.radius as number));
}

export function cylinderUV(s: SurfaceDef, p: Vec3): { u: number; v: number } {
  const d = sub(p, s.origin);
  const v = dot(d, s.axis as Vec3);
  const radialVec = sub(d, scl(s.axis as Vec3, v));
  const r0 = s.uAxis, circum = norm(cross(s.axis as Vec3, r0));
  const c = dot(radialVec, r0), ss = dot(radialVec, circum);
  let theta = Math.atan2(ss, c);
  if (theta < 0) theta += Math.PI * 2;
  return { u: theta * (s.radius as number), v };
}

export function rayCylinder(ray: Ray, s: SurfaceDef): SurfaceHit | null {
  const radius = s.radius as number;
  const ax = s.axis as Vec3;
  // 转到以 baseCenter 为原点、ax 为 z 的局部系
  const e = sub(ray.origin, s.origin);
  const ez = dot(e, ax);
  const exy = sub(e, scl(ax, ez));
  const dz = dot(ray.dir, ax);
  const dxy = sub(ray.dir, scl(ax, dz));
  const a = dot(dxy, dxy);
  const b = 2 * dot(dxy, exy);
  const cc = dot(exy, exy) - radius * radius;
  const disc = b * b - 4 * a * cc;
  if (a < 1e-12 || disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  const candidates = [t1, t2].filter((t) => t > 0);
  for (const t of candidates) {
    const p = add(ray.origin, scl(ray.dir, t));
    const { u, v } = cylinderUV(s, p);
    const eps = 0.002;
    if (v < -eps || v > s.height + eps || u > (s.arcLength as number) + eps) continue;
    return { surface: s, u: Math.min(u, s.arcLength as number), v: Math.max(0, Math.min(s.height, v)), point: p, t };
  }
  return null;
}

export function surfacePoint(s: SurfaceDef, u: number, v: number): Vec3 {
  return s.kind === 'planar' ? planarPoint(s, u, v) : cylinderPoint(s, u, v);
}

export function surfaceUV(s: SurfaceDef, p: Vec3): { u: number; v: number } {
  return s.kind === 'planar' ? planarUV(s, p) : cylinderUV(s, p);
}

export function surfaceNormalAt(s: SurfaceDef, u: number): Vec3 {
  if (s.kind === 'planar') return s.normal;
  const theta = u / (s.radius as number);
  const circum = norm(cross(s.axis as Vec3, s.uAxis));
  return norm(add(scl(s.uAxis, Math.cos(theta)), scl(circum, Math.sin(theta))));
}

export function intersectComponent(ray: Ray, comp: ComponentDef): (SurfaceHit & { componentId: string }) | null {
  let best: (SurfaceHit & { componentId: string }) | null = null;
  for (const s of comp.surfaces) {
    const hit = s.kind === 'planar' ? rayPlane(ray, s) : rayCylinder(ray, s);
    if (hit && (!best || hit.t < best.t)) best = { ...hit, componentId: comp.id };
  }
  return best;
}

// ---------- 网格累加器 ----------

export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];
  triSurface: number[] = [];
  private baseVertex = 0;

  /** 加一个四边形表面网格（nu×nv 分块），UV 按米制线性映射。
   *  绕序按表面真实法线自动翻转，保证 GL_CCW 下正面朝外。 */
  addPlanarGrid(s: SurfaceDef, nu: number, nv: number, surfaceIndex: number): void {
    const start = this.baseVertex;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = (i / nu) * s.width;
        const v = (j / nv) * s.height;
        const p = planarPoint(s, u, v);
        this.positions.push(p.x, p.y, p.z);
        this.normals.push(s.normal.x, s.normal.y, s.normal.z);
        this.uvs.push(u, v);
      }
    }
    const row = nu + 1;
    const triStart = this.indices.length;
    // 真实法线与 cross(uAxis,vAxis) 反向时翻转绕序
    const flip = dot(cross(s.uAxis, s.vAxis), s.normal) < 0;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = start + j * row + i;
        const b = a + 1, c = a + row, d = c + 1;
        if (!flip) {
          this.indices.push(a, c, b, b, c, d);
        } else {
          this.indices.push(a, b, c, b, d, c);
        }
        this.triSurface.push(surfaceIndex, surfaceIndex);
      }
    }
    s.triStart = triStart;
    s.triCount = this.indices.length - triStart;
    this.baseVertex += (nu + 1) * (nv + 1);
  }

  /** 圆柱侧面网格，nTheta 个环向分段。绕序保证法线朝外。 */
  addCylinderGrid(s: SurfaceDef, nTheta: number, nv: number, surfaceIndex: number): void {
    const start = this.baseVertex;
    const radius = s.radius as number;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nTheta; i++) {
        const u = (i / nTheta) * (s.arcLength as number);
        const v = (j / nv) * s.height;
        const p = cylinderPoint(s, u, v);
        const n = surfaceNormalAt(s, u);
        this.positions.push(p.x, p.y, p.z);
        this.normals.push(n.x, n.y, n.z);
        this.uvs.push(u, v);
      }
    }
    const row = nTheta + 1;
    const triStart = this.indices.length;
    // 圆柱参数化中 (i,j) 沿环向、(k) 沿轴向，cross(切环,切轴) 朝内，需翻转
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nTheta; i++) {
        const a = start + j * row + i;
        const b = a + 1, c = a + row, d = c + 1;
        this.indices.push(a, b, c, b, d, c);
        this.triSurface.push(surfaceIndex, surfaceIndex);
      }
    }
    s.triStart = triStart;
    s.triCount = this.indices.length - triStart;
    this.baseVertex += (nTheta + 1) * (nv + 1);
  }

  build(): Pick<ComponentDef, 'positions' | 'normals' | 'uvs' | 'indices' | 'triSurfaceIndex'> {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
      triSurfaceIndex: new Uint16Array(this.triSurface),
    };
  }
}

/** 把构件局部 UV 点转成世界坐标（这里所有构件直接在世界系建模，故等于 surfacePoint） */
export function localToWorld(comp: ComponentDef, surfaceId: string, u: number, v: number): Vec3 {
  const s = comp.surfaces.find((x) => x.id === surfaceId);
  if (!s) throw new Error(`构件 ${comp.code} 上找不到表面 ${surfaceId}`);
  return surfacePoint(s, u, v);
}

/** 世界点反算构件局部 UV */
export function worldToLocal(comp: ComponentDef, p: Vec3): { surfaceId: string; u: number; v: number } {
  let best: { surfaceId: string; u: number; v: number; d: number } | null = null;
  for (const s of comp.surfaces) {
    const uv = surfaceUV(s, p);
    const q = surfacePoint(s, uv.u, uv.v);
    const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    if (uv.u >= -0.01 && uv.u <= s.width + 0.01 && uv.v >= -0.01 && uv.v <= s.height + 0.01) {
      if (!best || d < best.d) best = { surfaceId: s.id, u: uv.u, v: uv.v, d };
    }
  }
  if (!best) throw new Error('点不在构件任何表面上');
  return { surfaceId: best.surfaceId, u: best.u, v: best.v };
}

/** 构件表面米制 UV -> 烘焙纹素（每构件纹理按表面图集排列，这里返回单表面内归一化坐标） */
export function uvToNormalized(s: SurfaceDef, u: number, v: number): { un: number; vn: number } {
  return { un: u / s.width, vn: v / s.height };
}

/** 局部坐标系（用于某些法线计算场景） */
export function surfaceFrame(s: SurfaceDef): Mat3 {
  if (s.kind === 'planar') return m3fromCols(s.uAxis, s.vAxis, s.normal);
  return m3fromCols(s.uAxis, s.axis as Vec3, s.normal);
}

export { m3mulv, v3 };
