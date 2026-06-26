import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioImportPage } from "../ScenarioImportPage";
import { ko } from "../../i18n/ko";

const HAR = JSON.stringify({
  log: {
    pages: [{ title: "쇼핑 흐름" }],
    entries: [
      {
        request: {
          method: "GET",
          url: "https://api.example.com/users",
          headers: [{ name: "accept", value: "application/json" }],
        },
        response: { status: 200, content: { mimeType: "application/json" } },
      },
      {
        request: { method: "GET", url: "https://cdn.example.com/logo.png", headers: [] },
        response: { status: 200, content: { mimeType: "image/png" } },
      },
    ],
  },
});

// method+경로 중복이 있는 HAR: GET /a 두 번(쿼리만 다름) + POST /a 한 번.
const DUP_HAR = JSON.stringify({
  log: {
    entries: [
      {
        request: { method: "GET", url: "https://api.example.com/a?p=1", headers: [] },
        response: { status: 200 },
      },
      {
        request: { method: "GET", url: "https://api.example.com/a?p=2", headers: [] },
        response: { status: 200 },
      },
      {
        request: { method: "POST", url: "https://api.example.com/a", headers: [] },
        response: { status: 200 },
      },
    ],
  },
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/scenarios/import"]}>
      <Routes>
        <Route path="/scenarios/import" element={<ScenarioImportPage />} />
        <Route path="/scenarios/new" element={<div>NEW</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function harFile(content = HAR): File {
  return new File([content], "flow.har", { type: "application/json" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ScenarioImportPage", () => {
  it("R7: HAR 업로드 시 이름이 page title로 프리필되고 미리보기에 step이 뜬다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    const nameInput = await screen.findByLabelText(ko.import.nameLabel);
    await waitFor(() => expect((nameInput as HTMLInputElement).value).toBe("쇼핑 흐름"));
    const preview = screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement;
    expect(preview.value).toContain("GET /users");
  });

  it("R5: 정적 리소스 제외(기본 ON)면 .png 요청이 미리보기에서 빠진다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    const preview = (await screen.findByLabelText(ko.import.preview)) as HTMLTextAreaElement;
    expect(preview.value).not.toContain("logo.png");
    // 토글 끄면 .png 포함
    await user.click(screen.getByLabelText(ko.import.excludeStatic));
    await waitFor(() =>
      expect((screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement).value).toContain(
        "logo.png",
      ),
    );
  });

  it("R5(b): 호스트 체크박스를 끄면 그 호스트 요청이 미리보기에서 빠진다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    const preview = (await screen.findByLabelText(ko.import.preview)) as HTMLTextAreaElement;
    expect(preview.value).toContain("GET /users");
    // 호스트 체크박스(aria-label=호스트명)는 hosts.length>1일 때만 렌더 — 테스트 HAR은 2개 호스트.
    await user.click(screen.getByLabelText("api.example.com"));
    await waitFor(() =>
      expect((screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement).value).not.toContain(
        "GET /users",
      ),
    );
  });

  it("R5(c): 요청별 체크박스를 끄면 그 요청이 미리보기에서 빠진다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    const preview = (await screen.findByLabelText(ko.import.preview)) as HTMLTextAreaElement;
    expect(preview.value).toContain("GET /users");
    await user.click(screen.getByLabelText("GET https://api.example.com/users"));
    await waitFor(() =>
      expect((screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement).value).not.toContain(
        "GET /users",
      ),
    );
  });

  it("R6: status assert 토글 시 미리보기에 status가 등장", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.statusAssert));
    await waitFor(() =>
      expect((screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement).value).toMatch(
        /- status:/,
      ),
    );
  });

  it("R10: 복사 버튼이 클립보드에 YAML을 쓴다", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByRole("button", { name: ko.import.copy }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("GET /users"));
  });

  it("R11: 깨진 HAR이면 alert를 보여주고 크래시하지 않는다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile("{not json"));
    expect(await screen.findByRole("alert")).toHaveTextContent(ko.import.parseError);
  });

  it("a11y: 옵션 fieldset에 그룹 라벨(legend)이 있다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    expect(await screen.findByRole("group", { name: ko.import.options })).toBeInTheDocument();
  });

  it("UX: 표시할 요청이 없으면(전부 정적·기본 제외) 안내 문구를 보여준다", async () => {
    const user = userEvent.setup();
    const staticOnly = JSON.stringify({
      log: {
        entries: [
          {
            request: { method: "GET", url: "https://cdn.example.com/logo.png", headers: [] },
            response: { status: 200, content: { mimeType: "image/png" } },
          },
        ],
      },
    });
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(staticOnly));
    await screen.findByLabelText(ko.import.preview);
    expect(screen.getByText(ko.import.noRequests)).toBeInTheDocument();
  });

  it("R9: 편집기로 보내기 → /scenarios/new로 navigate", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByRole("button", { name: ko.import.toEditor }));
    expect(await screen.findByText("NEW")).toBeInTheDocument();
  });

  it("R4/R5: 요약에 선택/전체/중복 수와 기준 문구, 중복 행에 배지", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(DUP_HAR));
    await screen.findByLabelText(ko.import.preview);
    // 3개 요청, 그 중 1개가 중복(2번째 GET /a)
    expect(screen.getByText(ko.import.selectionSummary(3, 3, 1))).toBeInTheDocument();
    // 중복 배지는 정확히 1개
    expect(screen.getAllByText(ko.import.dupBadge)).toHaveLength(1);
  });

  it("R2: 전체 해제 → YAML steps 0, R1: 전체 선택 → 복구", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(DUP_HAR));
    const preview = (await screen.findByLabelText(ko.import.preview)) as HTMLTextAreaElement;
    await user.click(screen.getByRole("button", { name: ko.import.deselectAll }));
    // 전체 해제해도 harToScenarioYaml은 `steps: []`를 emit한다(빈 배열) — 내용으로 단언(F1).
    await waitFor(() => expect(preview.value).toContain("steps: []"));
    await user.click(screen.getByRole("button", { name: ko.import.selectAll }));
    await waitFor(() =>
      expect((screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement).value).toContain(
        "/a",
      ),
    );
  });

  it("R3: 중복 해제 → 그룹당 첫 요청만 남는다(2번째 GET /a 해제)", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(DUP_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByRole("button", { name: ko.import.dedup }));
    // 중복 해제 후 선택 2 / 전체 3 / 중복 1
    await waitFor(() =>
      expect(screen.getByText(ko.import.selectionSummary(2, 3, 1))).toBeInTheDocument(),
    );
  });
});
