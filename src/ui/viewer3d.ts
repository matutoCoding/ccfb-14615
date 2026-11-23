// 共享三维视图：渲染循环、构件点选、机位/同名点/病害叠加
import { Renderer } from '../render/renderer';
import { OrbitControls } from '../render/orbit';
import { TexturePager } from '../render/texturePager';
import { store } from '../core/store';
import { screenRay, RayCaster } from '../core/raycast';
import { Vec3 } from '../core/math';
import { deserializeCamera } from '../core/camera';
import { DefectRecord } from '../types';
import { h } from './dom';

export class Viewer3D {
  renderer: Renderer;
  controls: OrbitControls;
  pager: TexturePager;
  caster: RayCaster | null = null;
  private raf = 0;
  private onClickCbs: ((componentId: string | null, point: Vec3 | null) => void)[] = [];
  showCameras = true;
  showDefects = true;
  highlightPhotoId: string | null = null;
  extraPoints: { pos: Vec3; color: [number, number, number, number]; size: number }[] = [];

  constructor(public container: HTMLElement) {
    const canvas = h('canvas', { class: 'gl' }) as HTMLCanvasElement;
    container.append(canvas);
    this.renderer = new Renderer(canvas);
    this.controls = new OrbitControls(this.renderer, canvas);
    this.pager = new TexturePager(this.renderer);
    if (store.geometry) {
      this.renderer.loadBridge(store.geometry);
      this.caster = new RayCaster(store.geometry);
      this.loadedBridgeId = store.bridge?.id ?? null;
    }
    // 桥梁异步载入/切换后自动上传网格
    this.unsubStore = store.subscribe(() => {
      if (store.geometry && this.loadedBridgeId !== store.bridge?.id) {
        this.reload();
      }
    });
    canvas.addEventListener('click', this.handleClick);
    const loop = () => {
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private unsubStore: (() => void) | null = null;
  private loadedBridgeId: string | null = store.bridge?.id ?? null;

  reload(): void {
    if (!store.geometry) return;
    this.renderer.loadBridge(store.geometry);
    this.caster = new RayCaster(store.geometry);
    this.loadedBridgeId = store.bridge?.id ?? null;
  }

  onPick(cb: (componentId: string | null, point: Vec3 | null) => void): void {
    this.onClickCbs.push(cb);
  }

  private handleClick = (e: MouseEvent): void => {
    if (!this.caster) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const { origin, dir } = screenRay(
      ndcX, ndcY, this.renderer.eyePos(), this.renderer.orbit.target, [0, 0, 1],
      this.renderer.fovy, rect.width / rect.height
    );
    const hit = this.caster.cast(origin, dir);
    for (const cb of this.onClickCbs) cb(hit ? hit.componentId : null, hit ? hit.point : null);
  };

  pickAtScreen(clientX: number, clientY: number) {
    if (!this.caster) return null;
    const rect = this.renderer.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const { origin, dir } = screenRay(
      ndcX, ndcY, this.renderer.eyePos(), this.renderer.orbit.target, [0, 0, 1],
      this.renderer.fovy, rect.width / rect.height
    );
    return this.caster.cast(origin, dir);
  }

  private frame(): void {
    this.renderer.selectedId = store.selectedComponentId;
    const lines: { points: Float32Array; color: [number, number, number, number] }[] = [];
    const points: { pos: Vec3; color: [number, number, number, number]; size: number }[] = [];

    if (this.showDefects && store.currentEpochId) {
      const defects = store.defectsOfEpoch(store.currentEpochId);
      for (const d of defects) {
        const color = defectColor(d);
        lines.push({
          points: new Float32Array(d.points.flatMap((p) => p.world)),
          color,
        });
      }
    }
    if (this.showCameras) {
      const photos = store.currentEpochId ? store.photosOfEpoch(store.currentEpochId) : [];
      for (const p of photos) {
        if (!p.camera) continue;
        const cam = deserializeCamera(p.camera);
        const isHi = p.id === this.highlightPhotoId;
        points.push({
          pos: cam.C,
          color: isHi ? [1, 0.8, 0.2, 1] : p.status === 'registered' ? [0.35, 0.95, 0.6, 1] : [0.7, 0.75, 0.85, 0.8],
          size: isHi ? 14 : 8,
        });
      }
    }
    points.push(...this.extraPoints);
    this.renderer.render(lines, points);
    void this.pager.tick(store.photos);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.unsubStore?.();
    this.controls.dispose();
    this.pager.dispose();
    this.renderer.canvas.removeEventListener('click', this.handleClick);
    this.renderer.disposeBridge();
    this.renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.container.replaceChildren();
  }
}

function defectColor(d: DefectRecord): [number, number, number, number] {
  switch (d.kind) {
    case 'crack': return [0.95, 0.25, 0.2, 1];
    case 'spall': return [0.95, 0.6, 0.2, 1];
    case 'seepage': return [0.4, 0.75, 0.95, 1];
    case 'honeycomb': return [0.75, 0.55, 0.95, 1];
  }
}
