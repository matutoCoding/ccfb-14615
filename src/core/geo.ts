// 大地坐标（经纬度+椭球高）与桥轴局部 ENU 坐标互换；POS 云台角 -> 相机位姿初值。
import type { CameraPose } from './camera';
import { m3fromRows, type Mat3, type Vec3, v3, deg2rad, m3mul } from './mathTypes';

// WGS84
const A = 6378137.0;
const E2 = 0.00669437999014;

export function lonLatToECEF(lon: number, lat: number, h: number): Vec3 {
  const lam = deg2rad(lon), phi = deg2rad(lat);
  const sinP = Math.sin(phi), cosP = Math.cos(phi);
  const N = A / Math.sqrt(1 - E2 * sinP * sinP);
  return v3(
    (N + h) * cosP * Math.cos(lam),
    (N + h) * cosP * Math.sin(lam),
    (N * (1 - E2) + h) * sinP,
  );
}

/** 以桥址原点为基准的局部坐标（东、北、天，米） */
export function geoToLocal(lon: number, lat: number, h: number, refLon: number, refLat: number, refH = 0): Vec3 {
  const p = lonLatToECEF(lon, lat, h);
  const r = lonLatToECEF(refLon, refLat, refH);
  const lam = deg2rad(refLon), phi = deg2rad(refLat);
  const sinL = Math.sin(lam), cosL = Math.cos(lam);
  const sinP = Math.sin(phi), cosP = Math.cos(phi);
  const dx = p.x - r.x, dy = p.y - r.y, dz = p.z - r.z;
  // ENU 旋转
  return v3(
    -sinL * dx + cosL * dy,
    -sinP * cosL * dx - sinP * sinL * dy + cosP * dz,
    cosP * cosL * dx + cosP * sinL * dy + sinP * dz,
  );
}

export function localToGeo(e: number, n: number, u: number, refLon: number, refLat: number, refH = 0): { lon: number; lat: number; h: number } {
  const r = lonLatToECEF(refLon, refLat, refH);
  const lam = deg2rad(refLon), phi = deg2rad(refLat);
  const sinL = Math.sin(lam), cosL = Math.cos(lam);
  const sinP = Math.sin(phi), cosP = Math.cos(phi);
  // ENU 基向量（ECEF 表达）
  const eE = v3(-sinL, cosL, 0);
  const eN = v3(-sinP * cosL, -sinP * sinL, cosP);
  const eU = v3(cosP * cosL, cosP * sinL, sinP);
  const p = v3(
    r.x + e * eE.x + n * eN.x + u * eU.x,
    r.y + e * eE.y + n * eN.y + u * eU.y,
    r.z + e * eE.z + n * eN.z + u * eU.z,
  );
  // ECEF -> 经纬高
  const lon = Math.atan2(p.y, p.x);
  const p2 = Math.hypot(p.x, p.y);
  let lat = Math.atan2(p.z, p2 * (1 - E2));
  let h = 0;
  for (let i = 0; i < 8; i++) {
    const sinP = Math.sin(lat);
    const N = A / Math.sqrt(1 - E2 * sinP * sinP);
    h = p2 / Math.cos(lat) - N;
    lat = Math.atan2(p.z, p2 * (1 - (E2 * N) / (N + h)));
  }
  return { lon: (lon * 180) / Math.PI, lat: (lat * 180) / Math.PI, h };
}

/**
 * 云台角 -> 世界->相机旋转。
 * 约定：yaw=0 相机朝东(X+)，pitch=0 水平，pitch=-90 垂直向下；roll 绕视线滚转。
 * 桥轴 X=东、Y=北、Z=天。
 */
export function gimbalToRotation(yawDeg: number, pitchDeg: number, rollDeg: number): Mat3 {
  const yaw = deg2rad(yawDeg), pitch = deg2rad(pitchDeg), roll = deg2rad(rollDeg);
  // 无人机云台约定：yaw 北=0/东=90（顺时针），pitch 水平=0、垂直向下=-90，roll 绕视线。
  // 视线（世界系）：(cos p·cos y, cos p·sin y, -sin p)
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const forward = v3(cp * Math.cos(yaw), cp * Math.sin(yaw), -sp);
  // 水平右方向（roll=0 时的像平面 x 轴）
  const right0 = v3(-Math.sin(yaw), Math.cos(yaw), 0);
  // 应用 roll（绕视线旋转）：right = cosR·right0 + sinR·(forward × right0)
  const fCrossR = v3(
    forward.y * right0.z - forward.z * right0.y,
    forward.z * right0.x - forward.x * right0.z,
    forward.x * right0.y - forward.y * right0.x,
  );
  const cosR = Math.cos(roll), sinR = Math.sin(roll);
  const camX = v3(
    cosR * right0.x + sinR * fCrossR.x,
    cosR * right0.y + sinR * fCrossR.y,
    cosR * right0.z + sinR * fCrossR.z,
  );
  // 相机系：x 向右、y 向下、z 向后（视线 = -z），右手系 y = z × x
  const camZ = v3(-forward.x, -forward.y, -forward.z);
  const camY = v3(
    camZ.y * camX.z - camZ.z * camX.y,
    camZ.z * camX.x - camZ.x * camX.z,
    camZ.x * camX.y - camZ.y * camX.x,
  );
  return m3fromRows(camX, camY, camZ);
}

export function poseFromPOS(pos: { x: number; y: number; z: number }, yaw: number, pitch: number, roll: number): CameraPose {
  const R = gimbalToRotation(yaw, pitch, roll);
  // t = -R·C
  const t = v3(
    -(R[0] * pos.x + R[1] * pos.y + R[2] * pos.z),
    -(R[3] * pos.x + R[4] * pos.y + R[5] * pos.z),
    -(R[6] * pos.x + R[7] * pos.y + R[8] * pos.z),
  );
  return { R, t };
}

/** 桥轴局部坐标约定 X=桥跨、Y=横桥向；ENU 与桥轴重合建模（建模时直接用 ENU 系），此函数保留做航向偏置 */
export function rotateToBridgeAxis(p: Vec3, axisYawDeg: number): Vec3 {
  if (Math.abs(axisYawDeg) < 1e-9) return p;
  const a = -deg2rad(axisYawDeg);
  const c = Math.cos(a), s = Math.sin(a);
  return v3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

export { m3mul };
