/**
 * InsertTemplateModal — 저장된 스텝 템플릿 목록에서 선택해 현재 시나리오에 삽입.
 * 2-phase 단일 Modal: 목록 → (토큰 있으면) 파라미터화 폼 → 치환 후 삽입.
 * 부모가 `{open && <InsertTemplateModal onClose={...} />}` 로 조건부 마운트.
 */
import { useMemo, useState } from "react";
import { useDeleteStepTemplate, useStepTemplates } from "../../api/hooks";
import { getStepTemplate } from "../../api/stepTemplates";
import { Button } from "../Button";
import { Modal } from "../Modal";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { newStepId } from "../../scenario/ulid";
import { prepareTemplateInsertion } from "../../scenario/yamlDoc";
import { scanFlowVars, scanEnvVars } from "../../scenario/scanVars";
import {
  scanTemplateTokens,
  applyTokenSubstitutions,
  type Substitution,
  type SubMap,
} from "../../scenario/templateParams";

interface Props {
  onClose: () => void;
}

type Pending = { id: string; stepsYaml: string; flow: string[]; env: string[] };

// flow: 공백/중괄호 금지; env: 추가로 콜론 금지(${} 안전).
function badRename(ns: "flow" | "env", to: string): boolean {
  if (to.trim() === "") return true;
  if (/[{}\s]/.test(to)) return true;
  if (ns === "env" && to.includes(":")) return true;
  return false;
}

export function InsertTemplateModal({ onClose }: Props) {
  const list = useStepTemplates();
  const del = useDeleteStepTemplate();
  const insertTemplateSteps = useScenarioEditor((s) => s.insertTemplateSteps);
  const select = useScenarioEditor((s) => s.select);
  const model = useScenarioEditor((s) => s.model);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  // per-token form state, keyed by `${ns}:${name}`.
  const [subs, setSubs] = useState<Record<string, Substitution>>({});

  const templates = list.data ?? [];

  // datalist 힌트: 대상 시나리오의 기존 변수명(best-effort, model null이면 빈 목록).
  const flowHints = useMemo(
    () => (model ? [...scanFlowVars(model), ...Object.keys(model.variables)] : []),
    [model],
  );
  const envHints = useMemo(() => (model ? [...scanEnvVars(model)] : []), [model]);

  const doInsert = (stepsYaml: string) => {
    const prep = prepareTemplateInsertion(stepsYaml, newStepId);
    if (!prep.ok) {
      setError(`${ko.stepTemplates.incompatible}: ${prep.error}`);
      return false;
    }
    const firstId = insertTemplateSteps({ preparedYaml: prep.preparedYaml, firstId: prep.firstId });
    select(firstId);
    return true;
  };

  const handleInsert = async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      const tpl = await getStepTemplate(id);
      const { flow, env } = scanTemplateTokens(tpl.steps_yaml);
      if (flow.length === 0 && env.length === 0) {
        if (doInsert(tpl.steps_yaml)) onClose(); // R10: no-token → direct insert
        return;
      }
      setSubs({});
      setPending({ id, stepsYaml: tpl.steps_yaml, flow, env });
    } catch (e) {
      setError((e as Error).message);
      void list.refetch();
    } finally {
      setBusy(false);
    }
  };

  const key = (ns: "flow" | "env", name: string) => `${ns}:${name}`;
  const subOf = (ns: "flow" | "env", name: string): Substitution =>
    subs[key(ns, name)] ?? { kind: "keep" };
  const setSub = (ns: "flow" | "env", name: string, s: Substitution) =>
    setSubs((prev) => ({ ...prev, [key(ns, name)]: s }));

  const hasBadRename =
    pending !== null &&
    (["flow", "env"] as const).some((ns) =>
      (ns === "flow" ? pending.flow : pending.env).some((name) => {
        const s = subOf(ns, name);
        return s.kind === "rename" && badRename(ns, s.to);
      }),
    );

  const buildSubMap = (): SubMap => {
    const out: SubMap = { flow: {}, env: {} };
    for (const [k, s] of Object.entries(subs)) {
      const [ns, ...rest] = k.split(":");
      const name = rest.join(":");
      if (ns === "flow") out.flow[name] = s;
      else if (ns === "env") out.env[name] = s;
    }
    return out;
  };

  const handleConfirmParams = () => {
    if (!pending || hasBadRename) return;
    setError(null);
    const substituted = applyTokenSubstitutions(pending.stepsYaml, buildSubMap());
    if (doInsert(substituted)) onClose();
  };

  const handleDelete = (id: string, name: string) => {
    if (!window.confirm(ko.stepTemplates.deleteConfirm(name))) return;
    del.mutate(id);
  };

  return (
    <Modal
      open
      title={pending ? ko.stepTemplates.paramTitle : ko.stepTemplates.insertTitle}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        {pending ? (
          <ParamForm
            pending={pending}
            subOf={subOf}
            setSub={setSub}
            flowHints={flowHints}
            envHints={envHints}
            badRename={badRename}
          />
        ) : (
          <TemplateList
            list={list}
            templates={templates}
            del={del}
            busy={busy}
            onInsert={handleInsert}
            onDelete={handleDelete}
          />
        )}

        <div className="flex justify-end gap-2">
          {pending ? (
            <>
              <Button variant="secondary" onClick={() => setPending(null)}>
                {ko.stepTemplates.back}
              </Button>
              <Button onClick={handleConfirmParams} disabled={hasBadRename}>
                {ko.stepTemplates.confirmInsert}
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              {ko.stepTemplates.cancel}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── TemplateList: list/delete JSX moved verbatim from the old component body ──

type ListProps = {
  list: ReturnType<typeof useStepTemplates>;
  templates: NonNullable<ReturnType<typeof useStepTemplates>["data"]>;
  del: ReturnType<typeof useDeleteStepTemplate>;
  busy: boolean;
  onInsert: (id: string) => void;
  onDelete: (id: string, name: string) => void;
};

function TemplateList({ list, templates, del, busy, onInsert, onDelete }: ListProps) {
  return (
    <>
      {del.error && (
        <p role="alert" className="text-sm text-red-600">
          {(del.error as Error).message}
        </p>
      )}

      {list.isLoading && <p className="text-sm text-slate-500">Loading…</p>}

      {list.error && (
        <p role="alert" className="text-sm text-red-600">
          {(list.error as Error).message}
        </p>
      )}

      {!list.isLoading && !list.error && templates.length === 0 && (
        <p className="text-sm text-slate-500">{ko.stepTemplates.empty}</p>
      )}

      {templates.length > 0 && (
        <ul className="flex flex-col gap-2">
          {templates.map((tpl) => (
            <li
              key={tpl.id}
              className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{tpl.name}</p>
                <p className="truncate text-xs text-slate-500">
                  {ko.stepTemplates.stepCount(tpl.step_count)}
                  {tpl.description ? ` · ${tpl.description}` : ""}
                  {" · "}
                  {new Date(tpl.updated_at).toLocaleString()}
                </p>
              </div>
              <div className="ml-2 flex shrink-0 gap-2">
                <Button onClick={() => void onInsert(tpl.id)} disabled={busy}>
                  {ko.stepTemplates.insertAction}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => onDelete(tpl.id, tpl.name)}
                  disabled={del.isPending}
                >
                  {ko.stepTemplates.deleteAction}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── ParamForm: per-token keep/rename/literal rows ──

function ParamForm({
  pending,
  subOf,
  setSub,
  flowHints,
  envHints,
  badRename,
}: {
  pending: Pending;
  subOf: (ns: "flow" | "env", name: string) => Substitution;
  setSub: (ns: "flow" | "env", name: string, s: Substitution) => void;
  flowHints: string[];
  envHints: string[];
  badRename: (ns: "flow" | "env", to: string) => boolean;
}) {
  const section = (ns: "flow" | "env", names: string[], title: string, hints: string[]) =>
    names.length === 0 ? null : (
      <fieldset className="min-w-0">
        <legend className="mb-2 text-sm font-medium">{title}</legend>
        <ul className="flex flex-col gap-3">
          {names.map((name) => {
            const s = subOf(ns, name);
            const listId = `tplvar-${ns}-${name}`;
            return (
              <li key={`${ns}:${name}`} className="flex flex-col gap-1">
                <code className="text-sm">{ns === "flow" ? `{{${name}}}` : `\${${name}}`}</code>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={s.kind === "keep"}
                      onChange={() => setSub(ns, name, { kind: "keep" })}
                    />
                    {ko.stepTemplates.optKeep}
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={s.kind === "rename"}
                      onChange={() => setSub(ns, name, { kind: "rename", to: "" })}
                    />
                    {ko.stepTemplates.optRename}
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={s.kind === "literal"}
                      onChange={() => setSub(ns, name, { kind: "literal", value: "" })}
                    />
                    {ko.stepTemplates.optLiteral}
                  </label>
                </div>
                {s.kind === "rename" && (
                  <>
                    <input
                      aria-label={`rename ${name}`}
                      list={listId}
                      className="w-56 rounded border border-slate-300 px-2 py-1 text-sm font-mono"
                      placeholder={ko.stepTemplates.renamePlaceholder}
                      value={s.to}
                      onChange={(e) => setSub(ns, name, { kind: "rename", to: e.target.value })}
                    />
                    <datalist id={listId}>
                      {hints.map((h) => (
                        <option key={h} value={h} />
                      ))}
                    </datalist>
                    {badRename(ns, s.to) && (
                      <p role="alert" className="text-xs text-red-600">
                        {ko.stepTemplates.badRename}
                      </p>
                    )}
                  </>
                )}
                {s.kind === "literal" && (
                  <input
                    aria-label={`literal ${name}`}
                    className="w-56 rounded border border-slate-300 px-2 py-1 text-sm"
                    placeholder={ko.stepTemplates.literalPlaceholder}
                    value={s.value}
                    onChange={(e) => setSub(ns, name, { kind: "literal", value: e.target.value })}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>
    );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-600">{ko.stepTemplates.paramIntro}</p>
      {section("flow", pending.flow, ko.stepTemplates.flowSection, flowHints)}
      {section("env", pending.env, ko.stepTemplates.envSection, envHints)}
    </div>
  );
}
