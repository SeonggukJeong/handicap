import { ko } from "../i18n/ko";
import type { Assertion } from "./model";

/** 에디터가 다루는 시나리오의 판정 규칙 번호(서버 `STATUS_RULE_CURRENT`와 같은 값). */
export const EDITOR_STATUS_RULE = 2 as const;

export type StatusMode =
  | { kind: "default" }
  | { kind: "codes"; codes: number[] }
  | { kind: "any" }
  | { kind: "multi"; lines: Assertion[] };

type CodeLine = Extract<Assertion, { kind: "status" }>;

function codeLines(asserts: ReadonlyArray<Assertion>): CodeLine[] {
  return asserts.filter((a): a is CodeLine => a.kind === "status");
}

function dedupe(codes: Iterable<number>): number[] {
  return [...new Set(codes)];
}

/** 검사 줄 구성에서 스텝의 검사 방식을 정하는 단일 소스. */
export function statusMode(asserts: ReadonlyArray<Assertion>): StatusMode {
  if (asserts.length === 0) return { kind: "default" };
  if (asserts.length === 1) {
    const only = asserts[0];
    return only.kind === "status" ? { kind: "codes", codes: dedupe(only.codes) } : { kind: "any" };
  }
  return { kind: "multi", lines: [...asserts] };
}

/** 엔진 `status_unchecked`와 같다: 검사 줄이 1개 이상이고 모두 `status_any`일 때만 참. */
export function statusUnchecked(asserts: ReadonlyArray<Assertion>): boolean {
  return asserts.length > 0 && asserts.every((a) => a.kind === "status_any");
}

/** 여러 줄을 한 줄로 합친다: 코드 줄의 코드를 처음 나온 순서로, 겹침 없이. `any` 줄은 뺀다. */
export function mergeStatusLines(asserts: ReadonlyArray<Assertion>): Assertion[] {
  const lines = codeLines(asserts);
  if (lines.length > 0) return [{ kind: "status", codes: dedupe(lines.flatMap((l) => l.codes)) }];
  return asserts.length > 0 ? [{ kind: "status_any" }] : [];
}

/** 지금 통과하는 코드. 코드 줄이 없으면 "any", 모든 코드 줄에 함께 든 코드가 없으면 빈 배열(항상 실패). */
export function passingCodes(asserts: ReadonlyArray<Assertion>): number[] | "any" {
  const lines = codeLines(asserts);
  if (lines.length === 0) return "any";
  const [first, ...rest] = lines;
  return dedupe(first.codes).filter((c) => rest.every((l) => l.codes.includes(c)));
}

/** 「응답 검증」 구획 머리 덧글. 기본(검사 없음)은 덧글이 없다. */
export function assertHeadHint(
  asserts: ReadonlyArray<Assertion>,
): { text: string; tone: "muted" | "warn" } | null {
  const m = statusMode(asserts);
  switch (m.kind) {
    case "default":
      return null;
    case "codes":
      return { text: ko.editor.assertHeadCodes(m.codes), tone: "muted" };
    case "any":
      return { text: ko.editor.assertHeadAny, tone: "warn" };
    case "multi":
      return { text: ko.editor.assertHeadMulti, tone: "warn" };
  }
}
