import { useState } from "react";
import { useSettings, usePutSetting, useResetSetting, usePoolWorkers } from "../api/hooks";
import { Button } from "../components/Button";
import { HelpTip } from "../components/HelpTip";
import { ko } from "../i18n/ko";
import type { Setting } from "../api/settings";
import { STARTUP_STALL_MS, MIDRUN_STALL_MS } from "../api/runStall";
import { scopeOf, ENV_NOTE_KEY } from "../settings/settingsEnv";

/** Split the effect string on \n and render each line as a block span (multiline HelpTip). */
const effectBlocks = (key: string) => {
  const effect = ko.opsSettings.effect[key as keyof typeof ko.opsSettings.effect];
  if (!effect) return null;
  return effect.split("\n").map((line, i) => (
    <span key={i} className="block">
      {line}
    </span>
  ));
};

/** Env-specific note for settings whose effect differs by deployment. */
const EnvNote = ({ settingKey }: { settingKey: string }) => {
  const noteKey = ENV_NOTE_KEY[settingKey];
  if (!noteKey) return null;
  return <p className="text-xs text-slate-500">{ko.opsSettings.envNote[noteKey]}</p>;
};

function invalid(s: Setting, draft: string): boolean {
  const n = Number(draft);
  return draft === "" || !Number.isInteger(n) || n < s.min || n > s.max;
}

function MutableRow({
  s,
  draft,
  rowError,
  onDraftChange,
  onSave,
  onReset,
  saving,
  resetting,
}: {
  s: Setting;
  draft: string;
  rowError: string | null;
  onDraftChange: (v: string) => void;
  onSave: () => void;
  onReset: () => void;
  saving: boolean;
  resetting: boolean;
}) {
  const isInvalid = invalid(s, draft);
  const effectKey = s.key as keyof typeof ko.opsSettings.effect;
  const hasEffect = effectKey in ko.opsSettings.effect;
  const inputId = `setting-${s.key}`;
  const rangeHintId = `setting-range-${s.key}`;
  const outOfRangeHintId = `setting-hint-${s.key}`;

  return (
    <li className="flex flex-col gap-1 py-4 border-b border-slate-100 last:border-0">
      <div className="flex items-center gap-1">
        <label htmlFor={inputId} className="text-sm font-medium text-slate-800">
          {s.label}
        </label>
        {hasEffect && <HelpTip label={`${s.label} 도움말`}>{effectBlocks(s.key)}</HelpTip>}
        {s.source === "override" && (
          <span className="ml-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">
            변경됨
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500">
        {ko.opsSettings.desc[s.key as keyof typeof ko.opsSettings.desc]}
      </p>
      <EnvNote settingKey={s.key} />
      <div className="flex items-center gap-2 mt-1">
        <input
          id={inputId}
          type="number"
          className="w-40 rounded border border-slate-300 px-2 py-1 text-sm"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          min={s.min}
          max={s.max}
          aria-invalid={isInvalid ? true : undefined}
          aria-describedby={isInvalid ? `${rangeHintId} ${outOfRangeHintId}` : rangeHintId}
        />
        <span className="text-xs text-slate-500">{s.unit}</span>
        <Button variant="primary" onClick={onSave} disabled={isInvalid || saving || resetting}>
          {saving ? "저장 중…" : ko.opsSettings.save}
        </Button>
        {s.source === "override" && (
          <Button variant="secondary" onClick={onReset} disabled={resetting || saving}>
            {ko.opsSettings.reset}
          </Button>
        )}
      </div>
      <div className="flex items-center gap-3 mt-0.5">
        <span id={rangeHintId} className="text-xs text-slate-400">
          {ko.opsSettings.defaultHint(s.default)} · {ko.opsSettings.rangeHint(s.min, s.max)}
        </span>
        {isInvalid && draft !== String(s.value) && (
          <span id={outOfRangeHintId} role="alert" className="text-xs text-red-600">
            {ko.opsSettings.outOfRange}
          </span>
        )}
      </div>
      {rowError && (
        <p role="alert" className="text-xs text-red-600 mt-0.5">
          {rowError}
        </p>
      )}
    </li>
  );
}

export function SettingsPage() {
  const { data: settings, isLoading, error } = useSettings();
  const putM = usePutSetting();
  const resetM = useResetSetting();
  const poolQ = usePoolWorkers();

  // Per-row draft state keyed by setting key; initialised on first render from server value.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Per-row mutation error state keyed by setting key.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const getDraft = (s: Setting) => (s.key in drafts ? drafts[s.key] : String(s.value));
  const setDraft = (key: string, v: string) => setDrafts((prev) => ({ ...prev, [key]: v }));
  const clearDraft = (key: string) =>
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  const setRowError = (key: string, msg: string) =>
    setRowErrors((prev) => ({ ...prev, [key]: msg }));
  const clearRowError = (key: string) =>
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const mutable = settings?.filter((s) => s.mutable) ?? [];
  // C(클라 stall advisory) 임계값 — 단일소스 = runStall.ts. /settings엔 읽기전용 표시만.
  const clientReadonly: Setting[] = [
    {
      key: "run_midrun_stall_seconds",
      label: ko.opsSettings.runMidrunStallLabel,
      group: "limits",
      value: MIDRUN_STALL_MS / 1000,
      default: MIDRUN_STALL_MS / 1000,
      min: 0,
      max: MIDRUN_STALL_MS / 1000,
      unit: "초",
      mutable: false,
      source: "readonly",
    },
    {
      key: "run_startup_stall_seconds",
      label: ko.opsSettings.runStartupStallLabel,
      group: "limits",
      value: STARTUP_STALL_MS / 1000,
      default: STARTUP_STALL_MS / 1000,
      min: 0,
      max: STARTUP_STALL_MS / 1000,
      unit: "초",
      mutable: false,
      source: "readonly",
    },
  ];
  const readonly = [...(settings?.filter((s) => !s.mutable) ?? []), ...clientReadonly];

  const groupMutable = (g: "common" | "pool") => mutable.filter((s) => scopeOf(s.key) === g);
  const groupReadonly = (g: "common" | "pool") => readonly.filter((s) => scopeOf(s.key) === g);

  const renderMutableList = (rows: Setting[]) => (
    <ul className="border border-slate-200 rounded-md bg-white px-4">
      {rows.map((s) => {
        const draft = getDraft(s);
        const isSaving = putM.isPending && putM.variables?.key === s.key;
        const isResetting = resetM.isPending && resetM.variables === s.key;
        return (
          <MutableRow
            key={s.key}
            s={s}
            draft={draft}
            rowError={rowErrors[s.key] ?? null}
            onDraftChange={(v) => setDraft(s.key, v)}
            onSave={() => {
              const n = Number(draft);
              if (!invalid(s, draft)) {
                clearRowError(s.key);
                putM.mutate(
                  { key: s.key, value: n },
                  {
                    onSuccess: () => clearDraft(s.key),
                    onError: (e: Error) => setRowError(s.key, e.message),
                  },
                );
              }
            }}
            onReset={() => {
              clearRowError(s.key);
              resetM.mutate(s.key, {
                onSuccess: () => clearDraft(s.key),
                onError: (e: Error) => setRowError(s.key, e.message),
              });
            }}
            saving={isSaving}
            resetting={isResetting}
          />
        );
      })}
    </ul>
  );

  const renderReadonlyList = (rows: Setting[]) => (
    <ul className="border border-slate-200 rounded-md bg-white px-4">
      {rows.map((s) => (
        <li
          key={s.key}
          className="flex flex-col gap-1 py-4 border-b border-slate-100 last:border-0"
        >
          <span className="text-sm font-medium text-slate-800">{s.label}</span>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm font-mono text-slate-700">
              {s.value} {s.unit}
            </span>
            <span className="text-xs text-slate-400">{ko.opsSettings.readonlyNote}</span>
          </div>
          <EnvNote settingKey={s.key} />
        </li>
      ))}
    </ul>
  );

  // 하트비트 ping/stale 적용 안내 + 2x margin 경고 (pool 전용 — pool 그룹 안에 렌더).
  const heartbeatNote = () => {
    const find = (k: string) => settings?.find((s) => s.key === k);
    const intervalRow = find("pool_heartbeat_interval_seconds");
    const staleRow = find("pool_stale_timeout_seconds");
    if (!intervalRow || !staleRow) return null;
    const num = (s: Setting) => {
      const d = s.key in drafts ? drafts[s.key] : String(s.value);
      const n = d.trim() === "" ? NaN : Number(d);
      return Number.isInteger(n) ? n : s.value;
    };
    const interval = num(intervalRow);
    const stale = num(staleRow);
    return (
      <div className="mt-3 space-y-1">
        <p className="text-xs text-slate-500">{ko.opsSettings.heartbeatApplyNote}</p>
        {stale < 2 * interval && (
          <p className="text-xs text-amber-700">{ko.opsSettings.heartbeatMarginHint}</p>
        )}
      </div>
    );
  };

  // 현재 컨트롤러 실행 모드 배너 (graceful: 쿼리 미해결/에러면 미렌더).
  const modeBanner = () => {
    if (!poolQ.isSuccess || !poolQ.data) return null;
    const active = poolQ.data.pool_mode;
    return (
      <p
        className={`mb-3 text-sm rounded px-3 py-2 border ${
          active
            ? "text-green-800 bg-green-50 border-green-200"
            : "text-slate-600 bg-slate-50 border-slate-200"
        }`}
      >
        {active ? ko.opsSettings.modeActivePool : ko.opsSettings.modeInactive}
      </p>
    );
  };

  const subHeader = (text: string) => (
    <h4 className="text-sm font-semibold text-slate-600 mb-2 mt-4 first:mt-0">{text}</h4>
  );

  const commonMutable = groupMutable("common");
  const commonReadonly = groupReadonly("common");
  const poolMutable = groupMutable("pool");
  const poolReadonly = groupReadonly("pool");

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">{ko.opsSettings.title}</h2>
      </div>

      {/* apply-note banner */}
      <p className="mb-6 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
        {ko.opsSettings.applyNote}
      </p>

      {isLoading && <p className="text-slate-500">{ko.common.loading}</p>}
      {error && (
        <p role="alert" className="text-red-600">
          불러오기 실패: {(error as Error).message}
        </p>
      )}

      {settings && (
        <>
          {/* 모든 배포 공통 */}
          {(commonMutable.length > 0 || commonReadonly.length > 0) && (
            <section aria-label={ko.opsSettings.groupCommon} className="mb-8">
              <h3 className="text-md font-semibold text-slate-700 mb-3">
                {ko.opsSettings.groupCommon}
              </h3>
              {commonMutable.length > 0 && (
                <>
                  {subHeader(ko.opsSettings.subMutable)}
                  {renderMutableList(commonMutable)}
                </>
              )}
              {commonReadonly.length > 0 && (
                <>
                  {subHeader(ko.opsSettings.subReadonly)}
                  {renderReadonlyList(commonReadonly)}
                </>
              )}
            </section>
          )}

          {/* 분산 워커 풀(LAN) 전용 */}
          {(poolMutable.length > 0 || poolReadonly.length > 0) && (
            <section aria-label={ko.opsSettings.groupPool} className="mb-8">
              <h3 className="text-md font-semibold text-slate-700 mb-1">
                {ko.opsSettings.groupPool}
              </h3>
              <p className="text-xs text-slate-500 mb-2">{ko.opsSettings.poolGroupNote}</p>
              {modeBanner()}
              {poolMutable.length > 0 && (
                <>
                  {subHeader(ko.opsSettings.subMutable)}
                  {renderMutableList(poolMutable)}
                  {heartbeatNote()}
                </>
              )}
              {poolReadonly.length > 0 && (
                <>
                  {subHeader(ko.opsSettings.subReadonly)}
                  {renderReadonlyList(poolReadonly)}
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
