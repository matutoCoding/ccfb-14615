// 构件建模页：三维模型浏览、构件树与自动编号、表面米制参数查看。
import { el, toast } from '../router';
import { appState } from '../state';
import { ModelViewer, type PickResult } from '../render/modelViewer';
import { runtime } from '../cache';
import type { ComponentDef } from '../core/types';

const CATEGORY_LABEL: Record<ComponentDef['category'], string> = {
  'main-girder': '主梁',
  diaphragm: '横隔板',
  'bent-cap': '盖梁',
  'pier-column': '墩柱',
  bearing: '支座',
  deck: '桥面系',
};

export async function renderModeling(_p: Record<string, string>, root: HTMLElement): Promise<void> {
  if (!appState.data.model) {
    root.append(el('div', { class: 'card muted' }, '请先在「桥梁档案」中新建或打开一座桥。'));
    return;
  }
  const model = appState.data.model;
  root.innerHTML = '';
  root.append(el('h2', {}, `构件建模 — ${model.spec.name}`));

  const info = el('div', { class: 'grid4' },
    stat('桥型', model.spec.type === 'simply-supported-t' ? '简支T梁' : model.spec.type === 'simply-supported-box' ? '简支小箱梁' : '连续箱梁'),
    stat('跨数 × 跨径', `${model.spec.spanCount} × ${model.spec.spanLengths[0]} m`),
    stat('构件总数', String(model.components.length)),
    stat('表面总数', String(model.components.reduce((a, c) => a + c.surfaces.length, 0))),
  );
  root.append(info);

  const wrap = el('div', { class: 'viewer-wrap' });
  const main = el('div', { class: 'viewer-main card' });
  const canvas = document.createElement('canvas');
  canvas.className = 'gl';
  canvas.style.height = '62vh';
  main.append(canvas);
  const hint = el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' },
    '左键拖拽旋转 · 滚轮缩放 · 单击构件拾取（显示编号与表面米制尺寸）');
  main.append(hint);

  const side = el('div', { class: 'viewer-side flex-col' });
  const detail = el('div', { class: 'card' }, el('div', { class: 'muted' }, '点击模型查看构件详情'));
  const tree = el('div', { class: 'card scrollbox' });
  tree.append(el('h3', {}, '构件树（自动编号）'));
  const groups = new Map<string, ComponentDef[]>();
  for (const c of model.components) {
    const arr = groups.get(c.category) ?? [];
    arr.push(c);
    groups.set(c.category, arr);
  }
  for (const [cat, comps] of groups) {
    tree.append(el('div', { style: 'margin:8px 0 4px;color:var(--fg-dim);font-size:12px' },
      `${CATEGORY_LABEL[cat as ComponentDef['category']]}（${comps.length}）`));
    const list = el('div', { class: 'pill-list' });
    for (const c of comps.slice(0, 40)) {
      const pill = el('div', { class: 'pill' }, el('span', {}, c.code), el('span', { class: 'muted' }, `${c.surfaces.length}面`));
      pill.addEventListener('click', () => {
        viewer.focusOn(c.id);
        showDetail(c);
      });
      list.append(pill);
    }
    if (comps.length > 40) list.append(el('div', { class: 'muted', style: 'font-size:12px' }, `…其余 ${comps.length - 40} 件略`));
    tree.append(list);
  }
  side.append(detail, tree);
  wrap.append(main, side);
  root.append(wrap);

  const viewer = new ModelViewer(canvas, model);
  const showDetail = (c: ComponentDef) => {
    detail.innerHTML = '';
    detail.append(
      el('h3', {}, c.code),
      el('div', { class: 'muted', style: 'margin-bottom:8px' }, `${c.name} · ${CATEGORY_LABEL[c.category]}`),
    );
    const tbl = document.createElement('table');
    tbl.innerHTML = '<thead><tr><th>表面</th><th>类型</th><th>宽×高 (m)</th></tr></thead>';
    const tb = document.createElement('tbody');
    for (const s of c.surfaces) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${s.name}<div class="muted mono" style="font-size:11px">${s.id}</div></td>
        <td>${s.kind === 'planar' ? '平面' : '圆柱面'}</td>
        <td class="mono">${s.width.toFixed(2)} × ${s.height.toFixed(2)}</td>`;
      tb.append(tr);
    }
    tbl.append(tb);
    detail.append(tbl);
    detail.append(el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' },
      `网格顶点 ${c.positions.length / 3}，三角形 ${c.indices.length / 3}；UV 为米制局部坐标，正射展开比例尺 = 实际尺寸。`));
  };
  viewer.onPick = (r: PickResult | null) => {
    if (!r) return;
    const c = model.components.find((x) => x.id === r.componentId);
    if (c) showDetail(c);
  };

  // 全局烘焙完成后自动上纹理
  const applyBake = () => {
    if (runtime.baked.size) viewer.setBakedTextures(runtime.baked);
    viewer.setDefects(runtime.defects);
  };
  applyBake();
  const unsub = appState.subscribe(() => {
    if (appState.data.bakeRevision) applyBake();
  });
  window.addEventListener('beforeunload', () => unsub(), { once: true });
  window.setTimeout(() => toast('模型已加载，单击构件可查看编号与表面参数', 'info', 2600), 400);
}

function stat(k: string, v: string): HTMLElement {
  return el('div', { class: 'kpi' }, el('div', { class: 'v', style: 'font-size:16px' }, v), el('div', { class: 'k' }, k));
}
