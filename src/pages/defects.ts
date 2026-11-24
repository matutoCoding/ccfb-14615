// 病害登记页：选择构件表面 -> 正射病害图上绘制；或在照片上绘制后反算到构件局部坐标。
import { el, modal, toast } from '../router';
import { appState } from '../state';
import { runtime } from '../cache';
import { defectRepo, getBlob, photoRepo } from '../core/db';
import type { ComponentDef, DefectRecord, DefectType, SeverityClass, SurfaceDef } from '../core/types';
import { DEFECT_TYPE_LABEL } from '../core/types';
import { OrthoView } from '../render/orthoView';
import { finalizeDefect, pixelWidthToMm } from '../services/defectService';
import { surfacePoint } from '../core/geometry';
import { ModelViewer } from '../render/modelViewer';
import type { CameraIntrinsics, CameraPose } from '../core/camera';
import { v3 } from '../core/mathTypes';

const TYPE_COLOR: Record<DefectType, string> = {
  crack: '#ff5a5a', spalling: '#ffb14d', seepage: '#7fd0ff', honeycomb: '#c69bff',
};

export async function renderDefects(_p: Record<string, string>, root: HTMLElement): Promise<void> {
  if (!appState.data.model) {
    root.append(el('div', { class: 'card muted' }, '请先打开一座桥。'));
    return;
  }
  const model = appState.data.model;
  root.innerHTML = '';
  root.append(el('h2', {}, '病害登记'));
  const epochId = appState.epochId;
  if (!epochId) {
    root.append(el('div', { class: 'card muted' }, '请先在「照片配准」选择检测期。'));
    return;
  }
  let defects = (await defectRepo.all()).filter((d) => d.epochId === epochId);
  runtime.defects = defects;
  runtime.defectsEpochId = epochId;

  // 构件选择
  const girders = model.components.filter((c) => c.category === 'main-girder' || c.category === 'bent-cap');
  const bar = el('div', { class: 'card row' });
  bar.append(el('strong', {}, '构件：'));
  const compSel = document.createElement('select');
  compSel.style.width = '220px';
  compSel.innerHTML = girders.map((c) => `<option value="${c.id}">${c.code} ${c.name}</option>`).join('');
  bar.append(compSel);
  bar.append(el('strong', { style: 'margin-left:14px' }, '表面：'));
  const surfSel = document.createElement('select');
  surfSel.style.width = '200px';
  bar.append(surfSel);
  const drawSel = document.createElement('select');
  drawSel.innerHTML = `<option value="">浏览模式</option>
    <option value="crack">绘制裂缝（折线，双击结束）</option>
    <option value="spalling">圈定剥落露筋（闭合）</option>
    <option value="seepage">圈定渗水泛白（闭合）</option>
    <option value="honeycomb">圈定蜂窝麻面（闭合）</option>`;
  drawSel.style.width = '230px';
  bar.append(drawSel);
  const widthInput = document.createElement('input');
  widthInput.type = 'number'; widthInput.step = '0.01'; widthInput.value = '0.15'; widthInput.style.width = '90px';
  widthInput.title = '裂缝宽度 mm';
  bar.append(el('span', { class: 'muted' }, '缝宽mm:'), widthInput);
  const sevSel = document.createElement('select');
  sevSel.innerHTML = [1, 2, 3, 4, 5].map((i) => `<option value="${i}" ${i === 3 ? 'selected' : ''}>标度 ${i}</option>`).join('');
  sevSel.style.width = '90px';
  bar.append(sevSel);
  const btnPhoto = el('button', {}, '在照片上绘制（自动反算坐标）');
  bar.append(el('div', { class: 'spacer' }), btnPhoto);
  root.append(bar);

  const host = el('div', { class: 'card' });
  const listCard = el('div', { class: 'card' });
  root.append(host, listCard);

  let comp = girders.find((c) => c.id === compSel.value)!;
  let ortho: OrthoView | null = null;

  const fillSurfaces = () => {
    comp = girders.find((c) => c.id === compSel.value)!;
    surfSel.innerHTML = comp.surfaces.map((s, i) => `<option value="${i}">${s.name}（${s.width.toFixed(2)}×${s.height.toFixed(2)}m）</option>`).join('');
  };
  fillSurfaces();

  const renderList = () => {
    listCard.innerHTML = '';
    listCard.append(el('h3', {}, `本期病害（${defects.length} 条）`));
    const tbl = document.createElement('table');
    tbl.innerHTML = `<thead><tr><th>编号</th><th>构件</th><th>类型</th><th>长度(m)</th><th>面积(m²)</th><th>缝宽(mm)</th><th>标度</th><th>操作</th></tr></thead>`;
    const tb = document.createElement('tbody');
    for (const d of defects) {
      const c = model.components.find((x) => x.id === d.componentId);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="mono">${d.id}</td><td>${c?.code ?? d.componentId}</td>
        <td><span style="color:${TYPE_COLOR[d.type]}">●</span> ${DEFECT_TYPE_LABEL[d.type]}</td>
        <td class="badge-num">${d.lengthM ? d.lengthM.toFixed(3) : '—'}</td>
        <td class="badge-num">${d.areaM2 ? d.areaM2.toFixed(3) : '—'}</td>
        <td class="badge-num">${d.widthMm ? d.widthMm.toFixed(2) : '—'}</td>
        <td class="badge-num">${d.severity}</td><td></td>`;
      const td = tr.lastElementChild as HTMLElement;
      const locate = el('button', { class: 'small' }, '图上定位');
      locate.addEventListener('click', () => {
        compSel.value = d.componentId;
        fillSurfaces();
        const si = comp.surfaces.findIndex((s) => s.id === d.points[0].surfaceId);
        if (si >= 0) surfSel.value = String(si);
        mount(true, d.id);
      });
      const del = el('button', { class: 'small danger' }, '删除');
      del.addEventListener('click', async () => {
        if (!confirm('删除该病害？')) return;
        await defectRepo.remove(d.id);
        defects = defects.filter((x) => x.id !== d.id);
        runtime.defects = defects;
        renderList(); mount(false);
      });
      td.append(locate, del);
      tb.append(tr);
    }
    tbl.append(tb);
    listCard.append(tbl);
  };

  const mount = (selectDefect = false, selectedId?: string) => {
    comp = girders.find((c) => c.id === compSel.value)!;
    const surf = comp.surfaces[parseInt(surfSel.value || '0', 10)] as SurfaceDef;
    host.innerHTML = '';
    const baked = runtime.baked.get(surf.id) ?? null;
    const compDefects = defects.filter((d) => d.componentId === comp.id);
    ortho = new OrthoView(comp, surf, baked, compDefects, {
      drawMode: drawSel.value ? (drawSel.value as DefectType) : null,
      widthMm: parseFloat(widthInput.value),
      severity: parseInt(sevSel.value, 10) as SeverityClass,
      selectedId: selectDefect ? selectedId : null,
      onSelectDefect: (d) => toast(`${d.id}：${DEFECT_TYPE_LABEL[d.type]}，长度 ${d.lengthM.toFixed(3)} m`, 'info', 2600),
      onDrawn: async (points) => saveDrawn(points, surf, null),
    });
    host.append(ortho.canvas);
    if (!baked) host.append(el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' },
      '提示：未烘焙也可以登记病害（坐标是构件局部米制，与纹理独立），烘焙后会自动贴回。'));
  };

  const saveDrawn = async (
    points: { surfaceId: string; u: number; v: number }[],
    surf: SurfaceDef,
    sourcePhotoId: string | null,
    widthOverride?: number,
  ) => {
    const type = (drawSel.value || 'crack') as DefectType;
    const d: DefectRecord = {
      id: `def-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
      bridgeId: appState.data.bridgeId!,
      epochId: epochId!,
      componentId: comp.id,
      type,
      points,
      lengthM: 0, areaM2: 0,
      widthMm: widthOverride ?? (type === 'crack' ? parseFloat(widthInput.value) : 0),
      severity: parseInt(sevSel.value, 10) as SeverityClass,
      description: `${DEFECT_TYPE_LABEL[type]}（${comp.code} / ${surf.name}）`,
      sourcePhotoId: sourcePhotoId ?? undefined,
      createdAt: Date.now(),
    };
    const fin = finalizeDefect(d);
    await defectRepo.put(fin);
    defects.push(fin);
    runtime.defects = defects;
    appState.bumpBake();
    toast(`已保存 ${DEFECT_TYPE_LABEL[type]}：长度 ${fin.lengthM.toFixed(3)} m${type === 'crack' ? `，宽度 ${fin.widthMm.toFixed(2)} mm` : `，面积 ${fin.areaM2.toFixed(3)} m²`}`, 'ok');
    renderList();
    mount(false);
  };

  compSel.addEventListener('change', () => { fillSurfaces(); mount(); });
  surfSel.addEventListener('change', () => mount());
  drawSel.addEventListener('change', () => mount());
  widthInput.addEventListener('change', () => mount());

  // 在照片上绘制：照片像素点 -> 射线 -> 构件表面求交 -> 局部 UV
  btnPhoto.addEventListener('click', () => openPhotoDraw());

  async function openPhotoDraw(): Promise<void> {
    const photos = (await photoRepo.all()).filter((p) => p.epochId === epochId && p.status === 'registered');
    if (!photos.length) { toast('没有已配准照片，先去配准', 'err'); return; }
    const content = el('div', { class: 'flex-col' });
    const phSel = document.createElement('select');
    phSel.innerHTML = photos.map((p) => `<option value="${p.id}">${p.filename}</option>`).join('');
    content.append(phSel);
    const cv = document.createElement('canvas');
    cv.style.width = '100%';
    cv.style.borderRadius = '6px';
    cv.style.cursor = 'crosshair';
    content.append(cv);
    const tip = el('div', { class: 'muted', style: 'font-size:12px' },
      '在照片上单击描点（折线/轮廓），双击结束。每个像素点会反投影为射线与当前构件表面求交，得到构件局部米制坐标；缝宽按 GSD=物距/焦距 换算。');
    content.append(tip);
    const draftPx: { x: number; y: number }[] = [];

    const draw = async () => {
      const ph = photos.find((p) => p.id === phSel.value)!;
      const blob = await getBlob(ph.thumbBlobKey ?? '');
      const ctx = cv.getContext('2d')!;
      const url = blob ? URL.createObjectURL(blob) : '';
      const img = url ? await new Promise<HTMLImageElement>((r) => { const i = new Image(); i.onload = () => r(i); i.src = url; }) : null;
      cv.width = ph.width; cv.height = ph.height;
      if (img) { ctx.drawImage(img, 0, 0); URL.revokeObjectURL(url); }
      ctx.strokeStyle = '#ffd24d'; ctx.lineWidth = 2.5;
      ctx.beginPath();
      draftPx.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      draftPx.forEach((p) => { ctx.fillStyle = '#ff5a5a'; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); });
    };
    void draw();
    phSel.addEventListener('change', () => { draftPx.length = 0; void draw(); });

    cv.addEventListener('click', (e) => {
      const rect = cv.getBoundingClientRect();
      draftPx.push({
        x: ((e.clientX - rect.left) / rect.width) * cv.width,
        y: ((e.clientY - rect.top) / rect.height) * cv.height,
      });
      void draw();
    });
    cv.addEventListener('dblclick', async () => {
      if (draftPx.length < 2) return;
      const ph = photos.find((p) => p.id === phSel.value)!;
      const K: CameraIntrinsics = { ...ph.intrinsics! };
      const pose: CameraPose = { R: new Float64Array(ph.R!) as never, t: v3(ph.t![0], ph.t![1], ph.t![2]) };
      // 用一个临时 ModelViewer 的屏幕射线逻辑不方便，直接按针孔反投影
      const { pixelToNormalized } = await import('../core/camera');
      const { m3mulv } = await import('../core/mathTypes');
      const Rt = new Float64Array(pose.R);
      // 相机系射线（指向场景 = -z 方向）
      const localPts: { surfaceId: string; u: number; v: number }[] = [];
      const widthsAt: number[] = [];
      const targetComp = comp;
      for (const px of draftPx) {
        const n = pixelToNormalized(K, px.x, px.y);
        const dirCam = v3(n.x, n.y, -1); // 归一化像点 -> 相机系方向
        // 世界系方向 = Rᵀ·dirCam
        const R = Rt;
        const dirW = v3(
          R[0] * dirCam.x + R[3] * dirCam.y + R[6] * dirCam.z,
          R[1] * dirCam.x + R[4] * dirCam.y + R[7] * dirCam.z,
          R[2] * dirCam.x + R[5] * dirCam.y + R[8] * dirCam.z,
        );
        // 光心 C = -Rᵀt
        const C = v3(
          -(R[0] * pose.t.x + R[1] * pose.t.y + R[2] * pose.t.z),
          -(R[3] * pose.t.x + R[4] * pose.t.y + R[5] * pose.t.z),
          -(R[6] * pose.t.x + R[7] * pose.t.y + R[8] * pose.t.z),
        );
        const ray = { origin: C, dir: dirW };
        const { intersectComponent } = await import('../core/geometry');
        const hit = intersectComponent(ray, targetComp);
        if (!hit) { toast('有像素点没有打到当前构件表面，已跳过该点', 'err'); continue; }
        localPts.push({ surfaceId: hit.surface.id, u: hit.u, v: hit.v });
        const pWorld = surfacePoint(hit.surface, hit.u, hit.v);
        const camP = m3mulv(R as never, pWorld);
        const depth = -(camP.z + pose.t.z);
        widthsAt.push(depth);
      }
      if (localPts.length < 2) { toast('反算失败：有效点不足', 'err'); return; }
      const meanDepth = widthsAt.reduce((a, b) => a + b, 0) / widthsAt.length;
      const surf = comp.surfaces.find((s) => s.id === localPts[0].surfaceId)!;
      close();
      await saveDrawn(localPts, surf, ph.id, parseFloat(widthInput.value));
      const gsd = (meanDepth / K.f) * 1000; // mm/px
      toast(`反算完成，平均物距 ${meanDepth.toFixed(2)} m，GSD ${gsd.toFixed(3)} mm/px`, 'ok', 4000);
    });

    const footer = el('div', { class: 'row', style: 'justify-content:flex-end' });
    const closeBtn = el('button', {}, '关闭');
    footer.append(closeBtn);
    const close = modal('照片上绘制病害', content, footer);
    closeBtn.addEventListener('click', close);
  }

  mount();
  renderList();
}
