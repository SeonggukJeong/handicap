import { describe, it, expect } from "vitest";
import { partitionBindingRows } from "../bindingGroups";

type Row = { varName: string; manual: boolean };
const r = (varName: string, manual = false): Row => ({ varName, manual });

const IDX = new Map([
  ["checkout_branch.session_token", { branchName: "checkout_branch", varName: "session_token" }],
  ["checkout_branch.order_id", { branchName: "checkout_branch", varName: "order_id" }],
]);

describe("partitionBindingRows", () => {
  // T1
  it("splits rows, keeps original indices, and preserves order within each part", () => {
    const rows = [
      r("username"), // 0 ungrouped
      r("checkout_branch.session_token"), // 1 grouped
      r("checkout_branch.order_id"), // 2 grouped
      r("late_var"), // 3 ungrouped
    ];
    const out = partitionBindingRows(rows, IDX);

    expect(out.ungrouped.map((u) => [u.row.varName, u.idx])).toEqual([
      ["username", 0],
      ["late_var", 3],
    ]);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].branchName).toBe("checkout_branch");
    expect(out.groups[0].items.map((i) => [i.varName, i.idx])).toEqual([
      ["session_token", 1],
      ["order_id", 2],
    ]);
  });

  // T2 — 오타는 분기가 아니다
  it("leaves a dotted name that no branch produces in ungrouped", () => {
    const out = partitionBindingRows([r("ghost.token")], IDX);
    expect(out.groups).toHaveLength(0);
    expect(out.ungrouped.map((u) => u.row.varName)).toEqual(["ghost.token"]);
  });

  // T3 — manual 행은 절대 그룹핑하지 않는다(타이핑 중 점프 방지)
  it("never groups a manual row even when its name is a namespaced producer", () => {
    const out = partitionBindingRows([r("checkout_branch.session_token", true)], IDX);
    expect(out.groups).toHaveLength(0);
    expect(out.ungrouped).toHaveLength(1);
  });

  it("orders groups by first appearance", () => {
    const idx = new Map([
      ["b1.y", { branchName: "b1", varName: "y" }],
      ["b2.x", { branchName: "b2", varName: "x" }],
    ]);
    const out = partitionBindingRows([r("b2.x"), r("b1.y")], idx);
    expect(out.groups.map((g) => g.branchName)).toEqual(["b2", "b1"]);
  });
});
