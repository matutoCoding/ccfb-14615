// 轻量向量/矩阵库：列主序 Mat4(WebGL 约定)，相机系 x 右、y 下、z 前
export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;
export type Mat3 = Float32Array;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const v3add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const v3sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const v3scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const v3dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const v3cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const v3len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const v3dist = (a: Vec3, b: Vec3): number => v3len(v3sub(a, b));
export const v3norm = (a: Vec3): Vec3 => {
  const l = v3len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const v3lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export const rad = (deg: number): number => (deg * Math.PI) / 180;
export const deg = (radv: number): number => (radv * 180) / Math.PI;
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

// ---------- Mat3 列主序 ----------
export function m3ident(): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}
export function m3mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Float32Array(9);
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++)
      o[c * 3 + r] =
        a[0 * 3 + r] * b[c * 3 + 0] + a[1 * 3 + r] * b[c * 3 + 1] + a[2 * 3 + r] * b[c * 3 + 2];
  return o;
}
export function m3fromCols(c0: Vec3, c1: Vec3, c2: Vec3): Mat3 {
  return new Float32Array([c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]]);
}
export function m3col(m: Mat3, c: number): Vec3 {
  return [m[c * 3], m[c * 3 + 1], m[c * 3 + 2]];
}
export function m3apply(m: Mat3, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[3] * p[1] + m[6] * p[2],
    m[1] * p[0] + m[4] * p[1] + m[7] * p[2],
    m[2] * p[0] + m[5] * p[1] + m[8] * p[2],
  ];
}
export function m3transpose(m: Mat3): Mat3 {
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

// R = Rz(yaw) * Ry(pitch) * Rx(roll)，输入弧度
export function m3fromEuler(yaw: number, pitch: number, roll: number): Mat3 {
  const cx = Math.cos(roll), sx = Math.sin(roll);
  const cy = Math.cos(pitch), sy = Math.sin(pitch);
  const cz = Math.cos(yaw), sz = Math.sin(yaw);
  const Rx = new Float32Array([1, 0, 0, 0, cx, sx, 0, -sx, cx]);
  const Ry = new Float32Array([cy, 0, -sy, 0, 1, 0, sy, 0, cy]);
  const Rz = new Float32Array([cz, sz, 0, -sz, cz, 0, 0, 0, 1]);
  return m3mul(m3mul(Rz, Ry), Rx);
}

export function eulerFromMat3(m: Mat3): Vec3 {
  // 与 m3fromEuler 互逆
  const sy = Math.hypot(m[0], m[1]);
  const pitch = Math.atan2(-m[6], sy);
  let yaw: number, roll: number;
  if (sy > 1e-9) {
    yaw = Math.atan2(m[3], m[4]);
    roll = Math.atan2(m[7], m[8]);
  } else {
    yaw = Math.atan2(-m[2], m[0]);
    roll = 0;
  }
  return [yaw, pitch, roll];
}

// 相机系 x 右 y 下 z 前；由光心/注视点构造旋转阵(列 [right, down, forward]，行列式 +1)
export function lookAtRotation(eye: Vec3, target: Vec3, worldUp: Vec3 = [0, 0, 1]): Mat3 {
  const f = v3norm(v3sub(target, eye));
  const r = v3norm(v3cross(worldUp, f));
  const d = v3cross(f, r); // 相机下方向，保证 det=+1
  return m3fromCols(r, d, f);
}

// ---------- Mat4 ----------
export function m4ident(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
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
export function m4fromMat3(m: Mat3): Mat4 {
  const o = m4ident();
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) o[j * 4 + i] = m[j * 3 + i];
  return o;
}
export function m4compose(R: Mat3, t: Vec3): Mat4 {
  const o = m4fromMat3(R);
  o[12] = t[0];
  o[13] = t[1];
  o[14] = t[2];
  return o;
}
export function m4invert(a: Mat4): Mat4 {
  const out = new Float32Array(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a21 - a01 * a20;
  const b02 = a00 * a31 - a01 * a30;
  const b03 = a10 * a21 - a11 * a20;
  const b04 = a10 * a31 - a11 * a30;
  const b05 = a20 * a31 - a21 * a30;
  const b06 = a02 * a13 - a03 * a12;
  const b07 = a02 * a23 - a03 * a22;
  const b08 = a02 * a33 - a03 * a32;
  const b09 = a12 * a23 - a13 * a22;
  const b10 = a12 * a33 - a13 * a32;
  const b11 = a22 * a33 - a23 * a32;
  let det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  det = 1 / det;
  out[0] = (a11 * b11 - a21 * b10 + a31 * b09) * det;
  out[1] = (a01 * b11 - a21 * b08 + a31 * b07) * det;
  out[2] = (a01 * b10 - a11 * b08 + a31 * b06) * det;
  out[3] = (a01 * b09 - a11 * b07 + a21 * b06) * det;
  out[4] = (a12 * b05 - a13 * b04 + a23 * b02) * det;
  out[5] = (a02 * b05 - a12 * b03 + a22 * b02) * det;
  out[6] = (a02 * b04 - a12 * b02 + a22 * b01) * det;
  out[7] = (a02 * b02 - a13 * b01 + a23 * b00) * det;
  out[8] = (a13 * b10 - a12 * b11 - a23 * b04 + a22 * b03) * det;
  out[9] = (a03 * b10 - a02 * b11 + a23 * b01 - a22 * b02) * det;
  out[10] = (a03 * b09 - a13 * b07 + a23 * b06 - a22 * b08) * det;
  out[11] = (a13 * b08 - a03 * b07 - a23 * b05 + a22 * b04) * det;
  out[12] = (a12 * b06 - a22 * b05 + a32 * b04) * det;
  out[13] = (a02 * b06 - a32 * b04 + a22 * b03) * det;
  out[14] = (a32 * b02 - a12 * b05 + a22 * b01) * det;
  out[15] = (b00 * b11 - b01 * b10 + b02 * b09) * det;
  return out;
}

// 轨道观察相机(无畸变)的透视投影矩阵，NDC 右手系
export function m4perspective(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

export function m4lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const z = v3norm(v3sub(eye, center));
  const x = v3norm(v3cross(up, z));
  const y = v3cross(z, x);
  const m = m4ident();
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[12] = -v3dot(x, eye);
  m[13] = -v3dot(y, eye);
  m[14] = -v3dot(z, eye);
  return m;
}
