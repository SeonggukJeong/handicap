import { expect, it } from "vitest";
import { buildOverlay } from "../overlay";
import { buildOverlayLatency } from "../overlayLatency";
import type { RunModel } from "../runModel";
import { expectClean } from "./expectClean";
import { L, run, secs } from "./latencyRuns";

const model = (b: RunModel, a: RunModel) => buildOverlayLatency(b, a, buildOverlay(b, a, false));

it("칸 평균: 2초 묶음에 (n=1, 10ms)·(n=3, 20ms) → 17.5ms (R-A8과 같은 계산)", () => {
  const m = model(
    run("b", secs(125, 10), [L(0, 1, 10_000), L(1, 3, 20_000)]),
    run("a", secs(125, 10), [L(2, 2, 30_000)]),
  )!;
  expect(m.durationSec).toBe(125);
  expect(m.binText).toBe("2초");
  expect(m.before.bins).toHaveLength(63);
  expect(m.before.bins[0]).toMatchObject({ startSec: 0, seconds: 2, meanMs: 17.5, observed: true });
  expect(m.before.bins[1]).toMatchObject({ meanMs: null, observed: false });
  expect(m.after.bins[1]).toMatchObject({ startSec: 2, meanMs: 30 });
  expect(m.yTicks).toEqual([0, 10, 20, 30]);
  expect(m.capped).toBe(false);
  expect(m.missingNote).toBeNull();
  expectClean(m);
});

it("길이가 다른 두 측정: 이전 60초 · 이후 1,800초 → 15초 묶음, 이전 4개 · 이후 120개", () => {
  const b = run("b", secs(60, 10), [L(59, 4, 8_000)]);
  const a = run("a", secs(1800, 10), [L(1799, 1, 12_000)]);
  const m = model(b, a)!;
  expect(m.binText).toBe("15초");
  expect(m.before.bins).toHaveLength(4);
  expect(m.before.bins[3]!.meanMs).toBe(8);
  expect(m.after.bins).toHaveLength(120);
  expect(m.after.bins[119]!.meanMs).toBe(12);
  expect(m.timeTicks).toEqual(buildOverlay(b, a, false).timeTicks);
});

it("한쪽에만 값이 없으면 그 쪽은 has false + 글, 다른 쪽은 그대로", () => {
  const m = model(run("b", secs(10, 5), []), run("a", secs(10, 5), [L(0, 1, 5_000)]))!;
  expect(m.before.has).toBe(false);
  expect(m.before.bins.every((b) => b.meanMs === null)).toBe(true);
  expect(m.after.has).toBe(true);
  expect(m.missingNote).toBe("이전 측정에는 응답 시간 값이 없습니다.");
  // 거꾸로
  const r = model(run("b", secs(10, 5), [L(0, 1, 5_000)]), run("a", secs(10, 5), [L(0, 0)]))!;
  expect(r.missingNote).toBe("이후 측정에는 응답 시간 값이 없습니다.");
});

it("두 쪽 모두 값이 없으면 null (창 없는 측정 포함)", () => {
  expect(model(run("b", secs(10, 5), []), run("a", secs(10, 5), [L(0, 0)]))).toBeNull();
  expect(model(run("b", [], []), run("a", [], []))).toBeNull();
});

it("60초 칸: capped 초가 든 묶음이 있으면 capped true, 값은 60,000", () => {
  const m = model(
    run("b", secs(10, 5), [L(0, 2, 60_000_000, true)]),
    run("a", secs(10, 5), [L(0, 1, 5_000)]),
  )!;
  expect(m.capped).toBe(true);
  expect(m.before.bins[0]!.meanMs).toBe(60_000);
  expect(m.yTicks[m.yTicks.length - 1]).toBe(60_000);
});
