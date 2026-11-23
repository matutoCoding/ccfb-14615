// 页面五：复检对比 — 同构件两期正射病害图叠加、裂缝延伸量、新增/消退病害自动列表
import { store } from '../../core/store';
import { DefectRecord } from '../../types';
import { SurfaceDef } from '../../core/geometry';
import { h, clear, toast, downloadCanvas } from '../dom';
import { Viewer3D } from '../viewer3d';
import { renderOrthoWithDefects, OrthoResult } from '../ortho';
import { kindName } from '../../core/scoring';
import { polylineLengthMm } from '../../core/defectUtils';

interface CompareRow {
  kind: 'extended' | 'new' | 'gone' | 'stable';
  epoch1?: DefectRecord;
  epoch2?: DefectRecord;
  deltaMm?: number;
}

export function comparePage(root: HTMLElement): () => void {
  clear(root);
  const view = h('div', { class: 'viewport' });
  const side = h('div', { class: 'sidebar' });
  const wrap = h('div', { class: 'split split-h' }, side, view);
  root.append(wrap);
  const viewer = new Viewer3D(view);
  let slider: HTMLInputElement | null = null;
  let layerA: HTMLImageElement | null = null;
  let layerB: HTMLImageElement | null = null;

  const epochs = store.epochs;
  const e1 = epochs[0]?.id;
  const e2 = epochs[1]?.id ?? epochs[0]?.id;

  const renderSide = (): void => {
    clear(side);
    if (!store.bridge || epochs.length < 1) {
      side.append(h('div', { class: 'card muted' }, '需要桥梁档案和至少一个期次'));
      return;
    }
    const defectComps = [...new Set(store.defects.map((d) => d.componentId))];
    side.append(
      h('div', { class: 'card' },
        h('h3', {}, '对比期次'),
        h('div', { class: 'muted' }, `${epochs.find((x) => x.id === e1)?.name ?? '-'}  →  ${epochs.find((x) => x.id === e2)?.name ?? '-'}`),
      ),
      h('div', { class: 'card' },
        h('h3', {}, '选择构件/表面'),
        h('div', { class: 'pill-list', style: 'max-height:240px;overflow:auto' },
          ...defectComps.map((cid) => {
            const c = store.componentById(cid);
            return h('div', {
              class: `pill ${store.selectedComponentId === cid ? 'selected' : ''}`,
              onclick: () => { store.selectComponent(cid); },
            }, h('div', { style: 'font-weight:600' }, c?.code ?? cid),
              h('div', { class: 'muted', style: 'font-size:11px' }, c?.label ?? ''));
          }),
          defectComps.length === 0 ? h('div', { class: 'muted' }, '还没有病害记录') : null,
        ),
      ),
      summaryCard(),
    );
  };

  function summaryCard(): HTMLElement {
    if (!e1 || !e2) return h('div', { class: 'card muted' }, '需要两个期次');
    const d1 = store.defectsOfEpoch(e1);
    const d2 = store.defectsOfEpoch(e2);
    const rows = matchDefects(d1, d2);
    const extended = rows.filter((r) => r.kind === 'extended');
    const fresh = rows.filter((r) => r.kind === 'new');
    const gone = rows.filter((r) => r.kind === 'gone');
    return h('div', { class: 'card' },
      h('h3', {}, '变化自动识别'),
      h('div', { class: 'grid3' },
        h('div', { class: 'pill' }, h('div', { class: 'metric-big', style: 'color:var(--bad)' }, String(extended.length)), h('div', { class: 'muted' }, '裂缝延伸')),
        h('div', { class: 'pill' }, h('div', { class: 'metric-big', style: 'color:var(--accent2)' }, String(fresh.length)), h('div', { class: 'muted' }, '新增病害')),
        h('div', { class: 'pill' }, h('div', { class: 'metric-big', style: 'color:var(--muted)' }, String(gone.length)), h('div', { class: 'muted' }, '消退病害')),
      ),
      h('table', { style: 'margin-top:8px' },
        h('thead', {}, h('tr', {}, h('th', {}, '类型'), h('th', {}, '编号'), h('th', {}, '变化量'))),
        h('tbody', {},
          ...rows.map((r) => h('tr', {
            style: 'cursor:pointer',
            onclick: () => {
              const d = r.epoch2 ?? r.epoch1!;
              store.selectComponent(d.componentId);
            },
          },
            h('td', {}, h('span', { class: `tag ${r.kind === 'new' ? 'bad' : r.kind === 'extended' ? 'warn' : 'info'}` }, rowLabel(r.kind))),
            h('td', {}, (r.epoch2 ?? r.epoch1)?.code ?? '-'),
            h('td', { class: 'mono' }, r.deltaMm !== undefined ? `${r.deltaMm >= 0 ? '+' : ''}${(r.deltaMm / 1000).toFixed(3)}m` : '-'),
          )),
        ),
      ),
    );
  }

  const renderView = (): void => {
    clear(view);
    const cid = store.selectedComponentId;
    const cg = cid ? store.geometryById(cid) : null;
    if (!cid || !cg) {
      view.append(h('div', { class: 'overlay-hud' }, '选择一个有病害的构件展开正射病害图对比'));
      return;
    }
    const surfaces = cg.surfaces;
    const surfSel = h('select', {},
      ...surfaces.map((s, i) => h('option', { value: String(i) }, s.label)),
    ) as HTMLSelectElement;
    const toolbar = h('div', { class: 'overlay-tools', style: 'top:12px;right:12px;flex-direction:column' },
      surfSel,
      h('button', {
        onclick: () => {
          const img = layerA ?? layerB;
          if (img) downloadCanvas(`ortho-${store.componentById(cid)!.code}.png`, img as unknown as HTMLCanvasElement);
        },
      }, '导出PNG'),
      h('button', { onclick: () => { store.selectComponent(null); } }, '返回三维'),
    );
    const stack = h('div', { style: 'position:absolute;inset:60px 12px 12px;display:flex;align-items:center;justify-content:center;overflow:auto' });
    view.append(toolbar, stack);

    const draw = (): void => {
      const surf = surfaces[parseInt(surfSel.value, 10)] ?? surfaces[0];
      const defects1 = e1 ? store.defectsOfEpoch(e1).filter((d) => d.componentId === cid) : [];
      const defects2 = e2 ? store.defectsOfEpoch(e2).filter((d) => d.componentId === cid) : [];
      const r1 = renderOrthoWithDefects(viewer.renderer, cid, surf, defects1, 1200);
      const r2 = renderOrthoWithDefects(viewer.renderer, cid, surf, defects2, 1200);
      clear(stack);
      const box = h('div', { style: 'position:relative;' });
      layerA = h('img', { src: r1.canvas.toDataURL(), class: 'ortho', style: 'max-width:min(96%,1100px);display:block' }) as HTMLImageElement;
      layerB = h('img', {
        src: r2.canvas.toDataURL(), class: 'ortho',
        style: 'position:absolute;inset:0;width:100%;max-width:min(96%,1100px);mix-blend-mode:multiply;opacity:.55',
      }) as HTMLImageElement;
      slider = h('input', { type: 'range', min: '0', max: '100', value: '55', class: 'compare-slider', style: 'position:absolute;left:12px;right:12px;bottom:-34px' }) as HTMLInputElement;
      slider.addEventListener('input', () => {
        layerB!.style.opacity = String(parseInt(slider!.value, 10) / 100);
      });
      box.append(layerA, layerB, slider);
      stack.append(
        h('div', {},
          h('div', { class: 'legend', style: 'margin-bottom:6px' },
            h('span', {}, `底图：${epochs.find((x) => x.id === e1)?.name ?? '一期'}`),
            h('span', { style: 'color:var(--accent)' }, `叠加：${epochs.find((x) => x.id === e2)?.name ?? '二期'}（滑块调透明度）`),
          ),
          box,
          measurePanel(surf, r1, r2, defects1, defects2),
        ),
      );
    };
    surfSel.addEventListener('change', draw);
    draw();
  };

  function measurePanel(surf: SurfaceDef, r1: OrthoResult, r2: OrthoResult, d1: DefectRecord[], d2: DefectRecord[]): HTMLElement {
    const rows = matchDefects(d1, d2);
    return h('div', { class: 'card', style: 'margin-top:44px;max-width:1100px' },
      h('h3', {}, `表面 ${surf.label} · 比例尺 ${(1000 / r1.ppm).toFixed(2)} mm/像素`),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '病害'), h('th', {}, '一期长度m'), h('th', {}, '二期长度m'), h('th', {}, '延伸mm'), h('th', {}, '宽度mm'))),
        h('tbody', {},
          ...rows.map((r) => h('tr', {},
            h('td', {}, `${kindName(r.epoch2?.kind ?? r.epoch1!.kind)} ${(r.epoch2 ?? r.epoch1)!.code}`),
            h('td', { class: 'mono' }, r.epoch1 ? (r.epoch1.lengthMm / 1000).toFixed(3) : '-'),
            h('td', { class: 'mono' }, r.epoch2 ? (r.epoch2.lengthMm / 1000).toFixed(3) : '-'),
            h('td', { class: 'mono', style: r.deltaMm && r.deltaMm > 5 ? 'color:var(--bad);font-weight:700' : '' },
              r.deltaMm !== undefined ? r.deltaMm.toFixed(1) : '-'),
            h('td', { class: 'mono' }, (r.epoch2 ?? r.epoch1)?.widthMm?.toFixed(2) ?? '-'),
          )),
        ),
      ),
    );
  }

  const unsub = store.subscribe(() => {
    renderSide();
    renderView();
  });
  renderSide();
  renderView();
  toast('两期病害按构件局部坐标自动配准，不依赖照片像素位置');
  return () => {
    unsub();
    viewer.dispose();
  };
}

function rowLabel(k: CompareRow['kind']): string {
  return { extended: '延伸', new: '新增', gone: '消退', stable: '稳定' }[k];
}

// 同构件、同表面、同类型且局部坐标邻近的病害配对；predecessorId 优先
export function matchDefects(d1: DefectRecord[], d2: DefectRecord[]): CompareRow[] {
  const rows: CompareRow[] = [];
  const used2 = new Set<string>();
  for (const a of d1) {
    let b = d2.find((x) => x.predecessorId === a.id);
    if (!b) {
      b = d2.find((x) =>
        !used2.has(x.id) &&
        x.componentId === a.componentId &&
        x.surface === a.surface &&
        x.kind === a.kind &&
        localDistance(a, x) < 0.6
      );
    }
    if (b) {
      used2.add(b.id);
      const delta = b.lengthMm - a.lengthMm;
      rows.push({
        kind: delta > 5 ? 'extended' : 'stable',
        epoch1: a, epoch2: b, deltaMm: delta,
      });
    } else {
      rows.push({ kind: 'gone', epoch1: a });
    }
  }
  for (const b of d2) {
    if (!used2.has(b.id)) rows.push({ kind: 'new', epoch2: b, deltaMm: b.lengthMm });
  }
  return rows.sort((x, y) => (y.deltaMm ?? 0) - (x.deltaMm ?? 0));
}

function localDistance(a: DefectRecord, b: DefectRecord): number {
  const pa = a.points[Math.floor(a.points.length / 2)].local;
  const pb = b.points[Math.floor(b.points.length / 2)].local;
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
}

export { polylineLengthMm };
