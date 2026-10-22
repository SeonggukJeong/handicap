import { useState } from "react";
import type { Condition, PreviewResult as Preview } from "../../api/monitors";
import { ko } from "../../i18n/ko";
import { formatMs } from "../../monitor/logic";
import { defaultCondition, targetLabel, type ConditionClick } from "../../monitor/conditions";
import { BodyBlock } from "../response/BodyBlock";
import { HeaderTable } from "../response/HeaderTable";
import { JsonValueTree } from "../response/JsonValueTree";
import { ConditionRow } from "./ConditionRow";

const VERDICT_LABEL = {
  ok: ko.monitor.stateOk,
  fail: ko.monitor.stateFail,
  config_error: ko.monitor.stateConfigError,
} as const;

const MAX_CONDITIONS = 10;

type TraceStep = NonNullable<Preview["trace"]>["steps"][number];

const addButtonCls = "rounded bg-slate-200 px-1.5 py-0.5 text-[11px] hover:bg-slate-300";

function isJsonBody(body: string, truncated: boolean): boolean {
  if (truncated) return false;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function StepRow({
  step: s,
  name,
  onAddCondition,
  conditionCount,
}: {
  step: TraceStep;
  name: string;
  onAddCondition?: (c: Condition) => void;
  conditionCount: number;
}) {
  const k = ko.monitor;
  const [click, setClick] = useState<ConditionClick | null>(null);
  const resp = s.response;
  const interactive = s.kind === "http" && resp != null && onAddCondition !== undefined;
  const blockedReason = conditionCount >= MAX_CONDITIONS ? k.condMax : undefined;
  const confirmRow = (c: ConditionClick, close: () => void) => {
    const { condition, volatileHint } = defaultCondition(s.step_id, c);
    return (
      <ConditionRow
        initial={condition}
        mode="create"
        volatileHint={volatileHint}
        blockedReason={blockedReason}
        onSubmit={(next) => {
          onAddCondition?.(next);
          close();
        }}
        onCancel={close}
      />
    );
  };
  const treeBody = interactive && resp.body !== "" && isJsonBody(resp.body, resp.body_truncated);

  return (
    <li className="rounded border border-slate-200 bg-white p-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-slate-500">{k.previewStep}</dt>
        <dd>{name}</dd>
        <dt className="text-slate-500">{k.previewStatus}</dt>
        <dd className="flex items-center gap-2 tabular-nums">
          <span>{resp ? String(resp.status) : k.noValue}</span>
          {interactive && (
            <button
              type="button"
              aria-label={k.condAddAria(k.condTargetStatus)}
              onClick={() => setClick({ kind: "status", status: resp.status })}
              className={addButtonCls}
            >
              {k.condAdd}
            </button>
          )}
        </dd>
        <dt className="text-slate-500">{k.previewLatency}</dt>
        <dd className="tabular-nums">{resp ? formatMs(resp.latency_ms) : k.noValue}</dd>
        {s.error != null && (
          <>
            <dt className="text-slate-500">{k.previewError}</dt>
            <dd className="break-all text-red-700">{s.error}</dd>
          </>
        )}
      </dl>
      {interactive && (
        <div className="mt-2">
          <HeaderTable
            title={k.previewHeaders}
            rows={Object.entries(resp.headers)}
            action={{
              label: k.condAdd,
              ariaLabelFor: (key) => k.condAddAria(k.condTargetHeader(key)),
              onClick: (key) => setClick({ kind: "header", name: key, value: resp.headers[key] }),
            }}
          />
          {click !== null && confirmRow(click, () => setClick(null))}
        </div>
      )}
      {resp && resp.body !== "" && (
        <>
          <p className="mt-2 text-xs font-medium text-slate-500">
            {treeBody ? k.previewBodyClickHint : k.previewBody}
          </p>
          {interactive && !treeBody && (
            <div className="mb-1 mt-1">
              <button
                type="button"
                onClick={() => setClick({ kind: "body_text" })}
                className={addButtonCls}
              >
                {k.condAddBodyText}
              </button>
            </div>
          )}
          <div className="mt-1">
            <BodyBlock
              body={resp.body}
              truncated={resp.body_truncated}
              label={treeBody ? k.previewBodyClickHint : k.previewBody}
              tree={
                treeBody
                  ? {
                      openLabel: k.previewOpenFullCondition,
                      render: (v) => (
                        <JsonValueTree
                          value={v}
                          actionLabel={k.condAdd}
                          actionAriaLabel={(l) =>
                            k.condAddAria(targetLabel({ source: "body", path: l.path }))
                          }
                          renderConfirm={(l, close) =>
                            confirmRow({ kind: "body", path: l.path, value: l.value }, close)
                          }
                        />
                      ),
                    }
                  : undefined
              }
            />
          </div>
        </>
      )}
    </li>
  );
}

/** Preview of one check: per-step status/ms/error/body + the verdict. With `onAddCondition`
 *  the status, headers and JSON body values become click targets for success conditions. */
export function PreviewResult({
  preview,
  stepNames,
  onAddCondition,
  conditionCount = 0,
}: {
  preview: Preview;
  stepNames: Record<string, string>;
  onAddCondition?: (c: Condition) => void;
  conditionCount?: number;
}) {
  const { trace, result } = preview;
  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-700">{ko.monitor.previewVerdict}</span>
        <span className="font-semibold">{VERDICT_LABEL[result.verdict]}</span>
        {result.latency_ms != null && <span>{formatMs(result.latency_ms)}</span>}
        {result.reason != null && <span className="text-slate-600">{result.reason}</span>}
        {result.detail != null && (
          <span className="whitespace-pre-wrap break-all text-slate-600">{result.detail}</span>
        )}
      </p>
      {trace == null ? (
        <p className="mt-2 text-slate-600">{ko.monitor.previewNoTrace}</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-2">
          {trace.steps.map((s, i) => (
            <StepRow
              key={`${s.step_id}-${i}`}
              step={s}
              name={stepNames[s.step_id] ?? s.step_id}
              onAddCondition={onAddCondition}
              conditionCount={conditionCount}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
