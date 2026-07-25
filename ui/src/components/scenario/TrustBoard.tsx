import { useState } from "react";
import { Modal } from "../Modal";
import { ko } from "../../i18n/ko";
import type { TestRunState, TrustCheck, TrustReport } from "../../scenario/trust";

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
              <p className="text-slate-600">{FAIL_WHY[c.id]}</p>
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
                  <li key={c.id}>{c.status === "na" ? ko.trust.naLabel : PASS_TEXT[c.id]}</li>
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
