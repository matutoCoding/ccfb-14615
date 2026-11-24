// 桥梁技术状况评定（依据 JTG/T H21-2011 思路实现）：
// 病害标度 -> 单项扣分值 -> 构件修正扣分 -> 部件(算术平均) -> 部位(权重) -> 全桥 D_r -> 1~5 类。
import type {
  BridgeModel, BridgeRating, ComponentDef, ComponentScore, DefectRecord,
  PartScore, SeverityClass,
} from '../core/types';

// 钢筋混凝土构件裂缝单项扣分（标度 1~5）。表值按规范常用区间取整，可在界面调整。
const CRACK_DEDUCT: Record<number, number> = { 1: 8, 2: 20, 3: 35, 4: 55, 5: 75 };
// 其他病害单项扣分（按标度）
const GENERAL_DEDUCT: Record<DefectRecord['type'], Record<number, number>> = {
  crack: CRACK_DEDUCT,
  spalling: { 1: 10, 2: 22, 3: 38, 4: 58, 5: 80 },
  seepage: { 1: 6, 2: 14, 3: 25, 4: 40, 5: 60 },
  honeycomb: { 1: 5, 2: 12, 3: 22, 4: 36, 5: 55 },
};

// 部位权重（中小跨径梁桥常用值，可在报告里改）
const PART_WEIGHT = {
  superstructure: 0.40,
  substructure: 0.40,
  deck: 0.20,
} as const;

function gradeFromScore(score: number): SeverityClass {
  if (score >= 95) return 1;
  if (score >= 80) return 2;
  if (score >= 60) return 3;
  if (score >= 40) return 4;
  return 5;
}

const GRADE_LABEL: Record<SeverityClass, string> = {
  1: '1类（完好）',
  2: '2类（较好）',
  3: '3类（较差）',
  4: '4类（差）',
  5: '5类（危险）',
};

export function gradeLabel(g: SeverityClass): string {
  return GRADE_LABEL[g];
}

/**
 * 构件评分。
 * 多项病害修正扣分（规范 5.3.2）：
 * 取最高单项 U，其余项按 100 折算：U_corrected = Σ U_i / (√x · 100) × (100 - U_max) + U_max
 * x 为扣分项数（x=1 时不修正）。
 */
export function scoreComponent(comp: ComponentDef, defects: DefectRecord[]): ComponentScore {
  const mine = defects.filter((d) => d.componentId === comp.id);
  if (!mine.length) {
    return { componentId: comp.id, score: 100, grade: 1, deductions: [] };
  }
  const deductions = mine.map((d) => {
    const table = GENERAL_DEDUCT[d.type];
    const deduct = table[d.severity] ?? table[3];
    return {
      defectId: d.id,
      deduct,
      reason: `${d.type === 'crack' ? '裂缝' : d.type === 'spalling' ? '剥落露筋' : d.type === 'seepage' ? '渗水泛白' : '蜂窝麻面'}（标度${d.severity}${
        d.type === 'crack' ? `，宽 ${d.widthMm.toFixed(2)} mm` : ''
      }）扣 ${deduct} 分`,
    };
  });
  const values = deductions.map((x) => x.deduct);
  const uMax = Math.max(...values);
  let corrected: number;
  if (values.length === 1) {
    corrected = uMax;
  } else {
    const sum = values.reduce((a, b) => a + b, 0);
    corrected = (sum / (Math.sqrt(values.length) * 100)) * (100 - uMax) + uMax;
  }
  corrected = Math.min(100, corrected);
  const score = Math.round((100 - corrected) * 10) / 10;
  return { componentId: comp.id, score, grade: gradeFromScore(score), deductions };
}

function partOf(comp: ComponentDef): keyof typeof PART_WEIGHT {
  if (comp.category === 'pier-column' || comp.category === 'bent-cap' || comp.category === 'bearing') return 'substructure';
  if (comp.category === 'deck') return 'deck';
  return 'superstructure';
}

export interface RatingResult {
  rating: BridgeRating;
  componentScores: ComponentScore[];
}

export function rateBridge(
  model: BridgeModel,
  epochId: string,
  defects: DefectRecord[],
): RatingResult {
  const componentScores = model.components.map((c) => scoreComponent(c, defects));
  const parts: PartScore[] = [];
  for (const part of ['superstructure', 'substructure', 'deck'] as const) {
    const comps = model.components.filter((c) => partOf(c) === part);
    const scores = comps.map((c) => componentScores.find((s) => s.componentId === c.id)!);
    if (!scores.length) continue;
    // 部件得分 = 各构件得分算术平均（规范对主要部件也可取加权，这里等权并在报告注明）
    const score = Math.round((scores.reduce((a, s) => a + s.score, 0) / scores.length) * 10) / 10;
    parts.push({ part, score, grade: gradeFromScore(score), componentScores: scores });
  }
  // 全桥 D_r = Σ(部位得分 × 权重)
  const total = Math.round(parts.reduce((a, p) => a + p.score * PART_WEIGHT[p.part], 0) * 10) / 10;
  const rating: BridgeRating = {
    id: `rating:${epochId}`,
    bridgeId: model.spec.id,
    epochId,
    parts,
    totalScore: total,
    grade: gradeFromScore(total),
    ratedAt: Date.now(),
  };
  return { rating, componentScores };
}

export const RATING_META = {
  partWeight: PART_WEIGHT,
  crackTable: CRACK_DEDUCT,
  generalTable: GENERAL_DEDUCT,
  standard: 'JTG/T H21-2011《公路桥梁技术状况评定标准》',
};
