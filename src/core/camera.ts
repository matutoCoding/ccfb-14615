// 针孔相机 + 径向畸变(k1,k2)，EPnP 初值 + LM 联合精化
// 相机坐标系：x 右、y 下、z 前(视线)；u = fx * xn + cx, v = fy * yn + cy
import {
  Mat3, Vec3, m3apply, m3col, m3fromCols, m3mul, m3transpose, v3add, v3cross, v3dist, v3dot, v3len,
  v3norm, v3scale, v3sub, rad, deg, m3fromEuler,
} from './math';
import { closestRotation, jacobiEigen, solveSym } from './svd';
import { GimbalAngles, SerializedCamera, TiePoint } from '../types';

export interface Intrinsics {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
}

export interface CameraPose {
  R: Mat3; // 世界 -> 相机
  C: Vec3; // 光心(世界坐标)
}

export interface CameraModel extends Intrinsics, CameraPose {}

export function serializeCamera(m: CameraModel): SerializedCamera {
  return {
    width: m.width, height: m.height, fx: m.fx, fy: m.fy, cx: m.cx, cy: m.cy,
    k1: m.k1, k2: m.k2, r: Array.from(m.R), t: [...m.C],
  };
}

export function deserializeCamera(s: SerializedCamera): CameraModel {
  return {
    width: s.width, height: s.height, fx: s.fx, fy: s.fy, cx: s.cx, cy: s.cy,
    k1: s.k1, k2: s.k2, R: new Float32Array(s.r), C: [s.t[0], s.t[1], s.t[2]] as Vec3,
  };
}

// 归一化像平面坐标 -> 带径向畸变的像平面坐标
export function distortNormalized(xn: number, yn: number, k1: number, k2: number): [number, number] {
  const r2 = xn * xn + yn * yn;
  const d = 1 + k1 * r2 + k2 * r2 * r2;
  return [xn * d, yn * d];
}

export function undistortPixel(u: number, v: number, K: Intrinsics): [number, number] {
  let xn = (u - K.cx) / K.fx;
  let yn = (v - K.cy) / K.fy;
  // Newton 迭代去畸变
  for (let i = 0; i < 12; i++) {
    const r2 = xn * xn + yn * yn;
    const d = 1 + K.k1 * r2 + K.k2 * r2 * r2;
    const xu = xn * d, yu = yn * d;
    const dx = xu - (u - K.cx) / K.fx;
    const dy = yu - (v - K.cy) / K.fy;
    // 畸变映射的近似 Jacobian
    const ddrx = d + 2 * (K.k1 + 2 * K.k2 * r2) * xn * xn;
    const ddry = d + 2 * (K.k1 + 2 * K.k2 * r2) * yn * yn;
    const drxy = 2 * (K.k1 + 2 * K.k2 * r2) * xn * yn;
    const det = ddrx * ddry - drxy * drxy || 1e-12;
    const nx = xn - (ddry * dx - drxy * dy) / det;
    const ny = yn - (ddrx * dy - drxy * dx) / det;
    xn = nx; yn = ny;
  }
  return [xn, yn];
}

// 世界点 -> 像素(含畸变)
export function projectPoint(m: CameraModel, P: Vec3): [number, number] {
  const q = m3apply(m.R, v3sub(P, m.C));
  const xn = q[0] / q[2], yn = q[1] / q[2];
  const [xd, yd] = distortNormalized(xn, yn, m.k1, m.k2);
  return [m.fx * xd + m.cx, m.fy * yd + m.cy];
}

// 世界点 -> 归一化无畸变坐标(供烘焙/着色器共用)
export function worldToNormalized(m: CameraModel, P: Vec3): [number, number, number] {
  const q = m3apply(m.R, v3sub(P, m.C));
  return [q[0] / q[2], q[1] / q[2], q[2]];
}

export function pointResiduals(m: CameraModel, ties: TiePoint[]): number[] {
  return ties.map((tp) => {
    const [u, v] = projectPoint(m, tp.world as Vec3);
    return Math.hypot(u - tp.image[0], v - tp.image[1]);
  });
}

export function rmsResidual(m: CameraModel, ties: TiePoint[]): number {
  const r = pointResiduals(m, ties);
  return Math.sqrt(r.reduce((s, x) => s + x * x, 0) / Math.max(1, r.length));
}

// ---------- 云台角 -> 旋转阵 ----------
// yaw: 绕世界Z；pitch: 视线俯仰(水平0，抬头正)；roll: 绕视线
export function rotationFromGimbal(g: GimbalAngles): Mat3 {
  const yaw = rad(g.yaw), pitch = rad(g.pitch), roll = rad(g.roll);
  const f: Vec3 = [
    Math.cos(pitch) * Math.sin(yaw),
    Math.cos(pitch) * Math.cos(yaw),
    Math.sin(pitch),
  ];
  const r0: Vec3 = [Math.cos(yaw), -Math.sin(yaw), 0];
  const right = v3norm(v3sub(r0, v3scale(f, v3dot(r0, f))));
  const down = v3cross(f, right); // 保证 det=+1
  // roll 绕 f 旋转 right/down
  const c = Math.cos(roll), s = Math.sin(roll);
  const r2 = v3add(v3scale(right, c), v3scale(down, s));
  const d2 = v3add(v3scale(down, c), v3scale(right, -s));
  return m3fromCols(v3norm(r2), v3norm(d2), v3norm(f));
}

export function gimbalFromRotation(R: Mat3): GimbalAngles {
  const f = m3col(R, 2);
  const right = m3col(R, 0);
  const down = m3col(R, 1);
  const yaw = Math.atan2(f[0], f[1]);
  const pitch = Math.atan2(f[2], Math.hypot(f[0], f[1]));
  // 零滚基准：由光轴反推水平 right0/down0，再用当前基的分量求 roll
  const yawR = yaw, pitchR = pitch;
  const f0: Vec3 = [
    Math.cos(pitchR) * Math.sin(yawR),
    Math.cos(pitchR) * Math.cos(yawR),
    Math.sin(pitchR),
  ];
  const r0h: Vec3 = [Math.cos(yawR), -Math.sin(yawR), 0];
  const right0 = v3norm(v3sub(r0h, v3scale(f0, v3dot(r0h, f0))));
  const down0 = v3cross(f0, right0);
  const roll = Math.atan2(v3dot(right, down0), v3dot(right, right0));
  return { yaw: deg(yaw), pitch: deg(pitch), roll: deg(roll) };
}

// ---------- EPnP ----------
// 输入无畸变归一化坐标与对应世界点，返回 R,C
export function epnp(ray: Vec3[], world: Vec3[]): CameraPose {
  const n = world.length;
  // 4 个控制点：质心 + 主方向三点
  const c0 = v3scale(
    world.reduce((a, p) => v3add(a, p), [0, 0, 0] as Vec3),
    1 / n
  );
  const A = new Float32Array(9);
  for (const p of world) {
    const d = v3sub(p, c0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) A[i * 3 + j] += d[i] * d[j];
  }
  // 控制点主轴：Jacobi 特征分解，按特征值降序取三个方向
  const Aarr = [
    [A[0], A[3], A[6]],
    [A[1], A[4], A[7]],
    [A[2], A[5], A[8]],
  ];
  const eigA = jacobiEigen(Aarr);
  const axes: Vec3[] = [2, 1, 0].map((k) => eigA.vectors[k] as Vec3);
  const spread = Math.sqrt(Math.max(1e-6, A[0] + A[4] + A[8]) / n);
  const cw: Vec3[] = [
    c0,
    v3add(c0, v3scale(axes[0], spread)),
    v3add(c0, v3scale(axes[1], spread)),
    v3add(c0, v3scale(axes[2], spread)),
  ];
  // 世界点关于控制点的重心坐标
  const Cmat = m3fromCols(v3sub(cw[1], cw[0]), v3sub(cw[2], cw[0]), v3sub(cw[3], cw[0]));
  const Cinv = invert3(Cmat);
  const alpha: number[][] = world.map((p) => {
    const d = m3apply(Cinv, v3sub(p, cw[0]));
    return [1 - d[0] - d[1] - d[2], d[0], d[1], d[2]];
  });
  // M x = 0，x 为相机系下 4 控制点坐标(共12维)
  const M: number[][] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = [ray[i][0], ray[i][1]];
    const row1 = new Array<number>(12).fill(0);
    const row2 = new Array<number>(12).fill(0);
    for (let j = 0; j < 4; j++) {
      row1[j * 3] = alpha[i][j];
      row1[j * 3 + 2] = -x * alpha[i][j];
      row2[j * 3 + 1] = alpha[i][j];
      row2[j * 3 + 2] = -y * alpha[i][j];
    }
    M.push(row1, row2);
  }
  const MtM = Array.from({ length: 12 }, () => new Array<number>(12).fill(0));
  for (const row of M)
    for (let p = 0; p < 12; p++)
      for (let q = 0; q < 12; q++) MtM[p][q] += row[p] * row[q];
  const { vectors } = jacobiEigen(MtM);
  const eigenVecs = vectors.slice(0, 4).map((v) => {
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
  // 每个零空间特征向量给出一组相机系控制点(未定标)
  const ccBasis: Vec3[][] = eigenVecs.map((ev) =>
    [0, 1, 2, 3].map((j) => [ev[j * 3], ev[j * 3 + 1], ev[j * 3 + 2]])
  );
  // 世界控制点 6 对距离
  const pairs: [number, number][] = [];
  const dw: number[] = [];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    pairs.push([i, j]);
    dw.push(v3dist(cw[i], cw[j]));
  }
  // 残差 r_k(beta) = ||sum_a beta_a (c_a_i - c_a_j)|| - dw_k，对 beta 做 Gauss-Newton
  const refineBeta = (beta0: number[]): number[] => {
    let beta = [...beta0];
    for (let iter = 0; iter < 30; iter++) {
      const J: number[][] = [];
      const r: number[] = [];
      for (let k = 0; k < pairs.length; k++) {
        const [i, j] = pairs[k];
        const diff: Vec3[] = ccBasis.map((cc) => v3sub(cc[i], cc[j]));
        const d: Vec3 = [
          beta.reduce((s, b, a) => s + b * diff[a][0], 0),
          beta.reduce((s, b, a) => s + b * diff[a][1], 0),
          beta.reduce((s, b, a) => s + b * diff[a][2], 0),
        ];
        const norm = v3len(d) || 1e-12;
        r.push(norm - dw[k]);
        J.push(diff.map((dd) => v3dot(dd, d) / norm));
      }
      const JtJ = Array.from({ length: 4 }, () => new Array<number>(4).fill(0));
      const Jtr = new Array<number>(4).fill(0);
      for (let a = 0; a < 4; a++) {
        for (let k = 0; k < pairs.length; k++) Jtr[a] += J[k][a] * r[k];
        for (let b = 0; b < 4; b++) for (let k = 0; k < pairs.length; k++) JtJ[a][b] += J[k][a] * J[k][b];
      }
      let delta: number[];
      try {
        for (let a = 0; a < 4; a++) JtJ[a][a] += 1e-8;
        delta = solveSym(JtJ, Jtr.map((x) => -x));
      } catch {
        break;
      }
      beta = beta.map((b, a) => b + delta[a]);
      if (Math.hypot(...delta) < 1e-9) break;
    }
    return beta;
  };
  let best: { R: Mat3; C: Vec3; err: number } | null = null;
  const candidates: Vec3[][] = [];
  // 单特征向量种子 -> 距离定标给 beta 初值(仅对应分量非零) -> GN 精化到 4 个 beta
  for (const ev of eigenVecs) {
    for (const sign of [1, -1]) {
      const cc0: Vec3[] = [0, 1, 2, 3].map((j) => [
        sign * ev[j * 3], sign * ev[j * 3 + 1], sign * ev[j * 3 + 2],
      ]);
      const dc: number[] = [];
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) dc.push(v3dist(cc0[i], cc0[j]));
      const scale = dw.reduce((s, w, k) => s + w * dc[k], 0) / (dc.reduce((s, x) => s + x * x, 0) || 1e-9);
      const beta0 = [0, 0, 0, 0];
      beta0[eigenVecs.indexOf(ev)] = scale * sign;
      const beta = refineBeta(beta0);
      const cc: Vec3[] = [0, 1, 2, 3].map((j) => [
        beta[0] * ccBasis[0][j][0] + beta[1] * ccBasis[1][j][0] + beta[2] * ccBasis[2][j][0] + beta[3] * ccBasis[3][j][0],
        beta[0] * ccBasis[0][j][1] + beta[1] * ccBasis[1][j][1] + beta[2] * ccBasis[2][j][1] + beta[3] * ccBasis[3][j][1],
        beta[0] * ccBasis[0][j][2] + beta[1] * ccBasis[1][j][2] + beta[2] * ccBasis[2][j][2] + beta[3] * ccBasis[3][j][2],
      ]);
      candidates.push(cc);
    }
  }
  for (const scaledCC of candidates) {
    // 用重心坐标把全部 n 个点重建到相机系，再做 Horn 绝对定向
    const camPts: Vec3[] = alpha.map((a) => [
      a[0] * scaledCC[0][0] + a[1] * scaledCC[1][0] + a[2] * scaledCC[2][0] + a[3] * scaledCC[3][0],
      a[0] * scaledCC[0][1] + a[1] * scaledCC[1][1] + a[2] * scaledCC[2][1] + a[3] * scaledCC[3][1],
      a[0] * scaledCC[0][2] + a[1] * scaledCC[1][2] + a[2] * scaledCC[2][2] + a[3] * scaledCC[3][2],
    ]);
    const horn = hornAbsolute(world, camPts);
    if (!horn) continue;
    const R = horn.R;
    const C = v3scale(m3apply(m3transpose(R), horn.t), -1); // t_cam = -R C => C = -R^T t
    const err = reproScore(R, C, ray, world);
    if (!best || err < best.err) best = { R, C, err };
  }
  if (!best) throw new Error('EPnP 求解失败');
  return { R: best.R, C: best.C };
}

function reproScore(R: Mat3, C: Vec3, ray: Vec3[], world: Vec3[]): number {
  let s = 0;
  for (let i = 0; i < world.length; i++) {
    const q = m3apply(R, v3sub(world[i], C));
    if (q[2] <= 0.05) return 1e9;
    const err = Math.hypot(q[0] / q[2] - ray[i][0], q[1] / q[2] - ray[i][1]);
    s += err * err;
  }
  return s / world.length;
}

// Horn 绝对定向：求 R,t 使 cameraPts ≈ R worldPts + t
function hornAbsolute(world: Vec3[], cam: Vec3[]): { R: Mat3; t: Vec3 } | null {
  const n = world.length;
  const mw = v3scale(world.reduce((a, p) => v3add(a, p), [0, 0, 0] as Vec3), 1 / n);
  const mc = v3scale(cam.reduce((a, p) => v3add(a, p), [0, 0, 0] as Vec3), 1 / n);
  const H = new Float32Array(9);
  for (let i = 0; i < n; i++) {
    const w = v3sub(world[i], mw), c = v3sub(cam[i], mc);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) H[a * 3 + b] += c[a] * w[b];
  }
  const R = closestRotation(H);
  const t = v3sub(mc, m3apply(R, mw));
  return { R, t };
}

function invert3(m: Mat3): Mat3 {
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[3] * (m[1] * m[8] - m[2] * m[7]) +
    m[6] * (m[1] * m[5] - m[2] * m[4]);
  const id = 1 / (det || 1e-12);
  return new Float32Array([
    (m[4] * m[8] - m[5] * m[7]) * id,
    (m[2] * m[7] - m[1] * m[8]) * id,
    (m[1] * m[5] - m[2] * m[4]) * id,
    (m[5] * m[6] - m[3] * m[8]) * id,
    (m[0] * m[8] - m[2] * m[6]) * id,
    (m[2] * m[3] - m[0] * m[5]) * id,
    (m[3] * m[7] - m[4] * m[6]) * id,
    (m[1] * m[6] - m[0] * m[7]) * id,
    (m[0] * m[4] - m[1] * m[3]) * id,
  ]);
}

// ---------- LM 联合精化 ----------
// 参数：[fx, fy, k1, k2, rx, ry, rz, Cx, Cy, Cz]
interface SolveResult {
  camera: CameraModel;
  residuals: number[];
  rms: number;
  iterations: number;
}

function so3Exp(w: Vec3): Mat3 {
  const theta = v3len(w);
  if (theta < 1e-10) {
    return m3fromCols(
      [1, -w[2], w[1]],
      [w[2], 1, -w[0]],
      [-w[1], w[0], 1]
    );
  }
  const k = v3scale(w, 1 / theta);
  const K = new Float32Array([
    0, k[2], -k[1],
    -k[2], 0, k[0],
    k[1], -k[0], 0,
  ]);
  const K2 = m3mul(K, K);
  const I = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const s = Math.sin(theta), c = Math.cos(theta);
  const out = new Float32Array(9);
  for (let i = 0; i < 9; i++) out[i] = I[i] + s * K[i] + (1 - c) * K2[i];
  return out;
}

function so3Log(R: Mat3): Vec3 {
  const cosTheta = Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2));
  const theta = Math.acos(cosTheta);
  if (theta < 1e-9) return [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
  const s = 2 * Math.sin(theta);
  return [
    theta * (R[7] - R[5]) / s,
    theta * (R[2] - R[6]) / s,
    theta * (R[3] - R[1]) / s,
  ];
}

export interface PnPInput {
  width: number;
  height: number;
  observed: [number, number][]; // 带畸变像素
  world: Vec3[];
  guess?: Partial<Intrinsics> & { pose?: CameraPose };
}

export function solvePnP(input: PnPInput): SolveResult {
  const { width, height, observed, world } = input;
  const n = observed.length;
  if (n < 4) throw new Error('同名点至少需要 4 个');
  const g = input.guess ?? {};
  let fx = g.fx ?? Math.max(width, height) * 1.2;
  let fy = g.fy ?? fx;
  let cx = g.cx ?? width / 2;
  let cy = g.cy ?? height / 2;
  let k1 = g.k1 ?? 0;
  let k2 = g.k2 ?? 0;

  // 1) 用当前内参去畸变，EPnP 求位姿
  const K0: Intrinsics = { width, height, fx, fy, cx, cy, k1, k2 };
  const rays: Vec3[] = observed.map(([u, v]) => {
    const [xn, yn] = undistortPixel(u, v, K0);
    return [xn, yn, 1];
  });
  let pose: CameraPose;
  if (g.pose) {
    pose = { R: new Float32Array(g.pose.R), C: [...g.pose.C] as Vec3 };
  } else {
    try {
      pose = epnp(rays, world);
    } catch {
      // 退化时给一个桥下方的兜底位姿
      const center = v3scale(world.reduce((a, p) => v3add(a, p), [0, 0, 0] as Vec3), 1 / n);
      pose = { R: m3fromEuler(0, 0, 0), C: [center[0], center[1] - 8, center[2] + 6] };
    }
  }

  const ties: TiePoint[] = observed.map((p, i) => ({ id: `${i}`, image: p, world: world[i] }));
  const buildModel = (): CameraModel => ({ width, height, fx, fy, cx, cy, k1, k2, R: pose.R, C: pose.C });

  const residualsOf = (m: CameraModel): number[] => pointResiduals(m, ties);
  const costOf = (r: number[]): number => r.reduce((s, x) => s + x * x, 0);

  let model = buildModel();
  let res = residualsOf(model);
  let cost = costOf(res);
  let lambda = 1e-3;
  let it = 0;
  for (it = 0; it < 60; it++) {
    const w = so3Log(pose.R);
    const params = [fx, fy, k1, k2, w[0], w[1], w[2], pose.C[0], pose.C[1], pose.C[2]];
    // 数值 Jacobian(前向差分)，每参数 10 次投影，点多也够用
    const J: number[][] = Array.from({ length: 2 * n }, () => new Array<number>(10).fill(0));
    const base: number[] = [];
    for (const tp of ties) {
      const [u, v] = projectPoint(model, tp.world as Vec3);
      base.push(u, v);
    }
    // 自适应有限差分步长：按各参数量级取相对扰动，避免固定步长在尺度变化后失效
    const scales = [
      Math.max(Math.abs(fx) * 1e-6, 0.01),
      Math.max(Math.abs(fy) * 1e-6, 0.01),
      1e-7, 1e-9,
      1e-7, 1e-7, 1e-7,
      1e-5, 1e-5, 1e-5,
    ];
    for (let p = 0; p < 10; p++) {
      const h = scales[p];
      // 中心差分，O(h²) 精度，避免收敛尾部雅可比失真
      const wPertPos: Vec3 = [p === 4 ? h : 0, p === 5 ? h : 0, p === 6 ? h : 0];
      const wPertNeg: Vec3 = [p === 4 ? -h : 0, p === 5 ? -h : 0, p === 6 ? -h : 0];
      const baseP: number[] = [fx, fy, k1, k2];
      const baseC: Vec3 = [...pose.C];
      const mkTrial = (sgn: 1 | -1, w: Vec3): CameraModel => ({
        width, height, cx, cy,
        fx: p === 0 ? baseP[0] + sgn * h : baseP[0],
        fy: p === 1 ? baseP[1] + sgn * h : baseP[1],
        k1: p === 2 ? baseP[2] + sgn * h : baseP[2],
        k2: p === 3 ? baseP[3] + sgn * h : baseP[3],
        R: m3mul(so3Exp(w), pose.R),
        C: [
          baseC[0] + (p === 7 ? sgn * h : 0),
          baseC[1] + (p === 8 ? sgn * h : 0),
          baseC[2] + (p === 9 ? sgn * h : 0),
        ],
      });
      const tp = mkTrial(1, wPertPos);
      const tn = mkTrial(-1, wPertNeg);
      for (let i = 0; i < n; i++) {
        const [up, vp] = projectPoint(tp, ties[i].world as Vec3);
        const [un, vn] = projectPoint(tn, ties[i].world as Vec3);
        J[i * 2][p] = (up - un) / (2 * h);
        J[i * 2 + 1][p] = (vp - vn) / (2 * h);
      }
    }
    // 残差向量(观测 - 投影)
    const e: number[] = [];
    for (let i = 0; i < n; i++) {
      e.push(observed[i][0] - base[i * 2]);
      e.push(observed[i][1] - base[i * 2 + 1]);
    }
    // JtJ + λ diag, Jte
    const N = 10;
    const JtJ = Array.from({ length: N }, () => new Array<number>(N).fill(0));
    const Jte = new Array<number>(N).fill(0);
    for (let a = 0; a < N; a++) {
      for (let r = 0; r < 2 * n; r++) Jte[a] += J[r][a] * e[r];
      for (let b = 0; b < N; b++)
        for (let r = 0; r < 2 * n; r++) JtJ[a][b] += J[r][a] * J[r][b];
    }
    let accepted = false;
    for (let inner = 0; inner < 12; inner++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
      let delta: number[];
      try {
        delta = solveSym(A, Jte);
      } catch {
        lambda *= 10;
        continue;
      }
      const nextParams = params.map((v, i) => v + delta[i]);
      // 姿态更新 = exp(delta_w) · R；nextParams[4..6] 仅用于下一轮重新 so3Log
      const trial: CameraModel = {
        width, height,
        fx: nextParams[0], fy: nextParams[1], k1: nextParams[2], k2: nextParams[3], cx, cy,
        R: m3mul(so3Exp([delta[4], delta[5], delta[6]]), pose.R),
        C: [nextParams[7], nextParams[8], nextParams[9]],
      };
      const trialRes = residualsOf(trial);
      const trialCost = costOf(trialRes);
      if (trialCost < cost) {
        pose = { R: trial.R, C: trial.C };
        fx = nextParams[0]; fy = nextParams[1]; k1 = nextParams[2]; k2 = nextParams[3];
        model = buildModel();
        res = trialRes;
        cost = trialCost;
        lambda = Math.max(lambda * 0.3, 1e-9);
        accepted = true;
        break;
      }
      lambda *= 3;
    }
    if (!accepted) break;
    if (Math.sqrt(cost / n) < 0.05) break;
  }
  return { camera: model, residuals: res, rms: Math.sqrt(cost / n), iterations: it };
}

// POS 粗位姿：光心=ENU 位置，姿态=云台角，内参=标称焦距
export function coarseFromPOS(
  width: number,
  height: number,
  center: Vec3,
  gimbal: GimbalAngles,
  focalMm: number,
  sensorWidthMm = 6.4
): CameraModel {
  const fx = (focalMm / sensorWidthMm) * width;
  return {
    width, height, fx, fy: fx, cx: width / 2, cy: height / 2, k1: 0, k2: 0,
    R: rotationFromGimbal(gimbal), C: center,
  };
}

export { rad, m3fromEuler };
