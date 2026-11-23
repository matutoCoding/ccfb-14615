// SVD 与最小二乘：Jacobi 单边正交迭代，供 PnP/本质阵求解使用
import { Mat3, Vec3, m3fromCols, m3mul, m3transpose, v3cross, v3len, v3norm } from './math';

export interface SVD3 {
  U: Mat3;
  S: [number, number, number];
  Vt: Mat3;
}

// A = U S Vt，3x3 列主序；单边 Jacobi：右乘旋转 J 正交化 A 的列，A·V = U·Σ
export function svd3(A: Mat3): SVD3 {
  // 内部用行主序二维数组，索引直观，结束再转回列主序
  const M: number[][] = [
    [A[0], A[3], A[6]],
    [A[1], A[4], A[7]],
    [A[2], A[5], A[8]],
  ];
  const V: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  // M <- M J, V <- V J，J 只旋转 p,q 两列
  const rotateCols = (p: number, q: number, c: number, s: number): void => {
    for (let r = 0; r < 3; r++) {
      const mp = M[r][p], mq = M[r][q];
      M[r][p] = c * mp - s * mq;
      M[r][q] = s * mp + c * mq;
      const vp = V[r][p], vq = V[r][q];
      V[r][p] = c * vp - s * vq;
      V[r][q] = s * vp + c * vq;
    }
  };
  for (let iter = 0; iter < 80; iter++) {
    let off = 0;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        let app = 0, aqq = 0, apq = 0;
        for (let r = 0; r < 3; r++) {
          app += M[r][p] * M[r][p];
          aqq += M[r][q] * M[r][q];
          apq += M[r][p] * M[r][q];
        }
        off += apq * apq;
        if (Math.abs(apq) < 1e-18 * (1 + app + aqq)) continue;
        const tau = (aqq - app) / (2 * apq);
        const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        rotateCols(p, q, c, s);
      }
    if (off < 1e-28) break;
  }
  // M 的列已正交，列范数即奇异值，归一化得 U
  const cols: Vec3[] = [
    [M[0][0], M[1][0], M[2][0]],
    [M[0][1], M[1][1], M[2][1]],
    [M[0][2], M[1][2], M[2][2]],
  ];
  const sig = cols.map(v3len) as [number, number, number];
  const order = [0, 1, 2].sort((a, b) => sig[b] - sig[a]);
  const uCols: Vec3[] = [];
  const vCols: Vec3[] = [];
  const S: [number, number, number] = [0, 0, 0];
  order.forEach((src, dst) => {
    const l = sig[src] || 1;
    uCols.push([cols[src][0] / l, cols[src][1] / l, cols[src][2] / l]);
    vCols.push([V[0][src], V[1][src], V[2][src]]);
    S[dst] = sig[src];
  });
  const Uout = m3fromCols(uCols[0], uCols[1], uCols[2]);
  const Vout = m3fromCols(vCols[0], vCols[1], vCols[2]);
  return { U: Uout, S, Vt: m3transpose(Vout) };
}

// 带约束 det(R)=+1 的最近正交阵，用于把旋转估计投影到 SO(3)
export function closestRotation(R: Mat3): Mat3 {
  const { U, Vt } = svd3(R);
  let D = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const det = m3det(m3mul(U, Vt));
  if (det < 0) D[8] = -1;
  return m3mul(m3mul(U, D), Vt);
}

export function m3det(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[3] * (m[1] * m[8] - m[2] * m[7]) +
    m[6] * (m[1] * m[5] - m[2] * m[4])
  );
}

// 一般线性最小二乘 A x = b，m>=n；A 行主序(m x n)，返回 x
export function lstsq(A: number[][], b: number[]): number[] {
  const m = A.length, n = A[0].length;
  // 正规方程 AtA x = Atb，配合小条件数问题足够稳定
  const AtA = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const Atb = new Array<number>(n).fill(0);
  for (let i = 0; i < m; i++) {
    for (let p = 0; p < n; p++) {
      Atb[p] += A[i][p] * b[i];
      for (let q = 0; q < n; q++) AtA[p][q] += A[i][p] * A[i][q];
    }
  }
  return solveSym(AtA, Atb);
}

// 对称正定方程组 Cholesky 求解
export function solveSym(M: number[][], rhs: number[]): number[] {
  const n = M.length;
  const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = M[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-30)) : s / L[j][j];
    }
  }
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = rhs[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

// 线性方程组通用高斯消元(带部分主元)，用于 DLT 齐次解之外的小系统
export function gaussianElim(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-30;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-30));
}

// 对称矩阵 Jacobi 特征分解，返回升序特征值与对应列向量(vectors[r][c])
export function jacobiEigen(A: number[][]): { values: number[]; vectors: number[][] } {
  const n = A.length;
  const V = Array.from({ length: n }, (_, i) => {
    const row = new Array<number>(n).fill(0);
    row[i] = 1;
    return row;
  });
  const B = A.map((r) => [...r]);
  const D = new Array<number>(n).fill(0).map((_, i) => A[i][i]);
  for (let iter = 0; iter < 100; iter++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += B[p][q] ** 2;
    if (off < 1e-28) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(B[p][q]) < 1e-20) continue;
        const tau = (D[q] - D[p]) / (2 * B[p][q]);
        const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t), s = t * c;
        for (let r = 0; r < n; r++) {
          const vp = V[r][p], vq = V[r][q];
          V[r][p] = c * vp - s * vq;
          V[r][q] = s * vp + c * vq;
        }
        for (let r = 0; r < n; r++) {
          const bp = B[p][r], bq = B[q][r];
          B[p][r] = c * bp - s * bq;
          B[q][r] = s * bp + c * bq;
        }
        for (let r = 0; r < n; r++) {
          const bp = B[r][p], bq = B[r][q];
          B[r][p] = c * bp - s * bq;
          B[r][q] = s * bp + c * bq;
        }
        D[p] = B[p][p];
        D[q] = B[q][q];
      }
    }
  }
  const order = [...Array(n).keys()].sort((a, b) => D[a] - D[b]);
  return {
    values: order.map((i) => D[i]),
    vectors: order.map((i) => V.map((row) => row[i])),
  };
}

// 超定齐次系统 A h = 0 的最小奇异值右奇异向量(用 AtA 幂迭代+压缩)
export function nullVector(A: number[][]): number[] {
  const m = A.length, n = A[0].length;
  const AtA = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < m; i++)
    for (let p = 0; p < n; p++)
      for (let q = 0; q < n; q++) AtA[p][q] += A[i][p] * A[i][q];
  const { vectors } = jacobiEigen(AtA);
  const vec = [...vectors[0]];
  const norm = Math.hypot(...vec) || 1;
  return vec.map((v) => v / norm);
}

// 由两条三角形法线计算旋转的 Rodrigues 辅助
export function rodrigues(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = v3norm(axis);
  const c = Math.cos(angle), s = Math.sin(angle), C = 1 - c;
  return new Float32Array([
    c + x * x * C, x * y * C + z * s, x * z * C - y * s,
    x * y * C - z * s, c + y * y * C, y * z * C + x * s,
    x * z * C + y * s, y * z * C - x * s, c + z * z * C,
  ]);
}

export { v3cross };
