// 技术状况评定：构件扣分 -> 部件 -> 桥面系/上部/下部 -> 全桥等级
// 规则参照 JTG/T H21-2011 思路做工程化简化，分值表内置可调
import { BridgeScore, ComponentScore, ComponentRecord, DefectKind, DefectRecord, DeductionItem, PartScore, PartKind } from '../types';

// 基础扣分值表 [轻微, 中等, 严重]
const BASE_DEDUCT: Record<DefectKind, [number, number, number]> = {
  crack: [12, 25, 42],
  spall: [18, 35, 55],
  seepage: [8, 16, 28],
  honeycomb: [6, 14, 24],
};

const KIND_NAME: Record<DefectKind, string> = {
  crack: '裂缝', spall: '剥落露筋', seepage: '渗水泛白', honeycomb: '蜂窝麻面',
};
export function kindName(k: DefectKind): string {
  return KIND_NAME[k];
}

function gradeFromScore(score: number): 1 | 2 | 3 | 4 | 5 {
  if (score >= 95) return 1;
  if (score >= 80) return 2;
  if (score >= 60) return 3;
  if (score >= 40) return 4;
  return 5;
}

// 多病害调整系数 t：按 H21 1/√m 趋势的连续近似
function adjustmentFactor(count: number, maxScale: number): number {
  if (count <= 1) return 1;
  return 100 / Math.pow(count, 0.5) / (100 / Math.pow(count, 0.5)) * (1 - 0.12 * Math.min(count - 1, 5) * (maxScale / 3));
}

export function scoreComponent(comp: ComponentRecord, defects: DefectRecord[]): ComponentScore {
  const mine = defects.filter((d) => d.componentId === comp.id);
  const items: DeductionItem[] = mine.map((d) => {
    const base = BASE_DEDUCT[d.kind][d.severity - 1];
    return { defectId: d.id, kind: d.kind, scale: d.severity, baseDeduct: base, adjusted: base };
  });
  if (items.length > 1) {
    const maxScale = Math.max(...items.map((i) => i.scale));
    const factor = adjustmentFactor(items.length, maxScale);
    for (const it of items) it.adjusted = Math.round(it.baseDeduct * factor * 10) / 10;
  }
  const totalDeduct = Math.min(100, items.reduce((s, i) => s + i.adjusted, 0));
  const score = Math.round((100 - totalDeduct) * 10) / 10;
  return { componentId: comp.id, score, grade: gradeFromScore(score), items };
}

const SUPER_PARTS: PartKind[] = ['main_girder', 'diaphragm', 'bearing', 'deck'];
const SUB_PARTS: PartKind[] = ['cap_beam', 'pier_column', 'abutment'];

export function scoreBridge(epochId: string, components: ComponentRecord[], defects: DefectRecord[]): BridgeScore {
  const compScores = components.map((c) => scoreComponent(c, defects));
  const parts: PartScore[] = [];
  const partKinds = [...new Set(components.map((c) => c.part))];
  for (const kind of partKinds) {
    const ids = components.filter((c) => c.part === kind).map((c) => c.id);
    const scores = compScores.filter((s) => ids.includes(s.componentId));
    // 部件得分 = 均值 * 0.6 + 最低分 * 0.4，突出最差构件
    const mean = scores.reduce((s, x) => s + x.score, 0) / Math.max(1, scores.length);
    const min = Math.min(...scores.map((x) => x.score));
    const score = Math.round((mean * 0.6 + min * 0.4) * 10) / 10;
    parts.push({ part: kind, score, grade: gradeFromScore(score), componentCount: scores.length });
  }
  const partScore = (k: PartKind): number => parts.find((p) => p.part === k)?.score ?? 100;
  const deckScore = partScore('deck');
  // 上部结构：主梁权重 0.7，横隔板 0.2，支座 0.1
  const superScore = Math.round(
    (partScore('main_girder') * 0.7 + partScore('diaphragm') * 0.2 + partScore('bearing') * 0.1) * 10
  ) / 10;
  // 下部结构：盖梁 0.45，墩柱 0.4，桥台 0.15
  const subScore = Math.round(
    (partScore('cap_beam') * 0.45 + partScore('pier_column') * 0.4 + partScore('abutment') * 0.15) * 10
  ) / 10;
  // 全桥：桥面系 0.15、上部 0.55、下部 0.30
  const overallScore = Math.round((deckScore * 0.15 + superScore * 0.55 + subScore * 0.3) * 10) / 10;
  return {
    epochId,
    components: compScores,
    parts,
    deckScore,
    superScore,
    subScore,
    overallScore,
    overallGrade: gradeFromScore(overallScore),
  };
}

export const GRADE_NAMES: Record<number, string> = {
  1: '1类(完好)', 2: '2类(良好)', 3: '3类(较差)', 4: '4类(差)', 5: '5类(危险)',
};
