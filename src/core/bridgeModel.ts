// 参数化桥梁建模：简支T梁 / 简支小箱梁 / 连续箱梁。
// 世界坐标约定：X 沿桥跨方向（米），Y 横桥向，Z 竖直向上；桥轴线 Y=0。
import type { BridgeModel, BridgeSpec, ComponentDef, FiducialPoint, SurfaceDef } from './types';
import {
  MeshBuilder, localToWorld, makeCylindricalSurface, makePlanarSurface,
} from './geometry';
import { add, scl, type Vec3, v3 } from './mathTypes';

let seq = 0;
const cid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const totalLength = (spec: BridgeSpec) => spec.spanLengths.reduce((a, b) => a + b, 0);

function spanStartX(spec: BridgeSpec, spanNo1: number): number {
  let x = 0;
  for (let i = 0; i < spanNo1 - 1; i++) x += spec.spanLengths[i];
  return x;
}

/** 横桥向第 k 片梁（1 起）的中心 Y */
function girderY(spec: BridgeSpec, k1: number): number {
  const gap = spec.deckWidth / spec.girderCount;
  return -spec.deckWidth / 2 + gap * (k1 - 0.5);
}

// ---------- 小箱形主梁（每片 7 个表面） ----------

function buildBoxGirder(spec: BridgeSpec, spanNo: number, girderNo: number): ComponentDef {
  const L = spec.spanLengths[spanNo - 1];
  const x0 = spanStartX(spec, spanNo);
  const yc = girderY(spec, girderNo);
  const H = spec.girderHeight;
  const topW = spec.boxTopWidth;
  const botW = spec.boxBottomWidth;
  const flangeT = Math.min(0.18, H * 0.12); // 顶板厚
  const bottomT = Math.min(0.16, H * 0.1); // 底板厚
  const webH = H - flangeT - bottomT;
  const zTop = 0;
  const zFlangeBot = zTop - flangeT;
  const zBotTop = -H + bottomT;
  const zBot = -H;

  const surfaces: SurfaceDef[] = [];
  const mb = new MeshBuilder();
  const ex = v3(1, 0, 0);
  let si = 0;
  const add = (s: SurfaceDef, nu: number, nv: number) => {
    mb.addPlanarGrid(s, nu, nv, si++);
    surfaces.push(s);
  };

  // 顶板底面（箱室上壁，可见）
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-soffit-top`, '顶板底面',
    v3(x0, yc - botW / 2, zFlangeBot), ex, v3(0, 1, 0), L, botW, 0),
    Math.max(8, Math.round(L * 2)), 2);
  // 左腹板（Y- 侧），朝下偏外
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-web-l`, '左侧腹板',
    v3(x0, yc - topW / 2, zFlangeBot), ex, v3(0, (topW - botW) / 2, -webH), L,
    Math.hypot((topW - botW) / 2, webH), 0, v3(0, -1, 0)),
    Math.max(8, Math.round(L * 2)), 2);
  // 右腹板（Y+ 侧）
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-web-r`, '右侧腹板',
    v3(x0, yc + botW / 2, zBotTop), ex, v3(0, (topW - botW) / 2, webH), L,
    Math.hypot((topW - botW) / 2, webH), 0, v3(0, 1, 0)),
    Math.max(8, Math.round(L * 2)), 2);
  // 底板顶面（箱室内，默认不可见但保留）
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-slab-top`, '底板顶面',
    v3(x0, yc - botW / 2, zBotTop), ex, v3(0, 1, 0), L, botW, 0, v3(0, 0, 1)),
    Math.max(8, Math.round(L * 2)), 1);
  // 底板底面（外侧，无人机主要拍摄面）
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-bottom`, '底板底面',
    v3(x0, yc - botW / 2, zBot), ex, v3(0, 1, 0), L, botW, 0, v3(0, 0, -1)),
    Math.max(8, Math.round(L * 2)), 2);
  // 左翼缘悬臂底面
  const cantL = (topW - botW) / 2;
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-flange-l`, '左翼缘底面',
    v3(x0, yc - topW / 2, zFlangeBot), ex, v3(0, 1, 0), L, cantL, 0, v3(0, 0, -1)),
    Math.max(8, Math.round(L * 2)), 1);
  // 右翼缘悬臂底面
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-flange-r`, '右翼缘底面',
    v3(x0, yc + botW / 2, zFlangeBot), ex, v3(0, 1, 0), L, cantL, 0, v3(0, 0, -1)),
    Math.max(8, Math.round(L * 2)), 1);

  const mesh = mb.build();
  return {
    id: cid('girder'),
    code: `${spanNo}-${girderNo}#主梁`,
    category: 'main-girder',
    spanNo, girderNo, pierNo: 0,
    name: `第${spanNo}跨${girderNo}#小箱梁主梁`,
    origin: v3(x0, yc, 0),
    surfaces,
    ...mesh,
    bakeVersion: 0,
  };
}

// ---------- T 形主梁（翼缘底面×2、腹板×2、马蹄×2、翼缘端面） ----------

function buildTGirder(spec: BridgeSpec, spanNo: number, girderNo: number): ComponentDef {
  const L = spec.spanLengths[spanNo - 1];
  const x0 = spanStartX(spec, spanNo);
  const yc = girderY(spec, girderNo);
  const H = spec.girderHeight;
  const fw = spec.flangeWidth;
  const webT = spec.webThickness;
  const flangeT = Math.min(0.17, H * 0.12);
  const haunchH = Math.min(0.28, H * 0.18);
  const haunchW = webT * 2.2;
  const zFlangeBot = -flangeT;
  const zHaunchTop = -H + haunchH;

  const surfaces: SurfaceDef[] = [];
  const mb = new MeshBuilder();
  const ex = v3(1, 0, 0);
  let si = 0;
  const add = (s: SurfaceDef, nu: number, nv: number) => {
    mb.addPlanarGrid(s, nu, nv, si++);
    surfaces.push(s);
  };

  // 左翼缘底面
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-flange-l`, '左翼缘底面',
    v3(x0, yc - fw / 2, zFlangeBot), ex, v3(0, 1, 0), L, fw / 2 - webT / 2, 0, v3(0, 0, -1)),
    Math.max(8, Math.round(L * 2)), 1);
  // 右翼缘底面
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-flange-r`, '右翼缘底面',
    v3(x0, yc + webT / 2, zFlangeBot), ex, v3(0, 1, 0), L, fw / 2 - webT / 2, 0, v3(0, 0, -1)),
    Math.max(8, Math.round(L * 2)), 1);
  // 左腹板
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-web-l`, '左腹板',
    v3(x0, yc - webT / 2, zFlangeBot), ex, v3(0, 0, -1), L,
    zHaunchTop - zFlangeBot, 0, v3(0, -1, 0)),
    Math.max(8, Math.round(L * 2)), 2);
  // 右腹板
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-web-r`, '右腹板',
    v3(x0, yc + webT / 2, zHaunchTop), ex, v3(0, 0, 1), L,
    zHaunchTop - zFlangeBot, 0, v3(0, 1, 0)),
    Math.max(8, Math.round(L * 2)), 2);
  // 左马蹄斜面
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-haunch-l`, '左马蹄',
    v3(x0, yc - webT / 2, zHaunchTop), ex, v3(0, -(haunchW - webT) / 2, -haunchH), L,
    Math.hypot((haunchW - webT) / 2, haunchH), 0, v3(0, -1, 0)),
    Math.max(8, Math.round(L * 2)), 1);
  // 右马蹄斜面
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-haunch-r`, '右马蹄',
    v3(x0, yc + webT / 2, -H), ex, v3(0, (haunchW - webT) / 2, haunchH), L,
    Math.hypot((haunchW - webT) / 2, haunchH), 0, v3(0, 1, 0)),
    Math.max(8, Math.round(L * 2)), 1);
  // 马蹄底面
  add(makePlanarSurface(
    `s${spanNo}-g${girderNo}-haunch-bottom`, '马蹄底面',
    v3(x0, yc - haunchW / 2, -H), ex, v3(0, 1, 0), L, haunchW, 0, v3(0, 0, -1)),
    Math.max(8, Math.round(L * 2)), 1);

  const mesh = mb.build();
  return {
    id: cid('girder'),
    code: `${spanNo}-${girderNo}#T梁`,
    category: 'main-girder',
    spanNo, girderNo, pierNo: 0,
    name: `第${spanNo}跨${girderNo}#T梁主梁`,
    origin: v3(x0, yc, 0),
    surfaces,
    ...mesh,
    bakeVersion: 0,
  };
}

// ---------- 横隔板 ----------

function buildDiaphragm(spec: BridgeSpec, spanNo: number, index1: number, x: number, label: string): ComponentDef {
  const depth = spec.girderHeight * 0.85;
  const width = spec.deckWidth * 0.92;
  const thick = 0.18;
  const surfaces: SurfaceDef[] = [];
  const mb = new MeshBuilder();
  let si = 0;
  const add = (s: SurfaceDef, nu: number, nv: number) => {
    mb.addPlanarGrid(s, nu, nv, si++);
    surfaces.push(s);
  };
  // 横隔板沿 YZ 平面：两个大面（X±）+ 底面
  add(makePlanarSurface(
    `s${spanNo}-d${index1}-face-up`, '横隔板上游面',
    v3(x - thick / 2, -width / 2, -depth), v3(0, 1, 0), v3(0, 0, 1),
    width, depth, 0, v3(-1, 0, 0)),
    Math.max(6, Math.round(width * 2)), 3);
  add(makePlanarSurface(
    `s${spanNo}-d${index1}-face-dn`, '横隔板下游面',
    v3(x + thick / 2, width / 2, -depth), v3(0, -1, 0), v3(0, 0, 1),
    width, depth, 0, v3(1, 0, 0)),
    Math.max(6, Math.round(width * 2)), 3);
  add(makePlanarSurface(
    `s${spanNo}-d${index1}-bottom`, '横隔板底面',
    v3(x - thick / 2, -width / 2, -depth), v3(1, 0, 0), v3(0, 1, 0),
    thick, width, 0, v3(0, 0, -1)),
    1, Math.max(6, Math.round(width * 2)));
  const mesh = mb.build();
  return {
    id: cid('diaph'),
    code: `${spanNo}-${index1}#横隔板`,
    category: 'diaphragm',
    spanNo, girderNo: 0, pierNo: 0,
    name: `第${spanNo}跨${label}横隔板`,
    origin: v3(x, 0, 0),
    surfaces, ...mesh, bakeVersion: 0,
  };
}

// ---------- 盖梁 / 墩柱 / 支座 ----------

function buildBentCap(spec: BridgeSpec, pierNo1: number, x: number, colTopZ: number): ComponentDef {
  const capW = spec.capWidth;
  const capH = spec.capHeight;
  const capLen = spec.deckWidth + 0.6;
  const zc = colTopZ + capH / 2;
  const surfaces: SurfaceDef[] = [];
  const mb = new MeshBuilder();
  let si = 0;
  const add = (s: SurfaceDef, nu: number, nv: number) => {
    mb.addPlanarGrid(s, nu, nv, si++);
    surfaces.push(s);
  };
  const ey = v3(0, 1, 0);
  // 底面（无人机可见）、两个侧面、两个端面
  add(makePlanarSurface(
    `p${pierNo1}-cap-bottom`, '盖梁底面',
    v3(x - capW / 2, -capLen / 2, zc - capH / 2), v3(1, 0, 0), ey,
    capW, capLen, 0, v3(0, 0, -1)),
    1, Math.max(6, Math.round(capLen * 2)));
  add(makePlanarSurface(
    `p${pierNo1}-cap-side-l`, '盖梁上游侧面',
    v3(x - capW / 2, -capLen / 2, zc - capH / 2), v3(1, 0, 0), v3(0, 0, 1),
    capW, capH, 0, v3(0, -1, 0)),
    1, 2);
  add(makePlanarSurface(
    `p${pierNo1}-cap-side-r`, '盖梁下游侧面',
    v3(x + capW / 2, capLen / 2, zc - capH / 2), v3(-1, 0, 0), v3(0, 0, 1),
    capW, capH, 0, v3(0, 1, 0)),
    1, 2);
  add(makePlanarSurface(
    `p${pierNo1}-cap-end-a`, '盖梁A端面',
    v3(x, -capLen / 2, zc - capH / 2), v3(1, 0, 0), v3(0, 0, 1),
    capW, capH, 0, v3(0, -1, 0)),
    1, 2);
  add(makePlanarSurface(
    `p${pierNo1}-cap-end-b`, '盖梁B端面',
    v3(x, capLen / 2, zc - capH / 2), v3(-1, 0, 0), v3(0, 0, 1),
    capW, capH, 0, v3(0, 1, 0)),
    1, 2);

  const mesh = mb.build();
  return {
    id: cid('cap'),
    code: `${pierNo1}#盖梁`,
    category: 'bent-cap',
    spanNo: 0, girderNo: 0, pierNo: pierNo1,
    name: `${pierNo1}#墩盖梁`,
    origin: v3(x, 0, zc),
    surfaces, ...mesh, bakeVersion: 0,
  };
}

function buildPierColumn(spec: BridgeSpec, pierNo1: number, colNo1: number, x: number, y: number, height: number): ComponentDef {
  const r = spec.columnDiameter / 2;
  const zBase = -spec.girderHeight - spec.capHeight - height;
  const arc = Math.PI * 2 * r;
  const s = makeCylindricalSurface(
    `p${pierNo1}-c${colNo1}-shaft`, '墩柱柱身',
    v3(x, y, zBase), v3(0, 0, 1), v3(1, 0, 0),
    r, arc, height, 0);
  const mb = new MeshBuilder();
  mb.addCylinderGrid(s, 24, Math.max(4, Math.round(height * 2)), 0);
  const mesh = mb.build();
  return {
    id: cid('col'),
    code: `${pierNo1}-${colNo1}#墩柱`,
    category: 'pier-column',
    spanNo: 0, girderNo: 0, pierNo: pierNo1,
    name: `${pierNo1}#墩${colNo1}号柱`,
    origin: v3(x, y, zBase),
    surfaces: [s], ...mesh, bakeVersion: 0,
  };
}

function buildBearing(spec: BridgeSpec, pierNo1: number, girderNo1: number, x: number): ComponentDef {
  const size = 0.34;
  const h = 0.08;
  const z = -spec.girderHeight + h / 2;
  const yc = girderY(spec, girderNo1);
  const s = makePlanarSurface(
    `p${pierNo1}-b${girderNo1}-top`, '支座顶面',
    v3(x - size / 2, yc - size / 2, z), v3(1, 0, 0), v3(0, 1, 0),
    size, size, 0, v3(0, 0, -1));
  const mb = new MeshBuilder();
  mb.addPlanarGrid(s, 1, 1, 0);
  const mesh = mb.build();
  return {
    id: cid('brg'),
    code: `${pierNo1}-${girderNo1}#支座`,
    category: 'bearing',
    spanNo: 0, girderNo: girderNo1, pierNo: pierNo1,
    name: `${pierNo1}#墩${girderNo1}号支座`,
    origin: v3(x, yc, z),
    surfaces: [s], ...mesh, bakeVersion: 0,
  };
}

// ---------- 控制点：在构件表面规则布点（合成数据与人工同名点共用） ----------

function buildFiducials(components: ComponentDef[]): FiducialPoint[] {
  const pts: FiducialPoint[] = [];
  let id = 1;
  for (const comp of components) {
    if (comp.category !== 'main-girder' && comp.category !== 'bent-cap') continue;
    for (const s of comp.surfaces) {
      if (s.kind !== 'planar') continue;
      // 只在朝下/朝外的可见表面布置（无人机仰拍可达）：底面、翼缘底面、盖梁底面
      const isDownFacing = s.normal.z < -0.5;
      const isSideFacing = Math.abs(s.normal.y) > 0.7;
      if (!isDownFacing && !(comp.category === 'bent-cap' && isSideFacing)) continue;
      // 每张表面 6×3 规则布点，避开边缘 8%，保证单张仰拍照片可覆盖 ≥6 个
      const nx = 6, ny = 3;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const u = s.width * (0.1 + (0.8 * i) / (nx - 1));
          const v = s.height * (0.2 + (0.6 * j) / (ny - 1));
          const p = localToWorld(comp, s.id, u, v);
          pts.push({ id: id++, position: p, surfaceId: s.id, u, v });
        }
      }
    }
  }
  return pts;
}

// ---------- 主入口 ----------

export function buildBridge(spec: BridgeSpec): BridgeModel {
  const components: ComponentDef[] = [];
  const isT = spec.type === 'simply-supported-t';

  // 主梁
  for (let span = 1; span <= spec.spanCount; span++) {
    for (let g = 1; g <= spec.girderCount; g++) {
      components.push(isT ? buildTGirder(spec, span, g) : buildBoxGirder(spec, span, g));
    }
  }

  // 横隔板：每跨端隔板 2 道 + 中间 diaphragmCount 道
  for (let span = 1; span <= spec.spanCount; span++) {
    const x0 = spanStartX(spec, span);
    const L = spec.spanLengths[span - 1];
    const total = spec.diaphragmCount + 2;
    for (let k = 1; k <= total; k++) {
      const x = x0 + (L * (k - 1)) / (total - 1);
      components.push(buildDiaphragm(spec, span, k, x, k === 1 || k === total ? '端' : '中'));
    }
  }

  // 下部结构：spanCount-1 个中间墩（0 号台、n 号台略去柱，仅作 POS 参考）
  let cumX = 0;
  const pierXs: number[] = [];
  for (let i = 0; i < spec.spanCount - 1; i++) {
    cumX += spec.spanLengths[i];
    pierXs.push(cumX);
  }
  pierXs.forEach((x, idx) => {
    const pierNo = idx + 1;
    const ph = spec.pierHeight[idx] ?? spec.pierHeight[0] ?? 4;
    components.push(buildBentCap(spec, pierNo, x, -spec.girderHeight - 0.08 - ph + spec.capHeight));
    const colYs: number[] = [];
    const n = spec.pierColumns;
    for (let k = 1; k <= n; k++) colYs.push(-spec.deckWidth / 2 + (spec.deckWidth * (k - 0.5)) / n);
    colYs.forEach((y, k) => components.push(buildPierColumn(spec, pierNo, k + 1, x, y, ph)));
    for (let g = 1; g <= spec.girderCount; g++) components.push(buildBearing(spec, pierNo, g, x));
  });

  const fiducials = buildFiducials(components);
  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  for (const c of components) {
    for (let i = 0; i < c.positions.length; i += 3) {
      const p = c.positions.subarray(i, i + 3);
      min.x = Math.min(min.x, p[0]); max.x = Math.max(max.x, p[0]);
      min.y = Math.min(min.y, p[1]); max.y = Math.max(max.y, p[1]);
      min.z = Math.min(min.z, p[2]); max.z = Math.max(max.z, p[2]);
    }
  }
  return { spec, components, fiducials, bounds: { min, max } };
}

export function getComponent(model: BridgeModel, id: string): ComponentDef | undefined {
  return model.components.find((c) => c.id === id);
}

export function findComponentByCode(model: BridgeModel, code: string): ComponentDef | undefined {
  return model.components.find((c) => c.code === code);
}

export { spanStartX, girderY, totalLength };
export { add };
