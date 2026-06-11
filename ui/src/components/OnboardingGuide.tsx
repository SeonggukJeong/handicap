import { useState } from "react";
import { Link } from "react-router-dom";
import { ko } from "../i18n/ko";
import { dismissOnboarding, readOnboarding } from "../onboarding/state";

const CTA_CLASS = "text-slate-700 underline hover:text-slate-900";

/**
 * 홈 시작 가이드 카드 (U2, spec §3.1).
 * ①은 서버 진실(firstScenarioId 존재), ②③은 localStorage 플래그.
 * 3단계 완료 또는 dismiss 시 영구 숨김. ②③ 링크는 첫 시나리오의 실행 목록
 * (전역 run 목록 API 부재 — 루트 CLAUDE.md).
 */
export function OnboardingGuide({ firstScenarioId }: { firstScenarioId: string | null }) {
  const [state, setState] = useState(readOnboarding);
  const hasScenario = firstScenarioId !== null;
  if (state.dismissed) return null;
  if (hasScenario && state.runCreated && state.reportViewed) return null;

  const runsHref = hasScenario ? `/scenarios/${firstScenarioId}/runs` : null;
  const steps = [
    {
      done: hasScenario,
      title: ko.onboarding.step1Title,
      desc: ko.onboarding.step1Desc,
      cta: (
        <Link to="/scenarios/new" className={CTA_CLASS}>
          {ko.onboarding.step1Cta} →
        </Link>
      ),
    },
    {
      done: state.runCreated,
      title: ko.onboarding.step2Title,
      desc: ko.onboarding.step2Desc,
      cta: runsHref ? (
        <Link to={runsHref} className={CTA_CLASS}>
          {ko.onboarding.step2Cta} →
        </Link>
      ) : (
        <span className="text-slate-400">{ko.onboarding.step2Blocked}</span>
      ),
    },
    {
      done: state.reportViewed,
      title: ko.onboarding.step3Title,
      desc: ko.onboarding.step3Desc,
      cta:
        state.runCreated && runsHref ? (
          <Link to={runsHref} className={CTA_CLASS}>
            {ko.onboarding.step3Cta} →
          </Link>
        ) : (
          <span className="text-slate-400">{ko.onboarding.step3Blocked}</span>
        ),
    },
  ];

  return (
    <section
      aria-label={ko.onboarding.ariaLabel}
      className="mb-6 border border-slate-200 rounded-md p-4 bg-white"
    >
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-semibold">{ko.onboarding.title}</h3>
        <button
          type="button"
          aria-label={ko.onboarding.dismiss}
          onClick={() => {
            dismissOnboarding();
            // localStorage 불가 환경에서도 세션 내에선 숨김 (영속 실패 시 fail-soft의 보완)
            setState((s) => ({ ...s, dismissed: true }));
          }}
          className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100"
        >
          ✕
        </button>
      </div>
      <ol className="mt-3 grid gap-4 sm:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-2 text-sm">
            <span aria-hidden="true" className={s.done ? "text-emerald-600" : "text-slate-400"}>
              {s.done ? "✓" : i + 1}
            </span>
            <span className="min-w-0">
              <span className="font-medium">
                {s.title}
                {s.done && <span className="sr-only"> ({ko.onboarding.done})</span>}
              </span>
              <span className="block text-slate-500">{s.desc}</span>
              {!s.done && <span className="block mt-1">{s.cta}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
