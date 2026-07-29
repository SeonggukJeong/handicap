/** 데이터 바인딩 패널의 매핑 행을 "비분기 행 + 분기별 그룹"으로 나누는 **표시용** 분할.
 *
 *  `rows` 자체는 변형·재정렬하지 않는다(규칙 6a) — `rows` 순서가 곧 제출 `mappings`
 *  순서이고 `profile_json` 바이트이기 때문이다. 각 항목이 **원본 인덱스 `idx`** 를
 *  들고 다니므로 소비처는 `updateRow(idx)`/`removeRow(idx)`를 안전하게 호출할 수 있다.
 */
export type RowRef = { varName: string; manual: boolean };

export type GroupedItem<T> = { row: T; idx: number; varName: string };

export type BindingGroups<T> = {
  ungrouped: { row: T; idx: number }[];
  groups: { branchName: string; items: GroupedItem<T>[] }[];
};

export function partitionBindingRows<T extends RowRef>(
  rows: readonly T[],
  index: Map<string, { branchName: string; varName: string }>,
): BindingGroups<T> {
  const ungrouped: { row: T; idx: number }[] = [];
  const groups: { branchName: string; items: GroupedItem<T>[] }[] = [];
  const byBranch = new Map<string, GroupedItem<T>[]>();

  rows.forEach((row, idx) => {
    // manual 행은 자유 입력칸이라 절대 그룹핑하지 않는다 — 타이핑 도중 행이
    // 다른 그룹으로 점프하면 포커스·커서가 깨진다.
    const hit = row.manual ? undefined : index.get(row.varName);
    if (!hit) {
      ungrouped.push({ row, idx });
      return;
    }
    let items = byBranch.get(hit.branchName);
    if (!items) {
      items = [];
      byBranch.set(hit.branchName, items);
      groups.push({ branchName: hit.branchName, items }); // 첫 등장 순
    }
    items.push({ row, idx, varName: hit.varName });
  });

  return { ungrouped, groups };
}
