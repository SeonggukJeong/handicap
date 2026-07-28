import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scenarios/import"]}>
        <Routes>
          <Route path="/scenarios/import" element={<ScenarioImportPage />} />
          <Route path="/scenarios/new" element={<div>NEW</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function harFile(content = HAR): File {
  return new File([content], "flow.har", { type: "application/json" });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // 신규 useEnvironmentsWithVars가 HAR 로드 시 무조건 GET /api/environments를 발화 —
  // 개별 테스트의 vi.stubGlobal이 이 baseline을 덮어쓴다.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse({ environments: [] }))),
  );
});

const SINGLE_HOST_HAR = JSON.stringify({
  log: {
    entries: [
      {
        request: { method: "GET", url: "https://api.example.com/users", headers: [] },
        response: { status: 200 },
      },
    ],
  },
});

const TWO_HOST_HAR = JSON.stringify({
  log: {
    entries: [
      {
        request: { method: "GET", url: "https://api.example.com/users", headers: [] },
        response: { status: 200 },
      },
      {
        request: { method: "GET", url: "https://auth.example.com/login", headers: [] },
        response: { status: 200 },
      },
    ],
  },
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

  it("R7/R8: 단일 호스트 HAR에서 치환 켜면 BASE_URL 입력 1개", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const varInput = screen.getByLabelText(
      ko.import.varNameLabel("api.example.com"),
    ) as HTMLInputElement;
    expect(varInput.value).toBe("BASE_URL");
  });

  it("R9: 치환 켜면 YAML url이 ${BASE_URL}/path", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    await waitFor(() =>
      expect((screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement).value).toContain(
        "url: ${BASE_URL}/users",
      ),
    );
  });

  it("R8: 2-호스트면 변수명 2개(BASE_URL, BASE_URL_2)", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    expect(
      (screen.getByLabelText(ko.import.varNameLabel("api.example.com")) as HTMLInputElement).value,
    ).toBe("BASE_URL");
    expect(
      (screen.getByLabelText(ko.import.varNameLabel("auth.example.com")) as HTMLInputElement).value,
    ).toBe("BASE_URL_2");
  });

  it("R11: 빈 변수명이면 [환경으로 등록] 비활성 + 경고", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const varInput = screen.getByLabelText(ko.import.varNameLabel("api.example.com"));
    await user.clear(varInput);
    expect(screen.getByRole("button", { name: ko.import.registerEnv })).toBeDisabled();
    expect(screen.getByText(ko.import.varNameEmpty)).toBeInTheDocument();
  });

  it("R11: 예약어(vu_id)면 soft 경고지만 등록은 활성", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const varInput = screen.getByLabelText(ko.import.varNameLabel("api.example.com"));
    await user.clear(varInput);
    await user.type(varInput, "vu_id");
    expect(screen.getByText(ko.import.varNameReserved("vu_id"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.import.registerEnv })).toBeEnabled();
  });

  it("R10: [환경으로 등록] → POST /api/environments 페이로드 + 성공 표기", async () => {
    const user = userEvent.setup();
    let posted: unknown = null;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/environments") && init?.method === "POST") {
        posted = JSON.parse(String(init.body));
        return Promise.resolve(
          jsonResponse(
            {
              id: "E1",
              name: "api.example.com",
              vars: { BASE_URL: "https://api.example.com" },
              created_at: 1,
              updated_at: 1,
            },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ environments: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    await user.click(screen.getByRole("button", { name: ko.import.registerEnv }));
    await waitFor(() =>
      expect(posted).toEqual({
        name: "api.example.com",
        vars: { BASE_URL: "https://api.example.com" },
      }),
    );
    expect(await screen.findByText(ko.import.envRegistered("api.example.com"))).toBeInTheDocument();
  });

  it("Minor: 미리보기 비면 선택 툴바를 숨긴다", async () => {
    const user = userEvent.setup();
    const staticOnly = JSON.stringify({
      log: {
        entries: [
          {
            request: { method: "GET", url: "https://cdn.example.com/app.js", headers: [] },
            response: { status: 200, content: { mimeType: "application/javascript" } },
          },
        ],
      },
    });
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(staticOnly));
    await screen.findByLabelText(ko.import.preview);
    // previewEntries 비면 선택 툴바 없음
    expect(screen.queryByRole("button", { name: ko.import.selectAll })).not.toBeInTheDocument();
    // 안내 문구는 표시
    expect(screen.getByText(ko.import.noRequests)).toBeInTheDocument();
  });

  it("Finding1: 변수명 후행 공백은 trim돼야 YAML에 ${VAR }가 아닌 ${VAR}가 나온다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const varInput = screen.getByLabelText(ko.import.varNameLabel("api.example.com"));
    await user.clear(varInput);
    await user.type(varInput, "MYVAR "); // trailing space
    const preview = screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement;
    await waitFor(() => expect(preview.value).toContain("url: ${MYVAR}/users"));
    // 후행 공백이 보존되면 "${MYVAR }/users"가 나타남 — 이 단언이 실패하면 버그.
    expect(preview.value).not.toContain("${MYVAR }");
  });

  it("ds-spread T2: var-name Input renders after HAR upload + host-var enabled", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    // After converting raw <input> → <Input>, aria-label passthrough must still work.
    expect(screen.getByLabelText(ko.import.varNameLabel("api.example.com"))).toBeInTheDocument();
  });

  it("R10: 409면 서버 메시지를 alert로", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/environments") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ error: "같은 이름의 환경이 이미 있습니다" }, 409));
      }
      return Promise.resolve(jsonResponse({ environments: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    await user.click(screen.getByRole("button", { name: ko.import.registerEnv }));
    expect(await screen.findByRole("alert")).toHaveTextContent("같은 이름의 환경이 이미 있습니다");
  });

  it("UD-R6c: 미리보기 행 텍스트·체크박스 aria-label이 디코딩 표시", async () => {
    const user = userEvent.setup();
    renderPage();
    const encodedHar = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: "GET",
              url: "https://api.example.com/%EA%B2%80%EC%83%89?q=%ED%95%9C%20%EA%B8%80",
              headers: [],
            },
            response: { status: 200, content: { mimeType: "text/html" } },
          },
        ],
      },
    });
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(encodedHar));
    // 행 텍스트와 체크박스 accname 둘 다 디코딩 형태 (인덱스 스코프 불필요 — 단일 행)
    expect(await screen.findByText("GET https://api.example.com/검색?q=한 글")).toBeInTheDocument();
    expect(screen.getByLabelText("GET https://api.example.com/검색?q=한 글")).toBeInTheDocument();
  });
});

const STAGING_ENV = {
  id: "E10",
  name: "스테이징",
  vars: { API_HOST: "https://api.example.com" },
  created_at: 1,
  updated_at: 5,
};

// 목록+단건을 함께 스텁하는 헬퍼 — 힌트 계열 케이스 공용 (mock 반환 = call-count 단언용)
function stubEnvFetch(envs: (typeof STAGING_ENV)[]) {
  const fetchMock = vi.fn((url: string) => {
    const s = String(url);
    const single = envs.find((e) => s.endsWith(`/api/environments/${e.id}`));
    if (single) return Promise.resolve(jsonResponse(single));
    return Promise.resolve(
      jsonResponse({
        environments: envs.map(({ id, name, created_at, updated_at, vars }) => ({
          id,
          name,
          created_at,
          updated_at,
          var_count: Object.keys(vars).length,
        })),
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("host-환경 힌트: 프리필", () => {
  it("US2: 매치된 host의 var 입력이 기존 환경 이름으로 프리필", async () => {
    const user = userEvent.setup();
    stubEnvFetch([STAGING_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    // 매치 settle 후: api 행 = API_HOST(매치), auth 행 = BASE_URL_2(기본 유지)
    expect(await screen.findByDisplayValue("API_HOST")).toBeInTheDocument();
    expect(screen.getByDisplayValue("BASE_URL_2")).toBeInTheDocument();
  });

  it("US2: YAML 미리보기 토큰이 프리필 이름 사용", async () => {
    const user = userEvent.setup();
    stubEnvFetch([STAGING_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    await screen.findByDisplayValue("API_HOST");
    const preview = screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement;
    expect(preview.value).toContain("${API_HOST}");
  });

  it("US3: 사용자 override는 매치 프리필이 덮지 않음", async () => {
    const user = userEvent.setup();
    stubEnvFetch([STAGING_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    // 매치가 실제로 도착·프리필됐음을 먼저 증명 — 없으면 프리필이 통째로 죽어도 green (이빨)
    await screen.findByDisplayValue("API_HOST");
    const apiInput = screen.getByLabelText(ko.import.varNameLabel("api.example.com"));
    await user.clear(apiInput);
    await user.type(apiInput, "MINE");
    expect(screen.getByDisplayValue("MINE")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("API_HOST")).not.toBeInTheDocument();
  });

  it("US4: 환경 fetch 실패 시 기본 프리필·흐름 정상 (fail-soft)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("boom"))),
    );
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    expect(await screen.findByDisplayValue("BASE_URL")).toBeInTheDocument();
    expect(screen.getByDisplayValue("BASE_URL_2")).toBeInTheDocument();
    // 에러 배너 없음 (기존 parseError alert만 role=alert)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("R1: fan-out 상한 K=20 — 21개 환경이면 단건 GET 정확히 20회, 최고(最古) 1개 탈락", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: `E${i}`,
      name: `env${i}`,
      vars: { API_HOST: `https://other${i}.example.com` }, // 키는 STAGING_ENV와 동일(타입 추론 일치 — tsc -b), origin은 매치 무관 host라 힌트 간섭 없음
      created_at: 1,
      updated_at: i, // E0이 가장 오래됨 → 상위 20개에서 탈락
    }));
    const fetchMock = stubEnvFetch(many);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await waitFor(() => {
      const singles = fetchMock.mock.calls.filter(([u]) =>
        /\/api\/environments\/E\d+$/.test(String(u)),
      );
      expect(singles.length).toBe(20);
    });
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/environments/E0"))).toBe(
      false,
    );
  });
});

describe("host-환경 힌트: 안내", () => {
  it("US1-①: 발견성 한 줄 — 체크박스 꺼진 상태에서도, 매치 있을 때만", async () => {
    const user = userEvent.setup();
    stubEnvFetch([STAGING_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    // 체크박스를 켜지 않은 상태에서 표시 (exact getByText — "호스트" 부분매칭 금지, spec R7)
    expect(await screen.findByText(ko.import.hostsRegisteredSummary(1))).toBeInTheDocument();
    // 렌더된 숫자를 별도 단언 (ko 보간 자기참조 함정 — 11호 클래스)
    expect(screen.getByText(ko.import.hostsRegisteredSummary(1)).textContent).toContain("1");
    expect(screen.getByLabelText(ko.import.hostToEnv)).not.toBeChecked();
  });

  it("US1-①: 매치 0건이면 발견성 줄 부재", async () => {
    const user = userEvent.setup();
    renderPage(); // baseline stub = 환경 0개
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    // n-무관 부재 단언 — n=1 고정이면 "호스트 0개…" 렌더 회귀가 false PASS (R7 "호스트" 부분매칭 회피 위해 꼬리 고정)
    expect(screen.queryByText(/이미 환경에 등록돼 있습니다$/)).not.toBeInTheDocument();
  });

  it("US1-②: 행별 안내 — 환경명·var이름 표시, 체크박스 켠 뒤", async () => {
    const user = userEvent.setup();
    stubEnvFetch([STAGING_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const hint = await screen.findByText(ko.import.hostRegisteredIn("스테이징", "API_HOST"));
    // 보간 실존 별도 단언 (자기참조 회피)
    expect(hint.textContent).toContain("스테이징");
    expect(hint.textContent).toContain("API_HOST");
  });

  it("US1-②: 다중 매치 꼬리 '외 N개 환경' (N = 전체-1)", async () => {
    const user = userEvent.setup();
    const OLDER_ENV = {
      id: "E11",
      name: "개발",
      vars: { API_HOST: "https://api.example.com" },
      created_at: 1,
      updated_at: 2, // STAGING_ENV(5)보다 과거 → 안내는 스테이징 기준
    };
    stubEnvFetch([STAGING_ENV, OLDER_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const hint = await screen.findByText((t) =>
      t.includes(ko.import.hostRegisteredIn("스테이징", "API_HOST")),
    );
    expect(hint.textContent).toContain(ko.import.hostRegisteredMore(1));
    expect(hint.textContent).toContain("1");
  });

  it("US3: 안내가 있어도 이름 수정·등록 버튼 동작 불변", async () => {
    const user = userEvent.setup();
    stubEnvFetch([STAGING_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const apiInput = await screen.findByLabelText(ko.import.varNameLabel("api.example.com"));
    await user.clear(apiInput);
    await user.type(apiInput, "OTHER");
    expect(screen.getByRole("button", { name: ko.import.registerEnv })).toBeEnabled();
    // 안내는 등록 사실(불변)을 계속 표시
    expect(
      screen.getByText(ko.import.hostRegisteredIn("스테이징", "API_HOST")),
    ).toBeInTheDocument();
  });
});
