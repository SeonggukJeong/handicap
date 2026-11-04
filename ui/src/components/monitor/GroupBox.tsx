import { Children, type ReactNode } from "react";
import type { CheckGroup } from "../../api/monitors";
import type { Scenario } from "../../api/schemas";
import type { EnvironmentSummary } from "../../api/environments";
import { Button } from "../Button";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { ko } from "../../i18n/ko";

type Props = {
  group: CheckGroup;
  /** 1-based group number (first appearance in the panel list). */
  number: number;
  scenarios: Scenario[];
  environments: EnvironmentSummary[];
  expanded: boolean;
  /** Server/client validation reason for this group; shown in the header. */
  error?: string;
  canRemove: boolean;
  canAddPanel: boolean;
  onToggle: () => void;
  onChange: (next: CheckGroup) => void;
  onAddPanel: () => void;
  onRemove: () => void;
  /** The group's panel editors. */
  children: ReactNode;
};

const toNum = (v: string): number => (v === "" ? 0 : Number(v));

/** 점검 묶음 상자(목업 01 A안): 시나리오·환경·점검 주기를 한 번만 두고 소속 칸들을 감싼다. */
export function GroupBox({
  group,
  number,
  scenarios,
  environments,
  expanded,
  error,
  canRemove,
  canAddPanel,
  onToggle,
  onChange,
  onAddPanel,
  onRemove,
  children,
}: Props) {
  const m = ko.monitor;
  const gid = group.id;
  const scenario = scenarios.find((s) => s.id === group.scenario_id);
  const env = environments.find((e) => e.id === group.environment_id);
  const summary = [
    env ? m.groupEnv(env.name) : m.environmentNone,
    m.groupRunsEvery(group.interval_seconds),
    m.groupPanelCount(Children.count(children)),
  ].join(" · ");
  // Only the client's scenario-required check marks the field; other group errors stay in the header.
  const scenarioErr = error === m.scenarioRequired && !group.scenario_id;

  return (
    <section
      id={`group-${gid}`}
      aria-label={m.groupTitle(number)}
      className={`rounded-md border-2 bg-white ${
        error ? "border-red-500" : expanded ? "border-accent-500" : "border-accent-200"
      }`}
    >
      <div
        className={`flex items-center justify-between gap-2 bg-accent-50 px-4 ${
          expanded ? "rounded-t border-b border-slate-200 py-2" : "rounded py-2"
        }`}
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left text-sm"
        >
          <span className="shrink-0 whitespace-nowrap font-semibold text-slate-700">
            {expanded ? "▾" : "▸"} {m.groupTitle(number)}
          </span>
          <span className="min-w-0 shrink truncate font-semibold text-slate-900">
            {scenario?.name ?? m.noScenario}
          </span>
          {error ? (
            <span className="min-w-0 truncate text-xs font-medium text-red-700">{`⚠ ${error}`}</span>
          ) : (
            <span className="min-w-0 truncate text-xs text-slate-500">{`· ${summary}`}</span>
          )}
        </button>
        {expanded && (
          <Button variant="secondary" type="button" disabled={!canRemove} onClick={onRemove}>
            {m.removeGroup}
          </Button>
        )}
      </div>

      <div hidden={!expanded}>
        <div className="grid gap-x-4 border-b border-dashed border-slate-300 px-4 pt-3 sm:grid-cols-3">
          <Field
            label={m.scenario}
            htmlFor={`${gid}-scenario`}
            error={scenarioErr ? m.scenarioRequired : undefined}
            errorId={`${gid}-scenario-err`}
          >
            <Select
              id={`${gid}-scenario`}
              value={group.scenario_id}
              aria-invalid={scenarioErr || undefined}
              aria-describedby={scenarioErr ? `${gid}-scenario-err` : undefined}
              onChange={(e) => onChange({ ...group, scenario_id: e.target.value })}
            >
              <option value="">{m.noValue}</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={m.environment} htmlFor={`${gid}-env`}>
            <Select
              id={`${gid}-env`}
              value={group.environment_id ?? ""}
              onChange={(e) =>
                onChange({
                  ...group,
                  environment_id: e.target.value === "" ? null : e.target.value,
                })
              }
            >
              <option value="">{m.environmentNone}</option>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={m.interval} htmlFor={`${gid}-interval`}>
            <Input
              id={`${gid}-interval`}
              type="number"
              numeric
              min={1}
              max={3600}
              value={group.interval_seconds}
              onChange={(e) => onChange({ ...group, interval_seconds: toNum(e.target.value) })}
            />
          </Field>
        </div>
        <div className="flex flex-col gap-2 py-3 pl-8 pr-4">
          {children}
          <div>
            <Button variant="secondary" type="button" disabled={!canAddPanel} onClick={onAddPanel}>
              {m.groupAddPanel}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
