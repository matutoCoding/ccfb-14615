// 轨道控制器：左键旋转、右键平移、滚轮缩放
import { Renderer } from './renderer';
import { rad } from '../core/math';

export class OrbitControls {
  private dragging: 'rotate' | 'pan' | null = null;
  private lastX = 0;
  private lastY = 0;
  private el: HTMLElement;

  constructor(private renderer: Renderer, canvas: HTMLCanvasElement) {
    this.el = canvas;
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel);
  }

  private onDown = (e: PointerEvent): void => {
    this.dragging = e.button === 2 ? 'pan' : 'rotate';
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };
  private onUp = (): void => {
    this.dragging = null;
  };
  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    const o = this.renderer.orbit;
    if (this.dragging === 'rotate') {
      o.yaw += dx * 0.006;
      o.pitch = Math.max(-1.3, Math.min(1.3, o.pitch + dy * 0.006));
    } else {
      const scale = o.distance * 0.0016;
      const cp = Math.cos(o.pitch);
      o.target[0] -= dx * scale * cp * Math.cos(o.yaw);
      o.target[1] += dx * scale * cp * Math.sin(o.yaw);
      o.target[2] += dy * scale;
    }
  };
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const o = this.renderer.orbit;
    o.distance = Math.max(2, Math.min(200, o.distance * (1 + Math.sign(e.deltaY) * 0.09)));
  };

  frameTarget(x: number, y: number, z: number, distance = 12): void {
    this.renderer.orbit.target = [x, y, z];
    this.renderer.orbit.distance = distance;
    this.renderer.orbit.pitch = rad(20);
  }
}
