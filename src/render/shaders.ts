// 全部 GLSL3 着色器源码

// 构件实体：颜色模式 / 投影纹理模式 / 展开面模式
export const MESH_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vNormal;
out vec3 vWorld;
out vec2 vUV;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUV = aUV;
  gl_Position = uViewProj * w;
}`;

export const MESH_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec2 vUV;
uniform vec3 uColor;
uniform vec3 uCamPos;
uniform int uMode; // 0 纯色 1 烘焙纹理 2 选中高亮 3 展开棋盘
uniform sampler2D uBaked;
uniform float uBakedReady;
uniform float uOpacity;
out vec4 frag;
void main() {
  vec3 N = normalize(vNormal);
  vec3 L = normalize(vec3(0.35, -0.45, 0.82));
  float diff = max(dot(N, L), 0.0);
  float amb = 0.55;
  vec3 base = uColor;
  if (uMode == 1 && uBakedReady > 0.5) {
    vec3 tex = texture(uBaked, vUV).rgb;
    base = tex;
  }
  if (uMode == 2) {
    base = mix(uColor, vec3(1.0, 0.62, 0.18), 0.55);
  }
  if (uMode == 3) {
    vec2 g = floor(vUV * 4.0);
    float chk = mod(g.x + g.y, 2.0);
    base = mix(uColor, uColor * 1.25, chk);
  }
  vec3 col = base * (amb + diff * 0.55);
  // 边缘轻微描边感
  frag = vec4(col, uOpacity);
}`;

// 投影纹理烘焙：每张照片一个 pass，深度可见性 + 入射角/距离权重，alpha 混合累积
export const BAKE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uModel;
uniform mat4 uCamViewProj; // 照片相机 viewProj(含内参)
out vec3 vNormal;
out vec3 vWorld;
out vec2 vUV;
out vec4 vClip;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUV = aUV;
  vClip = uCamViewProj * w;
  gl_Position = vec4(vUV * 2.0 - 1.0, 0.0, 1.0); // 直接以展开 uv 作为屏幕位置
}`;

export const BAKE_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec2 vUV;
in vec4 vClip;
uniform sampler2D uPhoto;
uniform sampler2D uSceneDepth; // 整桥在该相机下的深度
uniform vec3 uCamCenter;
uniform vec2 uCamF; // fx, fy
uniform vec2 uCamC; // cx, cy
uniform vec2 uCamK; // k1, k2
uniform vec2 uImageSize;
uniform float uNear;
uniform float uFar;
uniform float uProjA; // 自定义投影 z 行系数
uniform float uProjB;
uniform float uMaxAngle; // 最大入射角 cos 阈值
out vec4 frag;

float linearDepth(float d) {
  float ndc = d * 2.0 - 1.0;
  // ndc = -A - B/zc => zc = B / (-ndc - A)
  return uProjB / (-ndc - uProjA);
}
void main() {
  if (vClip.w <= 0.01) discard;
  // 世界点在照片相机系下的坐标
  vec4 ndc = vClip / vClip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0) discard;
  vec2 imgUV = ndc.xy * 0.5 + 0.5;
  // 去畸变采样：先由 NDC 反推归一化像面坐标，再迭代去畸变
  vec2 xn0 = vec2(
    (imgUV.x * uImageSize.x - uCamC.x) / uCamF.x,
    (imgUV.y * uImageSize.y - uCamC.y) / uCamF.y
  );
  vec2 xn = xn0;
  for (int i = 0; i < 8; i++) {
    float r2 = dot(xn, xn);
    float d = 1.0 + uCamK.x * r2 + uCamK.y * r2 * r2;
    vec2 xd = xn * d;
    // Newton
    float drdx = d + 2.0 * (uCamK.x + 2.0 * uCamK.y * r2) * xn.x * xn.x;
    float drdy = d + 2.0 * (uCamK.x + 2.0 * uCamK.y * r2) * xn.y * xn.y;
    float drxy = 2.0 * (uCamK.x + 2.0 * uCamK.y * r2) * xn.x * xn.y;
    float det = drdx * drdy - drxy * drxy;
    vec2 err = xd - xn0;
    xn -= vec2((drdy * err.x - drxy * err.y) / det, (drdx * err.y - drxy * err.x) / det);
  }
  vec2 samplePx = vec2(
    (uCamF.x * xn.x + uCamC.x) / uImageSize.x,
    (uCamF.y * xn.y + uCamC.y) / uImageSize.y
  );
  if (samplePx.x < 0.0 || samplePx.x > 1.0 || samplePx.y < 0.0 || samplePx.y > 1.0) discard;

  // 深度可见性：比较该点深度与场景深度纹理中同像素深度
  float sceneD = linearDepth(texture(uSceneDepth, imgUV).r);
  float myD = linearDepth(ndc.z * 0.5 + 0.5);
  if (myD > sceneD + 0.08) discard; // 被更近的面挡住(容差 8cm)

  // 入射角与距离权重
  vec3 viewDir = normalize(uCamCenter - vWorld);
  vec3 N = normalize(vNormal);
  float cosAng = abs(dot(N, viewDir));
  if (cosAng < uMaxAngle) discard;
  float dist = length(uCamCenter - vWorld);
  float wAngle = pow(cosAng, 1.6);
  float wDist = 1.0 / (1.0 + dist * dist * 0.004);
  float wEdge = 1.0 - smoothstep(0.82, 1.0, max(abs(ndc.x), abs(ndc.y)));
  float w = max(wAngle * wDist * max(wEdge, 0.08), 0.002);
  vec3 color = texture(uPhoto, samplePx).rgb;
  frag = vec4(color * w, w);
}`;

// 合成照片渲染：把整桥按照片相机渲染(带径向畸变与可选裂缝/过曝)
export const PHOTO_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vNormal;
out vec3 vWorld;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uViewProj * w;
}`;

export const PHOTO_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
uniform vec3 uColor;
uniform vec3 uCamCenter;
uniform int uOverexposed;
out vec4 frag;
// 简单 hash 噪声，模拟混凝土颗粒
float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
void main() {
  vec3 N = normalize(vNormal);
  vec3 L = normalize(uCamCenter - vWorld);
  float diff = clamp(abs(dot(N, L)) * 0.7 + 0.4, 0.0, 1.0);
  float grain = (hash(vWorld * 240.0) - 0.5) * 0.07;
  vec3 col = uColor * diff + grain;
  if (uOverexposed == 1) {
    col = mix(col, vec3(1.0), 0.92);
  }
  frag = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// 全屏幕四边形(畸变后处理、正射图显示)
export const QUAD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const DISTORT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform vec2 uF;
uniform vec2 uC;
uniform vec2 uK;
uniform vec2 uImageSize;
out vec4 frag;
void main() {
  vec2 xn0 = vec2(
    (vUV.x * uImageSize.x - uC.x) / uF.x,
    (vUV.y * uImageSize.y - uC.y) / uF.y
  );
  float r2 = dot(xn0, xn0);
  float d = 1.0 + uK.x * r2 + uK.y * r2 * r2;
  vec2 xd = xn0 * d;
  vec2 srcUV = vec2((uF.x * xd.x + uC.x) / uImageSize.x, (uF.y * xd.y + uC.y) / uImageSize.y);
  if (srcUV.x < 0.0 || srcUV.x > 1.0 || srcUV.y < 0.0 || srcUV.y > 1.0) {
    frag = vec4(0.08, 0.09, 0.1, 1.0);
  } else {
    frag = texture(uScene, srcUV);
  }
}`;

// 病害折线(世界空间细线，用三角形带模拟)
export const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }`;

export const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 frag;
void main() { frag = uColor; }`;

// 点精灵(同名点/照片机位)
export const POINT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
uniform float uSize;
void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
  gl_PointSize = uSize;
}`;
export const POINT_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 frag;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  frag = uColor;
}`;
