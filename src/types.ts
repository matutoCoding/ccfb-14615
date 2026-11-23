// 领域类型定义：桥梁档案、构件、期次、照片、同名点、病害、评分
export type BridgeType = 'T_GIRDER' | 'BOX_SMALL' | 'BOX_CONT';
export type PartKind =
  | 'main_girder'
  | 'diaphragm'
  | 'cap_beam'
  | 'pier_column'
  | 'bearing'
  | 'abutment'
  | 'deck';

export interface LonLatHeight {
  lon: number;
  lat: number;
  height: number;
}

export interface BridgeSpec {
  type: BridgeType;
  name: string;
  spanCount: number;
  spanLengths: number[]; // 每跨跨径 m
  girderCount: number; // 梁片数
  bridgeWidth: number; // m
  pierHeight: number; // 墩柱高 m
  origin: LonLatHeight; // 桥梁局部坐标系原点(ENU origin)的大地坐标
  bearingGap: number; // 支座与梁底间隙 m
  columnCount: number; // 每墩墩柱数
}

export interface BridgeRecord {
  id: string;
  spec: BridgeSpec;
  createdAt: number;
}

export interface ComponentRecord {
  id: string;
  bridgeId: string;
  code: string; // 自动编号，如 S2-#3 主梁
  label: string;
  part: PartKind;
  spanNo: number; // 1 起；下部结构为 0
  girderNo: number; // 1 起；不适用为 0
  pierNo: number; // 1 起；不适用为 0
  indexNo: number; // 同类序号
}

export interface EpochRecord {
  id: string;
  bridgeId: string;
  name: string;
  date: string;
  note: string;
  createdAt: number;
}

export type PhotoFlag = 'overexposed' | 'no_pos' | 'mismatch' | 'high_residual';
export type PhotoStatus = 'pending' | 'coarse' | 'registered' | 'rejected';

export interface GimbalAngles {
  yaw: number; // 绕 ENU Z 轴，度，北=0 顺时针
  pitch: number; // 绕 Y(横向) 轴，度
  roll: number; // 绕光轴 X 轴，度
}

export interface TiePoint {
  id: string;
  image: [number, number]; // 照片像素坐标(含畸变坐标系)
  world: [number, number, number]; // 桥梁局部 ENU 米制坐标
  residual?: number; // 重投影残差 像素
}

export interface SerializedCamera {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
  r: number[]; // 3x3 列主序
  t: number[]; // 长度 3，相机光心世界坐标
}

export interface PhotoRecord {
  id: string;
  bridgeId: string;
  epochId: string;
  fileName: string;
  width: number;
  height: number;
  pos: LonLatHeight | null;
  gimbal: GimbalAngles | null;
  focalMm: number | null; // 标称焦距(可能带误差)
  camera: SerializedCamera | null;
  status: PhotoStatus;
  flags: PhotoFlag[];
  rms: number | null;
  tiePoints: TiePoint[];
  createdAt: number;
  synthetic?: boolean;
}

export type DefectKind = 'crack' | 'spall' | 'seepage' | 'honeycomb';

export interface DefectPoint {
  world: [number, number, number];
  local: [number, number]; // 构件展开面局部坐标 m
}

export interface DefectRecord {
  id: string;
  bridgeId: string;
  componentId: string;
  epochId: string;
  kind: DefectKind;
  code: string;
  surface: string;
  points: DefectPoint[];
  widthMm: number | null;
  lengthMm: number;
  areaM2: number | null;
  severity: 1 | 2 | 3;
  photoId: string | null;
  note: string;
  predecessorId: string | null; // 上一期对应病害
  createdAt: number;
}

export interface DeductionItem {
  defectId: string;
  kind: DefectKind;
  scale: 1 | 2 | 3;
  baseDeduct: number; // 基础扣分值
  adjusted: number; // 调整后扣分
}

export interface ComponentScore {
  componentId: string;
  score: number;
  grade: 1 | 2 | 3 | 4 | 5;
  items: DeductionItem[];
}

export interface PartScore {
  part: PartKind;
  score: number;
  grade: 1 | 2 | 3 | 4 | 5;
  componentCount: number;
}

export interface BridgeScore {
  epochId: string;
  components: ComponentScore[];
  parts: PartScore[];
  deckScore: number;
  superScore: number;
  subScore: number;
  overallScore: number;
  overallGrade: 1 | 2 | 3 | 4 | 5;
}

export interface SyntheticGroundTruth {
  photoId: string;
  camera: SerializedCamera;
  features: { image: [number, number]; world: [number, number, number] }[];
}
