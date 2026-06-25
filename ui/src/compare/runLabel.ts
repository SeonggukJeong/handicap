// runLabel.ts — run 표시 정체성(짧은 라벨 + 위치-인덱스 색)을 비교 매트릭스 헤더와
// 오버레이 범례가 공유해 두 표면이 절대 어긋나지 않게 하는 단일 소스(spec R1/R5).
export function runShortLabel(id: string): string {
  return `#${id.slice(-6)}`;
}

// 비교 뷰는 상류(ScenarioRunsPage)에서 5개 run으로 상한 → modulo는 실제로 순환 안 함(방어적).
const RUN_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];

export function runColor(index: number): string {
  return RUN_COLORS[index % RUN_COLORS.length];
}
