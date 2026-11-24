import { describe, expect, it } from "vitest";
import { ReportSchema, type Report } from "../../../api/schemas";
import { buildRunModel, type RunModel } from "../runModel";
import { buildFairness, deepEqualLoose, stripScenarioNames, type Fairness } from "../fairness";
import type { RunMeta } from "../pair";
import { baseProfile, mkMeta, mkReport, scenarioYaml, type StepSpec } from "./fixtures";

const STEPS: StepSpec[] = [
  { id: "s1", name: "로그인" },
  { id: "s2", name: "조회" },
];

type Opts = {
  profile?: Record<string, unknown>;
  env?: Record<string, string> | null;
  yaml?: string;
  meta?: Partial<RunMeta>;
  status?: RunMeta["status"];
  basis?: Report["basis"];
  sample?: Report["sample"];
  statusRule?: 1 | 2;
};

function model(id: string, o: Opts = {}): RunModel {
  const report = mkReport({
    id,
    steps: [
      { id: "s1", counts: { "200": 10 }, errors: 0 },
      { id: "s2", counts: { "200": 10 }, errors: 0 },
    ],
    yaml: o.yaml ?? scenarioYaml(STEPS),
    profile: o.profile,
    env: o.env,
    status: o.status,
    basis: o.basis,
    sample: o.sample,
    statusRule: o.statusRule,
  });
  expect(ReportSchema.safeParse(report).success).toBe(true);
  return buildRunModel(mkMeta(id, { status: o.status ?? "completed", ...o.meta }), report);
}

function expectDiffersWhenTextDiffers(f: Fairness): void {
  for (const r of f.condRows) {
    if (r.before !== r.after) expect(r.differs, `${r.label}: ${r.before} / ${r.after}`).toBe(true);
  }
}

function expectTextDiffersWhenDiffers(f: Fairness): void {
  for (const r of f.condRows) {
    if (!r.differs) continue;
    const valueless = r.before === "다름" && r.after === "다름";
    expect(valueless || r.before !== r.after, `${r.label}: ${r.before} / ${r.after}`).toBe(true);
  }
}

const fair = (a: Opts = {}, b: Opts = {}): Fairness => {
  const f = buildFairness(model("b", a), model("a", b));
  expectDiffersWhenTextDiffers(f);
  expectTextDiffersWhenDiffers(f);
  return f;
};
const card = (f: Fairness, key: string) => {
  const c = f.cards.find((x) => x.key === key);
  if (!c) throw new Error(`no card ${key}`);
  return c;
};
const prof = (over: Record<string, unknown>) => ({ ...baseProfile, ...over });

describe("deepEqualLoose / stripScenarioNames", () => {
  it("null·undefined·키 없음은 같고 객체 키 순서는 무시, 배열 순서는 유지한다", () => {
    expect(deepEqualLoose({ a: 1, b: null }, { a: 1 })).toBe(true);
    expect(deepEqualLoose({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqualLoose([1, 2], [2, 1])).toBe(false);
    expect(deepEqualLoose({ a: 1 }, { a: 2 })).toBe(false);
  });
  it("최상위와 단계 객체의 name·notes만 지운다", () => {
    const out = stripScenarioNames({
      name: "x",
      notes: "n",
      default_think_time: 5,
      steps: [
        {
          name: "s",
          notes: "t",
          request: { body: { name: "keep" } },
          extract: [{ name: "tok" }],
        },
        {
          type: "parallel",
          name: "p",
          branches: [{ name: "br", steps: [{ name: "inner", request: {} }] }],
        },
        {
          type: "if",
          name: "i",
          then: [{ name: "t1" }],
          elif: [{ then: [{ name: "t2" }] }],
          else: [{ name: "e1" }],
        },
        { type: "loop", name: "l", do: [{ name: "inner", notes: "m", request: {} }] },
      ],
    });
    expect(out).toEqual({
      default_think_time: 5,
      steps: [
        { request: { body: { name: "keep" } }, extract: [{ name: "tok" }] },
        { type: "parallel", branches: [{ name: "br", steps: [{ request: {} }] }] },
        { type: "if", then: [{}], elif: [{ then: [{}] }], else: [{}] },
        { type: "loop", do: [{ request: {} }] },
      ],
    });
  });
});

describe("준비 스텝과 같은 시나리오 판정", () => {
  const withSetup = (name: string, url: string) => ({
    name: "x",
    setup: { steps: [{ id: "p1", name, notes: "메모", request: { method: "GET", url } }] },
    steps: [{ id: "b1", name: "본", request: { method: "GET", url: "/b" } }],
  });
  it("준비 스텝의 이름·메모만 다른 두 시나리오는 같은 시나리오다", () => {
    const a = stripScenarioNames(withSetup("가", "/p"));
    const b = stripScenarioNames(
      (() => {
        const o = withSetup("나", "/p");
        o.setup.steps[0].notes = "다른 메모";
        return o;
      })(),
    );
    expect(a).toEqual(b);
  });
  it("준비 스텝의 주소가 다르면 다른 시나리오다", () => {
    expect(stripScenarioNames(withSetup("가", "/p"))).not.toEqual(
      stripScenarioNames(withSetup("가", "/q")),
    );
  });
});

describe("부하 조건", () => {
  it("같은 리포트 둘이면 카드 4장 모두 같고 대조 행에 다름이 없다", () => {
    const f = fair();
    expect(f.cards.map((c) => c.key)).toEqual(["load", "env", "scenario", "criteria"]);
    expect(f.cards.every((c) => c.same)).toBe(true);
    expect(f.anyDiff).toBe(false);
    expect(f.diffNames).toEqual([]);
    expect(f.statusLines).toEqual([]);
    expect(f.criteriaSame).toBe(true);
    expect(f.condRows.length).toBeGreaterThan(3);
    expect(f.condRows.every((r) => !r.differs)).toBe(true);
  });

  it("VU·기간이 다르면 두 항목 이름이 줄에 오르고 대조 행이 다름이다", () => {
    const f = fair(
      { profile: prof({ vus: 200, duration_seconds: 600 }) },
      { profile: prof({ vus: 300, duration_seconds: 300 }) },
    );
    const c = card(f, "load");
    expect(c.same).toBe(false);
    expect(c.line).toBe("동시 사용자 · 기간 다름");
    expect(f.condRows.filter((r) => r.differs).map((r) => r.label)).toEqual([
      "동시 사용자",
      "기간",
    ]);
    const vus = f.condRows.find((r) => r.label === "동시 사용자");
    expect(vus).toMatchObject({ before: "200명", after: "300명" });
    expect(f.anyDiff).toBe(true);
    expect(f.diffNames).toEqual(["부하 조건"]);
  });

  it("다른 항목이 셋 이상이면 앞 2개와 외 N개로 줄인다", () => {
    const f = fair(
      {
        profile: prof({ vus: 1, duration_seconds: 1, ramp_up_seconds: 1, http_timeout_seconds: 5 }),
      },
      {
        profile: prof({ vus: 2, duration_seconds: 2, ramp_up_seconds: 2, http_timeout_seconds: 6 }),
      },
    );
    expect(card(f, "load").line).toBe("동시 사용자 · 기간 외 2개 다름");
  });

  it("max_in_flight만 다르면 동시 요청 상한이 줄에 오른다", () => {
    const f = fair(
      { profile: prof({ target_rps: 50, max_in_flight: 10 }) },
      { profile: prof({ target_rps: 50, max_in_flight: 20 }) },
    );
    expect(card(f, "load").line).toBe("동시 요청 상한 다름");
    expect(f.condRows.find((r) => r.label === "동시 요청 상한")).toMatchObject({
      before: "10건",
      after: "20건",
      differs: true,
    });
  });

  it("연결 제한 시간·단계 사이 쉼도 이름 붙은 항목으로 잡는다", () => {
    const f = fair(
      { profile: prof({ connect_timeout_seconds: 3 }) },
      { profile: prof({ connect_timeout_seconds: 5, think_time: { min_ms: 100, max_ms: 200 } }) },
    );
    expect(card(f, "load").line).toBe("단계 사이 쉼 · 연결 제한 시간 다름");
  });

  it("같은 정책에 데이터셋만 바뀌면 같은 글이어도 뒤쪽 칸에 다름 표지가 붙는다", () => {
    const b = (id: string) => ({ dataset_id: id, policy: "per_vu", mappings: [] });
    const f = fair(
      { profile: prof({ data_binding: b("ds1") }) },
      { profile: prof({ data_binding: b("ds2") }) },
    );
    const row = f.condRows.find((r) => r.label === "데이터 연결");
    expect(row?.differs).toBe(true);
    expect(row?.after.endsWith(" · 다름")).toBe(true);
    expect(row?.before.endsWith("다름")).toBe(false);
  });

  it("반올림하면 같게 찍히는 단계 사이 쉼도 다름 표지가 붙는다", () => {
    const f = fair(
      { profile: prof({ think_time: { min_ms: 1000, max_ms: 2000 } }) },
      { profile: prof({ think_time: { min_ms: 1004, max_ms: 2004 } }) },
    );
    const row = f.condRows.find((r) => r.label === "단계 사이 쉼");
    expect(row?.differs).toBe(true);
    expect(row?.before).toBe("1.0초–2.0초 무작위");
    expect(row?.after).toBe("1.0초–2.0초 무작위 · 다름");
  });

  it("단계 길이만 달라 같은 글로 찍히는 크기 행에도 다름 표지가 붙는다", () => {
    const curve = (d: number) => ({
      target_rps: undefined,
      stages: [
        { target: 10, duration_seconds: d },
        { target: 50, duration_seconds: 30 },
      ],
    });
    const f = fair({ profile: prof(curve(30)) }, { profile: prof(curve(60)) });
    const size = f.condRows.find((r) => r.label === "초당 목표");
    expect(size?.differs).toBe(true);
    expect(size?.before).not.toMatch(/다름/);
    expect(size?.after).toBe(`${size?.before} · 다름`);
  });

  it("think_seed만 다르면 같다", () => {
    const f = fair({ profile: prof({ think_seed: 1 }) }, { profile: prof({ think_seed: 2 }) });
    expect(card(f, "load").same).toBe(true);
  });

  it("measure_phases만 다르면 그 밖의 설정이다", () => {
    const f = fair(
      { profile: prof({ measure_phases: false }) },
      { profile: prof({ measure_phases: true }) },
    );
    const c = card(f, "load");
    expect(c.same).toBe(false);
    expect(c.line).toBe("그 밖의 설정 다름");
    expect(f.condRows.find((r) => r.label === "그 밖의 설정")).toEqual({
      label: "그 밖의 설정",
      before: "다름",
      after: "다름",
      differs: true,
    });
  });

  it("옛 data_binding 하나와 data_bindings 한 원소(내용 같음)는 같다", () => {
    const b = { dataset_id: "ds1", policy: "per_vu", mappings: [] };
    const f = fair(
      { profile: prof({ data_binding: b }) },
      { profile: prof({ data_bindings: [b] }) },
    );
    expect(card(f, "load").same).toBe(true);
    const g = fair(
      { profile: prof({ data_bindings: [b] }) },
      { profile: prof({ data_bindings: [{ ...b, policy: "unique" }] }) },
    );
    expect(card(g, "load").line).toBe("데이터 연결 다름");
  });

  it("계단 설정이 다르면 계단 시험 설정이 다르다", () => {
    const st = (t: number[]) => ({
      target_rps: t[0],
      stair: { targets: t, hold_seconds: 60, ramp_seconds: 10, discard_seconds: 5 },
    });
    const f = fair({ profile: prof(st([10, 20])) }, { profile: prof(st([10, 30])) });
    expect(card(f, "load").line).toBe("초당 목표 · 계단 시험 설정 다름");
    const size = f.condRows.find((r) => r.label === "초당 목표");
    expect(size?.differs).toBe(true);
    expect(size?.before).not.toBe(size?.after);
  });

  it("계단 설정만 다르고 크기 칸 글자가 같으면 계단 시험 설정만 다르다", () => {
    const st = (hold: number) => ({
      target_rps: 10,
      stair: { targets: [10, 20], hold_seconds: hold, ramp_seconds: 10, discard_seconds: 5 },
    });
    const f = fair({ profile: prof(st(60)) }, { profile: prof(st(90)) });
    expect(card(f, "load").line).toBe("계단 시험 설정 다름");
  });

  it("데이터 연결 정책은 한글 이름으로 쓰고 영문 식별자는 노출하지 않는다", () => {
    const b = (policy: string) => ({ dataset_id: "ds1", policy, mappings: [] });
    const f = fair(
      { profile: prof({ data_bindings: [b("per_vu")] }) },
      { profile: prof({ data_bindings: [b("iter_random")] }) },
    );
    const row = f.condRows.find((r) => r.label === "데이터 연결");
    expect(row).toEqual({
      label: "데이터 연결",
      before: "1개 연결(사용자마다 고정)",
      after: "1개 연결(반복마다 무작위)",
      differs: true,
    });
    expect(JSON.stringify(f)).not.toMatch(/per_vu|iter_random|iter_sequential|unique/);
  });

  it("크기 이름은 두 부하 모델에 따라 달라진다", () => {
    const mixed = fair({ profile: prof({ vus: 200 }) }, { profile: prof({ target_rps: 50 }) });
    expect(card(mixed, "load").line).toBe("부하 모델 · 크기 다름");
    expect(mixed.condRows.some((r) => r.label === "크기" && r.differs)).toBe(true);
    const open = fair({ profile: prof({ target_rps: 50 }) }, { profile: prof({ target_rps: 80 }) });
    expect(card(open, "load").line).toBe("초당 목표 다름");
  });

  it("steady_run_reads_as_fixed_everywhere: steady만 다르면 그 밖의 설정 줄이 없고 크기 칸에 80", () => {
    const steadyOpen = (discard: number) =>
      prof({
        vus: 0,
        duration_seconds: 0,
        max_in_flight: 50,
        stages: [
          { target: 80, duration_seconds: 30 },
          { target: 80, duration_seconds: 270 },
        ],
        steady: { target: 80, ramp_seconds: 30, hold_seconds: 270, discard_seconds: discard },
      });
    const f = fair({ profile: steadyOpen(5) }, { profile: steadyOpen(10) });
    expect(f.condRows.some((r) => r.label === "그 밖의 설정")).toBe(false);
    const size = f.condRows.find((r) => r.label === "초당 목표");
    expect(size?.before).toBe("초당 80회");
    expect(size?.after).toBe("초당 80회");
  });

  it("한쪽 profile을 읽지 못하면 부하 조건·판정 기준 카드 모두 읽을 수 없음이고 던지지 않는다", () => {
    const f = fair({}, { profile: { vus: "x" } });
    expect(card(f, "load")).toMatchObject({ same: false, line: "설정을 읽을 수 없음" });
    expect(card(f, "criteria")).toMatchObject({ same: false, line: "설정을 읽을 수 없음" });
    expect(f.criteriaSame).toBe(false);
    expect(f.anyDiff).toBe(true);
    expect(card(f, "env").same).toBe(true);
    expect(f.condRows.length).toBeGreaterThan(0);
  });

  it("양쪽 profile을 모두 읽지 못하면 그 행에 다름이라고 적지 않고 카드는 읽을 수 없음으로 둔다", () => {
    const f = fair({ profile: { vus: "x" } }, { profile: { vus: "x" } });
    expect(card(f, "load")).toMatchObject({ same: false, line: "설정을 읽을 수 없음" });
    expect(card(f, "criteria")).toMatchObject({ same: false, line: "설정을 읽을 수 없음" });
    expect(f.anyDiff).toBe(true);
    for (const r of f.condRows) {
      expect(r.before.endsWith("다름"), r.label).toBe(false);
      expect(r.after.endsWith("다름"), r.label).toBe(false);
      expect(r.after.includes("· 다름"), r.label).toBe(false);
    }
    const unread = f.condRows.filter(
      (r) => r.before === "읽을 수 없음" && r.after === "읽을 수 없음",
    );
    expect(unread).toHaveLength(1);
    expect(unread[0].differs).toBe(false);
  });
});

describe("환경 변수 — 값은 어디에도 찍지 않는다", () => {
  const A = { BASE_URL: "https://a", TOKEN: "s3cret-A" };
  const B = { BASE_URL: "https://b", TOKEN: "s3cret-A", EXTRA: "zz-extra-val" };

  it("다른 키 이름만 줄에 오른다", () => {
    const f = fair({ env: A }, { env: B });
    const c = card(f, "env");
    expect(c.same).toBe(false);
    expect(c.line).toBe("2개 다름: BASE_URL, EXTRA");
  });

  it("값 글자는 출력 어디에도 없다", () => {
    const dump = JSON.stringify(fair({ env: A }, { env: B }));
    for (const v of ["https://", "s3cret", "zz-extra-val"]) expect(dump).not.toContain(v);
  });

  it("값만 다른 키도 다름으로 세고, 같은 env는 같다", () => {
    expect(card(fair({ env: { K: "1" } }, { env: { K: "2" } }), "env").line).toBe("1개 다름: K");
    expect(card(fair({ env: A }, { env: { ...A } }), "env").same).toBe(true);
    expect(card(fair({ env: null }, { env: {} }), "env").same).toBe(true);
  });

  it("키가 5개 다르면 앞 2개와 외 3개", () => {
    const f = fair(
      { env: { A: "1", B: "1", C: "1", D: "1", E: "1" } },
      { env: { A: "2", B: "2", C: "2", D: "2", E: "2" } },
    );
    expect(card(f, "env").line).toBe("5개 다름: A, B 외 3개");
  });

  it("대조 표는 환경 변수 개수와 다른 키 개수만 보인다", () => {
    const f = fair({ env: A }, { env: B });
    expect(f.condRows.find((r) => r.label === "환경 변수 개수")).toEqual({
      label: "환경 변수 개수",
      before: "2개",
      after: "3개 · 다른 키 2개",
      differs: true,
    });
  });

  it("개수가 같아도 값이 다르면 이후 칸에 다른 키 개수가 붙는다", () => {
    const f = fair({ env: { A: "1", B: "1", C: "1" } }, { env: { A: "1", B: "2", C: "1" } });
    expect(f.condRows.find((r) => r.label === "환경 변수 개수")).toEqual({
      label: "환경 변수 개수",
      before: "3개",
      after: "3개 · 다른 키 1개",
      differs: true,
    });
    expect(card(f, "env").line).toBe("1개 다름: B");
  });

  it("환경 변수가 같으면 두 칸 모두 개수만", () => {
    const f = fair({ env: A }, { env: { ...A } });
    expect(f.condRows.find((r) => r.label === "환경 변수 개수")).toEqual({
      label: "환경 변수 개수",
      before: "2개",
      after: "2개",
      differs: false,
    });
  });
});

describe("시나리오 내용", () => {
  const withBody = (v: string) =>
    `version: 1\nname: "n"\nsteps:\n  - id: "s1"\n    name: "a"\n    request:\n      method: POST\n      url: "https://x/s1"\n      body:\n        name: "${v}"\n`;

  it("응답 코드 검사 추가는 단계 번호와 함께 설명된다", () => {
    const f = fair({}, { yaml: scenarioYaml([STEPS[0]!, { ...STEPS[1]!, assert: [200] }]) });
    const c = card(f, "scenario");
    expect(c.same).toBe(false);
    expect(c.line).toBe("1곳 다름: ②에 응답 코드 검사 추가됨");
    expect(f.condRows.find((r) => r.differs && r.label.includes("응답 코드 검사"))).toMatchObject({
      before: "다름",
      after: "다름",
    });
  });

  it("검사 줄이 any·목록으로 바뀌면 바뀜으로 설명된다", () => {
    const yml = (assert: string) =>
      `version: 1\nname: "n"\nsteps:\n  - id: "s1"\n    name: "a"\n    request:\n      method: GET\n      url: "https://x/s1"\n${assert}`;
    const lineOf = (a: string, b: string) => {
      const f = fair({ yaml: yml(a) }, { yaml: yml(b) });
      return card(f, "scenario").line;
    };
    const one = "    assert:\n      - status: 200\n";
    expect(lineOf(one, "    assert:\n      - status: [200, 409]\n")).toBe(
      "1곳 다름: ①의 응답 코드 검사 바뀜",
    );
    expect(lineOf(one, "    assert:\n      - status: any\n")).toBe(
      "1곳 다름: ①의 응답 코드 검사 바뀜",
    );
    expect(lineOf("", "    assert:\n      - status: any\n")).toBe(
      "1곳 다름: ①에 응답 코드 검사 추가됨",
    );
    expect(lineOf(one, "")).toBe("1곳 다름: ①에서 응답 코드 검사 제거됨");
  });

  it("단계 이름만, 시나리오 이름만 바뀌면 같다", () => {
    const f = fair(
      {},
      { yaml: scenarioYaml([{ ...STEPS[0]!, name: "다른 이름" }, STEPS[1]!], "다른 시나리오") },
    );
    expect(card(f, "scenario").same).toBe(true);
  });

  it("notes만 바뀌면 같다", () => {
    const y = scenarioYaml(STEPS);
    const f = fair(
      {},
      { yaml: y.replace('name: "민원 신청 흐름"', 'name: "민원 신청 흐름"\nnotes: "메모"') },
    );
    expect(card(f, "scenario").same).toBe(true);
  });

  it("본문 JSON의 name 값이 바뀌면 그 밖의 설정 다름이다", () => {
    const f = fair({ yaml: withBody("x") }, { yaml: withBody("y") });
    const c = card(f, "scenario");
    expect(c.same).toBe(false);
    expect(c.line).toContain("그 밖의 설정 다름");
  });

  it("시나리오 default_think_time이 바뀌면 그 밖의 설정 다름이다", () => {
    const y = scenarioYaml(STEPS);
    const f = fair(
      { yaml: y + "default_think_time: 1\n" },
      { yaml: y + "default_think_time: 2\n" },
    );
    expect(card(f, "scenario").line).toContain("그 밖의 설정 다름");
  });

  it("병렬 분기 name이 바뀌면 다르다", () => {
    const par = (n: string) =>
      `version: 1\nname: "n"\nsteps:\n  - id: "p1"\n    type: parallel\n    branches:\n      - name: "${n}"\n        steps:\n          - id: "s1"\n            request:\n              method: GET\n              url: "https://x"\n`;
    const f = fair({ yaml: par("a") }, { yaml: par("b") });
    expect(card(f, "scenario").same).toBe(false);
  });

  it("단계 삭제는 삭제로 설명된다", () => {
    const f = fair({}, { yaml: scenarioYaml([STEPS[0]!]) });
    expect(card(f, "scenario").line).toBe("1곳 다름: ② 단계 삭제됨");
  });

  it("한쪽 YAML이 깨지면 확인하지 못함이다", () => {
    const f = fair({}, { yaml: "steps: [unclosed\n  - : :" });
    expect(card(f, "scenario")).toMatchObject({
      same: false,
      line: "시나리오를 읽지 못해 확인하지 못함",
    });
  });
});

describe("판정 기준", () => {
  it("기준값이 다르면 기준 1개 다름이다", () => {
    const f = fair(
      { profile: prof({ criteria: { max_p95_ms: 3000 } }) },
      { profile: prof({ criteria: { max_p95_ms: 2000 } }) },
    );
    expect(card(f, "criteria")).toMatchObject({ same: false, line: "기준 1개 다름" });
    expect(f.criteriaSame).toBe(false);
    expect(f.diffNames).toEqual(["판정 기준"]);
  });

  it("step_criteria 순서만 다르면 같다", () => {
    const c1 = { metric: "p95_ms", op: "max", threshold: 1, target: "s1" };
    const c2 = { metric: "p95_ms", op: "max", threshold: 2, target: "s2" };
    const f = fair(
      { profile: prof({ criteria: { step_criteria: [c1, c2] } }) },
      { profile: prof({ criteria: { step_criteria: [c2, c1] } }) },
    );
    expect(card(f, "criteria").same).toBe(true);
  });

  it("한쪽만 있으면 한쪽만 기준 있음, 둘 다 없으면 같다", () => {
    const f = fair({}, { profile: prof({ criteria: { max_p95_ms: 2000 } }) });
    expect(card(f, "criteria").line).toBe("한쪽만 기준 있음");
    expect(f.criteriaSame).toBe(false);
    expect(card(fair(), "criteria").same).toBe(true);
  });
});

describe("상태 코드 규칙 안내", () => {
  const text =
    "선택한 run 가운데 오류 집계 규칙이 다른 run이 있습니다. 이 변경 전에 실행한 run은 상태 코드 검사가 없는 스텝의 4xx·5xx를 오류로 세지 않았습니다 — 오류율을 그대로 견주지 마세요.";
  it("규칙이 다르면 안내 한 줄이 생긴다", () => {
    expect(fair({ statusRule: 2 }, {}).statusRuleLine).toBe(text);
    expect(fair({ statusRule: 1 }, { statusRule: 2 }).statusRuleLine).toBe(text);
  });
  it("같으면 null", () => {
    expect(fair({ statusRule: 2 }, { statusRule: 2 }).statusRuleLine).toBeNull();
    expect(fair({}, {}).statusRuleLine).toBeNull();
  });
});

describe("검사 방식 차이 (R28)", () => {
  const yml = (lines: Array<number[] | "any">, emptyKey = false) => {
    const a = lines
      .map((l) => `      - status: ${l === "any" ? "any" : `[${l.join(", ")}]`}\n`)
      .join("");
    return `version: 1\nname: "n"\nsteps:\n  - id: "s1"\n    name: "a"\n    request:\n      method: GET\n      url: "https://x/s1"\n${
      lines.length > 0 ? `    assert:\n${a}` : emptyKey ? "    assert: []\n" : ""
    }`;
  };
  const line = (
    a: Array<number[] | "any">,
    b: Array<number[] | "any">,
    ra: 1 | 2,
    rb: 1 | 2,
  ): string | null => {
    const f = fair({ yaml: yml(a), statusRule: ra }, { yaml: yml(b), statusRule: rb });
    const c = card(f, "scenario");
    return c.same ? null : c.line;
  };

  it("두 run 모두 규칙 1이면 옛 세 갈래 글 그대로", () => {
    expect(line([], [[200]], 1, 1)).toBe("1곳 다름: ①에 응답 코드 검사 추가됨");
    expect(line([[200]], [], 1, 1)).toBe("1곳 다름: ①에서 응답 코드 검사 제거됨");
    expect(line([[200]], [[200, 409]], 1, 1)).toBe("1곳 다름: ①의 응답 코드 검사 바뀜");
  });
  it("두 run 모두 규칙 2", () => {
    expect(line([], ["any"], 2, 2)).toBe(
      "1곳 다름: ①의 상태 코드 검사 방식 바뀜: 400 이상은 오류 → 보지 않음",
    );
    expect(line([], [[200]], 2, 2)).toBe(
      "1곳 다름: ①의 상태 코드 검사 방식 바뀜: 400 이상은 오류 → 적은 코드만 통과",
    );
    expect(line([[200]], [[200, 409]], 2, 2)).toBe("1곳 다름: ①의 기대 코드 바뀜: 200 → 200·409");
    expect(line([[409, 200]], [[200, 409]], 2, 2)).toBeNull();
    expect(line(["any", [200]], [[200]], 2, 2)).toBeNull();
    expect(line(["any"], ["any"], 2, 2)).toBeNull();
    expect(line([[200], [201]], [[200, 201]], 2, 2)).toBe(
      "1곳 다름: ①의 기대 코드 바뀜: 200 / 201 → 200·201",
    );
  });
  it("두 run 모두 규칙 1이면 코드 순서만 달라도 옛 출력 그대로", () => {
    expect(line([[409, 200]], [[200, 409]], 1, 1)).toBe(
      "그 밖의 설정 다름(쉬는 시간·반복·조건·헤더·본문 등)",
    );
  });
  it("판정이 같은 표기 차이는 규칙 2에서 같다 (assert 없음 ↔ [], 코드 순서, any 줄)", () => {
    const f = fair({ yaml: yml([], false), statusRule: 2 }, { yaml: yml([], true), statusRule: 2 });
    expect(card(f, "scenario").same).toBe(true);
    expect(f.anyDiff).toBe(false);
    const g = fair({ yaml: yml([], true), statusRule: 2 }, { yaml: yml([], false), statusRule: 2 });
    expect(card(g, "scenario").same).toBe(true);
    expect(g.anyDiff).toBe(false);
    for (const [a, b] of [
      [[[409, 200]], [[200, 409]]],
      [["any", [200]], [[200]]],
    ] as Array<[Array<number[] | "any">, Array<number[] | "any">]>) {
      const h = fair({ yaml: yml(a), statusRule: 2 }, { yaml: yml(b), statusRule: 2 });
      expect(card(h, "scenario").same).toBe(true);
    }
  });
  it("줄 경계는 유지한다: [200]/[201] 두 줄과 [200, 201] 한 줄은 다르다", () => {
    expect(
      card(
        fair(
          { yaml: yml([[200], [201]]), statusRule: 2 },
          { yaml: yml([[200, 201]]), statusRule: 2 },
        ),
        "scenario",
      ).same,
    ).toBe(false);
  });
  it("반복 안의 스텝도 assert 없음 ↔ []는 같다", () => {
    const loop = (assertLine: string) =>
      `version: 1\nname: "n"\nsteps:\n  - id: "L1"\n    name: "l"\n    type: loop\n    repeat: 2\n    do:\n      - id: "s1"\n        name: "a"\n        type: http\n        request:\n          method: GET\n          url: "https://x/s1"\n${assertLine}`;
    const f = fair(
      { yaml: loop(""), statusRule: 2 },
      { yaml: loop("        assert: []\n"), statusRule: 2 },
    );
    expect(card(f, "scenario").same).toBe(true);
    expect(f.anyDiff).toBe(false);
  });
  it("그 밖의 설정이 실제로 다르면 여전히 「그 밖의」", () => {
    const other = yml([], true).replace('name: "n"', 'name: "n"\ndescription: "x"');
    const f = fair({ yaml: yml([]), statusRule: 2 }, { yaml: other, statusRule: 2 });
    expect(card(f, "scenario").line.startsWith("그 밖의")).toBe(true);
  });
  it("규칙 1(앞) ↔ 규칙 2(뒤)", () => {
    expect(line([], [], 1, 2)).toBeNull();
    expect(line([], [[200]], 1, 2)).toBe(
      "1곳 다름: ①의 상태 코드 검사 방식 바뀜: 검사 없음 → 적은 코드만 통과",
    );
    expect(line([[200]], [[200]], 1, 2)).toBeNull();
  });
  it("규칙 2(앞) ↔ 규칙 1(뒤)", () => {
    expect(line([], [], 2, 1)).toBeNull();
    expect(line(["any"], [], 2, 1)).toBe(
      "1곳 다름: ①의 상태 코드 검사 방식 바뀜: 보지 않음 → 검사 없음",
    );
  });
});

describe("규칙 차이를 다른 조건으로 (R26 보강)", () => {
  it("같은 시나리오·부하에서 규칙만 다르면 이름·행이 생긴다", () => {
    const f = fair({ statusRule: 1 }, { statusRule: 2 });
    expect(f.diffNames).toContain("오류 집계 규칙");
    expect(f.anyDiff).toBe(true);
    expect(f.cards.every((c) => c.same)).toBe(true);
    expect(f.statusRuleLine).not.toBeNull();
    expect(f.condRows[f.condRows.length - 1]).toEqual({
      label: "오류 집계 규칙",
      before: "검사 없는 스텝은 모두 통과",
      after: "검사 없는 스텝은 400 이상이 오류",
      differs: true,
    });
  });
  it("순서를 뒤집으면 칸 글이 바뀐다", () => {
    const f = fair({ statusRule: 2 }, { statusRule: 1 });
    expect(f.diffNames).toContain("오류 집계 규칙");
    expect(f.condRows[f.condRows.length - 1]).toMatchObject({
      before: "검사 없는 스텝은 400 이상이 오류",
      after: "검사 없는 스텝은 모두 통과",
    });
  });
  it("두 run 모두 1, 모두 2면 이름·행이 없다", () => {
    for (const r of [1, 2] as const) {
      const f = fair({ statusRule: r }, { statusRule: r });
      expect(f.diffNames).not.toContain("오류 집계 규칙");
      expect(f.condRows.some((x) => x.label === "오류 집계 규칙")).toBe(false);
    }
  });
  it("다른 조건과 함께여도 규칙 이름이 맨 앞이다", () => {
    const f = fair(
      { statusRule: 1, env: { A: "1" } },
      { statusRule: 2, env: { A: "2" }, profile: prof({ vus: 20 }) },
    );
    expect(f.diffNames[0]).toBe("오류 집계 규칙");
    expect(f.diffNames.length).toBeGreaterThan(2);
  });
});

describe("응답 시간 표본 안내", () => {
  const passed = { selected: "passed", default: "passed", split: true } as const;
  it("표본이 섞이면 안내 한 줄이 생긴다", () => {
    const f = fair({ sample: passed }, {});
    expect(f.sampleLine).toBe(
      "고른 run 중 일부는 실패한 요청을 포함해 응답 시간을 계산했습니다. 응답 시간을 그대로 비교하기 어렵습니다.",
    );
  });
  it("같으면 null", () => {
    expect(fair({ sample: passed }, { sample: passed }).sampleLine).toBeNull();
    expect(fair({}, {}).sampleLine).toBeNull();
  });
});

describe("측정 상태 줄과 한 줄 요약", () => {
  it("이후가 aborted면 걸린 시간과 함께 한 줄이 생긴다", () => {
    const f = fair({}, { status: "aborted", meta: { started_at: 0, ended_at: 252000 } });
    expect(f.statusLines).toEqual(["▲ 이후 측정은 도중에 중단되었습니다(4분 12초까지 측정)"]);
    expect(f.anyDiff).toBe(true);
    expect(f.diffNames).toEqual(["측정 상태"]);
    expect(f.cards.every((c) => c.same)).toBe(true);
  });

  it("시작 시각이 없으면 괄호가 없다", () => {
    const f = fair({}, { status: "aborted", meta: { started_at: null } });
    expect(f.statusLines).toEqual(["▲ 이후 측정은 도중에 중단되었습니다"]);
  });

  it("이전이 failed면 실패로 끝났다고 쓴다", () => {
    const f = fair({ status: "failed" }, {});
    expect(f.statusLines).toEqual(["▲ 이전 측정은 실패로 끝났습니다"]);
  });

  it("oneLine은 같은 카드와 다른 카드를 묶어 쓴다", () => {
    const f = fair(
      {},
      { yaml: scenarioYaml([STEPS[0]!]), profile: prof({ criteria: { max_p95_ms: 2000 } }) },
    );
    expect(f.oneLine).toContain("부하 조건·환경 변수 같음");
    expect(f.oneLine).toContain("시나리오 내용·판정 기준 다름");
    expect(fair().oneLine).toBe("부하 조건·환경 변수·시나리오 내용·판정 기준 같음");
  });
});

describe("집계 기준 줄", () => {
  const steadyBasis = (over: Record<string, unknown> = {}, discard = 5): Report["basis"] =>
    ({
      selected: "steady",
      default: "steady",
      state: "measured",
      config: { ramp_seconds: 30, hold_seconds: 270, discard_seconds: discard },
      window: { start_ms: 1_000_000, end_ms: 1_265_000, measured_seconds: 265 },
      t0_estimated: false,
      dropped_whole_run: false,
      other: null,
      ...over,
    }) as Report["basis"];
  const row = (f: Fairness, label: string) => f.condRows.find((r) => r.label === label);

  it("basis 없는 두 run: 집계 기준 줄이 없고 부하 조건 카드는 그대로", () => {
    const f = fair();
    expect(row(f, "집계 기준")).toBeUndefined();
    expect(card(f, "load").same).toBe(true);
  });
  it("steady 기준 run과 basis 없는 run: 줄이 다름이고 부하 조건이 같지 않다", () => {
    const f = fair({ basis: steadyBasis() }, {});
    expect(row(f, "집계 기준")).toMatchObject({
      before: "유지 구간(상승 30초·버림 5초 제외)",
      after: "전체 구간",
      differs: true,
    });
    expect(card(f, "load").same).toBe(false);
    expect(card(f, "load").line).toContain("집계 기준");
    expect(f.anyDiff).toBe(true);
  });
  it("basis_row_reads_report_not_profile: 프로필이 같은 두 steady run인데 한쪽이 닿기 전에 끝났다", () => {
    const p = prof({
      steady: { ramp_seconds: 30, hold_seconds: 270, discard_seconds: 5 },
      ramp_up_seconds: 30,
    });
    const f = fair(
      { profile: p, basis: steadyBasis() },
      {
        profile: p,
        basis: steadyBasis({
          selected: "whole",
          default: "whole",
          state: "not_reached",
          window: null,
        }),
      },
    );
    expect(row(f, "집계 기준")).toMatchObject({ after: "전체 구간", differs: true });
  });
  it("버림만 다른 두 steady run: 집계 기준 줄이 다르다", () => {
    const f = fair({ basis: steadyBasis({}, 5) }, { basis: steadyBasis({}, 10) });
    expect(row(f, "집계 기준")).toMatchObject({
      before: "유지 구간(상승 30초·버림 5초 제외)",
      after: "유지 구간(상승 30초·버림 10초 제외)",
      differs: true,
    });
  });
  it("같은 기준의 두 steady run: 줄이 있고 다름이 아니다", () => {
    const f = fair({ basis: steadyBasis() }, { basis: steadyBasis() });
    expect(row(f, "집계 기준")).toMatchObject({
      before: "유지 구간(상승 30초·버림 5초 제외)",
      after: "유지 구간(상승 30초·버림 5초 제외)",
      differs: false,
    });
    expect(card(f, "load").same).toBe(true);
  });
  it("도착률 고정 + 상승 run: 시작 늘림 줄이 steady.ramp_seconds를 보인다", () => {
    const p = prof({
      vus: 0,
      duration_seconds: 0,
      ramp_up_seconds: 0,
      max_in_flight: 50,
      stages: [
        { target: 80, duration_seconds: 30 },
        { target: 80, duration_seconds: 270 },
      ],
      steady: { target: 80, ramp_seconds: 30, hold_seconds: 270, discard_seconds: 5 },
    });
    const f = fair({ profile: p }, { profile: p });
    expect(row(f, "시작 늘림")?.before).toContain("30초");
  });
  it("상승 0·버림 5: 유지 구간(버림 5초 제외)", () => {
    const b = steadyBasis({ config: { ramp_seconds: 0, hold_seconds: 270, discard_seconds: 5 } });
    const f = fair({ basis: b }, { basis: b });
    expect(row(f, "집계 기준")?.before).toBe("유지 구간(버림 5초 제외)");
  });
});
