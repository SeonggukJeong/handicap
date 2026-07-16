import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "./client";
import type { DatasetUploadOptions, TestRunBody } from "./client";
import { cloneName } from "../scenario/cloneName";
import { renameScenarioYaml } from "../scenario/yamlDoc";
import { createPreset, deletePreset, listPresets, updatePreset, type PresetInput } from "./presets";
import {
  createEnvironment,
  deleteEnvironment,
  getEnvironment,
  listEnvironments,
  updateEnvironment,
  type EnvironmentInput,
} from "./environments";
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  scheduleEvents,
  updateSchedule,
  type ScheduleInput,
} from "./schedules";
import {
  createStepTemplate,
  deleteStepTemplate,
  listStepTemplates,
  updateStepTemplate,
  type StepTemplateInput,
} from "./stepTemplates";
import { deleteSetting, getSettings, putSetting } from "./settings";
import { listPoolWorkers, patchPoolWorker, excludePoolWorker } from "./pool";
import type { Profile, RunStatus } from "./schemas";
import { markRunCreated } from "../onboarding/state";

export const queryKeys = {
  scenarios: () => ["scenarios"] as const,
  scenario: (id: string) => ["scenarios", id] as const,
  scenarioRuns: (id: string) => ["scenarios", id, "runs"] as const,
  run: (id: string) => ["runs", id] as const,
  runMetrics: (id: string) => ["runs", id, "metrics"] as const,
  runReport: (id: string) => ["runs", id, "report"] as const,
  datasets: () => ["datasets"] as const,
  dataset: (id: string) => ["datasets", id] as const,
  datasetRows: (id: string, offset: number) => ["datasets", id, "rows", offset] as const,
  presets: (scenarioId: string) => ["presets", scenarioId] as const,
  preset: (id: string) => ["preset", id] as const,
  environments: () => ["environments"] as const,
  environment: (id: string) => ["environments", id] as const,
  schedules: () => ["schedules"] as const,
  schedule: (id: string) => ["schedules", id] as const,
  scheduleEvents: (id: string) => ["schedules", id, "events"] as const,
  stepTemplates: () => ["step-templates"] as const,
  stepTemplate: (id: string) => ["step-templates", id] as const,
  settings: () => ["settings"] as const,
  poolWorkers: () => ["pool", "workers"] as const,
};

export function useScenarios() {
  return useQuery({ queryKey: queryKeys.scenarios(), queryFn: api.listScenarios });
}

export function useScenario(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.scenario(id) : ["scenarios", "missing"],
    queryFn: () => api.getScenario(id!),
    enabled: Boolean(id),
  });
}

export function useCreateScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (yaml: string) => api.createScenario(yaml),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.scenarios() });
    },
  });
}

export function useCloneScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      sourceYaml,
      sourceName,
      existingNames,
    }: {
      sourceYaml: string;
      sourceName: string;
      existingNames: string[];
    }) => {
      const newName = cloneName(sourceName, existingNames);
      const newYaml = renameScenarioYaml(sourceYaml, newName);
      return api.createScenario(newYaml);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.scenarios() });
    },
  });
}

export function useUpdateScenario(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ yaml, version }: { yaml: string; version: number }) =>
      api.updateScenario(id, yaml, version),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: queryKeys.scenarios() });
      qc.setQueryData(queryKeys.scenario(id), updated);
    },
  });
}

/** 목록에 running run이 있으면 5s 폴링(stall 배지 신선도 — frozen last_metric_ts 오탐 방지),
 *  없으면 정지. 임계 120s ≫ 5s라 healthy 오탐 구조적 불가. G1b 목록 배지. */
export function runsRefetchInterval(
  data: { runs: { status: RunStatus }[] } | undefined,
): number | false {
  return data?.runs.some((r) => r.status === "running") ? 5000 : false;
}

export function useScenarioRuns(scenarioId: string | undefined) {
  return useQuery({
    queryKey: scenarioId ? queryKeys.scenarioRuns(scenarioId) : ["scenarios", "missing", "runs"],
    queryFn: () => api.listRunsForScenario(scenarioId!),
    enabled: Boolean(scenarioId),
    refetchInterval: (q) => runsRefetchInterval(q.state.data),
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      scenarioId,
      profile,
      env,
      force,
    }: {
      scenarioId: string;
      profile: Profile;
      env: Record<string, string>;
      force?: boolean;
    }) => api.createRun(scenarioId, profile, env, { force }),
    onSuccess: (run) => {
      markRunCreated(); // U2 온보딩 ②: UI 경유 run 생성 성공 시 1회성 플래그
      qc.invalidateQueries({ queryKey: queryKeys.scenarioRuns(run.scenario_id) });
    },
  });
}

const TERMINAL: ReadonlyArray<RunStatus> = ["completed", "failed", "aborted"];

export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.run(id) : ["runs", "missing"],
    queryFn: () => api.getRun(id!),
    enabled: Boolean(id),
    // Poll at 1s while not terminal. Returning `false` stops polling.
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 1000;
      return TERMINAL.includes(data.status) ? false : 1000;
    },
  });
}

export function useAbortRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.abortRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.run(runId) });
    },
  });
}

export function useRunMetrics(id: string | undefined, paused: boolean) {
  return useQuery({
    queryKey: id ? queryKeys.runMetrics(id) : ["runs", "missing", "metrics"],
    queryFn: () => api.getRunMetrics(id!),
    enabled: Boolean(id),
    // Same 1s cadence while live; once paused (terminal status) refetch once and stop.
    refetchInterval: paused ? false : 1000,
  });
}

export function useRunReport(id: string | undefined, terminal: boolean) {
  return useQuery({
    queryKey: id ? queryKeys.runReport(id) : ["runs", "missing", "report"],
    queryFn: () => api.getRunReport(id!),
    enabled: terminal && Boolean(id),
    // Report is immutable after terminal — fetch once and cache forever.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

export function useReports(runIds: string[]) {
  return useQueries({
    queries: runIds.map((id) => ({
      queryKey: queryKeys.runReport(id),
      queryFn: () => api.getRunReport(id),
      staleTime: Infinity,
      refetchInterval: false as const,
    })),
  });
}

export function useDatasets() {
  return useQuery({ queryKey: queryKeys.datasets(), queryFn: api.listDatasets });
}

export function useDataset(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.dataset(id) : ["datasets", "missing"],
    queryFn: () => api.getDataset(id!),
    enabled: Boolean(id),
  });
}

/** 미리보기 페이지 크기 (spec R5 — 50 고정). */
export const DATASET_ROWS_PAGE_SIZE = 50;

export function useDatasetRows(id: string | undefined, offset: number) {
  return useQuery({
    queryKey: id ? queryKeys.datasetRows(id, offset) : ["datasets", "missing", "rows"],
    queryFn: () => api.getDatasetRows(id!, offset, DATASET_ROWS_PAGE_SIZE),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
}

export function useUploadDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, opts }: { file: File; opts?: DatasetUploadOptions }) =>
      api.uploadDataset(file, opts),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.datasets() }),
  });
}

export function useDeleteDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) => api.deleteDataset(id, force),
    onSuccess: (result) => {
      if (result.deleted) qc.invalidateQueries({ queryKey: queryKeys.datasets() });
    },
  });
}

export function useDeleteScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) => api.deleteScenario(id, force),
    onSuccess: (result) => {
      if (result.deleted) qc.invalidateQueries({ queryKey: queryKeys.scenarios() });
    },
  });
}

export function usePresets(scenarioId: string | undefined) {
  return useQuery({
    queryKey: scenarioId ? queryKeys.presets(scenarioId) : ["presets", "missing"],
    queryFn: () => listPresets(scenarioId!),
    enabled: Boolean(scenarioId),
  });
}

export function useCreatePreset(scenarioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PresetInput) => createPreset(scenarioId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presets(scenarioId) }),
  });
}

export function useUpdatePreset(scenarioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PresetInput }) => updatePreset(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presets(scenarioId) }),
  });
}

export function useDeletePreset(scenarioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePreset(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presets(scenarioId) }),
  });
}

export function useEnvironments() {
  return useQuery({ queryKey: queryKeys.environments(), queryFn: listEnvironments });
}

export function useEnvironment(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.environment(id) : ["environments", "missing"],
    queryFn: () => getEnvironment(id!),
    enabled: Boolean(id),
  });
}

export function useCreateEnvironment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EnvironmentInput) => createEnvironment(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.environments() }),
  });
}

export function useUpdateEnvironment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: EnvironmentInput }) =>
      updateEnvironment(id, input),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.environments() });
      qc.invalidateQueries({ queryKey: queryKeys.environment(vars.id) });
    },
  });
}

export function useDeleteEnvironment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteEnvironment(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.environments() }),
  });
}

export function useSchedules() {
  return useQuery({ queryKey: queryKeys.schedules(), queryFn: listSchedules });
}

export function useSchedule(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.schedule(id) : ["schedules", "missing"],
    queryFn: () => getSchedule(id as string),
    enabled: !!id,
  });
}

export function useScheduleEvents(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.scheduleEvents(id) : ["schedules", "missing", "events"],
    queryFn: () => scheduleEvents(id as string),
    enabled: !!id,
  });
}

export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduleInput) => createSchedule(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.schedules() }),
  });
}

export function useUpdateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: ScheduleInput }) => updateSchedule(vars.id, vars.input),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.schedules() });
      qc.invalidateQueries({ queryKey: queryKeys.schedule(vars.id) });
      qc.invalidateQueries({ queryKey: queryKeys.scheduleEvents(vars.id) });
    },
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.schedules() }),
  });
}

export function useStepTemplates() {
  return useQuery({ queryKey: queryKeys.stepTemplates(), queryFn: listStepTemplates });
}

export function useCreateStepTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StepTemplateInput) => createStepTemplate(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.stepTemplates() }),
  });
}

export function useUpdateStepTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: StepTemplateInput }) =>
      updateStepTemplate(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.stepTemplates() }),
  });
}

export function useDeleteStepTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteStepTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.stepTemplates() }),
  });
}

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings(), queryFn: getSettings });
}

export function usePutSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: number }) => putSetting(key, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings() }),
  });
}

export function useResetSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => deleteSetting(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings() }),
  });
}

export function useTestRun() {
  return useMutation({
    mutationFn: (body: TestRunBody) => api.createTestRun(body),
  });
}

/** sequential 모드 test-run — ephemeral이라 무invalidation (C-2 이디엄). */
export function useTestRunSequential() {
  return useMutation({
    mutationFn: (body: TestRunBody) => api.createTestRunSequential(body),
  });
}

export function usePoolWorkers() {
  return useQuery({
    queryKey: queryKeys.poolWorkers(),
    queryFn: listPoolWorkers,
    refetchInterval: (q) => (q.state.data?.pool_mode ? 3000 : false),
  });
}

export function usePatchPoolWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof patchPoolWorker>[1] }) =>
      patchPoolWorker(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.poolWorkers() }),
  });
}

export function useExcludePoolWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => excludePoolWorker(id, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.poolWorkers() }),
  });
}
