import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenarioTrace } from "../../../api/schemas";
import type { Step } from "../../../scenario/model";
import { TestRunPanel } from "../TestRunPanel";

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
  it("renders the truncated banner and a per-step summary", () => {
    render(<TestRunPanel trace={TRACE} />);
    // truncated banner
    expect(screen.getByText(/상한 도달/)).toBeInTheDocument();
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

  it("shows an ok summary when the trace succeeded and is not truncated", () => {
    render(<TestRunPanel trace={{ ...TRACE, ok: true, truncated: false, steps: [] }} />);
    expect(screen.queryByText(/상한 도달/)).not.toBeInTheDocument();
    expect(screen.getByText(/OK/)).toBeInTheDocument();
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
