// 参数化桥梁几何：网格 + 构件展开面(局部二维坐标，米) + 自动编号
import { BridgeSpec, ComponentRecord, PartKind } from '../types';
import { Vec3, v3add, v3cross, v3lerp, v3norm } from './math';

export interface MeshData {
  positions: Float32Array; // xyz
  normals: Float32Array;
  uvs: Float32Array; // 构件局部展开坐标(米)
  indices: Uint32Array;
}

export interface SurfaceDef {
  name: string;
  label: string;
  // 局部 (u,v) 米 -> 世界坐标；u 沿桥纵向/构件长方向，v 沿展开面
  toWorld: (u: number, v: number) => Vec3;
  normal: Vec3; // 面外法线(世界)
  uRange: [number, number];
  vRange: [number, number];
  // 世界点是否落在该表面(容差米)
  contains: (p: Vec3, tol?: number) => boolean;
}

export interface ComponentGeometry {
  component: ComponentRecord;
  mesh: MeshData;
  surfaces: SurfaceDef[];
  color: [number, number, number];
  bbox: { min: Vec3; max: Vec3 };
}

export interface BridgeGeometry {
  components: ComponentGeometry[];
  spanBoundaries: number[]; // 每跨起止 x
  girderYs: number[]; // 每片梁的横向中心 y
  deckTop: number;
  girderBottom: number;
  length: number;
}

const PART_COLOR: Record<PartKind, [number, number, number]> = {
  main_girder: [0.62, 0.66, 0.72],
  diaphragm: [0.55, 0.6, 0.66],
  cap_beam: [0.72, 0.6, 0.5],
  pier_column: [0.68, 0.66, 0.6],
  bearing: [0.25, 0.25, 0.28],
  abutment: [0.7, 0.68, 0.62],
  deck: [0.5, 0.52, 0.55],
};

const PART_LABEL: Record<PartKind, string> = {
  main_girder: '主梁',
  diaphragm: '横隔板',
  cap_beam: '盖梁',
  pier_column: '墩柱',
  bearing: '支座',
  abutment: '桥台',
  deck: '桥面板',
};

export function partLabel(p: PartKind): string {
  return PART_LABEL[p];
}

// ---------- 基础网格工具 ----------
function emptyMesh(): MeshData {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    indices: new Uint32Array(0),
  };
}

function mergeMeshes(meshes: MeshData[]): MeshData {
  const out = emptyMesh();
  let vCount = 0, iCount = 0;
  for (const m of meshes) {
    vCount += m.positions.length / 3;
    iCount += m.indices.length;
  }
  out.positions = new Float32Array(vCount * 3);
  out.normals = new Float32Array(vCount * 3);
  out.uvs = new Float32Array(vCount * 2);
  out.indices = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const m of meshes) {
    out.positions.set(m.positions, vo * 3);
    out.normals.set(m.normals, vo * 3);
    out.uvs.set(m.uvs, vo * 2);
    for (let i = 0; i < m.indices.length; i++) out.indices[io + i] = m.indices[i] + vo;
    vo += m.positions.length / 3;
    io += m.indices.length;
  }
  return out;
}

interface Quad {
  p0: Vec3; p1: Vec3; p2: Vec3; p3: Vec3;
  n: Vec3;
  uv: ((p: Vec3) => [number, number]) | null;
}

function quadMesh(q: Quad): MeshData {
  const pos = [...q.p0, ...q.p1, ...q.p2, ...q.p3];
  const nor = [...q.n, ...q.n, ...q.n, ...q.n];
  let uv: number[];
  if (q.uv) {
    uv = [...q.uv(q.p0), ...q.uv(q.p1), ...q.uv(q.p2), ...q.uv(q.p3)];
  } else {
    uv = [0, 0, 1, 0, 1, 1, 0, 1];
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    uvs: new Float32Array(uv),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

// 轴对齐长方体，center+size；uvFn 给顶点赋局部展开坐标
function boxMesh(
  center: Vec3,
  size: Vec3,
  uvFn: (face: string, p: Vec3) => [number, number]
): MeshData {
  const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
  const [cx, cy, cz] = center;
  const p = (dx: number, dy: number, dz: number): Vec3 => [cx + dx * hx, cy + dy * hy, cz + dz * hz];
  const quads: { q: Quad; face: string }[] = [
    { q: { p0: p(-1, -1, 1), p1: p(1, -1, 1), p2: p(1, 1, 1), p3: p(-1, 1, 1), n: [0, 0, 1], uv: null }, face: 'top' },
    { q: { p0: p(-1, 1, -1), p1: p(1, 1, -1), p2: p(1, -1, -1), p3: p(-1, -1, -1), n: [0, 0, -1], uv: null }, face: 'bottom' },
    { q: { p0: p(-1, -1, -1), p1: p(-1, -1, 1), p2: p(1, -1, 1), p3: p(1, -1, -1), n: [0, -1, 0], uv: null }, face: 'sideNegY' },
    { q: { p0: p(1, 1, -1), p1: p(1, 1, 1), p2: p(-1, 1, 1), p3: p(-1, 1, -1), n: [0, 1, 0], uv: null }, face: 'sidePosY' },
    { q: { p0: p(1, -1, -1), p1: p(1, -1, 1), p2: p(1, 1, 1), p3: p(1, 1, -1), n: [1, 0, 0], uv: null }, face: 'endPosX' },
    { q: { p0: p(-1, 1, -1), p1: p(-1, 1, 1), p2: p(-1, -1, 1), p3: p(-1, -1, -1), n: [-1, 0, 0], uv: null }, face: 'endNegX' },
  ];
  return mergeMeshes(
    quads.map(({ q, face }) => {
      q.uv = (pt) => uvFn(face, pt);
      return quadMesh(q);
    })
  );
}

// 沿 x 拉伸截面环(y,z 顶点，首尾不闭合)生成棱柱
function ringExtrude(
  x0: number,
  x1: number,
  ring: [number, number][],
  uvFn: (ringIdx: number, p: Vec3) => [number, number]
): MeshData {
  const m = ring.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let xi = 0; xi < 2; xi++) {
    const x = xi === 0 ? x0 : x1;
    for (let j = 0; j < m; j++) {
      positions.push(x, ring[j][0], ring[j][1]);
      uvs.push(...uvFn(j, [x, ring[j][0], ring[j][1]]));
      normals.push(0, 0, 0);
    }
  }
  for (let j = 0; j < m; j++) {
    const j2 = (j + 1) % m;
    const a = ring[j], b = ring[j2];
    const dy = b[0] - a[0], dz = b[1] - a[1];
    const n: Vec3 = [0, dz, -dy];
    const nl = Math.hypot(n[1], n[2]) || 1;
    n[1] /= nl; n[2] /= nl;
    indices.push(j, j2, m + j2, j, m + j2, m + j);
    for (const vi of [j, j2, m + j, m + j2]) {
      normals[vi * 3] += n[0];
      normals[vi * 3 + 1] += n[1];
      normals[vi * 3 + 2] += n[2];
    }
  }
  // 两端封口(扇形三角)
  const addCap = (base: number, sign: number) => {
    const cy = ring.reduce((s, r) => s + r[0], 0) / m;
    const cz = ring.reduce((s, r) => s + r[1], 0) / m;
    const ci = positions.length / 3;
    positions.push(base === 0 ? x0 : x1, cy, cz);
    normals.push(sign, 0, 0);
    uvs.push(0, 0);
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      if (sign > 0) indices.push(ci, base + j, base + j2);
      else indices.push(ci, base + j2, base + j);
    }
  };
  addCap(0, -1);
  addCap(m, 1);
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

function bboxOf(mesh: MeshData): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], mesh.positions[i + k]);
      max[k] = Math.max(max[k], mesh.positions[i + k]);
    }
  }
  return { min, max };
}

// ---------- 表面定义工具 ----------
function planarSurface(
  name: string, label: string,
  origin: Vec3, uAxisIn: Vec3, vAxisIn: Vec3,
  uMax: number, vMax: number, normalHint?: Vec3
): SurfaceDef {
  // 归一化正交基：局部 (u,v) 直接是米制坐标；法线由轴叉乘得到，避免手算符号错误
  const uAxis = v3norm(uAxisIn);
  const vAxis = v3norm(vAxisIn);
  let nrm = v3norm(v3cross(uAxis, vAxis));
  if (normalHint && nrm[0] * normalHint[0] + nrm[1] * normalHint[1] + nrm[2] * normalHint[2] < 0) {
    nrm = [-nrm[0], -nrm[1], -nrm[2]];
  }
  return {
    name, label, normal: nrm,
    uRange: [0, uMax], vRange: [0, vMax],
    toWorld: (u, v) => [
      origin[0] + uAxis[0] * u + vAxis[0] * v,
      origin[1] + uAxis[1] * u + vAxis[1] * v,
      origin[2] + uAxis[2] * u + vAxis[2] * v,
    ],
    contains: (p, tol = 0.03) => {
      const d: Vec3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
      if (Math.abs(d[0] * nrm[0] + d[1] * nrm[1] + d[2] * nrm[2]) > tol) return false;
      const u = d[0] * uAxis[0] + d[1] * uAxis[1] + d[2] * uAxis[2];
      const v = d[0] * vAxis[0] + d[1] * vAxis[1] + d[2] * vAxis[2];
      return u >= -tol && u <= uMax + tol && v >= -tol && v <= vMax + tol;
    },
  };
}

// ---------- 主梁：小箱梁/连续箱梁(梯形箱)，T 梁(T 形) ----------
interface GirderDims {
  width: number;
  height: number;
  topFlange: number;
  bottomFlange: number;
  webThick: number;
  flangeThick: number;
}

function girderDims(spec: BridgeSpec): GirderDims {
  const spacing = spec.bridgeWidth / spec.girderCount;
  if (spec.type === 'T_GIRDER') {
    return {
      width: spacing * 0.98, height: 1.6, topFlange: spacing * 0.98,
      bottomFlange: 0.42, webThick: 0.22, flangeThick: 0.18,
    };
  }
  if (spec.type === 'BOX_CONT') {
    return {
      width: spacing * 0.92, height: 1.8, topFlange: spacing * 0.92,
      bottomFlange: spacing * 0.5, webThick: 0.28, flangeThick: 0.25,
    };
  }
  return {
    width: spacing * 0.92, height: 1.4, topFlange: spacing * 0.92,
    bottomFlange: spacing * 0.55, webThick: 0.24, flangeThick: 0.2,
  };
}

function buildMainGirder(
  spec: BridgeSpec, comp: ComponentRecord, x0: number, x1: number, yc: number, zBottom: number
): ComponentGeometry {
  const d = girderDims(spec);
  const h = d.height, w = d.width;
  let mesh: MeshData;
  const surfaces: SurfaceDef[] = [];
  const L = x1 - x0;

  if (spec.type === 'T_GIRDER') {
    // T 梁：翼缘板 + 腹板(带马蹄加宽)
    const flange = boxMesh(
      [(x0 + x1) / 2, yc, zBottom + h - d.flangeThick / 2],
      [L, d.topFlange, d.flangeThick],
      (face, p) => tBeamUV(face, p, x0, x1, yc, d, zBottom)
    );
    const webH = h - d.flangeThick;
    const web = boxMesh(
      [(x0 + x1) / 2, yc, zBottom + webH / 2],
      [L, d.webThick, webH],
      (face, p) => tBeamUV(face, p, x0, x1, yc, d, zBottom)
    );
    const hoof = boxMesh(
      [(x0 + x1) / 2, yc, zBottom + 0.18],
      [L, d.bottomFlange, 0.36],
      (face, p) => tBeamUV(face, p, x0, x1, yc, d, zBottom)
    );
    mesh = mergeMeshes([flange, web, hoof]);
    // 展开面：左/右腹板、翼缘底面、马蹄
    surfaces.push(
      planarSurface('webNegY', '腹板(左侧)', [x0, yc - d.webThick / 2, zBottom], [1, 0, 0], [0, 0, 1], L, webH, [0, -1, 0]),
      planarSurface('webPosY', '腹板(右侧)', [x0, yc + d.webThick / 2, zBottom], [1, 0, 0], [0, 0, 1], L, webH, [0, 1, 0]),
      planarSurface('flangeBottom', '翼缘底面', [x0, yc - d.topFlange / 2, zBottom + h - d.flangeThick], [1, 0, 0], [0, 1, 0], L, d.topFlange, [0, 0, -1]),
      planarSurface('hoofBottom', '马蹄底面', [x0, yc - d.bottomFlange / 2, zBottom], [1, 0, 0], [0, 1, 0], L, d.bottomFlange, [0, 0, -1])
    );
  } else {
    // 箱梁：梯形截面环(顶宽 topFlange，底宽 bottomFlange)
    const yTop = d.topFlange / 2, yBot = d.bottomFlange / 2;
    const ring: [number, number][] = [
      [yc - yTop, zBottom + h],
      [yc + yTop, zBottom + h],
      [yc + yBot, zBottom],
      [yc - yBot, zBottom],
    ];
    mesh = ringExtrude(x0, x1, ring, (j, p) => boxGirderUV(j, p, x0, ring));
    const webAngle = Math.atan2((yTop - yBot), h);
    const nyNeg = -Math.cos(webAngle), nzNeg = Math.sin(webAngle);
    surfaces.push(
      planarSurface('webNegY', '腹板(左侧)', [x0, yc - yBot, zBottom], [1, 0, 0], [0, -(yTop - yBot), h], L, Math.hypot(yTop - yBot, h), [0, nyNeg, nzNeg]),
      planarSurface('webPosY', '腹板(右侧)', [x0, yc + yBot, zBottom], [1, 0, 0], [0, yTop - yBot, h], L, Math.hypot(yTop - yBot, h), [0, -nyNeg, nzNeg]),
      planarSurface('bottom', '箱底(翼缘底面)', [x0, yc - yBot, zBottom], [1, 0, 0], [0, 1, 0], L, 2 * yBot, [0, 0, -1]),
      planarSurface('top', '顶板底面', [x0, yc - yTop, zBottom + h], [1, 0, 0], [0, 1, 0], L, 2 * yTop, [0, 0, -1])
    );
  }
  return { component: comp, mesh, surfaces, color: PART_COLOR.main_girder, bbox: bboxOf(mesh) };
}

function tBeamUV(face: string, p: Vec3, x0: number, x1: number, yc: number, d: GirderDims, zBottom: number): [number, number] {
  const u = p[0] - x0;
  switch (face) {
    case 'sideNegY':
    case 'sidePosY':
      return [u, p[2] - zBottom];
    case 'bottom':
      return [u, p[1] - yc + d.bottomFlange / 2];
    case 'top':
      return [u, p[1] - yc + d.topFlange / 2];
    default:
      return [u, 0];
  }
}

function boxGirderUV(j: number, p: Vec3, x0: number, ring: [number, number][]): [number, number] {
  const u = p[0] - x0;
  // 沿环周长累计 v
  let v = 0;
  for (let k = 0; k < j; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length];
    v += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return [u, v];
}

// ---------- 桥梁总装 ----------
export function buildBridge(spec: BridgeSpec, bridgeId: string): BridgeGeometry {
  const comps: ComponentGeometry[] = [];
  const spanBoundaries: number[] = [];
  let x = 0;
  const boundaries: [number, number][] = [];
  for (let s = 0; s < spec.spanCount; s++) {
    const L = spec.spanLengths[s];
    boundaries.push([x, x + L]);
    spanBoundaries.push(x, x + L);
    x += L;
  }
  const total = x;
  const width = spec.bridgeWidth;
  const girderYs = Array.from({ length: spec.girderCount }, (_, i) => -width / 2 + width * (i + 0.5) / spec.girderCount);
  const girderBottom = 0;
  const girderH = girderDims(spec).height;
  const deckTop = girderH + 0.28;
  let seq = 0;
  const mk = (part: PartKind, spanNo: number, girderNo: number, pierNo: number): ComponentRecord => {
    seq += 1;
    const code = makeCode(part, spanNo, girderNo, pierNo, seq);
    return {
      id: `${bridgeId}-C${seq}`, bridgeId, code,
      label: `${PART_LABEL[part]} ${code}`, part, spanNo, girderNo, pierNo, indexNo: seq,
    };
  };

  // 主梁
  for (let s = 1; s <= spec.spanCount; s++) {
    const [xa, xb] = boundaries[s - 1];
    for (let g = 1; g <= spec.girderCount; g++) {
      const comp = mk('main_girder', s, g, 0);
      comps.push(buildMainGirder(spec, comp, xa, xb, girderYs[g - 1], girderBottom));
    }
  }

  // 横隔板：每跨 3 道(支点、跨中、支点)
  for (let s = 1; s <= spec.spanCount; s++) {
    const [xa, xb] = boundaries[s - 1];
    const stations = [xa + 0.25, (xa + xb) / 2, xb - 0.25];
    stations.forEach((sx, k) => {
      const comp = mk('diaphragm', s, 0, 0);
      const size: Vec3 = [0.22, width * 0.96, girderH * 0.7];
      const mesh = boxMesh([sx, 0, girderH * 0.55], size, (face, p) => [
        p[1] + width / 2, p[2] - girderBottom,
      ]);
      comps.push({
        component: comp, mesh, color: PART_COLOR.diaphragm, bbox: bboxOf(mesh),
        surfaces: [
          planarSurface('faceNegX', '横隔板端面', [sx - 0.11, -width * 0.48, girderH * 0.2], [0, 1, 0], [0, 0, 1], width * 0.96, size[2], [-1, 0, 0]),
        ],
      });
    });
  }

  // 支座：每片梁端
  for (let s = 1; s <= spec.spanCount; s++) {
    const [xa, xb] = boundaries[s - 1];
    for (const sx of [xa + 0.12, xb - 0.12]) {
      for (let g = 1; g <= spec.girderCount; g++) {
        const comp = mk('bearing', s, g, 0);
        const size: Vec3 = [0.3, 0.3, spec.bearingGap];
        const mesh = boxMesh([sx, girderYs[g - 1], -spec.bearingGap / 2], size, () => [0, 0]);
        comps.push({ component: comp, mesh, color: PART_COLOR.bearing, bbox: bboxOf(mesh), surfaces: [] });
      }
    }
  }

  // 盖梁 + 墩柱(中间支点)
  const capH = 1.1, capW = 1.3;
  for (let pier = 1; pier < spec.spanCount; pier++) {
    const sx = boundaries[pier - 1][1];
    const capComp = mk('cap_beam', 0, 0, pier);
    const capCenter: Vec3 = [sx, 0, -spec.bearingGap - capH / 2];
    const capMesh = boxMesh(capCenter, [1.4, width + 1.0, capH], (face, p) => [
      p[1] + width / 2 + 0.5, p[2] - capCenter[2] + capH / 2,
    ]);
    comps.push({
      component: capComp, mesh: capMesh, color: PART_COLOR.cap_beam, bbox: bboxOf(capMesh),
      surfaces: [
        planarSurface('sideNegY', '盖梁背面(−Y)', [sx - 0.7, -width / 2 - 0.5, capCenter[2] - capH / 2], [1, 0, 0], [0, 0, 1], 1.4, capH, [0, -1, 0]),
        planarSurface('sidePosY', '盖梁正面(+Y)', [sx - 0.7, width / 2 + 0.5, capCenter[2] - capH / 2], [1, 0, 0], [0, 0, 1], 1.4, capH, [0, 1, 0]),
        planarSurface('bottom', '盖梁底面', [sx - 0.7, -width / 2 - 0.5, capCenter[2] - capH / 2], [1, 0, 0], [0, 1, 0], 1.4, width + 1.0, [0, 0, -1]),
      ],
    });
    const capBottom = capCenter[2] - capH / 2;
    const colTop = capBottom;
    const colBottom = -spec.pierHeight;
    const colH = colTop - colBottom;
    const colYs = spec.columnCount === 1 ? [0] : Array.from({ length: spec.columnCount }, (_, i) =>
      -width * 0.38 + (width * 0.76 * i) / (spec.columnCount - 1));
    for (let c = 1; c <= spec.columnCount; c++) {
      const colComp = mk('pier_column', 0, 0, pier);
      const r = 0.6;
      const mesh = cylinderMesh([sx, colYs[c - 1], (colTop + colBottom) / 2], r, colH, 16);
      comps.push({
        component: colComp, mesh, color: PART_COLOR.pier_column, bbox: bboxOf(mesh),
        surfaces: [cylinderSurface('side', '柱身', [sx, colYs[c - 1]], colBottom, colTop, r)],
      });
    }
  }

  // 桥台(两端)
  for (let ai = 0; ai < 2; ai++) {
    const sx = ai === 0 ? 0 : total;
    const comp = mk('abutment', 0, 0, ai === 0 ? 0 : spec.spanCount);
    const mesh = boxMesh([sx, 0, -spec.pierHeight / 2 - 0.5], [1.6, width + 1.2, spec.pierHeight + 1], (face, p) => [
      p[1] + width / 2, p[2] + spec.pierHeight / 2 + 0.5,
    ]);
    comps.push({
      component: comp, mesh, color: PART_COLOR.abutment, bbox: bboxOf(mesh),
      surfaces: [
        planarSurface('face', '台身正面', [sx - 0.8, -width / 2 - 0.6, -spec.pierHeight - 0.5], [0, 1, 0], [0, 0, 1], width + 1.2, spec.pierHeight + 1, [ai === 0 ? -1 : 1, 0, 0]),
      ],
    });
  }

  // 桥面板
  const deckComp: ComponentRecord = {
    id: `${bridgeId}-C0`, bridgeId, code: 'DECK', label: '桥面板 DECK',
    part: 'deck', spanNo: 0, girderNo: 0, pierNo: 0, indexNo: 0,
  };
  const deckMesh = boxMesh([total / 2, 0, girderH + 0.14], [total, width + 0.6, 0.28], (face, p) => [
    p[0], p[1] + width / 2,
  ]);
  comps.unshift({
    component: deckComp, mesh: deckMesh, color: PART_COLOR.deck, bbox: bboxOf(deckMesh),
    surfaces: [planarSurface('bottom', '桥面板底面', [0, -width / 2 - 0.3, girderH], [1, 0, 0], [0, 1, 0], total, width + 0.6, [0, 0, -1])],
  });

  return { components: comps, spanBoundaries, girderYs, deckTop, girderBottom, length: total };
}

function makeCode(part: PartKind, spanNo: number, girderNo: number, pierNo: number, seq: number): string {
  switch (part) {
    case 'main_girder': return `S${spanNo}-#${girderNo}`;
    case 'diaphragm': return `S${spanNo}-H${seq}`;
    case 'bearing': return `S${spanNo}-#${girderNo}-Z`;
    case 'cap_beam': return `P${pierNo}-GL`;
    case 'pier_column': return `P${pierNo}-Z${girderNo || pierNo}`;
    case 'abutment': return pierNo === 0 ? 'A0-T' : `A${spanNo || pierNo}-T`;
    default: return `X${seq}`;
  }
}

// 圆柱网格(轴沿 z)
function cylinderMesh(center: Vec3, r: number, h: number, seg: number): MeshData {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const [cx, cy, cz] = center;
  const z0 = cz - h / 2, z1 = cz + h / 2;
  for (let j = 0; j <= seg; j++) {
    const a = (2 * Math.PI * j) / seg;
    const ny = Math.cos(a), nxz = Math.sin(a);
    positions.push(cx + r * nxz, cy + r * ny, z0, cx + r * nxz, cy + r * ny, z1);
    normals.push(nxz, ny, 0, nxz, ny, 0);
    uvs.push((2 * Math.PI * r * j) / seg, 0, (2 * Math.PI * r * j) / seg, h);
  }
  for (let j = 0; j < seg; j++) {
    const b = j * 2;
    indices.push(b, b + 1, b + 3, b, b + 3, b + 2);
  }
  return {
    positions: new Float32Array(positions), normals: new Float32Array(normals),
    uvs: new Float32Array(uvs), indices: new Uint32Array(indices),
  };
}

function cylinderSurface(name: string, label: string, centerXY: [number, number], z0: number, z1: number, r: number): SurfaceDef {
  return {
    name, label, normal: [0, 0, 1],
    uRange: [0, 2 * Math.PI * r], vRange: [z0, z1],
    toWorld: (u, v) => {
      const a = u / r;
      return [centerXY[0] + r * Math.sin(a), centerXY[1] + r * Math.cos(a), v];
    },
    contains: (p, tol = 0.03) => {
      const d = Math.hypot(p[0] - centerXY[0], p[1] - centerXY[1]);
      return Math.abs(d - r) <= tol && p[2] >= z0 - tol && p[2] <= z1 + tol;
    },
  };
}

// 世界点 -> 构件表面局部坐标；返回 null 表示不在任何表面上
export function pointToSurface(geo: ComponentGeometry, p: Vec3, tol = 0.03): { surface: SurfaceDef; local: [number, number] } | null {
  for (const s of geo.surfaces) {
    if (!s.contains(p, tol)) continue;
    const o = s.toWorld(s.uRange[0], s.vRange[0]);
    const eu = s.toWorld(s.uRange[0] + 1, s.vRange[0]);
    const ev = s.toWorld(s.uRange[0], s.vRange[0] + 1);
    const uAxis: Vec3 = [eu[0] - o[0], eu[1] - o[1], eu[2] - o[2]];
    const vAxis: Vec3 = [ev[0] - o[0], ev[1] - o[1], ev[2] - o[2]];
    const d: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const u = d[0] * uAxis[0] + d[1] * uAxis[1] + d[2] * uAxis[2];
    const v = d[0] * vAxis[0] + d[1] * vAxis[1] + d[2] * vAxis[2];
    return { surface: s, local: [u, v] };
  }
  return null;
}

export function v3LerpPts(a: Vec3, b: Vec3, t: number): Vec3 {
  return v3lerp(a, b, t);
}
export { v3add };
