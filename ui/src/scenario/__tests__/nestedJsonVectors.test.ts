import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { parseBodyJson } from "../bodyJson";
import { segmentsToPath, type Segment } from "../jsonPath";

type Leaf = [string, unknown];
interface Vectors {
  cases: { name: string; body: string; leaves: Leaf[] }[];
  known_divergence: { name: string; body: string; path: string; ts: unknown }[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../testdata/nested_json_vectors.json"), "utf8"),
);

function leavesOf(root: unknown): Leaf[] {
  const out: Leaf[] = [];
  const stack: { v: unknown; segs: Segment[] }[] = [{ v: root, segs: [] }];
  while (stack.length > 0) {
    const { v, segs } = stack.pop()!;
    if (v === null || typeof v !== "object") {
      out.push([segmentsToPath(segs), v]);
    } else if (Array.isArray(v)) {
      v.forEach((child, index) =>
        stack.push({ v: child, segs: [...segs, { kind: "index", index }] }),
      );
    } else {
      for (const [key, child] of Object.entries(v)) {
        stack.push({ v: child, segs: [...segs, { kind: "key", key }] });
      }
    }
  }
  return out;
}

const byPath = (a: Leaf, b: Leaf): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

describe("nestedJsonVectors", () => {
  it("fixture is not emptied", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(14);
    expect(vectors.known_divergence.length).toBe(3);
  });
  for (const c of vectors.cases) {
    it(`cases: ${c.name}`, () => {
      const got = leavesOf(parseBodyJson(c.body)!.value).sort(byPath);
      expect(got).toEqual([...c.leaves].sort(byPath));
    });
  }
  for (const d of vectors.known_divergence) {
    it(`known_divergence: ${d.name}`, () => {
      const got = leavesOf(parseBodyJson(d.body)!.value);
      expect(got).toContainEqual([d.path, d.ts]);
    });
  }
});
