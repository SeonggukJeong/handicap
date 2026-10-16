import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { GenSpecModel } from "../genVars";
import { parseScenarioDoc } from "../yamlDoc";

// 생성기 판정 벡터 — 엔진 crates/engine/tests/pick_array.rs와 같은 파일, 양방향:
// accept ⇔ Zod 성공, reject ⇔ Zod 실패, known_divergence = 두 YAML 라이브러리가 같은 평문 스칼라를
// 다르게 읽는 문서화된 예외(spec §4.1) — UI 판정은 벡터의 `ui` 필드(엔진은 `engine` 필드).
const VECTORS = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../testdata/pick_array_vectors.json"), "utf8"),
) as { generators: { yaml: string; expect: string; ui?: string }[] };

describe("GenSpecModel ↔ 엔진 공유 벡터", () => {
  for (const v of VECTORS.generators) {
    it(`${v.expect}: ${v.yaml}`, () => {
      const r = GenSpecModel.safeParse(parse(v.yaml));
      const expected = v.expect === "known_divergence" ? v.ui : v.expect;
      expect(expected === "accept" || expected === "reject").toBe(true); // ui 필드 누락 방지
      expect(r.success).toBe(expected === "accept");
    });
  }

  it("positions 숫자 스칼라는 문자열로 정규화", () => {
    const r = GenSpecModel.safeParse(
      parse("{gen: pick_array, length: 10, min: 1, max: 1, positions: 8}"),
    );
    expect(r.success && r.data.gen === "pick_array" && r.data.positions).toBe("8");
  });

  it("length가 무효(2.5·1e9·1e10)여도 throw·대량 할당 없이 검증 실패 (F2)", () => {
    // 2.5가 먼저 — 가드가 없으면 superRefine의 parsePositions가 new Array(2.5)로 RangeError를 던진다.
    for (const length of [2.5, 1e10, 1e9]) {
      const spec = { gen: "pick_array", length, min: 1, max: 1, positions: "1" };
      let ok: boolean | undefined;
      expect(() => {
        ok = GenSpecModel.safeParse(spec).success;
      }).not.toThrow();
      expect(ok).toBe(false);
    }
    for (const length of ["2.5", "1e9"]) {
      const yaml = `version: 1\nname: t\nvariables:\n  flags: {gen: pick_array, length: ${length}, min: 1, max: 1, positions: "1"}\nsteps: []\n`;
      let res: ReturnType<typeof parseScenarioDoc> | undefined;
      expect(() => {
        res = parseScenarioDoc(yaml);
      }).not.toThrow();
      expect(res && "error" in res).toBe(true);
    }
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
