// 正射病害图：构件表面按米制 UV 展开，烘焙纹理做底图，病害矢量叠加，比例尺按实际尺寸。
import type { BakedSurface } from '../vision/textureBaker';
import type { ComponentDef, DefectRecord, SurfaceDef } from '../core/types';
import { el } from '../router';

export interface OrthoOptions {
  selectable?: boolean;
  drawMode?: 'crack' | 'spalling' | 'seepage' | 'honeycomb' | null;
  widthMm?: number;
  severity?: 1 | 2 | 3 | 4 | 5;
  onDrawn?: (points: { surfaceId: string; u: number; v: number }[]) => void;
  onSelectDefect?: (d: DefectRecord) => void;
  compareOverlay?: DefectRecord[]; // 第二期叠加（虚线）
  selectedId?: string | null;
}

export class OrthoView {
  canvas: HTMLCanvasElement;
  private comp: ComponentDef;
  private surf: SurfaceDef;
  private baked: BakedSurface | null;
  private defects: DefectRecord[];
  private opts: OrthoOptions;
  private draft: { u: number; v: number }[] = [];
  private scale = 1; // 像素/米
  private pad = 46;

  constructor(
    comp: ComponentDef,
    surf: SurfaceDef,
    baked: BakedSurface | null,
    defects: DefectRecord[],
    opts: OrthoOptions = {},
  ) {
    this.comp = comp;
    this.surf = surf;
    this.baked = baked;
    this.defects = defects;
    this.opts = opts;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map2d';
    this.canvas.style.cursor = opts.drawMode ? 'crosshair' : 'default';
    this.fitSize();
    this.bind();
    void this.render();
  }

  private fitSize(): void {
    const parentWidth = Math.max(420, this.canvas.parentElement?.clientWidth ?? 760);
    const avail = parentWidth - this.pad * 2 - 24;
    this.scale = Math.min(140, Math.max(24, avail / this.surf.width));
    this.canvas.width = Math.round(this.surf.width * this.scale) + this.pad * 2;
    this.canvas.height = Math.round(this.surf.height * this.scale) + this.pad * 2 + 34;
  }

  private toCanvas(u: number, v: number): { x: number; y: number } {
    return { x: this.pad + u * this.scale, y: this.pad + v * this.scale };
  }
  private toUV(x: number, y: number): { u: number; v: number } {
    return {
      u: Math.max(0, Math.min(this.surf.width, (x - this.pad) / this.scale)),
      v: Math.max(0, Math.min(this.surf.height, (y - this.pad) / this.scale)),
    };
  }

  private bind(): void {
    this.canvas.addEventListener('click', (e) => {
      if (!this.opts.drawMode) {
        // 选择病害
        const rect = this.canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
        const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
        const uv = this.toUV(x, y);
        const hit = this.pickDefect(uv.u, uv.v);
        if (hit) this.opts.onSelectDefect?.(hit);
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
      const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
      const uv = this.toUV(x, y);
      this.draft.push(uv);
      void this.render();
    });
    this.canvas.addEventListener('dblclick', () => {
      if (!this.opts.drawMode || this.draft.length < 2) return;
      this.opts.onDrawn?.(this.draft.map((p) => ({ surfaceId: this.surf.id, u: p.u, v: p.v })));
      this.draft = [];
      void this.render();
    });
  }

  private pickDefect(u: number, v: number): DefectRecord | null {
    let best: { defect: DefectRecord; dist: number } | null = null;
    for (const d of this.defects) {
      const pts = d.points.filter((p) => p.surfaceId === this.surf.id);
      for (let i = 1; i < pts.length; i++) {
        const dist = pointSeg({ u, v }, pts[i - 1], pts[i]);
        if ((!best || dist < best.dist) && dist < 0.05) best = { defect: d, dist };
      }
    }
    return best?.defect ?? null;
  }

  update(defects: DefectRecord[], opts?: OrthoOptions): void {
    this.defects = defects;
    if (opts) this.opts = { ...this.opts, ...opts };
    this.fitSize();
    void this.render();
  }

  private async render(): Promise<void> {
    const ctx = this.canvas.getContext('2d')!;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = '#0d131a';
    ctx.fillRect(0, 0, W, H);
    const x0 = this.pad, y0 = this.pad;
    const w = this.surf.width * this.scale, h = this.surf.height * this.scale;

    // 底图
    if (this.baked) {
      const off = document.createElement('canvas');
      off.width = this.baked.widthPx; off.height = this.baked.heightPx;
      off.getContext('2d')!.putImageData(this.baked.color, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, x0, y0, w, h);
    } else {
      ctx.fillStyle = '#26303c';
      ctx.fillRect(x0, y0, w, h);
      ctx.fillStyle = '#5b6b7d';
      ctx.font = '14px sans-serif';
      ctx.fillText('（该表面尚未烘焙纹理，先到「照片配准」执行烘焙）', x0 + 14, y0 + h / 2);
    }

    // 米制网格（每 0.5m）
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(220,230,240,0.75)';
    for (let u = 0; u <= this.surf.width + 1e-6; u += 0.5) {
      const x = x0 + u * this.scale;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h); ctx.stroke();
      if (Math.abs(u - Math.round(u)) < 1e-6) ctx.fillText(`${u.toFixed(1)}m`, x - 8, y0 + h + 16);
    }
    for (let v = 0; v <= this.surf.height + 1e-6; v += 0.25) {
      const y = y0 + v * this.scale;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); ctx.stroke();
      if (v > 0) ctx.fillText(`${v.toFixed(2)}`, 6, y + 3);
    }
    ctx.strokeStyle = '#8fa5bb';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, w, h);

    // 既有病害
    for (const d of this.defects) this.drawDefect(ctx, d, false);
    // 对比叠加
    for (const d of this.opts.compareOverlay ?? []) this.drawDefect(ctx, d, true);
    // 草稿
    if (this.draft.length) {
      ctx.strokeStyle = '#ffd24d';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      this.draft.forEach((p, i) => {
        const c = this.toCanvas(p.u, p.v);
        if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 标题与比例尺
    ctx.fillStyle = '#dbe6f1';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(`${this.comp.code} · ${this.surf.name}（正射展开，米制坐标）`, x0, 22);
    this.drawScaleBar(ctx, x0 + w - 150, H - 14);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = 'rgba(220,230,240,0.7)';
    ctx.fillText(`表面尺寸 ${this.surf.width.toFixed(2)} m × ${this.surf.height.toFixed(2)} m`, x0, H - 8);
  }

  private drawDefect(ctx: CanvasRenderingContext2D, d: DefectRecord, dashed: boolean): void {
    const pts = d.points.filter((p) => p.surfaceId === this.surf.id);
    if (pts.length < 2 && d.type === 'crack') return;
    if (pts.length < 3 && d.type !== 'crack') return;
    const colors: Record<string, string> = {
      crack: '#ff5a5a', spalling: '#ffb14d', seepage: '#7fd0ff', honeycomb: '#c69bff',
    };
    ctx.strokeStyle = dashed ? '#4dffd2' : colors[d.type];
    ctx.lineWidth = d.type === 'crack' ? Math.max(1.5, (d.widthMm / 1000) * this.scale * 1.4) : 2;
    ctx.setLineDash(dashed ? [7, 5] : []);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const c = this.toCanvas(p.u, p.v);
      if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y);
    });
    if (d.type !== 'crack') ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    if (d.type !== 'crack') {
      ctx.fillStyle = (dashed ? 'rgba(77,255,210,0.15)' : 'rgba(255,177,77,0.15)');
      ctx.fill();
    }
    // 标签
    const first = this.toCanvas(pts[0].u, pts[0].v);
    ctx.font = '11px sans-serif';
    const label = d.type === 'crack'
      ? `${d.id} L=${(d.lengthM * 1000).toFixed(0)}mm w=${d.widthMm.toFixed(2)}mm`
      : `${d.id} A=${d.areaM2.toFixed(2)}m²`;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    const tw = ctx.measureText(label).width;
    ctx.fillRect(first.x - 4, first.y - 16, tw + 8, 15);
    ctx.fillStyle = dashed ? '#4dffd2' : '#fff';
    ctx.fillText(label, first.x, first.y - 5);
    if (d.id === this.opts.selectedId) {
      ctx.strokeStyle = '#ffd24d';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(this.pad, this.pad, this.surf.width * this.scale, this.surf.height * this.scale);
    }
  }

  private drawScaleBar(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    // 选 0.5m 或 1m 整刻度
    const targetPx = 90;
    const meter = targetPx / this.scale > 0.75 ? 1 : 0.5;
    const px = meter * this.scale;
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + px, y);
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
    ctx.moveTo(x + px, y - 4); ctx.lineTo(x + px, y + 4);
    ctx.stroke();
    ctx.font = '11px sans-serif';
    ctx.fillText(`${meter} m（比例尺 ${((this.baked?.metersPerPixel ?? 0.004) * 1000).toFixed(1)} mm/px）`, x, y - 7);
  }

  get currentSurface(): SurfaceDef { return this.surf; }
}

function pointSeg(p: { u: number; v: number }, a: { u: number; v: number }, b: { u: number; v: number }): number {
  const dx = b.u - a.u, dy = b.v - a.v;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return Math.hypot(p.u - a.u, p.v - a.v);
  let t = ((p.u - a.u) * dx + (p.v - a.v) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.u - (a.u + t * dx), p.v - (a.v + t * dy));
}

export function orthoContainer(): HTMLElement {
  return el('div', { style: 'overflow:auto' });
}
