import { findStepById, summarizeCondition, type Step } from "../../scenario/model";
import { METHOD_BADGE } from "./methodBadge";

/** 사용처 목록 한 항목의 표시 정보. */
export interface StepRefDesc {
  /** 배지 — http=메서드, if="IF", 그 외/미발견=null */
  badge: { text: string; colorClass: string } | null;
  /** 라벨 — http=스텝 이름, if=조건 요약, 그 외=스텝 이름, 미발견=raw id */
  label: string;
}

/** 배지의 **레이아웃** 토큰(색 제외) — 소비처가 `${STEP_REF_BADGE_CLASS} ${colorClass}`로 조립한다.
 *  VarUsagePopover와 DeleteVariableDialog가 공유하는 단일 소스라, 여기만 바꾸면 두 표면이 함께 움직인다. */
export const STEP_REF_BADGE_CLASS = "shrink-0 rounded px-1 font-mono text-[10px]";

/** 변수 사용처 항목(`refIds`의 한 원소)을 배지+라벨로 서술한다.
 *  규칙의 정본은 추출 이전 `VarUsagePopover`의 렌더 코드였다 — 바꾸지 말 것. */
export function describeStepRef(steps: Step[], id: string): StepRefDesc {
  const s = findStepById(steps, id);
  if (!s) return { badge: null, label: id };
  if (s.type === "http")
    return {
      badge: {
        text: s.request.method,
        // 폴백은 방어용 — HttpMethod enum 7종이 모두 METHOD_BADGE의 키라 현재 도달 불가.
        colorClass: METHOD_BADGE[s.request.method] ?? "bg-slate-100 text-slate-600",
      },
      label: s.name,
    };
  if (s.type === "if")
    return {
      badge: { text: "IF", colorClass: "bg-slate-100 text-slate-500" },
      label: summarizeCondition(s.cond),
    };
  // loop/parallel — buildVarRefIndex가 http/if의 id만 기록하므로 현재 도달 불가하지만,
  // 이 헬퍼가 두 표면의 정본이므로 id 노출 대신 이름을 쓰는 규칙을 명시해 둔다.
  return { badge: null, label: s.name };
}
