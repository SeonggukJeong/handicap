import { ko } from "../i18n/ko";
import type { HttpStep, Scenario, Step, ThinkTime } from "./model";

/** 스텝의 think-time 설정 상태 5종. 엔진(`runner.rs`/`trace.rs`)의 적용 규칙을 그대로
 *  미러한다 — 여기가 틀리면 현황판이 거짓 부하 정보를 보여준다.
 *  - inherited      : think_time 없음 · 분기 밖 · 기본값 있음   → 실효 = 기본값(0,0이면 대기없음)
 *  - inherited_none : think_time 없음 · 분기 밖 · 기본값 없음   → 실효 = 대기없음
 *  - override       : 값 있음 (0,0 아님)                        → 실효 = 그 값
 *  - no_wait        : 값 = {0,0}                                → 실효 = 대기없음
 *  - parallel_unset : think_time 없음 · 분기 안 (ADR-0033 기본값 미적용) → 실효 = 대기없음 */
export type ThinkState = "inherited" | "inherited_none" | "override" | "no_wait" | "parallel_unset";

export type ThinkRow = {
  stepId: string;
  name: string;
  method: string;
  url: string;
  /** 조상 경로 라벨(" / " 연결) — 최상위면 "". */
  path: string;
  state: ThinkState;
  /** min/max 입력 시드값 — 원본 그대로(정규화하지 않는다). 설정 열 배지는 `state`가 그린다. */
  configured: ThinkTime | undefined;
  /** 실효 대기 — undefined = 대기없음 (R1-a2 정규화 후). */
  effective: ThinkTime | undefined;
  /** parallel 분기 서브트리 안인가. 일괄 [상속으로]의 병렬 안내 카운트(R5)가 이걸 쓴다 —
   *  경로 문자열로 유추하면 안 된다(loop 안 if 경로에도 구분자가 들어간다). */
  insideParallel: boolean;
};

/** {0,0}은 출처와 무관하게 "대기없음"으로 정규화한다(R1-a2). 엔진의 `pace(0)`은
 *  즉시 `Slept`를 반환하므로(`pacing.rs:56-57`) 대기 자체가 없는 것과 구별 불가능하다.
 *  이걸 안 하면 스텝 {0,0}은 "대기없음", 상속된 {0,0}은 "0–0ms"로 같은 동작이 두 문자열이 된다. */
function normalizeEffective(t: ThinkTime): ThinkTime | undefined {
  return t.min_ms === 0 && t.max_ms === 0 ? undefined : t;
}

export function classifyThink(
  step: HttpStep,
  defaultThink: ThinkTime | undefined,
  insideParallel: boolean,
): { state: ThinkState; effective: ThinkTime | undefined; insideParallel: boolean } {
  const own = step.think_time;
  if (own !== undefined) {
    const state: ThinkState = own.min_ms === 0 && own.max_ms === 0 ? "no_wait" : "override";
    return { state, effective: normalizeEffective(own), insideParallel };
  }
  if (insideParallel) {
    return { state: "parallel_unset", effective: undefined, insideParallel };
  }
  if (defaultThink === undefined) {
    return { state: "inherited_none", effective: undefined, insideParallel };
  }
  return { state: "inherited", effective: normalizeEffective(defaultThink), insideParallel };
}

/** think_time min/max 편집기(Inspector·ThinkTimeBoard)가 공유하는 4분기 커밋 규칙(R3).
 *  두 소비처가 이 로직을 한 줄씩 복제하면 한쪽 상한/규칙이 바뀔 때 다른 쪽이 조용히
 *  어긋난다 — 이 순수 판정 함수가 단일 소스다. 호출부는 반환된 outcome에 따라 자기
 *  setState/store 호출만 한다(부수효과는 여기서 하지 않는다 — 두 호출부의 revert 시드가
 *  다르기 때문: Inspector는 step.think_time, ThinkTimeBoard는 row.configured). */
export type ThinkDraftOutcome =
  | { kind: "clear" } // 둘 다 빔 → think_time 키 삭제(상속 복귀)
  | { kind: "noop" } // 정확히 한 칸만 빔 → 아무것도 안 함(draft 보존, 미완성 쌍)
  | { kind: "commit"; value: ThinkTime } // 둘 다 유효 → 커밋
  | { kind: "revert" }; // 그 외(범위 밖·비정수·min>max) → 마지막 커밋값으로 draft 되돌리기

export function resolveThinkDraft(minDraft: string, maxDraft: string): ThinkDraftOutcome {
  const minR = minDraft.trim();
  const maxR = maxDraft.trim();
  if (minR === "" && maxR === "") return { kind: "clear" };
  if (minR === "" || maxR === "") return { kind: "noop" };
  const mn = Number(minR);
  const mx = Number(maxR);
  if (Number.isInteger(mn) && Number.isInteger(mx) && mn >= 0 && mx >= mn && mx <= 600_000) {
    return { kind: "commit", value: { min_ms: mn, max_ms: mx } };
  }
  return { kind: "revert" };
}

/** 전 http leaf를 아웃라인과 같은 깊이우선 순서로 낸다. `flattenHttpSteps`도 같은 순서를
 *  주지만 조상 경로를 잃으므로(그것만이 이 walker가 따로 있는 이유다) 여기서 다시 내려간다. */
export function buildThinkRows(sc: Scenario): ThinkRow[] {
  const out: ThinkRow[] = [];
  const visit = (
    steps: ReadonlyArray<Step>,
    path: ReadonlyArray<string>,
    insideParallel: boolean,
  ) => {
    for (const s of steps) {
      if (s.type === "http") {
        const c = classifyThink(s, sc.default_think_time, insideParallel);
        out.push({
          stepId: s.id,
          name: s.name,
          method: s.request.method,
          url: s.request.url,
          path: path.join(" / "),
          state: c.state,
          configured: s.think_time,
          effective: c.effective,
          insideParallel: c.insideParallel,
        });
      } else if (s.type === "loop") {
        visit(s.do, [...path, s.name], insideParallel);
      } else if (s.type === "parallel") {
        // 분기 서브트리에는 시나리오 기본값이 적용되지 않는다(ADR-0033) — insideParallel=true.
        for (const b of s.branches) visit(b.steps, [...path, `${s.name}·${b.name}`], true);
      } else {
        visit(s.then, [...path, `${s.name}·${ko.editor.condThen}`], insideParallel);
        s.elif.forEach((e, i) =>
          // elifLabel은 1-based (Inspector.tsx:1440/1452 · FlowOutline.tsx:206과 동일).
          visit(e.then, [...path, `${s.name}·${ko.editor.elifLabel(i + 1)}`], insideParallel),
        );
        visit(s.else, [...path, `${s.name}·${ko.editor.condElse}`], insideParallel);
      }
    }
  };
  visit(sc.steps, [], false);
  return out;
}
