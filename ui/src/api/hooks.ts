import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { Profile, RunStatus } from "./schemas";

export const queryKeys = {
  scenarios: () => ["scenarios"] as const,
  scenario: (id: string) => ["scenarios", id] as const,
  scenarioRuns: (id: string) => ["scenarios", id, "runs"] as const,
  run: (id: string) => ["runs", id] as const,
  runMetrics: (id: string) => ["runs", id, "metrics"] as const,
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

export function useScenarioRuns(scenarioId: string | undefined) {
  return useQuery({
    queryKey: scenarioId ? queryKeys.scenarioRuns(scenarioId) : ["scenarios", "missing", "runs"],
    queryFn: () => api.listRunsForScenario(scenarioId!),
    enabled: Boolean(scenarioId),
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      scenarioId,
      profile,
      env,
    }: {
      scenarioId: string;
      profile: Profile;
      env: Record<string, unknown>;
    }) => api.createRun(scenarioId, profile, env),
    onSuccess: (run) => {
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

export function useRunMetrics(id: string | undefined, paused: boolean) {
  return useQuery({
    queryKey: id ? queryKeys.runMetrics(id) : ["runs", "missing", "metrics"],
    queryFn: () => api.getRunMetrics(id!),
    enabled: Boolean(id),
    // Same 1s cadence while live; once paused (terminal status) refetch once and stop.
    refetchInterval: paused ? false : 1000,
  });
}
