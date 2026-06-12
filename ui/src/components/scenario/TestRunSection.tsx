import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useEnvironment, useTestRun } from "../../api/hooks";
import { resolveEnv, type EnvEntry } from "../../api/envOverlay";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import type { Step } from "../../scenario/model";
import { Button } from "../Button";
import { EnvironmentPicker } from "../EnvironmentPicker";
import { TestRunPanel } from "./TestRunPanel";

export interface TestRunHandle {
  /** 섹션으로 스크롤 + 현재 입력값으로 test-run 1회 발사 — 헤더 "미리 1회 실행" 버튼용 (U4 §5.5). */
  runNow(): void;
}

/** Test-run controls + result panel for a scenario editor buffer. Self-contained
 *  unit whose only input is the live `yamlText` — so both the new-scenario page
 *  and the edit page reuse it (works on an unsaved draft; ephemeral, nothing is
 *  persisted). The `steps` parsed from the buffer feed `TestRunPanel`'s if-row
 *  condition summaries (the `ScenarioTrace` wire contract carries no cond text).
 *  ref 핸들(runNow)은 state 리프트 없이 컴포넌트 API만 확장한다 (spec §5.5). */
export const TestRunSection = forwardRef<TestRunHandle, { yamlText: string }>(
  function TestRunSection({ yamlText }, ref) {
    const testRun = useTestRun();
    const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
    const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
    const [maxRequests, setMaxRequests] = useState<number>(50);
    const [applyThinkTime, setApplyThinkTime] = useState(false);
    const selectedEnv = useEnvironment(selectedEnvId ?? undefined);
    const baseVars = selectedEnv.data?.vars ?? {};
    const rootRef = useRef<HTMLElement | null>(null);

    const traceSteps = useMemo<Step[]>(() => {
      const parsed = parseScenarioDoc(yamlText);
      return "model" in parsed ? parsed.model.steps : [];
    }, [yamlText]);

    const fire = () => {
      if (testRun.isPending) return;
      testRun.mutate({
        scenario_yaml: yamlText,
        env: resolveEnv(baseVars, envEntries),
        max_requests: maxRequests,
        apply_think_time: applyThinkTime,
      });
    };

    // deps 없음 — 매 렌더 재생성으로 최신 state 클로저 유지(stale closure 방지).
    useImperativeHandle(ref, () => ({
      runNow() {
        // jsdom은 scrollIntoView 미구현 — optional call
        rootRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        fire();
      },
    }));

    return (
      <>
        <section
          ref={rootRef}
          aria-label="Test run controls"
          className="flex flex-col gap-3 rounded border border-slate-200 p-4"
        >
          <h3 className="text-lg font-semibold">Test run</h3>
          <EnvironmentPicker
            selectedEnvId={selectedEnvId}
            onSelect={setSelectedEnvId}
            baseVars={baseVars}
            overrides={envEntries}
            onOverridesChange={setEnvEntries}
          />
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-600">Max requests</span>
            <input
              type="number"
              min={1}
              max={10000}
              value={maxRequests}
              onChange={(e) => setMaxRequests(Number(e.target.value))}
              className="w-28 rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={applyThinkTime}
              onChange={(e) => setApplyThinkTime(e.target.checked)}
            />
            <span className="text-slate-600">think time 적용 (천천히 전송)</span>
          </label>
          <div>
            <Button onClick={fire} disabled={testRun.isPending}>
              {testRun.isPending ? "Running…" : "Test run"}
            </Button>
          </div>
          {testRun.error && (
            <p className="text-sm text-red-700">{(testRun.error as Error).message}</p>
          )}
        </section>

        {testRun.data && <TestRunPanel trace={testRun.data} steps={traceSteps} />}
      </>
    );
  },
);
