import { useEffect, useRef, useState } from "react";
import { ko } from "../../i18n/ko";
import { assertionLabel } from "../../scenario/assertLabel";
import { MAX_STATUS_CODES, type Assertion, type HttpStep } from "../../scenario/model";
import { useScenarioEditor } from "../../scenario/store";
import { mergeStatusLines, passingCodes, statusMode } from "../../scenario/statusMode";
import { Input } from "../ui/Input";
import { Segmented } from "../ui/Segmented";

type ModeKey = "default" | "codes" | "any";

const NOTE_AMBER =
  "rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800";
const NOTE_RED = "rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800";
const BTN =
  "rounded border border-slate-300 bg-white px-2 py-1 text-left text-xs disabled:opacity-50";

function canAdd(raw: string, count: number): boolean {
  if (raw.trim() === "") return false;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 100 && n <= 599 && count < MAX_STATUS_CODES;
}

export function AssertEditor({ step }: { step: HttpStep }) {
  const setStepAssert = useScenarioEditor((s) => s.setStepAssert);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const locked = yamlError !== null;
  const [newCode, setNewCode] = useState("");
  // 이 스텝에서 마지막으로 본 비지 않은 코드 목록 — 방식을 잘못 눌러도 목록을 잃지 않게(에디터엔 되돌리기가 없다).
  useEffect(() => {
    setNewCode("");
  }, [step.id]);
  const lastCodes = useRef(new Map<string, number[]>());

  const mode = statusMode(step.assert);
  useEffect(() => {
    if (mode.kind === "codes" && mode.codes.length > 0) {
      lastCodes.current.set(step.id, mode.codes);
    }
  });

  const write = (asserts: Assertion[]) => setStepAssert(step.id, asserts);

  if (mode.kind === "multi") {
    const labels = mode.lines.map(assertionLabel).join(" / ");
    const k = mode.lines.length;
    const passing = passingCodes(step.assert);
    const merged = mergeStatusLines(step.assert);
    const m = merged[0];
    let note: string;
    let tone = NOTE_AMBER;
    if (passing === "any") {
      note = ko.editor.assertMultiAny(k, labels);
    } else if (passing.length === 0) {
      note = ko.editor.assertMultiFails(k, labels);
      tone = NOTE_RED;
    } else {
      note = ko.editor.assertMultiPassing(k, labels, passing);
    }
    const mergeLabel =
      m?.kind === "status" ? ko.editor.assertMergeCodes(m.codes) : ko.editor.assertMergeAny;
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-xs text-slate-600">{ko.editor.assertStatusLabel}</span>
        <p className={tone}>{note}</p>
        <button type="button" className={BTN} disabled={locked} onClick={() => write(merged)}>
          {mergeLabel}
        </button>
      </div>
    );
  }

  const current: ModeKey = mode.kind;
  const codes = mode.kind === "codes" ? mode.codes : [];

  const onMode = (next: ModeKey) => {
    if (next === current) return;
    if (next === "default") write([]);
    else if (next === "any") write([{ kind: "status_any" }]);
    else write([{ kind: "status", codes: lastCodes.current.get(step.id) ?? [200] }]);
  };

  const addable = canAdd(newCode, codes.length);
  const add = () => {
    if (!addable) return;
    const n = Number(newCode);
    write([{ kind: "status", codes: codes.includes(n) ? codes : [...codes, n] }]);
    setNewCode("");
  };
  const remove = (code: number) => {
    const rest = codes.filter((c) => c !== code);
    write(rest.length === 0 ? [] : [{ kind: "status", codes: rest }]);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-xs text-slate-600">{ko.editor.assertStatusLabel}</span>
      <Segmented<ModeKey>
        size="sm"
        className="w-full"
        ariaLabel={ko.editor.assertModeAria}
        value={current}
        onChange={onMode}
        options={[
          { value: "default", label: ko.editor.assertModeDefault, disabled: locked },
          { value: "codes", label: ko.editor.assertModeCodes, disabled: locked },
          { value: "any", label: ko.editor.assertModeAny, disabled: locked },
        ]}
      />
      {current === "codes" && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {codes.map((c) => (
              <span
                key={c}
                className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white py-0.5 pl-2.5 pr-1 font-mono text-xs"
              >
                {c}
                <button
                  type="button"
                  aria-label={ko.editor.assertRemoveCode(c)}
                  disabled={locked}
                  className="rounded-full px-1 py-0.5 text-sm leading-none text-slate-500 hover:text-red-600 disabled:opacity-50"
                  onClick={() => remove(c)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <div className="w-24">
              <Input
                numeric
                size="sm"
                type="number"
                placeholder={ko.editor.assertCodePlaceholder}
                min={100}
                max={599}
                disabled={locked}
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
              />
            </div>
            <button type="button" className={BTN} disabled={locked || !addable} onClick={add}>
              {ko.common.add}
            </button>
          </div>
        </>
      )}
      {current === "any" ? (
        <p className={NOTE_AMBER}>{ko.editor.assertHintAny}</p>
      ) : (
        <p className="text-xs text-slate-500">
          {current === "codes" ? ko.editor.assertHintCodes : ko.editor.assertHintDefault}
        </p>
      )}
    </div>
  );
}
