import { describe, expect, it } from "vitest";
import type { LoopStep } from "../model";
import { loopWarnings } from "../loopWarnings";

const http = (extract: string[], think?: { min_ms: number; max_ms: number }) => ({
  id: "h",
  name: "h",
  type: "http",
  request: { method: "GET", url: "/a", headers: {} },
  assert: [],
  extract: extract.map((v) => ({ var: v, from: "body", path: "$.a" })),
  ...(think ? { think_time: think } : {}),
});
const loop = (o: Record<string, unknown>, body = [http(["code"])]) =>
  ({
    id: "L",
    name: "L",
    type: "loop",
    while: { left: "{{code}}", op: "eq", right: "WAIT" },
    repeat: 3,
    do: body,
    ...o,
  }) as unknown as LoopStep;
const T = { min_ms: 500, max_ms: 500 };

describe("loopWarnings", () => {
  it("think 없는 조건 loop → noThink", () => {
    expect(loopWarnings(loop({}), undefined).noThink).toBe(true);
  });
  it("스텝 think {0,0}은 없음", () => {
    const l = loop({}, [http(["code"], { min_ms: 0, max_ms: 0 })]);
    expect(loopWarnings(l, undefined).noThink).toBe(true);
  });
  it("시나리오 기본 think만 있어도 noThink 아님", () => {
    expect(loopWarnings(loop({}), T).noThink).toBe(false);
  });
  it("think 있고 keep_think:false → thinkNotKept", () => {
    const w = loopWarnings(loop({ keep_think: false }, [http(["code"], T)]), undefined);
    expect(w.noThink).toBe(false);
    expect(w.thinkNotKept).toBe(true);
    expect(loopWarnings(loop({}, [http(["code"], T)]), undefined).thinkNotKept).toBe(false);
  });
  it("ne OK + 본문 추출 → retryOnFailure, eq WAIT → 아님", () => {
    const ne = { left: "{{code}}", op: "ne", right: "OK" };
    expect(loopWarnings(loop({ while: ne }), T).retryOnFailure).toBe(true);
    expect(loopWarnings(loop({}), T).retryOnFailure).toBe(false);
  });
  it("unlimited = repeat 없음", () => {
    expect(loopWarnings(loop({ repeat: undefined }), T).unlimited).toBe(true);
    expect(loopWarnings(loop({}), T).unlimited).toBe(false);
  });
  it("while 없는 loop은 전부 false", () => {
    const w = loopWarnings(loop({ while: undefined, repeat: undefined }, [http([])]), undefined);
    expect(w).toEqual({
      noThink: false,
      thinkNotKept: false,
      retryOnFailure: false,
      unlimited: false,
    });
  });
});
