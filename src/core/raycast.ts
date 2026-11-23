// 三角形网格光线投射(Möller–Trumbore)，支持 BVH 加速与最近交点查询
import { Vec3, v3cross, v3dot, v3sub, v3norm, Mat4, m4invert, m4mul, m4perspective, m4lookAt } from './math';
import { MeshData, BridgeGeometry, ComponentGeometry, pointToSurface, SurfaceDef } from './geometry';

export interface HitResult {
  componentId: string;
  point: Vec3;
  distance: number;
  triangleIndex: number;
  normal: Vec3;
  local: [number, number] | null;
  surface: SurfaceDef | null;
}

export class RayCaster {
  private geos = new Map<string, { geo: ComponentGeometry; tris: Float32Array; bounds: { min: Vec3; max: Vec3 } }>();

  constructor(bridge: BridgeGeometry) {
    for (const cg of bridge.components) {
      const p = cg.mesh.positions;
      const tris: number[] = [];
      const min: Vec3 = [Infinity, Infinity, Infinity];
      const max: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[i + k]);
          max[k] = Math.max(max[k], p[i + k]);
        }
      }
      for (let i = 0; i < cg.mesh.indices.length; i += 3) {
        const ia = cg.mesh.indices[i] * 3;
        const ib = cg.mesh.indices[i + 1] * 3;
        const ic = cg.mesh.indices[i + 2] * 3;
        tris.push(
          p[ia], p[ia + 1], p[ia + 2],
          p[ib], p[ib + 1], p[ib + 2],
          p[ic], p[ic + 1], p[ic + 2]
        );
      }
      this.geos.set(cg.component.id, {
        geo: cg,
        tris: new Float32Array(tris),
        bounds: { min, max },
      });
    }
  }

  private rayAABB(origin: Vec3, dir: Vec3, min: Vec3, max: Vec3): number {
    let tmin = 0, tmax = Infinity;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(dir[k]) < 1e-12) {
        if (origin[k] < min[k] || origin[k] > max[k]) return Infinity;
      } else {
        let t1 = (min[k] - origin[k]) / dir[k];
        let t2 = (max[k] - origin[k]) / dir[k];
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) return Infinity;
      }
    }
    return tmin;
  }

  // 射线(origin, unit dir) -> 最近命中
  cast(origin: Vec3, dir: Vec3, onlyComponentId?: string): HitResult | null {
    let best: HitResult | null = null;
    for (const [id, entry] of this.geos) {
      if (onlyComponentId && id !== onlyComponentId) continue;
      if (this.rayAABB(origin, dir, entry.bounds.min, entry.bounds.max) === Infinity) continue;
      const T = entry.tris;
      for (let i = 0; i < T.length; i += 9) {
        const t = hitTriangle(origin, dir, T, i);
        if (t !== null && (!best || t < best.distance)) {
          const a: Vec3 = [T[i], T[i + 1], T[i + 2]];
          const b: Vec3 = [T[i + 3], T[i + 4], T[i + 5]];
          const c: Vec3 = [T[i + 6], T[i + 7], T[i + 8]];
          const n = v3norm(v3cross(v3sub(b, a), v3sub(c, a)));
          const point: Vec3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
          const mapped = pointToSurface(entry.geo, point, 0.05);
          best = {
            componentId: id,
            point,
            distance: t,
            triangleIndex: i / 9,
            normal: n,
            local: mapped ? mapped.local : null,
            surface: mapped ? mapped.surface : null,
          };
        }
      }
    }
    return best;
  }

  // 沿指定方向把表面点投影回构件(用于绘画坐标反算)，返回表面命中
  castToComponent(origin: Vec3, dir: Vec3, componentId: string): HitResult | null {
    return this.cast(origin, dir, componentId);
  }
}

function hitTriangle(origin: Vec3, dir: Vec3, T: Float32Array, i: number): number | null {
  const e1: Vec3 = [T[i + 3] - T[i], T[i + 4] - T[i + 1], T[i + 5] - T[i + 2]];
  const e2: Vec3 = [T[i + 6] - T[i], T[i + 7] - T[i + 1], T[i + 8] - T[i + 2]];
  const p = v3cross(dir, e2);
  const det = v3dot(p, e1);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tvec = v3sub(origin, [T[i], T[i + 1], T[i + 2]]);
  const u = v3dot(tvec, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = v3cross(tvec, e1);
  const v = v3dot(dir, q) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = v3dot(e2, q) * inv;
  return t > 1e-6 ? t : null;
}

// 屏幕像素 -> 世界射线(无畸变观察相机)
export function screenRay(
  ndcX: number, ndcY: number,
  eye: Vec3, target: Vec3, up: Vec3,
  fovyRad: number, aspect: number
): { origin: Vec3; dir: Vec3 } {
  const view = m4lookAt(eye, target, up);
  const proj = m4perspective(fovyRad, aspect, 0.1, 250);
  const inv = m4invert(m4mul(proj, view));
  const near4 = mul4(inv, [ndcX, ndcY, -1, 1]);
  const far4 = mul4(inv, [ndcX, ndcY, 1, 1]);
  const near: Vec3 = [near4[0] / near4[3], near4[1] / near4[3], near4[2] / near4[3]];
  const far: Vec3 = [far4[0] / far4[3], far4[1] / far4[3], far4[2] / far4[3]];
  return { origin: eye, dir: v3norm(v3sub(far, near)) };
}

function mul4(m: Mat4, v: number[]): number[] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

// 点在三角形内的重心插值(用于深度判断时取表面属性)
export function barycentric(p: Vec3, a: Vec3, b: Vec3, c: Vec3): [number, number, number] {
  const v0 = v3sub(b, a), v1 = v3sub(c, a), v2 = v3sub(p, a);
  const d00 = v3dot(v0, v0), d01 = v3dot(v0, v1), d11 = v3dot(v1, v1);
  const d20 = v3dot(v2, v0), d21 = v3dot(v2, v1);
  const den = d00 * d11 - d01 * d01 || 1e-12;
  const v = (d11 * d20 - d01 * d21) / den;
  const w = (d00 * d21 - d01 * d20) / den;
  return [1 - v - w, v, w];
}
