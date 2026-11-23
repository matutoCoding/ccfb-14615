// WGS84 大地坐标 <-> 局部 ENU，椭球参数取标准值
import { LonLatHeight } from '../types';
import { Vec3, rad } from './math';

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

export function geoToEcef(g: LonLatHeight): Vec3 {
  const lam = rad(g.lon), phi = rad(g.lat);
  const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
  const N = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  return [
    (N + g.height) * cosPhi * Math.cos(lam),
    (N + g.height) * cosPhi * Math.sin(lam),
    (N * (1 - E2) + g.height) * sinPhi,
  ];
}

export function ecefToGeo(p: Vec3): LonLatHeight {
  const [x, y, z] = p;
  const lon = Math.atan2(y, x);
  const p2 = Math.hypot(x, y);
  let phi = Math.atan2(z, p2 * (1 - E2));
  let h = 0;
  for (let i = 0; i < 8; i++) {
    const sinPhi = Math.sin(phi);
    const N = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
    h = p2 / Math.cos(phi) - N;
    phi = Math.atan2(z, p2 * (1 - (E2 * N) / (N + h)));
  }
  return { lon: (lon * 180) / Math.PI, lat: (phi * 180) / Math.PI, height: h };
}

// 以 origin 为切点的 ENU 局部坐标系(米)
export class EnuFrame {
  private lam0: number;
  private phi0: number;
  private ecef0: Vec3;
  private R: number[][]; // ENU <- ECEF

  constructor(origin: LonLatHeight) {
    this.lam0 = rad(origin.lon);
    this.phi0 = rad(origin.lat);
    this.ecef0 = geoToEcef(origin);
    const sl = Math.sin(this.lam0), cl = Math.cos(this.lam0);
    const sp = Math.sin(this.phi0), cp = Math.cos(this.phi0);
    this.R = [
      [-sl, cl, 0],
      [-sp * cl, -sp * sl, cp],
      [cp * cl, cp * sl, sp],
    ];
  }

  toLocal(g: LonLatHeight): Vec3 {
    const e = geoToEcef(g);
    const d: Vec3 = [e[0] - this.ecef0[0], e[1] - this.ecef0[1], e[2] - this.ecef0[2]];
    return [
      this.R[0][0] * d[0] + this.R[0][1] * d[1] + this.R[0][2] * d[2],
      this.R[1][0] * d[0] + this.R[1][1] * d[1] + this.R[1][2] * d[2],
      this.R[2][0] * d[0] + this.R[2][1] * d[1] + this.R[2][2] * d[2],
    ];
  }

  toGeo(p: Vec3): LonLatHeight {
    const dEcef = [0, 0, 0].map((_, i) =>
      this.R[0][i] * p[0] + this.R[1][i] * p[1] + this.R[2][i] * p[2]
    );
    return ecefToGeo([
      this.ecef0[0] + dEcef[0],
      this.ecef0[1] + dEcef[1],
      this.ecef0[2] + dEcef[2],
    ]);
  }
}
