import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { ScenarioEditPage } from "../ScenarioEditPage";
import { ScenarioNewPage } from "../ScenarioNewPage";

/** 생성 변수(dynamic-vars) 페이지 통합 스모크 — Task 7, 신규 src 0.
 *  두 마운트 경로(/scenarios/new · /scenarios/{id})에서 각각 실제로 동작함을 락인
 *  ([[live-verify-all-mount-paths]] 미러: 한 화면만 정상인 버그 클래스 방지). */

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// 4종 생성기(date/random_int/uuid/random_string)를 모두 담은 서버측 YAML — 스토어
// loadFromString round-trip 락인의 소스(ScenarioEditPage T7 케이스들).
const GEN_SCENARIO_YAML = `version: 1
name: "genvars-demo"
cookie_jar: auto
variables:
  checkin:
    gen: date
    format: "%Y-%m-%d"
    tz: "Asia/Seoul"
  qty:
    gen: random_int
    min: 1
    max: 100
  order_ref:
    gen: uuid
  session_id:
    gen: random_string
    length: 8
steps: []
`;

function scenarioFixture(yaml: string) {
  return {
    id: "S1",
    name: "genvars-demo",
    yaml,
    version: 1,
    created_at: 0,
    updated_at: 0,
  };
}

function routeFetch(url: string, scenario: ReturnType<typeof scenarioFixture>): Response {
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(scenario);
  // listEnvironments parses EnvironmentListSchema = { environments: [...] } (ScenarioEditPage/
  // ScenarioNewPage.testrun.test.tsx 선례 — bare [] 는 .parse 실패로 쿼리 에러).
  if (url.endsWith("/api/environments")) return jsonResponse({ environments: [] });
  return jsonResponse({ error: "unexpected" }, 500);
}

function renderEditPage(yaml: string) {
  const scenario = scenarioFixture(yaml);
  fetchMock.mockImplementation((url: string | URL) =>
    Promise.resolve(routeFetch(String(url), scenario)),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [{ path: "/scenarios/:id/edit", element: <ScenarioEditPage /> }],
    {
      initialEntries: ["/scenarios/S1/edit"],
    },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function renderNewPage() {
  fetchMock.mockImplementation((url: string | URL) =>
    Promise.resolve(routeFetch(String(url), scenarioFixture(GEN_SCENARIO_YAML))),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: "/scenarios/new", element: <ScenarioNewPage /> },
      { path: "/", element: <div>HOME</div> },
    ],
    { initialEntries: ["/scenarios/new"] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("생성 변수 — 페이지 통합 스모크 + YAML 왕복 락인 (dynamic-vars T7)", () => {
  it("/scenarios/{id}: 스토어 loadFromString(4종 생성기 YAML) → 패널에 4종 배지 렌더 + model round-trip 유지", async () => {
    renderEditPage(GEN_SCENARIO_YAML);
    // 데이터 로드+시드 완료 신호 — 기존 ScenarioEditPage.testrun 하니스와 동일.
    await screen.findByRole("button", { name: "저장" });

    const badges: [string, string][] = [
      ["checkin", ko.editor.genTypeDate],
      ["qty", ko.editor.genTypeRandomInt],
      ["order_ref", ko.editor.genTypeUuid],
      ["session_id", ko.editor.genTypeRandomString],
    ];
    for (const [name, label] of badges) {
      const li = screen.getByRole("button", { name: ko.editor.varExpandAria(name) }).closest("li")!;
      // 배지는 header row(li의 첫 자식 div)에만 있다 — uuid는 genTypeLabel과 genSummary가
      // 둘 다 "UUID"라 li 전체 getByText는 접힘 요약줄과 다중매치(false ambiguity, 버그
      // 아님) → 배지의 고유 클래스(bg-indigo-50)로 정확히 그 요소만 스코프.
      const badge = li.querySelector(".bg-indigo-50");
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe(label);
    }

    // round-trip: 파싱된 model이 문자열로 뭉개지지 않고 GenSpec 형태를 그대로 유지한다
    // (declared value가 문자열이 아니라 객체 — genVars.isGenSpec 계약).
    const model = useScenarioEditor.getState().model!;
    expect(model.variables.checkin).toEqual({ gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul" });
    expect(model.variables.qty).toEqual({ gen: "random_int", min: 1, max: 100 });
    expect(model.variables.order_ref).toEqual({ gen: "uuid" });
    expect(model.variables.session_id).toEqual({ gen: "random_string", length: 8 });
  });

  it("/scenarios/new: 변수 추가 → date 전환 → yamlText에 gen: date · tz: Asia/Seoul가 실린다(모델 경유)", async () => {
    const user = userEvent.setup();
    renderNewPage();

    // U3: 갤러리 단계를 지나야 에디터가 mount된다 — 빈 시나리오 선택
    await user.click(
      await screen.findByRole("button", { name: new RegExp(ko.templates.blankName) }),
    );

    // "추가" 라벨은 변수 패널의 add-row 버튼과 ScenarioDefaults의 다른 add-row가 공유 —
    // 반드시 "변수" region으로 스코프(같은 라벨 여럿 함정, ui/CLAUDE.md).
    const varsRegion = screen.getByRole("region", { name: ko.editor.variablesTitle });
    const newVarInput = await within(varsRegion).findByPlaceholderText("new_var");
    await user.type(newVarInput, "checkin");
    await user.click(within(varsRegion).getByRole("button", { name: ko.editor.variablesAdd }));

    await user.click(screen.getByRole("button", { name: ko.editor.varExpandAria("checkin") }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: ko.editor.genFieldType("checkin") }),
      ko.editor.genTypeDate,
    );

    // Monaco DOM은 불신 대상 — 저장경로 검증은 라이브에서, 여기선 store yamlText(모델 경유)로.
    // yaml 라이브러리의 quote-style(plain vs "quoted")은 신규 createNode 시 구현
    // 세부사항이라 값 자체만 quote-무관 정규식으로 단언.
    const yamlText = useScenarioEditor.getState().yamlText;
    expect(yamlText).toContain("gen: date");
    expect(yamlText).toMatch(/tz:\s*"?Asia\/Seoul"?/);
  });

  it("/scenarios/{id}: '워커 로컬' tz 선택 시 yamlText에서 tz: 키가 실제로 소멸한다(setVariableGen undefined-strip 계약, orchestrator fold)", async () => {
    const user = userEvent.setup();
    renderEditPage(GEN_SCENARIO_YAML);
    await screen.findByRole("button", { name: "저장" });

    await user.click(screen.getByRole("button", { name: ko.editor.varExpandAria("checkin") }));
    expect(useScenarioEditor.getState().yamlText).toMatch(/tz:\s*"?Asia\/Seoul"?/);

    await user.selectOptions(
      screen.getByRole("combobox", { name: ko.editor.genFieldTz("checkin") }),
      ko.editor.genTzWorkerLocal,
    );

    const yamlText = useScenarioEditor.getState().yamlText;
    expect(yamlText).not.toContain("tz:");
    expect(yamlText).toContain("gen: date"); // 나머지 스펙은 그대로 잔존
  });
});
