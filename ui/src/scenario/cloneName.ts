const COPY_SUFFIX = /^(.*) \(copy(?: (\d+))?\)$/;

/**
 * 복제본 이름을 만든다. base = sourceName에서 기존 "(copy)"/"(copy N)" 접미사를
 * 벗긴 것. 후보 체인은 **항상 "(copy)"부터 위로** 스캔해 existingNames에 없는
 * 첫 빈 자리를 고른다(소스 번호로 시드하지 않음 — "첫 빈 자리" 시맨틱).
 * existingNames에 UNIQUE 강제는 없으니 best-effort 정돈일 뿐.
 */
export function cloneName(sourceName: string, existingNames: string[]): string {
  const m = COPY_SUFFIX.exec(sourceName);
  const base = m ? m[1] : sourceName;
  const taken = new Set(existingNames);
  if (!taken.has(`${base} (copy)`)) return `${base} (copy)`;
  for (let n = 2; ; n++) {
    const candidate = `${base} (copy ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}
