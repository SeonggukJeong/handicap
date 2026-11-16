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
  describe("추출 기본값 — 못 뽑았을 때 값으로 평가", () => {
    const withDefaults = (...defs: Array<string | undefined>) => [
      {
        ...http([]),
        extract: defs.map((d) => ({
          var: "status",
          from: "body",
          path: "$.s",
          ...(d === undefined ? {} : { default: d }),
        })),
      },
    ];
    const ne = { left: "{{status}}", op: "ne", right: "done" };
    const retry = (body: ReturnType<typeof withDefaults>, w: Record<string, unknown> = ne) =>
      loopWarnings(loop({ while: w }, body as never), T).retryOnFailure;
    it("기본값 없음 → 재시도 경고(지금과 같다)", () => {
      expect(retry(withDefaults(undefined))).toBe(true);
    });
    it("기본값이 종료 값(done) → 경고 없음", () => {
      expect(retry(withDefaults("done"))).toBe(false);
    });
    it("기본값이 계속 값(wait) → 경고", () => {
      expect(retry(withDefaults("wait"))).toBe(true);
    });
    it("matches + 기본값 x → 판단 보류(경고 없음)", () => {
      expect(retry(withDefaults("x"), { left: "{{status}}", op: "matches", right: "^d" })).toBe(
        false,
      );
    });
    it("같은 이름 두 항목[default done, default 없음] → done으로 본다", () => {
      expect(retry(withDefaults("done", undefined))).toBe(false);
    });
  });
  describe("같은 이름을 두 스텝이 뽑을 때 — 스텝 순서대로 뒤 스텝이 덮어쓴다", () => {
    const step = (id: string, d?: string) => ({
      ...http([]),
      id,
      extract: [
        { var: "status", from: "body", path: "$.s", ...(d === undefined ? {} : { default: d }) },
      ],
    });
    const ne = { left: "{{status}}", op: "ne", right: "done" };
    const retry = (...body: ReturnType<typeof step>[]) =>
      loopWarnings(loop({ while: ne }, body as never), T).retryOnFailure;
    it("A[default done] 뒤 B[기본값 없음] → 빈 값이 덮어써서 재시도 경고", () => {
      expect(retry(step("A", "done"), step("B"))).toBe(true);
    });
    it("A[기본값 없음] 뒤 B[default done] → done이 덮어써서 경고 없음", () => {
      expect(retry(step("A"), step("B", "done"))).toBe(false);
    });
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
