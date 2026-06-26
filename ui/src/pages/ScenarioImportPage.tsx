import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateEnvironment } from "../api/hooks";
import { Breadcrumb } from "../components/Breadcrumb";
import { Button } from "../components/Button";
import { ko } from "../i18n/ko";
import {
  type Har,
  type PreviewEntry,
  distinctHosts,
  duplicateIndices,
  entryHost,
  isStaticAsset,
} from "../import/filters";
import { type HeaderMode, harToScenarioYaml, inferName, parseHar } from "../import/harToScenario";
import {
  buildEnvInput,
  defaultHostVars,
  hostsByRequestCount,
  validateEnv,
} from "../import/hostEnv";

// jsdom의 File에는 Blob.text()가 없어 `await file.text()`가 throw한다(브라우저엔 있음).
// FileReader는 jsdom·브라우저 양쪽에서 동작 — 이 read가 기능 전체의 load-bearing I/O.
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsText(file);
  });
}

export function ScenarioImportPage() {
  const navigate = useNavigate();
  const [har, setHar] = useState<Har | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [headerMode, setHeaderMode] = useState<HeaderMode>("all");
  const [statusAssert, setStatusAssert] = useState(false);
  const [excludeStatic, setExcludeStatic] = useState(true);
  const [excludedHosts, setExcludedHosts] = useState<ReadonlySet<string>>(new Set());
  const [excludedIndices, setExcludedIndices] = useState<ReadonlySet<number>>(new Set());
  const [hostVarsEnabled, setHostVarsEnabled] = useState(false);
  const [hostVarOverrides, setHostVarOverrides] = useState<Record<string, string>>({});
  const [envName, setEnvName] = useState("");
  const createEnv = useCreateEnvironment();

  const hosts = useMemo(() => (har ? distinctHosts(har.log.entries) : []), [har]);
  const includedHosts = useMemo<ReadonlySet<string> | null>(
    () => (excludedHosts.size === 0 ? null : new Set(hosts.filter((h) => !excludedHosts.has(h)))),
    [hosts, excludedHosts],
  );

  // 미리보기 목록: static/host 필터 적용 후(요청별 체크박스 대상). 원본 인덱스 유지.
  const previewEntries = useMemo<PreviewEntry[]>(() => {
    if (!har) return [];
    return har.log.entries
      .map((e, index) => ({ e, index }))
      .filter(({ e }) => !(excludeStatic && isStaticAsset(e)))
      .filter(({ e }) => {
        const h = entryHost(e);
        return h === null || !excludedHosts.has(h);
      })
      .map(({ e, index }) => ({ url: e.request.url, method: e.request.method, index }));
  }, [har, excludeStatic, excludedHosts]);

  const dupSet = useMemo(() => duplicateIndices(previewEntries), [previewEntries]);
  const selectedCount = useMemo(
    () => previewEntries.filter((p) => !excludedIndices.has(p.index)).length,
    [previewEntries, excludedIndices],
  );

  const selectAll = () => setExcludedIndices(new Set());
  const deselectAll = () => setExcludedIndices(new Set(previewEntries.map((p) => p.index)));
  const dedup = () =>
    setExcludedIndices((prev) => {
      const next = new Set(prev);
      for (const i of duplicateIndices(previewEntries)) next.add(i);
      return next;
    });

  // F4: These memos depend on previewEntries — must be AFTER previewEntries declaration,
  // BEFORE yaml memo (useMemo callbacks run synchronously at the call site).
  const hostsOrdered = useMemo(() => hostsByRequestCount(previewEntries), [previewEntries]);
  const effectiveHostVars = useMemo(() => {
    const defaults = defaultHostVars(hostsOrdered);
    const out: Record<string, string> = {};
    for (const h of hostsOrdered) out[h] = hostVarOverrides[h] ?? defaults[h];
    return out;
  }, [hostsOrdered, hostVarOverrides]);
  const envValidation = useMemo(
    () => validateEnv(effectiveHostVars, envName),
    [effectiveHostVars, envName],
  );

  const yaml = useMemo(() => {
    if (!har) return "";
    return harToScenarioYaml(har, {
      headerMode,
      statusAssert,
      excludeStatic,
      includedHosts,
      excludedIndices,
      name,
      hostVars: hostVarsEnabled ? effectiveHostVars : undefined,
    });
  }, [
    har,
    headerMode,
    statusAssert,
    excludeStatic,
    includedHosts,
    excludedIndices,
    name,
    hostVarsEnabled,
    effectiveHostVars,
  ]);

  const onPick = async (file: File | null) => {
    if (!file) return;
    try {
      const parsed = parseHar(await readText(file));
      setHar(parsed);
      setParseError(null);
      setName(inferName(parsed));
      setExcludedHosts(new Set());
      setExcludedIndices(new Set());
      setHostVarsEnabled(false);
      setHostVarOverrides({});
      setEnvName(inferName(parsed));
    } catch (e) {
      setHar(null);
      setParseError((e as Error).message);
    }
  };

  const toggleHost = (host: string, checked: boolean) => {
    setExcludedHosts((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(host);
      else next.add(host);
      return next;
    });
  };
  const toggleIndex = (index: number, checked: boolean) => {
    setExcludedIndices((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const registerEnv = () => {
    createEnv.mutate(buildEnvInput(effectiveHostVars, previewEntries, envName));
  };

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: ko.nav.scenarios, to: "/" }, { label: ko.import.title }]} />
      <h2 className="text-xl font-semibold">{ko.import.title}</h2>
      <p className="text-sm text-slate-500">{ko.import.intro}</p>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-700">{ko.import.chooseFile}</span>
        <input
          type="file"
          accept=".har,application/json"
          aria-label={ko.import.chooseFile}
          onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
        />
      </label>

      {parseError && (
        <p role="alert" className="text-sm text-red-600">
          {ko.import.parseError}: {parseError}
        </p>
      )}

      {har && (
        <>
          <fieldset className="flex flex-col gap-3 rounded-md border border-slate-200 p-4">
            <legend className="px-1 font-medium text-slate-700">{ko.import.options}</legend>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">{ko.import.nameLabel}</span>
              <input
                aria-label={ko.import.nameLabel}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={ko.import.excludeStatic}
                checked={excludeStatic}
                onChange={(e) => setExcludeStatic(e.target.checked)}
              />
              {ko.import.excludeStatic}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">{ko.import.headerMode}</span>
              <select
                aria-label={ko.import.headerMode}
                value={headerMode}
                onChange={(e) => setHeaderMode(e.target.value as HeaderMode)}
                className="rounded border border-slate-300 px-2 py-1"
              >
                <option value="all">{ko.import.headerModeAll}</option>
                <option value="strip-volatile">{ko.import.headerModeStrip}</option>
                <option value="semantic-only">{ko.import.headerModeSemantic}</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={ko.import.statusAssert}
                checked={statusAssert}
                onChange={(e) => setStatusAssert(e.target.checked)}
              />
              {ko.import.statusAssert}
            </label>
          </fieldset>

          {hosts.length > 1 && (
            <fieldset className="flex flex-col gap-1 rounded-md border border-slate-200 p-4 text-sm">
              <legend className="font-medium text-slate-700">{ko.import.hosts}</legend>
              {hosts.map((h) => (
                <label key={h} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={h}
                    checked={!excludedHosts.has(h)}
                    onChange={(e) => toggleHost(h, e.target.checked)}
                  />
                  {h}
                </label>
              ))}
            </fieldset>
          )}

          <fieldset className="flex flex-col gap-1 rounded-md border border-slate-200 p-4 text-sm">
            <legend className="font-medium text-slate-700">{ko.import.requests}</legend>
            {previewEntries.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-600">
                  {ko.import.selectionSummary(selectedCount, previewEntries.length, dupSet.size)}
                </span>
                <span className="flex-1" />
                <Button variant="secondary" onClick={selectAll}>
                  {ko.import.selectAll}
                </Button>
                <Button variant="secondary" onClick={deselectAll}>
                  {ko.import.deselectAll}
                </Button>
                <Button variant="secondary" onClick={dedup} disabled={dupSet.size === 0}>
                  {ko.import.dedup}
                </Button>
              </div>
            )}
            {previewEntries.length === 0 ? (
              <p className="text-slate-400">{ko.import.noRequests}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {previewEntries.map((p) => (
                  <li key={p.index}>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label={`${p.method} ${p.url}`}
                        checked={!excludedIndices.has(p.index)}
                        onChange={(e) => toggleIndex(p.index, e.target.checked)}
                      />
                      <span className="truncate">
                        {p.method} {p.url}
                      </span>
                      {dupSet.has(p.index) && (
                        <span className="shrink-0 rounded bg-amber-100 px-1 text-xs text-amber-700">
                          {ko.import.dupBadge}
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          {previewEntries.length > 0 && (
            <fieldset className="flex flex-col gap-2 rounded-md border border-slate-200 p-4 text-sm">
              <legend className="font-medium text-slate-700">{ko.import.hostToEnv}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={ko.import.hostToEnv}
                  checked={hostVarsEnabled}
                  onChange={(e) => setHostVarsEnabled(e.target.checked)}
                />
                {ko.import.hostToEnvHint}
              </label>
              {hostVarsEnabled && (
                <>
                  {hostsOrdered.map((h) => (
                    <label key={h} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600">
                        {h}
                      </span>
                      <span aria-hidden="true">→</span>
                      <input
                        aria-label={ko.import.varNameLabel(h)}
                        value={effectiveHostVars[h]}
                        onChange={(e) =>
                          setHostVarOverrides((p) => ({ ...p, [h]: e.target.value }))
                        }
                        className="w-40 rounded border border-slate-300 px-2 py-1 font-mono"
                      />
                    </label>
                  ))}
                  {envValidation.emptyHosts.length > 0 && (
                    <p className="text-xs text-red-600">{ko.import.varNameEmpty}</p>
                  )}
                  {envValidation.invalidHosts.length > 0 && (
                    <p className="text-xs text-red-600">{ko.import.varNameInvalid}</p>
                  )}
                  {envValidation.dupNames.length > 0 && (
                    <p className="text-xs text-red-600">{ko.import.varNameDup}</p>
                  )}
                  {envValidation.reservedHosts.map((h) => (
                    <p key={h} className="text-xs text-amber-700">
                      {ko.import.varNameReserved(effectiveHostVars[h])}
                    </p>
                  ))}
                  <label className="flex flex-col gap-1">
                    <span className="font-medium text-slate-700">{ko.import.envNameLabel}</span>
                    <input
                      aria-label={ko.import.envNameLabel}
                      value={envName}
                      onChange={(e) => setEnvName(e.target.value)}
                      className="rounded border border-slate-300 px-2 py-1"
                    />
                  </label>
                  {envValidation.emptyEnvName && (
                    <p className="text-xs text-red-600">{ko.import.envNameEmpty}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={registerEnv}
                      disabled={!envValidation.ok || createEnv.isPending}
                    >
                      {createEnv.isPending ? ko.common.loading : ko.import.registerEnv}
                    </Button>
                    {createEnv.isSuccess && (
                      <span className="text-xs text-green-700">
                        {ko.import.envRegistered(createEnv.data.name)}
                      </span>
                    )}
                  </div>
                  {createEnv.isError && (
                    <p role="alert" className="text-xs text-red-600">
                      {(createEnv.error as Error).message}
                    </p>
                  )}
                </>
              )}
            </fieldset>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{ko.import.preview}</span>
            <textarea
              aria-label={ko.import.preview}
              readOnly
              value={yaml}
              rows={16}
              className="rounded border border-slate-300 p-2 font-mono text-xs"
            />
          </label>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(yaml)}>
              {ko.import.copy}
            </Button>
            <Button onClick={() => navigate("/scenarios/new", { state: { importedYaml: yaml } })}>
              {ko.import.toEditor}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
