/** 미리보기 페이지 크기의 localStorage 영속. `scenario/editorPrefs.ts` 이디엄:
 *  localStorage 불가/오염/비옵션 값 → fail-soft(기본값). */
import { DATASET_ROWS_DEFAULT_PAGE_SIZE, DATASET_ROWS_PAGE_SIZES } from "../../api/hooks";

const KEY = "handicap:dataset:preview-page-size:v1";

export function loadPreviewPageSize(): number {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return DATASET_ROWS_DEFAULT_PAGE_SIZE;
    const n = Number(raw);
    return (DATASET_ROWS_PAGE_SIZES as readonly number[]).includes(n)
      ? n
      : DATASET_ROWS_DEFAULT_PAGE_SIZE;
  } catch {
    return DATASET_ROWS_DEFAULT_PAGE_SIZE;
  }
}

export function savePreviewPageSize(n: number): void {
  try {
    window.localStorage.setItem(KEY, String(n));
  } catch {
    // 프라이빗 모드 등 — 조용히 무시(세션 메모리 상태만으로 동작)
  }
}
