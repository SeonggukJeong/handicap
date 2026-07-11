import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioNewPage } from "../ScenarioNewPage";
import { ko } from "../../i18n/ko";

// 스토어 reset 불필요: import-시드 테스트는 chooseTemplate→loadFromString이 store를
// 새로 덮어쓰고, 회귀 테스트는 갤러리 게이트(로컬 state seedYaml===null)라 store 내용과 무관.
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string | URL) =>
    Promise.resolve(
      new Response(
        JSON.stringify(String(url).endsWith("/api/environments") ? { environments: [] } : {}),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const IMPORTED =
  "version: 1\nname: 가져온 흐름\ncookie_jar: auto\nvariables: {}\nsteps:\n  - id: 01HX00000000000000000000ZZ\n    name: GET /users\n    type: http\n    request:\n      method: GET\n      url: https://api.example.com/users\n      headers: {}\n    assert: []\n    extract: []\n";

function renderWith(state: unknown) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter([{ path: "/scenarios/new", element: <ScenarioNewPage /> }], {
    initialEntries: [{ pathname: "/scenarios/new", state }],
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("ScenarioNewPage import 핸드오프 (R9)", () => {
  it("location.state.importedYaml이 있으면 갤러리를 건너뛰고 그 YAML로 에디터를 시드한다", async () => {
    renderWith({ importedYaml: IMPORTED });
    // 갤러리(템플릿 카드) 대신 에디터가 뜬다 — 시드된 step 이름이 캔버스 노드로.
    // 캔버스(아웃라인) 노드로 스코프 — 테스트 흐름 칩 스트립도 같은 스텝명을 렌더해
    // 텍스트만으로 쿼리하면 다중 매치(FlowOutline row role="option" + 칩)로 충돌한다.
    expect(await screen.findByRole("option", { name: "스텝: GET /users" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.create })).toBeInTheDocument();
    // 갤러리 region은 없다
    expect(
      screen.queryByRole("region", { name: ko.templates.galleryAria }),
    ).not.toBeInTheDocument();
  });

  it("회귀: state가 없으면 기존 템플릿 갤러리를 보여준다", async () => {
    renderWith(undefined);
    expect(
      await screen.findByRole("region", { name: ko.templates.galleryAria }),
    ).toBeInTheDocument();
  });
});
