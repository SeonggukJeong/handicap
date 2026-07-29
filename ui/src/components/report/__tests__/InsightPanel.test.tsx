import { render, screen } from "@testing-library/react";
import { beforeEach, describe, it, expect } from "vitest";
import userEvent from "@testing-library/user-event";
import { InsightPanel } from "../InsightPanel";
import type { Insight } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";

const meta = new Map([["s1", { id: "s1", name: "checkout", method: "GET", url: "/c" }]]);

// 픽스처 상수 — D7·remount 두 테스트가 공유한다.
const statusClass5xx: Insight = {
  kind: "status_class",
  severity: "critical",
  status_class: "5xx",
  pct: 0.12,
  count: 1203,
};
const saturatedWithSlots: Insight = {
  kind: "load_gen_saturated",
  severity: "warning",
  value: 40,
  count: 260,
  cause: "slots",
  recommended: 23,
  achieved_per_sec: 2.7,
  target_per_sec: 20,
};

beforeEach(() => window.localStorage.clear()); // 저장소의 localStorage 파일간 누수 선례

describe("InsightPanel", () => {
  it("renders nothing when empty", () => {
    const { container } = render(<InsightPanel insights={[]} meta={new Map()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a message per kind, resolving step name from meta", () => {
    const insights: Insight[] = [
      { kind: "slo_failure", severity: "critical", count: 2 },
      { kind: "status_class", severity: "critical", status_class: "5xx", pct: 0.12, count: 1203 },
      { kind: "slowest_step", severity: "info", step_id: "s1", metric: "p95_ms", value: 1240 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/SLO 실패: 2개 기준 미달/)).toBeInTheDocument();
    expect(screen.getByText(/5xx가 응답의 12\.0% \(1,203건\)/)).toBeInTheDocument();
    expect(screen.getByText(/checkout.*p95 1,240ms로 가장 느림/)).toBeInTheDocument();
  });

  it("preserves backend order", () => {
    const insights: Insight[] = [
      { kind: "slo_failure", severity: "critical", count: 1 },
      { kind: "slowest_step", severity: "info", step_id: "s1", value: 10 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    const items = screen.getAllByTestId("insight").map((e) => e.textContent);
    expect(items[0]).toMatch(/SLO 실패/);
    expect(items[1]).toMatch(/가장 느림/);
  });

  it("kind별 '다음 행동' 줄이 렌더된다", async () => {
    const insights: Insight[] = [
      { kind: "slowest_step", severity: "info", step_id: "s1", metric: "p95_ms", value: 1240 },
      { kind: "status_class", severity: "critical", status_class: "5xx", pct: 0.12, count: 3 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    await userEvent
      .setup()
      .click(screen.getByRole("checkbox", { name: ko.report.insightActionsToggle }));
    const action = screen.getByText(/스텝 표를 내보내 개발팀과 공유하세요/);
    expect(action).toBeInTheDocument();
    expect(screen.getByText(/5xx면 서버 측 문제부터 확인하세요/)).toBeInTheDocument();
    // 화살표는 장식 글리프 — 스크린리더가 "right arrow"를 읽지 않게 aria-hidden (repo 컨벤션: ↳/›)
    expect(action.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("load_gen_saturated cause 없음 — 헤드라인 + 폴백 행동 줄 (워커 CPU 언급 없음, ADR-0046)", async () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 7500, count: 320 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    await userEvent
      .setup()
      .click(screen.getByRole("checkbox", { name: ko.report.insightActionsToggle }));
    // 헤드라인: 초당 최대 N건 + 못 보낸 요청 M건 (천단위 구분)
    expect(screen.getByText(/초당 최대 7,500건.*못 보낸 요청이 320건/)).toBeInTheDocument();
    // 폴백 행동 줄 (R13 2-way: cause=slots|sut|없음 뿐, 워커 CPU 언급 없음)
    expect(
      screen.getByText(/동시 실행 수\(max_in_flight\)를 늘려 다시 실행하세요/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/워커 CPU/)).toBeNull();
  });

  it("slo_pass·미지 kind엔 토글을 켜도 조치 줄이 없다", async () => {
    const insights: Insight[] = [
      { kind: "slo_pass", severity: "info" },
      { kind: "future_kind", severity: "info" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    await userEvent
      .setup()
      .click(screen.getByRole("checkbox", { name: ko.report.insightActionsToggle }));
    expect(screen.queryByText(/→/)).toBeNull();
  });

  it("기본(숨김)에서 일반 안내는 감추되 계산된 권장치는 남긴다", () => {
    render(<InsightPanel insights={[statusClass5xx, saturatedWithSlots]} meta={new Map()} />);
    // 일반 코칭은 숨김.
    // ⚠ `new RegExp(ko.insightActions.status_class)`를 쓰지 말 것 — 그 문구의
    // "(인증·파라미터)"가 캡처 그룹으로 소비돼 괄호 없는 문자열을 요구하게 되고,
    // 그러면 일반 코칭이 *실제로 보여도* 이 단언이 통과한다(공허). 메타문자 없는
    // 리터럴 조각으로 고정한다.
    expect(screen.queryByText(/서버 측 문제부터 확인하세요/)).toBeNull();
    // 측정값 기반 권장치는 항상 표시 — 이 단언이 없으면 "조치문 렌더를 통째로
    // 지워도 통과"하는 공허한 테스트가 된다. 두 단언은 반드시 짝으로.
    expect(screen.getByText(/max_in_flight/)).toBeInTheDocument();
  });

  // US2 — 영속 배선. 이 테스트가 없으면 구현자가 `useState(false)`로 써도
  // ① prefs 단위 테스트 ② 토글 ON 테스트들 ③ 기본-숨김 테스트가 전부 통과해
  // US2의 자동 증거가 0이 된다(라이브에서만 드러남).
  it("토글 선택은 재마운트 후에도 유지된다", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<InsightPanel insights={[statusClass5xx]} meta={new Map()} />);
    await user.click(screen.getByRole("checkbox", { name: ko.report.insightActionsToggle }));
    expect(screen.getByText(/서버 측 문제부터 확인하세요/)).toBeInTheDocument();

    unmount();
    render(<InsightPanel insights={[statusClass5xx]} meta={new Map()} />);
    expect(screen.getByText(/서버 측 문제부터 확인하세요/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: ko.report.insightActionsToggle })).toBeChecked();
  });

  it("load_gen_saturated slots — 목표/달성 도착률·유실·권장 슬롯 수치를 행동 줄에 렌더 (R12)", () => {
    const insights: Insight[] = [
      {
        kind: "load_gen_saturated",
        severity: "warning",
        value: 3,
        count: 260,
        cause: "slots",
        recommended: 23,
        target_per_sec: 20,
        achieved_per_sec: 2.7,
      },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/초당 20회/)).toBeInTheDocument();
    expect(screen.getByText(/2\.7회/)).toBeInTheDocument();
    // Math.max(0, 20-2.7)=17.3 → toFixed(1)="17.3", "~17"은 그 부분문자열
    expect(screen.getByText(/~17/)).toBeInTheDocument();
    expect(screen.getByText(/최소 ~23\(으\)로 올려/)).toBeInTheDocument();
    // 상한(10,000) 미도달이면 slotsAtCap 문구는 없다
    expect(screen.queryByText(/슬롯 상한/)).toBeNull();
  });

  it("load_gen_saturated slots — recommended가 슬롯 상한(10,000) 이상이면 상한 문구를 덧붙인다 (R13)", () => {
    const insights: Insight[] = [
      {
        kind: "load_gen_saturated",
        severity: "warning",
        value: 50,
        count: 9000,
        cause: "slots",
        recommended: 10_000,
        target_per_sec: 100,
        achieved_per_sec: 0.5,
      },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/최소 ~10,000\(으\)로 올려/)).toBeInTheDocument();
    expect(screen.getByText(/슬롯 상한\(10,000\)에 도달했어요/)).toBeInTheDocument();
  });

  it("load_gen_saturated slots — target_per_sec/achieved_per_sec/recommended 중 하나라도 없으면 폴백 (구식 리포트 방어)", async () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 9000, count: 12, cause: "slots" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    await userEvent
      .setup()
      .click(screen.getByRole("checkbox", { name: ko.report.insightActionsToggle }));
    expect(
      screen.getByText(/동시 실행 수\(max_in_flight\)를 늘려 다시 실행하세요/),
    ).toBeInTheDocument();
  });

  it("load_gen_saturated sut — 서버 응답 열화 신호 + 슬롯·부하 증설을 보류하라는 행동 줄", () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 800, count: 90, cause: "sut" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/대상 서버\(SUT\)가 응답 열화 신호를 보여요/)).toBeInTheDocument();
    expect(screen.getByText(/지금 슬롯·부하를 늘리면 서버만 더 힘들어져요/)).toBeInTheDocument();
    expect(screen.queryByText(/worker_count를/)).toBeNull();
  });

  it("nonzero<0.05% pct는 '<0.1%'로 floor (R5)", () => {
    const insights: Insight[] = [
      { kind: "status_class", severity: "critical", status_class: "5xx", pct: 0.0003, count: 1 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/<0\.1%/)).toBeInTheDocument();
  });

  it("load_gen_saturated onset_second면 포화 시점 절을 헤드라인에 렌더", () => {
    const insights: Insight[] = [
      {
        kind: "load_gen_saturated",
        severity: "warning",
        value: 7500,
        count: 320,
        onset_second: 12,
      },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/약 12초 지점부터 포화/)).toBeInTheDocument();
  });
});
