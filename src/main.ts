import './ui/styles.css';
import { h, mount, toast } from './ui/dom';
import { store } from './core/store';
import { archivePage } from './ui/pages/archive';
import { modelingPage } from './ui/pages/modeling';
import { registrationPage } from './ui/pages/registration';
import { defectPage } from './ui/pages/defect';
import { comparePage } from './ui/pages/compare';
import { reportPage } from './ui/pages/report';
import { generateSyntheticDataset } from './core/synthetic';
import { Renderer } from './render/renderer';
import { runAcceptanceTests } from './test/acceptance';

type PageKey = 'archive' | 'modeling' | 'registration' | 'defect' | 'compare' | 'report';
const TABS: { key: PageKey; label: string }[] = [
  { key: 'archive', label: '桥梁档案' },
  { key: 'modeling', label: '构件建模' },
  { key: 'registration', label: '照片配准' },
  { key: 'defect', label: '病害登记' },
  { key: 'compare', label: '复检对比' },
  { key: 'report', label: '检测报告' },
];

let currentPage: PageKey = 'archive';
let disposePage: (() => void) | null = null;

function renderShell(): void {
  const pageRoot = h('div', { class: 'page' });
  const top = h('div', { class: 'topbar' },
    h('div', { class: 'brand' }, '桥检三维配准贴图系统'),
    ...TABS.map((t) =>
      h('button', {
        class: `nav ${currentPage === t.key ? 'active' : ''}`,
        onclick: () => navigate(t.key),
      }, t.label),
    ),
    h('div', { class: 'spacer' }),
    h('button', {
      class: 'warn',
      onclick: generateData,
      title: '生成三跨小箱梁合成桥、两期照片(含POS噪声/过曝/缺POS)和已知长度裂缝',
    }, '生成合成测试数据'),
    h('button', {
      onclick: runTests,
      title: '在浏览器控制台输出 1.5px 残差与 2% 长度误差验收结果',
    }, '运行验收自检'),
    h('span', { class: 'ctx' }, store.bridge ? `${store.bridge.spec.name}` : '未载入桥梁'),
  );
  mount(document.getElementById('app')!, h('div', { class: 'app' }, top, pageRoot));
  mountPage(pageRoot);
}

function navigate(key: PageKey): void {
  currentPage = key;
  renderShell();
}

function mountPage(root: HTMLElement): void {
  if (disposePage) {
    disposePage();
    disposePage = null;
  }
  switch (currentPage) {
    case 'archive': disposePage = archivePage(root); break;
    case 'modeling': disposePage = modelingPage(root); break;
    case 'registration': disposePage = registrationPage(root); break;
    case 'defect': disposePage = defectPage(root); break;
    case 'compare': disposePage = comparePage(root); break;
    case 'report': disposePage = reportPage(root); break;
  }
}

async function generateData(): Promise<void> {
  toast('正在离屏渲染合成照片并写入 IndexedDB，约需十几秒…', 5000);
  // 用一个隐藏 canvas 的 Renderer 做离屏合成
  const hidden = document.createElement('canvas');
  hidden.width = 1024;
  hidden.height = 768;
  hidden.style.position = 'fixed';
  hidden.style.left = '-99999px';
  document.body.append(hidden);
  try {
    const renderer = new Renderer(hidden);
    const result = await generateSyntheticDataset(renderer);
    await store.loadBridge(result.bridgeId);
    toast(`合成完成：${result.photoCount} 张照片、${result.groundTruth.length} 条已知病害，已自动载入`);
    navigate('registration');
  } catch (err) {
    console.error(err);
    toast('合成失败: ' + (err as Error).message);
  } finally {
    hidden.remove();
  }
}

async function runTests(): Promise<void> {
  if (!store.bridge) {
    toast('请先生成合成测试数据');
    return;
  }
  toast('自检运行中，结果同时输出到浏览器控制台(F12)…', 5000);
  const hidden = document.createElement('canvas');
  hidden.width = 1024;
  hidden.height = 768;
  hidden.style.position = 'fixed';
  hidden.style.left = '-99999px';
  document.body.append(hidden);
  try {
    const renderer = new Renderer(hidden);
    const report = await runAcceptanceTests(renderer);
    console.table(report.table);
    console.log('验收结论:', report.summary);
    toast(`自检完成：${report.summary}（详见控制台）`, 6000);
  } catch (err) {
    console.error(err);
    toast('自检失败: ' + (err as Error).message);
  } finally {
    hidden.remove();
  }
}

// 暴露给 Playwright/控制台自动化
declare global {
  interface Window {
    bridgeApp: {
      navigate: (k: PageKey) => void;
      generateData: () => Promise<void>;
      runTests: () => Promise<unknown>;
      store: typeof store;
    };
  }
}
window.bridgeApp = { navigate, generateData, runTests: async () => null, store };

renderShell();
