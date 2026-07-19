import { useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { Input } from "../ui/Input";
import { useThinkTimePair } from "./useThinkTimePair";

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
 *  접이식). min/max 입력의 draft/커밋 규칙은 `useThinkTimePair`가 단일 소스(Inspector·
 *  ThinkTimeBoard와 공유) — 커밋 경계는 "입력을 떠날 때"가 아니라 "짝을 떠날 때".
 *  `shrink-0`은 필수 — VariablesPanel이 flex-1이라 없으면 세로 공간을 다툰다. */
export function ScenarioDefaults() {
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const setDefaultThinkTime = useScenarioEditor((s) => s.setDefaultThinkTime);
  const defaultThink = model?.default_think_time;

  const [open, setOpen] = useState(false);

  // 짝 입력의 draft/커밋 규칙은 useThinkTimePair가 단일 소스(4 사이트 공용).
  // resetKey 없음 — 편집 대상이 시나리오 하나뿐이라 identity가 없다.
  const { minProps, maxProps } = useThinkTimePair({
    value: defaultThink,
    onCommit: (v) => setDefaultThinkTime(v),
    onClear: () => setDefaultThinkTime(undefined),
  });

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
                {...minProps}
                disabled={yamlError !== null}
              />
            </Field>
            <Field label={ko.editor.fieldDefaultThinkMax}>
              <Input
                numeric
                type="number"
                min={0}
                max={600000}
                {...maxProps}
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
