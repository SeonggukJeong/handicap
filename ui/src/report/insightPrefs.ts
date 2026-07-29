const KEY = "handicap:report:insight-actions:v1";

/**
 * 인사이트 일반 안내(조치문) 표시 여부. 기본값 false(숨김) — 전문가에게 조용한
 * 기본값이 이 기능의 헤드라인이다. malformed·접근 실패는 기본값으로 폴백(throw 금지).
 */
export function readShowInsightActions(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function writeShowInsightActions(v: boolean): void {
  try {
    window.localStorage.setItem(KEY, v ? "true" : "false");
  } catch {
    // 저장 실패는 무시 — 표시 설정 소실은 기능에 영향 없음
  }
}
