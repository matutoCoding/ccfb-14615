// WebGL2 渲染器：三维场景 / 深度图 / 投影纹理烘焙(可见性+加权融合) / 正射图 / 合成拍照
import {
  Mat4, Vec3, m4compose, m4invert, m4lookAt, m4mul, m4perspective, v3norm, v3sub,
} from '../core/math';
import { CameraModel } from '../core/camera';
import { BridgeGeometry, ComponentGeometry, SurfaceDef } from '../core/geometry';
import { Program, RenderTarget, createProgram, createRenderTarget, createTextureFromSource, uploadMesh, MeshBuffers } from './glUtils';
import {
  MESH_VS, MESH_FS, BAKE_VS, BAKE_FS, PHOTO_VS, PHOTO_FS, QUAD_VS, DISTORT_FS,
  LINE_VS, LINE_FS, POINT_VS, POINT_FS,
} from './shaders';

interface GPUComponent {
  geo: ComponentGeometry;
  buffers: MeshBuffers;
  baked: WebGLTexture | null;
  bakedReady: boolean;
}

export interface OrbitState {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
}

// 照片相机 viewProj：相机系 x 右 y 下 z 前 -> GL NDC
export function photoProjection(cam: CameraModel, near: number, far: number): Mat4 {
  const { width: W, height: H, fx, fy, cx, cy } = cam;
  const A = (3 * near - far) / (far - near);
  const B = (2 * far * near) / (far - near);
  const m = new Float32Array(16);
  m[0] = (2 * fx) / W;
  m[5] = -(2 * fy) / H;
  m[8] = (2 * cx) / W - 1;
  m[9] = 1 - (2 * cy) / H;
  m[10] = -A;
  m[11] = -1;
  m[14] = B;
  return m;
}

export function photoViewProj(cam: CameraModel, near = 0.2, far = 300): Mat4 {
  const view = m4compose(cam.R, [0, 0, 0]); // 旋转部分；平移通过光心
  // 完整 view = [R | -R C]
  const v = new Float32Array(view);
  const RC = [
    cam.R[0] * cam.C[0] + cam.R[3] * cam.C[1] + cam.R[6] * cam.C[2],
    cam.R[1] * cam.C[0] + cam.R[4] * cam.C[1] + cam.R[7] * cam.C[2],
    cam.R[2] * cam.C[0] + cam.R[5] * cam.C[1] + cam.R[8] * cam.C[2],
  ];
  v[12] = -RC[0]; v[13] = -RC[1]; v[14] = -RC[2];
  return m4mul(photoProjection(cam, near, far), v);
}

export class Renderer {
  gl: WebGL2RenderingContext;
  private meshProg!: Program;
  private bakeProg!: Program;
  private photoProg!: Program;
  private distortProg!: Program;
  private lineProg!: Program;
  private pointProg!: Program;
  private quadVao!: WebGLVertexArrayObject;
  private comps: GPUComponent[] = [];
  private geometry: BridgeGeometry | null = null;
  private sceneRT: RenderTarget | null = null;
  private photoRT: RenderTarget | null = null;
  private finalRT: RenderTarget | null = null;
  private photoTexures = new Map<string, { tex: WebGLTexture; width: number; height: number }>();
  orbit: OrbitState = { target: [15, 0, -1], distance: 32, yaw: 0.6, pitch: 0.35 };
  fovy = Math.PI / 4;
  selectedId: string | null = null;
  showBaked = true;
  private maxAniso = 1;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    gl.getExtension('EXT_color_buffer_float');
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) this.maxAniso = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    this.initPrograms();
    this.initQuad();
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE); // 桥检任意角度观察，统一不剔除背面
    gl.cullFace(gl.BACK);
  }

  private initPrograms(): void {
    this.meshProg = createProgram(this.gl, MESH_VS, MESH_FS, {
      uniforms: ['uViewProj', 'uModel', 'uColor', 'uCamPos', 'uMode', 'uBaked', 'uBakedReady', 'uOpacity'],
      attribs: ['aPos', 'aNormal', 'aUV'],
    });
    this.bakeProg = createProgram(this.gl, BAKE_VS, BAKE_FS, {
      uniforms: [
        'uModel', 'uCamViewProj', 'uPhoto', 'uSceneDepth', 'uCamCenter', 'uCamF', 'uCamC',
        'uCamK', 'uImageSize', 'uNear', 'uFar', 'uProjA', 'uProjB', 'uMaxAngle',
      ],
      attribs: ['aPos', 'aNormal', 'aUV'],
    });
    this.photoProg = createProgram(this.gl, PHOTO_VS, PHOTO_FS, {
      uniforms: ['uViewProj', 'uModel', 'uColor', 'uCamCenter', 'uOverexposed'],
      attribs: ['aPos', 'aNormal', 'aUV'],
    });
    this.distortProg = createProgram(this.gl, QUAD_VS, DISTORT_FS, {
      uniforms: ['uScene', 'uF', 'uC', 'uK', 'uImageSize'],
      attribs: ['aPos'],
    });
    this.lineProg = createProgram(this.gl, LINE_VS, LINE_FS, {
      uniforms: ['uViewProj', 'uColor'], attribs: ['aPos'],
    });
    this.pointProg = createProgram(this.gl, POINT_VS, POINT_FS, {
      uniforms: ['uViewProj', 'uColor', 'uSize'], attribs: ['aPos'],
    });
  }

  private initQuad(): void {
    const gl = this.gl;
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  loadBridge(geometry: BridgeGeometry): void {
    const gl = this.gl;
    this.disposeBridge();
    this.geometry = geometry;
    for (const cg of geometry.components) {
      const b = uploadMesh(gl, cg.mesh.positions, cg.mesh.normals, cg.mesh.uvs, cg.mesh.indices);
      this.comps.push({
        geo: cg,
        buffers: { ...b, componentId: cg.component.id },
        baked: null,
        bakedReady: false,
      });
    }
    this.orbit.target = [geometry.length / 2, 0, -1];
    this.orbit.distance = geometry.length * 0.9;
  }

  disposeBridge(): void {
    const gl = this.gl;
    for (const c of this.comps) {
      gl.deleteVertexArray(c.buffers.vao);
      if (c.baked) gl.deleteTexture(c.baked);
    }
    this.comps = [];
  }

  // ---------- 观察相机 ----------
  viewMatrix(): Mat4 {
    const o = this.orbit;
    const cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
    const eye: Vec3 = [
      o.target[0] + o.distance * cp * Math.sin(o.yaw),
      o.target[1] - o.distance * cp * Math.cos(o.yaw),
      o.target[2] + o.distance * sp,
    ];
    return m4lookAt(eye, o.target, [0, 0, 1]);
  }

  eyePos(): Vec3 {
    const o = this.orbit;
    const cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
    return [
      o.target[0] + o.distance * cp * Math.sin(o.yaw),
      o.target[1] - o.distance * cp * Math.cos(o.yaw),
      o.target[2] + o.distance * sp,
    ];
  }

  private viewProj(): Mat4 {
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    // 远裁剪面收紧到 250m，避免大 far/near 比把场景压到深度缓冲末端失去分辨率
    return m4mul(m4perspective(this.fovy, aspect, 0.1, 250), this.viewMatrix());
  }

  // ---------- 主场景 ----------
  render(lines: { points: Float32Array; color: [number, number, number, number] }[] = [], points: { pos: Vec3; color: [number, number, number, number]; size: number }[] = []): void {
    const gl = this.gl;
    this.resize();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0.16, 0.18, 0.21, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    // 不做背面剔除：桥检需从桥底/腹板等任意角度观察，且各构件索引绕序不统一
    gl.disable(gl.CULL_FACE);
    const vp = this.viewProj();
    const eye = this.eyePos();
    gl.useProgram(this.meshProg.program);
    gl.uniformMatrix4fv(this.meshProg.uniforms.uViewProj, false, vp);
    gl.uniformMatrix4fv(this.meshProg.uniforms.uModel, false, ident4());
    gl.uniform3fv(this.meshProg.uniforms.uCamPos, eye);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.meshProg.uniforms.uBaked, 0);
    for (const c of this.comps) {
      const selected = c.geo.component.id === this.selectedId;
      let mode = 0;
      if (selected) mode = 2;
      else if (this.showBaked && c.bakedReady) mode = 1;
      gl.uniform1i(this.meshProg.uniforms.uMode, mode);
      gl.uniform3fv(this.meshProg.uniforms.uColor, c.geo.color);
      gl.uniform1f(this.meshProg.uniforms.uBakedReady, c.bakedReady ? 1 : 0);
      gl.uniform1f(this.meshProg.uniforms.uOpacity, 1);
      if (c.baked) gl.bindTexture(gl.TEXTURE_2D, c.baked);
      gl.bindVertexArray(c.buffers.vao);
      gl.drawElements(gl.TRIANGLES, c.buffers.indexCount, gl.UNSIGNED_INT, 0);
    }
    this.renderLines(vp, lines);
    this.renderPoints(vp, points);
    gl.bindVertexArray(null);
  }

  private renderLines(vp: Mat4, lines: { points: Float32Array; color: [number, number, number, number] }[]): void {
    const gl = this.gl;
    if (!lines.length) return;
    gl.useProgram(this.lineProg.program);
    gl.uniformMatrix4fv(this.lineProg.uniforms.uViewProj, false, vp);
    gl.disable(gl.CULL_FACE);
    for (const ln of lines) {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, ln.points, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.uniform4fv(this.lineProg.uniforms.uColor, ln.color);
      gl.lineWidth(2);
      gl.drawArrays(gl.LINE_STRIP, 0, ln.points.length / 3);
      gl.deleteBuffer(buf);
    }
  }

  private renderPoints(vp: Mat4, pts: { pos: Vec3; color: [number, number, number, number]; size: number }[]): void {
    const gl = this.gl;
    if (!pts.length) return;
    gl.useProgram(this.pointProg.program);
    gl.uniformMatrix4fv(this.pointProg.uniforms.uViewProj, false, vp);
    const data = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => data.set(p.pos, i * 3));
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    for (const p of pts) {
      gl.uniform4fv(this.pointProg.uniforms.uColor, p.color);
      gl.uniform1f(this.pointProg.uniforms.uSize, p.size);
      gl.drawArrays(gl.POINTS, 0, 1);
    }
    gl.deleteBuffer(buf);
  }

  // ---------- 整桥深度图(照片相机视角) ----------
  renderSceneDepth(cam: CameraModel): RenderTarget {
    const gl = this.gl;
    const W = cam.width, H = cam.height;
    if (!this.sceneRT || this.sceneRT.width !== W || this.sceneRT.height !== H) {
      if (this.sceneRT) this.deleteRT(this.sceneRT);
      this.sceneRT = createRenderTarget(gl, W, H, true);
    }
    const rt = this.sceneRT;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE); // 深度图保留背面遮挡信息
    const vp = photoViewProj(cam);
    gl.useProgram(this.photoProg.program);
    gl.uniformMatrix4fv(this.photoProg.uniforms.uViewProj, false, vp);
    gl.uniformMatrix4fv(this.photoProg.uniforms.uModel, false, ident4());
    gl.uniform3fv(this.photoProg.uniforms.uCamCenter, cam.C);
    gl.uniform1i(this.photoProg.uniforms.uOverexposed, 0);
    for (const c of this.comps) {
      gl.uniform3fv(this.photoProg.uniforms.uColor, c.geo.color);
      gl.bindVertexArray(c.buffers.vao);
      gl.drawElements(gl.TRIANGLES, c.buffers.indexCount, gl.UNSIGNED_INT, 0);
    }
    gl.disable(gl.CULL_FACE); // 桥检任意角度观察，统一不剔除背面
    return rt;
  }

  // ---------- 投影纹理烘焙单张照片到各构件 ----------
  bakePhoto(cam: CameraModel, photoTex: WebGLTexture, near = 0.2, far = 300): void {
    const gl = this.gl;
    const depthRT = this.renderSceneDepth(cam);
    const vp = photoViewProj(cam, near, far);
    const projA = (3 * near - far) / (far - near);
    const projB = (2 * far * near) / (far - near);
    gl.useProgram(this.bakeProg.program);
    gl.uniformMatrix4fv(this.bakeProg.uniforms.uCamViewProj, false, vp);
    gl.uniformMatrix4fv(this.bakeProg.uniforms.uModel, false, ident4());
    gl.uniform3fv(this.bakeProg.uniforms.uCamCenter, cam.C);
    gl.uniform2fv(this.bakeProg.uniforms.uCamF, [cam.fx, cam.fy]);
    gl.uniform2fv(this.bakeProg.uniforms.uCamC, [cam.cx, cam.cy]);
    gl.uniform2fv(this.bakeProg.uniforms.uCamK, [cam.k1, cam.k2]);
    gl.uniform2fv(this.bakeProg.uniforms.uImageSize, [cam.width, cam.height]);
    gl.uniform1f(this.bakeProg.uniforms.uNear, near);
    gl.uniform1f(this.bakeProg.uniforms.uFar, far);
    gl.uniform1f(this.bakeProg.uniforms.uProjA, projA);
    gl.uniform1f(this.bakeProg.uniforms.uProjB, projB);
    gl.uniform1f(this.bakeProg.uniforms.uMaxAngle, 0.18); // ~79.6° 截止
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, photoTex);
    gl.uniform1i(this.bakeProg.uniforms.uPhoto, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, depthRT.depth);
    gl.uniform1i(this.bakeProg.uniforms.uSceneDepth, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); // 权重归一化累积
    gl.disable(gl.CULL_FACE);

    for (const c of this.comps) {
      const size = this.bakeTargetSize(c.geo);
      if (!c.baked) c.baked = this.createBakeTexture(size[0], size[1]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bakeFbo(c.baked, size[0], size[1]));
      gl.viewport(0, 0, size[0], size[1]);
      gl.bindVertexArray(c.buffers.vao);
      gl.drawElements(gl.TRIANGLES, c.buffers.indexCount, gl.UNSIGNED_INT, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE); // 桥检任意角度观察，统一不剔除背面
    for (const c of this.comps) c.bakedReady = true;
  }

  private bakeFboFor = new WeakMap<WebGLTexture, WebGLFramebuffer>();
  private bakeFbo(tex: WebGLTexture, w: number, h: number): WebGLFramebuffer {
    let fbo = this.bakeFboFor.get(tex);
    if (!fbo) {
      fbo = this.gl.createFramebuffer()!;
      this.bakeFboFor.set(tex, fbo);
    }
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return fbo;
  }

  private bakeTargetSize(cg: ComponentGeometry): [number, number] {
    const bb = cg.bbox;
    const dx = bb.max[0] - bb.min[0];
    const dy = bb.max[1] - bb.min[1];
    const dz = bb.max[2] - bb.min[2];
    const longest = Math.max(dx, dy, dz, 0.5);
    // 约 128 像素/米，上限 2048
    const scale = Math.min(2048 / longest, 128);
    return [
      Math.max(64, Math.round(Math.max(dx, 0.2) * scale)),
      Math.max(64, Math.round(Math.max(dy, dz, 0.2) * scale)),
    ];
  }

  private createBakeTexture(w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 初始化为混凝土底色，避免接缝黑边
    const init = new Uint8Array(w * h * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 178));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, init);
    gl.generateMipmap(gl.TEXTURE_2D);
    return tex;
  }

  resetBake(): void {
    const gl = this.gl;
    for (const c of this.comps) {
      if (c.baked) {
        gl.deleteTexture(c.baked);
        const fbo = this.bakeFboFor.get(c.baked);
        if (fbo) gl.deleteFramebuffer(fbo);
        this.bakeFboFor.delete(c.baked);
        c.baked = null;
      }
      c.bakedReady = false;
    }
  }

  // ---------- 正射病害图：表面 -> 画布 ----------
  renderOrthophoto(componentId: string, surface: SurfaceDef, widthPx: number): HTMLCanvasElement {
    const gl = this.gl;
    const cg = this.comps.find((c) => c.geo.component.id === componentId);
    if (!cg) throw new Error('构件未上传 GPU');
    const uLen = surface.uRange[1] - surface.uRange[0];
    const vLen = surface.vRange[1] - surface.vRange[0];
    const ppm = widthPx / uLen; // 像素/米
    const heightPx = Math.max(32, Math.round(vLen * ppm));
    const rt = createRenderTarget(gl, widthPx, heightPx, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    gl.viewport(0, 0, widthPx, heightPx);
    gl.clearColor(0.82, 0.82, 0.8, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    gl.useProgram(this.meshProg.program);
    const ortho = surfaceOrthoMatrix(surface);
    gl.uniformMatrix4fv(this.meshProg.uniforms.uViewProj, false, ortho);
    gl.uniformMatrix4fv(this.meshProg.uniforms.uModel, false, ident4());
    const mid = surface.toWorld(uLen / 2, vLen / 2);
    gl.uniform3fv(this.meshProg.uniforms.uCamPos, [
      mid[0] + surface.normal[0], mid[1] + surface.normal[1], mid[2] + surface.normal[2],
    ]);
    gl.uniform1i(this.meshProg.uniforms.uMode, cg.bakedReady ? 1 : 0);
    gl.uniform3fv(this.meshProg.uniforms.uColor, cg.geo.color);
    gl.uniform1f(this.meshProg.uniforms.uBakedReady, cg.bakedReady ? 1 : 0);
    gl.uniform1f(this.meshProg.uniforms.uOpacity, 1);
    gl.activeTexture(gl.TEXTURE0);
    if (cg.baked) gl.bindTexture(gl.TEXTURE_2D, cg.baked);
    gl.bindVertexArray(cg.buffers.vao);
    gl.drawElements(gl.TRIANGLES, cg.buffers.indexCount, gl.UNSIGNED_INT, 0);

    const pixels = new Uint8Array(widthPx * heightPx * 4);
    gl.readPixels(0, 0, widthPx, heightPx, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.deleteRT(rt);
    gl.disable(gl.CULL_FACE); // 桥检任意角度观察，统一不剔除背面

    const out = document.createElement('canvas');
    out.width = widthPx; out.height = heightPx;
    const ctx = out.getContext('2d')!;
    const img = ctx.createImageData(widthPx, heightPx);
    img.data.set(pixels);
    ctx.putImageData(img, 0, 0);
    // GL 原点左下 -> 图像原点左上
    const flipped = document.createElement('canvas');
    flipped.width = widthPx; flipped.height = heightPx;
    const fctx = flipped.getContext('2d')!;
    fctx.translate(0, heightPx);
    fctx.scale(1, -1);
    fctx.drawImage(out, 0, 0);
    return flipped;
  }

  // ---------- 合成拍照(供数据生成) ----------
  renderSyntheticPhoto(cam: CameraModel, overexposed: boolean): { canvas: HTMLCanvasElement; depth: RenderTarget } {
    const gl = this.gl;
    const W = cam.width, H = cam.height;
    const depthRT = this.renderSceneDepth(cam);
    if (!this.photoRT || this.photoRT.width !== W || this.photoRT.height !== H) {
      if (this.photoRT) this.deleteRT(this.photoRT);
      this.photoRT = createRenderTarget(gl, W, H, false);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.photoRT.fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.08, 0.09, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    const vp = photoViewProj(cam);
    gl.useProgram(this.photoProg.program);
    gl.uniformMatrix4fv(this.photoProg.uniforms.uViewProj, false, vp);
    gl.uniformMatrix4fv(this.photoProg.uniforms.uModel, false, ident4());
    gl.uniform3fv(this.photoProg.uniforms.uCamCenter, cam.C);
    gl.uniform1i(this.photoProg.uniforms.uOverexposed, overexposed ? 1 : 0);
    for (const c of this.comps) {
      gl.uniform3fv(this.photoProg.uniforms.uColor, c.geo.color);
      gl.bindVertexArray(c.buffers.vao);
      gl.drawElements(gl.TRIANGLES, c.buffers.indexCount, gl.UNSIGNED_INT, 0);
    }
    // 畸变后处理
    if (!this.finalRT || this.finalRT.width !== W || this.finalRT.height !== H) {
      if (this.finalRT) this.deleteRT(this.finalRT);
      this.finalRT = createRenderTarget(gl, W, H, false);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.finalRT.fbo);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.distortProg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.photoRT.color);
    gl.uniform1i(this.distortProg.uniforms.uScene, 0);
    gl.uniform2fv(this.distortProg.uniforms.uF, [cam.fx, cam.fy]);
    gl.uniform2fv(this.distortProg.uniforms.uC, [cam.cx, cam.cy]);
    gl.uniform2fv(this.distortProg.uniforms.uK, [cam.k1, cam.k2]);
    gl.uniform2fv(this.distortProg.uniforms.uImageSize, [W, H]);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const pixels = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const img = ctx.createImageData(W, H);
    img.data.set(pixels);
    ctx.putImageData(img, 0, 0);
    // 翻转 Y 得到常规图像坐标(原点左上)
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const octx = out.getContext('2d')!;
    octx.translate(0, H);
    octx.scale(1, -1);
    octx.drawImage(canvas, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.CULL_FACE); // 桥检任意角度观察，统一不剔除背面
    return { canvas: out, depth: depthRT };
  }

  // 供合成器在照片上叠加已知裂缝(2D 像素折线)
  uploadPhotoTexture(source: ImageBitmap | HTMLCanvasElement | HTMLImageElement): WebGLTexture {
    const gl = this.gl;
    return createTextureFromSource(gl, source, false);
  }

  private deleteRT(rt: RenderTarget): void {
    const gl = this.gl;
    gl.deleteFramebuffer(rt.fbo);
    gl.deleteTexture(rt.color);
    gl.deleteTexture(rt.depth);
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  get componentList(): GPUComponent[] {
    return this.comps;
  }
}

function ident4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// 表面世界坐标 -> NDC：局部 (u,v) 铺满屏幕，z 由法线距离决定深度
function surfaceOrthoMatrix(s: SurfaceDef): Mat4 {
  const o = s.toWorld(s.uRange[0], s.vRange[0]);
  const eu = s.toWorld(s.uRange[0] + 1, s.vRange[0]);
  const ev = s.toWorld(s.uRange[0], s.vRange[0] + 1);
  const uAxis: Vec3 = [eu[0] - o[0], eu[1] - o[1], eu[2] - o[2]];
  const vAxis: Vec3 = [ev[0] - o[0], ev[1] - o[1], ev[2] - o[2]];
  const n = s.normal;
  const uL = s.uRange[1] - s.uRange[0];
  const vL = s.vRange[1] - s.vRange[0];
  // NDC = M [x,y,z,1]，先写线性行再补平移
  const rows = [
    [uAxis[0] * (2 / uL), uAxis[1] * (2 / uL), uAxis[2] * (2 / uL)],
    [vAxis[0] * (2 / vL), vAxis[1] * (2 / vL), vAxis[2] * (2 / vL)],
    [n[0], n[1], n[2]],
  ];
  const m = new Float32Array(16);
  rows.forEach((row, r) => {
    m[r] = row[0]; m[4 + r] = row[1]; m[8 + r] = row[2];
    m[12 + r] = -(row[0] * o[0] + row[1] * o[1] + row[2] * o[2]) + (r === 2 ? 0 : -1);
  });
  m[15] = 1;
  return m;
}

export { v3norm, v3sub, m4invert };
