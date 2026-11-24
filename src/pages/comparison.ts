// 复检对比页：选两期检测 -> 同构件同表面正射病害图叠加（实线/虚线）-> 自动列变化。
import { el, toast } from '../router';
import { appState } from '../state';
import { runtime } from '../cache';
import { comparisonRepo, defectRepo } from '../core/db';
import type { DefectRecord } from '../core/types';
import { compareEpochs } from '../services/defectService';
import { OrthoView } from '../render/orthoView';

export async function renderComparison(_p: Record<string, string>, root: HTMLElement): Promise<void> {
  if (!appState.data.model) {
    root.append(el('div', { class: 'card muted' }, '请先打开一座桥。'));
    return;
  }
  const model = appState.data.model;
  await appState.refreshEpochs();
  const epochs = appState.data.epochs;
  root.innerHTML = '';
  root.append(el('h2', {}, '复检对比'));
  if (epochs.length < 2) {
    root.append(el('div', { class: 'card muted' }, '需要至少两个检测期。请先在「精度自测」生成两期合成数据。'));
    return;
  }

  const bar = el('div', { class: 'card row' });
  const selA = document.createElement('select');
  const selB = document.createElement('select');
  for (const s of [selA, selB]) {
    s.style.width = '240px';
    s.innerHTML = epochs.map((e) => `<option value="${e.id}">${e.date} ${e.name}</option>`).join('');
  }
  selB.selectedIndex = Math.min(1, epochs.length - 1);
  const btn = el('button', { class: 'primary' }, '执行对比分析');
  bar.append(el('strong', {}, '一期：'), selA, el('strong', { style: 'margin-left:14px' }, '二期：'), selB, btn);
  root.append(bar);

  const summaryCard = el('div', { class: 'card' });
  const changeCard = el('div', { class: 'card' });
  const orthoHost = el('div', { class: 'card' });
  root.append(summaryCard, changeCard, orthoHost);

  btn.addEventListener('click', async () => {
    const id = `cmp:${selA.value}->${selB.value}`;
    const [defA, defB] = await Promise.all([
      defectRepo.all().then((r) => r.filter((d) => d.epochId === selA.value)),
      defectRepo.all().then((r) => r.filter((d) => d.epochId === selB.value)),
    ]);
    const { comparison, stats } = compareEpochs(model, id, appState.data.bridgeId!, selA.value, selB.value, defA, defB);
    await comparisonRepo.put(comparison);

    summaryCard.innerHTML = '';
    summaryCard.append(
      el('h3', {}, '对比汇总'),
      el('div', { class: 'grid3' },
        kpi('成功匹配裂缝', stats.matched, ''),
        kpi('延伸裂缝', stats.extended, stats.extended ? 'warn' : 'good'),
        kpi('新增病害', stats.newCount, stats.newCount ? 'bad' : 'good'),
      ),
    );

    changeCard.innerHTML = '';
    changeCard.append(el('h3', {}, '变化明细（点击在三维/正射图定位）'));
    const tbl = document.createElement('table');
    tbl.innerHTML = `<thead><tr><th>类型</th><th>构件</th><th>说明</th><th>延伸量(mm)</th></tr></thead>`;
    const tb = document.createElement('tbody');
    for (const ch of comparison.changes) {
      const comp = model.components.find((c) => c.id === ch.componentId)!;
      const tr = document.createElement('tr');
      const tag = ch.kind === 'new' ? '<span class="tag bad">新增</span>'
        : ch.kind === 'extended' ? '<span class="tag warn">延伸</span>'
          : '<span class="tag ok">稳定</span>';
      tr.innerHTML = `<td>${tag}</td><td>${comp.code}</td><td>${ch.description}</td>
        <td class="badge-num">${ch.extensionM ? (ch.extensionM * 1000).toFixed(0) : '—'}</td>`;
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => showOrtho(ch.componentId, ch.surfaceId, defA, defB));
      tb.append(tr);
    }
    tbl.append(tb);
    changeCard.append(tbl);

    // 默认展示第一个有变化的构件
    const first = comparison.changes.find((c) => c.kind !== 'unchanged') ?? comparison.changes[0];
    if (first) showOrtho(first.componentId, first.surfaceId, defA, defB);
    toast('对比分析完成', 'ok');
  });

  function showOrtho(componentId: string, surfaceId: string, defA: DefectRecord[], defB: DefectRecord[]): void {
    const comp = model.components.find((c) => c.id === componentId)!;
    const surf = comp.surfaces.find((s) => s.id === surfaceId) ?? comp.surfaces[0];
    orthoHost.innerHTML = '';
    orthoHost.append(
      el('h3', {}, `${comp.code} · ${surf.name} — 两期正射病害图叠加`),
      el('div', { class: 'legend', style: 'margin-bottom:10px' },
        el('span', {}, '<i style="background:#ff5a5a"></i>一期病害（实线）'),
        el('span', {}, '<i style="background:#4dffd2"></i>二期病害（虚线）'),
      ),
    );
    const baked = runtime.baked.get(surf.id) ?? null;
    const view = new OrthoView(
      comp, surf, baked,
      defA.filter((d) => d.componentId === comp.id),
      { compareOverlay: defB.filter((d) => d.componentId === comp.id) },
    );
    orthoHost.append(view.canvas);
    orthoHost.append(el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' },
      '匹配方法：同构件同表面、采样点平均距离 < 30mm 视为同一裂缝；延伸量 = 两期长度差。'));
  }
}

function kpi(k: string, v: number, cls: string): HTMLElement {
  return el('div', { class: `kpi ${cls}` }, el('div', { class: 'v badge-num' }, String(v)), el('div', { class: 'k' }, k));
}
