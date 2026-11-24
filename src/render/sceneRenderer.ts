// WebGL2 离屏场景渲染：把桥梁模型按给定相机渲染到 FBO，
// 支持混凝土程序化纹理、裂缝贴片、控制点标志、光照；另含径向畸变后处理。
import type { BridgeModel, ComponentDef, DefectRecord, FiducialPoint } from '../core/types';
import { viewGL, projectionGL, type CameraIntrinsics, type CameraPose } from '../core/camera';
import { surfacePoint, surfaceNormalAt } from '../core/geometry';
import { m3mulv, sub, norm, type Vec3 } from '../core/mathTypes';

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uView;
uniform mat4 uProj;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
void main() {
  vWorld = aPos;
  vNormal = aNormal;
  vUV = aUV;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const SCENE_FRAG = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
uniform vec3 uCamPos;
uniform float uTime;
uniform int uHighlight; // 0 正常 1 线框叠加感
out vec4 frag;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
    mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x), mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y),
    f.z);
}

void main() {
  // 混凝土基色：米灰带色斑与浇筑条纹
  float n1 = noise3(vWorld * 2.3);
  float n2 = noise3(vWorld * 9.0 + 7.0);
  float streak = noise3(vec3(vWorld.x * 0.6, vWorld.y * 3.0, vWorld.z * 3.0));
  vec3 base = mix(vec3(0.55, 0.53, 0.49), vec3(0.66, 0.64, 0.60), n1);
  base = mix(base, base * 0.86, 0.25 * n2 + 0.15 * streak);

  vec3 N = normalize(vNormal);
  vec3 L = normalize(vec3(0.45, 0.55, 0.75));
  float diff = max(dot(N, L), 0.0) * 0.55 + 0.45;
  // 轻微边缘暗化，增强立体感
  vec3 V = normalize(uCamPos - vWorld);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.0) * 0.12;
  vec3 col = base * diff + rim * vec3(0.1);
  if (uHighlight == 1) col = mix(col, vec3(0.2, 0.45, 0.85), 0.25);
  frag = vec4(col, 1.0);
}`;

const MARKER_FRAG = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;   // 圆盘局部坐标：xy=切平面偏移(米)，由顶点属性传入
uniform vec3 uCamPos;
uniform float uRadius;
out vec4 frag;
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  if (dot(N, V) < 0.05) discard;
  float r = length(vUV) / uRadius;
  if (r > 1.0) discard;
  // 白底黑环测量标志：中心黑核 + 白环 + 黑外环
  vec3 col;
  if (r < 0.32) col = vec3(0.04);
  else if (r < 0.62) col = vec3(0.95);
  else if (r < 0.85) col = vec3(0.05);
  else col = vec3(0.93);
  frag = vec4(col, 1.0);
}`;

const CRACK_FRAG = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
uniform vec3 uCamPos;
uniform sampler2D uCrackMap; // 表面局部米制 UV -> 裂缝强度
uniform vec2 uCrackScale;   // 纹理覆盖的 u,v 尺寸（米）
uniform vec2 uCrackOffset;  // 表面 u,v 偏移
out vec4 frag;
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  if (dot(N, V) < 0.05) discard;
  vec2 suv = (vUV - uCrackOffset) / uCrackScale;
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) discard;
  float a = texture(uCrackMap, suv).r;
  if (a < 0.05) discard;
  frag = vec4(vec3(0.02, 0.02, 0.018), a * 0.92);
}`;

const DISTORT_FRAG = `#version 300 es
precision highp float;
out vec4 frag;
in vec2 vTex;
uniform sampler2D uScene;
uniform vec2 uFocal; // fx, fy（像素）
uniform vec2 uPrincipal; // cx, cy（像素）
uniform vec4 uDist; // k1,k2,p1,p2
uniform vec2 uSize;
uniform float uOverexpose; // 0 正常，>0 过曝强度
// 迭代去畸变：输出像素(畸变后) -> 针孔原图采样坐标
vec2 undistort(vec2 xd) {
  vec2 x = xd;
  for (int i = 0; i < 8; i++) {
    float r2 = dot(x, x);
    float radial = 1.0 + uDist.x * r2 + uDist.y * r2 * r2;
    vec2 tx = vec2(2.0 * uDist.z * x.x * x.y + uDist.w * (r2 + 2.0 * x.x * x.x),
                   uDist.z * (r2 + 2.0 * x.y * x.y) + 2.0 * uDist.w * x.x * x.y);
    x = (xd - tx) / radial;
  }
  return x;
}
void main() {
  vec2 px = vTex * uSize;
  vec2 xd = (px - uPrincipal) / uFocal;
  vec2 xn = undistort(xd);
  vec2 srcPx = uPrincipal + uFocal * xn;
  vec2 uv = srcPx / uSize;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    frag = vec4(0.05, 0.05, 0.06, 1.0);
    return;
  }
  vec4 c = texture(uScene, uv);
  if (uOverexpose > 0.001) {
    // 模拟逆光：右上方向增亮并削顶
    float g = smoothstep(0.2, 1.0, 0.6 * vTex.x + 0.5 * vTex.y);
    float boost = uOverexpose * g;
    c.rgb = min(vec3(1.0), c.rgb + boost);
    c.rgb = mix(c.rgb, vec3(1.0), boost * 0.55);
  }
  frag = c;
}`;

const POST_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vTex;
void main() {
  vTex = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

interface CompMesh {
  vao: WebGLVertexArrayObject;
  indexCount: number;
  comp: ComponentDef;
}

export interface CrackOverlay {
  componentId: string;
  surfaceId: string;
  texture: WebGLTexture;
  scale: [number, number];
  offset: [number, number];
  vao: WebGLVertexArrayObject;
  indexCount: number;
}

export class SceneRenderer {
  gl: WebGL2RenderingContext;
  private sceneProg: WebGLProgram;
  private markerProg: WebGLProgram;
  private crackProg: WebGLProgram;
  private postProg: WebGLProgram;
  private meshes: CompMesh[] = [];
  private fbo: WebGLFramebuffer;
  private fboTex: WebGLTexture;
  private depth: WebGLRenderbuffer;
  private postVao: WebGLVertexArrayObject;
  private W = 0;
  private H = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.sceneProg = program(gl, VERT, SCENE_FRAG);
    this.markerProg = program(gl, VERT, MARKER_FRAG);
    this.crackProg = program(gl, VERT, CRACK_FRAG);
    this.postProg = program(gl, POST_VERT, DISTORT_FRAG);
    this.fbo = gl.createFramebuffer()!;
    this.fboTex = gl.createTexture()!;
    this.depth = gl.createRenderbuffer()!;
    this.postVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.postVao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  loadModel(model: BridgeModel): void {
    const gl = this.gl;
    this.meshes.forEach((m) => gl.deleteVertexArray(m.vao));
    this.meshes = [];
    for (const comp of model.components) {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const mk = (loc: number, data: ArrayBufferView, size: number) => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      };
      mk(0, comp.positions, 3);
      mk(1, comp.normals, 3);
      mk(2, comp.uvs, 2);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, comp.indices, gl.STATIC_DRAW);
      this.meshes.push({ vao, indexCount: comp.indices.length, comp });
    }
    gl.bindVertexArray(null);
  }

  private ensureFbo(w: number, h: number): void {
    const gl = this.gl;
    if (this.W === w && this.H === h) return;
    this.W = w; this.H = h;
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** 生成裂缝贴片纹理（每表面一张），defects 为该构件病害 */
  buildCrackOverlays(model: BridgeModel, defects: DefectRecord[]): CrackOverlay[] {
    const gl = this.gl;
    const out: CrackOverlay[] = [];
    const byComp = new Map<string, DefectRecord[]>();
    for (const d of defects) {
      const arr = byComp.get(d.componentId) ?? [];
      arr.push(d);
      byComp.set(d.componentId, arr);
    }
    for (const [compId, list] of byComp) {
      const comp = model.components.find((c) => c.id === compId);
      if (!comp) continue;
      const bySurf = new Map<string, DefectRecord[]>();
      for (const d of list) {
        for (const pt of d.points) {
          const arr = bySurf.get(pt.surfaceId) ?? [];
          if (!arr.includes(d)) arr.push(d);
          bySurf.set(pt.surfaceId, arr);
        }
      }
      for (const [surfaceId, ds] of bySurf) {
        const surf = comp.surfaces.find((s) => s.id === surfaceId);
        if (!surf) continue;
        const scale: [number, number] = [surf.width, surf.height];
        const offset: [number, number] = [0, 0];
        const texW = 1024;
        const texH = Math.max(64, Math.round(texW * surf.height / surf.width));
        const canvas = document.createElement('canvas');
        canvas.width = texW; canvas.height = texH;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, texW, texH);
        for (const d of ds) {
          const pts = d.points.filter((p) => p.surfaceId === surfaceId);
          if (pts.length < 2) continue;
          ctx.strokeStyle = `rgba(255,255,255,${d.type === 'crack' ? 0.95 : 0.5})`;
          ctx.lineWidth = Math.max(2, (d.widthMm / 1000 / surf.width) * texW * 2.2);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          pts.forEach((p, i) => {
            const x = (p.u / surf.width) * texW;
            const y = (p.v / surf.height) * texH;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.stroke();
        }
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // 贴片网格：该表面三角形
        const triStart = surf.triStart, triCount = surf.triCount;
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        const mk = (loc: number, data: ArrayBufferView, size: number) => {
          const b = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, b);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
        };
        mk(0, comp.positions, 3);
        mk(1, comp.normals, 3);
        mk(2, comp.uvs, 2);
        const ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, comp.indices.subarray(triStart, triStart + triCount), gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        out.push({
          componentId: compId, surfaceId, texture: tex, scale, offset,
          vao, indexCount: triCount,
        });
      }
    }
    return out;
  }

  /** 渲染标志点圆盘（切平面 billboard） */
  private markerMesh: { vao: WebGLVertexArrayObject; count: number } | null = null;
  private markerRadius = 0.055;
  private markerData: { fid: FiducialPoint }[] = [];

  buildMarkers(fids: FiducialPoint[], radius: number): void {
    const gl = this.gl;
    this.markerRadius = radius;
    if (this.markerMesh) gl.deleteVertexArray(this.markerMesh.vao);
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    this.markerData = fids.map((fid) => ({ fid }));
    // 每个标志：在其表面切平面上的圆盘（28 段），沿法线抬升 4mm 防 z-fighting
    const lift = 0.004;
    fids.forEach((fid, fi) => {
      void fi;
      const comp = this.findSurface(fid.surfaceId);
      if (!comp) return;
      const surf = comp.surfaces.find((s) => s.id === fid.surfaceId)!;
      const n = surfaceNormalAt(surf, fid.u);
      const ref = Math.abs(n.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
      const t1 = norm(sub(ref, { x: n.x * (ref.x * n.x + ref.y * n.y + ref.z * n.z), y: n.y * (ref.x * n.x + ref.y * n.y + ref.z * n.z), z: n.z * (ref.x * n.x + ref.y * n.y + ref.z * n.z) }));
      const t2 = { x: n.y * t1.z - n.z * t1.y, y: n.z * t1.x - n.x * t1.z, z: n.x * t1.y - n.y * t1.x };
      const onSurf = surfacePoint(surf, fid.u, fid.v);
      const center = { x: onSurf.x + n.x * lift, y: onSurf.y + n.y * lift, z: onSurf.z + n.z * lift };
      const base = positions.length / 3;
      positions.push(center.x, center.y, center.z);
      normals.push(n.x, n.y, n.z);
      uvs.push(0, 0); // 圆心局部偏移 (0,0)
      const seg = 28;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const off = {
          x: (t1.x * Math.cos(a) + t2.x * Math.sin(a)) * radius,
          y: (t1.y * Math.cos(a) + t2.y * Math.sin(a)) * radius,
          z: (t1.z * Math.cos(a) + t2.z * Math.sin(a)) * radius,
        };
        positions.push(center.x + off.x, center.y + off.y, center.z + off.z);
        normals.push(n.x, n.y, n.z);
        // 局部切平面偏移（米），供着色器算径向半径
        const lu = t1.x * off.x + t1.y * off.y + t1.z * off.z;
        const lv = t2.x * off.x + t2.y * off.y + t2.z * off.z;
        uvs.push(lu, lv);
      }
      for (let i = 0; i < seg; i++) indices.push(base, base + 1 + i, base + 1 + i + 1);
    });
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const mk = (loc: number, data: ArrayBufferView, size: number) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    mk(0, new Float32Array(positions), 3);
    mk(1, new Float32Array(normals), 3);
    mk(2, new Float32Array(uvs), 2);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.markerMesh = { vao, count: indices.length };
  }

  private findSurface(surfaceId: string): ComponentDef | null {
    return this.meshes.find((m) => m.comp.surfaces.some((s) => s.id === surfaceId))?.comp ?? null;
  }

  /**
   * 离屏渲染一张合成照片。
   * @param overexpose 0~1，过曝强度
   */
  renderPhoto(
    K: CameraIntrinsics,
    pose: CameraPose,
    opts: { markers?: FiducialPoint[]; cracks?: CrackOverlay[]; overexpose?: number } = {},
  ): HTMLCanvasElement {
    const gl = this.gl;
    const w = K.width, h = K.height;
    this.ensureFbo(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0.06, 0.07, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const view = viewGL(pose);
    const proj = projectionGL(K);
    const camPos = (() => {
      const R = pose.R, t = pose.t;
      return {
        x: -(R[0] * t.x + R[1] * t.y + R[2] * t.z),
        y: -(R[3] * t.x + R[4] * t.y + R[5] * t.z),
        z: -(R[6] * t.x + R[7] * t.y + R[8] * t.z),
      };
    })();

    // 场景
    gl.useProgram(this.sceneProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.sceneProg, 'uView'), false, view);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.sceneProg, 'uProj'), false, proj);
    gl.uniform3f(gl.getUniformLocation(this.sceneProg, 'uCamPos'), camPos.x, camPos.y, camPos.z);
    gl.uniform1i(gl.getUniformLocation(this.sceneProg, 'uHighlight'), 0);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'uTime'), 0);
    for (const m of this.meshes) {
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.indexCount, gl.UNSIGNED_INT, 0);
    }

    // 裂缝贴片
    if (opts.cracks?.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthFunc(gl.LEQUAL);
      gl.useProgram(this.crackProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.crackProg, 'uView'), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.crackProg, 'uProj'), false, proj);
      gl.uniform3f(gl.getUniformLocation(this.crackProg, 'uCamPos'), camPos.x, camPos.y, camPos.z);
      for (const c of opts.cracks) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, c.texture);
        gl.uniform1i(gl.getUniformLocation(this.crackProg, 'uCrackMap'), 0);
        gl.uniform2f(gl.getUniformLocation(this.crackProg, 'uCrackScale'), c.scale[0], c.scale[1]);
        gl.uniform2f(gl.getUniformLocation(this.crackProg, 'uCrackOffset'), c.offset[0], c.offset[1]);
        gl.bindVertexArray(c.vao);
        gl.drawElements(gl.TRIANGLES, c.indexCount, gl.UNSIGNED_INT, 0);
      }
      gl.disable(gl.BLEND);
      gl.depthFunc(gl.LESS);
    }

    // 控制点标志（关闭背面剔除，圆盘从两侧都可见）
    if (opts.markers && this.markerMesh) {
      gl.disable(gl.CULL_FACE);
      gl.useProgram(this.markerProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.markerProg, 'uView'), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.markerProg, 'uProj'), false, proj);
      gl.uniform3f(gl.getUniformLocation(this.markerProg, 'uCamPos'), camPos.x, camPos.y, camPos.z);
      gl.uniform1f(gl.getUniformLocation(this.markerProg, 'uRadius'), this.markerRadius);
      gl.bindVertexArray(this.markerMesh.vao);
      gl.drawElements(gl.TRIANGLES, this.markerMesh.count, gl.UNSIGNED_INT, 0);
      gl.enable(gl.CULL_FACE);
    }

    // 畸变 + 过曝后处理，输出到画布
    const canvas = gl.canvas as HTMLCanvasElement;
    canvas.width = w;
    canvas.height = h;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.postProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.uniform1i(gl.getUniformLocation(this.postProg, 'uScene'), 0);
    gl.uniform2f(gl.getUniformLocation(this.postProg, 'uFocal'), K.f, K.f);
    gl.uniform2f(gl.getUniformLocation(this.postProg, 'uPrincipal'), K.cx, K.cy);
    gl.uniform4f(gl.getUniformLocation(this.postProg, 'uDist'), K.k1, K.k2, K.p1, K.p2);
    gl.uniform2f(gl.getUniformLocation(this.postProg, 'uSize'), w, h);
    gl.uniform1f(gl.getUniformLocation(this.postProg, 'uOverexpose'), opts.overexpose ?? 0);
    gl.bindVertexArray(this.postVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    return canvas;
  }

  /** 读取当前画布像素，返回 ImageBitmap（供存库/显示） */
  async snapshot(): Promise<Blob> {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败'))), 'image/jpeg', 0.92);
    });
  }

  worldToCameraVec(pose: CameraPose, p: Vec3): Vec3 {
    const x = m3mulv(pose.R, p);
    return { x: x.x + pose.t.x, y: x.y + pose.t.y, z: x.z + pose.t.z };
  }
}
