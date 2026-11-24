// 照片配准页：检测期选择、待处理清单、自动配准、人工同名点解算、逐点重投影残差、烘焙。
import { el, modal, toast } from '../router';
import { appState } from '../state';
import {
  defectRepo, epochRepo, getBlob, photoRepo, putBlob,
} from '../core/db';
import { STATUS_LABEL, type GCP, type PhotoRecord } from '../core/types';
import { defaultIntrinsics, projectPoint, type CameraIntrinsics, type CameraPose } from '../core/camera';
import { poseFromPOS } from '../core/geo';
import { solvePnP, solvePnPRobust, type Correspondence } from '../core/pnp';
import { detectMarkers } from '../vision/markerDetect';
import { bakeModel } from '../vision/textureBaker';
import { runtime, setBaked, setRuntimeDefects } from '../cache';
import type { Vec3 } from '../core/mathTypes';
import { v3 } from '../core/mathTypes';

function localCamFromPOS(ph: PhotoRecord): Vec3 {
  const spec = appState.spec;
  return v3(
    (ph.pos.lon - spec.originLon) * (111320 * Math.cos((spec.originLat * Math.PI) / 180)),
    (ph.pos.lat - spec.originLat) * 110540,
    ph.pos.altitude,
  );
}

export async function renderRegistration(_p: Record<string, string>, root: HTMLElement): Promise<void> {
  if (!appState.data.model) {
    root.append(el('div', { class: 'card muted' }, '请先打开一座桥。'));
    return;
  }
  const model = appState.data.model;
  root.innerHTML = '';
  await appState.refreshEpochs();
  const epochs = appState.data.epochs;
  root.append(el('h2', {}, '照片配准与纹理烘焙'));
  if (!epochs.length) {
    root.append(el('div', { class: 'card muted' }, '尚无检测期与照片。请先到「精度自测」页生成合成数据集，或导入照片。'));
    return;
  }

  const epochBar = el('div', { class: 'card row' });
  epochBar.append(el('strong', {}, '检测期：'));
  const sel = document.createElement('select');
  sel.style.width = '260px';
  sel.innerHTML = epochs.map((e) => `<option value="${e.id}" ${e.id === appState.epochId ? 'selected' : ''}>${e.date} ${e.name}</option>`).join('');
  sel.addEventListener('change', () => appState.setEpoch(sel.value));
  epochBar.append(sel);
  root.append(epochBar);

  let photos = await photoRepo.all();
  photos = photos.filter((p) => p.epochId === appState.epochId);
  runtime.photos = photos;

  const counts = {
    all: photos.length,
    registered: photos.filter((p) => p.status === 'registered').length,
    coarse: photos.filter((p) => p.status === 'coarse').length,
    pending: photos.filter((p) => p.status === 'pending-pos' || p.status === 'rejected-overexposed' || p.status === 'mismatch').length,
  };
  root.append(el('div', { class: 'grid4' },
    kpi('照片总数', counts.all),
    kpi('已配准', counts.registered, counts.registered === counts.all ? 'good' : ''),
    kpi('粗投待校正', counts.coarse, 'warn'),
    kpi('待处理（缺POS/过曝/对不上）', counts.pending, 'bad'),
  ));

  // 操作条
  const bar = el('div', { class: 'card row' });
  const btnAuto = el('button', { class: 'primary' }, '一键自动配准（标志检测 + PnP）');
  const btnBake = el('button', {}, '烘焙投影纹理到构件');
  const btnPending = el('button', { class: 'danger' }, '查看待处理列表');
  bar.append(btnAuto, btnBake, el('div', { class: 'spacer' }), btnPending);
  const prog = el('div', { class: 'progress', style: 'display:none;margin-top:10px' }, document.createElement('div'));
  const progLabel = el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' });
  bar.append(el('div', { style: 'flex-basis:100%' }, prog, progLabel));
  root.append(bar);

  // 照片表
  const card = el('div', { class: 'card' });
  const table = document.createElement('table');
  table.innerHTML = `<thead><tr>
    <th>照片</th><th>状态</th><th>过曝</th><th>同名点</th><th>RMS(px)</th><th>焦距(px)</th><th>k1/k2</th><th>操作</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  card.append(table);
  table.append(tbody);
  root.append(card);

  const refreshRows = () => {
    tbody.innerHTML = '';
    for (const ph of photos) {
      const tr = document.createElement('tr');
      const statusTag = ph.status === 'registered' ? 'ok' : ph.status === 'coarse' ? 'info' : ph.status === 'mismatch' ? 'bad' : 'warn';
      tr.innerHTML = `
        <td class="mono">${ph.filename}</td>
        <td><span class="tag ${statusTag}">${STATUS_LABEL[ph.status]}</span></td>
        <td class="mono">${(ph.overexposure * 100).toFixed(1)}%</td>
        <td class="badge-num">${ph.gcps?.length ?? 0}</td>
        <td class="badge-num ${ph.rmsPx && ph.rmsPx <= 1.5 ? 'tag ok' : ''}">${ph.rmsPx ? ph.rmsPx.toFixed(3) : '—'}</td>
        <td class="badge-num">${ph.intrinsics ? ph.intrinsics.f.toFixed(1) : '—'}</td>
        <td class="mono">${ph.intrinsics ? `${ph.intrinsics.k1.toFixed(3)}/${ph.intrinsics.k2.toFixed(3)}` : '—'}</td>
        <td></td>`;
      const td = tr.lastElementChild as HTMLElement;
      const open = el('button', { class: 'small' }, ph.status === 'registered' ? '查看/重解' : '同名点配准');
      open.addEventListener('click', () => openGcpDialog(ph));
      const img = el('button', { class: 'small' }, '看图');
      img.addEventListener('click', () => openImage(ph));
      td.append(open, img);
      if (ph.status === 'rejected-overexposed') {
        const approve = el('button', { class: 'small' }, '采纳过曝图');
        approve.addEventListener('click', async () => {
          ph.status = 'coarse';
          await photoRepo.put(ph);
          toast('已采纳，可参与配准', 'ok');
          refreshRows();
        });
        td.append(approve);
      }
      tbody.append(tr);
    }
  };
  refreshRows();

  btnPending.addEventListener('click', () => {
    const bad = photos.filter((p) => p.status !== 'registered' && p.status !== 'coarse');
    const content = el('div', {},
      el('div', { class: 'muted', style: 'margin-bottom:10px' }, '异常照片不会默默参与贴图，必须人工处理后才进入配准/烘焙：'),
      el('div', { class: 'pill-list' }, ...bad.map((p) =>
        el('div', { class: 'pill' }, el('span', { class: 'mono' }, p.filename), el('span', { class: 'tag warn' }, STATUS_LABEL[p.status])))),
    );
    modal('待处理列表', content);
  });

  btnAuto.addEventListener('click', () => runAuto());
  btnBake.addEventListener('click', () => runBake());

  async function runAuto(): Promise<void> {
    btnAuto.disabled = true;
    prog.style.display = 'block';
    const fGuess = Math.max(photos[0]?.width ?? 1024, photos[0]?.height ?? 768) * 1.15;
    let ok = 0, fail = 0;
    for (let i = 0; i < photos.length; i++) {
      const ph = photos[i];
      progLabel.textContent = `自动配准 ${i + 1}/${photos.length}：${ph.filename}`;
      (prog.firstElementChild as HTMLElement).style.width = `${((i + 1) / photos.length) * 100}%`;
      await new Promise((r) => setTimeout(r, 0));
      if (ph.status !== 'coarse') { fail++; continue; }
      try {
        const blob = await getBlob(ph.thumbBlobKey ?? '');
        if (!blob) throw new Error('图像 Blob 缺失');
        const K0 = defaultIntrinsics(ph.width, ph.height, fGuess);
        const pose0 = poseFromPOS(localCamFromPOS(ph), ph.pos.yaw, ph.pos.pitch, ph.pos.roll);
        const detected = await detectMarkers(blob, model.fiducials, K0, pose0, (fGuess * 0.09) / 3.2);
        if (detected.length < 4) {
          ph.status = 'mismatch';
          await photoRepo.put(ph);
          fail++;
          continue;
        }
        const corr: Correspondence[] = detected.map((d) => {
          const fid = model.fiducials.find((f) => f.id === d.fiducialId)!;
          return { object: fid.position, image: { x: d.x, y: d.y } };
        });
        const res = solvePnPRobust(corr, ph.width, ph.height, { fGuess, initialPose: pose0 }, 1.5);
        ph.gcps = detected.map((d) => {
          const fid = model.fiducials.find((f) => f.id === d.fiducialId)!;
          return { id: `g-${d.fiducialId}`, fiducialId: d.fiducialId, object: fid.position, image: { x: d.x, y: d.y } };
        });
        ph.intrinsics = { ...res.intrinsics };
        ph.R = Array.from(res.pose.R);
        ph.t = [res.pose.t.x, res.pose.t.y, res.pose.t.z];
        ph.rmsPx = res.rms;
        ph.perPointRmse = res.residuals;
        ph.status = 'registered';
        await photoRepo.put(ph);
        ok++;
      } catch (e) {
        console.error(e);
        ph.status = 'mismatch';
        await photoRepo.put(ph);
        fail++;
      }
    }
    progLabel.textContent = `完成：成功 ${ok} 张，失败/跳过 ${fail} 张`;
    btnAuto.disabled = false;
    refreshRows();
    toast(`自动配准完成，成功 ${ok} 张`, ok ? 'ok' : 'err');
  }

  async function runBake(): Promise<void> {
    const regs = photos.filter((p) => p.status === 'registered' || p.status === 'approved-overexposed');
    if (!regs.length) {
      toast('没有已配准照片可烘焙', 'err');
      return;
    }
    btnBake.disabled = true;
    prog.style.display = 'block';
    try {
      const baked = await bakeModel(model, regs, getBlob, {
        metersPerPixel: 0.004,
        maxTexSide: 512,
        onProgress: (done, total, label) => {
          (prog.firstElementChild as HTMLElement).style.width = `${(done / total) * 100}%`;
          progLabel.textContent = `烘焙 ${done}/${total}：${label}`;
        },
      });
      setBaked(appState.epochId!, baked);
      const defects = (await defectRepo.all()).filter((d) => d.epochId === appState.epochId);
      setRuntimeDefects(appState.epochId!, defects);
      appState.bumpBake();
      toast(`烘焙完成：${baked.size} 个表面，比例尺 2.5 mm/px`, 'ok', 4500);
    } catch (e) {
      toast('烘焙失败：' + (e as Error).message, 'err', 6000);
      console.error(e);
    } finally {
      btnBake.disabled = false;
    }
  }

  function openImage(ph: PhotoRecord): void {
    const content = el('div');
    getBlob(ph.thumbBlobKey ?? '').then((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const im = el('img', { src: url, style: 'width:100%;border-radius:6px' }) as HTMLImageElement;
      im.onload = () => URL.revokeObjectURL(url);
      content.append(im, el('div', { class: 'muted', style: 'margin-top:8px' },
        `POS: ${ph.pos.hasPOS ? `${ph.pos.lon.toFixed(7)}, ${ph.pos.lat.toFixed(7)}, H=${ph.pos.altitude.toFixed(1)}m` : '缺失'} ｜ 云台 ${ph.pos.yaw.toFixed(1)}°/${ph.pos.pitch.toFixed(1)}°/${ph.pos.roll.toFixed(1)}°`));
    });
    modal(ph.filename, content);
  }

  // ---------- 人工同名点对话框 ----------
  function openGcpDialog(ph: PhotoRecord): void {
    const content = el('div', { class: 'flex-col' });
    const state = {
      gcps: (ph.gcps ? structuredClone(ph.gcps) : []) as GCP[],
      K: ph.intrinsics ? { ...ph.intrinsics } : defaultIntrinsics(ph.width, ph.height, Math.max(ph.width, ph.height) * 1.15),
    };
    const summary = el('div', { class: 'muted' }, '在左侧照片找点，再在右侧模型点对应位置（可吸附控制点），至少 4 个同名点。');
    content.append(summary);

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.background = '#0a0e13';
    canvas.style.borderRadius = '6px';
    const wrap = el('div', {}, canvas);
    content.append(wrap);

    const resTable = document.createElement('table');
    content.append(el('h3', {}, '同名点与重投影残差'), resTable);

    const draw = async () => {
      const blob = await getBlob(ph.thumbBlobKey ?? '');
      const ctx = canvas.getContext('2d')!;
      const url = blob ? URL.createObjectURL(blob) : '';
      const img = url ? await new Promise<HTMLImageElement>((r) => { const i = new Image(); i.onload = () => r(i); i.src = url; }) : null;
      canvas.width = ph.width; canvas.height = ph.height;
      if (img) { ctx.drawImage(img, 0, 0); URL.revokeObjectURL(url); }
      else { ctx.fillStyle = '#222'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      // 已有同名点
      for (const g of state.gcps) {
        ctx.strokeStyle = '#ff5a5a'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(g.image.x, g.image.y, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#ff5a5a';
        ctx.font = 'bold 15px sans-serif';
        ctx.fillText(String(g.fiducialId ?? '?'), g.image.x + 11, g.image.y - 8);
      }
    };
    void draw();

    // 照片上点击：选最近控制点的投影像素，或直接记录像素待模型侧指定
    canvas.addEventListener('click', async (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * ph.width;
      const y = ((e.clientY - rect.top) / rect.height) * ph.height;
      // 若已有粗位姿，找投影后离点击位置最近的控制点作为同名点
      const pose = ph.R && ph.t ? poseFromStored(ph) : poseFromPOS(localCamFromPOS(ph), ph.pos.yaw, ph.pos.pitch, ph.pos.roll);
      let nearest: { fid: number; px: { x: number; y: number }; d: number } | null = null;
      for (const fid of model.fiducials) {
        const proj = projectPoint(state.K, pose, fid.position);
        if (!proj) continue;
        const d = Math.hypot(proj.x - x, proj.y - y);
        if (!nearest || d < nearest.d) nearest = { fid: fid.id, px: proj, d };
      }
      if (!nearest) return;
      const fid = model.fiducials.find((f) => f.id === nearest!.fid)!;
      // 用实际点击坐标（人工校正），物方取控制点精确坐标
      const exist = state.gcps.findIndex((g) => g.fiducialId === fid.id);
      const gcp: GCP = { id: `g-${fid.id}`, fiducialId: fid.id, object: fid.position, image: { x, y } };
      if (exist >= 0) state.gcps[exist] = gcp; else state.gcps.push(gcp);
      await draw();
      renderResTable();
      toast(`已记录控制点 #${fid.id}（点击像素 ${x.toFixed(1)}, ${y.toFixed(1)}）`, 'info', 1800);
    });

    const renderResTable = () => {
      resTable.innerHTML = '<thead><tr><th>控制点</th><th>图像 x,y</th><th>物方 X,Y,Z (m)</th><th>重投影残差(px)</th></tr></thead>';
      const tb = document.createElement('tbody');
      // 若已解算，逐点反算残差
      let perPoint: number[] = [];
      if (ph.R && ph.t && ph.intrinsics) {
        const pose = poseFromStored(ph);
        perPoint = state.gcps.map((g) => {
          const proj = projectPoint(ph.intrinsics!, pose, g.object);
          return proj ? Math.hypot(proj.x - g.image.x, proj.y - g.image.y) : NaN;
        });
      }
      state.gcps.forEach((g, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="badge-num">#${g.fiducialId}</td>
          <td class="mono">${g.image.x.toFixed(1)}, ${g.image.y.toFixed(1)}</td>
          <td class="mono">${g.object.x.toFixed(2)}, ${g.object.y.toFixed(2)}, ${g.object.z.toFixed(2)}</td>
          <td class="badge-num ${perPoint[i] <= 1.5 ? 'tag ok' : 'tag bad'}">${perPoint[i] ? perPoint[i].toFixed(3) : '—'}</td>`;
        tb.append(tr);
      });
      resTable.append(tb);
    };
    renderResTable();

    const footer = el('div', { class: 'row', style: 'margin-top:12px;justify-content:flex-end' });
    const solve = el('button', { class: 'primary' }, `解算位姿/焦距/畸变（${state.gcps.length} 点）`);
    solve.addEventListener('click', async () => {
      if (state.gcps.length < 4) { toast('至少需要 4 个同名点', 'err'); return; }
      try {
        const init = ph.pos.hasPOS ? poseFromPOS(localCamFromPOS(ph), ph.pos.yaw, ph.pos.pitch, ph.pos.roll) : undefined;
        const res = solvePnP(
          state.gcps.map((g) => ({ object: g.object, image: g.image })),
          ph.width, ph.height,
          { fGuess: state.K.f, initialPose: init },
        );
        ph.gcps = state.gcps;
        ph.intrinsics = { ...res.intrinsics };
        ph.R = Array.from(res.pose.R);
        ph.t = [res.pose.t.x, res.pose.t.y, res.pose.t.z];
        ph.rmsPx = res.rms;
        ph.perPointRmse = res.residuals;
        ph.status = res.rms <= 1.5 ? 'registered' : 'mismatch';
        await photoRepo.put(ph);
        renderResTable();
        toast(`解算完成：RMS ${res.rms.toFixed(3)} px（${res.rms <= 1.5 ? '达标 ≤1.5' : '未达标，请检查同名点'}）`, res.rms <= 1.5 ? 'ok' : 'err', 5000);
        const idx = photos.findIndex((p) => p.id === ph.id);
        if (idx >= 0) photos[idx] = ph;
        refreshRows();
      } catch (e) {
        toast('解算失败：' + (e as Error).message, 'err');
      }
    });
    const clear = el('button', { class: 'danger' }, '清空同名点');
    clear.addEventListener('click', async () => { state.gcps = []; await draw(); renderResTable(); });
    const closeBtn = el('button', {}, '关闭');
    footer.append(clear, solve, closeBtn);
    const close = modal(`同名点配准 — ${ph.filename}`, content, footer);
    closeBtn.addEventListener('click', close);
  }
}

function poseFromStored(ph: PhotoRecord): CameraPose {
  return {
    R: new Float64Array(ph.R!) as unknown as CameraPose['R'],
    t: v3(ph.t![0], ph.t![1], ph.t![2]),
  };
}

function kpi(k: string, v: number, cls = ''): HTMLElement {
  return el('div', { class: `kpi ${cls}` }, el('div', { class: 'v badge-num' }, String(v)), el('div', { class: 'k' }, k));
}

export { putBlob };
