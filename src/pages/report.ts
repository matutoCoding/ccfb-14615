// 检测报告页：构件->部件->部位->全桥评分，扣分明细点击跳回三维，支持打印。
import { el, toast } from '../router';
import { appState } from '../state';
import { defectRepo, ratingRepo } from '../core/db';
import { gradeLabel, rateBridge, RATING_META } from '../services/rating';
import type { SeverityClass } from '../core/types';

export async function renderReport(_p: Record<string, string>, root: HTMLElement): Promise<void> {
  if (!appState.data.model) {
    root.append(el('div', { class: 'card muted' }, '请先打开一座桥。'));
    return;
  }
  const model = appState.data.model;
  await appState.refreshEpochs();
  const epochs = appState.data.epochs;
  root.innerHTML = '';
  root.append(el('h2', {}, '检测报告与技术状况评定'));
  if (!epochs.length) {
    root.append(el('div', { class: 'card muted' }, '尚无检测期。'));
    return;
  }

  const bar = el('div', { class: 'card row' });
  const sel = document.createElement('select');
  sel.style.width = '260px';
  sel.innerHTML = epochs.map((e) => `<option value="${e.id}" ${e.id === appState.epochId ? 'selected' : ''}>${e.date} ${e.name}</option>`).join('');
  const btn = el('button', { class: 'primary' }, '重新评定');
  const print = el('button', {}, '打印 / 导出 PDF');
  bar.append(el('strong', {}, '检测期：'), sel, btn, el('div', { class: 'spacer' }), print);
  root.append(bar);

  const reportHost = el('div', {});
  root.append(reportHost);

  const renderReport = async () => {
    const epochId = sel.value;
    const epoch = epochs.find((e) => e.id === epochId)!;
    const defects = (await defectRepo.all()).filter((d) => d.epochId === epochId);
    const { rating, componentScores } = rateBridge(model, epochId, defects);
    await ratingRepo.put(rating);

    reportHost.innerHTML = '';
    const page = el('div', { class: 'report-page' });
    const gradeColor = (g: SeverityClass) => ['#1a7f4b', '#3d8b40', '#b8860b', '#c25a1e', '#b3261e'][g - 1];

    page.innerHTML = `
      <h2 style="text-align:center">桥梁技术状况检测报告</h2>
      <table style="margin:10px 0">
        <tr><th style="width:130px">桥梁名称</th><td>${model.spec.name}</td><th style="width:110px">桥梁编号</th><td>${model.spec.code}</td></tr>
        <tr><th>桥型/跨径</th><td>${model.spec.spanCount}×${model.spec.spanLengths[0]} m</td><th>检测日期</th><td>${epoch.date}</td></tr>
        <tr><th>检测期</th><td>${epoch.name}</td><th>评定依据</th><td>${RATING_META.standard}</td></tr>
      </table>
      <div style="display:flex;gap:26px;align-items:center;margin:18px 0">
        <div>全桥技术状况评分：<b style="font-size:34px">${rating.totalScore.toFixed(1)}</b> / 100</div>
        <div>评定等级：<b style="font-size:26px;color:${gradeColor(rating.grade)}">${gradeLabel(rating.grade)}</b></div>
      </div>`;

    // 部位评分
    const partTbl = document.createElement('table');
    partTbl.innerHTML = `<thead><tr><th>部位</th><th>权重</th><th>评分</th><th>等级</th><th>含构件数</th></tr></thead>`;
    const ptb = document.createElement('tbody');
    const partName: Record<string, string> = { superstructure: '上部结构', substructure: '下部结构', deck: '桥面系' };
    for (const part of rating.parts) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${partName[part.part]}</td>
        <td class="mono">${(RATING_META.partWeight[part.part] * 100).toFixed(0)}%</td>
        <td class="mono"><b>${part.score.toFixed(1)}</b></td>
        <td style="color:${gradeColor(part.grade)}">${gradeLabel(part.grade)}</td>
        <td class="badge-num">${part.componentScores.length}</td>`;
      ptb.append(tr);
    }
    partTbl.append(ptb);
    page.append(el('h3', { style: 'color:#111' }, '一、部位评定结果'), partTbl);

    // 构件评分与扣分明细（可点回三维）
    page.append(el('h3', { style: 'color:#111' }, '二、构件评分与扣分明细（点击病害行可跳转三维定位）'));
    const compTbl = document.createElement('table');
    compTbl.innerHTML = `<thead><tr><th>构件编号</th><th>类型</th><th>评分</th><th>等级</th><th>扣分明细</th></tr></thead>`;
    const ctb = document.createElement('tbody');
    const catName: Record<string, string> = {
      'main-girder': '主梁', diaphragm: '横隔板', 'bent-cap': '盖梁',
      'pier-column': '墩柱', bearing: '支座', deck: '桥面系',
    };
    for (const cs of componentScores) {
      const comp = model.components.find((c) => c.id === cs.componentId)!;
      const tr = document.createElement('tr');
      const tdDeduct = document.createElement('td');
      if (!cs.deductions.length) {
        tdDeduct.textContent = '无病害，满分';
      } else {
        for (const dd of cs.deductions) {
          const defect = defects.find((d) => d.id === dd.defectId)!;
          const link = el('div', { class: 'clickable', style: 'margin:2px 0' }, `${dd.reason}`);
          link.addEventListener('click', () => {
            appState.focusComponent(comp.id, defect.points[0].surfaceId, defect.points[0].u, defect.points[0].v);
            location.hash = '#/modeling';
            toast('已在三维视图定位该病害位置', 'ok');
          });
          tdDeduct.append(link);
        }
      }
      tr.innerHTML = `<td class="mono">${comp.code}</td><td>${catName[comp.category]}</td>
        <td class="mono"><b>${cs.score.toFixed(1)}</b></td>
        <td style="color:${gradeColor(cs.grade)}">${cs.grade}类</td>`;
      tr.append(tdDeduct);
      ctb.append(tr);
    }
    compTbl.append(ctb);
    page.append(compTbl);

    // 病害清单
    page.append(el('h3', { style: 'color:#111' }, '三、病害清单'));
    const dTbl = document.createElement('table');
    dTbl.innerHTML = `<thead><tr><th>病害号</th><th>构件</th><th>类型</th><th>长度(m)</th><th>面积(m²)</th><th>缝宽(mm)</th><th>标度</th><th>描述</th></tr></thead>`;
    const dtb = document.createElement('tbody');
    for (const d of defects) {
      const comp = model.components.find((c) => c.id === d.componentId);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="mono">${d.id}</td><td>${comp?.code ?? ''}</td><td>${d.description.split('（')[0]}</td>
        <td class="mono">${d.lengthM ? d.lengthM.toFixed(3) : '—'}</td>
        <td class="mono">${d.areaM2 ? d.areaM2.toFixed(3) : '—'}</td>
        <td class="mono">${d.widthMm ? d.widthMm.toFixed(2) : '—'}</td>
        <td class="badge-num">${d.severity}</td><td>${d.description}</td>`;
      dtb.append(tr);
    }
    dTbl.append(dtb);
    page.append(dTbl);

    page.append(el('div', { style: 'margin-top:26px;color:#555;font-size:12px' },
      `报告由桥梁病害照片配准与三维贴图系统自动生成 · 评分方法：构件修正扣分 U=ΣUᵢ/(√x·100)·(100-Umax)+Umax，部件等权平均，全桥 D_r=Σ 部位分×权重。`));
    reportHost.append(page);
  };

  btn.addEventListener('click', renderReport);
  sel.addEventListener('change', renderReport);
  print.addEventListener('click', () => window.print());
  await renderReport();
}
