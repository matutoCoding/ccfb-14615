// 领域数据模型：桥梁档案、构件、照片、同名点、病害、检测期。
import type { Vec3 } from './mathTypes';

export type BridgeType = 'simply-supported-t' | 'simply-supported-box' | 'continuous-box';
export type DefectType = 'crack' | 'spalling' | 'seepage' | 'honeycomb';
export type PhotoStatus = 'pending-pos' | 'coarse' | 'registered' | 'rejected-overexposed' | 'approved-overexposed' | 'mismatch';
export type SeverityClass = 1 | 2 | 3 | 4 | 5; // 桥梁技术状况等级（1类最好）

export interface BridgeSpec {
  id: string;
  name: string;
  code: string;
  type: BridgeType;
  spanCount: number;
  /** 每跨跨径（m），长度=spanCount；连续梁可给不同值 */
  spanLengths: number[];
  /** 每跨主梁片数 */
  girderCount: number;
  /** 桥面宽度（m） */
  deckWidth: number;
  /** 梁高（m） */
  girderHeight: number;
  /** 小箱梁顶板宽（m） */
  boxTopWidth: number;
  /** 小箱梁底板宽（m） */
  boxBottomWidth: number;
  /** T 梁翼缘宽（m） */
  flangeWidth: number;
  /** 腹板厚（m） */
  webThickness: number;
  /** 横隔板每跨数量（不含端隔板） */
  diaphragmCount: number;
  /** 墩柱高度（m），长度=spanCount-1 */
  pierHeight: number[];
  /** 每个盖梁下墩柱数 */
  pierColumns: number;
  /** 墩柱直径（m） */
  columnDiameter: number;
  /** 盖梁宽×高（m） */
  capWidth: number;
  capHeight: number;
  /** 桥址经纬度（POS 局部坐标原点） */
  originLon: number;
  originLat: number;
  createdAt: number;
}

export type SurfaceKind = 'planar' | 'cylindrical';

/** 构件表面：所有表面都有解析的 三维<->UV(米制) 映射 */
export interface SurfaceDef {
  id: string;
  name: string;
  kind: SurfaceKind;
  /** 平面：原点 + 两轴；圆柱：origin 轴底点、u 轴为环向基准、axis 为柱轴、radius */
  origin: Vec3;
  uAxis: Vec3; // 平面 U 方向单位向量；圆柱为环向角起点径向
  vAxis: Vec3; // 平面 V 方向单位向量
  normal: Vec3; // 平面外法线
  width: number; // U 向长度（m）
  height: number; // V 向长度（m）
  // 圆柱专用
  radius?: number;
  axis?: Vec3; // 柱轴单位向量
  arcLength?: number; // 环向展开长度（m）
  /** 该表面在构件网格中的三角形索引区间 */
  triStart: number;
  triCount: number;
}

export interface ComponentDef {
  id: string;
  /** 规范编号，如 2-3#主梁 */
  code: string;
  category: 'main-girder' | 'diaphragm' | 'bent-cap' | 'pier-column' | 'bearing' | 'deck';
  spanNo: number; // 跨号，1 起；下部结构用 0 表示桥台/墩号另见 pierNo
  girderNo: number; // 梁号，1 起；不适用为 0
  pierNo: number; // 墩号，1 起（0 号台、n 号台之间）
  name: string;
  /** 构件局部原点（世界坐标） */
  origin: Vec3;
  surfaces: SurfaceDef[];
  /** 网格数据（世界坐标，构件内连续编号） */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array; // 米制 UV（跨表面时按 surfaceId 分段，uv 为局部米）
  triSurfaceIndex: Uint16Array; // 每个三角形所属表面序号
  indices: Uint32Array;
  /** 烘焙纹理（运行期生成，不入库） */
  bakeTexture?: WebGLTexture;
  bakeVersion: number;
}

export interface BridgeModel {
  spec: BridgeSpec;
  components: ComponentDef[];
  /** 全局控制点（编号标志点），合成数据与自动配准共用 */
  fiducials: FiducialPoint[];
  bounds: { min: Vec3; max: Vec3 };
}

export interface FiducialPoint {
  id: number;
  position: Vec3;
  surfaceId: string;
  /** 表面局部 UV（米） */
  u: number;
  v: number;
}

export interface POSData {
  lon: number;
  lat: number;
  altitude: number;
  /** 云台/姿态角（度）：航向 yaw、俯仰 pitch、横滚 roll（ZYX 约定） */
  yaw: number;
  pitch: number;
  roll: number;
  hasPOS: boolean;
}

export interface GCP {
  id: string;
  fiducialId: number | null; // 吸附到控制点时非空
  object: Vec3;
  image: { x: number; y: number };
}

export interface PhotoRecord {
  id: string;
  bridgeId: string;
  epochId: string;
  filename: string;
  width: number;
  height: number;
  pos: POSData;
  status: PhotoStatus;
  /** 过曝比例（0~1），>0.35 进待处理 */
  overexposure: number;
  /** 配准结果 */
  intrinsics?: {
    f: number; cx: number; cy: number; k1: number; k2: number; p1: number; p2: number;
    width: number; height: number;
  };
  /** 世界->相机 R（列主序 9 数）与 t */
  R?: number[];
  t?: [number, number, number];
  gcps?: GCP[];
  rmsPx?: number;
  perPointRmse?: number[];
  /** 纹理/缩略图在 IndexedDB 的 blob key */
  imageBlobKey?: string;
  thumbBlobKey?: string;
  /** 烘焙贡献记录（哪些构件、权重和），运行期用 */
  bakeContribution?: Record<string, number>;
  importedAt: number;
}

export interface DefectPoint {
  /** 构件局部坐标（米，沿表面 U/V）；同一病害允许跨表面，逐点带 surfaceId */
  surfaceId: string;
  u: number;
  v: number;
}

export interface DefectRecord {
  id: string;
  bridgeId: string;
  epochId: string;
  componentId: string;
  type: DefectType;
  /** 折线（裂缝）或闭合轮廓（剥落等）的点序列，米制局部坐标 */
  points: DefectPoint[];
  /** 长度（m），入库时计算 */
  lengthM: number;
  /** 面积（m²），面状病害用 */
  areaM2: number;
  /** 裂缝宽度（mm），可逐点或单值 */
  widthMm: number;
  /** 现场标注的严重程度（1~5 类，映射评定标准） */
  severity: SeverityClass;
  description: string;
  /** 来源照片与绘制时的像素轨迹（回溯用） */
  sourcePhotoId?: string;
  createdAt: number;
}

export interface InspectionEpoch {
  id: string;
  bridgeId: string;
  name: string;
  date: string; // ISO yyyy-mm-dd
  note: string;
  createdAt: number;
}

export interface ComponentScore {
  componentId: string;
  score: number; // 0~100，分值越高越好
  grade: SeverityClass;
  deductions: { defectId: string; deduct: number; reason: string }[];
}

export interface PartScore {
  part: 'superstructure' | 'substructure' | 'deck';
  score: number;
  grade: SeverityClass;
  componentScores: ComponentScore[];
}

export interface BridgeRating {
  id: string;
  bridgeId: string;
  epochId: string;
  parts: PartScore[];
  totalScore: number;
  grade: SeverityClass;
  ratedAt: number;
}

export interface ComparisonChange {
  componentId: string;
  surfaceId: string;
  kind: 'extended' | 'new' | 'unchanged';
  defectIdA?: string;
  defectIdB?: string;
  extensionM: number;
  description: string;
}

export interface EpochComparison {
  id: string;
  bridgeId: string;
  epochA: string;
  epochB: string;
  changes: ComparisonChange[];
  createdAt: number;
}

export const DEFECT_TYPE_LABEL: Record<DefectType, string> = {
  crack: '裂缝',
  spalling: '剥落露筋',
  seepage: '渗水泛白',
  honeycomb: '蜂窝麻面',
};

export const STATUS_LABEL: Record<PhotoStatus, string> = {
  'pending-pos': '缺POS',
  coarse: '粗投待校正',
  registered: '已配准',
  'rejected-overexposed': '过曝待处理',
  'approved-overexposed': '过曝已采纳',
  mismatch: '配不上',
};
