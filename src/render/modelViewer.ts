// 交互式 WebGL2 三维查看器：轨道控制、构件拾取、烘焙纹理贴图、病害叠加、照片视锥。
import type { BridgeModel, ComponentDef, DefectRecord } from '../core/types';
import { m4lookAt, m4mul, m4perspective, type Vec3, v3, norm, sub, add, scl, cross, dot } from '../core/mathTypes';
import { type Ray } from '../core/geometry';
import { intersectComponent } from '../core/geometry';
import { defectWorldSamples } from '../services/defectService';
import type { BakedSurface } from '../vision/textureBaker';

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uMVP;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
out vec3 vLocal;
void main() {
  vWorld = aPos;
  vLocal = aPos;
  vNormal = aNormal;
  vUV = aUV;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
uniform vec3 uCam;
uniform int uMode;   // 0 素模 1 烘焙纹理 2 高亮 3 选中
uniform sampler2D uTex;
uniform int uHasTex;
uniform vec3 uColor;
uniform vec2 uTexSize; // 表面米制宽高（米制 UV 归一化用）
out vec4 frag;
void main() {
  vec3 N = normalize(vNormal);
  vec3 L = normalize(vec3(0.4, 0.5, 0.75));
  float diff = max(dot(N, L), 0.0) * 0.6 + 0.4;
  vec3 col;
  if (uMode == 1 && uHasTex == 1) {
    col = texture(uTex, vUV / uTexSize).rgb;
    col *= 0.55 + 0.45 * diff;
  } else if (uMode == 2) {
    col = uColor;
  } else if (uMode == 3) {
    col = mix(vec3(0.35,0.34,0.31), vec3(0.35,0.62,0.95), 0.45) * diff;
  } else {
    col = vec3(0.52, 0.51, 0.47) * diff;
  }
  // 简单距离雾
  float d = distance(uCam, vWorld);
  float fog = smoothstep(40.0, 90.0, d);
  col = mix(col, vec3(0.07, 0.09, 0.12), fog * 0.7);
  frag = vec4(col, 1.0);
}`;

const LINE_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;
const LINE_FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 frag;
void main() { frag = uColor; }`;

interface MeshGPU {
  comp: ComponentDef;
  vao: WebGLVertexArrayObject;
  count: number;
  surfaceTex: Map<string, WebGLTexture>;
  surfaceSize: Map<string, [number, number]>;
}

export interface PickResult {
  componentId: string;
  surfaceId: string;
  u: number;
  v: number;
  point: Vec3;
}

export class ModelViewer {
  gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private lineProg: WebGLProgram;
  private meshes: MeshGPU[] = [];
  private model: BridgeModel;
  private canvas: HTMLCanvasElement;
  // 轨道相机
  target = v3(30, 0, -2);
  yaw = 0.8;
  pitch = 0.35;
  dist = 38;
  private pickFbo: WebGLFramebuffer | null = null;
  selectedId: string | null = null;
  highlightId: string | null = null;
  defects: DefectRecord[] = [];
  showDefects = true;
  showMarkers = false;
  showFrustum: string[] = [];
  private frustumData: { id: string; positions: Float32Array }[] = [];
  private markerVao: WebGLVertexArrayObject | null = null;
  private markerCount = 0;
  private defectVao: WebGLVertexArrayObject | null = null;
  private defectCount = 0;
  private raf = 0;
  private disposed = false;
  onPick: ((r: PickResult | null) => void) | null = null;
  onHover: ((comp: ComponentDef | null) => void) | null = null;
  /** 视锥剔除回调：返回当前应当显示纹理的构件 id（分页加载） */
  visibleFilter: ((ids: string[]) => string[]) | null = null;
  private visibleIds: Set<string> | null = null;

  constructor(canvas: HTMLCanvasElement, model: BridgeModel) {
    this.canvas = canvas;
    this.model = model;
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    this.prog = this.link(VERT, FRAG);
    this.lineProg = this.link(LINE_VERT, LINE_FRAG);
    this.uploadModel();
    this.bindControls();
    this.loop();
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? '着色器编译失败');
    return sh;
  }
  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? '程序链接失败');
    return p;
  }

  private uploadModel(): void {
    const gl = this.gl;
    for (const comp of this.model.components) {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const buf = (loc: number, data: ArrayBufferView, size: number) => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      };
      buf(0, comp.positions, 3);
      buf(1, comp.normals, 3);
      buf(2, comp.uvs, 2);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, comp.indices, gl.STATIC_DRAW);
      this.meshes.push({
        comp, vao, count: comp.indices.length,
        surfaceTex: new Map(), surfaceSize: new Map(),
      });
    }
    gl.bindVertexArray(null);
  }

  setBakedTextures(baked: Map<string, BakedSurface>): void {
    const gl = this.gl;
    for (const m of this.meshes) {
      for (const s of m.comp.surfaces) {
        const b = baked.get(s.id);
        if (!b) continue;
        const old = m.surfaceTex.get(s.id);
        if (old) gl.deleteTexture(old);
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, b.widthPx, b.heightPx, 0, gl.RGBA, gl.UNSIGNED_BYTE, b.color.data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.generateMipmap(gl.TEXTURE_2D);
        m.surfaceTex.set(s.id, tex);
        m.surfaceSize.set(s.id, [s.width, s.height]);
      }
    }
  }

  setDefects(defects: DefectRecord[]): void {
    this.defects = defects;
    const gl = this.gl;
    if (this.defectVao) gl.deleteVertexArray(this.defectVao);
    const pts: number[] = [];
    for (const d of defects) {
      const samples = defectWorldSamples(this.model, d, 0.015);
      for (const p of samples) pts.push(p.x, p.y, p.z + 0.006);
    }
    this.defectVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.defectVao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    this.defectCount = pts.length / 3;
    gl.bindVertexArray(null);
  }

  setFrustums(data: { id: string; positions: Float32Array }[]): void {
    this.frustumData = data;
  }

  private cameraPos(): Vec3 {
    const cp = Math.cos(this.pitch);
    return add(this.target, v3(
      this.dist * cp * Math.cos(this.yaw),
      this.dist * cp * Math.sin(this.yaw),
      this.dist * Math.sin(this.pitch),
    ));
  }

  private bindControls(): void {
    const c = this.canvas;
    let dragging = false;
    let lastX = 0, lastY = 0;
    let downX = 0, downY = 0, moved = false;
    c.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false;
      lastX = downX = e.clientX; lastY = downY = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (dragging) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true;
        this.yaw -= dx * 0.006;
        this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.006));
        lastX = e.clientX; lastY = e.clientY;
      } else {
        const hit = this.pickAt(e.offsetX, e.offsetY);
        this.onHover?.(hit ? this.model.components.find((x) => x.id === hit.componentId) ?? null : null);
      }
    });
    c.addEventListener('pointerup', (e) => {
      dragging = false;
      if (!moved) {
        const hit = this.pickAt(e.offsetX, e.offsetY);
        this.selectedId = hit?.componentId ?? null;
        this.onPick?.(hit);
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.max(3, Math.min(120, this.dist * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
  }

  focusOn(compId: string): void {
    const comp = this.model.components.find((c) => c.id === compId);
    if (!comp) return;
    const c = comp.origin;
    this.target = v3(c.x, c.y, c.z - 0.5);
    this.dist = Math.max(6, Math.min(20, comp.surfaces[0]?.width ?? 10));
    this.selectedId = compId;
  }

  /** 屏幕坐标 -> 世界射线 */
  screenRay(offsetX: number, offsetY: number): Ray {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((offsetX / rect.width) * 2 - 1);
    const ny = -((offsetY / rect.height) * 2 - 1);
    const eye = this.cameraPos();
    const f = norm(sub(this.target, eye));
    const r = norm(cross(f, v3(0, 0, 1)));
    const u = cross(r, f);
    const aspect = rect.width / rect.height;
    const fovy = Math.PI / 4;
    const t = Math.tan(fovy / 2);
    const dir = norm(add(add(f, scl(r, nx * t * aspect)), scl(u, ny * t)));
    return { origin: eye, dir };
  }

  pickAt(offsetX: number, offsetY: number): PickResult | null {
    const ray = this.screenRay(offsetX, offsetY);
    let best: (PickResult & { t: number }) | null = null;
    for (const comp of this.model.components) {
      const hit = intersectComponent(ray, comp);
      if (hit && (!best || hit.t < best.t)) {
        best = {
          componentId: hit.componentId,
          surfaceId: hit.surface.id,
          u: hit.u,
          v: hit.v,
          point: hit.point,
          t: hit.t,
        };
      }
    }
    return best ? {
      componentId: best.componentId, surfaceId: best.surfaceId,
      u: best.u, v: best.v, point: best.point,
    } : null;
  }

  private computeVisible(): void {
    if (!this.visibleFilter) { this.visibleIds = null; return; }
    const eye = this.cameraPos();
    const near = this.dist - 30, far = this.dist + 30;
    const inView = this.model.components
      .filter((c) => {
        const d = Math.hypot(c.origin.x - eye.x, c.origin.y - eye.y, c.origin.z - eye.z);
        return d >= near && d <= far;
      })
      .map((c) => c.id);
    this.visibleIds = new Set(this.visibleFilter(inView));
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  };

  private render(): void {
    const gl = this.gl;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0.055, 0.075, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.computeVisible();

    const eye = this.cameraPos();
    const proj = m4perspective(Math.PI / 4, w / h, 0.1, 300);
    const view = m4lookAt(eye, this.target, v3(0, 0, 1));
    const vp = m4mul(proj, view);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uMVP'), false, vp);
    gl.uniform3f(gl.getUniformLocation(this.prog, 'uCam'), eye.x, eye.y, eye.z);
    for (const m of this.meshes) {
      if (this.visibleIds && !this.visibleIds.has(m.comp.id)) continue;
      gl.bindVertexArray(m.vao);
      const hasBaked = m.surfaceTex.size > 0;
      // 按表面分段绘制以换纹理
      let mode = 0;
      if (m.comp.id === this.selectedId) mode = 3;
      else if (m.comp.id === this.highlightId) mode = 2;
      else if (hasBaked) mode = 1;
      gl.uniform1i(gl.getUniformLocation(this.prog, 'uMode'), mode);
      gl.uniform3f(gl.getUniformLocation(this.prog, 'uColor'), 0.35, 0.62, 0.95);
      if (mode === 1) {
        // 分表面绘制，每段绑定对应烘焙纹理；无纹理表面回退素模
        for (let si = 0; si < m.comp.surfaces.length; si++) {
          const s = m.comp.surfaces[si];
          const tex = m.surfaceTex.get(s.id);
          if (tex) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.uniform1i(gl.getUniformLocation(this.prog, 'uTex'), 0);
            gl.uniform1i(gl.getUniformLocation(this.prog, 'uHasTex'), 1);
            gl.uniform2f(gl.getUniformLocation(this.prog, 'uTexSize'), s.width, s.height);
          } else {
            gl.uniform1i(gl.getUniformLocation(this.prog, 'uHasTex'), 0);
          }
          const start = s.triStart, count = s.triCount;
          gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, start * 4);
        }
      } else {
        gl.uniform1i(gl.getUniformLocation(this.prog, 'uHasTex'), 0);
        gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
      }
    }

    // 病害红线
    if (this.showDefects && this.defectCount > 1 && this.defectVao) {
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uMVP'), false, vp);
      gl.uniform4f(gl.getUniformLocation(this.lineProg, 'uColor'), 1, 0.22, 0.18, 1);
      gl.bindVertexArray(this.defectVao);
      gl.lineWidth(2);
      gl.drawArrays(gl.LINE_STRIP, 0, this.defectCount);
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}
