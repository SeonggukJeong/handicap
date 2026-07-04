import { useEffect, useMemo, useRef, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import type {
  Assertion,
  CompareOp,
  Condition,
  Extract,
  HttpMethod,
  HttpStep,
  IfStep,
  LoopStep,
  ParallelStep,
  Step,
} from "../../scenario/model";
import {
  findStepSiblings,
  findStepById,
  isLoopStep,
  isIfStep,
  isParallelStep,
} from "../../scenario/model";
import type { BranchSel } from "../../scenario/yamlDoc";
import { KeyValueGrid } from "./KeyValueGrid";
import { VarCheatSheet } from "./VarCheatSheet";
import { HelpTip } from "../HelpTip";
import { COMMON_HEADERS } from "../../scenario/commonHeaders";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";
import {
  loadSectionPrefs,
  saveSectionPrefs,
  type SectionKey,
  type SectionPrefs,
} from "../../scenario/editorPrefs";

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
type BodyKind = "none" | "json" | "form" | "raw";

function buildDisabled(
  headers: Record<string, string> | undefined,
  form: Record<string, string> | undefined,
): { headers?: Record<string, string>; form?: Record<string, string> } | undefined {
  const h = headers && Object.keys(headers).length ? headers : undefined;
  const f = form && Object.keys(form).length ? form : undefined;
  if (!h && !f) return undefined; // setStepField(undefined) → deleteIn → clean YAML
  return { ...(h ? { headers: h } : {}), ...(f ? { form: f } : {}) };
}

// 셀렉터 fallback은 안정 참조 필수 — 인라인 `?? []`는 model=null 동안 무한 리렌더
const EMPTY_STEPS: Step[] = [];

export function Inspector() {
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const steps = useScenarioEditor((s) => s.model?.steps ?? EMPTY_STEPS);
  const select = useScenarioEditor((s) => s.select);

  const step = useMemo<Step | null>(
    () => findStepById(steps, selectedStepId),
    [steps, selectedStepId],
  );

  useEffect(() => {
    if (selectedStepId !== null && step === null) select(null);
  }, [selectedStepId, step, select]);

  const [sectionPrefs, setSectionPrefs] = useState<SectionPrefs>(loadSectionPrefs);
  const toggleSection = (k: SectionKey) => {
    const next = { ...sectionPrefs, [k]: !sectionPrefs[k] };
    setSectionPrefs(next);
    saveSectionPrefs(next);
  };

  if (step === null) {
    return (
      <aside aria-label={ko.editor.inspectorAria} className="text-sm text-slate-400 italic">
        {ko.editor.inspectorEmpty}
      </aside>
    );
  }

  const topLevel = steps.some((s) => s.id === step.id);

  if (isLoopStep(step)) return <LoopInspector step={step} topLevel={topLevel} />;
  if (isIfStep(step)) return <IfInspector step={step} topLevel={topLevel} />;
  if (isParallelStep(step)) return <ParallelInspector step={step} topLevel={topLevel} />;
  return (
    <HttpStepInspector step={step} sectionPrefs={sectionPrefs} onToggleSection={toggleSection} />
  );
}

const OPS: CompareOp[] = [
  "eq",
  "ne",
  "contains",
  "matches",
  "lt",
  "gt",
  "lte",
  "gte",
  "exists",
  "empty",
];

const NEW_LEAF = (): Condition => ({ left: "", op: "eq", right: "" });

function isValidRegex(s: string): boolean {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

// Immutable edit of a condition tree by a path of child indices. Each path element
// indexes into the current group's all/any children array.
function setAtPath(node: Condition, path: number[], sub: Condition): Condition {
  if (path.length === 0) return sub;
  const key = "all" in node ? "all" : "any";
  const children = (node as { all?: Condition[]; any?: Condition[] })[key]!;
  const next = children.slice();
  next[path[0]] = setAtPath(next[path[0]], path.slice(1), sub);
  return { [key]: next } as Condition;
}

function removeAtPath(node: Condition, path: number[]): Condition {
  const key = "all" in node ? "all" : "any";
  const children = (node as { all?: Condition[]; any?: Condition[] })[key]!;
  if (path.length === 1) {
    return { [key]: children.filter((_, i) => i !== path[0]) } as Condition;
  }
  const next = children.slice();
  next[path[0]] = removeAtPath(next[path[0]], path.slice(1));
  return { [key]: next } as Condition;
}

// Move up/down buttons shared by every inspector (http leaf + loop/if
// containers). Siblings = the sequence the step actually lives in: top-level
// steps, a loop `do` body, or an if branch (then / elif[].then / else). Clamp
// against siblings, not the top-level list (a nested step has index -1 there,
// which would mis-disable the buttons).
function MoveButtons({ stepId }: { stepId: string }) {
  const moveStep = useScenarioEditor((s) => s.moveStep);
  const steps = useScenarioEditor((s) => s.model?.steps ?? EMPTY_STEPS);
  const siblings = useMemo<ReadonlyArray<Step>>(
    () => findStepSiblings(steps, stepId),
    [steps, stepId],
  );
  const index = siblings.findIndex((s) => s.id === stepId);
  return (
    <>
      <SmallButton
        onClick={() => moveStep(stepId, Math.max(0, index - 1))}
        disabled={index === 0}
        label="↑"
        title={ko.common.moveUp}
      />
      <SmallButton
        onClick={() => moveStep(stepId, Math.min(siblings.length - 1, index + 1))}
        disabled={index === siblings.length - 1}
        label="↓"
        title={ko.common.moveDown}
      />
    </>
  );
}

/** 접이식 인스펙터 섹션(R1). fieldset+legend-버튼 disclosure — RunDialog SLO/
 *  ScenarioSnapshot 이디엄. fieldset `min-w-0`은 canvas-fix overflow 가드(필수). */
function InspectorSection({
  title,
  hint,
  open,
  onToggle,
  children,
}: {
  title: string;
  hint: string | null;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3">
      <legend className="px-1 text-xs font-semibold text-slate-600 flex items-center gap-1">
        <button type="button" onClick={onToggle} aria-expanded={open} className="hover:underline">
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> {title}
        </button>
        {!open && hint !== null && <span className="font-normal text-slate-400">{hint}</span>}
      </legend>
      {open && children}
    </fieldset>
  );
}

function HttpStepInspector({
  step,
  sectionPrefs,
  onToggleSection,
}: {
  step: HttpStep;
  sectionPrefs: SectionPrefs;
  onToggleSection: (k: SectionKey) => void;
}) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const setStepAssert = useScenarioEditor((s) => s.setStepAssert);
  const removeStep = useScenarioEditor((s) => s.removeStep);

  // Numeric draft + commit-on-blur (F5 pattern), matching the loop Repeat field.
  // timeout_seconds is optional, so the draft round-trips the empty/undefined state.
  const [timeoutDraft, setTimeoutDraft] = useState(
    step.timeout_seconds !== undefined ? String(step.timeout_seconds) : "",
  );
  useEffect(() => {
    setTimeoutDraft(step.timeout_seconds !== undefined ? String(step.timeout_seconds) : "");
  }, [step.id, step.timeout_seconds]);
  const commitTimeout = () => {
    const raw = timeoutDraft.trim();
    if (raw === "") {
      setStepField(step.id, ["timeout_seconds"], undefined); // clears YAML key (byte-identical)
      return;
    }
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 600) {
      setStepField(step.id, ["timeout_seconds"], n);
    } else {
      // revert draft to last committed value (no NaN / out-of-range write)
      setTimeoutDraft(step.timeout_seconds !== undefined ? String(step.timeout_seconds) : "");
    }
  };

  // Per-step think_time min/max — same F5 draft + commit-on-blur pattern.
  // think_time is optional ({min_ms,max_ms} | undefined); the drafts round-trip
  // the empty/undefined state and both inputs share one commit handler.
  const [thinkMinDraft, setThinkMinDraft] = useState(
    step.think_time ? String(step.think_time.min_ms) : "",
  );
  const [thinkMaxDraft, setThinkMaxDraft] = useState(
    step.think_time ? String(step.think_time.max_ms) : "",
  );
  // `step.think_time` is an object, so this re-fires after ANY field commit on
  // the step (the model is re-derived from YAML each commit, minting a fresh
  // object). Harmless: text inputs commit on blur, so a half-typed think draft
  // can't coexist with another field's commit. (Same class as JsonBodyField's
  // effect.) The real job is reseeding when the selected step/value changes.
  useEffect(() => {
    setThinkMinDraft(step.think_time ? String(step.think_time.min_ms) : "");
    setThinkMaxDraft(step.think_time ? String(step.think_time.max_ms) : "");
  }, [step.id, step.think_time]);
  const commitThinkTime = () => {
    const minR = thinkMinDraft.trim();
    const maxR = thinkMaxDraft.trim();
    if (minR === "" && maxR === "") {
      setStepField(step.id, ["think_time"], undefined); // clears YAML key
      return;
    }
    // Exactly one field empty = incomplete pair (e.g. focus moving between the
    // two inputs mid-entry). Leave drafts untouched so the user can finish —
    // don't coerce "" to 0 or revert a half-typed value.
    if (minR === "" || maxR === "") return;
    const mn = Number(minR);
    const mx = Number(maxR);
    if (Number.isInteger(mn) && Number.isInteger(mx) && mn >= 0 && mx >= mn && mx <= 600_000) {
      setStepField(step.id, ["think_time"], { min_ms: mn, max_ms: mx });
    } else {
      // revert to last committed (no NaN / out-of-range / min>max write)
      setThinkMinDraft(step.think_time ? String(step.think_time.min_ms) : "");
      setThinkMaxDraft(step.think_time ? String(step.think_time.max_ms) : "");
    }
  };

  const headerCount =
    Object.keys(step.request.headers ?? {}).length +
    Object.keys(step.request.disabled?.headers ?? {}).length;
  const bodyKind: BodyKind = step.request.body?.kind ?? "none";
  const bodyKindLabel: string | null =
    bodyKind === "none"
      ? null
      : bodyKind === "json"
        ? ko.editor.bodyJson
        : bodyKind === "form"
          ? ko.editor.bodyForm
          : ko.editor.bodyRaw;
  const hasTiming = step.timeout_seconds !== undefined || step.think_time !== undefined;

  return (
    <aside aria-label={ko.editor.inspectorAria} className="flex flex-col gap-4 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-700">{ko.editor.httpPanelTitle}</h3>
        <div className="flex gap-1">
          <MoveButtons stepId={step.id} />
          <SmallButton
            onClick={() => removeStep(step.id)}
            label={ko.common.delete}
            title={ko.editor.deleteStep}
            danger
          />
        </div>
      </header>

      <StepNameField stepId={step.id} name={step.name} />

      <fieldset className="flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3">
        <legend className="px-1 text-xs font-semibold text-slate-600">
          {ko.editor.requestLegend}
        </legend>
        <div className="flex items-center text-xs text-slate-500">
          <span>{ko.editor.varCheatSheetContext}</span>
          <VarCheatSheet />
        </div>
        <Field label={ko.editor.fieldMethod}>
          <div className="w-fit">
            <Select
              value={step.request.method}
              onChange={(e) =>
                setStepField(step.id, ["request", "method"], e.target.value as HttpMethod)
              }
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </div>
        </Field>
        <Field label={ko.editor.urlLabel}>
          <Input
            size="sm"
            className="font-mono"
            value={step.request.url}
            placeholder={ko.editor.urlPlaceholder}
            onChange={(e) => setStepField(step.id, ["request", "url"], e.target.value)}
          />
        </Field>
        {step.request.url.trim() === "" && (
          <p role="alert" className="text-xs text-amber-600">
            {ko.editor.urlEmptyWarning}
          </p>
        )}
      </fieldset>

      <InspectorSection
        title={ko.editor.headersLabel}
        hint={headerCount > 0 ? ko.editor.sectionCountHint(headerCount) : null}
        open={sectionPrefs.headers}
        onToggle={() => onToggleSection("headers")}
      >
        <HeadersEditor step={step} />
      </InspectorSection>
      <InspectorSection
        title={ko.editor.bodyLabel}
        hint={bodyKindLabel}
        open={sectionPrefs.body}
        onToggle={() => onToggleSection("body")}
      >
        <BodyEditor step={step} />
      </InspectorSection>
      <InspectorSection
        title={ko.editor.sectionTiming}
        hint={hasTiming ? ko.editor.sectionSetHint : null}
        open={sectionPrefs.timing}
        onToggle={() => onToggleSection("timing")}
      >
        <Field label={ko.editor.fieldTimeout}>
          <Input
            numeric
            type="number"
            min={1}
            max={600}
            value={timeoutDraft}
            onChange={(e) => setTimeoutDraft(e.target.value)}
            onBlur={commitTimeout}
          />
        </Field>

        <Field label={ko.editor.fieldThinkMin}>
          <Input
            numeric
            type="number"
            min={0}
            max={600000}
            value={thinkMinDraft}
            onChange={(e) => setThinkMinDraft(e.target.value)}
            onBlur={commitThinkTime}
          />
        </Field>
        <Field label={ko.editor.fieldThinkMax}>
          <Input
            numeric
            type="number"
            min={0}
            max={600000}
            value={thinkMaxDraft}
            onChange={(e) => setThinkMaxDraft(e.target.value)}
            onBlur={commitThinkTime}
          />
        </Field>
        <p className="text-xs text-slate-500">{ko.editor.thinkHint}</p>
      </InspectorSection>
      <InspectorSection
        title={ko.editor.assertionsLegend}
        hint={step.assert.length > 0 ? ko.editor.sectionCountHint(step.assert.length) : null}
        open={sectionPrefs.assert}
        onToggle={() => onToggleSection("assert")}
      >
        <AssertEditor step={step} setStepAssert={setStepAssert} />
      </InspectorSection>
      <InspectorSection
        title={ko.editor.extractsLegend}
        hint={step.extract.length > 0 ? ko.editor.sectionCountHint(step.extract.length) : null}
        open={sectionPrefs.extract}
        onToggle={() => onToggleSection("extract")}
      >
        <ExtractEditor step={step} />
      </InspectorSection>
    </aside>
  );
}

function HeadersEditor({ step }: { step: HttpStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  return (
    <div className="min-w-0">
      <KeyValueGrid
        entries={step.request.headers ?? {}}
        disabledEntries={step.request.disabled?.headers ?? {}}
        onChange={(active, disabled) => {
          setStepField(step.id, ["request", "headers"], active);
          setStepField(
            step.id,
            ["request", "disabled"],
            buildDisabled(disabled, step.request.disabled?.form),
          );
        }}
        resetKey={step.id}
        bulkFormat="header"
        itemLabel="header"
        keyPlaceholder={ko.editor.headerKeyPlaceholder}
        valuePlaceholder="value"
        emptyText={ko.editor.noHeaders}
        commonKeys={COMMON_HEADERS}
      />
    </div>
  );
}

function BodyEditor({ step }: { step: HttpStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);

  const kind: BodyKind = step.request.body?.kind ?? "none";

  const setKind = (k: BodyKind) => {
    // leaving a form body → disabled.form no longer has an editor → drop the orphan
    if (k !== "form" && step.request.disabled?.form) {
      setStepField(
        step.id,
        ["request", "disabled"],
        buildDisabled(step.request.disabled?.headers, undefined),
      );
    }
    if (k === "none") {
      setStepField(step.id, ["request", "body"], undefined);
      return;
    }
    // YAML representation: body: { json: ... } not { kind: 'json', value: ... }
    const value: unknown = k === "json" ? {} : k === "form" ? {} : "";
    setStepField(step.id, ["request", "body"], { [k]: value });
  };

  return (
    <div>
      <div className="w-fit">
        <Select className="mb-2" value={kind} onChange={(e) => setKind(e.target.value as BodyKind)}>
          <option value="none">{ko.editor.bodyNone}</option>
          <option value="json">{ko.editor.bodyJson}</option>
          <option value="form">{ko.editor.bodyForm}</option>
          <option value="raw">{ko.editor.bodyRaw}</option>
        </Select>
      </div>
      {kind === "json" && <JsonBodyField step={step} />}
      {kind === "form" && <FormBodyField step={step} />}
      {kind === "raw" && <RawBodyField step={step} />}
    </div>
  );
}

function JsonBodyField({ step }: { step: HttpStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const body = step.request.body;
  const initial = body?.kind === "json" ? JSON.stringify(body.value, null, 2) : "{}";
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Reset local textarea only when the user switches to a different step,
    // not on every body change (which would overwrite in-progress edits).
    setText(body?.kind === "json" ? JSON.stringify(body.value, null, 2) : "{}");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);

  const store = (parsed: unknown) => setStepField(step.id, ["request", "body"], { json: parsed });

  const commit = () => {
    try {
      store(JSON.parse(text));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Re-indent the buffer to 2 spaces and persist the parsed value (spec §B4 — no
  // external prettier; the same JSON.stringify the field already uses on load).
  const format = () => {
    try {
      const parsed = JSON.parse(text);
      setText(JSON.stringify(parsed, null, 2));
      setError(null);
      store(parsed);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center text-xs text-slate-500">
        <span>{ko.editor.jsonCastHint}</span>
        <HelpTip label={ko.editor.jsonCastLabel}>
          <span className="block">{ko.glossary.jsonCastIntro}</span>
          <span className="mt-1 block">{ko.glossary.jsonCastTypes}</span>
          <span className="mt-1 block">{ko.glossary.jsonCastTokens}</span>
          <span className="mt-1 block">{ko.glossary.jsonCastRule}</span>
        </HelpTip>
      </div>
      <Textarea
        size="sm"
        aria-label={ko.editor.jsonBodyAria}
        className="h-32 font-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        spellCheck={false}
      />
      <div className="flex justify-end mt-1">
        <button
          type="button"
          className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded"
          onClick={format}
        >
          {ko.editor.formatButton}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">JSON: {error}</p>}
    </div>
  );
}

function FormBodyField({ step }: { step: HttpStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const body = step.request.body;
  const map = body?.kind === "form" ? body.value : {};
  return (
    <KeyValueGrid
      entries={map ?? {}}
      disabledEntries={step.request.disabled?.form ?? {}}
      onChange={(active, disabled) => {
        setStepField(step.id, ["request", "body"], { form: active });
        setStepField(
          step.id,
          ["request", "disabled"],
          buildDisabled(step.request.disabled?.headers, disabled),
        );
      }}
      resetKey={step.id}
      bulkFormat="form"
      itemLabel="form field"
      keyPlaceholder="field"
      valuePlaceholder="value"
      emptyText={ko.editor.noFormFields}
    />
  );
}

function RawBodyField({ step }: { step: HttpStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const body = step.request.body;
  const value = body?.kind === "raw" ? body.value : "";
  return (
    <Textarea
      size="sm"
      className="h-24 font-mono"
      value={value}
      onChange={(e) => setStepField(step.id, ["request", "body"], { raw: e.target.value })}
      spellCheck={false}
    />
  );
}

function AssertEditor({
  step,
  setStepAssert,
}: {
  step: HttpStep;
  setStepAssert: (id: string, asserts: ReadonlyArray<Assertion>) => void;
}) {
  const [newCode, setNewCode] = useState("");
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <ul className="flex flex-col gap-1">
        {step.assert.map((a, idx) => (
          <li key={`${a.kind}-${a.code}-${idx}`} className="flex items-center gap-2 text-xs">
            <span className="font-mono text-slate-600 w-16">{ko.editor.assertStatusField}</span>
            <div className="w-24">
              <Input
                numeric
                size="sm"
                type="number"
                min={100}
                max={599}
                value={a.code}
                onChange={(e) => {
                  const code = Number(e.target.value);
                  if (!Number.isFinite(code)) return;
                  const next = [...step.assert];
                  next[idx] = { kind: "status", code };
                  setStepAssert(step.id, next);
                }}
              />
            </div>
            <button
              type="button"
              aria-label={ko.editor.removeAssertion(idx)}
              className="text-slate-500 hover:text-red-600"
              onClick={() => {
                setStepAssert(
                  step.id,
                  step.assert.filter((_, i) => i !== idx),
                );
              }}
            >
              ×
            </button>
          </li>
        ))}
        {step.assert.length === 0 && (
          <li className="text-xs text-slate-400 italic">{ko.editor.noAssertions}</li>
        )}
      </ul>
      <div className="flex gap-2">
        <div className="w-24">
          <Input
            numeric
            size="sm"
            type="number"
            placeholder="200"
            min={100}
            max={599}
            value={newCode}
            onChange={(e) => setNewCode(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="px-2 py-1 text-xs border border-slate-300 rounded disabled:opacity-50"
          disabled={!newCode}
          onClick={() => {
            const code = Number(newCode);
            if (!Number.isFinite(code) || code < 100 || code > 599) return;
            setStepAssert(step.id, [...step.assert, { kind: "status", code }]);
            setNewCode("");
          }}
        >
          {ko.common.add}
        </button>
      </div>
    </div>
  );
}

// Draft type mirrors Extract but allows empty strings during editing.
type DraftExtract =
  | { var: string; from: "body"; path: string }
  | { var: string; from: "header"; name: string }
  | { var: string; from: "cookie"; name: string }
  | { var: string; from: "status" };

function draftFromExtract(e: Extract): DraftExtract {
  return e as DraftExtract;
}

function ExtractEditor({ step }: { step: HttpStep }) {
  const setStepExtract = useScenarioEditor((s) => s.setStepExtract);

  // Local drafts let us show in-progress rows before they pass Zod validation.
  const [drafts, setDrafts] = useState<DraftExtract[]>(() => step.extract.map(draftFromExtract));

  // Reset drafts when the selected step changes.
  useEffect(() => {
    setDrafts(step.extract.map(draftFromExtract));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);

  // Push valid rows to the store after every draft change.
  const commitDrafts = (next: DraftExtract[]) => {
    // Rows that satisfy Zod (var non-empty + required second field non-empty and
    // not just the bare "$." default sentinel that append() inserts).
    const valid = next.filter((d) => {
      if (!d.var) return false;
      if (d.from === "body") return d.path.length > 0 && d.path !== "$.";
      if (d.from === "header" || d.from === "cookie") return d.name.length > 0;
      return true; // status needs no extra field
    }) as Extract[];
    setStepExtract(step.id, valid);
  };

  // Update a single draft row locally — does NOT commit to the store.
  const updateDraft = (idx: number, next: DraftExtract) => {
    const list = drafts.slice();
    list[idx] = next;
    setDrafts(list);
  };

  // Commit the current drafts to the store (called on input blur).
  const commitFromBlur = () => {
    commitDrafts(drafts);
  };

  // Structural from-kind change: update draft AND commit immediately.
  const setFromKind = (idx: number, from: Extract["from"]) => {
    const x = drafts[idx];
    const list = drafts.slice();
    if (from === "body")
      list[idx] = { var: x.var, from, path: (x as { path?: string }).path ?? "$." };
    else if (from === "header")
      list[idx] = { var: x.var, from, name: (x as { name?: string }).name ?? "" };
    else if (from === "cookie")
      list[idx] = { var: x.var, from, name: (x as { name?: string }).name ?? "" };
    else list[idx] = { var: x.var, from: "status" };
    setDrafts(list);
    commitDrafts(list); // structural change — commit immediately
  };

  const remove = (idx: number) => {
    const list = drafts.filter((_, i) => i !== idx);
    setDrafts(list);
    setStepExtract(step.id, list as Extract[]);
  };

  const append = () => {
    const list: DraftExtract[] = [...drafts, { var: "", from: "body", path: "$." }];
    setDrafts(list);
    // Don't commit yet — the new row is empty and won't pass validation.
  };

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <p className="text-xs text-slate-500">{ko.editor.extractsHint}</p>
      <ul className="flex flex-col gap-2">
        {drafts.map((x, idx) => (
          <li key={idx} className="flex flex-wrap gap-2 items-center text-xs">
            <div className="w-24">
              <Input
                size="sm"
                placeholder="var"
                className="font-mono"
                value={x.var}
                onChange={(e) => updateDraft(idx, { ...x, var: e.target.value })}
                onBlur={commitFromBlur}
              />
            </div>
            <div className="w-fit">
              <Select
                size="sm"
                aria-label={ko.editor.extractFromAria(idx)}
                value={x.from}
                onChange={(e) => setFromKind(idx, e.target.value as Extract["from"])}
              >
                <option value="body">본문</option>
                <option value="header">헤더</option>
                <option value="cookie">쿠키</option>
                <option value="status">상태</option>
              </Select>
            </div>
            {x.from === "body" && (
              <div className="flex-1 min-w-[120px]">
                <Input
                  size="sm"
                  placeholder="$.path"
                  className="font-mono"
                  value={x.path}
                  onChange={(e) => updateDraft(idx, { ...x, path: e.target.value })}
                  onBlur={commitFromBlur}
                />
              </div>
            )}
            {(x.from === "header" || x.from === "cookie") && (
              <div className="flex-1 min-w-[120px]">
                <Input
                  size="sm"
                  placeholder={
                    x.from === "header"
                      ? ko.editor.headerNamePlaceholder
                      : ko.editor.cookieNamePlaceholder
                  }
                  className="font-mono"
                  value={x.name}
                  onChange={(e) => updateDraft(idx, { ...x, name: e.target.value })}
                  onBlur={commitFromBlur}
                />
              </div>
            )}
            {x.from === "status" && (
              <span className="text-slate-400 italic flex-1">{ko.editor.noExtraField}</span>
            )}
            <button
              type="button"
              aria-label={ko.editor.removeExtract(idx)}
              className="text-slate-500 hover:text-red-600"
              onClick={() => remove(idx)}
            >
              ×
            </button>
          </li>
        ))}
        {drafts.length === 0 && (
          <li className="text-xs text-slate-400 italic">{ko.editor.noExtracts}</li>
        )}
      </ul>
      <button
        type="button"
        className="self-start px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
        onClick={append}
      >
        {ko.common.add}
      </button>
    </div>
  );
}

function ParallelBranchEditor({
  parallelId,
  branchIndex,
  branchName,
  stepsCount,
  canRemove,
  allBranchNames,
}: {
  parallelId: string;
  branchIndex: number;
  branchName: string;
  stepsCount: number;
  canRemove: boolean;
  allBranchNames: ReadonlyArray<string>;
}) {
  const addStepInParallelBranch = useScenarioEditor((s) => s.addStepInParallelBranch);
  const setBranchName = useScenarioEditor((s) => s.setBranchName);
  const removeBranch = useScenarioEditor((s) => s.removeBranch);
  const select = useScenarioEditor((s) => s.select);

  // F5 onBlur-commit pattern: local draft for the branch name input.
  // Per-branch draft keyed by branchIndex — avoids cross-field one-empty no-op issue.
  const [nameDraft, setNameDraft] = useState(branchName);

  // Re-seed when the committed name changes (e.g. after a remote edit or step switch).
  useEffect(() => {
    setNameDraft(branchName);
  }, [branchName]);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed === "") {
      // Empty name not valid; revert draft to last committed value
      setNameDraft(branchName);
      return;
    }
    if (trimmed !== branchName) {
      setBranchName(parallelId, branchIndex, trimmed);
    }
  };

  // Duplicate name: the current draft value matches another branch's committed name.
  // Zod's superRefine hard-blocks duplicate committed names; this is a visual preview
  // warning that fires when the draft (being typed / just committed) would conflict.
  // We check nameDraft against other branches' committed names (excluding this branch's
  // own index so a branch renaming to its current name doesn't self-warn).
  const isDuplicate =
    nameDraft.trim() !== "" &&
    allBranchNames.some((n, i) => i !== branchIndex && n === nameDraft.trim());

  return (
    <div className="border border-slate-200 rounded p-2 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="text-xs font-semibold text-slate-600 shrink-0">
          {ko.editor.branchLabel(branchIndex + 1)}
        </label>
        <div className="flex-1 min-w-0">
          <Input
            size="sm"
            aria-label={ko.editor.branchNameAria(branchIndex)}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
          />
        </div>
        {canRemove && (
          <button
            type="button"
            aria-label={ko.editor.removeBranch(branchIndex)}
            className="shrink-0 text-slate-500 hover:text-red-600 text-xs border border-slate-200 rounded px-2 py-1"
            onClick={() => removeBranch(parallelId, branchIndex)}
          >
            ✕
          </button>
        )}
      </div>
      {isDuplicate && (
        <span role="alert" className="text-[11px] text-amber-600">
          중복된 분기 이름
        </span>
      )}
      <div className="text-xs text-slate-400 italic ml-1">
        {stepsCount} step{stepsCount !== 1 ? "s" : ""}
      </div>
      <button
        type="button"
        aria-label={ko.editor.addStepToLabel(`분기 ${branchIndex}`)}
        className="self-start px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
        onClick={() => {
          const id = addStepInParallelBranch(parallelId, branchIndex, "Step");
          select(id);
        }}
      >
        {ko.editor.addStepInBranch}
      </button>
    </div>
  );
}

function ParallelInspector({ step }: { step: ParallelStep; topLevel: boolean }) {
  const addBranch = useScenarioEditor((s) => s.addBranch);
  const removeStep = useScenarioEditor((s) => s.removeStep);

  const allBranchNames = step.branches.map((b) => b.name);
  const canRemove = step.branches.length > 1;

  return (
    <aside aria-label={ko.editor.inspectorAria} className="flex flex-col gap-4 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-700">{ko.editor.parallelPanelTitle}</h3>
        <div className="flex gap-1">
          <MoveButtons stepId={step.id} />
          <SmallButton
            onClick={() => removeStep(step.id)}
            label={ko.common.delete}
            title={ko.editor.deleteParallel}
            danger
          />
        </div>
      </header>

      <StepNameField stepId={step.id} name={step.name} />

      <div className="flex flex-col gap-2">
        <div className="text-xs font-semibold text-slate-600">{ko.editor.branchesLabel}</div>
        {step.branches.map((branch, i) => (
          <ParallelBranchEditor
            key={i}
            parallelId={step.id}
            branchIndex={i}
            branchName={branch.name}
            stepsCount={branch.steps.length}
            canRemove={canRemove}
            allBranchNames={allBranchNames}
          />
        ))}
        <button
          type="button"
          className="self-start px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
          onClick={() => addBranch(step.id)}
        >
          {ko.editor.addBranch}
        </button>
      </div>
    </aside>
  );
}

function ChildStepButton({ step, onClick }: { step: Step; onClick: () => void }) {
  const meta =
    step.type === "http"
      ? `${step.request.method} ${step.request.url}`
      : step.type === "loop"
        ? `loop ×${step.repeat}`
        : step.type === "parallel"
          ? `parallel ×${step.branches.length}`
          : "if";
  return (
    <button
      type="button"
      title={`${step.name} — ${meta}`}
      className="block w-full truncate text-left px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-100"
      onClick={onClick}
    >
      <span className="font-medium">{step.name}</span>{" "}
      <span className="font-mono text-slate-500">{meta}</span>
    </button>
  );
}

function LoopInspector({ step, topLevel }: { step: LoopStep; topLevel: boolean }) {
  const setLoopRepeat = useScenarioEditor((s) => s.setLoopRepeat);
  const removeStep = useScenarioEditor((s) => s.removeStep);
  const select = useScenarioEditor((s) => s.select);
  const addStepInLoop = useScenarioEditor((s) => s.addStepInLoop);
  const addIfInLoop = useScenarioEditor((s) => s.addIfInLoop);

  // Numeric draft + commit-on-blur (F5 pattern): local state echoes every
  // keystroke; the model is only updated when a valid integer is committed.
  const [repeatDraft, setRepeatDraft] = useState(String(step.repeat));

  useEffect(() => {
    setRepeatDraft(String(step.repeat));
  }, [step.id, step.repeat]);

  const commitRepeat = () => {
    const n = Number(repeatDraft);
    if (Number.isInteger(n) && n >= 1) setLoopRepeat(step.id, n);
    else setRepeatDraft(String(step.repeat));
  };

  return (
    <aside aria-label={ko.editor.inspectorAria} className="flex flex-col gap-4 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-700">{ko.editor.loopPanelTitle}</h3>
        <div className="flex gap-1">
          <MoveButtons stepId={step.id} />
          <SmallButton
            onClick={() => removeStep(step.id)}
            label={ko.common.delete}
            title={ko.editor.deleteLoop}
            danger
          />
        </div>
      </header>

      <StepNameField stepId={step.id} name={step.name} />

      <Field label={ko.editor.fieldRepeat}>
        <div className="w-24">
          <Input
            numeric
            type="number"
            min={1}
            aria-label={ko.editor.fieldRepeat}
            value={repeatDraft}
            onChange={(e) => setRepeatDraft(e.target.value)}
            onBlur={commitRepeat}
          />
        </div>
      </Field>

      <div>
        <div className="text-xs font-semibold text-slate-600 mb-1">{ko.editor.bodyStepsLabel}</div>
        <ul className="flex flex-col gap-1">
          {step.do.map((c) => (
            <li key={c.id}>
              <ChildStepButton step={c} onClick={() => select(c.id)} />
            </li>
          ))}
          {step.do.length === 0 && (
            <li className="text-xs text-slate-400 italic">{ko.editor.noSteps}</li>
          )}
        </ul>
        <div className="flex gap-2 mt-1">
          <button
            type="button"
            aria-label={ko.editor.addStepToLoopBody}
            className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
            onClick={() => {
              const id = addStepInLoop(step.id, "Step");
              select(id);
            }}
          >
            {ko.editor.addStep}
          </button>
          {topLevel && (
            <button
              type="button"
              aria-label={ko.editor.addIfToLoopBody}
              className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
              onClick={() => {
                const id = addIfInLoop(step.id, "If");
                select(id);
              }}
            >
              {ko.editor.addIfToLoopBody}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function ConditionEditor({
  cond,
  onCommit,
}: {
  cond: Condition;
  onCommit: (c: Condition) => void;
}) {
  // Local draft tree (ExtractEditor pattern): text inputs update the draft and
  // commit on blur; structural changes update + commit immediately.
  const [draft, setDraft] = useState<Condition>(cond);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Re-seed the draft when the committed cond changes. A self-commit re-parses the
  // model, so cond is a new-but-structurally-equal object and this re-fires harmlessly;
  // its real purpose is resetting the draft when the user switches to a different step/elif.
  useEffect(() => {
    setDraft(cond);
  }, [cond]);

  const editLocal = (path: number[], sub: Condition) => setDraft((d) => setAtPath(d, path, sub));
  const editCommit = (path: number[], sub: Condition) => {
    const next = setAtPath(draftRef.current, path, sub);
    setDraft(next);
    onCommit(next);
  };
  const removeChild = (path: number[]) => {
    const next = removeAtPath(draftRef.current, path);
    setDraft(next);
    onCommit(next);
  };
  const commitText = () => onCommit(draftRef.current);

  const isGroup = "all" in draft || "any" in draft;

  return (
    <div className="flex flex-col gap-2">
      <ConditionNode
        value={draft}
        path={[]}
        editLocal={editLocal}
        editCommit={editCommit}
        removeChild={removeChild}
        commitText={commitText}
      />
      {!isGroup && (
        <button
          type="button"
          className="self-start px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
          onClick={() => {
            const next: Condition = { all: [draftRef.current] };
            setDraft(next);
            onCommit(next);
          }}
        >
          {ko.editor.wrapInGroup}
        </button>
      )}
    </div>
  );
}

function ConditionNode({
  value,
  path,
  editLocal,
  editCommit,
  removeChild,
  commitText,
}: {
  value: Condition;
  path: number[];
  editLocal: (path: number[], sub: Condition) => void;
  editCommit: (path: number[], sub: Condition) => void;
  removeChild: (path: number[]) => void;
  commitText: () => void;
}) {
  if ("all" in value || "any" in value) {
    const kind: "all" | "any" = "all" in value ? "all" : "any";
    const children = "all" in value ? value.all : (value as { any: Condition[] }).any;
    const wrap = (next: Condition[]): Condition => (kind === "all" ? { all: next } : { any: next });
    return (
      <div className="flex flex-col gap-2 border-l-2 border-accent-200 pl-2">
        <div className="w-32">
          <Select
            size="sm"
            aria-label={ko.editor.condGroupKindAria}
            value={kind}
            onChange={(e) => {
              const k = e.target.value as "all" | "any";
              editCommit(path, (k === "all" ? { all: children } : { any: children }) as Condition);
            }}
          >
            <option value="all">{ko.editor.condAll}</option>
            <option value="any">{ko.editor.condAny}</option>
          </Select>
        </div>
        {children.map((c, i) => (
          <div key={i} className="flex gap-1 items-start">
            <ConditionNode
              value={c}
              path={[...path, i]}
              editLocal={editLocal}
              editCommit={editCommit}
              removeChild={removeChild}
              commitText={commitText}
            />
            {/* Only offer removal when >1 child: a group must never reach zero
                children (engine reads empty `all` as vacuous-true / empty `any`
                as false), so a 1-child group has no removable child. */}
            {children.length > 1 && (
              <button
                type="button"
                aria-label={ko.editor.removeCondition}
                className="text-slate-500 hover:text-red-600 shrink-0"
                onClick={() => removeChild([...path, i])}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <div className="flex gap-2">
          <button
            type="button"
            className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
            onClick={() => editCommit(path, wrap([...children, NEW_LEAF()]))}
          >
            {ko.editor.addCondition}
          </button>
          <button
            type="button"
            className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
            onClick={() =>
              editCommit(path, wrap([...children, { all: [NEW_LEAF()] } as Condition]))
            }
          >
            {ko.editor.addGroup}
          </button>
        </div>
      </div>
    );
  }

  const leaf = value as { left: string; op: CompareOp; right?: string };
  const noRight = leaf.op === "exists" || leaf.op === "empty";
  const regexBad = leaf.op === "matches" && !isValidRegex(leaf.right ?? "");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1 items-center">
        <div className="w-28 min-w-0">
          <Input
            size="sm"
            className="min-w-0 font-mono"
            aria-label={ko.editor.condLeftAria}
            placeholder={ko.editor.condLeftPlaceholder}
            value={leaf.left}
            onChange={(e) => editLocal(path, { ...leaf, left: e.target.value })}
            onBlur={commitText}
          />
        </div>
        <div className="w-fit">
          <Select
            size="sm"
            aria-label={ko.editor.condOpAria}
            value={leaf.op}
            onChange={(e) => {
              const op = e.target.value as CompareOp;
              const next: Condition =
                op === "exists" || op === "empty"
                  ? { left: leaf.left, op }
                  : { left: leaf.left, op, right: leaf.right ?? "" };
              editCommit(path, next);
            }}
          >
            {OPS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </div>
        {!noRight && (
          <div className="w-28 min-w-0">
            <Input
              size="sm"
              className="min-w-0 font-mono"
              aria-label={ko.editor.condRightAria}
              placeholder={ko.editor.condRightPlaceholder}
              value={leaf.right ?? ""}
              onChange={(e) => editLocal(path, { ...leaf, right: e.target.value })}
              onBlur={commitText}
            />
          </div>
        )}
      </div>
      {regexBad && <span className="text-[11px] text-amber-600">⚠ invalid regex</span>}
    </div>
  );
}

function BranchPanel({
  label,
  branch,
  steps,
  ifId,
  loopAllowed,
}: {
  label: string;
  branch: BranchSel;
  steps: ReadonlyArray<Step>;
  ifId: string;
  loopAllowed: boolean;
}) {
  const addStepInBranch = useScenarioEditor((s) => s.addStepInBranch);
  const addLoopInBranch = useScenarioEditor((s) => s.addLoopInBranch);
  const select = useScenarioEditor((s) => s.select);
  return (
    <div>
      <div className="text-xs font-semibold text-slate-600 mb-1">{label}</div>
      <ul className="flex flex-col gap-1">
        {steps.map((c) => (
          <li key={c.id}>
            <ChildStepButton step={c} onClick={() => select(c.id)} />
          </li>
        ))}
        {steps.length === 0 && (
          <li className="text-xs text-slate-400 italic">{ko.editor.noSteps}</li>
        )}
      </ul>
      <div className="flex gap-2 mt-1">
        <button
          type="button"
          aria-label={ko.editor.addStepToLabel(label)}
          className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
          onClick={() => {
            const id = addStepInBranch(ifId, branch, "Step");
            select(id);
          }}
        >
          {ko.editor.addStep}
        </button>
        {loopAllowed && (
          <button
            type="button"
            aria-label={ko.editor.addLoopToLabel(label)}
            className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
            onClick={() => {
              const id = addLoopInBranch(ifId, branch, "Loop");
              select(id);
            }}
          >
            {ko.editor.addLoopInBranch}
          </button>
        )}
      </div>
    </div>
  );
}

function IfInspector({ step, topLevel }: { step: IfStep; topLevel: boolean }) {
  const setIfCond = useScenarioEditor((s) => s.setIfCond);
  const setElifCond = useScenarioEditor((s) => s.setElifCond);
  const addElif = useScenarioEditor((s) => s.addElif);
  const removeElif = useScenarioEditor((s) => s.removeElif);
  const removeStep = useScenarioEditor((s) => s.removeStep);

  return (
    <aside aria-label={ko.editor.inspectorAria} className="flex flex-col gap-4 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-700">{ko.editor.ifPanelTitle}</h3>
        <div className="flex gap-1">
          <MoveButtons stepId={step.id} />
          <SmallButton
            onClick={() => removeStep(step.id)}
            label={ko.common.delete}
            title={ko.editor.deleteIf}
            danger
          />
        </div>
      </header>

      <StepNameField stepId={step.id} name={step.name} />

      <fieldset
        className="flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3"
        aria-label={ko.editor.conditionLegend}
      >
        <legend className="px-1 text-xs font-semibold text-slate-600">
          {ko.editor.conditionLegend}
        </legend>
        <ConditionEditor cond={step.cond} onCommit={(c) => setIfCond(step.id, c)} />
      </fieldset>

      <BranchPanel
        label={ko.editor.condThen}
        branch={{ kind: "then" }}
        steps={step.then}
        ifId={step.id}
        loopAllowed={topLevel}
      />

      {step.elif.map((e, i) => (
        <fieldset
          key={i}
          className="flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3"
        >
          <legend className="px-1 text-xs font-semibold text-slate-600 flex items-center gap-2">
            <span>{ko.editor.elifLabel(i + 1)}</span>
            <button
              type="button"
              aria-label={ko.editor.removeElif(i + 1)}
              className="text-slate-500 hover:text-red-600"
              onClick={() => removeElif(step.id, i)}
            >
              ×
            </button>
          </legend>
          <ConditionEditor cond={e.cond} onCommit={(c) => setElifCond(step.id, i, c)} />
          <BranchPanel
            label={ko.editor.elifLabel(i + 1)}
            branch={{ kind: "elif", index: i }}
            steps={e.then}
            ifId={step.id}
            loopAllowed={topLevel}
          />
        </fieldset>
      ))}

      <button
        type="button"
        className="self-start px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
        onClick={() => addElif(step.id)}
      >
        {ko.editor.addElif}
      </button>

      <BranchPanel
        label={ko.editor.condElse}
        branch={{ kind: "else" }}
        steps={step.else}
        ifId={step.id}
        loopAllowed={topLevel}
      />
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

/** 이름 draft + 하이브리드 커밋(R12): 비-빈은 onChange 즉시 커밋(라이브 갱신),
 *  빈 값은 미커밋(draft 유지), blur 시 trim-빈이면 "Untitled" 폴백. store엔 빈
 *  이름이 절대 안 들어가 model min(1)/reparse 실패 경로 없음(R13). name dep
 *  재시드는 YAML 모달 등 외부 편집이 같은 스텝 이름을 바꿔도 draft가 따라가게 한다. */
function StepNameField({ stepId, name }: { stepId: string; name: string }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    setDraft(name);
  }, [stepId, name]);
  return (
    <Field label={ko.editor.fieldName}>
      <Input
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          if (v !== "") setStepField(stepId, ["name"], v); // raw 검사 — trim은 blur만 (R12)
        }}
        onBlur={() => {
          if (draft.trim() === "") {
            setStepField(stepId, ["name"], "Untitled");
            setDraft("Untitled");
          }
        }}
      />
    </Field>
  );
}

function SmallButton({
  onClick,
  label,
  title,
  disabled,
  danger,
}: {
  onClick: () => void;
  label: string;
  title: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={
        "px-2 py-1 text-xs border rounded disabled:opacity-40 " +
        (danger
          ? "border-red-300 text-red-700 hover:bg-red-50"
          : "border-slate-300 text-slate-700 hover:bg-slate-100")
      }
    >
      {label}
    </button>
  );
}
