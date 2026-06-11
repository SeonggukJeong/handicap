import { useEffect, useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  useAbortRun,
  useCreatePreset,
  useCreateRun,
  useRun,
  useRunMetrics,
  useRunReport,
  useScenario,
} from "../api/hooks";
import { envValueToRecord, normalizeProfile, profileDurationSeconds } from "../api/runPrefill";
import { Breadcrumb } from "../components/Breadcrumb";
import { StatusBadge } from "../components/StatusBadge";
import { VerdictBadge } from "../components/VerdictBadge";
import { ReportView } from "../components/report/ReportView";
import type { RunStatus } from "../api/schemas";
import { ko } from "../i18n/ko";
import { markReportViewed } from "../onboarding/state";
import { parseScenarioDoc } from "../scenario/yamlDoc";
import { flattenHttpSteps } from "../scenario/model";
import { resolveForDisplay } from "../scenario/template";

const TERMINAL: ReadonlyArray<RunStatus> = ["completed", "failed", "aborted"];

type StepMeta = { name: string; method: string; url: string };

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const run = useRun(id);
  const abort = useAbortRun(id ?? "");
  const createRun = useCreateRun();
  const createPreset = useCreatePreset(run.data?.scenario_id ?? "");
  const terminal = run.data ? TERMINAL.includes(run.data.status) : false;
  const metrics = useRunMetrics(id, terminal);
  const report = useRunReport(id, terminal);
  const scenario = useScenario(run.data?.scenario_id);

  // U2 온보딩 ③: 종료된 run의 리포트가 실제 화면에 렌더된 시점 기록
  useEffect(() => {
    if (terminal && report.data) markReportViewed();
  }, [terminal, report.data]);

  const stepOrder = useMemo<Array<{ id: string } & StepMeta>>(() => {
    const yaml = scenario.data?.yaml;
    if (!yaml) return [];
    const parsed = parseScenarioDoc(yaml);
    if (!("model" in parsed)) return [];
    return flattenHttpSteps(parsed.model.steps).map((s) => ({
      id: s.id,
      name: s.name,
      method: s.request.method,
      url: s.request.url,
    }));
  }, [scenario.data?.yaml]);

  const stepMap = useMemo(() => {
    const m = new Map<string, StepMeta>();
    for (const s of stepOrder) m.set(s.id, s);
    return m;
  }, [stepOrder]);

  const stepTotals = useMemo(() => {
    const m = new Map<string, { count: number; errors: number }>();
    for (const w of metrics.data?.windows ?? []) {
      const cur = m.get(w.step_id) ?? { count: 0, errors: 0 };
      m.set(w.step_id, {
        count: cur.count + w.count,
        errors: cur.errors + w.error_count,
      });
    }
    return m;
  }, [metrics.data]);

  if (run.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (run.error) return <p className="text-red-600">{(run.error as Error).message}</p>;
  if (!run.data) return <p className="text-slate-500">Not found.</p>;

  const r = run.data;
  const envMap: Record<string, string> = {};
  if (r.env && typeof r.env === "object" && !Array.isArray(r.env)) {
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof v === "string") envMap[k] = v;
    }
  }
  const totalCount = metrics.data?.windows.reduce((acc, w) => acc + w.count, 0) ?? 0;
  const totalErrors = metrics.data?.windows.reduce((acc, w) => acc + w.error_count, 0) ?? 0;
  // Curve runs (S-D) store duration_seconds: 0; the real length is the stage sum.
  const durationSeconds = profileDurationSeconds(r.profile);
  const rps = durationSeconds > 0 ? Math.round((totalCount / durationSeconds) * 10) / 10 : 0;

  function saveAsPreset() {
    const name = window.prompt("프리셋 이름")?.trim();
    if (!name) return;
    createPreset.mutate({
      name,
      profile: normalizeProfile(r.profile),
      env: envValueToRecord(r.env),
    });
  }

  return (
    <div>
      <Breadcrumb
        items={[
          { label: ko.nav.scenarios, to: "/" },
          {
            label: scenario.data?.name ?? r.scenario_id.slice(0, 8),
            to: `/scenarios/${r.scenario_id}`,
          },
          { label: ko.breadcrumb.runs, to: `/scenarios/${r.scenario_id}/runs` },
          { label: `#${r.id.slice(0, 8)}` },
        ]}
      />
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold flex items-center gap-3">
          Run <span className="font-mono text-base text-slate-600">{r.id.slice(0, 8)}</span>
          <StatusBadge status={r.status} />
          <VerdictBadge verdict={report.data?.verdict} />
        </h2>
        <div className="flex items-center gap-2">
          {r.status === "running" && (
            <button
              type="button"
              onClick={() => abort.mutate()}
              disabled={abort.isPending}
              className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
            >
              {abort.isPending ? "Aborting…" : "Abort"}
            </button>
          )}
          {terminal && (
            <>
              <button
                type="button"
                onClick={() =>
                  createRun.mutate(
                    {
                      scenarioId: r.scenario_id,
                      profile: normalizeProfile(r.profile),
                      env: envValueToRecord(r.env),
                    },
                    { onSuccess: (created) => navigate(`/runs/${created.id}`) },
                  )
                }
                disabled={createRun.isPending}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100 disabled:opacity-50"
              >
                {createRun.isPending ? "Starting…" : "동일 설정 즉시 재실행"}
              </button>
              <Link
                to={`/scenarios/${r.scenario_id}/runs?retry=${r.id}`}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
              >
                다시 실행
              </Link>
              <button
                type="button"
                onClick={saveAsPreset}
                disabled={createPreset.isPending}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100 disabled:opacity-50"
              >
                {createPreset.isPending ? "저장 중…" : "프리셋으로 저장"}
              </button>
            </>
          )}
        </div>
      </div>

      {createRun.error && (
        <div
          role="alert"
          className="mb-4 p-3 border border-red-200 bg-red-50 text-sm text-red-800 rounded"
        >
          재실행 실패: {(createRun.error as Error).message}
        </div>
      )}
      {createPreset.error && (
        <div
          role="alert"
          className="mb-4 p-3 border border-red-200 bg-red-50 text-sm text-red-800 rounded"
        >
          프리셋 저장 실패: {(createPreset.error as Error).message}
        </div>
      )}

      <div className="grid grid-cols-4 gap-4 mb-6 text-sm">
        <Card label="VUs">{r.profile.vus}</Card>
        <Card label="Duration">{durationSeconds}s</Card>
        <Card label="Total requests">{totalCount}</Card>
        <Card label="Errors">{totalErrors}</Card>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
        <Card label="Avg RPS">{rps}</Card>
        <Card label="Created">{new Date(r.created_at).toLocaleString()}</Card>
      </div>

      {r.status === "failed" && typeof r.message === "string" && r.message.length > 0 && (
        <div
          role="alert"
          className="mb-4 p-3 border border-red-200 bg-red-50 text-sm text-red-800 rounded"
        >
          <span className="font-semibold">실패 사유:</span> {r.message}
        </div>
      )}

      {terminal && report.data ? (
        <ReportView report={report.data} profile={normalizeProfile(r.profile)} />
      ) : (
        <>
          {terminal && report.error && (
            <div
              role="alert"
              className="mb-4 p-3 border border-red-200 bg-red-50 text-sm text-red-800 rounded"
            >
              Report 로드 실패: {(report.error as Error).message}
            </div>
          )}
          {terminal && report.isLoading && (
            <div
              role="status"
              className="mb-4 p-3 border border-slate-200 bg-slate-50 text-sm text-slate-600 rounded"
            >
              리포트 생성 중…
            </div>
          )}
          <EnvBlock env={r.env} />

          <section aria-label="Profile" className="mb-6 text-sm">
            <h3 className="text-lg font-semibold mb-2">Profile</h3>
            <ul className="font-mono text-slate-700">
              <li>vus = {r.profile.vus}</li>
              <li>duration = {r.profile.duration_seconds}s</li>
              <li>ramp_up = {r.profile.ramp_up_seconds ?? 0}s</li>
            </ul>
          </section>

          {stepOrder.length > 0 && (
            <section aria-label="Steps" className="mb-6">
              <h3 className="text-lg font-semibold mb-2">Steps</h3>
              <table className="min-w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-600">
                  <tr>
                    <th className="py-2 pr-4 font-medium">#</th>
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Method</th>
                    <th className="py-2 pr-4 font-medium">URL</th>
                    <th className="py-2 pr-4 font-medium">Requests</th>
                    <th className="py-2 pr-4 font-medium">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {stepOrder.map((s, idx) => {
                    const totals = stepTotals.get(s.id);
                    const resolved = resolveForDisplay(s.url, envMap);
                    return (
                      <tr key={s.id} className="border-b border-slate-100">
                        <td className="py-2 pr-4 text-slate-500">{idx + 1}</td>
                        <td className="py-2 pr-4 font-medium">{s.name}</td>
                        <td className="py-2 pr-4 font-mono text-xs">{s.method}</td>
                        <td className="py-2 pr-4 font-mono text-xs break-all">
                          <div>{resolved}</div>
                          {resolved !== s.url && (
                            <div className="text-slate-500 text-[10px]">template: {s.url}</div>
                          )}
                        </td>
                        <td className="py-2 pr-4">{totals?.count ?? 0}</td>
                        <td className="py-2 pr-4">{totals?.errors ?? 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          <h3 className="text-lg font-semibold mb-2">Metric windows</h3>
          {!metrics.data || metrics.data.windows.length === 0 ? (
            <p className="text-slate-500 text-sm">
              {terminal ? "No metrics recorded." : "Waiting for first batch…"}
            </p>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-600">
                <tr>
                  <th className="py-2 pr-4 font-medium">Second</th>
                  <th className="py-2 pr-4 font-medium">Step</th>
                  <th className="py-2 pr-4 font-medium">Count</th>
                  <th className="py-2 pr-4 font-medium">Errors</th>
                  <th className="py-2 pr-4 font-medium">Status codes</th>
                </tr>
              </thead>
              <tbody>
                {metrics.data.windows.map((w) => {
                  const meta = stepMap.get(w.step_id);
                  return (
                    <tr key={`${w.ts_second}-${w.step_id}`} className="border-b border-slate-100">
                      <td className="py-2 pr-4 font-mono">{w.ts_second}</td>
                      <td className="py-2 pr-4">
                        {meta ? (
                          <span>
                            <span className="font-medium">{meta.name}</span>{" "}
                            <span className="font-mono text-xs text-slate-500">
                              {meta.method} {resolveForDisplay(meta.url, envMap)}
                            </span>
                          </span>
                        ) : (
                          <span className="font-mono text-xs">{w.step_id}</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">{w.count}</td>
                      <td className="py-2 pr-4">{w.error_count}</td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {Object.entries(w.status_counts)
                          .map(([s, c]) => `${s}:${c}`)
                          .join(" ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-slate-200 rounded-md p-3 bg-white">
      <div className="text-slate-500 text-xs">{label}</div>
      <div className="text-lg font-semibold">{children}</div>
    </div>
  );
}

function EnvBlock({ env }: { env: unknown }) {
  const entries =
    env && typeof env === "object" && !Array.isArray(env)
      ? Object.entries(env as Record<string, unknown>)
      : [];
  return (
    <section aria-label="Env" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">Env</h3>
      {entries.length === 0 ? (
        <p className="text-slate-500 text-sm italic">No env vars were sent.</p>
      ) : (
        <ul className="text-sm font-mono">
          {entries.map(([k, v]) => (
            <li key={k} className="py-0.5">
              <span className="text-slate-600">{k}</span>
              <span className="text-slate-400"> = </span>
              <span>{typeof v === "string" ? v : JSON.stringify(v)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
