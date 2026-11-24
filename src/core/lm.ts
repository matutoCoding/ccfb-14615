// 通用 Levenberg–Marquardt 非线性最小二乘（数值雅可比）。
// 残差函数返回每对观测的残差向量（例如每个同名点的 dx、dy 两个残差）。

export interface LMResult {
  params: number[];
  /** 每条观测一个 RMSE（残差向量自己的范数均值开方，单位由调用方解释，通常是像素） */
  perObservationRmse: number[];
  rms: number;
  iterations: number;
  converged: boolean;
}

export interface LMOptions {
  maxIterations?: number;
  /** 初始阻尼 */
  lambdaInit?: number;
  /** 每个参数的数值差分步长（相对+绝对） */
  epsRel?: number;
  epsAbs?: number;
  /** Huber 核阈值（残差单位），undefined 表示不用鲁棒核 */
  huber?: number;
  /** 参数下限/上限（可含 ±Infinity） */
  lower?: number[];
  upper?: number[];
  onIteration?: (info: { iter: number; rms: number; lambda: number }) => void;
}

function clampParams(p: number[], lower?: number[], upper?: number[]): number[] {
  if (!lower && !upper) return p;
  return p.map((v, i) => {
    if (lower && Number.isFinite(lower[i]) && v < lower[i]) return lower[i];
    if (upper && Number.isFinite(upper[i]) && v > upper[i]) return upper[i];
    return v;
  });
}

/**
 * @param residuals 给定参数，返回扁平残差数组 [r0a,r0b, r1a,r1b, ...]
 * @param residualSize 每条观测的残差分量数（一般为 2）
 */
export function levenbergMarquardt(
  residuals: (params: number[]) => number[],
  initial: number[],
  residualSize: number,
  opts: LMOptions = {},
): LMResult {
  const maxIter = opts.maxIterations ?? 30;
  const epsRel = opts.epsRel ?? 1e-7;
  const epsAbs = opts.epsAbs ?? 1e-6;
  let lambda = opts.lambdaInit ?? 1e-2;
  let params = clampParams(initial.slice(), opts.lower, opts.upper);

  const huberWeights = (r: number[]): number[] => {
    if (opts.huber === undefined) return r.map(() => 1);
    const k = opts.huber;
    return r.map((ri) => (Math.abs(ri) <= k ? 1 : k / Math.abs(ri)));
  };

  const cost = (r: number[], w: number[]): number => {
    let s = 0;
    for (let i = 0; i < r.length; i++) s += w[i] * r[i] * r[i];
    return s;
  };

  let r = residuals(params);
  let w = huberWeights(r);
  let curCost = cost(r, w);
  let iter = 0;
  let converged = false;

  for (; iter < maxIter; iter++) {
    const n = params.length;
    // 数值雅可比
    const J: number[][] = r.map(() => new Array<number>(n).fill(0));
    for (let j = 0; j < n; j++) {
      const step = epsAbs + epsRel * Math.abs(params[j]);
      const p2 = params.slice();
      p2[j] += step;
      const r2 = residuals(clampParams(p2, opts.lower, opts.upper));
      for (let i = 0; i < r.length; i++) J[i][j] = (r2[i] - r[i]) / step;
    }
    // JtWJ 与 JtWr（加权）
    const H = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const g = new Array<number>(n).fill(0);
    for (let i = 0; i < r.length; i++) {
      const wi = w[i];
      for (let a = 0; a < n; a++) {
        g[a] -= J[i][a] * wi * r[i];
        for (let b = 0; b < n; b++) H[a][b] += J[i][a] * wi * J[i][b];
      }
    }
    const diag = H.map((row, i) => row[i]);
    let accepted = false;
    for (let inner = 0; inner < 12 && !accepted; inner++) {
      const A = H.map((row, i) => row.map((v, j) => (i === j ? v + lambda * diag[i] : v)));
      const delta = solveLinear(A, g);
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const cand = clampParams(params.map((v, i) => v + delta[i]), opts.lower, opts.upper);
      const rc = residuals(cand);
      const wc = huberWeights(rc);
      const cc = cost(rc, wc);
      if (cc < curCost) {
        const rel = (curCost - cc) / Math.max(curCost, 1e-12);
        // 参数步长（归一化），用于判断是否停滞
        const stepNorm = Math.sqrt(delta.reduce((a, d) => a + d * d, 0) / Math.max(1, delta.length));
        params = cand;
        r = rc;
        w = wc;
        curCost = cc;
        lambda = Math.max(lambda * 0.3, 1e-12);
        accepted = true;
        // 成本相对下降极小 且 参数步长很小，才判收敛（避免首步误判）
        if (iter > 1 && rel < 1e-7 && stepNorm < 1e-7) converged = true;
      } else {
        lambda *= 10;
      }
    }
    opts.onIteration?.({ iter, rms: Math.sqrt(curCost / r.length), lambda });
    if (converged || !accepted) break;
  }

  const perObs: number[] = [];
  let total = 0;
  for (let i = 0; i < r.length; i += residualSize) {
    let s = 0;
    for (let k = 0; k < residualSize; k++) s += r[i + k] ** 2;
    const rmse = Math.sqrt(s / residualSize);
    perObs.push(rmse);
    total += s;
  }
  return {
    params,
    perObservationRmse: perObs,
    rms: Math.sqrt(total / r.length),
    iterations: iter + 1,
    converged,
  };
}

/** 高斯消元解 Ax=b（A 会被修改） */
function solveLinear(AIn: number[][], bIn: number[]): number[] | null {
  const n = bIn.length;
  const A = AIn.map((row) => row.slice());
  const b = bIn.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let i = col + 1; i < n; i++) if (Math.abs(A[i][col]) > Math.abs(A[piv][col])) piv = i;
    if (Math.abs(A[piv][col]) < 1e-14) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    for (let i = 0; i < n; i++) {
      if (i === col) continue;
      const f = A[i][col] / A[col][col];
      for (let j = col; j < n; j++) A[i][j] -= f * A[col][j];
      b[i] -= f * b[col];
    }
  }
  return b.map((bi, i) => bi / A[i][i]);
}
