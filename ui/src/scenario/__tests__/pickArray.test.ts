import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  VALUE_PRESETS,
  candidatesOf,
  formatPositions,
  formatValueLiteral,
  isFullRange,
  parsePositions,
  parseValueLiteral,
  presetIndexOf,
  samplePickArray,
  trimPositionsForLength,
  type JsonScalar,
} from "../pickArray";
import { seededRand } from "../genVars";

type PosVec = { text: string; length: number; expect: string; set?: number[]; canonical?: string };
const VECTORS = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../testdata/pick_array_vectors.json"), "utf8"),
) as { positions: PosVec[] };

describe("parsePositions / formatPositions — 공유 벡터(엔진 lockstep)", () => {
  for (const v of VECTORS.positions) {
    it(`${v.expect}: ${JSON.stringify(v.text)} (len ${v.length})`, () => {
      const r = parsePositions(v.text, v.length);
      if (v.expect === "accept") {
        expect(r).toEqual({ ok: true, set: v.set });
        if (r.ok) expect(formatPositions(r.set)).toBe(v.canonical);
      } else {
        expect(r.ok).toBe(false);
      }
    });
  }

  it("4096자 경계: 4096 수용, 4097 tooLong", () => {
    const at = `${"1, ".repeat(1365)}1`;
    expect(at.length).toBe(4096);
    expect(parsePositions(at, 10)).toEqual({ ok: true, set: [1] });
    expect(parsePositions(`${at} `, 10)).toEqual({ ok: false, error: { kind: "tooLong" } });
  });

  it("오류 종류와 1-based 항목 번호", () => {
    expect(parsePositions("1, x", 10)).toEqual({ ok: false, error: { kind: "badItem", index: 2 } });
    expect(parsePositions("1, 11", 10)).toEqual({
      ok: false,
      error: { kind: "outOfRange", index: 2 },
    });
    expect(parsePositions("5-3", 10)).toEqual({ ok: false, error: { kind: "reversed", index: 1 } });
  });

  it("프로퍼티: format→parse→format 고정점 (numRuns 40)", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 60 }), { maxLength: 30 }), (xs) => {
        const f = formatPositions(xs);
        const back = parsePositions(f, 60);
        expect(back.ok).toBe(true);
        if (back.ok) {
          expect(back.set).toEqual([...xs].sort((a, b) => a - b));
          expect(formatPositions(back.set)).toBe(f);
        }
      }),
      { numRuns: 40 },
    );
  });

  it("isFullRange / trimPositionsForLength", () => {
    expect(isFullRange([1, 2, 3], 3)).toBe(true);
    expect(isFullRange([1, 3], 3)).toBe(false);
    expect(trimPositionsForLength("1-30", 30, 25)).toBe("1-25"); // 전체 → 새 전체
    expect(trimPositionsForLength("1-5, 8, 12-20", 30, 10)).toBe("1-5, 8"); // 일부 → 범위 밖 제거
    expect(trimPositionsForLength("1-5, 28", 30, 25)).toBe("1-5");
    expect(trimPositionsForLength("1 - 3", 30, 30)).toBe("1 - 3"); // 같은 길이 = 원문 그대로
    expect(trimPositionsForLength("x", 30, 10)).toBe("x"); // 파싱 실패 = 원문 그대로
  });
});

describe("parseValueLiteral / formatValueLiteral", () => {
  it("규칙(spec §5)", () => {
    expect(parseValueLiteral(" true ")).toEqual({ ok: true, value: true });
    expect(parseValueLiteral("null")).toEqual({ ok: true, value: null });
    expect(parseValueLiteral("1")).toEqual({ ok: true, value: 1 });
    expect(parseValueLiteral("-1.5e2")).toEqual({ ok: true, value: -150 });
    expect(parseValueLiteral('"1"')).toEqual({ ok: true, value: "1" });
    expect(parseValueLiteral("Y")).toEqual({ ok: true, value: "Y" });
    expect(parseValueLiteral("True")).toEqual({ ok: true, value: "True" });
    expect(parseValueLiteral("")).toEqual({ ok: false, reason: "empty" });
    expect(parseValueLiteral('"a"b"')).toEqual({ ok: false, reason: "badQuoted" });
    expect(parseValueLiteral("1e999")).toEqual({ ok: false, reason: "nonFinite" });
  });

  it("포매터는 파서 기준으로 따옴표를 붙인다", () => {
    expect(formatValueLiteral(true)).toBe("true");
    expect(formatValueLiteral(1)).toBe("1");
    expect(formatValueLiteral(null)).toBe("null");
    expect(formatValueLiteral("Y")).toBe("Y");
    expect(formatValueLiteral("1")).toBe('"1"');
    expect(formatValueLiteral("true")).toBe('"true"');
    expect(formatValueLiteral("1e999")).toBe('"1e999"');
    expect(formatValueLiteral(" a")).toBe('" a"');
    expect(formatValueLiteral("")).toBe('""');
  });

  it("프로퍼티: 왕복 불변식 (-0 제외, numRuns 40)", () => {
    const scalar = fc.oneof(
      fc.boolean(),
      fc.constant(null),
      fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)),
      fc.string({ maxLength: 64 }), // 64자 상한(F1) 안쪽만 — 왕복 대상
    ) as fc.Arbitrary<JsonScalar>;
    fc.assert(
      fc.property(scalar, (v) => {
        expect(parseValueLiteral(formatValueLiteral(v))).toEqual({ ok: true, value: v });
      }),
      { numRuns: 40 },
    );
  });

  it("프리셋 인덱스", () => {
    expect(VALUE_PRESETS).toHaveLength(4);
    expect(presetIndexOf(true, false)).toBe(0);
    expect(presetIndexOf("True", "False")).toBe(1);
    expect(presetIndexOf(1, 0)).toBe(2);
    expect(presetIndexOf("Y", "N")).toBe(3);
    expect(presetIndexOf("1", "0")).toBe(-1); // 문자열 "1"은 숫자 프리셋 아님
    expect(presetIndexOf(true, null)).toBe(-1);
  });
});

describe("samplePickArray", () => {
  it("길이·개수·후보·값 타입 불변식 (엔진 분포와 동일 규칙)", () => {
    const p = { length: 30, min: 2, max: 3, positions: "1-5, 8, 12-20", pick: 1, rest: 0 };
    const cand = new Set(candidatesOf(p)!);
    const rand = seededRand(42);
    const counts = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const arr = JSON.parse(samplePickArray(p, rand)!) as number[];
      expect(arr).toHaveLength(30);
      const picked = arr.flatMap((x, idx) => (x === 1 ? [idx + 1] : []));
      expect(picked.every((q) => cand.has(q))).toBe(true);
      expect(arr.every((x) => x === 0 || x === 1)).toBe(true);
      counts.add(picked.length);
    }
    expect([...counts].sort()).toEqual([2, 3]);
  });

  it("max > 후보 수면 후보 수로 상한, positions 무효면 null", () => {
    const rand = seededRand(1);
    for (let i = 0; i < 50; i++) {
      const arr = JSON.parse(
        samplePickArray({ length: 10, min: 1, max: 10, positions: "1-3" }, rand)!,
      ) as boolean[];
      expect(arr.filter(Boolean).length).toBeLessThanOrEqual(3);
    }
    expect(samplePickArray({ length: 10, min: 1, max: 1, positions: "x" }, rand)).toBeNull();
  });
});

describe("pick/rest 문자열 64자 상한 (F1 — 엔진 present_value와 lockstep)", () => {
  it("코드 포인트로 센다 — 64 수용·65 거부, 서로게이트 쌍도 1자", () => {
    const a64 = "a".repeat(64);
    expect(parseValueLiteral(a64)).toEqual({ ok: true, value: a64 });
    expect(parseValueLiteral("a".repeat(65))).toEqual({ ok: false, reason: "tooLong" });
    expect(parseValueLiteral(JSON.stringify("b".repeat(65)))).toEqual({
      ok: false,
      reason: "tooLong",
    });
    const e64 = "😀".repeat(64); // UTF-16 128 단위 — s.length로 세면 거부되는 경계
    expect(parseValueLiteral(e64)).toEqual({ ok: true, value: e64 });
    expect(parseValueLiteral("😀".repeat(65))).toEqual({ ok: false, reason: "tooLong" });
  });
});

describe("범위 밖 length 가드 (F2)", () => {
  it("parsePositions·candidatesOf·samplePickArray는 throw·대량 할당 없이 실패", () => {
    // 2.5가 먼저 — 가드가 없으면 new Array(2.5)가 RangeError를 던진다(1e9는 ~8 GB 할당).
    for (const length of [2.5, 0, -1, 1001, Number.NaN, 1e10, 1e9]) {
      expect(parsePositions("1", length).ok).toBe(false);
      expect(parsePositions("", length).ok).toBe(false);
      expect(candidatesOf({ length, min: 0, max: 0 })).toBeNull();
      expect(samplePickArray({ length, min: 0, max: 0 }, seededRand(1))).toBeNull();
    }
    expect(parsePositions("1000", 1000)).toEqual({ ok: true, set: [1000] });
  });
});
