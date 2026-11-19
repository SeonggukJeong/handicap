import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TestRunPanel } from "../TestRunPanel";
import type { ScenarioTrace, StepTrace } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { parseBodyJson } from "../../../scenario/bodyJson";

vi.mock("../../../scenario/bodyJson", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../scenario/bodyJson")>();
  return { ...actual, parseBodyJson: vi.fn(actual.parseBodyJson) };
});

beforeEach(() => {
  vi.clearAllMocks();
});

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

// 추출 확인 줄은 누른 헤더·쿠키 줄 바로 아래에 떠야 한다(표 전체 뒤가 아니라).
describe("TestRunPanel 추출 확인 줄 위치", () => {
  const confirm = () => screen.getByRole("button", { name: "추가" });

  it("헤더 추출 → 그 헤더 줄 바로 다음 줄", async () => {
    const user = userEvent.setup();
    const step = httpStep({
      response: { ...httpStep().response!, headers: { a: "1", "x-request-id": "9f2c", z: "3" } },
    });
    render(<TestRunPanel trace={trace(step)} onAddExtract={vi.fn()} />);
    await expand(user);
    const btn = screen.getByRole("button", { name: "x-request-id 추출" });
    await user.click(btn);
    expect(btn.closest("tr")!.nextElementSibling).toContainElement(confirm());
  });

  it("Set-Cookie 추출 → 그 쿠키 줄 바로 다음 줄", async () => {
    const user = userEvent.setup();
    const step = httpStep({
      response: { ...httpStep().response!, set_cookies: ["a=1", "session=abc", "z=3"] },
    });
    render(<TestRunPanel trace={trace(step)} onAddExtract={vi.fn()} />);
    await expand(user);
    const btn = screen.getByRole("button", { name: "session 추출" });
    await user.click(btn);
    expect(btn.closest("tr")!.nextElementSibling).toContainElement(confirm());
  });
});

describe("TestRunPanel 감싼 JSON 풀기", () => {
  const wrappedBody = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ data: JSON.stringify({ id: 7, token: "T" }), ...extra });
  const withBody = (body: string, over: Partial<StepTrace["response"] & object> = {}) =>
    httpStep({ response: { ...httpStep().response!, body, ...over } });

  it("wrapped body shows inner leaves and the notice", async () => {
    const user = userEvent.setup();
    const onAddExtract = vi.fn();
    render(<TestRunPanel trace={trace(withBody(wrappedBody()))} onAddExtract={onAddExtract} />);
    await expand(user);
    expect(screen.getByText(ko.common.jsonUnwrappedNotice)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "+추출" })[0]);
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onAddExtract).toHaveBeenCalledWith("01J0000000000000000000000A", {
      var: "id",
      from: "body",
      path: "$.data.id",
    });
  });

  it("collapsed row does not parse the body", async () => {
    const user = userEvent.setup();
    render(<TestRunPanel trace={trace(withBody(wrappedBody()))} onAddExtract={vi.fn()} />);
    expect(parseBodyJson).not.toHaveBeenCalled();
    await expand(user);
    expect(vi.mocked(parseBodyJson).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("plain body shows no notice", async () => {
    const user = userEvent.setup();
    render(<TestRunPanel trace={trace(httpStep())} onAddExtract={vi.fn()} />);
    await expand(user);
    expect(screen.queryByText(ko.common.jsonUnwrappedNotice)).toBeNull();
  });

  it("long wrapped body shows the notice inside the full-view dialog", async () => {
    const user = userEvent.setup();
    const step = withBody(wrappedBody({ pad: "x".repeat(600) }));
    render(<TestRunPanel trace={trace(step)} onAddExtract={vi.fn()} />);
    await expand(user);
    await user.click(screen.getByRole("button", { name: /전체 보기·추출/ }));
    expect(
      within(screen.getByRole("dialog")).getByText(ko.common.jsonUnwrappedNotice),
    ).toBeInTheDocument();
  });

  it("truncated or non-JSON body keeps the fallback notice", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <TestRunPanel
        trace={trace(withBody(wrappedBody(), { body_truncated: true }))}
        onAddExtract={vi.fn()}
      />,
    );
    await expand(user);
    expect(screen.getByText(/추출 불가/)).toBeInTheDocument();
    expect(screen.queryByText(ko.common.jsonUnwrappedNotice)).toBeNull();
    unmount();
    render(<TestRunPanel trace={trace(withBody("<html>"))} onAddExtract={vi.fn()} />);
    await expand(user);
    expect(screen.getByText(/추출 불가/)).toBeInTheDocument();
    expect(screen.queryByText(ko.common.jsonUnwrappedNotice)).toBeNull();
  });
});
