import { parse } from "yaml";
import { ProfileSchema, type Criteria, type Profile, type Report } from "../../api/schemas";
import { envValueToRecord } from "../../api/runPrefill";
import { workerCount } from "../conditions";
import { readScenarioFacts, type ScenarioFacts } from "../scenarioFacts";
import { buildStepTable, type StepTableModel } from "../stepTable";
import { stepStatus, type RankedRow } from "../stepStatus";
import { verdictBox, type BoxState } from "../verdict";
import type { RunMeta } from "./pair";

export type RunModel = {
  meta: RunMeta;
  report: Report;
  facts: ScenarioFacts;
  yamlObj: unknown | null;
  profile: Profile | null;
  criteria: Criteria | null;
  env: Record<string, string>;
  table: StepTableModel;
  ranked: RankedRow[];
  box: BoxState;
  workers: number;
};

function parseYaml(text: string): unknown | null {
  try {
    return parse(text) ?? null;
  } catch {
    return null;
  }
}

export function buildRunModel(meta: RunMeta, report: Report): RunModel {
  const facts = readScenarioFacts(report.scenario_yaml);
  const parsed = ProfileSchema.safeParse(report.run.profile);
  const profile = parsed.success ? parsed.data : null;
  const criteria = profile?.criteria ?? null;
  const table = buildStepTable(report.steps, facts);
  const { count } = report.summary;
  return {
    meta,
    report,
    facts,
    yamlObj: parseYaml(report.scenario_yaml),
    profile,
    criteria,
    env: envValueToRecord(report.run.env),
    table,
    ranked: table.rows.map((r) => ({ ...r, status: stepStatus(r, criteria) })),
    box: verdictBox({ count, status: meta.status, criteria, verdict: report.verdict }),
    workers: workerCount(profile, report.worker_breakdown?.length ?? 0),
  };
}
