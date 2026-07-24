import { describe, expect, it } from "vitest";
import {
  GenSpecModel,
  canonicalGenKey,
  declSearchText,
  formatStrftimeSubset,
  genParamsSummary,
  genTypeLabel,
  isGenSpec,
  lengthDraftValue,
  offsetKo,
  offsetSeconds,
  sampleFor,
  samplePreview,
  stepDraftValue,
  type GenSpec,
} from "../genVars";

describe("GenSpecModel", () => {
  it("accepts the 4 gen kinds (including default-omitted forms)", () => {
    const cases = [
      { gen: "date" },
      { gen: "date", format: "%Y-%m-%d", offset: "+7d", tz: "Asia/Seoul" },
      { gen: "random_int", min: 1, max: 100 },
      { gen: "random_int", min: 1000, max: 10000, step: 100 },
      { gen: "uuid" },
      { gen: "random_string" },
      { gen: "random_string", length: 12 },
    ];
    for (const c of cases) {
      const r = GenSpecModel.safeParse(c);
      expect(r.success, `expected success for ${JSON.stringify(c)}`).toBe(true);
    }
  });

  it("rejects unknown keys (strict members)", () => {
    expect(GenSpecModel.safeParse({ gen: "uuid", bogus: 1 }).success).toBe(false);
    expect(GenSpecModel.safeParse({ gen: "date", format: "%Y", bogus: 1 }).success).toBe(false);
  });

  it("rejects min > max via union-level superRefine (not member-level)", () => {
    const r = GenSpecModel.safeParse({ gen: "random_int", min: 5, max: 1 });
    expect(r.success).toBe(false);
  });

  it("accepts min === max (only min > max is invalid)", () => {
    expect(GenSpecModel.safeParse({ gen: "random_int", min: 5, max: 5 }).success).toBe(true);
  });

  it("rejects step: 0", () => {
    expect(GenSpecModel.safeParse({ gen: "random_int", min: 1, max: 2, step: 0 }).success).toBe(
      false,
    );
  });

  it("rejects length out of [1,64]", () => {
    expect(GenSpecModel.safeParse({ gen: "random_string", length: 0 }).success).toBe(false);
    expect(GenSpecModel.safeParse({ gen: "random_string", length: 65 }).success).toBe(false);
  });

  it("rejects malformed offset strings", () => {
    expect(GenSpecModel.safeParse({ gen: "date", offset: "7d" }).success).toBe(false);
    expect(GenSpecModel.safeParse({ gen: "date", offset: "+7w" }).success).toBe(false);
  });

  it("accepts valid offset strings", () => {
    expect(GenSpecModel.safeParse({ gen: "date", offset: "+7d" }).success).toBe(true);
    expect(GenSpecModel.safeParse({ gen: "date", offset: "-2h" }).success).toBe(true);
  });
});

describe("isGenSpec / declSearchText", () => {
  it("distinguishes static strings from GenSpec objects", () => {
    expect(isGenSpec("hello")).toBe(false);
    expect(isGenSpec({ gen: "uuid" })).toBe(true);
  });

  it("declSearchText returns the raw value for static strings", () => {
    expect(declSearchText("hello world")).toBe("hello world");
  });
});

describe("genTypeLabel", () => {
  it("labels each gen kind in Korean", () => {
    expect(genTypeLabel({ gen: "date" })).toBe("날짜");
    expect(genTypeLabel({ gen: "random_int", min: 1, max: 2 })).toBe("랜덤 정수");
    expect(genTypeLabel({ gen: "uuid" })).toBe("UUID");
    expect(genTypeLabel({ gen: "random_string" })).toBe("랜덤 문자열");
  });
});

describe("offsetKo", () => {
  it("returns '오늘' when offset is absent", () => {
    expect(offsetKo(undefined)).toBe("오늘");
  });

  it("converts unit suffix to Korean", () => {
    expect(offsetKo("+7d")).toBe("오늘+7일");
    expect(offsetKo("-2h")).toBe("오늘-2시간");
    expect(offsetKo("+30m")).toBe("오늘+30분");
    expect(offsetKo("+10s")).toBe("오늘+10초");
  });
});

describe("samplePreview — 시드 결정적", () => {
  it("같은 (spec,name,tick)이면 어느 호출에서든 같은 텍스트", () => {
    const spec: GenSpec = { gen: "random_string", length: 12 };
    const a = samplePreview(spec, "sid", 0);
    const b = samplePreview(spec, "sid", 0);
    expect(a).toEqual(b);
    if (a.kind !== "ok") throw new Error("expected ok");
    expect(a.text).toHaveLength(12); // 길이 파라미터가 텍스트에 반영
  });

  it("tick이 바뀌면 랜덤 3종의 텍스트가 바뀐다", () => {
    for (const spec of [
      { gen: "random_string", length: 12 },
      { gen: "random_int", min: 1, max: 1000000 },
      { gen: "uuid" },
    ] as GenSpec[]) {
      const a = samplePreview(spec, "v", 0);
      const b = samplePreview(spec, "v", 1);
      expect(a).not.toEqual(b);
    }
  });

  it("random_int 샘플은 min..max 구간의 step 배수 지점", () => {
    const spec: GenSpec = { gen: "random_int", min: 10, max: 100, step: 10 };
    const s = samplePreview(spec, "n", 3);
    if (s.kind !== "ok") throw new Error("expected ok");
    const v = Number(s.text);
    expect(v).toBeGreaterThanOrEqual(10);
    expect(v).toBeLessThanOrEqual(100);
    expect((v - 10) % 10).toBe(0);
  });

  it("uuid 샘플은 8-4-4-4-12 v4 형식", () => {
    const s = samplePreview({ gen: "uuid" }, "u", 0);
    if (s.kind !== "ok") throw new Error("expected ok");
    expect(s.text).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("canonicalGenKey", () => {
  it("step 생략과 step:1은 같은 키(기본값 정규화)", () => {
    expect(canonicalGenKey({ gen: "random_int", min: 1, max: 9 })).toBe(
      canonicalGenKey({ gen: "random_int", min: 1, max: 9, step: 1 }),
    );
  });
  it("length 생략과 8은 같은 키", () => {
    expect(canonicalGenKey({ gen: "random_string" })).toBe(
      canonicalGenKey({ gen: "random_string", length: 8 }),
    );
  });
  it("파라미터가 다르면 키가 다르다", () => {
    expect(canonicalGenKey({ gen: "random_string", length: 8 })).not.toBe(
      canonicalGenKey({ gen: "random_string", length: 9 }),
    );
  });
});

describe("genParamsSummary (타입명 없는 요약)", () => {
  // 기존 genSummary describe의 date/int 기대값은 그대로, uuid/rs만 새 값
  it("date: offset+tz", () => {
    expect(genParamsSummary({ gen: "date", offset: "+7d", tz: "Asia/Seoul" })).toBe(
      "오늘+7일 · Asia/Seoul",
    );
  });
  it("date: offset 없음 → 오늘", () => {
    expect(genParamsSummary({ gen: "date", tz: "UTC" })).toBe("오늘 · UTC");
  });
  it("date: tz 없음 → 워커 로컬", () => {
    expect(genParamsSummary({ gen: "date" })).toBe("오늘 · 워커 로컬");
  });
  it("random_int: step!==1이면 단위 접미", () => {
    expect(genParamsSummary({ gen: "random_int", min: 1000, max: 10000, step: 100 })).toBe(
      "1000 ~ 10000 · 100 단위",
    );
  });
  it("random_int: step 1/생략은 접미 없음", () => {
    expect(genParamsSummary({ gen: "random_int", min: 1, max: 100 })).toBe("1 ~ 100");
    expect(genParamsSummary({ gen: "random_int", min: 1, max: 100, step: 1 })).toBe("1 ~ 100");
  });
  it("uuid: 빈 문자열(배지 단독)", () => {
    expect(genParamsSummary({ gen: "uuid" })).toBe("");
  });
  it("random_string: N자", () => {
    expect(genParamsSummary({ gen: "random_string" })).toBe("8자");
    expect(genParamsSummary({ gen: "random_string", length: 12 })).toBe("12자");
  });
});

describe("declSearchText (타입명 포함 — 검색 하위호환+개선)", () => {
  it("gen 값은 타입명+파라미터", () => {
    expect(declSearchText({ gen: "random_int", min: 1, max: 100 })).toBe("랜덤 정수 1 ~ 100");
    expect(declSearchText({ gen: "random_string", length: 12 })).toBe("랜덤 문자열 12자");
  });
  it("uuid는 매달린 공백 없이 타입명만", () => {
    expect(declSearchText({ gen: "uuid" })).toBe("UUID");
  });
});

describe("draft 유효성 헬퍼 (commit 술어와 동작 동일 — 특성화)", () => {
  it("lengthDraftValue: 1..64 정수만", () => {
    expect(lengthDraftValue("12")).toBe(12);
    expect(lengthDraftValue(" 8 ")).toBe(8);
    expect(lengthDraftValue("0")).toBeNull();
    expect(lengthDraftValue("-1")).toBeNull();
    expect(lengthDraftValue("65")).toBeNull();
    expect(lengthDraftValue("3.5")).toBeNull();
    expect(lengthDraftValue("")).toBeNull();
  });
  it("stepDraftValue: >=1 정수만", () => {
    expect(stepDraftValue("1")).toBe(1);
    expect(stepDraftValue("100")).toBe(100);
    expect(stepDraftValue("0")).toBeNull();
    expect(stepDraftValue("1.5")).toBeNull();
    expect(stepDraftValue("")).toBeNull();
  });
});

describe("offsetSeconds", () => {
  it("converts each unit to seconds with sign", () => {
    expect(offsetSeconds("+7d")).toBe(7 * 86400);
    expect(offsetSeconds("-2h")).toBe(-2 * 3600);
    expect(offsetSeconds("+30m")).toBe(30 * 60);
    expect(offsetSeconds("+10s")).toBe(10);
  });

  it("returns 0 for absent/malformed offsets", () => {
    expect(offsetSeconds(undefined)).toBe(0);
  });
});

describe("formatStrftimeSubset", () => {
  it("returns null for a format outside the supported subset", () => {
    expect(
      formatStrftimeSubset(
        "%j",
        { year: 2026, month: 7, day: 24, hour: 15, minute: 0, second: 0 },
        0,
      ),
    ).toBeNull();
  });

  it("formats %% as a literal percent", () => {
    expect(
      formatStrftimeSubset(
        "100%%",
        { year: 2026, month: 7, day: 24, hour: 15, minute: 0, second: 0 },
        0,
      ),
    ).toBe("100%");
  });
});

describe("sampleFor", () => {
  const NOW = new Date(Date.UTC(2026, 6, 24, 15, 0, 0)); // 2026-07-24T15:00:00Z

  it("applies +7d offset with %Y-%m-%d in UTC", () => {
    const r = sampleFor({ gen: "date", format: "%Y-%m-%d", tz: "UTC", offset: "+7d" }, NOW);
    expect(r).toEqual({ kind: "ok", text: "2026-07-31" });
  });

  it("formats a Korean-language date pattern in UTC", () => {
    const r = sampleFor({ gen: "date", format: "%Y년 %m월 %d일", tz: "UTC" }, NOW);
    expect(r).toEqual({ kind: "ok", text: "2026년 07월 24일" });
  });

  it("applies -2h offset with %H:%M in UTC", () => {
    const r = sampleFor({ gen: "date", format: "%H:%M", tz: "UTC", offset: "-2h" }, NOW);
    expect(r).toEqual({ kind: "ok", text: "13:00" });
  });

  it("formats unix as epoch seconds", () => {
    const r = sampleFor({ gen: "date", format: "unix" }, NOW);
    expect(r).toEqual({ kind: "ok", text: String(Math.floor(NOW.getTime() / 1000)) });
  });

  it("formats unix_ms as epoch milliseconds", () => {
    const r = sampleFor({ gen: "date", format: "unix_ms" }, NOW);
    expect(r).toEqual({ kind: "ok", text: String(NOW.getTime()) });
  });

  it("returns unsupported for a format outside the subset (%j)", () => {
    const r = sampleFor({ gen: "date", format: "%j", tz: "UTC" }, NOW);
    expect(r).toEqual({ kind: "unsupported" });
  });

  it("returns unsupported (not throw) for a gate-passing extreme offset producing an Invalid Date", () => {
    // 게이트 정규식 `^[+-]\d{1,9}[smhd]$`는 9자리 `d`(예: +99999999d)를 수용한다 — ±8.64e15ms를
    // 넘으면 Invalid Date가 되어 partsIn의 dtf.formatToParts가 RangeError를 throw한다
    // (dynamic-vars final review I1). 접힌 행(GenSampleLine)도 렌더하므로 열람만 해도 크래시.
    // NOW(2026)가 epoch(1970)에 가까워 -99999999d(8자리)는 아직 유효 범위 안이라, 음수
    // 방향은 최대 9자리(-999999999d)로 확실히 경계를 넘긴다.
    expect(() =>
      sampleFor({ gen: "date", format: "%Y-%m-%d", tz: "UTC", offset: "+99999999d" }, NOW),
    ).not.toThrow();
    const r = sampleFor({ gen: "date", format: "%Y-%m-%d", tz: "UTC", offset: "+99999999d" }, NOW);
    expect(r).toEqual({ kind: "unsupported" });
    const rNeg = sampleFor(
      { gen: "date", format: "%Y-%m-%d", tz: "UTC", offset: "-999999999d" },
      NOW,
    );
    expect(rNeg).toEqual({ kind: "unsupported" });
  });

  it("returns unsupported (not NaN text) for unix/unix_ms with an extreme offset", () => {
    const rUnix = sampleFor({ gen: "date", format: "unix", offset: "+99999999d" }, NOW);
    expect(rUnix).toEqual({ kind: "unsupported" });
    const rUnixMs = sampleFor({ gen: "date", format: "unix_ms", offset: "+99999999d" }, NOW);
    expect(rUnixMs).toEqual({ kind: "unsupported" });
  });

  it("random_int sample lands on the min/step grid", () => {
    const spec: GenSpec = { gen: "random_int", min: 1000, max: 10000, step: 100 };
    for (let i = 0; i < 20; i++) {
      const r = sampleFor(spec, NOW);
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") {
        const v = Number(r.text);
        expect(v).toBeGreaterThanOrEqual(1000);
        expect(v).toBeLessThanOrEqual(10000);
        expect((v - 1000) % 100).toBe(0);
      }
    }
  });

  it("uuid sample matches the v4 regex", () => {
    const r = sampleFor({ gen: "uuid" }, NOW);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.text).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("random_string sample has the requested length and charset", () => {
    const r = sampleFor({ gen: "random_string", length: 12 }, NOW);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.text).toHaveLength(12);
      expect(r.text).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("random_string sample defaults to length 8", () => {
    const r = sampleFor({ gen: "random_string" }, NOW);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.text).toHaveLength(8);
  });
});
