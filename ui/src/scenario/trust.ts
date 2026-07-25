import { flattenHttpSteps, type Scenario } from "./model";
import { undefinedVarRefs } from "./scanVars";
import { buildVarRows } from "./varRows";

export type TrustCheckId = "response_validation" | "undefined_vars" | "broken_extract_chain";

export type TrustCheckStatus = "pass" | "fail" | "na";
export type TrustLevel = "good" | "caution" | "weak";

/** D(시험 실행 미검증)는 등급과 무관한 별개 상태다(spec D19). 타입은 여기서 선언·export하고
 *  `trustPrefs.ts`가 import한다(의존은 trustPrefs → trust 단방향). */
export type TestRunState = "verified" | "stale" | "never";

export interface TrustCheck {
  id: TrustCheckId;
  status: TrustCheckStatus;
  /** A 전용: 검증이 없는 http 스텝(문서순). B·C는 항상 빈 배열(spec D14). */
  steps: Array<{ id: string; name: string }>;
  /** B·C 전용: 걸린 변수 개수. A는 0. */
  count: number;
}

export interface TrustReport {
  level: TrustLevel;
  /** 항상 3개, 고정 순서 A→B→C. */
  checks: TrustCheck[];
  passed: number;
  applicable: number;
  /** 칩 숫자 = RunDialog 건수 (최대 3). */
  failed: number;
  noValidationAtAll: boolean;
}

/** http 스텝이 0개면 신뢰도를 평가하지 않는다(spec D12) — 호출부가 이걸로 칩을 숨긴다. */
export function isTrustApplicable(scenario: Scenario): boolean {
  return flattenHttpSteps(scenario.steps).length > 0;
}

/**
 * 시나리오 정적 신뢰도(spec §4~§5). **test-run 상태를 받지 않는다** — D를 등급에 섞으면
 * 등급이 사람마다 달라진다(spec D19/FR1). 순수 함수: localStorage·시간·난수 미사용.
 */
export function evaluateTrust(scenario: Scenario): TrustReport {
  const https = flattenHttpSteps(scenario.steps);

  // A — 모든 http 스텝이 status assert를 가져야 통과(전칭). 1차 서버 판정은 존재 한정이다.
  const missing = https.filter((s) => !s.assert.some((x) => x.kind === "status"));
  const withAssertCount = https.length - missing.length;
  const a: TrustCheck =
    https.length === 0
      ? { id: "response_validation", status: "na", steps: [], count: 0 }
      : {
          id: "response_validation",
          status: missing.length > 0 ? "fail" : "pass",
          steps: missing.map((s) => ({ id: s.id, name: s.name })),
          count: 0,
        };

  // B — 위치 인식 판정은 undefinedVarRefs에 위임(재구현 금지).
  const undef = undefinedVarRefs(scenario);
  const b: TrustCheck = {
    id: "undefined_vars",
    status: undef.size > 0 ? "fail" : "pass",
    steps: [],
    count: undef.size,
  };

  // C — VariablesPanel이 `미사용` 배지를 붙이는 조건과 **동일**(refIds가 빔).
  const extractRows = buildVarRows(scenario).filter(
    (r) => r.kind === "flat-extract" || r.kind === "parallel-extract",
  );
  const unused = extractRows.filter((r) => r.refIds.length === 0);
  const c: TrustCheck =
    extractRows.length === 0
      ? { id: "broken_extract_chain", status: "na", steps: [], count: 0 }
      : {
          id: "broken_extract_chain",
          status: unused.length > 0 ? "fail" : "pass",
          steps: [],
          count: unused.length,
        };

  const checks = [a, b, c];
  const failed = checks.filter((x) => x.status === "fail").length;
  const passed = checks.filter((x) => x.status === "pass").length;
  const applicable = checks.filter((x) => x.status !== "na").length;

  // 증폭 조건은 "검증 **전무**"다 — 부분 검증(9/10)은 그 9개에서 시끄럽게 실패하므로
  // 증폭기가 아니다. `A fail`로 바꾸면 진리표 행 4가 깨진다.
  const noValidationAtAll = https.length > 0 && withAssertCount === 0;

  const level: TrustLevel =
    b.status === "fail" || (noValidationAtAll && c.status === "fail")
      ? "weak"
      : failed > 0
        ? "caution"
        : "good";

  return { level, checks, passed, applicable, failed, noValidationAtAll };
}
