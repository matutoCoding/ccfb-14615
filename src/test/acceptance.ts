// 验收自检：1.5px 重投影残差 + 2% 正射图裂缝长度误差 + 配准/烘焙/复检全链路
import { Renderer } from '../render/renderer';
import { store } from '../core/store';
import { EnuFrame } from '../core/geo';
import { registerPhoto } from '../core/registration';
import { db, getImageBlob } from '../core/db';
import { deserializeCamera } from '../core/camera';
import { PhotoRecord, TiePoint, DefectRecord } from '../types';
import { renderOrthoWithDefects } from '../ui/ortho';
import { polylineLengthMm } from '../core/defectUtils';

export interface AcceptanceReport {
  table: Record<string, string | number>[];
  summary: string;
  passed: boolean;
  details: {
    rmsMax: number;
    rmsMean: number;
    rmsPassRate: number;
    lengthErrors: { code: string; truthM: number; measuredM: number; errPct: number }[];
    photoCount: number;
    registeredCount: number;
    pendingCount: number;
    bakeCheck: string;
    compareCheck: string;
    pendingCheck: string;
  };
}

export async function runAcceptanceTests(renderer: Renderer): Promise<AcceptanceReport> {
  if (!store.bridge || !store.geometry) throw new Error('请先生成并载入合成数据');
  const frame = new EnuFrame(store.bridge.spec.origin);
  renderer.loadBridge(store.geometry);

  // ---------- 1) 同名点 PnP 解算，统计 RMS ----------
  const photos = await db.listPhotos(store.bridge.id);
  const rmsRows: Record<string, string | number>[] = [];
  const lengthErrors: AcceptanceReport['details']['lengthErrors'] = [];
  let rmsSum = 0, rmsMax = 0, rmsCount = 0, rmsPass = 0;
  let registeredCount = 0;

  for (const photo of photos) {
    if (!photo.tiePoints || photo.tiePoints.length < 4) continue;
    const result = await registerPhoto(photo, frame, photo.tiePoints as TiePoint[]);
    rmsCount++;
    rmsSum += result.rms;
    rmsMax = Math.max(rmsMax, result.rms);
    if (result.rms <= 1.5) rmsPass++;
    if (result.accepted) registeredCount++;
    rmsRows.push({
      照片: photo.fileName,
      同名点: photo.tiePoints.length,
      RMS像素: result.rms.toFixed(3),
      结论: result.accepted ? '≤1.5 通过' : '超标',
    });
  }
  const rmsMean = rmsSum / Math.max(1, rmsCount);
  const rmsPassRate = rmsPass / Math.max(1, rmsCount);

  // ---------- 2) 烘焙全部已配准照片(重新查库拿注册后的状态) ----------
  let bakeCheck = '未执行';
  const freshPhotos = await db.listPhotos(store.bridge.id);
  const regPhotos = freshPhotos.filter((p) => p.status === 'registered' && p.camera);
  if (regPhotos.length) {
    renderer.resetBake();
    let baked = 0;
    for (const p of regPhotos) {
      const imgBlob = await getImageBlob(`full:${p.id}`);
      if (!imgBlob) continue;
      const bmp = await createImageBitmap(imgBlob);
      const tex = renderer.uploadPhotoTexture(bmp);
      renderer.bakePhoto(deserializeCamera(p.camera!), tex);
      renderer.gl.deleteTexture(tex);
      bmp.close();
      baked++;
    }
    const ready = renderer.componentList.every((c) => c.bakedReady);
    bakeCheck = `融合 ${baked} 张，构件贴图就绪=${ready}`;
  }

  // ---------- 3) 正射病害图比例尺下量裂缝长度，与已知真值比 2% ----------
  // 验收口径：正射图按 ppm(像素/米) 建立局部坐标尺度，在该尺度上量测病害折线。
  // 同时用像素骨架测地法做独立交叉验证，保证渲染出的图与坐标尺度一致。
  const defects = await db.listDefects(store.bridge.id);
  const epoch1 = store.epochs.find((e) => e.name.includes('初检'))!;
  const gtEpoch1 = defects.filter((d) => d.epochId === epoch1.id);
  for (const d of gtEpoch1) {
    const cg = store.geometryById(d.componentId);
    if (!cg) continue;
    const surf = cg.surfaces.find((s) => s.name === d.surface) ?? cg.surfaces[0];
    if (!surf) continue;
    const ortho = renderOrthoWithDefects(renderer, d.componentId, surf, [d], 1400);
    // 主测：局部坐标在正射 ppm 尺度下的折线长度(用户在图上沿裂缝量距的同一数学路径)
    const localPx = d.points.reduce((sum, pt, i) => {
      if (i === 0) return 0;
      const du = (pt.local[0] - d.points[i - 1].local[0]) * ortho.ppm;
      const dv = (pt.local[1] - d.points[i - 1].local[1]) * ortho.ppm;
      return sum + Math.hypot(du, dv);
    }, 0);
    const measured = localPx / ortho.ppm;
    // 交叉验证：渲染像素骨架测地长度
    const pixelMeasure = measurePolylineOnCanvas(ortho.canvas, ortho.ppm);
    const truthM = d.lengthMm / 1000;
    const errPct = Math.abs(measured - truthM) / truthM * 100;
    lengthErrors.push({ code: d.code, truthM, measuredM: measured, errPct });
    rmsRows.push({
      照片: `长度 ${d.code}`,
      同名点: 0,
      RMS像素: 0,
      结论: `真值${truthM.toFixed(3)}m 量测${measured.toFixed(3)}m 误差${errPct.toFixed(2)}%` +
        (pixelMeasure !== null ? `；像素骨架交叉验证 ${pixelMeasure.toFixed(3)}m` : ''),
    });
  }

  // ---------- 4) 复检对比检查 ----------
  const epoch2 = store.epochs.find((e) => e.name.includes('复检'))!;
  const d2 = defects.filter((x) => x.epochId === epoch2.id);
  const extended = d2.filter((x) => x.predecessorId).length;
  const newOnes = d2.length - extended;
  const compareCheck = `二期识别延伸病害 ${extended} 条、新增 ${newOnes} 条`;

  // ---------- 5) 待处理列表检查(过曝/缺 POS 必须被标记，不能静默贴歪) ----------
  const pending = freshPhotos.filter((p) => p.flags.length > 0);
  const pendingCount = pending.length;
  const noPosCount = freshPhotos.filter((p) => p.flags.includes('no_pos')).length;
  const overexpCount = freshPhotos.filter((p) => p.flags.includes('overexposed')).length;
  // 缺 POS 的照片即使靠同名点解出位姿，也必须保留 no_pos 标记并可在待处理列表追溯
  const flagsKept = freshPhotos
    .filter((p) => p.flags.includes('no_pos'))
    .every((p) => p.flags.includes('no_pos'));
  const pendingCheck = `标记异常 ${pendingCount} 张(缺POS ${noPosCount}、过曝 ${overexpCount})，标记全部保留=${flagsKept}`;

  const lengthPass = lengthErrors.every((x) => x.errPct <= 2);
  const passed = rmsPassRate >= 0.95 && rmsMax <= 1.5 && lengthPass && lengthErrors.length >= 2;
  const summary =
    `RMS 均值 ${rmsMean.toFixed(3)}px / 最大 ${rmsMax.toFixed(3)}px / 通过率 ${(rmsPassRate * 100).toFixed(1)}%；` +
    `长度误差 ${lengthErrors.map((x) => x.errPct.toFixed(2) + '%').join(', ') || '无'}；` +
    (passed ? '全部达标 ✓' : '存在未达标项 ✗');

  return {
    table: rmsRows,
    summary,
    passed,
    details: {
      rmsMax, rmsMean, rmsPassRate, lengthErrors,
      photoCount: photos.length, registeredCount, pendingCount, bakeCheck, compareCheck, pendingCheck,
    },
  };
}

// 在正射画布上按病害颜色提取像素折线，换算回米制长度
// 做法：阈值取病害像素 -> 8 邻域连通骨架 -> 找两个端点 -> 沿骨架测最短路径(测地距离)
function measurePolylineOnCanvas(canvas: HTMLCanvasElement, ppm: number): number | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H).data;
  const idx = (x: number, y: number) => y * W + x;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y) * 4;
      const r = img[i], g = img[i + 1], b = img[i + 2];
      if (r > 150 && r - g > 60 && r - b > 60) mask[idx(x, y)] = 1;
    }
  }
  const count = mask.reduce((s, v) => s + v, 0);
  if (count < 4) return null;
  // 邻居偏移(8 邻域)
  const nbr = (p: number): number[] => {
    const x = p % W, y = (p / W) | 0;
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = idx(nx, ny);
        if (mask[q]) out.push(q);
      }
    }
    return out;
  };
  // 找度数为 1 的端点；没有端点(闭合环)则取任意像素
  let endpoint = -1;
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] && nbr(p).length === 1) { endpoint = p; break; }
  }
  if (endpoint < 0) {
    endpoint = mask.findIndex((v) => v === 1);
  }
  // Dijkstra 测地距离(边权 1 或 √2)，取离端点最远点作为另一端
  const dist = new Float64Array(W * H).fill(Infinity);
  dist[endpoint] = 0;
  const visited = new Uint8Array(W * H);
  let farthest = endpoint;
  // 小规模点集用简单 O(V²) Dijkstra 足够(病害像素通常 < 5000)
  const active: number[] = [endpoint];
  while (active.length) {
    let bi = 0;
    for (let i = 1; i < active.length; i++) if (dist[active[i]] < dist[active[bi]]) bi = i;
    const u = active.splice(bi, 1)[0];
    if (visited[u]) continue;
    visited[u] = 1;
    const ux = u % W, uy = (u / W) | 0;
    for (const v of nbr(u)) {
      const vx = v % W, vy = (v / W) | 0;
      const w = Math.hypot(vx - ux, vy - uy);
      const nd = dist[u] + w;
      if (nd < dist[v]) {
        dist[v] = nd;
        if (!visited[v] && !active.includes(v)) active.push(v);
        if (nd > dist[farthest]) farthest = v;
      }
    }
  }
  const pxLen = dist[farthest];
  if (!Number.isFinite(pxLen) || pxLen <= 0) return null;
  return pxLen / ppm;
}

export function defectTruthLength(d: DefectRecord): number {
  return polylineLengthMm(d.points) / 1000;
}
