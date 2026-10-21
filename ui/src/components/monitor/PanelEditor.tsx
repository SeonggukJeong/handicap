import { useMemo, useState } from "react";
import { previewCheck, newPanel } from "../../api/monitors";
import type { PanelConfig, PreviewResult as Preview } from "../../api/monitors";
import type { Scenario } from "../../api/schemas";
import type { EnvironmentSummary } from "../../api/environments";
import { Button } from "../Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { ko } from "../../i18n/ko";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import { flattenHttpSteps } from "../../scenario/model";
import { PreviewResult } from "./PreviewResult";

const MAX_THRESHOLDS = 5;
const THRESHOLD_COLORS = ["#f59e0b", "#ef4444", "#a855f7", "#3b82f6", "#14b8a6"];

type Props = {
  panel: PanelConfig;
  index: number;
  scenarios: Scenario[];
  environments: EnvironmentSummary[];
  scenarioError: boolean;
  canRemove: boolean;
  onChange: (next: PanelConfig) => void;
  onRemove: () => void;
};

const toNum = (v: string): number => (v === "" ? 0 : Number(v));

/** Number of advanced settings that differ from a fresh panel's defaults. */
function advancedCount(p: PanelConfig): number {
  const d = newPanel();
  let n = 0;
  if (p.timeout_seconds !== d.timeout_seconds) n++;
  if (p.latency_source.kind !== "total") n++;
  if (p.bar_count !== d.bar_count) n++;
  if (p.graph_max_ms !== d.graph_max_ms) n++;
  return n;
}

export function PanelEditor({
  panel,
  index,
  scenarios,
  environments,
  scenarioError,
  canRemove,
  onChange,
  onRemove,
}: Props) {
  const pid = panel.id;
  const [advOpen, setAdvOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [localScenarioErr, setLocalScenarioErr] = useState(false);

  const scenario = scenarios.find((s) => s.id === panel.scenario_id);
  const steps = useMemo(() => {
    if (!scenario) return [];
    const parsed = parseScenarioDoc(scenario.yaml);
    if ("error" in parsed) return [];
    return flattenHttpSteps(parsed.model.steps);
  }, [scenario]);
  const stepNames = useMemo(
    () => Object.fromEntries(steps.map((s) => [s.id, s.name])) as Record<string, string>,
    [steps],
  );

  const set = (patch: Partial<PanelConfig>) => onChange({ ...panel, ...patch });
  const advN = advancedCount(panel);
  const latencyValue =
    panel.latency_source.kind === "step" ? `step:${panel.latency_source.step_id}` : "total";
  const stepGone =
    panel.latency_source.kind === "step" &&
    !steps.some((s) => s.id === (panel.latency_source as { step_id: string }).step_id);

  const setThreshold = (i: number, patch: Partial<{ ms: number; color: string }>) =>
    set({ thresholds: panel.thresholds.map((t, k) => (k === i ? { ...t, ...patch } : t)) });
  const addThreshold = () => {
    const last = panel.thresholds[panel.thresholds.length - 1];
    set({
      thresholds: [
        ...panel.thresholds,
        {
          ms: last ? last.ms + 1000 : 1000,
          color: THRESHOLD_COLORS[panel.thresholds.length % THRESHOLD_COLORS.length],
        },
      ],
    });
  };

  const runPreview = async () => {
    setPreview(null);
    setPreviewErr(null);
    if (!panel.scenario_id) {
      setLocalScenarioErr(true);
      return;
    }
    setLocalScenarioErr(false);
    setPreviewing(true);
    try {
      // The server requires a 1–40 char title; a blank form title must not fail the preview.
      const payload = panel.title.trim() ? panel : { ...panel, title: ko.monitor.preview };
      setPreview(await previewCheck(payload));
    } catch (e) {
      setPreviewErr((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const showScenarioErr = (scenarioError || localScenarioErr) && !panel.scenario_id;

  return (
    <section
      aria-label={`${ko.monitor.panels} ${index + 1}`}
      className="rounded-md border border-slate-200 bg-white p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">
          {ko.monitor.panels} {index + 1}
        </h3>
        {canRemove && (
          <Button variant="secondary" type="button" onClick={onRemove}>
            {ko.monitor.removePanel}
          </Button>
        )}
      </div>

      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label={ko.monitor.panelTitle} htmlFor={`${pid}-title`}>
          <Input
            id={`${pid}-title`}
            value={panel.title}
            onChange={(e) => set({ title: e.target.value })}
          />
        </Field>
        <Field label={ko.monitor.interval} htmlFor={`${pid}-interval`}>
          <Input
            id={`${pid}-interval`}
            type="number"
            numeric
            min={1}
            max={3600}
            value={panel.interval_seconds}
            onChange={(e) => set({ interval_seconds: toNum(e.target.value) })}
          />
        </Field>
        <Field
          label={ko.monitor.scenario}
          htmlFor={`${pid}-scenario`}
          error={showScenarioErr ? ko.monitor.scenarioRequired : undefined}
          errorId={`${pid}-scenario-err`}
        >
          <Select
            id={`${pid}-scenario`}
            value={panel.scenario_id}
            aria-invalid={showScenarioErr || undefined}
            aria-describedby={showScenarioErr ? `${pid}-scenario-err` : undefined}
            onChange={(e) =>
              set({ scenario_id: e.target.value, latency_source: { kind: "total" } })
            }
          >
            <option value="">{ko.monitor.noValue}</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={ko.monitor.environment} htmlFor={`${pid}-env`}>
          <Select
            id={`${pid}-env`}
            value={panel.environment_id ?? ""}
            onChange={(e) => set({ environment_id: e.target.value === "" ? null : e.target.value })}
          >
            <option value="">{ko.monitor.environmentNone}</option>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset className="mb-3 min-w-0">
        <legend className="mb-1 text-sm text-slate-700">{ko.monitor.thresholds}</legend>
        <ul className="flex flex-col gap-2">
          {panel.thresholds.map((t, i) => (
            <li key={i} className="flex items-center gap-2">
              <div className="w-32">
                <Input
                  aria-label={`${ko.monitor.thresholds} ${i + 1} ${ko.monitor.thresholdMs}`}
                  type="number"
                  numeric
                  min={1}
                  value={t.ms}
                  onChange={(e) => setThreshold(i, { ms: toNum(e.target.value) })}
                />
              </div>
              <span className="text-sm text-slate-500">{ko.monitor.thresholdMs}</span>
              <input
                type="color"
                aria-label={`${ko.monitor.thresholds} ${i + 1}`}
                value={t.color}
                onChange={(e) => setThreshold(i, { color: e.target.value })}
                className="h-8 w-10 cursor-pointer rounded border border-slate-300 bg-white p-0.5"
              />
              <Button
                variant="secondary"
                type="button"
                aria-label={`${ko.monitor.thresholds} ${i + 1} ${ko.monitor.removeThreshold}`}
                onClick={() => set({ thresholds: panel.thresholds.filter((_, k) => k !== i) })}
              >
                {ko.monitor.removeThreshold}
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-2">
          <Button
            variant="secondary"
            type="button"
            disabled={panel.thresholds.length >= MAX_THRESHOLDS}
            onClick={addThreshold}
          >
            {ko.monitor.addThreshold}
          </Button>
        </div>
      </fieldset>

      <fieldset className="mb-3 min-w-0">
        <legend className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <button
            type="button"
            aria-expanded={advOpen}
            onClick={() => setAdvOpen((v) => !v)}
            className="hover:underline"
          >
            {advOpen ? "▾" : "▸"} {ko.monitor.advanced}
          </button>
          {!advOpen && advN > 0 && (
            <span className="text-xs font-normal text-slate-500">
              {ko.monitor.advancedSet(advN)}
            </span>
          )}
        </legend>
        {advOpen && (
          <div className="mt-2 grid gap-x-4 sm:grid-cols-2">
            <Field label={ko.monitor.timeout} htmlFor={`${pid}-timeout`}>
              <Input
                id={`${pid}-timeout`}
                type="number"
                numeric
                min={1}
                max={120}
                value={panel.timeout_seconds}
                onChange={(e) => set({ timeout_seconds: toNum(e.target.value) })}
              />
            </Field>
            <Field label={ko.monitor.latencySource} htmlFor={`${pid}-latency`}>
              <Select
                id={`${pid}-latency`}
                value={latencyValue}
                onChange={(e) => {
                  const v = e.target.value;
                  set({
                    latency_source:
                      v === "total" ? { kind: "total" } : { kind: "step", step_id: v.slice(5) },
                  });
                }}
              >
                <option value="total">{ko.monitor.latencyTotal}</option>
                {stepGone && panel.latency_source.kind === "step" && (
                  <option value={latencyValue}>{panel.latency_source.step_id}</option>
                )}
                {steps.map((s) => (
                  <option key={s.id} value={`step:${s.id}`}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={ko.monitor.barCount} htmlFor={`${pid}-bars`}>
              <Input
                id={`${pid}-bars`}
                type="number"
                numeric
                min={10}
                max={300}
                value={panel.bar_count}
                onChange={(e) => set({ bar_count: toNum(e.target.value) })}
              />
            </Field>
            <Field label={ko.monitor.graphMax} htmlFor={`${pid}-gmax`}>
              <Input
                id={`${pid}-gmax`}
                type="number"
                numeric
                min={100}
                max={600000}
                value={panel.graph_max_ms}
                onChange={(e) => set({ graph_max_ms: toNum(e.target.value) })}
              />
            </Field>
          </div>
        )}
      </fieldset>

      <div className="flex items-center gap-3">
        <Button variant="secondary" type="button" disabled={previewing} onClick={runPreview}>
          {previewing ? ko.monitor.previewRunning : ko.monitor.preview}
        </Button>
      </div>
      {previewErr && (
        <Callout variant="error" role="alert" className="mt-2">
          {previewErr}
        </Callout>
      )}
      {preview && <PreviewResult preview={preview} stepNames={stepNames} />}
    </section>
  );
}
