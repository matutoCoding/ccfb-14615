// 正射病害图：表面渲染 + 病害按局部坐标叠加 + 比例尺
import { DefectRecord } from '../types';
import { Renderer } from '../render/renderer';
import { SurfaceDef } from '../core/geometry';
import { h } from './dom';
import { kindName } from '../core/scoring';

const KIND_COLOR: Record<string, string> = {
  crack: '#d83a2c',
  spall: '#e0832a',
  seepage: '#2f8fd6',
  honeycomb: '#8a5cd1',
};

export interface OrthoResult {
  canvas: HTMLCanvasElement;
  ppm: number; // 像素/米
  widthM: number;
  heightM: number;
}

export function renderOrthoWithDefects(
  renderer: Renderer,
  componentId: string,
  surface: SurfaceDef,
  defects: DefectRecord[],
  targetWidthPx = 1400
): OrthoResult {
  const canvas = renderer.renderOrthophoto(componentId, surface, targetWidthPx);
  const widthM = surface.uRange[1] - surface.uRange[0];
  const heightM = surface.vRange[1] - surface.vRange[0];
  const ppm = canvas.width / widthM;
  const ctx = canvas.getContext('2d')!;

  // 病害局部坐标 -> 画布像素；注意 GL 渲染结果已翻转为左上原点，v 向下
  for (const d of defects) {
    const pts = d.points
      .map((p) => {
        const u = p.local[0] - surface.uRange[0];
        const v = p.local[1] - surface.vRange[0];
        if (u < -0.05 || u > widthM + 0.05 || v < -0.05 || v > heightM + 0.05) return null;
        return [u * ppm, v * ppm] as [number, number];
      })
      .filter((x): x is [number, number] => x !== null);
    if (pts.length < 2) continue;
    ctx.save();
    ctx.strokeStyle = KIND_COLOR[d.kind];
    ctx.lineWidth = d.kind === 'crack' ? Math.max(2, (d.widthMm ?? 100) / 1000 * ppm * 0.6) : 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 2;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    // 编码标注
    ctx.shadowBlur = 0;
    ctx.fillStyle = KIND_COLOR[d.kind];
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(d.code, pts[0][0] + 6, pts[0][1] - 6);
    ctx.restore();
  }

  // 边框与比例尺
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  const barM = niceBarLength(widthM);
  const barPx = barM * ppm;
  const bx = 24, by = canvas.height - 28;
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.fillRect(bx - 8, by - 22, barPx + 16, 40);
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by);
  ctx.stroke();
  ctx.fillStyle = '#111';
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText(`${barM} m  (比例尺 1:${Math.round(1 / ppm * 1000)} 毫米/像素=${(1000 / ppm).toFixed(2)})`, bx, by - 6);
  ctx.restore();
  return { canvas, ppm, widthM, heightM };
}

function niceBarLength(widthM: number): number {
  const candidates = [0.2, 0.5, 1, 2, 5, 10];
  for (const c of candidates) if (c <= widthM * 0.3) return c;
  return candidates[0];
}

export function orthoCard(title: string, result: OrthoResult, subtitle: string): HTMLElement {
  return h('div', { class: 'card' },
    h('h3', {}, title),
    h('div', { class: 'muted', style: 'margin-bottom:6px' }, subtitle),
    h('img', {
      src: result.canvas.toDataURL('image/png'),
      class: 'ortho',
      style: 'width:100%',
      alt: title,
    }),
  );
}

export function defectKindColor(k: string): string {
  return KIND_COLOR[k] ?? '#f00';
}
export { kindName };
