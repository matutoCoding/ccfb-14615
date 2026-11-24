// 桥梁档案页：桥梁列表、新建（按桥型参数化）、切换、删除。
import { el, modal, navigate, toast } from '../router';
import { appState } from '../state';
import type { BridgeSpec, BridgeType } from '../core/types';
import { loadBridgeArchive, wipeAll, kvDelete } from '../core/db';

const TYPE_LABEL: Record<BridgeType, string> = {
  'simply-supported-t': '简支 T 梁桥',
  'simply-supported-box': '简支小箱梁桥',
  'continuous-box': '连续箱梁桥',
};

function specForm(defaults: Partial<BridgeSpec>): HTMLFormElement {
  const f = document.createElement('form');
  f.innerHTML = `
    <div class="grid2">
      <div><label>桥梁名称</label><input name="name" value="${defaults.name ?? ''}" required></div>
      <div><label>桥梁编号</label><input name="code" value="${defaults.code ?? ''}" required></div>
      <div><label>桥型</label><select name="type">
        ${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${defaults.type === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select></div>
      <div><label>跨数</label><input name="spanCount" type="number" min="1" max="8" value="${defaults.spanCount ?? 3}"></div>
      <div><label>每跨跨径（米，逗号分隔）</label><input name="spanLengths" value="${(defaults.spanLengths ?? [20, 20, 20]).join(',')}"></div>
      <div><label>每跨主梁片数</label><input name="girderCount" type="number" min="2" max="8" value="${defaults.girderCount ?? 4}"></div>
      <div><label>桥面宽度（m）</label><input name="deckWidth" type="number" step="0.1" value="${defaults.deckWidth ?? 12}"></div>
      <div><label>梁高（m）</label><input name="girderHeight" type="number" step="0.05" value="${defaults.girderHeight ?? 1.2}"></div>
      <div><label>小箱梁顶板宽（m）</label><input name="boxTopWidth" type="number" step="0.05" value="${defaults.boxTopWidth ?? 2.7}"></div>
      <div><label>小箱梁底板宽（m）</label><input name="boxBottomWidth" type="number" step="0.05" value="${defaults.boxBottomWidth ?? 1.5}"></div>
      <div><label>T 梁翼缘宽（m）</label><input name="flangeWidth" type="number" step="0.05" value="${defaults.flangeWidth ?? 2.6}"></div>
      <div><label>腹板厚（m）</label><input name="webThickness" type="number" step="0.01" value="${defaults.webThickness ?? 0.18}"></div>
      <div><label>每跨横隔板数（不含端隔板）</label><input name="diaphragmCount" type="number" value="${defaults.diaphragmCount ?? 2}"></div>
      <div><label>墩柱高度（m，逗号分隔）</label><input name="pierHeight" value="${(defaults.pierHeight ?? [4.5, 4.2]).join(',')}"></div>
      <div><label>每墩柱数</label><input name="pierColumns" type="number" value="${defaults.pierColumns ?? 2}"></div>
      <div><label>墩柱直径（m）</label><input name="columnDiameter" type="number" step="0.1" value="${defaults.columnDiameter ?? 1.1}"></div>
      <div><label>盖梁宽（m）</label><input name="capWidth" type="number" step="0.1" value="${defaults.capWidth ?? 1.6}"></div>
      <div><label>盖梁高（m）</label><input name="capHeight" type="number" step="0.1" value="${defaults.capHeight ?? 1.3}"></div>
      <div><label>桥址经度</label><input name="originLon" type="number" step="0.000001" value="${defaults.originLon ?? 116.391}"></div>
      <div><label>桥址纬度</label><input name="originLat" type="number" step="0.000001" value="${defaults.originLat ?? 39.907}"></div>
    </div>`;
  return f;
}

function readForm(f: HTMLFormElement): BridgeSpec {
  const fd = new FormData(f);
  const num = (k: string) => parseFloat(String(fd.get(k) ?? '0'));
  const nums = (k: string) => String(fd.get(k) ?? '').split(/[,，]/).map((s) => parseFloat(s.trim())).filter(Number.isFinite);
  const spanCount = num('spanCount');
  const spanLengths = nums('spanLengths');
  while (spanLengths.length < spanCount) spanLengths.push(spanLengths[spanLengths.length - 1] ?? 20);
  const pierHeight = nums('pierHeight');
  while (pierHeight.length < Math.max(1, spanCount - 1)) pierHeight.push(pierHeight[pierHeight.length - 1] ?? 4.5);
  return {
    id: `bridge-${Date.now().toString(36)}`,
    name: String(fd.get('name')),
    code: String(fd.get('code')),
    type: String(fd.get('type')) as BridgeType,
    spanCount,
    spanLengths: spanLengths.slice(0, spanCount),
    girderCount: num('girderCount'),
    deckWidth: num('deckWidth'),
    girderHeight: num('girderHeight'),
    boxTopWidth: num('boxTopWidth'),
    boxBottomWidth: num('boxBottomWidth'),
    flangeWidth: num('flangeWidth'),
    webThickness: num('webThickness'),
    diaphragmCount: num('diaphragmCount'),
    pierHeight: pierHeight.slice(0, Math.max(1, spanCount - 1)),
    pierColumns: num('pierColumns'),
    columnDiameter: num('columnDiameter'),
    capWidth: num('capWidth'),
    capHeight: num('capHeight'),
    originLon: num('originLon'),
    originLat: num('originLat'),
    createdAt: Date.now(),
  };
}

export async function renderArchive(_p: Record<string, string>, root: HTMLElement): Promise<void> {
  root.innerHTML = '';
  const archives = await appState.listArchives();
  const head = el('div', { class: 'row' },
    el('h2', {}, '桥梁档案'),
    el('div', { class: 'spacer' }),
    (() => {
      const b = el('button', { class: 'primary' }, '＋ 新建桥梁');
      b.addEventListener('click', () => openCreate());
      return b;
    })(),
    (() => {
      const b = el('button', { class: 'danger' }, '清空全部数据');
      b.addEventListener('click', async () => {
        if (!confirm('确认清空 IndexedDB 中的全部桥梁、照片与病害数据？')) return;
        await wipeAll();
        appState.data.bridgeId = null;
        appState.data.model = null;
        appState.data.spec = null;
        toast('已清空全部数据', 'ok');
        renderArchive({}, root);
      });
      return b;
    })(),
  );
  root.append(head);

  if (!archives.length) {
    root.append(el('div', { class: 'card muted' },
      '暂无桥梁档案。点击「新建桥梁」按桥型录入跨径、跨数、梁片数，系统将自动参数化生成主梁、横隔板、盖梁、墩柱与支座。'));
    return;
  }

  const card = el('div', { class: 'card' });
  const table = document.createElement('table');
  table.innerHTML = `<thead><tr>
    <th>桥梁编号</th><th>名称</th><th>桥型</th><th>跨径布置</th><th>构件数</th><th>创建时间</th><th>操作</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const a of archives) {
    const s = a.spec;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${s.code}</td>
      <td>${s.name}${appState.data.bridgeId === s.id ? ' <span class="tag info">当前</span>' : ''}</td>
      <td>${TYPE_LABEL[s.type]}</td>
      <td class="mono">${s.spanCount}×${s.spanLengths[0]}m</td>
      <td class="badge-num">${a.componentOrder.length}</td>
      <td>${new Date(s.createdAt).toLocaleString('zh-CN')}</td>
      <td></td>`;
    const td = tr.lastElementChild as HTMLElement;
    const open = el('button', { class: 'small primary' }, '打开');
    open.addEventListener('click', async () => {
      await appState.loadBridge(s.id);
      toast(`已打开 ${s.name}`, 'ok');
      navigate('#/modeling');
    });
    const del = el('button', { class: 'small danger' }, '删除');
    del.addEventListener('click', async () => {
      if (!confirm(`确认删除桥梁「${s.name}」及其全部数据？`)) return;
      await kvDelete(`bridge:${s.id}`);
      toast('已删除', 'ok');
      renderArchive({}, root);
    });
    td.append(open, del);
    tbody.append(tr);
  }
  table.append(tbody);
  card.append(table);
  root.append(card);

  // 统计卡片
  const model = appState.data.model;
  if (model) {
    const count = (cat: string) => model.components.filter((c) => c.category === cat).length;
    root.append(el('div', { class: 'grid4' },
      kpi('主梁', count('main-girder')),
      kpi('横隔板', count('diaphragm')),
      kpi('盖梁/墩柱/支座', count('bent-cap') + count('pier-column') + count('bearing')),
      kpi('控制点', model.fiducials.length),
    ));
  }
}

function kpi(k: string, v: number): HTMLElement {
  return el('div', { class: 'kpi' }, el('div', { class: 'v badge-num' }, String(v)), el('div', { class: 'k' }, k));
}

function openCreate(): void {
  const form = specForm({});
  const close = modal('新建桥梁（参数化建模）', form, undefined as never);
  const footer = el('div', { class: 'row', style: 'margin-top:14px;justify-content:flex-end' });
  const cancel = el('button', {}, '取消');
  cancel.addEventListener('click', close);
  const ok = el('button', { class: 'primary' }, '生成构件并保存');
  ok.addEventListener('click', async () => {
    try {
      const spec = readForm(form);
      await appState.createBridge(spec);
      close();
      toast(`已生成 ${appState.model.components.length} 个构件`, 'ok');
      navigate('#/modeling');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  });
  footer.append(cancel, ok);
  document.querySelector('.modal')?.append(footer);
}
