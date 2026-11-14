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

  it("steps가 없으면 이름 자리에 step_id가 나온다", () => {
    render(<TestRunPanel trace={{ ...base, steps: [judge("done", 0)] }} />);
    expect(screen.getByText(LP)).toBeInTheDocument();
  });
});
