// 相机模型：针孔 + 径向畸变(k1,k2) + 切向畸变(p1,p2)。
// 坐标系：Xc = R·Xw + t，相机看向 -Z，像平面在 Z=-f 处，x 向右、y 向下。
import type { Mat3, Vec2, Vec3 } from './mathTypes';
import { m3mulv, sub } from './mathTypes';

export interface CameraIntrinsics {
  /** 焦距（像素），正方形像素 */
  f: number;
  /** 主点（像素） */
  cx: number;
  cy: number;
  /** 径向畸变 */
  k1: number;
  k2: number;
  /** 切向畸变（通常接近 0，保留以便完整解算） */
  p1: number;
  p2: number;
  width: number;
  height: number;
}

export interface CameraPose {
  /** 世界->相机旋转 */
  R: Mat3;
  /** 世界->相机平移，Xc = R·Xw + t；相机光心 C = -Rᵀt */
  t: Vec3;
}

export function defaultIntrinsics(width: number, height: number, f: number): CameraIntrinsics {
  return { f, cx: width / 2, cy: height / 2, k1: 0, k2: 0, p1: 0, p2: 0, width, height };
}

/** 归一化坐标（含畸变）-> 像素 */
export function distortAndPixel(K: CameraIntrinsics, xn: number, yn: number): Vec2 {
  const r2 = xn * xn + yn * yn;
  const r4 = r2 * r2;
  const radial = 1 + K.k1 * r2 + K.k2 * r4;
  const xd = xn * radial + 2 * K.p1 * xn * yn + K.p2 * (r2 + 2 * xn * xn);
  const yd = yn * radial + K.p1 * (r2 + 2 * yn * yn) + 2 * K.p2 * xn * yn;
  return { x: K.f * xd + K.cx, y: K.f * yd + K.cy };
}

/** 世界点 -> 像素。返回 null 表示点在相机后方 */
export function projectPoint(K: CameraIntrinsics, pose: CameraPose, P: Vec3): Vec2 | null {
  const X = m3mulv(pose.R, P);
  const zc = X.z + pose.t.z;
  if (zc >= -1e-9) return null;
  const xc = X.x + pose.t.x;
  const yc = X.y + pose.t.y;
  return distortAndPixel(K, xc / -zc, yc / -zc);
}

/** 迭代去畸变（归一化坐标） */
export function undistortNormalized(K: CameraIntrinsics, xd: number, yd: number): Vec2 {
  let x = xd, y = yd;
  for (let i = 0; i < 12; i++) {
    const r2 = x * x + y * y;
    const radial = 1 + K.k1 * r2 + K.k2 * r2 * r2;
    const tx = 2 * K.p1 * x * y + K.p2 * (r2 + 2 * x * x);
    const ty = K.p1 * (r2 + 2 * y * y) + 2 * K.p2 * x * y;
    x = (xd - tx) / radial;
    y = (yd - ty) / radial;
  }
  return { x, y };
}

/** 像素 -> 归一化坐标（去畸变） */
export function pixelToNormalized(K: CameraIntrinsics, px: number, py: number): Vec2 {
  const xd = (px - K.cx) / K.f;
  const yd = (py - K.cy) / K.f;
  return undistortNormalized(K, xd, yd);
}

export function cameraCenter(pose: CameraPose): Vec3 {
  // C = -Rᵀt
  const R = pose.R;
  const t = pose.t;
  return {
    x: -(R[0] * t.x + R[1] * t.y + R[2] * t.z),
    y: -(R[3] * t.x + R[4] * t.y + R[5] * t.z),
    z: -(R[6] * t.x + R[7] * t.y + R[8] * t.z),
  };
}

export function worldToCamera(pose: CameraPose, P: Vec3): Vec3 {
  const X = m3mulv(pose.R, P);
  return { x: X.x + pose.t.x, y: X.y + pose.t.y, z: X.z + pose.t.z };
}

/** 从归一化射线方向（相机系，指向场景）得到像素 */
export function rayDirToPixel(K: CameraIntrinsics, dirCam: Vec3): Vec2 | null {
  if (dirCam.z >= -1e-9) return null;
  return distortAndPixel(K, dirCam.x / -dirCam.z, dirCam.y / -dirCam.z);
}

export function distanceToCamera(pose: CameraPose, P: Vec3): number {
  const c = cameraCenter(pose);
  return Math.hypot(P.x - c.x, P.y - c.y, P.z - c.z);
}

/** 生成透视投影矩阵（WebGL 用，不含畸变；畸变在屏幕空间后处理） */
export function projectionGL(K: CameraIntrinsics, near = 0.05, far = 200): Float32Array {
  const f = K.f, w = K.width, h = K.height;
  // 自定义 NDC：x∈[-1,1], y∈[-1,1]，z 朝向 -Z
  const A = (2 * f) / w;
  const B = (2 * f) / h;
  const ox = (w - 2 * K.cx) / w;
  const oy = (h - 2 * K.cy) / h;
  return Float32Array.from([
    A, 0, 0, 0,
    0, B, 0, 0,
    ox, oy, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
}

/** 世界->相机视图矩阵（列主序）：Xc = R·Xw + t，与 viewGL 约定一致 */
export function viewGL(pose: CameraPose): Float32Array {
  const R = pose.R, t = pose.t;
  // 列主序：前三列是 R 的三列，第四列（索引 12/13/14）是平移 t
  return Float32Array.from([
    R[0], R[1], R[2], 0,
    R[3], R[4], R[5], 0,
    R[6], R[7], R[8], 0,
    t.x, t.y, t.z, 1,
  ]);
}

export { sub };
