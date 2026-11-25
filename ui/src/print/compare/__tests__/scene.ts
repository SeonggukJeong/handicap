import { expect } from "vitest";
import { ReportSchema, type Report } from "../../../api/schemas";
import { buildRunModel, type RunModel } from "../runModel";
import type { RunMeta } from "../pair";
import { mkMeta, mkReport, scenarioYaml, type ReportStepSpec, type StepSpec } from "./fixtures";

export type SceneRun = {
  id: string;
  steps?: StepSpec[];
  rep?: ReportStepSpec[];
  summary?: Partial<Report["summary"]>;
  verdict?: Report["verdict"];
  profile?: Record<string, unknown>;
  env?: Record<string, string> | null;
  yaml?: string;
  meta?: Partial<RunMeta>;
  sample?: Report["sample"];
  statusRule?: 1 | 2;
  latencyRule?: 1 | 2;
};

const DEFAULT_STEPS: StepSpec[] = [{ id: "s1", name: "접수", assert: [200] }];
const DEFAULT_REP: ReportStepSpec[] = [{ id: "s1", counts: { "200": 1000 }, errors: 0 }];

export function sceneModel(o: SceneRun): RunModel {
  const report = mkReport({
    id: o.id,
    steps: o.rep ?? DEFAULT_REP,
    yaml: o.yaml ?? scenarioYaml(o.steps ?? DEFAULT_STEPS),
    summary: o.summary,
    verdict: o.verdict,
    profile: o.profile,
    env: o.env,
    sample: o.sample,
    statusRule: o.statusRule,
    latencyRule: o.latencyRule,
  });
  expect(ReportSchema.safeParse(report).success).toBe(true);
  return buildRunModel(mkMeta(o.id, o.meta), report);
}

export const summaryOf = (over: Partial<Report["summary"]>): Report["summary"] =>
  mkReport({ id: "x", steps: [], yaml: scenarioYaml([]), summary: over }).summary;
