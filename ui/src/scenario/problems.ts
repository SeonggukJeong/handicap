import { ko } from "../i18n/ko";
import { flattenHttpSteps, type Step } from "./model";

/** 배너 한 줄 (spec §5.4). step 항목 = 모델-가용(클릭 시 해당 스텝 선택),
 *  gate 항목 = YAML 파싱/Zod 게이트 실패(모델 stale — 스텝 선택 비활성). */
export type ScenarioProblem =
  | { kind: "step"; stepId: string; message: string }
  | { kind: "gate"; message: string };

/** 게이트 에러(yamlError)가 있으면 모델은 stale — 모델-가용 항목은 내지 않는다
 *  (stale 모델 기준 스텝 선택은 거짓 정보, spec §5.4와 같은 근거). */
export function collectProblems(
  steps: ReadonlyArray<Step> | null,
  yamlError: string | null,
): ScenarioProblem[] {
  if (yamlError !== null) {
    return formatGateMessages(yamlError).map((message) => ({ kind: "gate" as const, message }));
  }
  if (!steps) return [];
  const out: ScenarioProblem[] = [];
  for (const s of flattenHttpSteps(steps)) {
    const url = s.request.url.trim();
    if (url === "") {
      out.push({ kind: "step", stepId: s.id, message: ko.editor.problemEmptyUrl(s.name) });
    } else if (startsWithVar(url)) {
      // ${...}/{{...}} 로 시작 = 변수 — 런타임 해석값을 모르므로 flag 안 함 (false-negative-safe, R6).
    } else if (!/^https?:\/\//i.test(url)) {
      // 변수-prefix가 아닌 리터럴인데 http(s):// 스킴이 없음 → 엔진 fail-fast(status 0). /login·//host·example.com/api·api/users 포괄 (R5/R7).
      out.push({ kind: "step", stepId: s.id, message: ko.editor.problemUrlNeedsScheme(s.name) });
    }
  }
  return out;
}

function startsWithVar(url: string): boolean {
  return url.startsWith("${") || url.startsWith("{{");
}

/** Zod의 따옴표·파이프 구분 목록(`'a' | 'b'` / `'x', 'y'`)을 사람이 읽는 콤마 목록으로.
 *  discriminator/enum 허용값·unrecognized 키 이름에 적용 (spec R6). */
export function normalizeList(s: string): string {
  return s.replace(/'/g, "").replace(/ \| /g, ", ");
}

/** parseScenarioDoc은 Zod issues를 "path: message; path: message"로 join한다(yamlDoc.ts) —
 *  세그먼트별로 알려진 문구를 한국어로 매핑, 못 알아보면 원문 유지(spec §5.4 fallback).
 *  알려진 한계: 메시지 자체에 "; "가 들어 있으면(YAML 라이브러리 멀티 에러 등) 둘로
 *  쪼개진다 — 둘 다 매핑 불가 fallback으로 떨어질 뿐 정보 손실은 없다. */
export function formatGateMessages(yamlError: string): string[] {
  return yamlError.split("; ").map(formatSegment);
}

function formatSegment(seg: string): string {
  let m = /^(.+): Required$/.exec(seg);
  if (m) return ko.editor.gateRequired(m[1]);
  m = /^(.+): (?:step name|branch name|name) required$/.exec(seg);
  if (m) return ko.editor.gateNameRequired(m[1]);
  m = /^(.+): Invalid literal value, expected (.+)$/.exec(seg);
  if (m) return ko.editor.gateInvalidLiteral(m[1], m[2]);
  m = /^(.+): Expected (.+), received (.+)$/.exec(seg);
  if (m) return ko.editor.gateInvalidType(m[1], m[2], m[3]);
  m = /^(.+): duplicate branch name "(.+)"$/.exec(seg);
  if (m) return ko.editor.gateDuplicateBranch(m[1], m[2]);
  m = /^(.+): Invalid discriminator value\. Expected (.+)$/.exec(seg);
  if (m) return ko.editor.gateInvalidChoice(m[1], normalizeList(m[2]));
  m = /^(.+): Invalid enum value\. Expected (.+), received (.+)$/.exec(seg);
  if (m) return ko.editor.gateInvalidChoiceReceived(m[1], normalizeList(m[2]), normalizeList(m[3]));
  m = /^(.+): Unrecognized key\(s\) in object: (.+)$/.exec(seg);
  if (m) return ko.editor.gateUnknownKeys(m[1], normalizeList(m[2]));
  m = /^(.+): String must contain at least 1 character\(s\)$/.exec(seg);
  if (m) return ko.editor.gateEmptyValue(m[1]);
  m = /^(.+): loop body needs at least one step$/.exec(seg);
  if (m) return ko.editor.gateLoopBodyMin(m[1]);
  m = /^(.+): if branch needs at least one step$/.exec(seg);
  if (m) return ko.editor.gateIfBranchMin(m[1]);
  m = /^(.+): elif branch needs at least one step$/.exec(seg);
  if (m) return ko.editor.gateElifBranchMin(m[1]);
  m = /^(.+): parallel needs at least one branch$/.exec(seg);
  if (m) return ko.editor.gateParallelBranchesMin(m[1]);
  m = /^(.+): branch needs at least one step$/.exec(seg);
  if (m) return ko.editor.gateBranchStepsMin(m[1]);
  m = /^(.+): repeat must be >= 1$/.exec(seg);
  if (m) return ko.editor.gateRepeatMin(m[1]);
  return seg;
}
