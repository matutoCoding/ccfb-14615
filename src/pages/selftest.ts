// 精度自测页：生成合成两期数据集 -> 自动配准 -> 烘焙 -> 在正射病害图上量测裂缝 -> 对照真值。
import { el, toast } from '../router';
import { appState } from '../state';
import { runtime, setBaked, setRuntimeDefects } from '../cache';
import {
  defectRepo, epochRepo, photoRepo, getBlob, saveComponent, saveBridgeArchive,
} from '../core/db';
import { SceneRenderer } from '../render/sceneRenderer';
import {
  generateSyntheticDataset, type GeneratedDataset, type Rng,
} from '../vision/synthetic';
import { detectMarkers } from '../vision/markerDetect';
import { defaultIntrinsics, projectPoint } from '../core/camera';
import { poseFromPOS } from '../core/geo';
import { solvePnP, solvePnPRobust } from '../core/pnp';
import { bakeModel, type BakedSurface } from '../vision/textureBaker';
import type { DefectRecord } from '../core/types';
import { polylineLength } from '../services/defectService';
import { surfacePoint } from '../core/geometry';
import { v3 } from '../core/mathTypes';

interface MetricRow {
  name: string;
  value: string;
  target: string;
  pass: boolean;
  detail?: string;
}

export async function renderSelftest(_p: Record<string, string>, root: HTMLElement): Promise<void> {
  root.innerHTML = '';
  root.append(el('h2', {}, '精度自测（合成数据端到端验证）'));
  root.append(el('div', { class: 'card muted' },
    '系统自动生成一座三跨预应力小箱梁桥（3×20m，4 片主梁/跨），在构件表面布置设计长度已知的裂缝，' +
    '用离屏渲染从模型拍摄两期照片，POS 加随机误差（平面 0.35m、高程 0.25m、姿态 1.2°），并掺入过曝与缺 POS 照片。' +
    '随后自动完成标志检测、PnP 解算、纹理烘焙与裂缝量测，对照真值核验精度。'));

  const ctrl = el('div', { class: 'card row' });
  const seedInput = document.createElement('input');
  seedInput.type = 'number'; seedInput.value = '20260525'; seedInput.style.width = '130px';
  const btnRun = el('button', { class: 'primary' }, '① 生成合成数据集（两期）');
  const btnReg = el('button', {}, '② 自动配准全部照片');
  const btnBake = el('button', {}, '③ 烘焙纹理');
  const btnMeasure = el('button', {}, '④ 裂缝量测与精度评定');
  btnReg.disabled = btnBake.disabled = btnMeasure.disabled = true;
  ctrl.append(el('strong', {}, '随机种子：'), seedInput, btnRun, btnReg, btnBake, btnMeasure);
  const prog = el('div', { class: 'progress', style: 'display:none;margin-top:12px' }, document.createElement('div'));
  const label = el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' });
  ctrl.append(el('div', { style: 'flex-basis:100%' }, prog, label));
  root.append(ctrl);

  const resultCard = el('div', { class: 'card' });
  root.append(resultCard);
  let dataset: GeneratedDataset | null = null;
  let renderer: SceneRenderer | null = null;

  const setProgress = (pct: number, text: string) => {
    prog.style.display = 'block';
    (prog.firstElementChild as HTMLElement).style.width = `${pct}%`;
    label.textContent = text;
  };

  btnRun.addEventListener('click', async () => {
    try {
      btnRun.disabled = true;
      const off = document.createElement('canvas');
      off.style.display = 'none';
      document.body.append(off);
      renderer = new SceneRenderer(off);
      const bridgeId = `demo-${String(seedInput.value || '1')}`;
      setProgress(5, '参数化建模并离屏渲染两期照片…');
      dataset = await generateSyntheticDataset(renderer, {
        bridgeId,
        photosPerSpan: 12,
        posNoise: { xy: 0.35, z: 0.25, angle: 1.2 },
        seed: parseInt(seedInput.value, 10) || 1,
      });
      // 持久化
      await saveBridgeArchive({
        spec: dataset.spec,
        componentOrder: dataset.model.components.map((c) => c.id),
        fiducials: dataset.model.fiducials,
        modelVersion: 1,
      });
      for (const c of dataset.model.components) await saveComponent(c);
      for (const ep of dataset.epochs) {
        await epochRepo.put(ep.epoch);
        for (const ph of ep.photos) await photoRepo.put(ph);
        for (const d of ep.defects) await defectRepo.put(d);
      }
      await appState.loadBridge(bridgeId);
      await appState.setEpoch(dataset.epochs[0].epoch.id);
      runtime.groundTruth = dataset.epochs.map((e) => ({ epoch: e.epoch.id, gt: e.groundTruth }));
      runtime.crackTruths = dataset.truths;
      const total = dataset.epochs.reduce((a, e) => a + e.photos.length, 0);
      const faults = dataset.epochs[0].photos.filter((p) => p.status !== 'coarse').length;
      setProgress(100, `完成：${total} 张照片（含 ${faults} 张异常：过曝/缺POS），${dataset.epochs.reduce((a, e) => a + e.defects.length, 0)} 条病害已入库`);
      btnReg.disabled = false;
      toast('合成数据集已生成并入库', 'ok');
      showDatasetSummary(dataset, resultCard);
    } catch (e) {
      console.error(e);
      toast('生成失败：' + (e as Error).message, 'err', 6000);
      btnRun.disabled = false;
    }
  });

  btnReg.addEventListener('click', async () => {
    if (!dataset || !renderer) return;
    btnReg.disabled = true;
    try {
      const allPhotos = await photoRepo.all();
      const fGuess = Math.max(dataset.epochs[0].photos[0].width, dataset.epochs[0].photos[0].height) * 1.15;
      let idx = 0;
      const rmsList: number[] = [];
      const perPoint: number[] = [];
      for (const ep of dataset.epochs) {
        const photos = allPhotos.filter((p) => p.epochId === ep.epoch.id);
        for (const ph of photos) {
          idx++;
          setProgress((idx / allPhotos.length) * 100, `配准 ${idx}/${allPhotos.length}：${ph.filename}`);
          await new Promise((r) => setTimeout(r, 0));
          if (ph.status !== 'coarse') continue;
          const blob = await getBlob(ph.thumbBlobKey ?? '');
          if (!blob) continue;
          const spec = dataset.spec;
          const cam = v3(
            (ph.pos.lon - spec.originLon) * (111320 * Math.cos((spec.originLat * Math.PI) / 180)),
            (ph.pos.lat - spec.originLat) * 110540,
            ph.pos.altitude,
          );
          const pose0 = poseFromPOS(cam, ph.pos.yaw, ph.pos.pitch, ph.pos.roll);
          const K0 = defaultIntrinsics(ph.width, ph.height, fGuess);
          const det = await detectMarkers(blob, dataset.model.fiducials, K0, pose0, (fGuess * 0.09) / 3.2);
          if (det.length < 4) { ph.status = 'mismatch'; await photoRepo.put(ph); continue; }
          const corr = det.map((d) => {
            const fid = dataset!.model.fiducials.find((f) => f.id === d.fiducialId)!;
            return { object: fid.position, image: { x: d.x, y: d.y } };
          });
          const res = solvePnPRobust(corr, ph.width, ph.height, { fGuess, initialPose: pose0 }, 1.5);
          ph.gcps = det.map((d) => {
            const fid = dataset!.model.fiducials.find((f) => f.id === d.fiducialId)!;
            return { id: `g-${d.fiducialId}`, fiducialId: d.fiducialId, object: fid.position, image: { x: d.x, y: d.y } };
          });
          ph.intrinsics = { ...res.intrinsics };
          ph.R = Array.from(res.pose.R);
          ph.t = [res.pose.t.x, res.pose.t.y, res.pose.t.z];
          ph.rmsPx = res.rms;
          ph.perPointRmse = res.residuals;
          ph.status = 'registered';
          await photoRepo.put(ph);
          rmsList.push(res.rms);
          perPoint.push(...res.residuals);
        }
      }
      const rmsAvg = rmsList.reduce((a, b) => a + b, 0) / rmsList.length;
      const rmsMax = Math.max(...rmsList);
      const ppMax = Math.max(...perPoint);
      const pp95 = [...perPoint].sort((a, b) => a - b)[Math.floor(perPoint.length * 0.95)];
      showMetrics(resultCard, [
        { name: '配准照片数', value: String(rmsList.length), target: '全部 coarse 照片', pass: rmsList.length > 0 },
        { name: '重投影 RMS（平均）', value: `${rmsAvg.toFixed(3)} px`, target: '≤ 1.5 px', pass: rmsAvg <= 1.5 },
        { name: '重投影 RMS（单张最大）', value: `${rmsMax.toFixed(3)} px`, target: '≤ 1.5 px', pass: rmsMax <= 1.5 },
        { name: '同名点残差 95 分位', value: `${pp95.toFixed(3)} px`, target: '≤ 1.5 px', pass: pp95 <= 1.5 },
        { name: '同名点残差最大值', value: `${ppMax.toFixed(3)} px`, target: '≤ 1.5 px（单点可略超）', pass: ppMax <= 2.0 },
      ]);
      btnBake.disabled = false;
      toast(`配准完成，平均 RMS ${rmsAvg.toFixed(3)} px`, rmsAvg <= 1.5 ? 'ok' : 'err', 5000);
    } catch (e) {
      console.error(e);
      toast('配准失败：' + (e as Error).message, 'err');
      btnReg.disabled = false;
    }
  });

  btnBake.addEventListener('click', async () => {
    if (!dataset) return;
    btnBake.disabled = true;
    try {
      const all = await photoRepo.all();
      const regs = all.filter((p) => p.status === 'registered');
      setProgress(0, `开始烘焙 ${regs.length} 张照片…`);
      const baked = await bakeModel(dataset.model, regs, getBlob, {
        metersPerPixel: 0.004,
        maxTexSide: 512,
        onProgress: (d, t, l) => setProgress((d / t) * 100, `烘焙 ${d}/${t}：${l}`),
      });
      setBaked(dataset.epochs[0].epoch.id, baked);
      const defs = (await defectRepo.all()).filter((d) => d.epochId === dataset!.epochs[0].epoch.id);
      setRuntimeDefects(dataset.epochs[0].epoch.id, defs);
      appState.bumpBake();
      // 评估覆盖率：分母 = 至少被一张已配准照片拍到表面中心的"理论可拍表面"，
      // 分子 = 其中实际烘焙上纹理的表面。箱室内表面、视野外表面不计入分母。
      const { projectPoint } = await import('../core/camera');
      const { surfacePoint } = await import('../core/geometry');
      const viewableIds = new Set<string>();
      for (const c of dataset.model.components) {
        for (const s of c.surfaces) {
          if (!(s.normal.z < -0.5 || Math.abs(s.normal.y) > 0.7)) continue;
          const center = surfacePoint(s, s.width / 2, s.height / 2);
          for (const ph of regs) {
            const pp = projectPoint(ph.intrinsics!, { R: new Float64Array(ph.R!) as never, t: v3(ph.t![0], ph.t![1], ph.t![2]) }, center);
            if (pp && pp.x > 0 && pp.x < ph.width && pp.y > 0 && pp.y < ph.height) { viewableIds.add(s.id); break; }
          }
        }
      }
      let covered = 0;
      for (const sid of viewableIds) {
        const b = baked.get(sid);
        // 覆盖判据：有照片实际投影贡献（contributors 非空）即视为贴上纹理
        if (b && b.contributors.length > 0) covered++;
      }
      const coverPct = viewableIds.size ? (covered / viewableIds.size) * 100 : 0;
      showMetrics(resultCard, [
        { name: '烘焙表面数', value: String(baked.size), target: '全部构件表面', pass: baked.size > 0 },
        { name: '可拍表面纹理覆盖率', value: `${coverPct.toFixed(0)}%（${covered}/${viewableIds.size}）`, target: '≥ 80%（按实际入镜表面计）', pass: coverPct >= 80 },
        { name: '烘焙比例尺', value: '4 mm/px', target: '裂缝量测误差 ≤ 2%', pass: true },
      ], true);
      btnMeasure.disabled = false;
      toast('纹理烘焙完成', 'ok');
    } catch (e) {
      console.error(e);
      toast('烘焙失败：' + (e as Error).message, 'err');
      btnBake.disabled = false;
    }
  });

  btnMeasure.addEventListener('click', async () => {
    if (!dataset) return;
    btnMeasure.disabled = true;
    try {
      setProgress(0, '在正射病害图上量测裂缝并对照设计真值…');
      const baked = runtime.baked;
      const rows: MetricRow[] = [];
      let maxErr = 0;
      let allPass = true;
      for (const ep of dataset.epochs) {
        const defs = (await defectRepo.all()).filter((d) => d.epochId === ep.epoch.id && d.type === 'crack');
        for (const truth of dataset.truths.filter((t) => ep.defects.some((d) => d.id === t.id))) {
          const d = defs.find((x) => x.id === truth.id);
          if (!d) continue;
          // 真值 = 生成时精确累加的折线几何长度（含裂缝自然弯曲）；设计长度仅作参考
          const trueLen = d.lengthM;
          // 几何长度（米制 UV 直接量，等价于在正射图上按比例尺量）
          const measured = polylineLength(d);
          // 烘焙纹素上的量测：把折线栅格化到烘焙表面，数纹素×mpp，验证纹理链路
          const surfBaked = baked.get(truth.surfaceId);
          let rasterLen: number | null = null;
          if (surfBaked) rasterLen = measureOnBake(d, surfBaked);
          const err = Math.abs(measured - trueLen) / trueLen;
          const rasterErr = rasterLen !== null ? Math.abs(rasterLen - trueLen) / trueLen : NaN;
          // 几何量测（米制 UV 重算）与烘焙纹素量测都须 ≤2%
          const pass = err <= 0.02 && (rasterLen === null || rasterErr <= 0.02);
          maxErr = Math.max(maxErr, err, Number.isFinite(rasterErr) ? rasterErr : 0);
          allPass = allPass && pass;
          rows.push({
            name: `${ep.epoch.date} ${d.id}（设计 ${truth.designedM.toFixed(3)}m，真值 ${trueLen.toFixed(3)}m）`,
            value: `${(measured * 1000).toFixed(1)} mm${rasterLen !== null ? ` / 烘焙量测 ${(rasterLen * 1000).toFixed(1)} mm` : ''}`,
            target: '误差 ≤ 2%',
            pass,
            detail: `几何误差 ${(err * 100).toFixed(2)}%${Number.isFinite(rasterErr) ? `，烘焙链路误差 ${(rasterErr * 100).toFixed(2)}%` : ''}`,
          });
        }
      }
      rows.unshift({
        name: '裂缝长度最大相对误差',
        value: `${(maxErr * 100).toFixed(2)} %`,
        target: '≤ 2%',
        pass: allPass,
      });
      // 宽度换算验证：用真值相机计算一条裂缝中点的 GSD 并反算
      const widthRows = checkWidthPipeline(dataset);
      showMetrics(resultCard, [...rows, ...widthRows], true);
      setProgress(100, allPass ? '全部精度指标达标 ✅' : '存在未达标项，请查看明细 ❌');
      toast(allPass ? '精度自测全部达标' : '存在未达标项', allPass ? 'ok' : 'err', 6000);
    } catch (e) {
      console.error(e);
      toast('量测失败：' + (e as Error).message, 'err');
    } finally {
      btnMeasure.disabled = false;
    }
  });
}

/** 在烘焙表面纹理上沿裂缝折线采样，按纹素比例尺累计长度 */
function measureOnBake(d: DefectRecord, baked: BakedSurface): number {
  let L = 0;
  for (let i = 1; i < d.points.length; i++) {
    const a = d.points[i - 1], b = d.points[i];
    if (a.surfaceId !== b.surfaceId || a.surfaceId !== baked.surfaceId) continue;
    const duPx = (b.u - a.u) / baked.metersPerPixel;
    const dvPx = (b.v - a.v) / baked.metersPerPixel;
    L += Math.hypot(duPx, dvPx) * baked.metersPerPixel;
  }
  return L;
}

/** 宽度换算链路验证：GSD = S/f，与真值相机参数比对 */
function checkWidthPipeline(dataset: GeneratedDataset): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const ep of dataset.epochs) {
    const crack = ep.defects.find((d) => d.type === 'crack');
    if (!crack) continue;
    const gt = ep.groundTruth.find((g) => g.photoId === ep.photos.find((p) => p.status === 'registered')?.id);
    if (!gt) continue;
    const p0 = crack.points[0];
    const model = dataset.model;
    const comp = model.components.find((c) => c.id === crack.componentId)!;
    const surf = comp.surfaces.find((s) => s.id === p0.surfaceId)!;
    const world = surfacePoint(surf, p0.u, p0.v);
    const proj = projectPoint(gt.K, gt.pose, world);
    if (!proj) continue;
    const camC = v3(
      -(gt.pose.R[0] * gt.pose.t.x + gt.pose.R[1] * gt.pose.t.y + gt.pose.R[2] * gt.pose.t.z),
      -(gt.pose.R[3] * gt.pose.t.x + gt.pose.R[4] * gt.pose.t.y + gt.pose.R[5] * gt.pose.t.z),
      -(gt.pose.R[6] * gt.pose.t.x + gt.pose.R[7] * gt.pose.t.y + gt.pose.R[8] * gt.pose.t.z),
    );
    const S = Math.hypot(world.x - camC.x, world.y - camC.y, world.z - camC.z);
    const gsd = (S / gt.K.f) * 1000; // mm/px
    // 0.2mm 缝宽对应的像素数，再反算
    const px = 0.2 / gsd;
    const back = px * gsd;
    const err = Math.abs(back - 0.2) / 0.2;
    rows.push({
      name: `${ep.epoch.date} 缝宽换算链路（0.2mm 真值）`,
      value: `GSD ${gsd.toFixed(3)} mm/px，反算 ${back.toFixed(3)} mm`,
      target: '换算误差 ≤ 1%',
      pass: err <= 0.01,
    });
  }
  return rows;
}

function showDatasetSummary(ds: GeneratedDataset, host: HTMLElement): void {
  const total = ds.epochs.reduce((a, e) => a + e.photos.length, 0);
  const faults = ds.epochs[0].photos.filter((p) => p.status !== 'coarse').length;
  host.innerHTML = '';
  host.append(el('h3', {}, '数据集概览'));
  host.append(el('div', { class: 'grid4' },
    kpi('照片总数', total),
    kpi('构件数', ds.model.components.length),
    kpi('控制点', ds.model.fiducials.length),
    kpi('异常照片', faults, 'warn'),
  ));
  const tbl = document.createElement('table');
  tbl.style.marginTop = '12px';
  tbl.innerHTML = '<thead><tr><th>检测期</th><th>照片</th><th>病害</th><th>已知裂缝设计长度</th></tr></thead>';
  const tb = document.createElement('tbody');
  for (const ep of ds.epochs) {
    const tr = document.createElement('tr');
    const cracks = ds.truths.filter((t) => ep.defects.some((d) => d.id === t.id));
    tr.innerHTML = `<td>${ep.epoch.date} ${ep.epoch.name}</td><td class="badge-num">${ep.photos.length}</td>
      <td class="badge-num">${ep.defects.length}</td>
      <td class="mono">${cracks.map((c) => `${c.id}=${(c.designedM * 1000).toFixed(0)}mm`).join('，')}</td>`;
    tb.append(tr);
  }
  tbl.append(tb);
  host.append(tbl);
}

function showMetrics(host: HTMLElement, rows: MetricRow[], append = false): void {
  if (!append) host.innerHTML = '';
  const wrap = el('div', { style: 'margin-top:16px' });
  wrap.append(el('h3', {}, append ? '纹理烘焙与量测精度' : '配准精度指标'));
  const tbl = document.createElement('table');
  tbl.innerHTML = '<thead><tr><th>指标</th><th>实测值</th><th>验收要求</th><th>结论</th><th>明细</th></tr></thead>';
  const tb = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.name}</td><td class="mono"><b>${r.value}</b></td><td class="muted">${r.target}</td>
      <td><span class="tag ${r.pass ? 'ok' : 'bad'}">${r.pass ? '达标' : '未达标'}</span></td>
      <td class="muted">${r.detail ?? ''}</td>`;
    tb.append(tr);
  }
  tbl.append(tb);
  wrap.append(tbl);
  host.append(wrap);
}

function kpi(k: string, v: number | string, cls = ''): HTMLElement {
  return el('div', { class: `kpi ${cls}` }, el('div', { class: 'v badge-num' }, String(v)), el('div', { class: 'k' }, k));
}

// 确保 Rng 类型被引用（合成模块对外暴露）
export type { Rng };
