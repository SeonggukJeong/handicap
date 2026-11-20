import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_ASSIGN,
  MAX_GROUP_CHARS,
  filterScenarios,
  groupNames,
  groupScenarios,
  validateGroupName,
} from "../grouping";

type Item = { id: string; name: string; group?: string | null };

const list: Item[] = [
  { id: "1", name: "로그인 A", group: "주문" },
  { id: "2", name: "결제", group: null },
  { id: "3", name: "검색", group: "가입" },
  { id: "4", name: "Cart", group: "주문" },
  { id: "5", name: "탈퇴" },
  { id: "6", name: "빈 그룹", group: "" },
];

describe("constants", () => {
  it("limits", () => {
    expect(MAX_GROUP_CHARS).toBe(40);
    expect(MAX_ASSIGN).toBe(500);
  });
});

describe("groupScenarios", () => {
  it("sorts groups by ko name, keeps input order inside and for ungrouped", () => {
    const g = groupScenarios(list);
    expect(g.groups.map((x) => x.name)).toEqual(["가입", "주문"]);
    expect(g.groups[1].items.map((x) => x.id)).toEqual(["1", "4"]);
    expect(g.ungrouped.map((x) => x.id)).toEqual(["2", "5", "6"]);
  });

  it("no groups -> groups [] and ungrouped is the input, same elements", () => {
    const plain = list.filter((x) => !x.group);
    const g = groupScenarios(plain);
    expect(g.groups).toEqual([]);
    expect(g.ungrouped.length).toBe(plain.length);
    g.ungrouped.forEach((x, i) => expect(x).toBe(plain[i]));
  });
});

describe("groupNames", () => {
  it("dedups and sorts", () => {
    expect(groupNames(list)).toEqual(["가입", "주문"]);
    expect(groupNames([])).toEqual([]);
  });
});

describe("filterScenarios", () => {
  it("blank query returns everything", () => {
    expect(filterScenarios(list, "   ")).toHaveLength(list.length);
    expect(filterScenarios(list, "")).toHaveLength(list.length);
  });
  it("matches name substring case-insensitively", () => {
    expect(filterScenarios(list, "cART").map((x) => x.id)).toEqual(["4"]);
  });
  it("trims the query before matching", () => {
    expect(filterScenarios(list, " cart ").map((x) => x.id)).toEqual(["4"]);
  });
  it("matching group name returns all members, in input order", () => {
    expect(filterScenarios(list, "주문").map((x) => x.id)).toEqual(["1", "4"]);
  });
  it("a group-only match does not pull in other scenarios", () => {
    expect(filterScenarios(list, "가").map((x) => x.id)).toEqual(["3"]);
  });
  it("name and group matches combine in input order", () => {
    expect(filterScenarios(list, "a").map((x) => x.id)).toEqual(["1", "4"]);
  });
  it("no match returns []", () => {
    expect(filterScenarios(list, "zzz")).toEqual([]);
  });
});

type Expect = "none" | "too_long" | "forbidden" | { value: string };
const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(
  readFileSync(resolve(here, "../../../../testdata/group_name_cases.json"), "utf8"),
) as { input: string | null; expect: Expect }[];

describe("validateGroupName (shared table with the server)", () => {
  it("table is not empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });
  cases.forEach((c, i) => {
    if (c.input === null) return;
    const input = c.input;
    it(`case ${i}: ${JSON.stringify(input).slice(0, 30)}`, () => {
      const got = validateGroupName(input);
      if (c.expect === "none") expect(got).toEqual({ ok: true, value: null });
      else if (c.expect === "too_long" || c.expect === "forbidden")
        expect(got).toEqual({ ok: false, reason: c.expect });
      else expect(got).toEqual({ ok: true, value: c.expect.value });
    });
  });
});
