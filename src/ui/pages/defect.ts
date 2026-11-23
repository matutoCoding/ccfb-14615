// 页面四：病害登记 — 照片上画线，射线反算到构件表面局部坐标；裂缝宽度按像素/物距换算
import { store } from '../../core/store';
import { DefectKind, DefectPoint, DefectRecord, PhotoRecord } from '../../types';
import { deserializeCamera } from '../../core/camera';
import { RayCaster } from '../../core/raycast';
import { pointToSurface } from '../../core/geometry';
import { polylineLengthMm, crackWidthMm } from '../../core/defectUtils';
import { db, getImageBlob } from '../../core/db';
import { kindName } from '../../core/scoring';
import { h, clear, toast } from '../dom';
import { Viewer3D } from '../viewer3d';
import { Vec3, v3dist } from '../../core/math';

const KINDS: DefectKind[] = ['crack', 'spall', 'seepage', 'honeycomb'];

export function defectPage(root: HTMLElement): () => void {
  clear(root);
  const photoPane = h('div', { class: 'viewport', style: 'background:#0c0e11;position:relative;overflow:auto' });
  const view3d = h('div', { class: 'viewport' });
  const side = h('div', { class: 'sidebar right' });
  const wrap = h('div', { class: 'split', style: 'grid-template-columns:380px 1fr 380px;height:100%' }, side, view3d, photoPane);
  root.append(wrap);
  const viewer = new Viewer3D(view3d);
  const caster = store.geometry ? new RayCaster(store.geometry) : null;

  let photo: PhotoRecord | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let bitmap: ImageBitmap | null = null;
  let kind: DefectKind = 'crack';
  let drawing = false;
  let imagePts: [number, number][] = [];
  let worldPts: Vec3[] = [];
  let widthPx = 2;
  let componentId: string | null = null;

  const renderSide = (): void => {
    clear(side);
    if (!store.bridge) {
      side.append(h('div', { class: 'card muted' }, '请先建桥'));
      return;
    }
    const photos = (store.currentEpochId ? store.photosOfEpoch(store.currentEpochId) : []).filter((p) => p.camera);
    const defects = store.currentEpochId ? store.defectsOfEpoch(store.currentEpochId) : [];
    side.append(
      h('div', { class: 'card' },
        h('h3', {}, '期次/照片'),
        h('select', {
          onchange: (e: Event) => store.setEpoch((e.target as HTMLSelectElement).value),
        }, ...store.epochs.map((ep) => h('option', { value: ep.id, selected: ep.id === store.currentEpochId }, ep.name))),
        h('select', {
          style: 'margin-top:8px;width:100%',
          onchange: (e: Event) => selectPhoto((e.target as HTMLSelectElement).value),
        },
          h('option', { value: '' }, '选择已配准照片…'),
          ...photos.map((p) => h('option', { value: p.id, selected: p.id === photo?.id }, p.fileName))),
      ),
      h('div', { class: 'card' },
        h('h3', {}, '病害类型'),
        h('div', { class: 'row' },
          ...KINDS.map((k) => h('button', {
            class: kind === k ? 'primary' : '',
            onclick: () => { kind = k; renderSide(); },
          }, kindName(k))),
        ),
        h('label', { class: 'field' }, h('span', {}, '像素宽度'),
          h('input', { type: 'number', value: String(widthPx), step: '0.5', min: '0.5', oninput: (e: Event) => {
            widthPx = parseFloat((e.target as HTMLInputElement).value) || 1;
          } })),
        h('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' },
          '裂缝毫米宽度 = 像素宽度 × 物距 / fx × 1000，随画线实时换算'),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'primary', onclick: saveDefect }, '登记病害'),
          h('button', { class: 'danger', onclick: resetDraw }, '重画'),
        ),
        h('div', { id: 'live-metric', class: 'mono muted', style: 'margin-top:8px' }, liveMetricText()),
      ),
      h('div', { class: 'card' },
        h('h3', {}, `本期病害 (${defects.length})`),
        h('div', { class: 'pill-list', style: 'max-height:300px;overflow:auto' },
          ...defects.map((d) => h('div', {
            class: 'pill',
            onclick: () => {
              store.selectComponent(d.componentId);
              viewer.controls.frameTarget(d.points[0].world[0], d.points[0].world[1], d.points[0].world[2], 6);
            },
          },
            h('div', { style: 'font-weight:600' }, `${d.code} · ${kindName(d.kind)}`),
            h('div', { class: 'muted', style: 'font-size:11px' },
              `${store.componentById(d.componentId)?.code ?? d.componentId} · 长${(d.lengthMm / 1000).toFixed(2)}m${d.widthMm ? ` · 宽${d.widthMm.toFixed(2)}mm` : ''}`),
          )),
        ),
      ),
    );
  };

  function liveMetricText(): string {
    if (!worldPts.length) return '画线后显示反算坐标与长度';
    const lenM = polylineLengthMm(worldPts.map((w) => ({ world: w }))) / 1000;
    let widthText = '';
    if (kind === 'crack' && photo?.camera) {
      const cam = deserializeCamera(photo.camera);
      const wmm = crackWidthMm(widthPx, cam, worldPts[0]);
      widthText = ` | 估算宽度 ${wmm.toFixed(3)}mm`;
    }
    return `已取 ${worldPts.length} 点 | 长 ${lenM.toFixed(3)}m${widthText}${componentId ? ` | 构件 ${store.componentById(componentId)?.code}` : ''}`;
  }

  async function selectPhoto(id: string): Promise<void> {
    if (!id) {
      photo = null;
      return;
    }
    photo = store.photos.find((p) => p.id === id) ?? null;
    resetDraw();
    clear(photoPane);
    if (!photo) return;
    canvas = h('canvas', { style: 'max-width:100%;max-height:100%;cursor:crosshair' }) as HTMLCanvasElement;
    canvas.width = photo.width;
    canvas.height = photo.height;
    photoPane.append(canvas);
    const blob = await getImageBlob(`full:${photo.id}`);
    const ctx = canvas.getContext('2d')!;
    if (blob) {
      bitmap = await createImageBitmap(blob);
      ctx.drawImage(bitmap, 0, 0);
    }
    canvas.addEventListener('pointerdown', (e) => {
      drawing = true;
      imagePts = [];
      worldPts = [];
      componentId = null;
      handlePointer(e, ctx);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (drawing) handlePointer(e, ctx);
    });
    window.addEventListener('pointerup', () => {
      if (drawing) {
        drawing = false;
        renderSide();
      }
    }, { once: true });
  }

  function handlePointer(e: PointerEvent, ctx: CanvasRenderingContext2D): void {
    if (!canvas || !photo?.camera || !caster) return;
    const rect = canvas.getBoundingClientRect();
    const u = ((e.clientX - rect.left) / rect.width) * photo.width;
    const v = ((e.clientY - rect.top) / rect.height) * photo.height;
    if (imagePts.length && Math.hypot(u - imagePts[imagePts.length - 1][0], v - imagePts[imagePts.length - 1][1]) < 4) return;
    imagePts.push([u, v]);
    // 像素 -> 相机射线 -> 构件表面交点
    const cam = deserializeCamera(photo.camera);
    const xn = (u - cam.cx) / cam.fx;
    const yn = (v - cam.cy) / cam.fy;
    const dirCam: Vec3 = [xn, yn, 1];
    const dirWorld: Vec3 = [
      cam.R[0] * dirCam[0] + cam.R[3] * dirCam[1] + cam.R[6] * dirCam[2],
      cam.R[1] * dirCam[0] + cam.R[4] * dirCam[1] + cam.R[7] * dirCam[2],
      cam.R[2] * dirCam[0] + cam.R[5] * dirCam[1] + cam.R[8] * dirCam[2],
    ];
    const hit = caster.cast(cam.C, dirWorld);
    if (!hit) {
      toast('该点未命中构件表面，已忽略');
      imagePts.pop();
      return;
    }
    worldPts.push(hit.point);
    componentId = hit.componentId;
    paintStroke(ctx);
    const metric = document.getElementById('live-metric');
    if (metric) metric.textContent = liveMetricText();
  }

  function paintStroke(ctx: CanvasRenderingContext2D): void {
    if (!bitmap || !canvas) return;
    ctx.drawImage(bitmap, 0, 0);
    ctx.save();
    ctx.strokeStyle = defectStrokeColor(kind);
    ctx.lineWidth = Math.max(1.4, widthPx);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    imagePts.forEach(([u, v], i) => i ? ctx.lineTo(u, v) : ctx.moveTo(u, v));
    ctx.stroke();
    ctx.restore();
  }

  function resetDraw(): void {
    imagePts = [];
    worldPts = [];
    componentId = null;
    drawing = false;
    if (canvas && bitmap) canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    renderSide();
  }

  async function saveDefect(): Promise<void> {
    if (!photo || !componentId || worldPts.length < 2 || !store.currentEpoch) {
      toast('先选已配准照片并在构件表面画出至少两点');
      return;
    }
    const cg = store.geometryById(componentId);
    if (!cg) return;
    const points: DefectPoint[] = worldPts.map((w) => ({
      world: w,
      local: pointToSurface(cg, w, 0.06)?.local ?? [0, 0],
    }));
    const cam = deserializeCamera(photo.camera!);
    const widthMm = kind === 'crack' ? crackWidthMm(widthPx, cam, worldPts[0]) : null;
    const comp = store.componentById(componentId)!;
    const count = store.defects.filter((d) => d.epochId === store.currentEpochId).length + 1;
    const rec: DefectRecord = {
      id: `D-${Date.now().toString(36)}`,
      bridgeId: store.bridge!.id,
      componentId,
      epochId: store.currentEpoch.id,
      kind,
      code: `${kindPrefix(kind)}-${comp.code}-${count}`,
      surface: cg.surfaces[0]?.name ?? '',
      points,
      widthMm,
      lengthMm: polylineLengthMm(points),
      areaM2: null,
      severity: widthMm && widthMm > 0.15 ? 2 : 1,
      photoId: photo.id,
      note: '',
      predecessorId: null,
      createdAt: Date.now(),
    };
    await db.saveDefect(rec);
    await store.refresh();
    viewer.extraPoints = points.map((p) => ({ pos: p.world, color: [1, 0.3, 0.2, 1], size: 8 }));
    toast(`已登记 ${rec.code}，坐标已反算到构件局部系，切换照片仍贴在原位`);
    resetDraw();
  }

  const unsub = store.subscribe(renderSide);
  renderSide();
  return () => {
    unsub();
    bitmap?.close();
    viewer.dispose();
  };
}

const KIND_PREFIX: Record<DefectKind, string> = { crack: 'LF', spall: 'BL', seepage: 'SS', honeycomb: 'FM' };
const KIND_STROKE: Record<DefectKind, string> = { crack: '#ff4d3d', spall: '#f2a33c', seepage: '#66bfff', honeycomb: '#b98cff' };
function kindPrefix(k: DefectKind): string {
  return KIND_PREFIX[k];
}
function defectStrokeColor(k: DefectKind): string {
  return KIND_STROKE[k];
}
export { v3dist };
