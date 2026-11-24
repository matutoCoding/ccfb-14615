// 极简 Hash 路由与 DOM 辅助。
export type RouteRender = (params: Record<string, string>, root: HTMLElement) => void | Promise<void>;

const routes: { pattern: string; render: RouteRender }[] = [];

export function route(pattern: string, render: RouteRender): void {
  routes.push({ pattern, render });
}

function match(pattern: string, hash: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean);
  const hh = hash.split('/').filter(Boolean);
  if (pp.length !== hh.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(hh[i]);
    else if (pp[i] !== hh[i]) return null;
  }
  return params;
}

export function navigate(hash: string): void {
  location.hash = hash;
}

export async function startRouter(): Promise<void> {
  const root = document.getElementById('view')!;
  const dispatch = async () => {
    const hash = location.hash.replace(/^#\/?/, '');
    const key = hash.split('/')[0] || 'archive';
    document.querySelectorAll('#sidebar .nav a').forEach((a) => {
      a.classList.toggle('active', (a.getAttribute('href') ?? '').includes(key));
    });
    for (const r of routes) {
      const params = match(r.pattern, hash);
      if (params !== null) {
        root.innerHTML = '<div class="muted" style="padding:40px;text-align:center">加载中…</div>';
        try {
          await r.render(params, root);
        } catch (e) {
          root.innerHTML = '';
          const div = document.createElement('div');
          div.className = 'card';
          div.style.borderColor = '#6b3030';
          div.innerHTML = `<h3>页面出错</h3><pre class="mono">${(e as Error).stack ?? e}</pre>`;
          root.appendChild(div);
          console.error(e);
        }
        return;
      }
    }
    root.innerHTML = '<div class="muted">未知页面</div>';
  };
  window.addEventListener('hashchange', dispatch);
  await dispatch();
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else node.setAttribute(k, v);
  }
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

export function toast(msg: string, kind: 'info' | 'err' | 'ok' = 'info', ms = 3200): void {
  const root = document.getElementById('toast-root')!;
  const t = el('div', { class: `toast ${kind === 'info' ? '' : kind}` }, msg);
  root.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function modal(title: string, content: Node, footer?: Node): () => void {
  const mask = el('div', { class: 'modal-mask' });
  const box = el('div', { class: 'modal' });
  box.append(el('h3', {}, title), content);
  if (footer) box.append(footer);
  mask.append(box);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  document.getElementById('modal-root')!.append(mask);
  const close = () => mask.remove();
  return close;
}

export function fmtNum(x: number, digits = 2): string {
  return Number.isFinite(x) ? x.toFixed(digits) : '—';
}
