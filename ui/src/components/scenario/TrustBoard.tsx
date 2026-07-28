import { useState } from "react";
import { Modal } from "../Modal";
import { ko } from "../../i18n/ko";
import type { TestRunState, TrustCheck, TrustReport } from "../../scenario/trust";
import { bFailMode } from "../../scenario/trust";

const FAIL_TITLE: Record<TrustCheck["id"], (n: number) => string> = {
  response_validation: () => ko.trust.checkAFailTitle,
  undefined_vars: (n) => ko.trust.checkBFailTitle(n),
  broken_extract_chain: (n) => ko.trust.checkCFailTitle(n),
};
const FAIL_WHY: Record<TrustCheck["id"], string> = {
  response_validation: ko.trust.checkAFailWhy,
  undefined_vars: ko.trust.checkBFailWhy,
  broken_extract_chain: ko.trust.checkCFailWhy,
};
const PASS_TEXT: Record<TrustCheck["id"], string> = {
  response_validation: ko.trust.checkAPass,
  undefined_vars: ko.trust.checkBPass,
  broken_extract_chain: ko.trust.checkCPass,
};
/** na 줄도 통과 줄처럼 **어떤 점검이 왜** 해당 없는지 말해야 한다 — 공통 "해당 항목 없음"은
 *  이 목록에서 맥락을 잃어(통과 줄들은 내용으로 자기를 식별한다) 처음 보는 사용자가
 *  무엇이 해당 없는지 알 수 없다. */
const NA_TEXT: Record<TrustCheck["id"], string> = {
  response_validation: ko.trust.checkANa,
  undefined_vars: ko.trust.checkBNa,
  broken_extract_chain: ko.trust.checkCNa,
};
const TEST_RUN_TEXT: Record<TestRunState, string> = {
  never: ko.trust.testRunNever,
  stale: ko.trust.testRunStale,
  verified: ko.trust.testRunVerified,
};

export function TrustBoard({
  open,
  onClose,
  report,
  testRun,
  onSelectStep,
  onOpenVars,
}: {
  open: boolean;
  onClose: () => void;
  /** null = YAML 게이트 보류(spec §7.4) — 등급을 렌더하지 않는다. */
  report: TrustReport | null;
  testRun: TestRunState;
  onSelectStep: (stepId: string) => void;
  onOpenVars: () => void;
}) {
  const [passedOpen, setPassedOpen] = useState(false);

  if (report === null) {
    return (
      <Modal open={open} onClose={onClose} title={ko.trust.boardTitle}>
        <p className="text-sm text-slate-700">{ko.trust.boardGateBlocked}</p>
      </Modal>
    );
  }

  const failed = report.checks.filter((c) => c.status === "fail");
  const rest = report.checks.filter((c) => c.status !== "fail");

  return (
    <Modal open={open} onClose={onClose} title={ko.trust.boardTitle}>
      <div className="flex flex-col gap-3 text-sm">
        <div>
          <p className="font-medium">
            {ko.trust.level[report.level]} · {ko.trust.boardCount(report.passed, report.applicable)}
          </p>
          <p className="mt-1 text-slate-600">{ko.trust.boardSubtitle}</p>
          {report.level === "good" && (
            <p className="mt-1 text-slate-600">{ko.trust.boardGoodNote}</p>
          )}
        </div>

        <ul className="flex flex-col gap-2">
          {failed.map((c) => (
            <li key={c.id}>
              <p className="font-medium">
                <span aria-hidden="true">✗</span> {FAIL_TITLE[c.id](c.count)}
              </p>
              {/* B는 위치 클래스로 결과가 갈린다(spec §5.1): misroute만 cond 문구,
                  annihilation·null(빈 vars 방어)은 기존 문구 — FAIL_WHY가 그 폴백. */}
              <p className="text-slate-600">
                {c.id === "undefined_vars" && bFailMode(c.vars) === "misroute"
                  ? ko.trust.checkBFailWhyCond
                  : FAIL_WHY[c.id]}
              </p>
              {c.id === "response_validation" ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.steps.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100"
                      onClick={() => {
                        onSelectStep(s.id);
                        onClose();
                      }}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  className="mt-1 underline hover:text-slate-900"
                  onClick={() => {
                    onOpenVars();
                    onClose();
                  }}
                >
                  {ko.trust.varsPanelLink}
                </button>
              )}
            </li>
          ))}
        </ul>

        {rest.length > 0 && (
          <div>
            {/* 접힘 라벨은 passed 기준 — na를 "통과"로 세지 않는다(spec D7). */}
            <button
              type="button"
              aria-expanded={passedOpen}
              className="text-left text-slate-600 hover:text-slate-900"
              onClick={() => setPassedOpen((v) => !v)}
            >
              <span aria-hidden="true">{passedOpen ? "▾" : "▸"}</span>{" "}
              {ko.trust.boardPassedFold(report.passed)}
            </button>
            {passedOpen && (
              <ul className="mt-1 flex flex-col gap-1 text-slate-600">
                {rest.map((c) => (
                  <li key={c.id}>{c.status === "na" ? NA_TEXT[c.id] : PASS_TEXT[c.id]}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* D — 등급 미반영(spec D19). 접지 않는다(D13). */}
        <div className="border-t border-slate-200 pt-2 text-slate-600">
          <p>
            <span aria-hidden="true">○</span> {TEST_RUN_TEXT[testRun]}
          </p>
          <p className="text-xs">{ko.trust.testRunScope}</p>
        </div>
      </div>
    </Modal>
  );
}
