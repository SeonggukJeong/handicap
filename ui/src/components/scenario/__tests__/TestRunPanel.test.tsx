import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenarioTrace } from "../../../api/schemas";
import type { Step } from "../../../scenario/model";
import { TestRunPanel } from "../TestRunPanel";
import { ko } from "../../../i18n/ko";

const TRACE: ScenarioTrace = {
  ok: false,
  total_ms: 42,
  truncated: true,
  error: null,
  final_vars: { token: "abc" },
  steps: [
    {
      step_id: "01HX0000000000000000000010",
      kind: "if",
      loop_index: null,
      branch: "none",
      request: null,
      response: null,
      extracted: {},
      unbound_vars: ["missing_cond"],
      error: null,
    },
    {
      step_id: "01HX0000000000000000000011",
      kind: "http",
      loop_index: 2,
      branch: null,
      request: { method: "GET", url: "http://api/ping", headers: { a: "1" }, body: null },
      response: {
        status: 500,
        latency_ms: 9,
        download_ms: 3,
        headers: {},
        set_cookies: [],
        body: "boom",
        body_truncated: false,
      },
      extracted: { id: "42" },
      unbound_vars: [],
      error: "status 500 != 200",
    },
  ],
};

describe("TestRunPanel", () => {
  it("결과 패널 제목은 컨트롤 제목과 다른 '미리 테스트 결과'를 쓴다 (공유 키 분리)", () => {
    render(<TestRunPanel trace={TRACE} />);
    expect(screen.getByRole("heading", { name: "미리 테스트 결과" })).toBeInTheDocument();
  });

  it("renders the truncated banner and a per-step summary", () => {
    render(<TestRunPanel trace={TRACE} />);
    // truncated banner
    expect(screen.getByText(/상한 도달/)).toBeInTheDocument();
    // 원인 셋(요청 수·판정 줄 수·시간)을 적는다 — 글자 조각을 리터럴로(ko 참조는 자기 참조).
    expect(screen.getByText(/판정 줄 수/)).toBeInTheDocument();
    expect(screen.queryByText(/max_requests/)).not.toBeInTheDocument();
    // http row: method + url + status
    expect(screen.getByText("GET")).toBeInTheDocument();
    expect(screen.getByText("http://api/ping")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
    // if row: branch label (none -> "(미매치)")
    expect(screen.getByText(/\(미매치\)/)).toBeInTheDocument();
    // loop_index tag
    expect(screen.getByText("#2")).toBeInTheDocument();
    // unbound var amber chip
    expect(screen.getByText("missing_cond")).toBeInTheDocument();
    // extracted chip
    expect(screen.getByText(/id=42/)).toBeInTheDocument();
    // step error
    expect(screen.getByText(/status 500 != 200/)).toBeInTheDocument();
  });

  it("긴 추출값 칩은 박스 안에서 줄바꿈된다 (공백 없는 토큰도 break-all)", () => {
    // jsdom은 레이아웃이 없어 폭을 못 잰다 — 줄바꿈 계약(break-all)을 클래스 토큰으로 락인하고,
    // 실제 박스 내 줄바꿈은 라이브 getBoundingClientRect로 확인한다.
    const longToken = "eyJ" + "A".repeat(600);
    const trace: ScenarioTrace = {
      ...TRACE,
      steps: [{ ...TRACE.steps[1], extracted: { token: longToken } }],
    };
    render(<TestRunPanel trace={trace} />);
    const chipEl = screen.getByText(`token=${longToken}`);
    expect(chipEl.className.split(/\s+/)).toContain("break-all");
  });

  it("shows TTFB and download_ms on the http response row", () => {
    render(<TestRunPanel trace={TRACE} />);
    // The http row (status 500, latency_ms 9, download_ms 3) should show TTFB and download
    expect(screen.getByText(/TTFB 9ms/)).toBeInTheDocument();
    expect(screen.getByText(/다운로드 3ms/)).toBeInTheDocument();
  });

  it("renders the limit-reached notice as a warn Callout (rounded-md + bg-amber-50, not raw rounded/bg-amber-100)", () => {
    render(<TestRunPanel trace={TRACE} />);
    const box = screen.getByText(/상한 도달/).closest("div");
    expect(box).toHaveClass("rounded-md");
    expect(box).toHaveClass("bg-amber-50");
  });

  it("shows an ok summary when the trace succeeded and is not truncated", () => {
    render(<TestRunPanel trace={{ ...TRACE, ok: true, truncated: false, steps: [] }} />);
    expect(screen.queryByText(/상한 도달/)).not.toBeInTheDocument();
    expect(screen.getByText(ko.editor.testRunOk)).toBeInTheDocument();
  });

  it("renders the if condition summary when the scenario steps are provided", () => {
    const ifStep: Step = {
      id: "01HX0000000000000000000010",
      name: "branch",
      type: "if",
      cond: { left: "status", op: "eq", right: "200" },
      then: [
        {
          id: "01HX0000000000000000000011",
          name: "ok",
          type: "http",
          request: { method: "GET", url: "/ok", headers: {} },
          assert: [],
          extract: [],
        },
      ],
      elif: [],
      else: [],
    };
    render(<TestRunPanel trace={TRACE} steps={[ifStep]} />);
    expect(screen.getByText("status eq 200")).toBeInTheDocument();
  });

  // jsdom has no navigator.clipboard and it's read-only → install a configurable mock.
  function mockClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  // Don't leak the clipboard mock into sibling tests (configurable → deletable).
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  function httpTrace(
    resp: Partial<ScenarioTrace["steps"][number]["response"]> & { body: string },
    reqBody?: string,
  ): ScenarioTrace {
    return {
      ok: true,
      total_ms: 1,
      truncated: false,
      error: null,
      final_vars: {},
      steps: [
        {
          step_id: "01HX0000000000000000000031",
          kind: "http",
          loop_index: null,
          branch: null,
          request: { method: "GET", url: "http://api/x", headers: {}, body: reqBody ?? null },
          response: {
            status: 200,
            latency_ms: 1,
            download_ms: 1,
            headers: {},
            set_cookies: [],
            body_truncated: false,
            ...resp,
          },
          extracted: {},
          unbound_vars: [],
          error: null,
        },
      ],
    };
  }

  async function expandRow(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByText("http://api/x"));
  }

  it("shows a short response body inline without a 전체 보기 button", async () => {
    const user = userEvent.setup();
    render(<TestRunPanel trace={httpTrace({ body: "short body" })} />);
    await expandRow(user);
    expect(screen.getByText("short body")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "전체 보기" })).not.toBeInTheDocument();
  });

  it("previews a long response body and opens the full body in a modal", async () => {
    const user = userEvent.setup();
    const long = "x".repeat(600);
    render(<TestRunPanel trace={httpTrace({ body: long })} />);
    await expandRow(user);
    // inline preview is the first 500 chars + ellipsis, not the full body
    expect(screen.getByText(`${"x".repeat(500)}…`)).toBeInTheDocument();
    expect(screen.queryByText(long)).not.toBeInTheDocument();
    // open modal → full body present
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    const dialog = screen.getByRole("dialog", { name: "응답 본문" });
    expect(within(dialog).getByText(long)).toBeInTheDocument();
  });

  it("offers a JSON format toggle only for valid JSON bodies", async () => {
    const user = userEvent.setup();
    const json = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: i, name: "row" })));
    render(<TestRunPanel trace={httpTrace({ body: json })} />);
    await expandRow(user);
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    const dialog = screen.getByRole("dialog", { name: "응답 본문" });
    const fmt = within(dialog).getByRole("button", { name: "JSON 포맷" });
    await user.click(fmt);
    // pretty-printed output contains indentation newlines. RTL's default
    // normalizer collapses whitespace (\s+ → " "), so the newline+indent would
    // never survive — disable collapsing for this matcher.
    expect(within(dialog).getByText(/\n {2}/, { collapseWhitespace: false })).toBeInTheDocument();
  });

  it("has no JSON format toggle for a non-JSON body", async () => {
    const user = userEvent.setup();
    render(<TestRunPanel trace={httpTrace({ body: "x".repeat(600) })} />);
    await expandRow(user);
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    const dialog = screen.getByRole("dialog", { name: "응답 본문" });
    expect(within(dialog).queryByRole("button", { name: "JSON 포맷" })).not.toBeInTheDocument();
  });

  it("copies the displayed body text", async () => {
    const user = userEvent.setup();
    // mockClipboard must come AFTER userEvent.setup() — setup() installs its own
    // clipboard stub via Object.defineProperty(navigator, "clipboard", …); our
    // mock (also configurable:true) then overrides it so the button's
    // navigator.clipboard?.writeText() hits our spy.
    const writeText = mockClipboard();
    const long = "x".repeat(600);
    render(<TestRunPanel trace={httpTrace({ body: long })} />);
    await expandRow(user);
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    const dialog = screen.getByRole("dialog", { name: "응답 본문" });
    await user.click(within(dialog).getByRole("button", { name: "복사" }));
    expect(writeText).toHaveBeenCalledWith(long);
  });

  it("shows '복사됨' feedback after a successful copy", async () => {
    const user = userEvent.setup();
    mockClipboard();
    render(<TestRunPanel trace={httpTrace({ body: "x".repeat(600) })} />);
    await expandRow(user);
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    const dialog = screen.getByRole("dialog", { name: "응답 본문" });
    await user.click(within(dialog).getByRole("button", { name: "복사" }));
    // the copy button confirms success by switching its label to "복사됨"
    expect(await within(dialog).findByRole("button", { name: "복사됨" })).toBeInTheDocument();
  });

  it("shows the truncated banner in the modal when body_truncated", async () => {
    const user = userEvent.setup();
    render(<TestRunPanel trace={httpTrace({ body: "x".repeat(600), body_truncated: true })} />);
    await expandRow(user);
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    const dialog = screen.getByRole("dialog", { name: "응답 본문" });
    expect(within(dialog).getByText(/잘림/)).toBeInTheDocument();
  });

  it("previews and modals a long request body too", async () => {
    const user = userEvent.setup();
    const longReq = "r".repeat(600);
    render(<TestRunPanel trace={httpTrace({ body: "ok" }, longReq)} />);
    await expandRow(user);
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    expect(screen.getByRole("dialog", { name: "요청 본문" })).toBeInTheDocument();
  });
});

describe("TestRunPanel — 조건 반복 판정 줄", () => {
  const LP = "01HX00000000000000000000L1";
  const HT = "01HX00000000000000000000H1";
  const loopSteps: Step[] = [
    {
      id: LP,
      name: "주문 재시도",
      type: "loop",
      repeat: 3,
      while: { left: "{{code}}", op: "eq", right: "WAIT" },
      do: [
        {
          id: HT,
          name: "조회",
          type: "http",
          request: { method: "GET", url: "/o", headers: {} },
          assert: [],
          extract: [],
        },
      ],
    },
  ];
  const http = (i: number): ScenarioTrace["steps"][number] => ({
    step_id: HT,
    kind: "http",
    loop_index: i,
    branch: null,
    request: { method: "GET", url: "http://api/o", headers: {}, body: null },
    response: {
      status: 200,
      latency_ms: 1,
      download_ms: null,
      headers: {},
      set_cookies: [],
      body: "",
      body_truncated: false,
    },
    extracted: {},
    unbound_vars: [],
    error: null,
  });
  const judge = (branch: string, i: number): ScenarioTrace["steps"][number] => ({
    step_id: LP,
    kind: "loop",
    loop_index: i,
    branch,
    request: null,
    response: null,
    extracted: {},
    unbound_vars: [],
    error: null,
  });
  const base: ScenarioTrace = {
    ok: true,
    total_ms: 5,
    truncated: false,
    error: null,
    final_vars: {},
    steps: [http(0), judge("again", 0), http(1), judge("again", 1), http(2), judge("done", 2)],
  };

  it("판정 줄이 회차·문구로 그려지고 http 행은 3개 그대로다", () => {
    render(<TestRunPanel trace={base} steps={loopSteps} />);
    expect(screen.getByText("1회차")).toBeInTheDocument();
    expect(screen.getByText("2회차")).toBeInTheDocument();
    expect(screen.getByText("3회차")).toBeInTheDocument();
    expect(screen.getAllByText("조건이 참 → 다시 실행")).toHaveLength(2);
    expect(screen.getAllByText("조건이 거짓 → 다음 스텝")).toHaveLength(1);
    expect(screen.getAllByText("GET")).toHaveLength(3);
    expect(screen.getAllByText("주문 재시도")).toHaveLength(3);
    expect(screen.queryByText(LP)).not.toBeInTheDocument();
  });

  it("ended_by_loop이면 목록 위에 안내가 뜬다", () => {
    render(
      <TestRunPanel
        trace={{ ...base, ended_by_loop: LP, steps: [http(0), judge("exhausted", 2)] }}
        steps={loopSteps}
      />,
    );
    expect(
      screen.getByText(
        "조건 반복 「주문 재시도」이(가) 최대 횟수까지 풀리지 않아 여기서 끝났습니다.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("최대 3회 → 이번 반복 종료")).toBeInTheDocument();
  });

  it("최대 횟수 판정 줄 없이 ended_by_loop이면(보내지 못한 회차) 안내 문구가 다르다", () => {
    render(
      <TestRunPanel
        trace={{ ...base, ended_by_loop: LP, steps: [http(0), judge("again", 0)] }}
        steps={loopSteps}
      />,
    );
    expect(
      screen.getByText("조건 반복 「주문 재시도」 안의 요청을 보내지 못해 여기서 끝났습니다."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/최대 횟수까지 풀리지 않아/)).not.toBeInTheDocument();
  });

  it("steps가 없으면 이름 자리에 step_id가 나온다", () => {
    render(<TestRunPanel trace={{ ...base, steps: [judge("done", 0)] }} />);
    expect(screen.getByText(LP)).toBeInTheDocument();
  });
});

describe("TestRunPanel 보내지 않은 요청", () => {
  const S1 = "01HX0000000000000000000041";
  const S2 = "01HX0000000000000000000042";
  const blockedTrace: ScenarioTrace = {
    ok: false,
    total_ms: 5,
    truncated: false,
    error: null,
    final_vars: {},
    steps: [
      {
        step_id: S2,
        kind: "http",
        loop_index: null,
        branch: null,
        request: null,
        response: null,
        extracted: {},
        unbound_vars: ["x"],
        error: "not sent: blank value in url",
        blocked: { vars: ["orderId"], by_step: S1 },
      },
    ],
  };
  const named: Step[] = [
    {
      id: S1,
      name: "상태 조회",
      type: "http",
      request: { method: "GET", url: "/poll", headers: {} },
      assert: [],
      extract: [],
    },
  ];

  it("blocked 행은 한국어 문구만 보이고 원문과 unbound 칩은 없다", () => {
    render(<TestRunPanel trace={blockedTrace} steps={named} />);
    expect(
      screen.getByText("앞 스텝 상태 조회이(가) orderId 값을 주지 않아 요청을 보내지 않음"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not sent: blank value in url/)).not.toBeInTheDocument();
    expect(screen.queryByText("unbound:")).not.toBeInTheDocument();
  });

  it("blocked 아닌 http 행은 unbound 칩을 그대로 보인다", () => {
    render(
      <TestRunPanel
        trace={{
          ...blockedTrace,
          steps: [{ ...blockedTrace.steps[0], blocked: undefined, error: "boom" }],
        }}
        steps={named}
      />,
    );
    expect(screen.getByText("unbound:")).toBeInTheDocument();
    expect(screen.getByText("x")).toBeInTheDocument();
  });

  it("steps가 없으면 이름 자리에 step_id", () => {
    render(<TestRunPanel trace={blockedTrace} />);
    expect(screen.getByText(new RegExp(`앞 스텝 ${S1}이\\(가\\) orderId`))).toBeInTheDocument();
  });
});

describe("TestRunPanel 준비 표지", () => {
  const S_ID = "01HX0000000000000000000091";
  const B_ID = "01HX0000000000000000000092";
  const mk = (id: string, name: string): Step => ({
    id,
    name,
    type: "http",
    request: { method: "GET", url: `http://x/${name}`, headers: {} },
    assert: [],
    extract: [],
  });
  const STEPS: Step[] = [mk(S_ID, "준비 요청"), mk(B_ID, "조회")];
  const row = (id: string, section?: string) => ({
    ...TRACE.steps[1],
    step_id: id,
    loop_index: null,
    error: null,
    ...(section ? { section } : {}),
  });
  const SETUP_TRACE: ScenarioTrace = {
    ...TRACE,
    truncated: false,
    steps: [row(S_ID, "setup"), row(B_ID)],
  };

  it("준비 행에만 「준비」 표지가 붙는다", () => {
    render(<TestRunPanel trace={SETUP_TRACE} steps={STEPS} />);
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]).getByText("준비")).toBeInTheDocument();
    expect(within(items[0]).getByText("준비 요청")).toBeInTheDocument();
    expect(within(items[1]).queryByText("준비")).not.toBeInTheDocument();
  });

  it("머리의 스텝 수는 본 행만 세고 준비 수를 따로 적는다", () => {
    const { unmount } = render(<TestRunPanel trace={SETUP_TRACE} steps={STEPS} />);
    expect(screen.getByText(/ms · /)).toHaveTextContent(/1 steps · 준비 1$/);
    unmount();
    render(<TestRunPanel trace={{ ...SETUP_TRACE, steps: [row(B_ID), row(B_ID)] }} />);
    const head = screen.getByText(/ms · /);
    expect(head).toHaveTextContent(/2 steps$/);
    expect(head).not.toHaveTextContent("준비");
  });

  it("준비 실패면 본 스텝을 실행하지 않았다고 알린다", () => {
    const msg = "준비 스텝이 실패해 본 스텝을 실행하지 않았습니다";
    const { unmount } = render(
      <TestRunPanel
        trace={{ ...SETUP_TRACE, setup_failed: true, steps: [row(S_ID, "setup")] }}
        steps={STEPS}
      />,
    );
    expect(screen.getByText(msg)).toBeInTheDocument();
    unmount();
    render(<TestRunPanel trace={SETUP_TRACE} steps={STEPS} />);
    expect(screen.queryByText(msg)).not.toBeInTheDocument();
  });

  it("준비 행이 있는 목록에서는 본 행에도 스텝 이름이 나온다", () => {
    render(<TestRunPanel trace={SETUP_TRACE} steps={STEPS} />);
    const items = screen.getAllByRole("listitem");
    expect(within(items[1]).getByText("조회")).toBeInTheDocument();
    expect(within(items[1]).queryByText("준비")).not.toBeInTheDocument();
  });

  it("준비 행이 없는 목록에는 스텝 이름이 나오지 않는다", () => {
    render(<TestRunPanel trace={{ ...SETUP_TRACE, steps: [row(B_ID)] }} steps={STEPS} />);
    const item = screen.getAllByRole("listitem")[0];
    expect(within(item).queryByText("조회")).not.toBeInTheDocument();
  });

  it("구분선은 바로 다음이 본 행인 준비 행에만 있다", () => {
    const { unmount } = render(<TestRunPanel trace={SETUP_TRACE} steps={STEPS} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveClass("border-b-2", "border-accent-200");
    expect(items[0]).not.toHaveClass("border-slate-100");
    expect(items[1]).toHaveClass("border-slate-100");
    unmount();
    render(<TestRunPanel trace={{ ...SETUP_TRACE, steps: [row(S_ID, "setup")] }} steps={STEPS} />);
    expect(screen.getAllByRole("listitem")[0]).not.toHaveClass("border-accent-200");
  });
});

describe("TestRunPanel 기본값 표지", () => {
  const withExtracted = (defaulted?: string[]): ScenarioTrace => ({
    ...TRACE,
    steps: [
      {
        ...TRACE.steps[1],
        error: null,
        extracted: { orderId: "none", state: "WAIT" },
        ...(defaulted ? { defaulted } : {}),
      },
    ],
  });
  it("기본값이 들어간 칩에만 「기본값」 글자가 있다", () => {
    render(<TestRunPanel trace={withExtracted(["orderId"])} />);
    const orderChip = screen.getByText("orderId=none");
    const stateChip = screen.getByText("state=WAIT");
    expect(within(orderChip).getByText("기본값")).toBeInTheDocument();
    expect(within(stateChip).queryByText("기본값")).not.toBeInTheDocument();
    // 스크린리더가 `orderId=none기본값`으로 붙여 읽지 않게 값과 표지 사이에 실제 공백이 있다.
    expect(orderChip.textContent).toBe("orderId=none 기본값");
    expect(stateChip.textContent).toBe("state=WAIT");
  });
  it("defaulted 키가 없으면 「기본값」 글자가 화면에 없다", () => {
    render(<TestRunPanel trace={withExtracted()} />);
    expect(screen.queryByText("기본값")).not.toBeInTheDocument();
  });
});
