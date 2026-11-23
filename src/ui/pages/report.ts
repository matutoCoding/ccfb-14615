// 页面六：检测报告 — 构件/部件/上部/全桥评分，扣分明细点回三维，导出 JSON/Markdown
import { store } from '../../core/store';
import { scoreBridge, GRADE_NAMES, kindName } from '../../core/scoring';
import { BridgeScore, PartKind } from '../../types';
import { partLabel } from '../../core/geometry';
import { db } from '../../core/db';
import { h, clear, toast, download, fmt } from '../dom';
import { Viewer3D } from '../viewer3d';

export function reportPage(root: HTMLElement): () => void {
  clear(root);
  const view = h('div', { class: 'viewport' });
  const side = h('div', { class: 'sidebar' });
  const wrap = h('div', { class: 'split split-h' }, side, view);
  root.append(wrap);
  const viewer = new Viewer3D(view);

  const render = (): void => {
    clear(side);
    if (!store.bridge || !store.currentEpochId) {
      side.append(h('div', { class: 'card muted' }, '需要桥梁和期次数据'));
      return;
    }
    const defects = store.defectsOfEpoch(store.currentEpochId);
    const score = scoreBridge(store.currentEpochId, store.components, defects);
    db.saveScore(score);
    side.append(
      h('div', { class: 'card' },
        h('h3', {}, '期次'),
        h('select', {
          onchange: (e: Event) => store.setEpoch((e.target as HTMLSelectElement).value),
        }, ...store.epochs.map((ep) => h('option', { value: ep.id, selected: ep.id === store.currentEpochId }, `${ep.name} (${ep.date})`))),
      ),
      overallCard(score),
      partCard(score),
      componentCard(score),
      exportCard(score),
    );
  };

  function overallCard(s: BridgeScore): HTMLElement {
    const cell = (title: string, score: number): HTMLElement =>
      h('div', { class: 'pill', style: 'text-align:center' },
        h('div', { class: 'muted' }, title),
        h('div', { class: `metric-big score-${s.overallGrade}` }, fmt(score, 1)),
        h('div', { class: 'muted', style: 'font-size:11px' }, GRADE_NAMES[gradeOf(score)]));
    return h('div', { class: 'card' },
      h('h3', {}, '全桥技术状况'),
      h('div', { class: 'grid3' },
        cell('桥面系', s.deckScore),
        cell('上部结构', s.superScore),
        cell('下部结构', s.subScore),
      ),
      h('div', { style: 'margin-top:10px;text-align:center' },
        h('span', { class: `tag info`, style: 'font-size:14px;padding:6px 16px' },
          `全桥评分 ${fmt(s.overallScore, 1)} · ${GRADE_NAMES[s.overallGrade]}`)),
    );
  }
  function gradeOf(score: number): 1 | 2 | 3 | 4 | 5 {
    if (score >= 95) return 1;
    if (score >= 80) return 2;
    if (score >= 60) return 3;
    if (score >= 40) return 4;
    return 5;
  }

  function partCard(s: BridgeScore): HTMLElement {
    return h('div', { class: 'card' },
      h('h3', {}, '部件得分'),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '部件'), h('th', {}, '构件数'), h('th', {}, '得分'), h('th', {}, '等级'))),
        h('tbody', {},
          ...s.parts.map((p) => h('tr', {},
            h('td', {}, partLabel(p.part as PartKind)),
            h('td', { class: 'mono' }, String(p.componentCount)),
            h('td', { class: 'mono' }, fmt(p.score, 1)),
            h('td', {}, h('span', { class: `tag ${p.grade <= 2 ? 'ok' : p.grade === 3 ? 'warn' : 'bad'}` }, GRADE_NAMES[p.grade])),
          )),
        ),
      ),
    );
  }

  function componentCard(s: BridgeScore): HTMLElement {
    const withDeductions = s.components.filter((c) => c.items.length > 0);
    return h('div', { class: 'card' },
      h('h3', {}, `扣分明细 (${withDeductions.length} 个构件有病害)`),
      h('div', { class: 'pill-list', style: 'max-height:340px;overflow:auto' },
        ...withDeductions.map((cs) => {
          const comp = store.componentById(cs.componentId)!;
          return h('div', { class: 'pill' },
            h('div', { style: 'display:flex;justify-content:space-between;align-items:center' },
              h('span', { style: 'font-weight:600' }, `${comp.code} · ${partLabel(comp.part)}`),
              h('span', { class: `tag ${cs.grade <= 2 ? 'ok' : cs.grade === 3 ? 'warn' : 'bad'}` }, `${fmt(cs.score, 1)}分`),
            ),
            h('table', { style: 'margin-top:6px' },
              h('tbody', {},
                ...cs.items.map((it) => h('tr', {
                  style: 'cursor:pointer',
                  title: '点击在三维中定位该病害',
                  onclick: () => locateDefect(it.defectId),
                },
                  h('td', {}, kindName(it.kind)),
                  h('td', {}, `标度${it.scale}`),
                  h('td', { class: 'mono' }, `-${fmt(it.adjusted, 1)}`),
                  h('td', { class: 'muted', style: 'font-size:11px' }, '↗定位'),
                )),
              ),
            ),
          );
        }),
        withDeductions.length === 0 ? h('div', { class: 'muted' }, '本期无扣分，全桥完好') : null,
      ),
    );
  }

  function locateDefect(defectId: string): void {
    const d = store.defects.find((x) => x.id === defectId);
    if (!d) return;
    store.selectComponent(d.componentId);
    const p = d.points[0].world;
    viewer.controls.frameTarget(p[0], p[1], p[2], 5);
    viewer.extraPoints = d.points.map((pt) => ({ pos: pt.world, color: [1, 0.3, 0.2, 1], size: 10 }));
    toast(`已定位到 ${d.code}`);
  }

  function exportCard(s: BridgeScore): HTMLElement {
    return h('div', { class: 'card' },
      h('h3', {}, '报告导出'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => exportMarkdown(s) }, '导出 Markdown 报告'),
        h('button', { onclick: () => download(`score-${store.currentEpoch!.id}.json`, JSON.stringify(s, null, 2)) }, '导出评分JSON'),
      ),
    );
  }

  function exportMarkdown(s: BridgeScore): void {
    const b = store.bridge!;
    const ep = store.currentEpoch!;
    const lines: string[] = [];
    lines.push(`# ${b.spec.name} 技术状况检测报告`);
    lines.push('');
    lines.push(`- 档案号：${b.id}`);
    lines.push(`- 期次：${ep.name}（${ep.date}）`);
    lines.push(`- 桥型：${b.spec.type}，${b.spec.spanCount} 跨，跨径 ${b.spec.spanLengths.join('+')}m，${b.spec.girderCount} 片梁/跨`);
    lines.push(`- 照片总数：${store.photosOfEpoch(ep.id).length}，已配准：${store.photosOfEpoch(ep.id).filter((p) => p.status === 'registered').length}`);
    lines.push('');
    lines.push('## 总体评定');
    lines.push('');
    lines.push(`| 桥面系 | 上部结构 | 下部结构 | 全桥评分 | 等级 |`);
    lines.push('|---|---|---|---|---|');
    lines.push(`| ${fmt(s.deckScore, 1)} | ${fmt(s.superScore, 1)} | ${fmt(s.subScore, 1)} | ${fmt(s.overallScore, 1)} | ${GRADE_NAMES[s.overallGrade]} |`);
    lines.push('');
    lines.push('## 部件得分');
    lines.push('');
    lines.push('| 部件 | 构件数 | 得分 | 等级 |');
    lines.push('|---|---|---|---|');
    for (const p of s.parts) lines.push(`| ${partLabel(p.part)} | ${p.componentCount} | ${fmt(p.score, 1)} | ${GRADE_NAMES[p.grade]} |`);
    lines.push('');
    lines.push('## 病害与扣分明细');
    lines.push('');
    for (const cs of s.components.filter((c) => c.items.length)) {
      const comp = store.componentById(cs.componentId)!;
      lines.push(`### ${comp.code} ${partLabel(comp.part)}（${fmt(cs.score, 1)} 分）`);
      for (const it of cs.items) {
        const d = store.defects.find((x) => x.id === it.defectId);
        lines.push(`- ${kindName(it.kind)} ${d?.code ?? it.defectId}：标度 ${it.scale}，扣分 ${fmt(it.adjusted, 1)}，长 ${fmt((d?.lengthMm ?? 0) / 1000, 2)}m${d?.widthMm ? `，宽 ${fmt(d.widthMm, 2)}mm` : ''}`);
      }
      lines.push('');
    }
    download(`检测报告-${b.spec.name}-${ep.date}.md`, lines.join('\n'), 'text/markdown');
    toast('报告已导出');
  }

  const unsub = store.subscribe(render);
  render();
  return () => {
    unsub();
    viewer.dispose();
  };
}
