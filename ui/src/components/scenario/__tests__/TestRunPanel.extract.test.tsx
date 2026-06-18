import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TestRunPanel } from "../TestRunPanel";
import type { ScenarioTrace, StepTrace } from "../../../api/schemas";

function httpStep(over: Partial<StepTrace> = {}): StepTrace {
  return {
    step_id: "01J0000000000000000000000A",
    kind: "http",
    loop_index: null,
    branch: null,
    request: { method: "POST", url: "https://x/login", headers: {}, body: null },
    response: {
      status: 200,
      latency_ms: 5,
      download_ms: null,
      headers: { "x-request-id": "9f2c" },
      set_cookies: ["session=abc123; Path=/; HttpOnly"],
      body: JSON.stringify({ data: { token: "eyJabc" } }),
      body_truncated: false,
    },
    extracted: {},
    unbound_vars: [],
    error: null,
    ...over,
  };
}

function trace(step: StepTrace): ScenarioTrace {
  // final_vars is REQUIRED by ScenarioTraceSchema (z.record(string,string)) — omitting
  // it makes tsc -b reject the whole test file.
  return { ok: true, total_ms: 10, truncated: false, error: null, final_vars: {}, steps: [step] };
}

async function expand(user: ReturnType<typeof userEvent.setup>) {
  // HttpRow header is a toggle button; open it to reveal response detail.
  await user.click(screen.getByRole("button", { name: /login/ }));
}

describe("TestRunPanel extract affordances", () => {
  it("body field +추출 → onAddExtract(step_id, body extract) (R1,R4)", async () => {
    const user = userEvent.setup();
    const onAddExtract = vi.fn();
    render(<TestRunPanel trace={trace(httpStep())} onAddExtract={onAddExtract} />);
    await expand(user);
    await user.click(screen.getByRole("button", { name: "+추출" }));
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onAddExtract).toHaveBeenCalledWith("01J0000000000000000000000A", {
      var: "token",
      from: "body",
      path: "$.data.token",
    });
  });

  it("response header 추출 → header extract (R3)", async () => {
    const user = userEvent.setup();
    const onAddExtract = vi.fn();
    render(<TestRunPanel trace={trace(httpStep())} onAddExtract={onAddExtract} />);
    await expand(user);
    // header row has its own 추출 button; click it, then 추가
    const headerExtract = screen.getByRole("button", { name: "x-request-id 추출" });
    await user.click(headerExtract);
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onAddExtract).toHaveBeenCalledWith("01J0000000000000000000000A", {
      var: "x_request_id",
      from: "header",
      name: "x-request-id",
    });
  });

  it("Set-Cookie 추출 → cookie extract with parsed name (R3)", async () => {
    const user = userEvent.setup();
    const onAddExtract = vi.fn();
    render(<TestRunPanel trace={trace(httpStep())} onAddExtract={onAddExtract} />);
    await expand(user);
    await user.click(screen.getByRole("button", { name: "session 추출" }));
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onAddExtract).toHaveBeenCalledWith("01J0000000000000000000000A", {
      var: "session",
      from: "cookie",
      name: "session",
    });
  });

  it("status 추출 → status extract (R3)", async () => {
    const user = userEvent.setup();
    const onAddExtract = vi.fn();
    render(<TestRunPanel trace={trace(httpStep())} onAddExtract={onAddExtract} />);
    await expand(user);
    await user.click(screen.getByRole("button", { name: "상태 추출" }));
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onAddExtract).toHaveBeenCalledWith("01J0000000000000000000000A", {
      var: "status",
      from: "status",
    });
  });

  it("truncated body → no tree, shows manual notice; header still extractable (R5)", async () => {
    const user = userEvent.setup();
    const onAddExtract = vi.fn();
    const step = httpStep({
      response: { ...httpStep().response!, body_truncated: true },
    });
    render(<TestRunPanel trace={trace(step)} onAddExtract={onAddExtract} />);
    await expand(user);
    expect(screen.queryByRole("button", { name: "+추출" })).toBeNull();
    expect(screen.getByText(/추출 불가/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "x-request-id 추출" })).toBeInTheDocument();
  });

  it("non-JSON body → no tree, shows manual notice (R5)", async () => {
    const user = userEvent.setup();
    const step = httpStep({
      response: { ...httpStep().response!, body: "<html>not json</html>" },
    });
    render(<TestRunPanel trace={trace(step)} onAddExtract={vi.fn()} />);
    await expand(user);
    expect(screen.queryByRole("button", { name: "+추출" })).toBeNull();
    expect(screen.getByText(/추출 불가/)).toBeInTheDocument();
  });

  it("no affordances when onAddExtract is absent (back-compat)", async () => {
    const user = userEvent.setup();
    render(<TestRunPanel trace={trace(httpStep())} />);
    await expand(user);
    expect(screen.queryByRole("button", { name: "+추출" })).toBeNull();
    expect(screen.queryByRole("button", { name: "상태 추출" })).toBeNull();
  });
});
