import { ko } from "../i18n/ko";
import type { Assertion } from "./model";

/** 검사 줄에 보이는 글자 — 코드는 가운뎃점으로 잇고, any는 「보지 않음」. */
export function assertionLabel(a: Assertion): string {
  return a.kind === "status_any" ? ko.editor.assertStatusAny : a.codes.join("·");
}
