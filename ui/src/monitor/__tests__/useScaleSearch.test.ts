import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useScaleSearch } from "../useScaleSearch";

/**
 * `splitFit` (spec §6.2 `--split-fit`) mirrors `reasonFit`: it is read from the
 * probes' `splitNeed` only once the board search is done and every probe has
 * reported; a settings change keeps the old value until the new search ends.
 */
describe("useScaleSearch splitFit", () => {
  function setup(count = 2) {
    const hook = renderHook(({ k }: { k: string }) => useScaleSearch(k, count), {
      initialProps: { k: "a" },
    });
    const rep = (id: string, splitNeed: number, fit = 1) =>
      act(() => {
        hook.result.current.report(id, { fit, need: Infinity, reasonNeed: Infinity, splitNeed });
      });
    return { hook, rep };
  }

  it("split_fit_is_min_of_every_probe_after_done", () => {
    const { hook, rep } = setup();
    // search phase: every probe fits at 1 -> done (split needs ignored here)
    rep("p1", 0.5);
    rep("p2", 0.5);
    expect(hook.result.current.done).toBe(true);
    expect(hook.result.current.splitFit).toBe(1);
    // done phase: one probe only -> no update yet
    rep("p1", 0.8);
    expect(hook.result.current.splitFit).toBe(1);
    rep("p2", 0.6);
    expect(hook.result.current.splitFit).toBe(0.6);
  });

  it("split_fit_caps_at_1_when_every_split_line_fits", () => {
    const { hook, rep } = setup();
    rep("p1", Infinity);
    rep("p2", Infinity);
    rep("p1", Infinity);
    rep("p2", Infinity);
    expect(hook.result.current.splitFit).toBe(1);
  });

  it("split_fit_keeps_old_value_until_new_search_reports_fully", () => {
    const { hook, rep } = setup();
    rep("p1", Infinity);
    rep("p2", Infinity);
    rep("p1", 0.6);
    rep("p2", 0.7);
    expect(hook.result.current.splitFit).toBe(0.6);
    // settings changed -> search restarts; the old split scale stays meanwhile
    hook.rerender({ k: "b" });
    expect(hook.result.current.done).toBe(false);
    expect(hook.result.current.splitFit).toBe(0.6);
    rep("p1", Infinity);
    rep("p2", Infinity);
    expect(hook.result.current.done).toBe(true);
    expect(hook.result.current.splitFit).toBe(0.6);
    // the old search's needs were cleared: one fresh report is not enough
    // (a stale p2 = 0.7 would otherwise give min(0.9, 0.7) = 0.7 here)
    rep("p1", 0.9);
    expect(hook.result.current.splitFit).toBe(0.6);
    rep("p2", Infinity);
    expect(hook.result.current.splitFit).toBe(0.9);
  });
});
