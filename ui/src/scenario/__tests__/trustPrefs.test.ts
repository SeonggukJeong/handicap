import { beforeEach, describe, expect, it } from "vitest";
import {
  DRAFT_KEY,
  adoptDraftBucket,
  executionFingerprint,
  fingerprintHash,
  recordVerified,
  testRunStateFor,
} from "../trustPrefs";
import { ScenarioModel, type Scenario } from "../model";

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA";
const B = "01HZZZZZZZZZZZZZZZZZZZZZZB";
const C = "01HZZZZZZZZZZZZZZZZZZZZZZC";

function sc(over: Record<string, unknown> = {}): Scenario {
  return ScenarioModel.parse({
    version: 1,
    name: "t",
    cookie_jar: "auto",
    variables: {},
    steps: [],
    ...over,
  });
}

function step(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `s-${id.slice(-1)}`,
    type: "http",
    request: { method: "GET", url: "https://e.test/a", headers: { X: "1", A: "2" } },
    assert: [],
    extract: [],
    ...over,
  };
}

/** 기준 시나리오 — 모든 비교의 baseline. */
const base = () => sc({ steps: [step(A)] });

beforeEach(() => {
  window.localStorage.clear();
});

describe("executionFingerprint — 무효화하지 않아야 하는 변경", () => {
  it("시나리오 이름", () => {
    expect(executionFingerprint(sc({ name: "other", steps: [step(A)] }))).toBe(
      executionFingerprint(base()),
    );
  });
  it("공유 메모(notes)", () => {
    expect(executionFingerprint(sc({ notes: "hello", steps: [step(A)] }))).toBe(
      executionFingerprint(base()),
    );
  });
  it("스텝 이름", () => {
    expect(executionFingerprint(sc({ steps: [step(A, { name: "renamed" })] }))).toBe(
      executionFingerprint(base()),
    );
  });
  it("스텝 id", () => {
    expect(executionFingerprint(sc({ steps: [step(B)] }))).toBe(executionFingerprint(base()));
  });
  it("헤더 키 순서 (엔진은 BTreeMap이라 순서 무영향)", () => {
    const swapped = sc({
      steps: [
        step(A, {
          request: { method: "GET", url: "https://e.test/a", headers: { A: "2", X: "1" } },
        }),
      ],
    });
    expect(executionFingerprint(swapped)).toBe(executionFingerprint(base()));
  });
  it("중첩 JSON 바디 객체의 키 순서 (정렬은 재귀여야 한다)", () => {
    const mk = (body: unknown) =>
      executionFingerprint(
        sc({
          steps: [
            step(A, {
              request: {
                method: "POST",
                url: "https://e.test/a",
                headers: {},
                body: { kind: "json", value: body },
              },
            }),
          ],
        }),
      );
    expect(mk({ outer: { p: 1, q: 2 } })).toBe(mk({ outer: { q: 2, p: 1 } }));
  });
  it("think time (test-run이 기본으로 행사하지 않는다)", () => {
    expect(
      executionFingerprint(sc({ steps: [step(A, { think_time: { min_ms: 100, max_ms: 200 } })] })),
    ).toBe(executionFingerprint(base()));
  });
  it("disabled (엔진이 절대 읽지 않는다)", () => {
    const d = sc({
      steps: [
        step(A, {
          request: {
            method: "GET",
            url: "https://e.test/a",
            headers: { X: "1", A: "2" },
            disabled: { headers: { Z: "off" } },
          },
        }),
      ],
    });
    expect(executionFingerprint(d)).toBe(executionFingerprint(base()));
  });
});

describe("executionFingerprint — 무효화해야 하는 변경", () => {
  it("URL", () => {
    // 헤더는 baseline과 동일하게 유지 — URL만 바뀌어야 이 테스트가 URL 필드를
    // 실제로 지문에 검증한다(헤더까지 같이 바뀌면 canonRecord 세그먼트 차이로도
    // 통과해버려 URL 자체는 아무것도 증명하지 못한다).
    const u = sc({
      steps: [
        step(A, {
          request: {
            method: "GET",
            url: "https://e.test/CHANGED",
            headers: { X: "1", A: "2" },
          },
        }),
      ],
    });
    expect(executionFingerprint(u)).not.toBe(executionFingerprint(base()));
  });
  it("method", () => {
    const p = sc({
      steps: [
        step(A, {
          request: { method: "POST", url: "https://e.test/a", headers: { X: "1", A: "2" } },
        }),
      ],
    });
    expect(executionFingerprint(p)).not.toBe(executionFingerprint(base()));
  });
  it("timeout_seconds (test-run이 실제로 적용한다 — executor.rs:392 execute_step_traced)", () => {
    const t = sc({ steps: [step(A, { timeout_seconds: 5 })] });
    expect(executionFingerprint(t)).not.toBe(executionFingerprint(base()));
  });
  it("loop.repeat", () => {
    const mk = (repeat: number) =>
      executionFingerprint(
        sc({
          steps: [
            {
              id: A,
              name: "l",
              type: "loop",
              repeat,
              do: [step(B, { request: { method: "GET", url: "https://e.test/b", headers: {} } })],
            },
          ],
        }),
      );
    expect(mk(2)).not.toBe(mk(3));
  });
  it("http body 값 변경 (키 순서가 아니라 값 자체)", () => {
    const mk = (p: number) =>
      executionFingerprint(
        sc({
          steps: [
            step(A, {
              request: {
                method: "POST",
                url: "https://e.test/a",
                headers: {},
                body: { kind: "json", value: { outer: { p } } },
              },
            }),
          ],
        }),
      );
    expect(mk(1)).not.toBe(mk(2));
  });
  it("if.cond", () => {
    const mk = (right: string) =>
      executionFingerprint(
        sc({
          variables: { v: "1" },
          steps: [
            {
              id: A,
              name: "i",
              type: "if",
              cond: { left: "{{v}}", op: "eq", right },
              then: [step(B, { request: { method: "GET", url: "https://e.test/x", headers: {} } })],
              elif: [],
              else: [],
            },
          ],
        }),
      );
    expect(mk("1")).not.toBe(mk("2"));
  });
  it("assert 추가", () => {
    expect(
      executionFingerprint(sc({ steps: [step(A, { assert: [{ kind: "status", code: 200 }] })] })),
    ).not.toBe(executionFingerprint(base()));
  });
  it("스텝 순서", () => {
    const ab = sc({
      steps: [
        step(A),
        step(B, { request: { method: "GET", url: "https://e.test/b", headers: {} } }),
      ],
    });
    const ba = sc({
      steps: [
        step(B, { request: { method: "GET", url: "https://e.test/b", headers: {} } }),
        step(A),
      ],
    });
    expect(executionFingerprint(ab)).not.toBe(executionFingerprint(ba));
  });

  /** if 분기 정체성 — **then은 min(1)이라 비울 수 없다**(model.ts:199).
   *  그래서 두 스텝을 준비해 배치만 바꾼다: then=[X,Y]/else=[] vs then=[X]/else=[Y]. */
  const ifScenario = (bothInThen: boolean) => {
    const X = step(B, { request: { method: "GET", url: "https://e.test/x", headers: {} } });
    const Y = step(C, { request: { method: "GET", url: "https://e.test/y", headers: {} } });
    return executionFingerprint(
      sc({
        variables: { v: "1" },
        steps: [
          {
            id: A,
            name: "i",
            type: "if",
            cond: { left: "{{v}}", op: "eq", right: "1" },
            then: bothInThen ? [X, Y] : [X],
            elif: [],
            else: bothInThen ? [] : [Y],
          },
        ],
      }),
    );
  };

  it("if 분기 정체성 — 같은 스텝이 then에 있는지 else에 있는지로 달라진다", () => {
    expect(ifScenario(true)).not.toBe(ifScenario(false));
  });

  it("elif 순서", () => {
    const mk = (swap: boolean) => {
      const e1 = {
        cond: { left: "{{v}}", op: "eq", right: "1" },
        then: [step(B, { request: { method: "GET", url: "https://e.test/x", headers: {} } })],
      };
      const e2 = {
        cond: { left: "{{v}}", op: "eq", right: "2" },
        then: [step(C, { request: { method: "GET", url: "https://e.test/y", headers: {} } })],
      };
      return executionFingerprint(
        sc({
          variables: { v: "1" },
          steps: [
            {
              id: A,
              name: "i",
              type: "if",
              cond: { left: "{{v}}", op: "eq", right: "0" },
              then: [step(B, { request: { method: "GET", url: "https://e.test/t", headers: {} } })],
              elif: swap ? [e2, e1] : [e1, e2],
              else: [],
            },
          ],
        }),
      );
    };
    expect(mk(true)).not.toBe(mk(false));
  });

  it("parallel 분기 이름 (네임스페이스 의미 변경)", () => {
    const mk = (branch: string) =>
      executionFingerprint(
        sc({
          steps: [
            { id: A, name: "p", type: "parallel", branches: [{ name: branch, steps: [step(B)] }] },
          ],
        }),
      );
    expect(mk("b1")).not.toBe(mk("b2"));
  });
});

describe("버킷 3상태 + 이관", () => {
  const changed = () =>
    sc({
      steps: [step(A, { request: { method: "GET", url: "https://e.test/CHANGED", headers: {} } })],
    });

  it("기록이 없으면 never", () => {
    expect(testRunStateFor("SC1", base())).toBe("never");
  });

  it("다른 시나리오를 기록해도 이 시나리오는 여전히 never (US4 회귀 가드)", () => {
    recordVerified("SC_OTHER", fingerprintHash(base()));
    expect(testRunStateFor("SC1", base())).toBe("never");
  });

  it("현재 지문이 버킷에 있으면 verified", () => {
    recordVerified("SC1", fingerprintHash(base()));
    expect(testRunStateFor("SC1", base())).toBe("verified");
  });

  it("기록 후 실행 표면이 바뀌면 stale", () => {
    recordVerified("SC1", fingerprintHash(base()));
    expect(testRunStateFor("SC1", changed())).toBe("stale");
  });

  it("스텝 이름만 바꾸면 verified 유지 (US4)", () => {
    recordVerified("SC1", fingerprintHash(base()));
    expect(testRunStateFor("SC1", sc({ steps: [step(A, { name: "renamed" })] }))).toBe("verified");
  });

  it("adoptDraftBucket — 드래프트 기록이 새 id로 이관된다", () => {
    recordVerified(DRAFT_KEY, fingerprintHash(base()));
    adoptDraftBucket("SC_NEW");
    expect(testRunStateFor("SC_NEW", base())).toBe("verified");
    expect(testRunStateFor(DRAFT_KEY, base())).toBe("never");
  });

  it("localStorage가 깨져 있어도 never로 fail-soft", () => {
    window.localStorage.setItem("handicap:trust-testrun:v1", "{not json");
    expect(testRunStateFor("SC1", base())).toBe("never");
  });
});
