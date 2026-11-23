// 纹理分页/LOD 管理：视锥+构件可见性决定加载，先缩略图后原图，限制显存占用
import { Renderer } from './renderer';
import { CameraModel, deserializeCamera } from '../core/camera';
import { getImageBlob } from '../core/db';
import { PhotoRecord } from '../types';
import { Vec3 } from '../core/math';

interface LoadedTexture {
  photoId: string;
  tex: WebGLTexture;
  level: 'thumb' | 'full';
  lastUsed: number;
  bytes: number;
}

const MAX_BYTES = 256 * 1024 * 1024; // 显存预算 256MB
const MAX_CONCURRENT = 4;

export class TexturePager {
  private loaded = new Map<string, LoadedTexture>();
  private loading = new Set<string>();
  private totalBytes = 0;
  private frame = 0;
  constructor(private renderer: Renderer) {}

  // 可见性测试：机位距离 + 光轴朝向
  private inFrustum(cam: CameraModel): boolean {
    const dir: Vec3 = [cam.R[6], cam.R[7], cam.R[8]]; // 光轴
    const toEye: Vec3 = [
      this.renderer.eyePos()[0] - cam.C[0],
      this.renderer.eyePos()[1] - cam.C[1],
      this.renderer.eyePos()[2] - cam.C[2],
    ];
    const dl = Math.hypot(toEye[0], toEye[1], toEye[2]) || 1;
    const cos = (dir[0] * toEye[0] + dir[1] * toEye[1] + dir[2] * toEye[2]) / dl;
    return dl < 60 && cos < 0.35; // 机位附近、朝桥方向的照片优先
  }

  async tick(photos: PhotoRecord[]): Promise<void> {
    this.frame++;
    if (this.frame % 12 !== 0) return; // 每 ~200ms 评估一次
    const gl = this.renderer.gl;
    const registered = photos.filter((p) => p.status === 'registered' && p.camera);
    const ranked: { p: PhotoRecord; cam: CameraModel; score: number }[] = [];
    for (const p of registered) {
      const cam = deserializeCamera(p.camera!);
      if (!this.inFrustum(cam)) continue;
      const dist = Math.hypot(
        cam.C[0] - this.renderer.eyePos()[0],
        cam.C[1] - this.renderer.eyePos()[1],
        cam.C[2] - this.renderer.eyePos()[2]
      );
      ranked.push({ p, cam, score: dist });
    }
    ranked.sort((a, b) => a.score - b.score);
    const want = ranked.slice(0, 12);
    const wantIds = new Set(want.map((w) => w.p.id));

    // 卸载不再需要的
    for (const [id, lt] of this.loaded) {
      if (!wantIds.has(id)) {
        gl.deleteTexture(lt.tex);
        this.totalBytes -= lt.bytes;
        this.loaded.delete(id);
      }
    }
    let inflight = 0;
    for (const w of want) {
      const existing = this.loaded.get(w.p.id);
      if (existing?.level === 'full') {
        existing.lastUsed = this.frame;
        continue;
      }
      if (this.loading.has(w.p.id)) continue;
      if (inflight >= MAX_CONCURRENT) break;
      inflight++;
      this.loading.add(w.p.id);
      this.load(w.p, existing?.level === 'thumb')
        .catch(() => undefined)
        .finally(() => this.loading.delete(w.p.id));
    }
    // 超预算淘汰最久未用
    while (this.totalBytes > MAX_BYTES && this.loaded.size > 2) {
      let oldest: LoadedTexture | null = null;
      for (const lt of this.loaded.values()) {
        if (!oldest || lt.lastUsed < oldest.lastUsed) oldest = lt;
      }
      if (!oldest) break;
      gl.deleteTexture(oldest.tex);
      this.totalBytes -= oldest.bytes;
      this.loaded.delete(oldest.photoId);
    }
  }

  private async load(photo: PhotoRecord, upgrade: boolean): Promise<void> {
    const key = upgrade ? `full:${photo.id}` : `thumb:${photo.id}`;
    const blob = await getImageBlob(key);
    if (!blob) return;
    const bitmap = await createImageBitmap(blob);
    const gl = this.renderer.gl;
    const tex = this.renderer.uploadPhotoTexture(bitmap);
    const bytes = bitmap.width * bitmap.height * 4;
    const old = this.loaded.get(photo.id);
    if (old) {
      gl.deleteTexture(old.tex);
      this.totalBytes -= old.bytes;
    }
    this.loaded.set(photo.id, {
      photoId: photo.id, tex, level: upgrade ? 'full' : 'thumb', lastUsed: this.frame, bytes,
    });
    this.totalBytes += bytes;
    bitmap.close();
  }

  getTexture(photoId: string): WebGLTexture | null {
    const lt = this.loaded.get(photoId);
    if (lt) lt.lastUsed = this.frame;
    return lt?.tex ?? null;
  }

  dispose(): void {
    const gl = this.renderer.gl;
    for (const lt of this.loaded.values()) gl.deleteTexture(lt.tex);
    this.loaded.clear();
    this.totalBytes = 0;
  }
}
