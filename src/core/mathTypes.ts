// 基础向量/矩阵运算。Mat4 为列主序（WebGL 约定），Mat3 同为列主序 9 元素。
export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scl = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));
export const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scl(sub(b, a), t));
export const mid = (a: Vec3, b: Vec3): Vec3 => scl(add(a, b), 0.5);
export const neg = (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z });

// ---------- Mat3（列主序，索引 m[col*3+row]） ----------
export type Mat3 = Float64Array; // 长度 9
export const m3id = (): Mat3 => Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export function m3mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Float64Array(9);
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++)
      o[c * 3 + r] =
        a[0 * 3 + r] * b[c * 3 + 0] + a[1 * 3 + r] * b[c * 3 + 1] + a[2 * 3 + r] * b[c * 3 + 2];
  return o;
}

export function m3mulv(a: Mat3, p: Vec3): Vec3 {
  return {
    x: a[0] * p.x + a[3] * p.y + a[6] * p.z,
    y: a[1] * p.x + a[4] * p.y + a[7] * p.z,
    z: a[2] * p.x + a[5] * p.y + a[8] * p.z,
  };
}

export function m3inv(a: Mat3): Mat3 {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const b0 = a4 * a8 - a5 * a7, b1 = a2 * a7 - a1 * a8, b2 = a1 * a5 - a2 * a4;
  const det = a0 * b0 + a3 * b1 + a6 * b2;
  const d = 1 / (det || 1e-12);
  return Float64Array.from([
    b0 * d, (a5 * a6 - a3 * a8) * d, (a3 * a7 - a4 * a6) * d,
    b1 * d, (a0 * a8 - a2 * a6) * d, (a2 * a6 - a0 * a7) * d,
    b2 * d, (a1 * a6 - a0 * a5) * d, (a0 * a4 - a1 * a3) * d,
  ]);
}

/** 由三个行向量构造（便于写 R 的行列定义） */
export function m3fromRows(r0: Vec3, r1: Vec3, r2: Vec3): Mat3 {
  return Float64Array.from([r0.x, r1.x, r2.x, r0.y, r1.y, r2.y, r0.z, r1.z, r2.z]);
}
export function m3fromCols(c0: Vec3, c1: Vec3, c2: Vec3): Mat3 {
  return Float64Array.from([c0.x, c0.y, c0.z, c1.x, c1.y, c1.z, c2.x, c2.y, c2.z]);
}
/** Rodrigues：旋转向量 -> 旋转矩阵 */
export function rodrigues(rvec: Vec3): Mat3 {
  const theta = len(rvec);
  if (theta < 1e-12) return m3id();
  const k = scl(rvec, 1 / theta);
  const K = m3fromRows(
    { x: 0, y: -k.z, z: k.y },
    { x: k.z, y: 0, z: -k.x },
    { x: -k.y, z: k.x, y: 0 },
  );
  const s = Math.sin(theta), c = Math.cos(theta);
  const I = m3id();
  // R = I + sinθ·K + (1-cosθ)·K²
  const K2 = m3mul(K, K);
  const out = new Float64Array(9);
  for (let i = 0; i < 9; i++) out[i] = I[i] + s * K[i] + (1 - c) * K2[i];
  return out;
}

// ---------- Mat4（列主序 16 元素） ----------
export type Mat4 = Float32Array;
export const m4id = (): Mat4 =>
  Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function m4mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
  return o;
}

export function m4perspective(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  return Float32Array.from([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function m4lookAt(eye: Vec3, center: Vec3, upHint: Vec3): Mat4 {
  const z = norm(sub(eye, center)); // 相机看向 -z
  const x = norm(cross(upHint, z));
  const y = cross(z, x);
  return Float32Array.from([
    x.x, y.x, z.x, 0,
    x.y, y.y, z.y, 0,
    x.z, y.z, z.z, 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

/** 由旋转矩阵 R、平移 t（世界->相机：Xc = R·Xw + t）、焦距合成模型视图（含内参，即投影用 P=K[R|t] 的 4x4 版） */
export function m4fromRt(R: Mat3, t: Vec3): Mat4 {
  return Float32Array.from([
    R[0], R[1], R[2], 0,
    R[3], R[4], R[5], 0,
    R[6], R[7], R[8], 0,
    t.x, t.y, t.z, 1,
  ]);
}

export function m4mulv(a: Mat4, p: Vec3): Vec3 {
  const w = a[3] * p.x + a[7] * p.y + a[11] * p.z + a[15];
  return {
    x: (a[0] * p.x + a[4] * p.y + a[8] * p.z + a[12]) / w,
    y: (a[1] * p.x + a[5] * p.y + a[9] * p.z + a[13]) / w,
    z: (a[2] * p.x + a[6] * p.y + a[10] * p.z + a[14]) / w,
  };
}

export function m4inv(a: Mat4): Mat4 {
  const o = new Float32Array(16);
  const inv = (out: Float32Array, m: Float32Array) => {
    const [a0, a1, a2, a3, b0, b1, b2, b3, c0, c1, c2, c3, d0, d1, d2, d3] = m;
    const b00 = a0 * b1 - a1 * b0, b01 = a0 * b2 - a2 * b0, b02 = a0 * b3 - a3 * b0;
    const b03 = a1 * b2 - a2 * b1, b04 = a1 * b3 - a3 * b1, b05 = a2 * b3 - a3 * b2;
    const c00 = c0 * d1 - c1 * d0, c01 = c0 * d2 - c2 * d0, c02 = c0 * d3 - c3 * d0;
    const c03 = c1 * d2 - c2 * d1, c04 = c1 * d3 - c3 * d1, c05 = c2 * d3 - c3 * d2;
    let det = b00 * c05 - b01 * c04 + b02 * c03 + b03 * c02 - b04 * c01 + b05 * c00;
    if (!det) return;
    det = 1 / det;
    out[0] = (b1 * c05 - b2 * c04 + b3 * c03) * det;
    out[1] = (a2 * c04 - a1 * c05 - a3 * c03) * det;
    out[2] = (d3 * b03 + d2 * (-b04) + d1 * b05) * det;
    out[3] = (c3 * b04 + c2 * (-b05) - c1 * b03) * det;
    out[4] = (b2 * c02 - b3 * c01 - b0 * c05) * det;
    out[5] = (a0 * c05 + a3 * c01 - a2 * c02) * det;
    out[6] = (d0 * b05 + d3 * b02 + d2 * (-b02)) * det;
    out[7] = (c0 * b05 + c2 * b02 - c3 * b02) * det;
    out[8] = (b3 * c00 - b1 * c02 + b0 * c04) * det;
    out[9] = (a1 * c02 - a0 * c04 - a3 * c00) * det;
    out[10] = (d1 * b02 - d0 * b04 - d3 * b00) * det;
    out[11] = (c1 * b00 - c0 * b02 - c2 * b02) * det;
    out[12] = (b0 * c01 - b2 * c00 + b1 * c00) * det;
    out[13] = (a2 * c00 - a0 * c01 - a1 * c00) * det;
    out[14] = (d0 * b03 - d1 * b01 + d2 * b00) * det;
    out[15] = (c0 * b01 - c1 * b00 - c2 * b00) * det;
  };
  inv(o, a);
  return o;
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const deg2rad = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;

/** 解 2x2 线性系统，返回 null 表示奇异 */
export function solve2(a: number, b: number, c: number, d: number, e: number, f: number): Vec2 | null {
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return { x: (e * d - b * f) / det, y: (a * f - e * c) / det };
}
