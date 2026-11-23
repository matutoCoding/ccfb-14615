// 页面一：桥梁档案
import { BridgeSpec, BridgeType } from '../../types';
import { db } from '../../core/db';
import { store } from '../../core/store';
import { h, clear, toast } from '../dom';

const TYPE_LABEL: Record<BridgeType, string> = {
  T_GIRDER: '简支T梁',
  BOX_SMALL: '小箱梁',
  BOX_CONT: '连续箱梁',
};

export function archivePage(root: HTMLElement): () => void {
  const render = async (): Promise<void> => {
    const bridges = await db.listBridges();
    const side = h('div', { class: 'sidebar' },
      h('div', { class: 'card' },
        h('h3', {}, '新建桥梁档案'),
        buildForm(),
      ),
      h('div', { class: 'card' },
        h('h3', {}, '档案列表'),
        h('div', { class: 'pill-list' },
          ...bridges.map((b) =>
            h('div', {
              class: `pill ${store.bridge?.id === b.id ? 'selected' : ''}`,
              onclick: () => store.loadBridge(b.id).then(() => toast(`已载入 ${b.spec.name}`)),
            },
              h('div', { style: 'font-weight:600' }, b.spec.name),
              h('div', { class: 'muted' },
                `${TYPE_LABEL[b.spec.type]} · ${b.spec.spanCount}跨 · ${b.spec.girderCount}片梁 · ${b.spec.spanLengths.join('+')}m`),
              h('div', { class: 'muted mono', style: 'font-size:11px;margin-top:4px' },
                `原点 ${b.spec.origin.lon.toFixed(5)}, ${b.spec.origin.lat.toFixed(5)}`),
            )
          ),
          bridges.length === 0 ? h('div', { class: 'muted' }, '暂无档案，先在上方新建') : null,
        ),
      ),
    );
    const info = h('div', { class: 'sidebar' },
      store.bridge ? bridgeDetail() : h('div', { class: 'card muted' }, '选择或新建一座桥梁后查看档案详情'),
    );
    const wrap = h('div', { class: 'split split-h' }, side, info);
    clear(root);
    root.append(wrap);
  };

  function buildForm(): HTMLElement {
    const state: BridgeSpec = {
      type: 'BOX_SMALL',
      name: '',
      spanCount: 3,
      spanLengths: [20, 20, 20],
      girderCount: 4,
      bridgeWidth: 12,
      pierHeight: 6,
      origin: { lon: 118.78, lat: 32.06, height: 12 },
      bearingGap: 0.08,
      columnCount: 2,
    };
    const typeSel = h('select', {},
      ...Object.entries(TYPE_LABEL).map(([v, label]) => h('option', { value: v }, label)),
    ) as HTMLSelectElement;
    const nameIn = h('input', { value: '示例中桥', placeholder: '桥梁名称' }) as HTMLInputElement;
    const spanIn = h('input', { type: 'number', value: '3', min: '1', max: '8' }) as HTMLInputElement;
    const lenIn = h('input', { value: '20,20,20' }) as HTMLInputElement;
    const girderIn = h('input', { type: 'number', value: '4', min: '1', max: '12' }) as HTMLInputElement;
    const widthIn = h('input', { type: 'number', value: '12', step: '0.1' }) as HTMLInputElement;
    const pierIn = h('input', { type: 'number', value: '6', step: '0.1' }) as HTMLInputElement;
    const colIn = h('input', { type: 'number', value: '2', min: '1', max: '4' }) as HTMLInputElement;
    const lonIn = h('input', { value: String(state.origin.lon), step: '0.000001' }) as HTMLInputElement;
    const latIn = h('input', { value: String(state.origin.lat), step: '0.000001' }) as HTMLInputElement;
    const hIn = h('input', { type: 'number', value: '12' }) as HTMLInputElement;

    const submit = h('button', {
      class: 'primary', style: 'width:100%;margin-top:8px',
      onclick: async () => {
        const lengths = lenIn.value.split(/[,，]/).map((s) => parseFloat(s.trim()));
        const n = parseInt(spanIn.value, 10);
        if (lengths.length !== n || lengths.some((x) => !Number.isFinite(x) || x <= 0)) {
          toast('跨径数量要与跨数一致，用逗号分隔', );
          return;
        }
        const spec: BridgeSpec = {
          ...state,
          type: typeSel.value as BridgeType,
          name: nameIn.value || '未命名桥梁',
          spanCount: n,
          spanLengths: lengths,
          girderCount: parseInt(girderIn.value, 10),
          bridgeWidth: parseFloat(widthIn.value),
          pierHeight: parseFloat(pierIn.value),
          columnCount: parseInt(colIn.value, 10),
          origin: { lon: parseFloat(lonIn.value), lat: parseFloat(latIn.value), height: parseFloat(hIn.value) },
        };
        submit.disabled = true;
        try {
          await store.createBridge(spec);
          toast(`已生成 ${store.components.length} 个构件并自动编号`);
          render();
        } finally {
          submit.disabled = false;
        }
      },
    }, '参数化建模并保存');

    return h('div', {},
      h('label', { class: 'field' }, h('span', {}, '桥型'), typeSel),
      h('label', { class: 'field' }, h('span', {}, '桥名'), nameIn),
      h('label', { class: 'field' }, h('span', {}, '跨数'), spanIn),
      h('label', { class: 'field' }, h('span', {}, '每跨跨径m'), lenIn),
      h('label', { class: 'field' }, h('span', {}, '梁片数'), girderIn),
      h('label', { class: 'field' }, h('span', {}, '桥宽m'), widthIn),
      h('label', { class: 'field' }, h('span', {}, '墩高m'), pierIn),
      h('label', { class: 'field' }, h('span', {}, '每墩柱数'), colIn),
      h('div', { class: 'muted', style: 'margin:6px 0 4px' }, 'POS 原点(经纬度/高程m)'),
      h('div', { class: 'grid3' }, lonIn, latIn, hIn),
      submit,
    );
  }

  function bridgeDetail(): HTMLElement {
    const b = store.bridge!;
    const s = b.spec;
    const groups = new Map<string, number>();
    for (const c of store.components) groups.set(c.part, (groups.get(c.part) ?? 0) + 1);
    const partNames: Record<string, string> = {
      main_girder: '主梁', diaphragm: '横隔板', cap_beam: '盖梁', pier_column: '墩柱',
      bearing: '支座', abutment: '桥台', deck: '桥面板',
    };
    return h('div', {},
      h('div', { class: 'card' },
        h('h3', {}, s.name),
        h('div', { class: 'muted' }, `档案号 ${b.id} · ${TYPE_LABEL[s.type]}`),
        h('table', {},
          h('tbody', {},
            row('总跨数', `${s.spanCount}`),
            row('跨径布置', s.spanLengths.map((l) => `${l}m`).join(' + ')),
            row('全长', `${s.spanLengths.reduce((a, x) => a + x, 0)}m`),
            row('梁片数/跨', `${s.girderCount}`),
            row('桥宽', `${s.bridgeWidth}m`),
            row('墩柱高度', `${s.pierHeight}m`),
          ),
        ),
      ),
      h('div', { class: 'card' },
        h('h3', {}, '构件统计'),
        h('div', { class: 'grid2' },
          ...[...groups.entries()].map(([k, v]) =>
            h('div', { class: 'pill' }, h('div', {}, partNames[k] ?? k), h('div', { class: 'metric-big' }, String(v))),
          ),
        ),
      ),
      h('div', { class: 'card' },
        h('h3', {}, '编号规则'),
        h('div', { class: 'muted' },
          '主梁 S跨号-#梁号（如 S2-#3）；横隔板 S跨号-H序号；支座 S跨号-#梁号-Z；',
          '盖梁 P墩号-GL；墩柱 P墩号-Z序号；桥台 A0/A末-T。',
        ),
      ),
    );
  }
  function row(k: string, v: string): HTMLElement {
    return h('tr', {}, h('td', { class: 'muted' }, k), h('td', {}, v));
  }

  render();
  const unsub = store.subscribe(render);
  return unsub;
}
