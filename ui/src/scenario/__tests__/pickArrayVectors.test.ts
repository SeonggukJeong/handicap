import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { GenSpecModel } from "../genVars";

// 생성기 판정 벡터 — 엔진 crates/engine/tests/pick_array.rs와 같은 파일, 양방향:
// accept ⇔ Zod 성공, reject ⇔ Zod 실패, known_divergence = UI 수용(엔진만 거부, spec §4.1).
const VECTORS = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../testdata/pick_array_vectors.json"), "utf8"),
) as { generators: { yaml: string; expect: string }[] };

describe("GenSpecModel ↔ 엔진 공유 벡터", () => {
  for (const v of VECTORS.generators) {
    it(`${v.expect}: ${v.yaml}`, () => {
      const r = GenSpecModel.safeParse(parse(v.yaml));
      expect(r.success).toBe(v.expect !== "reject");
    });
  }

  it("positions 숫자 스칼라는 문자열로 정규화", () => {
    const r = GenSpecModel.safeParse(
      parse("{gen: pick_array, length: 10, min: 1, max: 1, positions: 8}"),
    );
    expect(r.success && r.data.gen === "pick_array" && r.data.positions).toBe("8");
  });

  it("positions 4097자 거부(문법 검사보다 먼저)", () => {
    const at = `${"1, ".repeat(1365)}1`;
    expect(
      GenSpecModel.safeParse({ gen: "pick_array", length: 10, min: 1, max: 1, positions: at })
        .success,
    ).toBe(true);
    expect(
      GenSpecModel.safeParse({ gen: "pick_array", length: 10, min: 1, max: 1, positions: `${at} ` })
        .success,
    ).toBe(false);
  });
});
