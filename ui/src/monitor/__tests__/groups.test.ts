import { describe, it, expect } from "vitest";
import {
  addGroup,
  addPanelToGroup,
  groupNumber,
  navSegments,
  normalizeForCompare,
  removeGroup,
  removePanel,
  setPanelStep,
  stepOptionsFor,
  updateGroup,
  withMirror,
} from "../groups";
import { newPanel, type BoardConfig, type CheckGroup, type PanelConfig } from "../../api/monitors";
import type { Step } from "../../scenario/model";

const G1: CheckGroup = { id: "g1", scenario_id: "s1", environment_id: "e1", interval_seconds: 20 };
const G2: CheckGroup = { id: "g2", scenario_id: "s2", environment_id: null, interval_seconds: 30 };

function gp(id: string, group?: string): PanelConfig {
  const p: PanelConfig = { ...newPanel(), id };
  if (group) p.group_id = group;
  return p;
}
function board(panels: PanelConfig[], groups?: CheckGroup[]): BoardConfig {
  const cfg: BoardConfig = {
    font_scale: "medium",
    display_style: "fill",
    blink: "off",
    show_latency_stats: false,
    record_limit_kb: 64,
    panels,
  };
  if (groups) cfg.groups = groups;
  return cfg;
}

describe("monitor groups helpers", () => {
  it("navSegments_groups_contiguous", () => {
    const panels = [gp("a", "g1"), gp("b", "g1"), gp("c"), gp("d", "g2")];
    expect(navSegments(panels)).toEqual([
      { groupId: "g1", indices: [0, 1] },
      { groupId: null, indices: [2] },
      { groupId: "g2", indices: [3] },
    ]);
  });

  it("addGroup_appends_group_and_step_panel", () => {
    const cfg = board([gp("a")]);
    const r = addGroup(cfg);
    expect(r.cfg.groups).toHaveLength(1);
    expect(r.cfg.groups![0].id).toBe(r.groupId);
    expect(r.cfg.panels).toHaveLength(2);
    const p = r.cfg.panels[1];
    expect(p.id).toBe(r.panelId);
    expect(p.group_id).toBe(r.groupId);
    expect(p.step_id).toBeUndefined();
    expect(cfg.panels).toHaveLength(1);
  });

  it("addPanelToGroup_inserts_after_last_member_with_mirror", () => {
    const cfg = board([gp("a", "g1"), gp("b", "g1"), gp("c")], [G1]);
    const r = addPanelToGroup(cfg, "g1");
    expect(r.cfg.panels.map((p) => p.id)).toEqual(["a", "b", r.panelId, "c"]);
    const p = r.cfg.panels[2];
    expect(p.group_id).toBe("g1");
    expect(p.scenario_id).toBe("s1");
    expect(p.environment_id).toBe("e1");
    expect(p.interval_seconds).toBe(20);
  });

  it("updateGroup_mirrors_members", () => {
    const cfg = board([gp("a", "g1"), gp("b", "g2"), gp("c", "g1")], [G1, G2]);
    const next = { ...G1, scenario_id: "sX", environment_id: null, interval_seconds: 45 };
    const r = updateGroup(cfg, next);
    expect(r.groups![0]).toEqual(next);
    expect(r.panels[0]).toMatchObject({
      scenario_id: "sX",
      environment_id: null,
      interval_seconds: 45,
    });
    expect(r.panels[2]).toMatchObject({ scenario_id: "sX", interval_seconds: 45 });
    expect(r.panels[1].scenario_id).toBe(cfg.panels[1].scenario_id);
  });

  it("setPanelStep_syncs_conditions_and_display", () => {
    const p: PanelConfig = {
      ...gp("a", "g1"),
      conditions: [
        {
          step_id: "old",
          source: "status",
          path: "",
          op: "eq",
          value: "200",
          ignore_case: false,
          trim: false,
        },
      ],
      display_items: [{ step_id: "old", source: "body", path: "$.a" }],
    };
    const r = setPanelStep(p, "NEW");
    expect(r.step_id).toBe("NEW");
    expect(r.latency_source).toEqual({ kind: "step", step_id: "NEW" });
    expect(r.conditions[0].step_id).toBe("NEW");
    expect(r.display_items[0].step_id).toBe("NEW");
    expect(p.conditions[0].step_id).toBe("old");
  });

  it("removePanel_last_member_removes_group", () => {
    const cfg = board([gp("a", "g1"), gp("b", "g1"), gp("c", "g2")], [G1, G2]);
    const r1 = removePanel(cfg, 0);
    expect(r1.groups!.map((g) => g.id)).toEqual(["g1", "g2"]);
    const r2 = removePanel(r1, 0);
    expect(r2.groups!.map((g) => g.id)).toEqual(["g2"]);
    expect(r2.panels.map((p) => p.id)).toEqual(["c"]);
  });

  it("removeGroup_removes_members", () => {
    const cfg = board([gp("a", "g1"), gp("b"), gp("c", "g1")], [G1]);
    const r = removeGroup(cfg, "g1");
    expect(r.panels.map((p) => p.id)).toEqual(["b"]);
    expect("groups" in r).toBe(true);
    expect(r.groups).toEqual([]);
  });

  it("groupNumber_first_appearance", () => {
    const cfg = board([gp("a", "g2"), gp("b", "g1"), gp("c", "g2")], [G1, G2]);
    expect(groupNumber(cfg, "g2")).toBe(1);
    expect(groupNumber(cfg, "g1")).toBe(2);
  });

  it("normalizeForCompare_add_then_remove_group_equal", () => {
    const cfg = board([gp("a")]);
    const added = addGroup(cfg);
    const back = removeGroup(added.cfg, added.groupId);
    expect(JSON.stringify(normalizeForCompare(back))).toBe(
      JSON.stringify(normalizeForCompare(cfg)),
    );
    expect("groups" in normalizeForCompare(back)).toBe(false);
  });

  it("withMirror_fills_and_omits_group_id", () => {
    const r = withMirror(gp("a", "g1"), G1);
    expect(r.scenario_id).toBe("s1");
    expect(r.environment_id).toBe("e1");
    expect(r.interval_seconds).toBe(20);
    expect("group_id" in r).toBe(false);
  });

  it("stepOptionsFor_nested_if_hint", () => {
    const h = (id: string, name: string) => ({ id, name, type: "http" }) as unknown as Step;
    const steps = [
      h("A", "outside"),
      {
        id: "L",
        name: "loop",
        type: "loop",
        repeat: 1,
        do: [
          {
            id: "I",
            name: "분기",
            type: "if",
            then: [h("B", "inside")],
            elif: [],
            else: [],
          },
        ],
      },
    ] as unknown as Step[];
    expect(stepOptionsFor(steps)).toEqual([
      { id: "A", name: "outside", branchHint: null },
      { id: "B", name: "inside", branchHint: "분기" },
    ]);
  });

  const h = (id: string, name: string) => ({ id, name, type: "http" }) as unknown as Step;

  it("stepOptionsFor_parallel_branch_has_no_hint", () => {
    const steps = [
      {
        id: "P",
        name: "동시",
        type: "parallel",
        branches: [
          { name: "a", steps: [h("A", "가")] },
          { name: "b", steps: [h("B", "나")] },
        ],
      },
    ] as unknown as Step[];
    expect(stepOptionsFor(steps)).toEqual([
      { id: "A", name: "가", branchHint: null },
      { id: "B", name: "나", branchHint: null },
    ]);
  });

  it("stepOptionsFor_elif_and_else_hint_is_that_if", () => {
    const steps = [
      {
        id: "I",
        name: "경마일",
        type: "if",
        then: [h("T", "then")],
        elif: [{ then: [h("E", "elif")] }],
        else: [h("X", "else")],
      },
    ] as unknown as Step[];
    expect(stepOptionsFor(steps)).toEqual([
      { id: "T", name: "then", branchHint: "경마일" },
      { id: "E", name: "elif", branchHint: "경마일" },
      { id: "X", name: "else", branchHint: "경마일" },
    ]);
  });

  it("stepOptionsFor_nested_if_uses_innermost_name", () => {
    const steps = [
      {
        id: "O",
        name: "바깥",
        type: "if",
        then: [
          h("A", "outer-then"),
          {
            id: "N",
            name: "안쪽",
            type: "if",
            then: [h("B", "inner-then")],
            elif: [],
            else: [h("C", "inner-else")],
          },
        ],
        elif: [],
        else: [],
      },
    ] as unknown as Step[];
    expect(stepOptionsFor(steps)).toEqual([
      { id: "A", name: "outer-then", branchHint: "바깥" },
      { id: "B", name: "inner-then", branchHint: "안쪽" },
      { id: "C", name: "inner-else", branchHint: "안쪽" },
    ]);
  });
});
