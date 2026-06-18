import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsertTemplateModal } from "../InsertTemplateModal";
import { useScenarioEditor } from "../../../scenario/store";

vi.mock("../../../api/stepTemplates", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../api/stepTemplates")>();
  return {
    ...mod,
    listStepTemplates: vi.fn(),
    getStepTemplate: vi.fn(),
    deleteStepTemplate: vi.fn(),
  };
});
import { deleteStepTemplate, getStepTemplate, listStepTemplates } from "../../../api/stepTemplates";

const SCENARIO = `version: 1
name: target
steps:
  - id: 01HX0000000000000000000001
    name: First
    type: http
    request:
      method: GET
      url: /1
`;

const TPL_SUMMARY = {
  id: "T1",
  name: "login-flow",
  description: "로그인",
  step_count: 1,
  created_at: 0,
  // 2025-12-12 근방 (epoch ms) — Fix 1: *1000 버그 검증용 실제 ms 값
  updated_at: 1765500000000,
};

// 야생 비-ULID id — 삽입 경로가 재발급하므로 그대로 통과해야 한다 (spec §5.2 순서 락인)
const TPL_FULL = {
  ...TPL_SUMMARY,
  steps_yaml:
    "- id: wild-1\n  name: TplStep\n  type: http\n  request:\n    method: GET\n    url: /tpl\n",
};

function mount(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InsertTemplateModal onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe("InsertTemplateModal", () => {
  beforeEach(() => {
    vi.mocked(listStepTemplates).mockReset().mockResolvedValue([TPL_SUMMARY]);
    vi.mocked(getStepTemplate).mockReset();
    vi.mocked(deleteStepTemplate).mockReset().mockResolvedValue(undefined);
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(SCENARIO);
  });

  it("목록을 렌더한다 (이름/설명/스텝 수)", async () => {
    mount();
    expect(await screen.findByText("login-flow")).toBeInTheDocument();
    // 설명/스텝 수는 한 <p>의 joined 텍스트("스텝 1개 · 로그인 · <날짜>") — 정규식 매처 필수
    expect(screen.getByText(/로그인/)).toBeInTheDocument();
    expect(screen.getByText(/스텝 1개/)).toBeInTheDocument();
    // Fix 1: updated_at ms 정상 변환 확인 — toLocaleString 결과에 연도가 포함되어야 한다
    // (2025-12-12 근방, *1000이면 56379년이 나옴)
    expect(
      screen.getByText((content) => content.includes("2025") || content.includes("2026")),
    ).toBeInTheDocument();
  });

  it("삽입: 야생 id도 재발급 경유로 성공, 새 스텝 선택 + onClose", async () => {
    const user = userEvent.setup();
    vi.mocked(getStepTemplate).mockResolvedValue(TPL_FULL);
    const onClose = mount();
    await user.click(await screen.findByRole("button", { name: "삽입" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const st = useScenarioEditor.getState();
    expect(st.model?.steps.map((s) => s.name)).toEqual(["First", "TplStep"]);
    // 재발급: 야생 id는 사라지고, 새 스텝이 선택돼 있다
    expect(st.yamlText).not.toContain("wild-1");
    const inserted = st.model?.steps[1];
    expect(st.selectedStepId).toBe(inserted?.id);
  });

  it("호환 불가 템플릿(2단 중첩)은 에러 표시 + 미삽입", async () => {
    const user = userEvent.setup();
    vi.mocked(getStepTemplate).mockResolvedValue({
      ...TPL_SUMMARY,
      steps_yaml:
        "- id: a\n  name: L\n  type: loop\n  repeat: 1\n  do:\n    - id: b\n      name: L2\n      type: loop\n      repeat: 1\n      do:\n        - id: c\n          name: x\n          type: http\n          request:\n            method: GET\n            url: /x\n",
    });
    mount();
    await user.click(await screen.findByRole("button", { name: "삽입" }));
    expect(await screen.findByText(/호환되지 않습니다/)).toBeInTheDocument();
    expect(useScenarioEditor.getState().model?.steps).toHaveLength(1);
  });

  it("list fetch 실패 시 에러 배너 표시 + 빈 목록 문구 미표시 (Fix 2)", async () => {
    vi.mocked(listStepTemplates).mockRejectedValue(new Error("network down"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
    expect(screen.queryByText(/저장된 템플릿이 없습니다/)).not.toBeInTheDocument();
  });

  it("삭제: confirm 후 deleteStepTemplate 호출", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mount();
    await user.click(await screen.findByRole("button", { name: "삭제" }));
    await waitFor(() => expect(deleteStepTemplate).toHaveBeenCalledWith("T1"));
    confirmSpy.mockRestore(); // Fix 3: spy 복원
  });

  it("삭제된 템플릿 삽입(GET 404)은 에러 표시 + 목록 갱신 + 미삽입 (spec §6)", async () => {
    const user = userEvent.setup();
    vi.mocked(getStepTemplate).mockRejectedValue(new Error("not found"));
    mount();
    await user.click(await screen.findByRole("button", { name: "삽입" }));
    expect(await screen.findByText(/not found/)).toBeInTheDocument();
    // 목록 갱신 — list.refetch() 경유 listStepTemplates 재호출
    await waitFor(() => expect(listStepTemplates).toHaveBeenCalledTimes(2));
    expect(useScenarioEditor.getState().model?.steps).toHaveLength(1);
  });

  it("빈 목록이면 빈 상태 문구", async () => {
    vi.mocked(listStepTemplates).mockResolvedValue([]);
    mount();
    expect(await screen.findByText(/저장된 템플릿이 없습니다/)).toBeInTheDocument();
  });

  it("삭제 실패 시 에러 배너 표시 (Fix 2)", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(deleteStepTemplate).mockRejectedValue(new Error("delete failed"));
    mount();
    await user.click(await screen.findByRole("button", { name: "삭제" }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((el) => el.textContent === "delete failed")).toBe(true);
    confirmSpy.mockRestore();
  });

  // ── 파라미터화 2-phase 테스트 (R9, R10, R13, R14, R15) ──

  const TPL_WITH_TOKENS = {
    ...TPL_SUMMARY,
    steps_yaml:
      "- id: wild-2\n  name: TplStep\n  type: http\n  request:\n    method: GET\n    url: '{{token}}'\n    headers:\n      X-Host: '${BASE_URL}'\n",
  };

  it("opens the parameterization form when the chosen template has tokens (R9/R14)", async () => {
    const user = userEvent.setup();
    vi.mocked(getStepTemplate).mockResolvedValue(TPL_WITH_TOKENS);
    const onClose = mount();

    // Click the list-phase 삽입 button
    await user.click(await screen.findByRole("button", { name: "삽입" }));

    // Modal title swaps to paramTitle
    expect(await screen.findByText("변수 조정 후 삽입")).toBeInTheDocument();

    // Section headings present
    expect(screen.getByText("흐름 변수 {{ }}")).toBeInTheDocument();
    expect(screen.getByText("환경 변수 ${ }")).toBeInTheDocument();

    // Row for flow token "token" — 그대로 유지 radio should be checked
    const keepRadios = screen.getAllByRole("radio", { name: "그대로 유지" });
    expect(keepRadios.length).toBeGreaterThanOrEqual(2);
    expect(keepRadios[0]).toBeChecked();

    // insertTemplateSteps NOT called yet
    expect(useScenarioEditor.getState().model?.steps).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("inserts directly with no params form when the template has no tokens (R10)", async () => {
    const user = userEvent.setup();
    // TPL_FULL has no {{}} or ${} tokens
    vi.mocked(getStepTemplate).mockResolvedValue(TPL_FULL);
    const onClose = mount();

    await user.click(await screen.findByRole("button", { name: "삽입" }));

    // onClose called directly — no params phase
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    // params headings never appear
    expect(screen.queryByText("변수 조정 후 삽입")).not.toBeInTheDocument();
    expect(screen.queryByText("흐름 변수 {{ }}")).not.toBeInTheDocument();

    // Step was inserted
    expect(useScenarioEditor.getState().model?.steps).toHaveLength(2);
  });

  it("disables 삽입 when a rename target is invalid (R13)", async () => {
    const user = userEvent.setup();
    vi.mocked(getStepTemplate).mockResolvedValue(TPL_WITH_TOKENS);
    mount();

    // Enter params phase
    await user.click(await screen.findByRole("button", { name: "삽입" }));
    await screen.findByText("변수 조정 후 삽입");

    // Pick 다른 이름으로 for the flow token "token"
    const renameRadios = screen.getAllByRole("radio", { name: "다른 이름으로" });
    await user.click(renameRadios[0]);

    // Type an invalid rename (contains a space)
    // Note: input with list= (datalist) has implicit ARIA role "combobox" not "textbox" (ui/CLAUDE.md footgun)
    const renameInput = screen.getByRole("combobox", { name: "rename token" });
    await user.type(renameInput, "bad name");

    // badRename warning shown
    expect(
      await screen.findByText("변수명에 공백/중괄호/콜론을 쓸 수 없습니다"),
    ).toBeInTheDocument();

    // confirm 삽입 button disabled
    const confirmBtn = screen.getByRole("button", { name: "삽입" });
    expect(confirmBtn).toBeDisabled();
  });

  it("applies a literal substitution into the inserted steps (R9/R11)", async () => {
    const user = userEvent.setup();
    vi.mocked(getStepTemplate).mockResolvedValue(TPL_WITH_TOKENS);
    const onClose = mount();

    // Enter params phase
    await user.click(await screen.findByRole("button", { name: "삽입" }));
    await screen.findByText("변수 조정 후 삽입");

    // Pick 값으로 교체 for the flow token "token"
    const literalRadios = screen.getAllByRole("radio", { name: "값으로 교체" });
    await user.click(literalRadios[0]);

    // Type the literal value
    const literalInput = screen.getByRole("textbox", { name: "literal token" });
    await user.type(literalInput, "XYZ");

    // Confirm insert
    await user.click(screen.getByRole("button", { name: "삽입" }));

    // onClose called
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    // The inserted YAML should contain "XYZ" and not "{{token}}"
    const st = useScenarioEditor.getState();
    expect(st.model?.steps).toHaveLength(2);
    expect(st.yamlText).toContain("XYZ");
    expect(st.yamlText).not.toContain("{{token}}");
  });
});
