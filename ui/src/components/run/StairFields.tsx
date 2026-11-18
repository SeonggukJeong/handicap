import { useEffect, useId, useState } from "react";
import { ko } from "../../i18n/ko";
import { formatDurationKo } from "../../i18n/duration";
import { Button } from "../Button";
import { HelpTip } from "../HelpTip";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { AutoStopFields } from "./AutoStopFields";
import { draftToStairConfig, generateTargets, stairSummary, type StairDraft } from "./stair";

type Multiple = 1.5 | 2 | 2.5 | 3;
const MULTIPLES: { value: Multiple; label: string }[] = [
  { value: 1.5, label: "1.5×" },
  { value: 2, label: "2×" },
  { value: 2.5, label: "2.5×" },
  { value: 3, label: "3×" },
];

type Props = {
  value: StairDraft;
  onChange: (next: StairDraft) => void;
  errors: Partial<
    Record<
      | "targets"
      | "hold"
      | "ramp"
      | "discard"
      | "p99Cap"
      | "emErrorPct"
      | "emP99Ms"
      | "emSeconds"
      | "emMinRequests",
      string
    >
  >;
};

export function StairFields({ value, onChange, errors }: Props) {
  const ids = {
    goal: useId(),
    multiple: useId(),
    targets: useId(),
    hold: useId(),
    ramp: useId(),
    discard: useId(),
    p99Cap: useId(),
    judge: useId(),
  };
  const [goal, setGoal] = useState("");
  const [multiple, setMultiple] = useState<Multiple>(1.5);
  const [judgeOpen, setJudgeOpen] = useState(errors.p99Cap !== undefined);
  const [targetsTouched, setTargetsTouched] = useState(false);
  const capError = errors.p99Cap !== undefined;
  // 오류가 생기면 펼쳐 두고, 고친 뒤에도 그대로 둔다(포커스된 입력이 사라지지 않게).
  useEffect(() => {
    if (capError) setJudgeOpen(true);
  }, [capError]);
  // 아직 건드리지 않은 빈 칸은 붉게 칠하지 않는다(실행 버튼은 어차피 막혀 있다).
  const targetsError = targetsTouched || value.targets.trim() !== "" ? errors.targets : undefined;
  const set = (patch: Partial<StairDraft>) => onChange({ ...value, ...patch });

  const goalNum = Number(goal);
  const goalValid = goal.trim() !== "" && Number.isInteger(goalNum) && goalNum >= 1;
  const makeList = () => {
    if (!goalValid) return;
    setTargetsTouched(true);
    set({ targets: generateTargets(goalNum, multiple).join(", ") });
  };

  const cfg = draftToStairConfig(value);
  const sm = cfg ? stairSummary(cfg) : null;
  const judgeShown = judgeOpen;
  const capSet = value.p99Cap.trim() !== "";

  return (
    <div className="mb-3" data-testid="stair-fields">
      <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 p-3">
        <p className="mb-2 text-xs font-semibold text-slate-600">{ko.loadModel.stairHelperTitle}</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-36">
            <Field
              label={ko.loadModel.stairGoalLabel}
              htmlFor={ids.goal}
              help={<HelpTip label="목표 설명">{ko.loadModel.stairGoalHelp}</HelpTip>}
            >
              <Input
                id={ids.goal}
                type="number"
                min={1}
                max={1000000}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                numeric
              />
            </Field>
          </div>
          <div className="w-28">
            <Field label={ko.loadModel.stairMultipleLabel} htmlFor={ids.multiple}>
              <Select
                id={ids.multiple}
                value={String(multiple)}
                onChange={(e) => setMultiple(Number(e.target.value) as Multiple)}
              >
                {MULTIPLES.map((m) => (
                  <option key={m.value} value={String(m.value)}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="mb-3">
            <Button type="button" onClick={makeList} disabled={!goalValid}>
              {ko.loadModel.stairMakeList}
            </Button>
          </div>
        </div>
        <p className="text-xs text-slate-500">{ko.loadModel.stairHelperNote}</p>
      </div>

      <Field
        label={ko.loadModel.stairTargetsLabel}
        htmlFor={ids.targets}
        error={targetsError}
        errorId={`${ids.targets}-error`}
      >
        <Input
          id={ids.targets}
          type="text"
          placeholder={ko.loadModel.stairTargetsPlaceholder}
          value={value.targets}
          onChange={(e) => set({ targets: e.target.value })}
          onBlur={() => setTargetsTouched(true)}
          aria-invalid={targetsError !== undefined}
          aria-describedby={targetsError ? `${ids.targets}-error` : undefined}
          numeric
        />
      </Field>

      <div className="grid grid-cols-3 gap-4">
        <Field
          label={ko.loadModel.stairHoldLabel}
          htmlFor={ids.hold}
          error={errors.hold}
          errorId={`${ids.hold}-error`}
        >
          <Input
            id={ids.hold}
            type="number"
            min={20}
            max={3600}
            value={value.hold}
            onChange={(e) => set({ hold: e.target.value })}
            aria-invalid={errors.hold !== undefined}
            aria-describedby={errors.hold ? `${ids.hold}-error` : undefined}
            numeric
          />
        </Field>
        <Field
          label={ko.loadModel.stairRampLabel}
          htmlFor={ids.ramp}
          error={errors.ramp}
          errorId={`${ids.ramp}-error`}
        >
          <Input
            id={ids.ramp}
            type="number"
            min={1}
            max={600}
            value={value.ramp}
            onChange={(e) => set({ ramp: e.target.value })}
            aria-invalid={errors.ramp !== undefined}
            aria-describedby={errors.ramp ? `${ids.ramp}-error` : undefined}
            numeric
          />
        </Field>
        <Field
          label={ko.loadModel.stairDiscardLabel}
          htmlFor={ids.discard}
          help={<HelpTip label="앞부분 버림 설명">{ko.loadModel.stairDiscardHelp}</HelpTip>}
          error={errors.discard}
          errorId={`${ids.discard}-error`}
        >
          <Input
            id={ids.discard}
            type="number"
            min={0}
            value={value.discard}
            onChange={(e) => set({ discard: e.target.value })}
            aria-invalid={errors.discard !== undefined}
            aria-describedby={errors.discard ? `${ids.discard}-error` : undefined}
            numeric
          />
        </Field>
      </div>

      {sm && (
        <p data-testid="stair-summary" className="mb-3 text-sm text-slate-700">
          {ko.loadModel
            .stairSummary(sm.steps, formatDurationKo(sm.totalSeconds), sm.measureSeconds)
            .map((seg, i) =>
              seg.bold ? (
                <b key={i} className="font-bold tabular-nums">
                  {seg.text}
                </b>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )}
        </p>
      )}

      <div className="max-w-xl">
        <button
          type="button"
          aria-expanded={judgeShown}
          aria-controls={ids.judge}
          onClick={() => {
            if (!capError) setJudgeOpen((o) => !o);
          }}
          className="flex items-center gap-1 text-sm text-slate-600 hover:underline"
        >
          <span aria-hidden="true">{judgeShown ? "▾" : "▸"}</span>
          <span>{ko.loadModel.stairJudgeToggle}</span>
          {!judgeShown && capSet ? (
            <span className="ml-1 text-xs font-normal text-slate-500">
              · {ko.loadModel.stairJudgeSetHint(1)}
            </span>
          ) : null}
        </button>
        {judgeShown && (
          <div id={ids.judge} className="mt-1">
            <p className="mb-2 text-xs text-slate-500">{ko.loadModel.stairJudgeRules}</p>
            <div className="max-w-xs">
              <Field
                label={ko.loadModel.stairP99CapLabel}
                htmlFor={ids.p99Cap}
                help={<HelpTip label="절대 p99 상한 설명">{ko.loadModel.stairP99CapHelp}</HelpTip>}
                error={errors.p99Cap}
                errorId={`${ids.p99Cap}-error`}
              >
                <Input
                  id={ids.p99Cap}
                  type="number"
                  min={1}
                  max={600000}
                  value={value.p99Cap}
                  onChange={(e) => set({ p99Cap: e.target.value })}
                  aria-invalid={errors.p99Cap !== undefined}
                  aria-describedby={errors.p99Cap ? `${ids.p99Cap}-error` : undefined}
                  numeric
                />
              </Field>
            </div>
          </div>
        )}
      </div>

      <div className="mt-3">
        <AutoStopFields value={value} onChange={onChange} errors={errors} />
      </div>
    </div>
  );
}
