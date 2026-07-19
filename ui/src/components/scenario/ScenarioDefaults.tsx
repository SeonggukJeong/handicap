import { useEffect, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { Input } from "../ui/Input";
import { resolveThinkDraft } from "../../scenario/thinkTime";

/** ScenarioDefaults의 min/max 입력 전용 로컬 Field — Inspector.tsx의 동명 로컬
 *  이디엄(label span + children, htmlFor 없는 암묵 연관)과 시각적으로 동일하게 유지. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

/** 왼쪽 패널의 접이식 "시나리오 기본값" 섹션(R7) — VariablesPanel 아래 마운트.
 *  기본 접힘 + 값이 있으면 접힌 상태에 "설정됨" 힌트(사용자 선호: optional 섹션은
 *  접이식). min/max 입력은 Inspector의 `commitThinkTime`과 동일한 draft +
 *  commit-on-blur 규칙(둘 다 비면 삭제/한 칸만 비면 no-op/둘 다 유효하면 커밋/그 외
 *  revert). `shrink-0`은 필수 — VariablesPanel이 flex-1이라 없으면 세로 공간을 다툰다. */
export function ScenarioDefaults() {
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const setDefaultThinkTime = useScenarioEditor((s) => s.setDefaultThinkTime);
  const defaultThink = model?.default_think_time;

  const [open, setOpen] = useState(false);
  const [minDraft, setMinDraft] = useState(defaultThink ? String(defaultThink.min_ms) : "");
  const [maxDraft, setMaxDraft] = useState(defaultThink ? String(defaultThink.max_ms) : "");

  useEffect(() => {
    setMinDraft(defaultThink ? String(defaultThink.min_ms) : "");
    setMaxDraft(defaultThink ? String(defaultThink.max_ms) : "");
  }, [defaultThink]);

  // 4분기 커밋 규칙은 thinkTime.ts::resolveThinkDraft가 단일 소스다 — Inspector·
  // ThinkTimeBoard와 규칙을 공유한다. 여기선 outcome에 따른 store/setState 호출만.
  const commit = () => {
    const outcome = resolveThinkDraft(minDraft, maxDraft);
    switch (outcome.kind) {
      case "clear":
        setDefaultThinkTime(undefined);
        return;
      case "noop":
        return;
      case "commit":
        setDefaultThinkTime(outcome.value);
        return;
      case "revert":
        setMinDraft(defaultThink ? String(defaultThink.min_ms) : "");
        setMaxDraft(defaultThink ? String(defaultThink.max_ms) : "");
        return;
    }
  };

  return (
    <section className="shrink-0 flex flex-col gap-2 border border-slate-200 rounded p-3 text-sm">
      <div className="flex items-center gap-1 text-xs font-semibold text-slate-600">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="hover:underline"
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> {ko.editor.scenarioDefaultsTitle}
        </button>
        {!open && defaultThink !== undefined && (
          <span className="font-normal text-slate-400">{ko.editor.defaultThinkSetHint}</span>
        )}
      </div>
      {open && (
        <>
          <div className="flex gap-2">
            <Field label={ko.editor.fieldDefaultThinkMin}>
              <Input
                numeric
                type="number"
                min={0}
                max={600000}
                value={minDraft}
                onChange={(e) => setMinDraft(e.target.value)}
                onBlur={commit}
                disabled={yamlError !== null}
              />
            </Field>
            <Field label={ko.editor.fieldDefaultThinkMax}>
              <Input
                numeric
                type="number"
                min={0}
                max={600000}
                value={maxDraft}
                onChange={(e) => setMaxDraft(e.target.value)}
                onBlur={commit}
                disabled={yamlError !== null}
              />
            </Field>
          </div>
          <p className="text-xs text-slate-500">{ko.editor.defaultThinkHint}</p>
          <HelpTip label={ko.editor.defaultThinkParallelHelpLabel}>
            {ko.editor.defaultThinkParallelHelp}
          </HelpTip>
        </>
      )}
    </section>
  );
}
