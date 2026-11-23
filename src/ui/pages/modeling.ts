// 页面二：构件建模(三维浏览 + 构件树 + 编号 + 表面信息)
import { store } from '../../core/store';
import { partLabel } from '../../core/geometry';
import { h, clear, toast } from '../dom';
import { Viewer3D } from '../viewer3d';
import { PartKind } from '../../types';

export function modelingPage(root: HTMLElement): () => void {
  clear(root);
  const view = h('div', { class: 'viewport' });
  const side = h('div', { class: 'sidebar' });
  const wrap = h('div', { class: 'split split-h' }, side, view);
  root.append(wrap);
  const viewer = new Viewer3D(view);

  const renderSide = (): void => {
    clear(side);
    if (!store.bridge) {
      side.append(h('div', { class: 'card muted' }, '请先在「桥梁档案」页建桥'));
      return;
    }
    const parts: PartKind[] = ['main_girder', 'diaphragm', 'bearing', 'cap_beam', 'pier_column', 'abutment', 'deck'];
    side.append(
      h('div', { class: 'card' },
        h('h3', {}, '构件树'),
        h('div', { class: 'row' },
          h('button', { onclick: () => { viewer.showCameras = !viewer.showCameras; } }, '机位开关'),
          h('button', { onclick: () => { viewer.showDefects = !viewer.showDefects; } }, '病害开关'),
          h('button', { class: 'warn', onclick: () => { viewer.renderer.resetBake(); toast('已清空投影纹理'); } }, '清空贴图'),
        ),
        ...parts.map((part) => {
          const comps = store.components.filter((c) => c.part === part);
          if (!comps.length) return null;
          return h('div', { style: 'margin-bottom:10px' },
            h('div', { class: 'muted', style: 'margin:6px 0' }, `${partLabel(part)} (${comps.length})`),
            h('div', { class: 'pill-list' },
              ...comps.slice(0, 40).map((c) =>
                h('div', {
                  class: `pill ${store.selectedComponentId === c.id ? 'selected' : ''}`,
                  onclick: () => {
                    store.selectComponent(c.id);
                    const g = store.geometryById(c.id);
                    if (g) {
                      const bb = g.bbox;
                      viewer.controls.frameTarget(
                        (bb.min[0] + bb.max[0]) / 2,
                        (bb.min[1] + bb.max[1]) / 2,
                        (bb.min[2] + bb.max[2]) / 2,
                        Math.max(6, bb.max[0] - bb.min[0]) * 1.6
                      );
                    }
                  },
                }, h('div', { style: 'font-weight:600' }, c.code), h('div', { class: 'muted', style: 'font-size:11px' }, c.label)),
              ),
              comps.length > 40 ? h('div', { class: 'muted' }, `…其余 ${comps.length - 40} 件省略`) : null,
            ),
          );
        }),
      ),
      detailCard(),
    );
  };

  function detailCard(): HTMLElement {
    const c = store.componentById(store.selectedComponentId);
    if (!c) return h('div', { class: 'card muted' }, '在三维视图或构件树中点选一个构件');
    const g = store.geometryById(c.id)!;
    const bb = g.bbox;
    return h('div', { class: 'card' },
      h('h3', {}, `构件 ${c.code}`),
      h('table', {}, h('tbody', {},
        h('tr', {}, h('td', { class: 'muted' }, '名称'), h('td', {}, c.label)),
        h('tr', {}, h('td', { class: 'muted' }, '跨号/梁号'), h('td', {}, `${c.spanNo} / ${c.girderNo}`)),
        h('tr', {}, h('td', { class: 'muted' }, '包围盒'), h('td', { class: 'mono' },
          `${(bb.max[0] - bb.min[0]).toFixed(2)} × ${(bb.max[1] - bb.min[1]).toFixed(2)} × ${(bb.max[2] - bb.min[2]).toFixed(2)} m`)),
        h('tr', {}, h('td', { class: 'muted' }, '三角面'), h('td', { class: 'mono' }, String(g.mesh.indices.length / 3))),
      )),
      h('div', { class: 'muted', style: 'margin:8px 0 4px' }, '可展开表面(正射病害图用)'),
      h('div', { class: 'pill-list' },
        ...g.surfaces.map((s) =>
          h('div', { class: 'pill' },
            h('div', { style: 'font-weight:600' }, s.label),
            h('div', { class: 'muted mono', style: 'font-size:11px' },
              `${s.name} · ${(s.uRange[1] - s.uRange[0]).toFixed(2)}m × ${(s.vRange[1] - s.vRange[0]).toFixed(2)}m`),
          ),
        ),
        g.surfaces.length === 0 ? h('div', { class: 'muted' }, '该构件无展开面') : null,
      ),
    );
  }

  viewer.onPick((id) => {
    if (id) store.selectComponent(id);
  });
  const unsub = store.subscribe(renderSide);
  renderSide();

  return () => {
    unsub();
    viewer.dispose();
  };
}
