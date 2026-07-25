import { beforeEach, describe, expect, it } from "vitest";
import {
  DRAFT_KEY,
  adoptDraftBucket,
  executionFingerprint,
  fingerprintHash,
  recordVerified,
  testRunStateFor,
} from "../trustPrefs";
import {
  BranchModel,
  ElifBranchModel,
  HttpStepModel,
  IfStepModel,
  LoopStepModel,
  NestedElifBranchModel,
  NestedIfStepModel,
  NestedLoopStepModel,
  ParallelStepModel,
  RequestModel,
  ScenarioModel,
  type Scenario,
} from "../model";

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

/**
 * 기준 요청 — 빌더 기본값과 아래 변형(URL·method)이 **같은 헤더 집합**을 공유해야
 * 그 변형 테스트가 검증 대상 필드 하나만 실제로 검증한다(T3 fold의 격리). 이 리터럴을
 * 세 곳에 복붙해 두면 빌더 기본값을 바꿀 때 두 테스트에서 동시에 격리가 조용히 깨진다.
 * 순수 객체 리터럴의 spread라 픽스처 규약(파싱된 `Step` union 멤버 사후 변형 금지)에
 * 저촉되지 않는다 — 빌더 *입력*을 조립하는 것뿐이다.
 */
const baseRequest = { method: "GET", url: "https://e.test/a", headers: { X: "1", A: "2" } };

function step(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `s-${id.slice(-1)}`,
    type: "http",
    request: { ...baseRequest },
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
    // 통과해버려 URL 자체는 아무것도 증명하지 못한다). `baseRequest` spread가 그 격리를
    // 구조적으로 보장한다.
    const u = sc({
      steps: [step(A, { request: { ...baseRequest, url: "https://e.test/CHANGED" } })],
    });
    expect(executionFingerprint(u)).not.toBe(executionFingerprint(base()));
  });
  it("method", () => {
    const p = sc({ steps: [step(A, { request: { ...baseRequest, method: "POST" } })] });
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

// ── 버킷 상한 축출 ────────────────────────────────────────────────────────
// 상한 값은 모듈 private다(export하지 않는다) — 여기서 미러하며, 값이 바뀌면 이 블록도 갱신.
const BUCKET_CAP = 50;
const STORAGE_KEY = "handicap:trust-testrun:v1";

function readStore(): Record<string, number[] | undefined> {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<
    string,
    number[] | undefined
  >;
}

/** localStorage에 버킷을 직접 심는다 — 다른 탭/옛 빌드가 남긴 **상한 초과** 저장소를
 *  재현하기 위한 것(현재 모듈의 쓰기 경로만으로는 상한을 넘길 수 없다). */
function seedBuckets(n: number, extra: string[] = []): void {
  const b: Record<string, number[]> = {};
  for (let i = 0; i < n; i += 1) b[`SC_${i}`] = [i + 1];
  for (const k of extra) b[k] = [999];
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
}

describe("버킷 상한 축출", () => {
  it("가장 오래 쓰지 않은 버킷을 버린다 — 방금 기록한 버킷은 살아남는다", () => {
    // 정확히 상한까지 채운다(축출 없음).
    for (let i = 0; i < BUCKET_CAP; i += 1) recordVerified(`SC_${i}`, i + 1);
    expect(Object.keys(readStore())).toHaveLength(BUCKET_CAP);

    // 가장 먼저 만들어진 버킷을 **다시** 기록 → 이제 가장 최근 쓰기다.
    recordVerified("SC_0", 12345);
    // 새 시나리오 하나를 더하면 상한을 넘겨 하나를 버려야 한다.
    recordVerified("SC_NEW", 777);

    const store = readStore();
    expect(Object.keys(store)).toHaveLength(BUCKET_CAP);
    // 삽입 순서(=최초 쓰기 순서)로 버리면 방금 재기록한 SC_0이 희생된다 — 회귀 가드.
    expect(store["SC_0"]).toContain(12345);
    expect(store["SC_NEW"]).toContain(777);
    expect(store["SC_1"]).toBeUndefined();
  });

  it("상한을 넘긴 저장소에서 가장 오래된 버킷에 기록해도 그 기록이 사라지지 않는다", () => {
    seedBuckets(BUCKET_CAP + 1); // SC_0 … SC_50
    recordVerified("SC_0", 4242);
    const store = readStore();
    // 재할당은 삽입 순서를 옮기지 않으므로, 지우지 않으면 방금 쓴 SC_0이 축출 대상에 든다.
    expect(store["SC_0"]).toContain(4242);
    expect(Object.keys(store)).toHaveLength(BUCKET_CAP);
  });

  it("adoptDraftBucket도 상한을 적용한다", () => {
    seedBuckets(BUCKET_CAP, [DRAFT_KEY]); // 상한 초과 상태(51) — 이관은 순증 0이 아니다
    adoptDraftBucket("SC_NEW");
    const store = readStore();
    expect(Object.keys(store).length).toBeLessThanOrEqual(BUCKET_CAP);
    expect(store["SC_NEW"]).toEqual([999]);
    expect(store[DRAFT_KEY]).toBeUndefined();
  });
});

// ── 지문 필드 커버리지 핀 ────────────────────────────────────────────────
// `canonStep`/`executionFingerprint`는 모델 필드를 **하나씩 열거**하므로, 기존 arm에
// 새 필드가 추가되면 컴파일도 기존 테스트도 통과한 채 지문에서 조용히 빠진다
// (= 실행 표면이 바뀌었는데도 영구 `verified` — 이 기능 최악의 실패 모드).
// **이 테스트가 깨졌다면**: 새 필드가 지문에 들어가야 하는지 먼저 결정하고
// (test-run이 그 필드를 실제로 행사하는가? — `timeout_seconds` 판정 선례 참고)
// `trustPrefs.ts`를 갱신한 뒤 아래 목록을 고칠 것.
// 배열/union으로 통째 직렬화되는 필드(assert·extract·cond·body.value)는 새 키가 자동
// 반영되므로 목록에 없다 — 여기 있는 건 필드별로 열거되는 객체들뿐이다.
const FINGERPRINT_SHAPES: Array<{ model: string; shape: object; keys: string[] }> = [
  {
    model: "RequestModel",
    shape: RequestModel.shape,
    keys: ["body", "disabled", "headers", "method", "url"],
  },
  {
    model: "HttpStepModel",
    shape: HttpStepModel.shape,
    keys: ["assert", "extract", "id", "name", "request", "think_time", "timeout_seconds", "type"],
  },
  {
    model: "LoopStepModel",
    shape: LoopStepModel.shape,
    keys: ["do", "id", "name", "repeat", "type"],
  },
  {
    model: "NestedLoopStepModel",
    shape: NestedLoopStepModel.shape,
    keys: ["do", "id", "name", "repeat", "type"],
  },
  {
    model: "IfStepModel",
    shape: IfStepModel.shape,
    keys: ["cond", "elif", "else", "id", "name", "then", "type"],
  },
  {
    model: "NestedIfStepModel",
    shape: NestedIfStepModel.shape,
    keys: ["cond", "elif", "else", "id", "name", "then", "type"],
  },
  { model: "ElifBranchModel", shape: ElifBranchModel.shape, keys: ["cond", "then"] },
  { model: "NestedElifBranchModel", shape: NestedElifBranchModel.shape, keys: ["cond", "then"] },
  { model: "BranchModel", shape: BranchModel.shape, keys: ["name", "steps"] },
  {
    model: "ParallelStepModel",
    shape: ParallelStepModel.shape,
    keys: ["branches", "id", "name", "type"],
  },
  {
    model: "ScenarioModel",
    shape: ScenarioModel.shape,
    keys: ["cookie_jar", "default_think_time", "name", "notes", "steps", "variables", "version"],
  },
];

describe("지문 필드 커버리지 핀", () => {
  it.each(FINGERPRINT_SHAPES)("$model 필드 집합이 고정돼 있다", ({ shape, keys }) => {
    expect(Object.keys(shape).sort()).toEqual(keys);
  });
});
