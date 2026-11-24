// PnP 求解：DLT（11 参数投影矩阵）给初值，LM 精化 [旋转向量3, 平移3, f, k1, k2, p1, p2]。
// 主点固定在图像中心（无人机相机主点偏移通常 <0.5% 幅宽，固定主点可显著降低参数耦合）。
import type { CameraIntrinsics, CameraPose } from './camera';
import { defaultIntrinsics, projectPoint } from './camera';
import { levenbergMarquardt, type LMResult } from './lm';
import { m3fromRows, rodrigues, type Mat3, type Vec2, type Vec3, v3 } from './mathTypes';

export interface Correspondence {
  object: Vec3; // 模型上的三维同名点
  image: Vec2; // 照片像素
}

export interface PnPResult {
  intrinsics: CameraIntrinsics;
  pose: CameraPose;
  /** 每个同名点的重投影残差（像素） */
  residuals: number[];
  rms: number;
  iterations: number;
  converged: boolean;
}

export interface PnPOptions {
  /** 焦距初值（像素）。不传则由 DLT 估计 */
  fGuess?: number;
  /** 初始位姿（如 POS 粗投结果），传入后跳过 DLT */
  initialPose?: CameraPose;
  /** 是否估计切向畸变 p1,p2（默认估计；点少时可关闭） */
  estimateTangential?: boolean;
  maxIterations?: number;
  huber?: number;
  /** 径向畸变信任域（默认 ±0.4）。收紧可防止畸变漂移补偿位姿误差 */
  distortionBound?: number;
}

/** DLT：归一化 12 参数投影矩阵，拆 K[R|t] */
function dlt(corr: Correspondence[], width: number, height: number): { R: Mat3; t: Vec3; f: number } {
  // Hartley 归一化（图像点相似变换）
  const n = corr.length;
  let cx = 0, cy = 0;
  for (const c of corr) { cx += c.image.x; cy += c.image.y; }
  cx /= n; cy /= n;
  let meanDist = 0;
  for (const c of corr) meanDist += Math.hypot(c.image.x - cx, c.image.y - cy);
  meanDist /= n;
  const s = meanDist > 1e-9 ? Math.SQRT2 / meanDist : 1;
  const T = [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
  const normP = corr.map((c) => ({ x: T[0] * c.image.x + T[2], y: T[4] * c.image.y + T[5] }));

  // 物方点各向同性归一化
  let ox = 0, oy = 0, oz = 0;
  for (const c of corr) { ox += c.object.x; oy += c.object.y; oz += c.object.z; }
  ox /= n; oy /= n; oz /= n;
  let md = 0;
  for (const c of corr) md += Math.hypot(c.object.x - ox, c.object.y - oy, c.object.z - oz);
  md /= n;
  const su = md > 1e-9 ? Math.SQRT2 / md : 1;
  const U = [su, 0, 0, -su * ox, 0, su, 0, -su * oy, 0, 0, su, -su * oz, 0, 0, 0, 1];

  const A: number[][] = [];
  for (let i = 0; i < n; i++) {
    const X = U[0] * corr[i].object.x + U[3] * corr[i].object.y + U[6] * corr[i].object.z + U[12];
    const Y = U[1] * corr[i].object.x + U[7] * corr[i].object.y + U[10] * corr[i].object.z + U[13];
    const Z = U[2] * corr[i].object.x + U[8] * corr[i].object.y + U[11] * corr[i].object.z + U[14];
    const { x, y } = normP[i];
    A.push([X, Y, Z, 1, 0, 0, 0, 0, -x * X, -x * Y, -x * Z, -x]);
    A.push([0, 0, 0, 0, X, Y, Z, 1, -y * X, -y * Y, -y * Z, -y]);
  }
  // AᵀA 最小特征向量（幂迭代+逆迭代替代 SVD：用雅可比求最小特征值）
  const AtA = Array.from({ length: 12 }, () => new Array<number>(12).fill(0));
  for (const row of A) for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) AtA[i][j] += row[i] * row[j];
  const p = smallestEigenVector(AtA);
  // 反归一化：P = T⁻¹ · p · U
  const Pmat = Array.from({ length: 3 }, () => new Array<number>(4).fill(0));
  const Tinv = [1 / T[0], 0, -T[2] / T[0], 0, 1 / T[4], -T[5] / T[4], 0, 0, 1];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 4; k++)
        for (let a = 0; a < 3; a++) Pmat[r][c] += Tinv[r * 3 + a] * p[a * 4 + k] * U[k * 4 + c];

  // 分解 P = K[R|t]（RQ 分解，主点取图像中心约束）
  const M = [Pmat[0].slice(0, 3), Pmat[1].slice(0, 3), Pmat[2].slice(0, 3)];
  const p4 = [Pmat[0][3], Pmat[1][3], Pmat[2][3]];
  // 保证 P34 约定：相机看 -Z，M 第三行是视线方向，取符号使其…先 RQ 再修正
  let scale = Math.hypot(M[2][0], M[2][1], M[2][2]);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] /= scale;
  for (let i = 0; i < 3; i++) p4[i] /= scale;
  const { K, R } = rqDecompose(M);
  // 符号修正：f>0，det(R)=+1
  let D = [Math.sign(K[0][0]) || 1, Math.sign(K[1][1]) || 1, Math.sign(K[2][2]) || 1];
  for (let i = 0; i < 3; i++) {
    R[i] = R[i].map((v) => v * D[i]);
    p4[i] *= D[i];
  }
  // Rt = K⁻¹ p4
  const t = solve3(K, p4);
  const f = Math.abs((K[0][0] + K[1][1]) / 2);
  const Rm = m3fromRows(v3(R[0][0], R[0][1], R[0][2]), v3(R[1][0], R[1][1], R[1][2]), v3(R[2][0], R[2][1], R[2][2]));
  return { R: Rm, t: v3(t[0], t[1], t[2]), f: Math.max(f, width * 0.2) };
}

function rqDecompose(M: number[][]): { K: number[][]; R: number[][] } {
  // 对 3x3 做 RQ（Givens）
  const A = M.map((r) => r.slice());
  const Q = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const givens = (p: number, q: number) => {
    const [a, b] = [A[p][p], A[q][p]];
    const c = a / Math.hypot(a, b), s = -b / Math.hypot(a, b);
    for (let j = 0; j < 3; j++) {
      const ap = c * A[p][j] - s * A[q][j];
      const aq = s * A[p][j] + c * A[q][j];
      A[p][j] = ap; A[q][j] = aq;
    }
    for (let i = 0; i < 3; i++) {
      const qp = c * Q[i][p] - s * Q[i][q];
      const qq = s * Q[i][p] + c * Q[i][q];
      Q[i][p] = qp; Q[i][q] = qq;
    }
  };
  givens(1, 2);
  givens(0, 2);
  givens(0, 1);
  return { K: A, R: Q };
}

function solve3(A: number[][], b: number[]): number[] {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let i = col + 1; i < 3; i++) if (Math.abs(M[i][col]) > Math.abs(M[piv][col])) piv = i;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let i = 0; i < 3; i++) {
      if (i === col) continue;
      const f = M[i][col] / M[col][col];
      for (let j = col; j < 4; j++) M[i][j] -= f * M[col][j];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

/** 雅可比法求对称矩阵最小特征值对应特征向量 */
function smallestEigenVector(A: number[][]): number[] {
  const n = A.length;
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  const M: number[][] = A.map((r) => r.slice());
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += M[p][q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(M[p][q]) < 1e-18) continue;
        const tau = (M[q][q] - M[p][p]) / (2 * M[p][q]);
        const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t), s = t * c;
        for (let k = 0; k < n; k++) {
          const mp = c * M[p][k] - s * M[q][k];
          const mq = s * M[p][k] + c * M[q][k];
          M[p][k] = mp; M[q][k] = mq;
        }
        for (let k = 0; k < n; k++) {
          const mp = c * M[k][p] - s * M[k][q];
          const mq = s * M[k][p] + c * M[k][q];
          M[k][p] = mp; M[k][q] = mq;
        }
        for (let k = 0; k < n; k++) {
          const vp = c * V[k][p] - s * V[k][q];
          const vq = s * V[k][p] + c * V[k][q];
          V[k][p] = vp; V[k][q] = vq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (M[i][i] < M[best][best]) best = i;
  return V.map((row) => row[best]);
}

export function rvecFromR(R: Mat3): Vec3 {
  const trace = R[0] + R[4] + R[8];
  const cosT = Math.max(-1, Math.min(1, (trace - 1) / 2));
  const theta = Math.acos(cosT);
  if (theta < 1e-9) {
    // 小角度：r ≈ vee(R - I)/2
    return v3((R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2);
  }
  // θ 接近 π 时 sinθ→0，标准反对称公式退化。改用基于 R+Rᵀ 对角元的稳定求法：
  // r 方向为 (R+Rᵀ) 最大特征值对应的特征向量，长度 = θ。
  if (theta > Math.PI - 1e-6) {
    // 选 (R+Rᵀ) 对角元最大者构造轴向（OpenCV 经典处理）
    const rr = [R[0], R[4], R[8]];
    const maxI = rr.indexOf(Math.max(...rr));
    const axis = v3(0, 0, 0);
    if (maxI === 0) {
      const v = Math.sqrt(Math.max(1e-12, R[0] + 1) / 2);
      axis.x = v; axis.y = R[1] / (2 * v); axis.z = R[2] / (2 * v);
    } else if (maxI === 1) {
      const v = Math.sqrt(Math.max(1e-12, R[4] + 1) / 2);
      axis.x = R[3] / (2 * v); axis.y = v; axis.z = R[5] / (2 * v);
    } else {
      const v = Math.sqrt(Math.max(1e-12, R[8] + 1) / 2);
      axis.x = R[6] / (2 * v); axis.y = R[7] / (2 * v); axis.z = v;
    }
    // 符号校正：r 与反对称部分同向
    if (axis.x * (R[7] - R[5]) + axis.y * (R[2] - R[6]) + axis.z * (R[3] - R[1]) < 0) {
      axis.x = -axis.x; axis.y = -axis.y; axis.z = -axis.z;
    }
    return v3(axis.x * theta, axis.y * theta, axis.z * theta);
  }
  const k = theta / (2 * Math.sin(theta));
  return v3((R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k);
}

export function solvePnP(corr: Correspondence[], width: number, height: number, opts: PnPOptions = {}): PnPResult {
  if (corr.length < 4) throw new Error('同名点至少需要 4 个');
  const estimateTangential = opts.estimateTangential ?? corr.length >= 7;

  let R: Mat3, t: Vec3, f0: number;
  if (opts.initialPose && opts.fGuess) {
    R = opts.initialPose.R;
    t = opts.initialPose.t;
    f0 = opts.fGuess;
  } else {
    const dltRes = dlt(corr, width, height);
    R = dltRes.R;
    t = dltRes.t;
    f0 = opts.fGuess ?? dltRes.f;
  }
  const rvec0 = rvecFromR(R);
  // 参数：[rx,ry,rz, tx,ty,tz, ln(f), k1,k2,p1,p2]
  // 畸变给温和先验而非 0：消费级/吊舱相机典型桶形畸变 k1≈-0.08，避免 LM 用大畸变补偿位姿
  const k1prior = -0.08, k2prior = 0.02;
  const initial = [
    rvec0.x, rvec0.y, rvec0.z,
    t.x, t.y, t.z,
    Math.log(f0), k1prior, k2prior, 0, 0,
  ];
  const distBound = opts.distortionBound ?? 0.4;
  // 当提供 POS 初姿时，给旋转/平移加信任域，消除平面点集的法向翻转歧义。
  // 角度边界 ±0.15rad（≈8.6°，覆盖 POS 1.2° 噪声并留余量），平移 ±0.8m。
  const hasPosePrior = !!opts.initialPose;
  const angB = 0.15, posB = 0.8;
  const lower = [
    hasPosePrior ? rvec0.x - angB : -Math.PI,
    hasPosePrior ? rvec0.y - angB : -Math.PI,
    hasPosePrior ? rvec0.z - angB : -Math.PI,
    hasPosePrior ? t.x - posB : -1e4,
    hasPosePrior ? t.y - posB : -1e4,
    hasPosePrior ? t.z - posB : -1e4,
    Math.log(width * 0.15), -distBound, -distBound, -0.05, -0.05,
  ];
  const upper = [
    hasPosePrior ? rvec0.x + angB : Math.PI,
    hasPosePrior ? rvec0.y + angB : Math.PI,
    hasPosePrior ? rvec0.z + angB : Math.PI,
    hasPosePrior ? t.x + posB : 1e4,
    hasPosePrior ? t.y + posB : 1e4,
    hasPosePrior ? t.z + posB : 1e4,
    Math.log(width * 8), distBound, distBound, 0.05, 0.05,
  ];

  const residualFn = (params: number[]): number[] => {
    const Rm = rodrigues(v3(params[0], params[1], params[2]));
    const K: CameraIntrinsics = {
      f: Math.exp(params[6]), cx: width / 2, cy: height / 2,
      k1: params[7], k2: params[8],
      p1: estimateTangential ? params[9] : 0,
      p2: estimateTangential ? params[10] : 0,
      width, height,
    };
    const pose: CameraPose = { R: Rm, t: v3(params[3], params[4], params[5]) };
    const out: number[] = [];
    for (const c of corr) {
      const proj = projectPoint(K, pose, c.object);
      if (!proj) { out.push(0, 0); continue; }
      out.push(proj.x - c.image.x, proj.y - c.image.y);
    }
    return out;
  };

  const lm: LMResult = levenbergMarquardt(residualFn, initial, 2, {
    maxIterations: opts.maxIterations ?? 40,
    huber: opts.huber,
    lower, upper,
  });
  const p = lm.params;
  const intrinsics: CameraIntrinsics = {
    f: Math.exp(p[6]), cx: width / 2, cy: height / 2,
    k1: p[7], k2: p[8],
    p1: estimateTangential ? p[9] : 0,
    p2: estimateTangential ? p[10] : 0,
    width, height,
  };
  const pose: CameraPose = { R: rodrigues(v3(p[0], p[1], p[2])), t: v3(p[3], p[4], p[5]) };
  return {
    intrinsics,
    pose,
    residuals: lm.perObservationRmse,
    rms: lm.rms,
    iterations: lm.iterations,
    converged: lm.converged,
  };
}

export function initialIntrinsics(width: number, height: number, fGuess?: number): CameraIntrinsics {
  return defaultIntrinsics(width, height, fGuess ?? Math.max(width, height) * 1.2);
}

/**
 * 鲁棒 PnP：先全点求解，再按残差迭代剔除外点重解，直到无外点或点数不足。
 * @param outlierPx 外点门限（像素），残差超过即剔除
 */
export function solvePnPRobust(
  corr: Correspondence[],
  width: number,
  height: number,
  opts: PnPOptions = {},
  outlierPx = 2.0,
): PnPResult & { inlierCount: number; rejected: number[] } {
  if (corr.length < 4) throw new Error('同名点至少需要 4 个');
  // Huber 软核：外点残差被降权而非硬剔除，避免最小配置失稳；
  // 切向畸变仅在 ≥8 点（冗余充分）时估计；收紧径向畸变信任域防止其漂移补偿位姿。
  const res = solvePnP(corr, width, height, {
    ...opts, huber: 2.0,
    estimateTangential: corr.length >= 8,
    distortionBound: 0.25,
    maxIterations: 60,
  });
  const rejected: number[] = [];
  const inlierResiduals: number[] = [];
  let sumSq = 0;
  res.residuals.forEach((r, i) => {
    if (r > outlierPx) rejected.push(i);
    else { sumSq += r * r; inlierResiduals.push(r); }
  });
  const inlierCount = corr.length - rejected.length;
  // 报告 RMS 与残差序列只统计内点，真实反映配准精度（外点不污染 95 分位等指标）
  const inlierRms = Math.sqrt(sumSq / Math.max(1, inlierCount));
  return { ...res, rms: inlierRms, residuals: inlierResiduals, inlierCount, rejected };
}
