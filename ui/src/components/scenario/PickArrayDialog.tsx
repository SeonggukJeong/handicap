import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { Input } from "../ui/Input";
import { ko } from "../../i18n/ko";
import { samplePreview, type PickArraySpec } from "../../scenario/genVars";
import {
  PICK_ARRAY_MAX_LEN,
  VALUE_PRESETS,
  formatPositions,
  formatValueLiteral,
  isFullRange,
  jsonScalarKind,
  parsePositions,
  parseValueLiteral,
  presetIndexOf,
  trimPositionsForLength,
  type JsonScalar,
  type LiteralResult,
  type PositionsError,
} from "../../scenario/pickArray";

/** 선택 배열 편집 팝업(spec §6.3). draft는 전부 로컬 — store 쓰기는 onApply 1회뿐.
 *  목업(docs/superpowers/mockups/2026-10-17-pick-array-mockup.html)은 시각 참조만. */

type ValueMode = number | "custom"; // 0..3 = VALUE_PRESETS 인덱스

const intText = (t: string): number | null => (/^\s*\d+\s*$/.test(t) ? Number(t.trim()) : null);
const lengthOf = (t: string): number | null => {
  const n = intText(t);
  return n !== null && n >= 1 && n <= PICK_ARRAY_MAX_LEN ? n : null;
};

function positionsErrorText(e: PositionsError, length: number): string {
  switch (e.kind) {
    case "badLength": // 호출부가 lengthOf로 거른 길이만 넘기므로 도달 불가 — exhaustive용
      return ko.editor.pickErrLength;
    case "tooLong":
      return ko.editor.pickErrTooLong;
    case "badItem":
      return ko.editor.pickErrBadItem(e.index);
    case "outOfRange":
      return ko.editor.pickErrOutOfRange(e.index, length);
    case "reversed":
      return ko.editor.pickErrReversed(e.index);
  }
}

function literalErrorText(r: LiteralResult): string | null {
  if (r.ok) return null;
  switch (r.reason) {
    case "empty":
      return ko.editor.pickErrValueEmpty;
    case "badQuoted":
      return ko.editor.pickErrValueQuoted;
    case "nonFinite":
      return ko.editor.pickErrValueNonFinite;
    case "tooLong":
      return ko.editor.pickErrValueTooLong;
  }
}

export function PickArrayDialog({
  name,
  initial,
  sampleTick,
  onSampleRefresh,
  onApply,
  onCancel,
}: {
  name: string;
  initial: PickArraySpec;
  /** 패널 예시와 같은 틱(GenVarEditor 동명 prop) — 둘 다 오면 ↻는 부모 틱을 올린다(적용 직후 패널 예시 =
   *  팝업 미리보기). 생략 시 로컬 틱. 틱은 예시 표시 전용 UI 상태라 store/YAML 쓰기가 아니다. */
  sampleTick?: number;
  onSampleRefresh?: () => void;
  onApply: (spec: PickArraySpec) => void;
  onCancel: () => void;
}) {
  const initPick: JsonScalar = initial.pick === undefined ? true : initial.pick;
  const initRest: JsonScalar = initial.rest === undefined ? false : initial.rest;
  const initPreset = presetIndexOf(initPick, initRest);

  const [lengthText, setLengthText] = useState(String(initial.length));
  const [committedLength, setCommittedLength] = useState(initial.length);
  const [minText, setMinText] = useState(String(initial.min));
  const [maxText, setMaxText] = useState(String(initial.max));
  const [positionsText, setPositionsText] = useState(initial.positions ?? `1-${initial.length}`);
  const [valueMode, setValueMode] = useState<ValueMode>(initPreset === -1 ? "custom" : initPreset);
  const [pickText, setPickText] = useState(formatValueLiteral(initPick));
  const [restText, setRestText] = useState(formatValueLiteral(initRest));
  const [valuesOpen, setValuesOpen] = useState(initPreset !== 0);
  const [localTick, setLocalTick] = useState(0);
  const controlledTick = sampleTick !== undefined && onSampleRefresh !== undefined;
  const tick = controlledTick ? sampleTick : localTick;
  const reroll = controlledTick ? onSampleRefresh : () => setLocalTick((t) => t + 1);
  const anchorRef = useRef<number | null>(null);
  // 문법 오류 동안 칸 그리드가 보일 직전 유효 집합(spec §6.3) — 렌더 중 ref 갱신(파생 표시 전용).
  const lastValidRef = useRef<number[]>([]);

  // live 길이(무효면 마지막 유효) — 활성 판정·칸 수. 깎기 규칙은 비파괴 미리보기로만.
  const liveLength = lengthOf(lengthText) ?? committedLength;
  const effText = trimPositionsForLength(positionsText, committedLength, liveLength);
  const pos = parsePositions(effText, liveLength);
  if (pos.ok) lastValidRef.current = pos.set;

  const commitLength = () => {
    const n = lengthOf(lengthText);
    if (n === null) return;
    setPositionsText(trimPositionsForLength(positionsText, committedLength, n));
    if (n !== committedLength) anchorRef.current = null; // 옛 길이 기준 앵커로 범위를 만들지 않는다
    setCommittedLength(n);
  };

  const uid = useId();
  const sizeErrId = `${uid}-size-err`;
  const countErrId = `${uid}-count-err`;
  const valuesRegionId = `${uid}-values`;
  const posErrId = `${uid}-pos-err`;
  const minN = intText(minText);
  const maxN = intText(maxText);
  const pickRes: LiteralResult =
    valueMode === "custom"
      ? parseValueLiteral(pickText)
      : { ok: true, value: VALUE_PRESETS[valueMode].pick };
  const restRes: LiteralResult =
    valueMode === "custom"
      ? parseValueLiteral(restText)
      : { ok: true, value: VALUE_PRESETS[valueMode].rest };

  const sizeError =
    lengthOf(lengthText) === null
      ? ko.editor.pickErrLength
      : minN === null || maxN === null
        ? ko.editor.pickErrCount
        : minN > maxN
          ? ko.editor.pickErrMinGtMax
          : maxN > liveLength
            ? ko.editor.pickErrMaxGtLength
            : null;
  const posError = !pos.ok
    ? positionsErrorText(pos.error, liveLength)
    : pos.set.length === 0
      ? ko.editor.pickErrNoCandidates
      : null;
  const c = pos.ok ? pos.set.length : 0;
  const countVsCand =
    pos.ok && c > 0 && minN !== null && maxN !== null && sizeError === null
      ? minN > c
        ? { level: "error" as const, text: ko.editor.pickErrMinGtCandidates(c) }
        : maxN > c
          ? { level: "warn" as const, text: ko.editor.pickWarnMaxGtCandidates(c) }
          : null
      : null;

  const lenBad = lengthOf(lengthText) === null;
  const minBad =
    (!lenBad && (minN === null || (maxN !== null && minN > maxN))) ||
    countVsCand?.level === "error";
  const maxBad =
    !lenBad &&
    (maxN === null || (minN !== null && minN > maxN) || sizeError === ko.editor.pickErrMaxGtLength);
  const describe = (ids: (string | false)[]) => ids.filter(Boolean).join(" ") || undefined;
  const lenDesc = describe([lenBad && sizeError !== null && sizeErrId]);
  const minDesc = describe([
    minBad && sizeError !== null && sizeErrId,
    countVsCand?.level === "error" && countErrId,
  ]);
  const maxDesc = describe([
    maxBad && sizeError !== null && sizeErrId,
    countVsCand?.level === "warn" && countErrId,
  ]);

  const spec: PickArraySpec | null =
    sizeError === null &&
    posError === null &&
    countVsCand?.level !== "error" &&
    pickRes.ok &&
    restRes.ok &&
    pos.ok
      ? {
          gen: "pick_array",
          length: liveLength,
          min: minN!,
          max: maxN!,
          ...(isFullRange(pos.set, liveLength) ? {} : { positions: formatPositions(pos.set) }),
          ...(pickRes.value === true ? {} : { pick: pickRes.value }),
          ...(restRes.value === false ? {} : { rest: restRes.value }),
          // 팝업은 refresh를 편집하지 않는다 — initial 값을 그대로 싣는다(없으면 키 없음, spec §6.3).
          ...(initial.refresh !== undefined ? { refresh: initial.refresh } : {}),
        }
      : null;

  // 패널 예시 줄(GenSampleLine)과 같은 시드 경로 — 같은 spec·틱이면 같은 예시(F5).
  const preview = useMemo(
    () => {
      if (!spec) return null;
      const r = samplePreview(spec, name, tick);
      return r.kind === "ok" ? r.text : null;
    },
    // spec은 매 렌더 새 객체 — 내용 키로 메모
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, tick, JSON.stringify(spec)],
  );

  const toggle = (i: number, range: boolean) => {
    if (!pos.ok) return;
    const set = new Set(pos.set);
    const turnOn = !set.has(i);
    const from = range && anchorRef.current !== null ? Math.min(anchorRef.current, i) : i;
    const to = Math.min(
      liveLength,
      range && anchorRef.current !== null ? Math.max(anchorRef.current, i) : i,
    );
    for (let j = from; j <= to; j++) {
      if (turnOn) set.add(j);
      else set.delete(j);
    }
    anchorRef.current = i;
    setPositionsText(formatPositions([...set]));
  };

  const pickShown = pickRes.ok ? formatValueLiteral(pickRes.value) : pickText;
  const restShown = restRes.ok ? formatValueLiteral(restRes.value) : restText;
  const apply = () => {
    if (spec) onApply(spec); // 클릭 시점 재검증 — spec은 이 렌더의 draft 기준
  };

  return (
    <Modal open onClose={onCancel} title={name}>
      <div className="flex flex-col gap-4 text-sm">
        <span className="self-start rounded bg-indigo-50 px-1.5 text-xs text-indigo-600">
          {ko.editor.genTypePickArray}
        </span>
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold text-slate-500">{ko.editor.pickSectionSize}</h3>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-x-3 gap-y-1">
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] text-slate-400">{ko.editor.pickFieldLength}</span>
              <Input
                size="sm"
                numeric
                type="number"
                min={1}
                max={PICK_ARRAY_MAX_LEN}
                aria-label={ko.editor.pickFieldLength}
                aria-invalid={lenBad || undefined}
                aria-describedby={lenDesc}
                value={lengthText}
                onChange={(e) => setLengthText(e.target.value)}
                onBlur={commitLength}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitLength();
                }}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] text-slate-400">{ko.editor.pickFieldMin}</span>
              <Input
                size="sm"
                numeric
                type="number"
                min={0}
                aria-label={ko.editor.pickFieldMin}
                aria-invalid={minBad || undefined}
                aria-describedby={minDesc}
                value={minText}
                onChange={(e) => setMinText(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] text-slate-400">{ko.editor.pickFieldMax}</span>
              <Input
                size="sm"
                numeric
                type="number"
                min={0}
                aria-label={ko.editor.pickFieldMax}
                aria-invalid={maxBad || undefined}
                aria-describedby={maxDesc}
                value={maxText}
                onChange={(e) => setMaxText(e.target.value)}
              />
            </label>
          </div>
          {sizeError && (
            <p id={sizeErrId} className="text-xs text-red-600">
              {sizeError}
            </p>
          )}
          {countVsCand && (
            <p
              id={countErrId}
              className={
                countVsCand.level === "error"
                  ? "text-xs text-red-600"
                  : "self-start rounded bg-amber-50 px-1.5 text-xs text-amber-700"
              }
            >
              {countVsCand.text}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold text-slate-500">{ko.editor.pickSectionPositions}</h3>
          <Input
            size="sm"
            className="font-mono"
            aria-label={ko.editor.pickSectionPositions}
            aria-invalid={posError !== null || undefined}
            aria-describedby={posError ? posErrId : undefined}
            value={positionsText}
            onChange={(e) => setPositionsText(e.target.value)}
          />
          {posError ? (
            <p id={posErrId} className="text-xs text-red-600">
              {posError}
            </p>
          ) : (
            <p className="text-xs text-slate-400">{ko.editor.pickPositionsHint}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setPositionsText(`1-${liveLength}`)}>
              {ko.editor.pickAll}
            </Button>
            <Button variant="secondary" disabled={!pos.ok} onClick={() => setPositionsText("")}>
              {ko.editor.pickNone}
            </Button>
            <span className="ml-auto flex flex-wrap gap-3 text-[11px] text-slate-400">
              <span>
                <span
                  aria-hidden="true"
                  className="mr-1 inline-block h-2 w-2 rounded-sm bg-accent-600"
                />
                {ko.editor.pickLegendOn}
              </span>
              <span>
                <span
                  aria-hidden="true"
                  className="mr-1 inline-block h-2 w-2 rounded-sm border border-slate-300"
                />
                {ko.editor.pickLegendOff}
              </span>
              <span>{ko.editor.pickLegendRange}</span>
            </span>
          </div>
          <PositionGrid
            length={liveLength}
            selected={new Set(pos.ok ? pos.set : lastValidRef.current)}
            disabled={!pos.ok}
            onToggle={toggle}
          />
        </section>

        <section className="flex flex-col gap-1.5">
          <button
            type="button"
            aria-expanded={valuesOpen}
            aria-controls={valuesRegionId}
            onClick={() => setValuesOpen((o) => !o)}
            className="self-start text-left text-xs font-semibold text-slate-500 hover:text-accent-600"
          >
            <span aria-hidden="true">{valuesOpen ? "▾ " : "▸ "}</span>
            {ko.editor.pickValuesToggle(pickShown, restShown)}
          </button>
          {valuesOpen && (
            <div
              id={valuesRegionId}
              role="radiogroup"
              aria-label={ko.editor.pickValuesAria}
              className="flex flex-col gap-1 pl-4"
            >
              {VALUE_PRESETS.map((p, i) => (
                <label key={i} className="flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name={`pick-values-${name}`}
                    checked={valueMode === i}
                    onChange={() => setValueMode(i)}
                  />
                  {/* 프리셋 라벨만 문자열에 따옴표(목업) — 토글 라벨·패널 요약은 formatValueLiteral(spec §6.3) */}
                  <code>{`${JSON.stringify(p.pick)} / ${JSON.stringify(p.rest)}`}</code>
                  <span className="text-slate-400">
                    {ko.editor.pickValueKind[jsonScalarKind(p.pick)]}
                  </span>
                </label>
              ))}
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name={`pick-values-${name}`}
                  checked={valueMode === "custom"}
                  onChange={() => {
                    if (valueMode !== "custom") {
                      setPickText(formatValueLiteral(VALUE_PRESETS[valueMode].pick));
                      setRestText(formatValueLiteral(VALUE_PRESETS[valueMode].rest));
                    }
                    setValueMode("custom");
                  }}
                />
                {ko.editor.pickValueCustom}
              </label>
              {valueMode === "custom" && (
                <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-3 gap-y-1">
                  {(
                    [
                      [ko.editor.pickFieldPick, pickText, setPickText, pickRes, `${uid}-pick-err`],
                      [ko.editor.pickFieldRest, restText, setRestText, restRes, `${uid}-rest-err`],
                    ] as const
                  ).map(([label, text, setText, res, errId]) => (
                    <label key={label} className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-slate-400">
                        {label}
                        {res.ok ? ` · ${ko.editor.pickValueKind[jsonScalarKind(res.value)]}` : ""}
                      </span>
                      <Input
                        size="sm"
                        className="font-mono"
                        aria-label={label}
                        aria-invalid={!res.ok || undefined}
                        aria-describedby={res.ok ? undefined : errId}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                      />
                      {!res.ok && (
                        <span id={errId} className="text-xs text-red-600">
                          {literalErrorText(res)}
                        </span>
                      )}
                    </label>
                  ))}
                  <p className="col-span-full text-[11px] text-slate-400">
                    {ko.editor.pickValueKindHint}
                  </p>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-slate-500">
              {initial.refresh === "request"
                ? ko.editor.pickPreviewTitleRequest
                : ko.editor.pickPreviewTitle}
            </h3>
            <Button variant="secondary" className="ml-auto" disabled={!spec} onClick={reroll}>
              {ko.editor.pickPreviewReroll}
            </Button>
          </div>
          <div
            data-testid="pick-preview"
            className="max-h-24 overflow-y-auto break-all rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs"
          >
            {preview ?? ko.editor.pickPreviewInvalid}
          </div>
          <p className="text-xs text-slate-500">{ko.editor.pickUsageHint(name)}</p>
        </section>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {ko.common.cancel}
          </Button>
          <Button onClick={apply} disabled={spec === null}>
            {ko.editor.pickApply}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** roving-tabindex 칸 그리드 — Tab 정지 1개. 토글은 네이티브 버튼 활성화(Space/Enter→click),
 *  keydown은 이동과 Shift+Space(범위, preventDefault로 네이티브 click 억제)만. */
function PositionGrid({
  length,
  selected,
  disabled,
  onToggle,
}: {
  length: number;
  selected: ReadonlySet<number>;
  disabled: boolean;
  onToggle: (i: number, range: boolean) => void;
}) {
  const [active, setActive] = useState(1);
  const gridRef = useRef<HTMLDivElement>(null);
  // Shift+Space로 범위를 만든 뒤 따라오는 Space keyup(=네이티브 click)을 1회 억제 — Shift를 먼저 떼도 유효.
  const suppressSpaceUp = useRef(false);
  const cellRefs = useRef(new Map<number, HTMLButtonElement>());
  const current = Math.min(active, length);

  const move = (to: number) => {
    const n = Math.max(1, Math.min(length, to));
    setActive(n);
    cellRefs.current.get(n)?.focus();
  };
  const cols = () => {
    const g = gridRef.current;
    if (!g) return 1;
    return getComputedStyle(g).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const delta: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: cols(),
      ArrowUp: -cols(),
    };
    if (e.key in delta) {
      e.preventDefault();
      move(i + delta[e.key]);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(1);
    } else if (e.key === "End") {
      e.preventDefault();
      move(length);
    } else if (e.key === " " && e.shiftKey) {
      e.preventDefault();
      suppressSpaceUp.current = true;
      onToggle(i, true);
    }
  };

  return (
    <div
      ref={gridRef}
      role="group"
      aria-label={ko.editor.pickGridAria}
      className={`grid select-none max-h-44 grid-cols-[repeat(auto-fill,minmax(2.1rem,1fr))] gap-[3px] overflow-y-auto overflow-x-hidden rounded border border-slate-200 bg-slate-50 p-1 ${disabled ? "opacity-50" : ""}`}
    >
      {Array.from({ length }, (_, k) => k + 1).map((i) => (
        <button
          key={i}
          type="button"
          ref={(el) => {
            if (el) cellRefs.current.set(i, el);
            else cellRefs.current.delete(i);
          }}
          tabIndex={i === current ? 0 : -1}
          aria-pressed={selected.has(i)}
          aria-label={ko.editor.pickCellAria(i)}
          disabled={disabled}
          onFocus={() => setActive(i)}
          onClick={(e) => onToggle(i, e.shiftKey)}
          onKeyDown={(e) => onKeyDown(e, i)}
          onKeyUp={(e) => {
            if (e.key === " " && suppressSpaceUp.current) {
              suppressSpaceUp.current = false;
              e.preventDefault();
            }
          }}
          onBlur={() => {
            suppressSpaceUp.current = false;
          }}
          className={`h-6 min-w-0 rounded-sm border font-mono text-[10px] tabular-nums ${
            selected.has(i)
              ? "border-accent-600 bg-accent-600 text-white"
              : "border-slate-300 bg-white text-slate-400"
          }`}
        >
          {i}
        </button>
      ))}
    </div>
  );
}
