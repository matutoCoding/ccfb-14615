import './styles.css';
import { startRouter, navigate, route } from './router';
import { appState } from './state';
import { renderArchive } from './pages/archive';
import { renderModeling } from './pages/modeling';
import { renderRegistration } from './pages/registration';
import { renderDefects } from './pages/defects';
import { renderComparison } from './pages/comparison';
import { renderReport } from './pages/report';
import { renderSelftest } from './pages/selftest';

function buildSidebar(): void {
  const sb = document.getElementById('sidebar')!;
  const items: { hash: string; icon: string; label: string }[] = [
    { hash: '#/archive', icon: '🌉', label: '桥梁档案' },
    { hash: '#/modeling', icon: '🧩', label: '构件建模' },
    { hash: '#/registration', icon: '📷', label: '照片配准' },
    { hash: '#/defects', icon: '🩹', label: '病害登记' },
    { hash: '#/comparison', icon: '🔍', label: '复检对比' },
    { hash: '#/report', icon: '📄', label: '检测报告' },
    { hash: '#/selftest', icon: '🧪', label: '精度自测' },
  ];
  sb.innerHTML = `
    <div class="brand">
      <h1>桥梁病害配准贴图系统</h1>
      <div class="sub">照片配准 · 三维纹理烘焙 · 正射病害图<br/>TypeScript + WebGL2 + IndexedDB</div>
    </div>
    <nav class="nav">
      ${items.map((i) => `<a href="${i.hash}"><span class="ico">${i.icon}</span>${i.label}</a>`).join('')}
    </nav>
    <div class="side-foot" id="side-status">未选择桥梁</div>`;
  appState.subscribe(() => {
    const s = document.getElementById('side-status');
    if (!s) return;
    s.textContent = appState.data.spec
      ? `${appState.data.spec.name}\n${appState.data.epochs.length} 个检测期`
      : '未选择桥梁';
    s.style.whiteSpace = 'pre-line';
  });
}

route('archive', renderArchive);
route('modeling', renderModeling);
route('registration', renderRegistration);
route('defects', renderDefects);
route('comparison', renderComparison);
route('report', renderReport);
route('selftest', renderSelftest);

(async () => {
  buildSidebar();
  await appState.restore();
  if (!location.hash) navigate('#/archive');
  await startRouter();
})();
