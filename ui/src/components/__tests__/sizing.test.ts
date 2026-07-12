import { describe, it, expect } from "vitest";
import {
  recommendVus,
  pickLatestClosedRun,
  recommendSlots,
  pickLatestOpenRun,
  pickLatestFixedOpenRun,
  peakStageTarget,
  peakThroughput,
  recommendWorkers,
  sizePresetsFor,
  iterationHoldMs,
  iterationRequestRange,
} from "../sizing";
import type { Run } from "../../api/schemas";
import type { Step } from "../../scenario/model";
import { ko } from "../../i18n/ko";

describe("recommendVus", () => {
  it("prior: 선형 스케일 (VU 50→200 RPS, 목표 400 → 100)", () => {
    expect(recommendVus(400, { kind: "prior", priorVus: 50, priorRps: 200 })).toEqual({
      recommendedVus: 100,
      rpsPerVu: 4,
      basis: "prior",
    });
  });

  it("measured: 1요청/250ms → 4 rps/vu, 목표 400 → 100", () => {
    const r = recommendVus(400, { kind: "measured", reqPerIter: 1, iterMs: 250 });
    expect(r?.recommendedVus).toBe(100);
    expect(r?.basis).toBe("measured");
  });

  it("ceil + 최소 1", () => {
    expect(recommendVus(1, { kind: "prior", priorVus: 50, priorRps: 200 })?.recommendedVus).toBe(1);
    expect(recommendVus(401, { kind: "prior", priorVus: 50, priorRps: 200 })?.recommendedVus).toBe(
      101,
    );
  });

  it("가드 → null", () => {
    expect(recommendVus(0, { kind: "prior", priorVus: 50, priorRps: 200 })).toBeNull(); // target<1
    expect(recommendVus(1_000_001, { kind: "prior", priorVus: 50, priorRps: 200 })).toBeNull(); // target>max
    expect(recommendVus(1.5, { kind: "prior", priorVus: 50, priorRps: 200 })).toBeNull(); // 비정수
    expect(recommendVus(400, { kind: "estimate", reqPerIter: 0, iterMs: 250 })).toBeNull(); // rpsPerVu 0
    expect(recommendVus(400, { kind: "measured", reqPerIter: 1, iterMs: 0 })).toBeNull(); // iterMs 0 → Inf
    expect(recommendVus(400, { kind: "prior", priorVus: 0, priorRps: 200 })).toBeNull(); // div0 → Inf
  });
});

describe("pickLatestClosedRun", () => {
  // pickLatestClosedRun이 읽는 필드(status/profile.vus/created_at)만 가진 최소 fixture를 cast.
  const mk = (vus: number, created_at: number, status = "completed"): Run =>
    ({ id: `r${created_at}`, status, profile: { vus }, created_at }) as unknown as Run;

  it("vus>0인 completed 중 최신 선택 (vus==0=open/curve, 비완료 제외)", () => {
    const runs = [
      mk(10, 100),
      mk(50, 300),
      mk(0, 400), // open-loop 또는 VU곡선 → 제외
      mk(20, 500, "running"), // 비완료 → 제외
    ];
    expect(pickLatestClosedRun(runs)?.profile.vus).toBe(50);
  });

  it("해당 run 없으면 null", () => {
    expect(pickLatestClosedRun([mk(0, 1), mk(5, 2, "failed")])).toBeNull();
  });
});

describe("recommendSlots", () => {
  it("단일-스텝 정확값: 1000 RPS × 50ms = 50슬롯", () => {
    expect(recommendSlots(1000, 50)).toEqual({ recommendedSlots: 50 });
  });

  it("200 RPS × 250ms = 50슬롯", () => {
    expect(recommendSlots(200, 250)?.recommendedSlots).toBe(50);
  });

  it("insight 수식 동치: ceil(target × p50/1000), 최소 1", () => {
    // 2000 RPS × 53ms = 106 (= insights.rs:224 required)
    expect(recommendSlots(2000, 53)?.recommendedSlots).toBe(106);
    // floor: 아주 작은 곱도 최소 1
    expect(recommendSlots(1, 1)?.recommendedSlots).toBe(1);
    expect(recommendSlots(1, 0.4)?.recommendedSlots).toBe(1);
  });

  it("가드 → null", () => {
    expect(recommendSlots(0, 50)).toBeNull(); // target < 1
    expect(recommendSlots(1_000_001, 50)).toBeNull(); // target > max
    expect(recommendSlots(1.5, 50)).toBeNull(); // 비정수 target
    expect(recommendSlots(1000, 0)).toBeNull(); // latency 0
    expect(recommendSlots(1000, -5)).toBeNull(); // latency 음수
    expect(recommendSlots(1000, NaN)).toBeNull(); // latency NaN
    expect(recommendSlots(1000, Infinity)).toBeNull(); // latency Inf
  });
});

describe("pickLatestOpenRun", () => {
  // pickLatestOpenRun이 읽는 필드(status/profile.target_rps/profile.stages/created_at)만 가진 최소 fixture.
  const mk = (profile: Record<string, unknown>, created_at: number, status = "completed"): Run =>
    ({ id: `r${created_at}`, status, profile, created_at }) as unknown as Run;

  it("open-loop(target_rps) completed 중 최신 선택", () => {
    const runs = [
      mk({ target_rps: 100, max_in_flight: 50 }, 100),
      mk({ target_rps: 200, max_in_flight: 80 }, 300), // 최신 open
      mk({ vus: 5 }, 400), // closed+fixed → 제외
      mk({ target_rps: 50, max_in_flight: 10 }, 500, "running"), // 비완료 → 제외
    ];
    expect(pickLatestOpenRun(runs)?.created_at).toBe(300);
  });

  it("open-loop(stages, target_rps 없음)도 포함", () => {
    const runs = [mk({ stages: [{ target: 100, duration_seconds: 10 }], max_in_flight: 50 }, 200)];
    expect(pickLatestOpenRun(runs)?.created_at).toBe(200);
  });

  it("closed+fixed가 stray max_in_flight를 달고 있어도 제외(양성 식)", () => {
    // is_open_loop는 max_in_flight를 안 보고 target_rps/stages만 본다.
    const runs = [mk({ vus: 5, max_in_flight: 999 }, 100)];
    expect(pickLatestOpenRun(runs)).toBeNull();
  });

  it("VU곡선(vu_stages, target_rps/stages 없음) 제외", () => {
    const runs = [mk({ vus: 0, vu_stages: [{ target: 10, duration_seconds: 5 }] }, 100)];
    expect(pickLatestOpenRun(runs)).toBeNull();
  });

  it("해당 run 없으면 null", () => {
    expect(pickLatestOpenRun([mk({ vus: 5 }, 1), mk({ target_rps: 10 }, 2, "failed")])).toBeNull();
  });
});

describe("peakStageTarget", () => {
  it("빈 배열 → null", () => {
    expect(peakStageTarget([])).toBeNull();
  });

  it("전부 무효(빈/문자/0/소수/범위초과) → null", () => {
    expect(
      peakStageTarget([
        { target: "" },
        { target: "abc" },
        { target: "0" },
        { target: "1.5" },
        { target: "2000000" },
      ]),
    ).toBeNull();
  });

  it("혼합(유효+무효) → 유효 후보 중 최대", () => {
    expect(
      peakStageTarget([{ target: "50" }, { target: "abc" }, { target: "200" }, { target: "100" }]),
    ).toBe(200);
  });

  it("단일 유효 → 그 값", () => {
    expect(peakStageTarget([{ target: "120" }])).toBe(120);
  });

  it("정렬 무관(내림차순도 동일 결과)", () => {
    expect(peakStageTarget([{ target: "300" }, { target: "10" }])).toBe(300);
  });

  it("경계: 1 / 1000000 포함, 1000001 제외", () => {
    expect(peakStageTarget([{ target: "1" }])).toBe(1);
    expect(peakStageTarget([{ target: "1000000" }])).toBe(1000000);
    expect(peakStageTarget([{ target: "1000001" }])).toBeNull();
  });

  it("parity: peak → recommendSlots가 insight 수식(ceil(target×p50/1000))과 동일", () => {
    // 단계 목표 50→200 → peak 200; insights.rs:224 required = ceil(200×250/1000)=50.
    const peak = peakStageTarget([{ target: "50" }, { target: "200" }]);
    expect(peak).toBe(200);
    expect(recommendSlots(peak as number, 250)?.recommendedSlots).toBe(50);
  });
});

describe("peakThroughput", () => {
  it("빈 배열 → 0", () => {
    expect(peakThroughput([])).toBe(0);
  });

  it("초별 Σcount의 최대 (평균/총합 아님 — insights.rs by_sec와 동형)", () => {
    // ts1 합=4, ts2 합=5+4=9 (peak), ts3 합=3
    expect(
      peakThroughput([
        { ts_second: 1, count: 4 },
        { ts_second: 2, count: 5 },
        { ts_second: 2, count: 4 },
        { ts_second: 3, count: 3 },
      ]),
    ).toBe(9);
  });

  it("단일 초 여러 스텝 행 → 그 초 합", () => {
    expect(
      peakThroughput([
        { ts_second: 7, count: 100 },
        { ts_second: 7, count: 50 },
      ]),
    ).toBe(150);
  });

  it("정렬 무관", () => {
    expect(
      peakThroughput([
        { ts_second: 3, count: 3 },
        { ts_second: 1, count: 9 },
        { ts_second: 2, count: 5 },
      ]),
    ).toBe(9);
  });
});

describe("recommendWorkers (분모=달성 도착률, ADR-0046 R10)", () => {
  it("기본: ceil(target × wc / achieved)", () => {
    // target 2000, achieved 790, wc 2 → ceil(4000/790)=ceil(5.06)=6
    expect(recommendWorkers(2000, 790, 2)?.recommendedWorkers).toBe(6);
  });

  it("단일 워커 prior", () => {
    // target 1000, achieved 200, wc 1 → ceil(5)=5
    expect(recommendWorkers(1000, 200, 1)?.recommendedWorkers).toBe(5);
  });

  it("floor 1 (target 작아 0이 안 됨)", () => {
    expect(recommendWorkers(10, 1000, 1)?.recommendedWorkers).toBe(1);
  });

  it("무효: 목표 무효(0·비정수·범위 밖) → null", () => {
    expect(recommendWorkers(0, 200, 1)).toBeNull();
    expect(recommendWorkers(1.5, 200, 1)).toBeNull();
    expect(recommendWorkers(2_000_000, 200, 1)).toBeNull();
  });

  it("무효: achieved <= 0 / NaN / Inf → null", () => {
    expect(recommendWorkers(1000, 0, 1)).toBeNull();
    expect(recommendWorkers(1000, -5, 1)).toBeNull();
    expect(recommendWorkers(1000, NaN, 1)).toBeNull();
    expect(recommendWorkers(1000, Infinity, 1)).toBeNull();
  });

  it("무효: prior_wc < 1 또는 비정수 → null", () => {
    expect(recommendWorkers(1000, 200, 0)).toBeNull();
    expect(recommendWorkers(1000, 200, 1.5)).toBeNull();
  });

  it("대수적 동치: ceil(t×wc/achieved) == ceil(t/(achieved/wc))", () => {
    // IEEE-754에선 항상 bit-identical은 아니다 — 이 값(2000/790/2 → 둘 다 6)에선 일치(값 특정 단언).
    const t = 2000;
    const achieved = 790;
    const wc = 2;
    const altForm = Math.ceil(t / (achieved / wc));
    expect(recommendWorkers(t, achieved, wc)?.recommendedWorkers).toBe(altForm);
  });
});

describe("sizePresetsFor", () => {
  it("anchor null → 기존 고정 3개(ko.loadModel.sizePresets)와 deep-equal", () => {
    expect(sizePresetsFor(null)).toEqual(ko.loadModel.sizePresets);
  });

  it("anchor null → 반환값은 원본과 별개의 배열(참조 동일 아님, mutable 복사본)", () => {
    const result = sizePresetsFor(null);
    expect(result).not.toBe(ko.loadModel.sizePresets);
  });

  it("anchor 있음 → 0.5×/1×/2× 계산 (VU 20·60초 기준)", () => {
    expect(sizePresetsFor({ vus: 20, durationSeconds: 60 })).toEqual([
      { label: "10명 · 30초", vus: 10, durationSeconds: 30 },
      { label: "20명 · 1분", vus: 20, durationSeconds: 60 },
      { label: "40명 · 2분", vus: 40, durationSeconds: 120 },
    ]);
  });

  it("최소 1 클램프 + 중복 collapse (VU 1·1초 기준 → 0.5×/1× 모두 1로 겹쳐 2개만)", () => {
    expect(sizePresetsFor({ vus: 1, durationSeconds: 1 })).toEqual([
      { label: "1명 · 1초", vus: 1, durationSeconds: 1 },
      { label: "2명 · 2초", vus: 2, durationSeconds: 2 },
    ]);
  });

  it("반올림 (VU 7·13초 기준 → 0.5×=3.5→4명/6.5→7초, 2×=14명/26초)", () => {
    expect(sizePresetsFor({ vus: 7, durationSeconds: 13 })).toEqual([
      { label: "4명 · 7초", vus: 4, durationSeconds: 7 },
      { label: "7명 · 13초", vus: 7, durationSeconds: 13 },
      { label: "14명 · 26초", vus: 14, durationSeconds: 26 },
    ]);
  });
});

// http() 캐스트는 기존 pickLatestClosedRun/pickLatestOpenRun의 `as unknown as Run` fixture
// 관행과 동형 — 여기선 최소 Step 필드만 채운 뒤 Step으로 캐스트.
const http = (id: string, think?: { min_ms: number; max_ms: number }): Step =>
  ({
    type: "http",
    id,
    name: id,
    request: { method: "GET", url: "/x" },
    ...(think ? { think_time: think } : {}),
  }) as unknown as Step;

describe("iterationHoldMs (R7)", () => {
  const p50 = new Map([
    ["a", 100],
    ["b", 200],
  ]);
  it("flat: Σ(p50 + think평균), 미관측 스텝은 fallback", () => {
    // a=100 + think(500+1500)/2=1000 → 1100; b=200; c(미관측)=fallback 50 → 합 1350
    const steps = [http("a", { min_ms: 500, max_ms: 1500 }), http("b"), http("c")];
    expect(iterationHoldMs(steps, p50, 50)).toBe(1350);
  });
  it("loop: repeat 배수", () => {
    const steps = [
      { type: "loop", id: "L", name: "L", repeat: 3, do: [http("a")] } as unknown as Step,
    ];
    expect(iterationHoldMs(steps, p50, 50)).toBe(300);
  });
  it("if/parallel: 분기 max", () => {
    const ifStep = {
      type: "if",
      id: "I",
      name: "I",
      cond: {},
      then: [http("a")],
      elif: [],
      else: [http("b")],
    } as unknown as Step;
    expect(iterationHoldMs([ifStep], p50, 50)).toBe(200); // max(100, 200)
    const par = {
      type: "parallel",
      id: "P",
      name: "P",
      branches: [
        { name: "x", steps: [http("a")] },
        { name: "y", steps: [http("b")] },
      ],
    } as unknown as Step;
    expect(iterationHoldMs([par], p50, 50)).toBe(200);
  });
  it("http leaf 0개면 0", () => expect(iterationHoldMs([], p50, 50)).toBe(0));
});

describe("iterationHoldMs — 시나리오 기본 think time (R15)", () => {
  const p50 = new Map([
    ["a", 100],
    ["b", 200],
  ]);
  it("상속 스텝엔 기본값 평균이 더해지고, 스텝 명시값이 이긴다", () => {
    const steps = [http("a"), http("b", { min_ms: 0, max_ms: 0 })];
    expect(iterationHoldMs(steps, p50, 50)).toBe(300); // 기본값 없음: 100 + 200
    // 기본값 200/400(평균 300): a는 상속(+300), b는 {0,0} 명시 → 대기 0
    expect(iterationHoldMs(steps, p50, 50, { min_ms: 200, max_ms: 400 })).toBe(600);
  });
  it("parallel 분기 안 스텝엔 기본값이 적용되지 않는다 (엔진 R4 미러)", () => {
    const par = {
      type: "parallel",
      id: "P",
      name: "P",
      branches: [{ name: "x", steps: [http("a")] }],
    } as unknown as Step;
    const steps = [par, http("b")];
    expect(iterationHoldMs(steps, p50, 50)).toBe(300); // 기본값 없음: max(a=100) + b=200
    // 기본값 500/500: 분기 a엔 미적용(100 유지), 최상위 b에만 +500 → 100 + 700 = 800
    expect(iterationHoldMs(steps, p50, 50, { min_ms: 500, max_ms: 500 })).toBe(800);
  });
});

describe("iterationRequestRange (ADR-0046 ②)", () => {
  it("flat http 2개 → {2,2}", () => {
    expect(iterationRequestRange([http("a"), http("b")])).toEqual({ min: 2, max: 2 });
  });
  it("loop repeat 3 × (http 2개) → {6,6}", () => {
    const steps = [
      {
        type: "loop",
        id: "L",
        name: "L",
        repeat: 3,
        do: [http("a"), http("b")],
      } as unknown as Step,
    ];
    expect(iterationRequestRange(steps)).toEqual({ min: 6, max: 6 });
  });
  it("if(then 2건·elif 1건·else 빈 배열) → {0,2} — else 무요청이 min", () => {
    const ifStep = {
      type: "if",
      id: "I",
      name: "I",
      cond: {},
      then: [http("a"), http("b")],
      elif: [{ cond: {}, then: [http("c")] }],
      else: [],
    } as unknown as Step;
    expect(iterationRequestRange([ifStep])).toEqual({ min: 0, max: 2 });
  });
  it("parallel은 분기 '합'(전 분기 동시 실행 — 시간 walk의 max와 다름) — 2분기(2건·3건) → {5,5}", () => {
    const par = {
      type: "parallel",
      id: "P",
      name: "P",
      branches: [
        { name: "x", steps: [http("a"), http("b")] },
        { name: "y", steps: [http("c"), http("d"), http("e")] },
      ],
    } as unknown as Step;
    expect(iterationRequestRange([par])).toEqual({ min: 5, max: 5 });
  });
  it("http leaf 0개 → {0,0} (호출부 skip 신호)", () => {
    expect(iterationRequestRange([])).toEqual({ min: 0, max: 0 });
  });
  it("혼합: http 1 + if(then 1건/else 빈) → {1,2}", () => {
    const ifStep = {
      type: "if",
      id: "I2",
      name: "I2",
      cond: {},
      then: [http("b")],
      elif: [],
      else: [],
    } as unknown as Step;
    expect(iterationRequestRange([http("a"), ifStep])).toEqual({ min: 1, max: 2 });
  });
});

describe("pickLatestFixedOpenRun (R10 — 곡선 prior 제외)", () => {
  it("target_rps 있는 completed run만", () => {
    const runs = [
      { id: "1", status: "completed", created_at: 1, profile: { vus: 0, target_rps: 10 } },
      {
        id: "2",
        status: "completed",
        created_at: 2,
        profile: { vus: 0, stages: [{ target: 5, duration_seconds: 10 }] },
      },
    ] as never[];
    expect(pickLatestFixedOpenRun(runs)?.id).toBe("1"); // 곡선(2)은 제외
  });
});
