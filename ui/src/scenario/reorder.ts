// 그룹내 정렬만 (컨테이너 경계 넘기 = 슬라이스 3). over가 같은 형제 그룹에
// 없으면(다른 컨테이너로 드롭) null = no-op.
export function computeReorder(
  siblingIds: string[],
  activeId: string,
  overId: string | null,
): number | null {
  if (overId === null || activeId === overId) return null;
  const idx = siblingIds.indexOf(overId);
  if (idx === -1) return null; // over가 이 그룹 밖
  if (siblingIds.indexOf(activeId) === -1) return null; // active가 이 그룹 밖
  return idx;
}
