import { newPanel, type BoardConfig, type CheckGroup, type PanelConfig } from "../api/monitors";
import type { Step } from "../scenario/model";
import { newStepId } from "../scenario/ulid";

/** Dirty-compare form: drops an empty `groups` key and undefined optional keys
 *  (JSON round-trip drops undefined), so add-then-remove of a group compares equal. */
export function normalizeForCompare(cfg: BoardConfig): BoardConfig {
  const out = JSON.parse(JSON.stringify(cfg)) as BoardConfig;
  if (out.groups && out.groups.length === 0) delete out.groups;
  return out;
}

export type NavSegment = { groupId: string | null; indices: number[] };

/** Contiguous runs of panels sharing a group; solo panels are one segment each. */
export function navSegments(panels: PanelConfig[]): NavSegment[] {
  const out: NavSegment[] = [];
  panels.forEach((p, i) => {
    const gid = p.group_id ?? null;
    const last = out[out.length - 1];
    if (gid !== null && last && last.groupId === gid) last.indices.push(i);
    else out.push({ groupId: gid, indices: [i] });
  });
  return out;
}

/** Copies the group's scenario/env/interval onto the panel; omits group_id. */
export function withMirror(p: PanelConfig, g: CheckGroup): PanelConfig {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { group_id: _omit, ...rest } = p;
  return {
    ...rest,
    scenario_id: g.scenario_id,
    environment_id: g.environment_id,
    interval_seconds: g.interval_seconds,
  };
}

function mirrored(p: PanelConfig, g: CheckGroup): PanelConfig {
  return {
    ...p,
    scenario_id: g.scenario_id,
    environment_id: g.environment_id,
    interval_seconds: g.interval_seconds,
  };
}

/** Appends an empty group with one step panel (step_id left absent until picked). */
export function addGroup(cfg: BoardConfig): { cfg: BoardConfig; groupId: string; panelId: string } {
  const base = newPanel();
  const group: CheckGroup = {
    id: newStepId(),
    scenario_id: base.scenario_id,
    environment_id: base.environment_id,
    interval_seconds: base.interval_seconds,
  };
  const panel: PanelConfig = { ...base, group_id: group.id };
  return {
    cfg: { ...cfg, groups: [...(cfg.groups ?? []), group], panels: [...cfg.panels, panel] },
    groupId: group.id,
    panelId: panel.id,
  };
}

export function addPanelToGroup(
  cfg: BoardConfig,
  groupId: string,
): { cfg: BoardConfig; panelId: string } {
  const g = (cfg.groups ?? []).find((x) => x.id === groupId);
  const panel = g
    ? mirrored({ ...newPanel(), group_id: groupId }, g)
    : { ...newPanel(), group_id: groupId };
  let at = -1;
  cfg.panels.forEach((p, i) => {
    if (p.group_id === groupId) at = i;
  });
  const panels = [...cfg.panels];
  panels.splice(at < 0 ? panels.length : at + 1, 0, panel);
  return { cfg: { ...cfg, panels }, panelId: panel.id };
}

export function updateGroup(cfg: BoardConfig, next: CheckGroup): BoardConfig {
  return {
    ...cfg,
    groups: (cfg.groups ?? []).map((g) => (g.id === next.id ? next : g)),
    panels: cfg.panels.map((p) => (p.group_id === next.id ? mirrored(p, next) : p)),
  };
}

/** Mirrors server normalize_step_panel: step_id + latency source + condition/display step ids. */
export function setPanelStep(p: PanelConfig, stepId: string): PanelConfig {
  return {
    ...p,
    step_id: stepId,
    latency_source: { kind: "step", step_id: stepId },
    conditions: p.conditions.map((c) => ({ ...c, step_id: stepId })),
    display_items: p.display_items.map((d) => ({ ...d, step_id: stepId })),
  };
}

export function removePanel(cfg: BoardConfig, index: number): BoardConfig {
  const target = cfg.panels[index];
  const panels = cfg.panels.filter((_, i) => i !== index);
  const gid = target?.group_id;
  if (gid && cfg.groups && !panels.some((p) => p.group_id === gid)) {
    return { ...cfg, panels, groups: cfg.groups.filter((g) => g.id !== gid) };
  }
  return { ...cfg, panels };
}

export function removeGroup(cfg: BoardConfig, groupId: string): BoardConfig {
  return {
    ...cfg,
    groups: (cfg.groups ?? []).filter((g) => g.id !== groupId),
    panels: cfg.panels.filter((p) => p.group_id !== groupId),
  };
}

/** 1-based number by first appearance in panels (0 if absent). */
export function groupNumber(cfg: BoardConfig, groupId: string): number {
  const seen: string[] = [];
  for (const p of cfg.panels) {
    if (p.group_id && !seen.includes(p.group_id)) seen.push(p.group_id);
  }
  const i = seen.indexOf(groupId);
  return i < 0 ? 0 : i + 1;
}

export type StepOption = { id: string; name: string; branchHint: string | null };

/** Every http step (recursing loop/if/parallel); branchHint = innermost enclosing IF name. */
export function stepOptionsFor(steps: ReadonlyArray<Step>): StepOption[] {
  const out: StepOption[] = [];
  const walk = (list: ReadonlyArray<Step>, hint: string | null) => {
    for (const s of list) {
      if (s.type === "http") out.push({ id: s.id, name: s.name, branchHint: hint });
      else if (s.type === "loop") walk(s.do, hint);
      else if (s.type === "parallel") for (const b of s.branches) walk(b.steps, hint);
      else {
        walk(s.then, s.name);
        for (const e of s.elif) walk(e.then, s.name);
        walk(s.else, s.name);
      }
    }
  };
  walk(steps, null);
  return out;
}
