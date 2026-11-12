import { useId, useState, type ReactNode } from "react";
import type { Condition, DisplayItem, PreviewResult as Preview } from "../../api/monitors";
import { ko } from "../../i18n/ko";
import { formatMs } from "../../monitor/logic";
import {
  defaultCondition,
  isSecretName,
  lastKeyOf,
  parseBodyJson,
  targetLabel,
  type ConditionClick,
} from "../../monitor/conditions";
import { BodyBlock } from "../response/BodyBlock";
import { HeaderTable } from "../response/HeaderTable";
import { JsonValueTree } from "../response/JsonValueTree";
import { ConditionRow } from "./ConditionRow";

const VERDICT_LABEL = {
  ok: ko.monitor.stateOk,
  fail: ko.monitor.stateFail,
  config_error: ko.monitor.stateConfigError,
  upstream_failed: ko.monitor.verdictUpstreamFailed,
  branch_skipped: ko.monitor.verdictBranchSkipped,
} as const;

const MAX_CONDITIONS = 10;

type TraceStep = NonNullable<Preview["trace"]>["steps"][number];

const addButtonCls = "rounded bg-slate-200 px-1.5 py-0.5 text-[11px] hover:bg-slate-300";

const MAX_DISPLAY = 2;
// Credential-bearing headers: the server rejects them as display items too.
// Keep in sync with AUTH_HEADERS in crates/controller/src/monitor/config.rs.
const AUTH_HEADERS = new Set(["set-cookie", "cookie", "authorization", "proxy-authorization"]);

function displayItemOf(stepId: string, c: ConditionClick): DisplayItem | null {
  switch (c.kind) {
    case "body":
      return { step_id: stepId, source: "body", path: c.path };
    case "header":
      return { step_id: stepId, source: "header", path: c.name };
    case "status":
      return { step_id: stepId, source: "status", path: "" };
    default:
      return null;
  }
}

/** The popup after clicking `+ 추가`: condition or wall display. Whole-body text
 *  (`body_text`) has no display form, so it skips straight to the condition row. */
function AddChoice({
  item,
  existing,
  onAddDisplay,
  confirmRow,
  close,
  startAtCondition,
  secretName,
}: {
  secretName: boolean;
  item: DisplayItem | null;
  existing: DisplayItem[];
  onAddDisplay?: (d: DisplayItem) => void;
  confirmRow: (close: () => void) => ReactNode;
  close: () => void;
  startAtCondition: boolean;
}) {
  const k = ko.monitor;
  const [stage, setStage] = useState<"choose" | "condition">(
    startAtCondition || item === null || onAddDisplay === undefined ? "condition" : "choose",
  );
  const reasonId = useId();
  const noteId = useId();
  if (stage === "condition") return <>{confirmRow(close)}</>;
  let reason: string | undefined;
  if (item !== null) {
    if (existing.length >= MAX_DISPLAY) reason = k.displayMax;
    else if (
      existing.some(
        (d) => d.step_id === item.step_id && d.source === item.source && d.path === item.path,
      )
    )
      reason = k.displayDup;
    else if (item.source === "header" && AUTH_HEADERS.has(item.path.trim().toLowerCase()))
      reason = k.displayAuthHeader;
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 rounded bg-accent-50 px-2 py-1 font-sans text-xs text-slate-700">
      <button type="button" onClick={() => setStage("condition")} className={addButtonCls}>
        {k.condChooseCondition}
      </button>
      <button
        type="button"
        disabled={reason !== undefined}
        aria-describedby={reason !== undefined ? reasonId : secretName ? noteId : undefined}
        onClick={() => {
          if (item !== null) onAddDisplay?.(item);
          close();
        }}
        className={`${addButtonCls} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {k.condChooseDisplay}
      </button>
      {reason !== undefined && (
        <span id={reasonId} className="text-xs text-slate-700">
          {reason}
        </span>
      )}
      {reason === undefined && secretName && (
        <span id={noteId} className="text-xs text-amber-700">
          {k.displaySecretNote}
        </span>
      )}
    </div>
  );
}

function StepRow({
  step: s,
  name,
  onAddCondition,
  conditionCount,
  displayItems,
  onAddDisplay,
}: {
  step: TraceStep;
  name: string;
  onAddCondition?: (c: Condition) => void;
  conditionCount: number;
  displayItems: DisplayItem[];
  onAddDisplay?: (d: DisplayItem) => void;
}) {
  const k = ko.monitor;
  const [click, setClick] = useState<ConditionClick | null>(null);
  const resp = s.response;
  const interactive = s.kind === "http" && resp != null && onAddCondition !== undefined;
  const blockedReason = conditionCount >= MAX_CONDITIONS ? k.condMax : undefined;
  const choice = (c: ConditionClick, close: () => void) => (
    <AddChoice
      item={displayItemOf(s.step_id, c)}
      existing={displayItems}
      onAddDisplay={onAddDisplay}
      startAtCondition={c.kind === "body_text"}
      secretName={
        c.kind === "header"
          ? isSecretName(c.name)
          : c.kind === "body" && c.key !== null && isSecretName(c.key)
      }
      close={close}
      confirmRow={(done) => confirmRow(c, done)}
    />
  );
  const confirmRow = (c: ConditionClick, close: () => void) => {
    const { condition, hint } = defaultCondition(s.step_id, c);
    return (
      <ConditionRow
        initial={condition}
        mode="create"
        hint={hint}
        blockedReason={blockedReason}
        onSubmit={(next) => {
          onAddCondition?.(next);
          close();
        }}
        onCancel={close}
      />
    );
  };
  // BodyBlock hands the raw single-layer parse to `render`; the tree uses the unwrapped one.
  const parsedBody =
    interactive && resp.body !== "" && !resp.body_truncated ? parseBodyJson(resp.body) : null;
  const treeBody = parsedBody !== null;

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
          {click !== null && (
            <div key={JSON.stringify(click)}>{choice(click, () => setClick(null))}</div>
          )}
        </div>
      )}
      {resp && resp.body !== "" && (
        <div className="mt-2">
          <BodyBlock
            body={resp.body}
            truncated={resp.body_truncated}
            label={treeBody ? k.previewBodyClickHint : k.previewBody}
            heading={
              <>
                {treeBody ? k.previewBodyClickHint : k.previewBody}
                {parsedBody !== null && parsedBody.unwrapped >= 1 && (
                  <span className="ml-2 font-normal text-slate-600">{k.previewUnwrapped}</span>
                )}
              </>
            }
            belowHeading={
              interactive &&
              !treeBody &&
              !resp.body_truncated && (
                <div className="mb-1">
                  <button
                    type="button"
                    onClick={() => setClick({ kind: "body_text" })}
                    className={addButtonCls}
                  >
                    {k.condAddBodyText}
                  </button>
                </div>
              )
            }
            tree={
              treeBody
                ? {
                    openLabel: k.previewOpenFullCondition,
                    render: () => (
                      <JsonValueTree
                        value={parsedBody.value}
                        actionLabel={k.condAdd}
                        actionAriaLabel={(l) =>
                          k.condAddAria(targetLabel({ source: "body", path: l.path }))
                        }
                        renderConfirm={(l, close) =>
                          choice(
                            {
                              kind: "body",
                              path: l.path,
                              value: l.value,
                              key: lastKeyOf(l.segments),
                            },
                            close,
                          )
                        }
                      />
                    ),
                  }
                : undefined
            }
          />
        </div>
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
  displayItems = [],
  onAddDisplay,
  onlyStepId,
}: {
  preview: Preview;
  stepNames: Record<string, string>;
  onAddCondition?: (c: Condition) => void;
  conditionCount?: number;
  displayItems?: DisplayItem[];
  onAddDisplay?: (d: DisplayItem) => void;
  /** A step panel: only this step's row offers condition/display add buttons. */
  onlyStepId?: string;
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
          {trace.steps.map((s, i) => {
            const addable = onlyStepId === undefined || s.step_id === onlyStepId;
            return (
              <StepRow
                key={`${s.step_id}-${i}`}
                step={s}
                name={stepNames[s.step_id] ?? s.step_id}
                onAddCondition={addable ? onAddCondition : undefined}
                conditionCount={conditionCount}
                displayItems={displayItems}
                onAddDisplay={addable ? onAddDisplay : undefined}
              />
            );
          })}
        </ol>
      )}
    </div>
  );
}
