import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ReportSetup } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { SetupSection } from "../SetupSection";

const ID1 = "01HX0000000000000000000001";
const ID2 = "01HX0000000000000000000002";

function mk(over: Partial<ReportSetup> = {}): ReportSetup {
  return {
    ok: 98,
    failed: 0,
    interrupted: 0,
    steps: [
      {
        step_id: ID1,
        count: 100,
        errors: 2,
        p50_ms: 41,
        p95_ms: 120,
        max_ms: 310,
        status_counts: { "200": 98, "401": 2 },
        failure_kinds: { status_assert: 2 },
      },
    ],
    ...over,
  };
}

const META = new Map([[ID1, { name: "로그인" }]]);

function renderIt(
  setup: ReportSetup,
  extra: Partial<{
    meta: Map<string, { name: string }>;
    loadModel: "vu" | "open";
    steadyNote: boolean;
  }> = {},
) {
  return render(
    <SetupSection
      setup={setup}
      stepMeta={extra.meta ?? META}
      loadModel={extra.loadModel ?? "vu"}
      steadyNote={extra.steadyNote ?? false}
    />,
  );
}

describe("SetupSection", () => {
  it("기본은 접혀 있고 머리 줄에 요약이 나온다", async () => {
    renderIt(mk());
    const btn = screen.getByRole("button", { name: /준비 스텝 1개 · VU 98개 준비 완료/ });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("로그인")).not.toBeInTheDocument();
    await userEvent.setup().click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("로그인")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "준비 스텝 통계" })).toBeInTheDocument();
    expect(screen.getByText("41")).toBeInTheDocument();
    expect(screen.getByText("200: 98")).toBeInTheDocument();
    expect(screen.getByText(`${ko.report.errorKinds.labels.status_assert}: 2`)).toBeInTheDocument();
  });

  it("준비 실패 종류 http_status는 「상태 코드 400 이상」으로 보이고 영문 키는 안 보인다", async () => {
    const s = mk();
    s.steps[0].failure_kinds = { http_status: 3 };
    renderIt(s);
    await userEvent.setup().click(screen.getByRole("button", { name: /준비 스텝 1개/ }));
    expect(screen.getByText("상태 코드 400 이상: 3")).toBeInTheDocument();
    expect(screen.queryByText(/http_status/)).not.toBeInTheDocument();
  });

  it("failed > 0 이면 처음부터 펼쳐지고 경고가 나온다", () => {
    renderIt(mk({ failed: 2 }));
    expect(screen.getByRole("button", { name: /준비 스텝 1개/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      screen.getByText(
        "VU 2개가 준비 스텝에 실패해 본 스텝을 실행하지 않았습니다. 실제 부하는 설정보다 적었습니다.",
      ),
    ).toBeInTheDocument();
  });

  it("open-loop 문구", () => {
    renderIt(mk({ failed: 2 }), { loadModel: "open" });
    expect(screen.getByRole("button", { name: /슬롯 98개 준비 완료/ })).toBeInTheDocument();
    expect(
      screen.getByText(
        "슬롯 2개가 준비 스텝에 실패해 run에서 빠졌습니다. 그만큼 보내지 못한 요청이 늘었을 수 있습니다.",
      ),
    ).toBeInTheDocument();
  });

  it("interrupted > 0 문구", async () => {
    renderIt(mk({ interrupted: 3 }));
    await userEvent.setup().click(screen.getByRole("button", { name: /준비 스텝/ }));
    expect(screen.getByText("VU 3개는 준비 도중 run이 끝났습니다.")).toBeInTheDocument();
  });

  it("interrupted > 0 문구 — open-loop은 슬롯", async () => {
    renderIt(mk({ interrupted: 3 }), { loadModel: "open" });
    await userEvent.setup().click(screen.getByRole("button", { name: /준비 스텝/ }));
    expect(screen.getByText("슬롯 3개는 준비 도중 run이 끝났습니다.")).toBeInTheDocument();
    expect(screen.queryByText(/VU 3개는/)).not.toBeInTheDocument();
  });

  it("Object 프로토타입 이름의 실패 종류는 글자 그대로 보인다", async () => {
    const base = mk();
    renderIt(mk({ steps: [{ ...base.steps[0], failure_kinds: { constructor: 1 } }] }));
    await userEvent.setup().click(screen.getByRole("button", { name: /준비 스텝/ }));
    expect(screen.getByText("constructor: 1")).toBeInTheDocument();
  });

  it("steadyNote 문구", async () => {
    renderIt(mk(), { steadyNote: true });
    await userEvent.setup().click(screen.getByRole("button", { name: /준비 스텝/ }));
    expect(screen.getByText("유지 구간 안에서도 준비가 실행됐을 수 있습니다.")).toBeInTheDocument();
  });

  it("steadyNote가 없으면 그 문구도 없다", async () => {
    renderIt(mk());
    await userEvent.setup().click(screen.getByRole("button", { name: /준비 스텝/ }));
    expect(screen.queryByText(/유지 구간 안에서도/)).not.toBeInTheDocument();
  });

  it("이름이 없으면 step id를 쓴다", async () => {
    renderIt(mk(), { meta: new Map() });
    await userEvent.setup().click(screen.getByRole("button", { name: /준비 스텝/ }));
    expect(screen.getByText(ID1)).toBeInTheDocument();
  });

  it("아주 긴 이름은 말줄임 + 툴팁이고 스텝 다섯 개도 한 표에 그려진다", async () => {
    const long = "아주긴이름".repeat(40);
    const ids = [ID1, ID2, "03", "04", "05"];
    const steps = ids.map((id) => ({
      step_id: id,
      count: 1,
      errors: 0,
      p50_ms: 1,
      p95_ms: 2,
      max_ms: 3,
      status_counts: { "200": 1 },
      failure_kinds: {},
    }));
    const meta = new Map(ids.map((id) => [id, { name: id === ID1 ? long : `단계 ${id}` }]));
    renderIt(mk({ steps }), { meta });
    await userEvent.setup().click(screen.getByRole("button", { name: /준비 스텝 5개/ }));
    const name = screen.getByText(long);
    expect(name).toHaveAttribute("title", long);
    expect(name.className).toContain("truncate");
    expect(screen.getAllByRole("row")).toHaveLength(6);
  });
});
