import { useEffect, useState } from "react";
import { ko } from "../../i18n/ko";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import {
  DATE_FORMAT_PRESETS,
  OFFSET_RE,
  isGenSpec,
  sampleFor,
  type GenSpec,
  type VarDeclValue,
} from "../../scenario/genVars";
import { useIntPairDraft } from "./useIntPairDraft";

type VarKind = "static" | GenSpec["gen"];

const CUSTOM_FORMAT = "__custom__";
const TZ_WORKER_LOCAL = "__worker__";

/** 생성기 값의 "예:" 샘플 줄 — 접힘 요약 행(VariablesPanel)과 이 펼침 편집기가 공유하는
 *  단일 소스(genSummary 선례와 동형). 파라미터 변경·재렌더마다 즉시 재계산(US4). */
export function GenSampleLine({ spec }: { spec: GenSpec }) {
  const sample = sampleFor(spec);
  return (
    <span className="text-slate-400">
      {sample.kind === "ok"
        ? `${ko.editor.genSamplePrefix} ${sample.text}`
        : ko.editor.genSampleUnsupported}
    </span>
  );
}

/** 라벨+컨트롤 한 칸 — 컴팩트 펼침 편집기 전용(ScenarioDefaults의 동명 로컬 Field와 시각
 *  이디엄은 같되 더 조밀하다). 시각 라벨은 그 필드 aria-label의 부분문자열이 되도록
 *  호출부가 맞춘다(WCAG 2.5.3 Label-in-Name) — aria-label이 accessible name을 갖고 이
 *  span은 순수 시각 보조. */
function GenField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] text-slate-400">{label}</span>
      {children}
    </label>
  );
}

/** 변수 패널 declared 행의 그 자리 펼침 편집기(C안, spec §6). 순수 프레젠테이셔널 —
 *  모든 커밋은 부모 콜백으로만(store 직접 접근 금지). 타입 select·형식 프리셋·타임존은
 *  즉시 커밋(구조 변경 — ExtractEditor 선례), 텍스트/숫자 단독 필드는 draft+blur-commit
 *  (F5), min/max는 `useIntPairDraft`로 파트너-hold. */
export function GenVarEditor({
  name,
  value,
  disabled,
  onCommitGen,
  onCommitStatic,
}: {
  name: string;
  value: VarDeclValue;
  disabled: boolean;
  onCommitGen: (spec: GenSpec) => void;
  onCommitStatic: (v: string) => void;
}) {
  const kind: VarKind = isGenSpec(value) ? value.gen : "static";
  const spec = isGenSpec(value) ? value : null;
  const staticValue = isGenSpec(value) ? "" : value;

  const changeKind = (k: VarKind) => {
    if (k === kind) return;
    if (k === "static") return onCommitStatic("");
    onCommitGen(
      k === "date"
        ? { gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul" }
        : k === "random_int"
          ? { gen: "random_int", min: 1, max: 100 }
          : k === "uuid"
            ? { gen: "uuid" }
            : { gen: "random_string", length: 8 },
    );
  };

  // ---- date ----
  const dateSpec = spec?.gen === "date" ? spec : null;
  const presetMatch = dateSpec
    ? DATE_FORMAT_PRESETS.find((p) => p.value === (dateSpec.format ?? "%Y-%m-%d"))
    : undefined;
  // 사용자가 select에서 명시적으로 "직접 입력…"을 골랐다는 로컬 오버라이드 — format이
  // 우연히 프리셋 값과 같아도(예: 아직 안 고침) select가 즉시 되돌아가지 않게 한다.
  // name/format이 바뀌면(다른 변수로 이동·재커밋) 리셋.
  const [manualCustom, setManualCustom] = useState(false);
  useEffect(() => setManualCustom(false), [name, dateSpec?.format]);
  const presetValue = !dateSpec
    ? CUSTOM_FORMAT
    : manualCustom || !presetMatch
      ? CUSTOM_FORMAT
      : presetMatch.value;

  const changeFormatPreset = (v: string) => {
    if (!dateSpec) return;
    if (v === CUSTOM_FORMAT) {
      setManualCustom(true); // 커밋할 값 없음 — 커스텀 input이 현재 format을 이어받는다
      return;
    }
    setManualCustom(false);
    onCommitGen({ ...dateSpec, format: v });
  };

  const [formatDraft, setFormatDraft] = useState(dateSpec?.format ?? "%Y-%m-%d");
  useEffect(() => {
    setFormatDraft(dateSpec?.format ?? "%Y-%m-%d");
  }, [name, dateSpec?.format]);
  const commitFormat = () => {
    if (!dateSpec) return;
    const trimmed = formatDraft.trim();
    if (trimmed === "") {
      setFormatDraft(dateSpec.format ?? "%Y-%m-%d"); // 빈 형식은 무의미 — revert
      return;
    }
    onCommitGen({ ...dateSpec, format: trimmed });
  };

  const [offsetDraft, setOffsetDraft] = useState(dateSpec?.offset ?? "");
  useEffect(() => {
    setOffsetDraft(dateSpec?.offset ?? "");
  }, [name, dateSpec?.offset]);
  const commitOffset = () => {
    if (!dateSpec) return;
    const trimmed = offsetDraft.trim();
    if (trimmed === "") {
      onCommitGen({ ...dateSpec, offset: undefined }); // 빈 값 = 오프셋 제거(오늘)
      return;
    }
    if (!OFFSET_RE.test(trimmed)) {
      setOffsetDraft(dateSpec.offset ?? ""); // 불합격 — revert
      return;
    }
    onCommitGen({ ...dateSpec, offset: trimmed });
  };

  const changeTz = (v: string) => {
    if (!dateSpec) return;
    onCommitGen({ ...dateSpec, tz: v === TZ_WORKER_LOCAL ? undefined : v });
  };

  // ---- random_int ----
  const intSpec = spec?.gen === "random_int" ? spec : null;
  const { minProps, maxProps } = useIntPairDraft({
    value: intSpec ? { min: intSpec.min, max: intSpec.max } : null,
    resetKey: name,
    onCommit: (min, max) => {
      if (!intSpec) return;
      onCommitGen({ ...intSpec, min, max });
    },
  });
  const [stepDraft, setStepDraft] = useState(
    intSpec?.step !== undefined ? String(intSpec.step) : "",
  );
  useEffect(() => {
    setStepDraft(intSpec?.step !== undefined ? String(intSpec.step) : "");
  }, [name, intSpec?.step]);
  const commitStep = () => {
    if (!intSpec) return;
    const trimmed = stepDraft.trim();
    if (trimmed === "") {
      if (intSpec.step === undefined) return; // 미편집(왕복) — 키 없음 그대로, 커밋 생략
      onCommitGen({ ...intSpec, step: undefined });
      return;
    }
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 1) {
      if (n === intSpec.step) return; // 미편집(왕복) — 값 불변, 커밋 생략
      onCommitGen({ ...intSpec, step: n });
    } else {
      setStepDraft(intSpec.step !== undefined ? String(intSpec.step) : ""); // revert
    }
  };

  // ---- random_string ----
  const strSpec = spec?.gen === "random_string" ? spec : null;
  const [lengthDraft, setLengthDraft] = useState(
    strSpec?.length !== undefined ? String(strSpec.length) : "8",
  );
  useEffect(() => {
    setLengthDraft(strSpec?.length !== undefined ? String(strSpec.length) : "8");
  }, [name, strSpec?.length]);
  const commitLength = () => {
    if (!strSpec) return;
    const trimmed = lengthDraft.trim();
    if (trimmed === "") {
      if (strSpec.length === undefined) return; // 미편집(왕복) — 키 없음 그대로, 커밋 생략
      onCommitGen({ ...strSpec, length: undefined });
      return;
    }
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 1 && n <= 64) {
      if (n === (strSpec.length ?? 8)) return; // 미편집(왕복) — 값 불변(기본값 8 포함), 커밋 생략
      onCommitGen({ ...strSpec, length: n });
    } else {
      setLengthDraft(strSpec.length !== undefined ? String(strSpec.length) : "8"); // revert
    }
  };

  return (
    <div className="mt-1 flex flex-col gap-2 rounded border border-slate-200 bg-slate-50 p-2">
      <div className="w-36">
        <Select
          size="sm"
          aria-label={ko.editor.genFieldType(name)}
          disabled={disabled}
          value={kind}
          onChange={(e) => changeKind(e.target.value as VarKind)}
        >
          <option value="static">{ko.editor.genTypeStatic}</option>
          <option value="date">{ko.editor.genTypeDate}</option>
          <option value="random_int">{ko.editor.genTypeRandomInt}</option>
          <option value="uuid">{ko.editor.genTypeUuid}</option>
          <option value="random_string">{ko.editor.genTypeRandomString}</option>
        </Select>
      </div>

      {kind === "static" && (
        <AutoGrowTextarea
          aria-label={ko.editor.variableValueAria(name)}
          className="font-mono"
          value={staticValue}
          disabled={disabled}
          onChange={(e) => onCommitStatic(e.target.value)}
        />
      )}

      {dateSpec && (
        <div className="flex flex-wrap items-end gap-x-2 gap-y-1">
          <GenField label={ko.editor.genFieldLabelFormat}>
            <Select
              size="sm"
              aria-label={ko.editor.genFieldFormatPreset(name)}
              disabled={disabled}
              value={presetValue}
              onChange={(e) => changeFormatPreset(e.target.value)}
            >
              {DATE_FORMAT_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.labelKey}
                </option>
              ))}
              <option value={CUSTOM_FORMAT}>{ko.editor.genFormatCustomOption}</option>
            </Select>
          </GenField>
          {presetValue === CUSTOM_FORMAT && (
            <GenField label={ko.editor.genFieldLabelCustomFormat}>
              <Input
                size="sm"
                aria-label={ko.editor.genFieldFormatCustom(name)}
                disabled={disabled}
                value={formatDraft}
                onChange={(e) => setFormatDraft(e.target.value)}
                onBlur={commitFormat}
                className="w-36 font-mono"
              />
            </GenField>
          )}
          <GenField label={ko.editor.genFieldLabelOffset}>
            <Input
              size="sm"
              aria-label={ko.editor.genFieldOffset(name)}
              disabled={disabled}
              value={offsetDraft}
              placeholder="+7d"
              onChange={(e) => setOffsetDraft(e.target.value)}
              onBlur={commitOffset}
              className="w-20 font-mono"
            />
          </GenField>
          <GenField label={ko.editor.genFieldLabelTz}>
            <Select
              size="sm"
              aria-label={ko.editor.genFieldTz(name)}
              disabled={disabled}
              value={dateSpec.tz ?? TZ_WORKER_LOCAL}
              onChange={(e) => changeTz(e.target.value)}
            >
              <option value="Asia/Seoul">Asia/Seoul</option>
              <option value="UTC">UTC</option>
              <option value={TZ_WORKER_LOCAL}>{ko.editor.genTzWorkerLocal}</option>
            </Select>
          </GenField>
        </div>
      )}

      {intSpec && (
        <div className="flex flex-wrap items-end gap-x-2 gap-y-1">
          <GenField label={ko.editor.genFieldLabelMin}>
            <Input
              size="sm"
              numeric
              type="number"
              aria-label={ko.editor.genFieldMin(name)}
              disabled={disabled}
              className="w-20"
              {...minProps}
            />
          </GenField>
          <GenField label={ko.editor.genFieldLabelMax}>
            <Input
              size="sm"
              numeric
              type="number"
              aria-label={ko.editor.genFieldMax(name)}
              disabled={disabled}
              className="w-20"
              {...maxProps}
            />
          </GenField>
          <GenField label={ko.editor.genStepUnit}>
            <Input
              size="sm"
              numeric
              type="number"
              aria-label={ko.editor.genFieldStep(name)}
              disabled={disabled}
              className="w-16"
              value={stepDraft}
              onChange={(e) => setStepDraft(e.target.value)}
              onBlur={commitStep}
            />
          </GenField>
        </div>
      )}

      {strSpec && (
        <div className="flex flex-wrap items-end gap-x-2 gap-y-1">
          <GenField label={ko.editor.genFieldLabelLength}>
            <Input
              size="sm"
              numeric
              type="number"
              aria-label={ko.editor.genFieldLength(name)}
              disabled={disabled}
              className="w-16"
              value={lengthDraft}
              onChange={(e) => setLengthDraft(e.target.value)}
              onBlur={commitLength}
            />
          </GenField>
        </div>
      )}

      {spec && (
        <div className="text-xs">
          <GenSampleLine spec={spec} />
        </div>
      )}
    </div>
  );
}
