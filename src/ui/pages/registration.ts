// 页面三：照片配准 — POS 粗投、同名点联选、PnP 精化、残差表、待处理列表、批量烘焙
import { store } from '../../core/store';
import { EnuFrame } from '../../core/geo';
import { PhotoRecord, TiePoint, PhotoFlag } from '../../types';
import { applyCoarseBatch, registerPhoto } from '../../core/registration';
import { deserializeCamera, projectPoint } from '../../core/camera';
import { getImageBlob } from '../../core/db';
import { h, clear, toast } from '../dom';
import { Viewer3D } from '../viewer3d';
import { Vec3 } from '../../core/math';

const FLAG_LABEL: Record<PhotoFlag, string> = {
  overexposed: '逆光过曝',
  no_pos: 'POS缺失',
  mismatch: '对不上',
  high_residual: '残差超标',
};

export function registrationPage(root: HTMLElement): () => void {
  clear(root);
  const photoPane = h('div', {
    class: 'viewport',
    style: 'background:#0c0e11;display:flex;align-items:center;justify-content:center;overflow:auto;position:relative',
  });
  const view3d = h('div', { class: 'viewport' });
  const right = h('div', { class: 'sidebar right' });
  const wrap = h('div', {
    class: 'split',
    style: 'grid-template-columns: 380px 1fr 380px; height:100%',
  }, photoPane, view3d, right);
  root.append(wrap);
  const viewer = new Viewer3D(view3d);

  let frame: EnuFrame | null = null;
  let current: PhotoRecord | null = null;
  let draftTies: TiePoint[] = [];
  let waitingWorld = false;
  let photoCanvas: HTMLCanvasElement | null = null;
  let photoBitmap: ImageBitmap | null = null;

  const renderRight = (): void => {
    clear(right);
    if (!store.bridge) {
      right.append(h('div', { class: 'card muted' }, '请先建桥并生成检测数据'));
      return;
    }
    frame = new EnuFrame(store.bridge.spec.origin);
    const photos = store.currentEpochId ? store.photosOfEpoch(store.currentEpochId) : [];
    const problem = photos.filter((p) => p.flags.length || p.status !== 'registered');
    const registered = photos.filter((p) => p.status === 'registered');

    right.append(
      h('div', { class: 'card' },
        h('h3', {}, '期次与批处理'),
        h('select', {
          onchange: (e: Event) => store.setEpoch((e.target as HTMLSelectElement).value),
        }, ...store.epochs.map((ep) => h('option', { value: ep.id, selected: ep.id === store.currentEpochId }, `${ep.name} (${ep.date})`))),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', {
            class: 'primary', onclick: async () => {
              const updated = await applyCoarseBatch(photos, frame!);
              store.photos = updated;
              store.emit();
              toast(`POS 粗投完成，${updated.filter((p) => p.status === 'coarse').length} 张待精化，缺 POS 的进待处理`);
            },
          }, 'POS 批量粗投'),
          h('button', {
            onclick: () => bakeAll(registered),
          }, '批量烘焙贴图'),
        ),
        h('div', { class: 'muted', style: 'font-size:11px' },
          `共 ${photos.length} 张 · 已配准 ${registered.length} · 待处理 ${problem.length}`),
      ),
      h('div', { class: 'card' },
        h('h3', { style: problem.length ? 'color:var(--accent2)' : '' }, `待处理 (${problem.length})`),
        h('div', { class: 'pill-list', style: 'max-height:200px;overflow:auto' },
          ...problem.map((p) => photoPill(p)),
          problem.length === 0 ? h('div', { class: 'muted' }, '没有异常照片') : null,
        ),
      ),
      h('div', { class: 'card' },
        h('h3', {}, `已配准 (${registered.length})`),
        h('div', { class: 'pill-list', style: 'max-height:180px;overflow:auto' },
          ...registered.map((p) => photoPill(p)),
        ),
      ),
    );

    if (current) right.append(tieEditor());
  };

  function photoPill(p: PhotoRecord): HTMLElement {
    return h('div', {
      class: `pill ${current?.id === p.id ? 'selected' : ''}`,
      onclick: () => selectPhoto(p.id),
    },
      h('div', { style: 'font-weight:600;display:flex;justify-content:space-between;gap:6px' },
        h('span', { class: 'mono' }, p.fileName),
        h('span', { class: `tag ${p.status === 'registered' ? 'ok' : 'warn'}` }, statusText(p))),
      h('div', { class: 'muted', style: 'font-size:11px' },
        p.rms !== null ? `RMS ${p.rms.toFixed(3)}px · ${p.tiePoints.length} 点` : `${p.tiePoints.length} 同名点 · 未精化`),
      h('div', { style: 'margin-top:3px;display:flex;gap:4px;flex-wrap:wrap' },
        ...p.flags.map((f) => h('span', { class: 'tag bad' }, FLAG_LABEL[f]))),
    );
  }

  function tieEditor(): HTMLElement {
    return h('div', { class: 'card' },
      h('h3', {}, `同名点联选 (${draftTies.length})`),
      h('div', { class: 'muted', style: 'margin-bottom:8px' },
        '① 在左栏照片上点像素 → ② 在中间三维模型上点对应表面 → 重复；≥4 点后解算。'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: solve }, '解算位姿/焦距/畸变'),
        h('button', { onclick: () => { draftTies.pop(); waitingWorld = false; syncExtra(); paintPhoto(); renderRight(); } }, '撤销一点'),
        h('button', { class: 'danger', onclick: () => { draftTies = []; waitingWorld = false; syncExtra(); paintPhoto(); renderRight(); } }, '清空'),
      ),
      waitingWorld ? h('div', { class: 'tag warn', style: 'margin-bottom:6px' }, '照片点已取，等待在三维模型上点对应位置…') : null,
      h('div', { style: 'max-height:220px;overflow:auto' },
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, '像素 u,v'), h('th', {}, '世界 xyz(m)'), h('th', {}, '残差'))),
          h('tbody', {},
            ...draftTies.map((t, i) => h('tr', {},
              h('td', {}, String(i + 1)),
              h('td', { class: 'mono' }, `${t.image[0].toFixed(1)},${t.image[1].toFixed(1)}`),
              h('td', { class: 'mono' }, t.world.map((x) => x.toFixed(2)).join(',')),
              h('td', { class: 'mono' }, t.residual !== undefined ? residualCell(t.residual) : '-'),
            )),
          ),
        ),
      ),
      current!.camera ? cameraCard() : null,
    );
  }

  function cameraCard(): HTMLElement {
    const c = deserializeCamera(current!.camera!);
    return h('div', { class: 'card' },
      h('h3', {}, '解算结果'),
      h('table', {}, h('tbody', {},
        h('tr', {}, h('td', { class: 'muted' }, 'fx, fy(px)'), h('td', { class: 'mono' }, `${c.fx.toFixed(1)}, ${c.fy.toFixed(1)}`)),
        h('tr', {}, h('td', { class: 'muted' }, 'cx, cy'), h('td', { class: 'mono' }, `${c.cx.toFixed(1)}, ${c.cy.toFixed(1)}`)),
        h('tr', {}, h('td', { class: 'muted' }, 'k1, k2'), h('td', { class: 'mono' }, `${c.k1.toFixed(4)}, ${c.k2.toFixed(4)}`)),
        h('tr', {}, h('td', { class: 'muted' }, '光心 ENU(m)'), h('td', { class: 'mono' }, c.C.map((x) => x.toFixed(2)).join(', '))),
        h('tr', {}, h('td', { class: 'muted' }, 'RMS'), h('td', { class: 'mono' }, current!.rms !== null ? residualCell(current!.rms) : '-')),
      )),
    );
  }

  function residualCell(r: number): HTMLElement {
    return h('span', { class: r <= 1.5 ? 'rms-pass' : 'rms-fail', style: 'font-weight:700' },
      r.toFixed(3), r <= 1.5 ? ' ✓' : ' ✗');
  }

  async function selectPhoto(id: string): Promise<void> {
    const rec = store.photos.find((p) => p.id === id);
    if (!rec) return;
    current = rec;
    store.selectPhoto(id);
    draftTies = rec.tiePoints.map((t) => ({ ...t }));
    waitingWorld = false;
    viewer.highlightPhotoId = id;
    syncExtra();
    await paintPhoto();
    renderRight();
  }

  async function paintPhoto(): Promise<void> {
    clear(photoPane);
    if (!current) {
      photoPane.append(h('div', { class: 'muted' }, '从右侧选择照片'));
      return;
    }
    photoCanvas = h('canvas', {
      style: 'max-width:100%;max-height:100%;cursor:crosshair',
    }) as HTMLCanvasElement;
    photoCanvas.width = current.width;
    photoCanvas.height = current.height;
    photoPane.append(photoCanvas);
    const ctx = photoCanvas.getContext('2d')!;
    const blob = await getImageBlob(`full:${current.id}`);
    if (photoBitmap) photoBitmap.close();
    if (blob) {
      photoBitmap = await createImageBitmap(blob);
      ctx.drawImage(photoBitmap, 0, 0);
    } else {
      ctx.fillStyle = '#222';
      ctx.fillRect(0, 0, current.width, current.height);
      ctx.fillStyle = '#aaa';
      ctx.font = '28px sans-serif';
      ctx.fillText('图像数据缺失', 60, 80);
    }
    photoCanvas.addEventListener('click', (e) => {
      if (!current) return;
      const rect = photoCanvas!.getBoundingClientRect();
      const u = ((e.clientX - rect.left) / rect.width) * current.width;
      const v = ((e.clientY - rect.top) / rect.height) * current.height;
      draftTies.push({ id: `tp-${draftTies.length}`, image: [u, v], world: [0, 0, 0] });
      waitingWorld = true;
      paintOverlays(ctx);
      renderRight();
      toast('照片点已取，请到中间三维视图点对应构件表面');
    });
    paintOverlays(ctx);
  }

  function paintOverlays(ctx: CanvasRenderingContext2D): void {
    if (!current || !photoCanvas) return;
    ctx.save();
    draftTies.forEach((t, i) => {
      ctx.beginPath();
      ctx.arc(t.image[0], t.image[1], 8, 0, Math.PI * 2);
      ctx.strokeStyle = i === draftTies.length - 1 && waitingWorld ? '#f2a33c' : '#4f8cff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(String(i + 1), t.image[0] + 10, t.image[1] - 8);
    });
    if (current.camera) {
      const cam = deserializeCamera(current.camera);
      ctx.strokeStyle = 'rgba(63,191,127,.95)';
      ctx.lineWidth = 1.6;
      for (const t of draftTies) {
        if (!finiteWorld(t.world)) continue;
        const [u, v] = projectPoint(cam, t.world);
        ctx.beginPath();
        ctx.moveTo(u - 6, v); ctx.lineTo(u + 6, v);
        ctx.moveTo(u, v - 6); ctx.lineTo(u, v + 6);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // 三维视图点选回填世界坐标
  viewer.onPick((_id, point) => {
    if (!waitingWorld || !point || !draftTies.length) return;
    draftTies[draftTies.length - 1].world = [point[0], point[1], point[2]];
    waitingWorld = false;
    syncExtra();
    if (photoCanvas) paintOverlays(photoCanvas.getContext('2d')!);
    renderRight();
  });

  function syncExtra(): void {
    viewer.extraPoints = draftTies.filter((t) => finiteWorld(t.world)).map((t) => ({
      pos: t.world, color: [0.31, 0.55, 1, 1] as [number, number, number, number], size: 10,
    }));
  }

  async function solve(): Promise<void> {
    if (!current || !frame) return;
    const complete = draftTies.filter((t) => finiteWorld(t.world));
    if (complete.length < 4) {
      toast('至少需要 4 个同时含像素和世界坐标的同名点');
      return;
    }
    try {
      const result = await registerPhoto(current, frame, complete);
      current = result.photo;
      draftTies = current.tiePoints.map((t) => ({ ...t }));
      const idx = store.photos.findIndex((p) => p.id === current!.id);
      if (idx >= 0) store.photos[idx] = current;
      syncExtra();
      store.emit();
      renderRight();
      if (photoCanvas) paintOverlays(photoCanvas.getContext('2d')!);
      toast(result.accepted
        ? `配准成功 RMS=${result.rms.toFixed(3)}px，满足 ≤1.5px 验收线`
        : `RMS=${result.rms.toFixed(3)}px 超标，请调整同名点后重解`);
    } catch (err) {
      toast('解算失败: ' + (err as Error).message);
    }
  }

  async function bakeAll(photos: PhotoRecord[]): Promise<void> {
    if (!photos.length) {
      toast('当前期次还没有已配准照片');
      return;
    }
    const r = viewer.renderer;
    r.resetBake();
    let n = 0;
    for (const p of photos) {
      const blob = await getImageBlob(`full:${p.id}`);
      if (!blob || !p.camera) continue;
      const bmp = await createImageBitmap(blob);
      const tex = r.uploadPhotoTexture(bmp);
      r.bakePhoto(deserializeCamera(p.camera), tex);
      r.gl.deleteTexture(tex);
      bmp.close();
      n++;
    }
    r.showBaked = true;
    toast(`融合 ${n} 张照片：深度可见性遮挡 + 入射角/拍摄距离加权`);
  }

  const unsub = store.subscribe(renderRight);
  renderRight();
  paintPhoto();

  return () => {
    unsub();
    photoBitmap?.close();
    viewer.dispose();
  };
}

function finiteWorld(p: Vec3): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]) &&
    !(p[0] === 0 && p[1] === 0 && p[2] === 0);
}
function statusText(p: PhotoRecord): string {
  switch (p.status) {
    case 'registered': return '已配准';
    case 'coarse': return '粗投';
    case 'pending': return '待处理';
    case 'rejected': return '已拒收';
  }
}
