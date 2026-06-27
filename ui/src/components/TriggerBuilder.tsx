import { useEffect, useMemo, useState } from "react";
import {
  compileTrigger,
  type BuilderState,
  type TriggerMode,
  type IntervalUnit,
} from "./triggerCron";
import { previewNext, type TriggerInput } from "../api/schedules";
import { ko } from "../i18n/ko";
import { Section } from "./ui/Section";
import { Input } from "./ui/Input";
import { Select } from "./ui/Select";

const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

const INITIAL: BuilderState = {
  mode: "daily",
  time: "02:00",
  days: [],
  everyN: 15,
  unit: "minutes",
  raw: "",
  runAtLocal: "",
};

type Props = {
  /** 컴파일된 트리거(또는 미완성이면 null)를 부모에 통지. */
  onChange: (trigger: TriggerInput | null) => void;
  /** 편집 진입 시 초기 빌더 상태(없으면 daily 02:00). */
  initial?: Partial<BuilderState>;
};

export function TriggerBuilder({ onChange, initial }: Props) {
  const [state, setState] = useState<BuilderState>({ ...INITIAL, ...initial });
  const [preview, setPreview] = useState<number[] | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const trigger = useMemo(() => compileTrigger(state), [state]);

  // 컴파일된 트리거를 부모에 통지.
  useEffect(() => {
    onChange(trigger);
    // onChange는 부모가 매 렌더 새로 만들 수 있으므로 deps에서 제외(trigger 변화에만 반응).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  // 라이브 미리보기(debounce 400ms, 서버 cron 평가 단일 소스).
  useEffect(() => {
    if (!trigger) {
      setPreview(null);
      setPreviewErr(null);
      return;
    }
    const handle = setTimeout(() => {
      previewNext(trigger, 3)
        .then((next) => {
          setPreview(next);
          setPreviewErr(null);
        })
        .catch((e: Error) => {
          setPreview(null);
          setPreviewErr(e.message);
        });
    }, 400);
    return () => clearTimeout(handle);
  }, [trigger]);

  const set = (patch: Partial<BuilderState>) => setState((s) => ({ ...s, ...patch }));
  const toggleDay = (d: number) =>
    set({ days: state.days.includes(d) ? state.days.filter((x) => x !== d) : [...state.days, d] });

  const MODES: { value: TriggerMode; label: string }[] = [
    { value: "once", label: "1회" },
    { value: "daily", label: "매일" },
    { value: "weekly", label: "매주" },
    { value: "interval", label: "간격" },
    { value: "advanced", label: "고급(cron)" },
  ];

  return (
    <Section title="트리거" divider>
      <div className="flex flex-wrap gap-3 mb-3">
        {MODES.map((m) => (
          <label key={m.value} className="flex items-center gap-1 text-sm">
            <input
              type="radio"
              name="trigger-mode"
              checked={state.mode === m.value}
              onChange={() => set({ mode: m.value })}
            />
            {m.label}
          </label>
        ))}
      </div>

      {state.mode === "once" && (
        <label className="block text-sm max-w-xs">
          <span className="text-slate-600">실행 일시</span>
          <Input
            type="datetime-local"
            aria-label="실행 일시"
            className="mt-1"
            value={state.runAtLocal}
            onChange={(e) => set({ runAtLocal: e.target.value })}
          />
        </label>
      )}

      {(state.mode === "daily" || state.mode === "weekly") && (
        <label className="block text-sm max-w-xs">
          <span className="text-slate-600">시각</span>
          <Input
            type="time"
            aria-label="시각"
            className="mt-1"
            value={state.time}
            onChange={(e) => set({ time: e.target.value })}
          />
        </label>
      )}

      {state.mode === "weekly" && (
        <div className="mt-2 flex gap-1" role="group" aria-label="요일 선택">
          {DAY_LABELS.map((label, d) => (
            <button
              key={d}
              type="button"
              aria-pressed={state.days.includes(d)}
              onClick={() => toggleDay(d)}
              className={`w-8 h-8 rounded text-sm border ${
                state.days.includes(d)
                  ? "bg-slate-800 text-white border-slate-800"
                  : "border-slate-300 text-slate-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {state.mode === "interval" && (
        <div className="flex items-end gap-2">
          <label className="block text-sm">
            <span className="text-slate-600">간격</span>
            <div className="w-24">
              <Input
                type="number"
                min={1}
                aria-label="간격 N"
                className="mt-1"
                value={state.everyN}
                onChange={(e) => set({ everyN: Number(e.target.value) })}
              />
            </div>
          </label>
          <div className="mb-1 w-28">
            <Select
              aria-label="간격 단위"
              value={state.unit}
              onChange={(e) => set({ unit: e.target.value as IntervalUnit })}
            >
              <option value="minutes">분마다</option>
              <option value="hours">시간마다</option>
            </Select>
          </div>
        </div>
      )}

      {state.mode === "advanced" && (
        <label className="block text-sm max-w-md">
          <span className="text-slate-600">cron (5-field: 분 시 일 월 요일)</span>
          <Input
            type="text"
            aria-label={ko.triggerBuilder.cronExpressionAria}
            placeholder="0 2 * * *"
            className="mt-1 font-mono"
            value={state.raw}
            onChange={(e) => set({ raw: e.target.value })}
          />
        </label>
      )}

      <div className="mt-3 text-sm">
        {previewErr ? (
          <p role="alert" className="text-red-600">
            미리보기 오류: {previewErr}
          </p>
        ) : preview && preview.length > 0 ? (
          <div>
            <span className="text-slate-600">다음 발사:</span>
            <ul className="mt-1 list-disc list-inside text-slate-700">
              {preview.map((ms, i) => (
                <li key={i}>{new Date(ms).toLocaleString()}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-slate-400">다음 발사 시각을 보려면 트리거를 완성하세요.</p>
        )}
      </div>
    </Section>
  );
}
