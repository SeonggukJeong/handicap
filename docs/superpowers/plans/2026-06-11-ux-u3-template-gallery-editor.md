# U3 — 시나리오 템플릿 갤러리 + 에디터 진입 장벽 완화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 새 시나리오 진입 시 템플릿 4종(빈/단순 GET/로그인 흐름/데이터 기반) 선택부터 시작하게 하고, 에디터의 빈 캔버스·스텝 설정 패널·URL 필드·변수 표기를 초보자(HTTP 기본은 아는 QA)가 막히지 않게 재라벨·보강한다.

**Architecture:** 전부 **UI-only** (엔진·컨트롤러·워커·proto·migration 무변경). 신규 모듈 = `ui/src/scenario/templates.ts`(클라 상수) + `ui/src/components/scenario/VarCheatSheet.tsx`(HelpTip 재사용). 선행 모델 변경 1건 = `RequestModel.url`의 `z.string().min(1)` → `z.string()` 완화(spec §5.2 — 엔진 와이어 `url: String`에 더 가까워지는 방향, U4 검증 배너의 전제). 템플릿 선택 화면은 **EditorShell mount 이전 단계**(spec §4 — `initialRef`가 initialYaml을 mount 1회 고정하므로 remount 불요 설계). 신규 문구는 전부 `ko.ts` 카탈로그 경유(ADR-0035).

**Tech Stack:** React + TS + Tailwind + Zustand + Zod + `yaml` Document API + vitest/RTL(jsdom). 신규 라이브러리 없음.

**Spec:** `docs/superpowers/specs/2026-06-11-ux-beginner-friendly-redesign-design.md` §4, §5.1–5.3 (+§3.2의 시나리오 빈 상태 문구 갱신 — U2가 U3로 미룬 책임).

---

## Spec 해석 노트 (reviewer 확인 포인트)

1. **갤러리 배치 = ScenarioNewPage 내 2단계 state** (`seedYaml: string | null`). `null`이면 템플릿 카드 화면, 선택 시 기존 에디터 화면(EditorShell + TestRunSection). 라우트 신설 없음(spec §4 "진입 화면 내 단계"). EditorShell은 선택 *후* 처음 mount되므로 `initialRef` mount-1회 고정과 충돌 없음(spec §4가 명시한 바로 그 설계). 갤러리 화면에는 "취소" 버튼만(미입력 상태라 confirm 없이 `navigate("/")`), 뒤로(갤러리로 복귀) 동선은 비목표(같은 페이지 재진입으로 충분).
   **dirty baseline은 첫-onChange 시딩이 아니라 `chooseTemplate`에서 선험 확정한다** (plan 리뷰 B1, jsdom 재현으로 검증됨): EditorShell의 두 effect는 같은 passive-effect 패스에서 돌아 **첫 onChange가 mount-렌더에 캡처된 *pre-load* store 텍스트**(싱글톤 store의 이전 페이지 잔존물, fresh면 `""`)를 전달한다 — 그걸 baseline으로 박으면 "store 잔존물 ≠ 선택 템플릿"인 갤러리에서 가짜 dirty(취소 시 가짜 confirm)가 난다. 해법: `chooseTemplate`이 EditorShell mount **전에** `useScenarioEditor.getState().loadFromString(yaml)`로 store를 선적재하고 그 시점의 `yamlText`(=canonical)를 `yamlText`/`originalYaml` 둘 다에 시드 → mount 후 첫 onChange는 canonical과 동일해 no-op. `baselineSeededRef` 첫-onChange 스니핑은 제거(불필요해짐).
2. **템플릿 step id는 고정 ULID 하드코딩** (`01HX…` fixture 관용 스타일, I/L/O/U 회피). 시나리오 id 유일성은 *시나리오 내부*에서만 요구되고 템플릿은 시나리오당 1회 seed라 충돌 경로 없음(시나리오 복제 슬라이스도 id 재생성 안 함 — 동일 전례). `newStepId()` 동적 생성은 테스트 결정성을 깨므로 미채택.
3. **`STARTER_YAML` 단일 소스화(부분)**: 빈 템플릿 YAML을 `templates.ts`의 `BLANK_TEMPLATE_YAML`로 옮기고 `ScenarioNewPage`는 `export const STARTER_YAML = BLANK_TEMPLATE_YAML;`로 re-export 유지(외부 import는 `pages/__tests__/ScenarioNewPage.test.ts` 1곳 — re-export로 호환). `store.ts`의 private 사본(`resetEmpty`용)은 **건드리지 않음**(동작 무변경 원칙 — 내용이 동일하다는 단언을 templates 테스트에 추가해 drift만 막는다).
4. **§5.1 "한 줄 부연" = 버튼 행 아래 상시 캡션 1줄**("반복·조건·동시 실행은 HTTP 스텝을 묶는 컨테이너입니다."). 버튼 4개에 각각 보이는 설명을 달면 행이 비대해져서 고급 3종을 한 줄로 묶어 부연. 시각 톤 다운 = HTTP 스텝 버튼만 `font-medium border-slate-400`, 고급 3종은 `text-slate-500`(구조 변경 없음).
5. **§5.2 "오른쪽 패널에서 설정하세요 힌트 1회"** = CanvasView 로컬 state. 이 mount에서 *첫* 스텝 추가 직후 표시, 두 번째 추가 또는 pane 클릭 시 숨김(ref 가드로 재표시 없음). localStorage 비사용(U2 온보딩과 달리 세션 영속 가치 낮음 — 페이지 단위 1회면 충분).
6. **§5.2 패널 제목 재라벨 범위**: `aria-label="Inspector"` 5곳 → `ko.editor.inspectorAria`("스텝 설정") + 빈 선택 문구 한국어화. 4개 변형 패널의 visible `h3`는 §5.1의 노드 한국어명과 일치시킴: "Step"→"HTTP 스텝", "Loop"→"반복(loop)", "If"→"조건(if)", "Parallel"→"동시 실행(parallel)". `Assertions` legend→"응답 검증", `Extracts` legend+aria-label→"값 추출" + 부연 1줄. EditorShell YAML 탭 placeholder("Switch to the Canvas tab…")도 패널을 직접 지칭하므로 동반 한국어화. **나머지 Inspector 필드 라벨(Name/Method/Headers/Body/Timeout/Think/Then/Else/Branches 등)·MoveButtons·Delete는 spec §5.2 밖 — 명시 연기**(아래 "연기" 절).
7. **스코프 추가 1건(같은 파일·같은 화면)**: 갤러리가 ScenarioNewPage를 재구성하므로 그 화면의 Create/Creating…/Cancel 버튼과 `window.confirm` 인라인 문구를 카탈로그 경유 한국어화("만들기"/"생성 중…"/"취소"). ScenarioEditPage chrome은 비범위(연기). reviewer가 부적절하다고 보면 이 항목만 드랍 가능(Task 3에 격리).
8. **§5.3 치트시트 = `VarCheatSheet`**(HelpTip 래퍼, `ko.glossary` 신규 3키 `varFlow`/`varEnv`/`varSys` 단일 소스). 부착 2곳: VariablesPanel 제목 옆(h3 *형제* — heading name 오염 방지) + Inspector `Request` fieldset 첫 행(legend 밖 — group name 오염 방지). popover 본문은 `<span className="block">` 3줄(HelpTip popover가 `<span>`이라 블록 *요소* 금지 — display:block 클래스는 허용). 갤러리는 Modal이 아니므로 HelpTip Modal-ESC 레이어링 함정 비해당. VariablesPanel은 치트시트를 붙이면서 제목/빈 목록/Add 문구도 카탈로그 한국어화(같은 표면 동반 정리 — 3문자열; **spec §5.3 밖 스코프 추가, 노트 7과 동급 droppable** — 드랍 시 치트시트 부착만 남김).
9. **`url` 완화 락인**: `.min(1)`에 의존하는 기존 테스트/픽스처 0건(정찰 grep 검증 — `url: ""` 픽스처 없음, proptests URL arbitrary는 항상 `/` 시작). 완화 후 신규 락인 = ① 빈 url 시나리오가 `parseScenarioDoc` 통과 ② Inspector 인라인 경고 ③ 캔버스 ⚠ 배지 ④ URL 비우기가 stale-model 비대칭(현행: doc만 mutate되고 reparse 실패→yamlError+stale)을 해소함을 단언. 저장은 막지 않음(작성 중 상태 허용 — Create/PATCH 게이트 무변경).
10. **`ko.empty.scenarios` 갱신**(U2 deferral): "시나리오는 부하를 줄 API 요청 흐름입니다. 템플릿에서 시작해 보세요." — 기존 ko.test.ts `toContain("API 요청")` 단언과 양립(문구에 "API 요청" 유지). CTA(`scenariosCta` "새 시나리오 만들기")는 무변경 — 행선지 `/scenarios/new`가 이제 갤러리를 보여주므로 의미 정합.
11. **payload/와이어 무변경 불변식**: `POST /api/scenarios`는 기존과 동일하게 `mutation.mutate(yamlText)` 한 경로(템플릿은 yamlText *시드*일 뿐). run/스케줄/test-run 경로 무접촉(TestRunSection 파일 무변경 — U4 경계). Zod 변경은 `RequestModel.url` 완화 단 1건이고 이는 *허용 확대*라 기존 유효 시나리오의 파싱 결과 불변.
12. **기존 테스트 두 부류 분리**(U1b §6.6 컨벤션 준용): [A] 동작/payload 단언(무수정 통과 필수 — store 편집 계약, testrun POST body, Zod round-trip) / [B] 라벨·문구 단언(카탈로그 기준 갱신 허용). 갱신 대상 [B] 전수: `CanvasView.test.tsx`(버튼 정규식 4건 + 빈 캔버스 힌트 2건), `Inspector.test.tsx`(`/Select a step/i` 1건, `group {name:/Extracts?/i}` 5건, heading "Loop"/"If" 3건), `ScenarioNewPage.testrun.test.tsx`(3 케이스 — 갤러리 선행 클릭 추가 + Create/Cancel 라벨), `ko.test.ts`(신규 키 단언 추가).

---

## 사전 준비 (orchestrator — task 아님)

- 워크트리: `.claude/worktrees/u3-template-editor` (`.claude/settings.local.json`의 `worktree.baseRef: head` 확인. `EnterWorktree` 거부 시 수동 `git worktree add` fallback — U1b 전례).
- `cd ui && pnpm install` (새 워크트리엔 node_modules 없음).
- `cargo build -p handicap-worker && cargo build --workspace` (pre-commit cold-build flake 예방 warm — UI-only 커밋도 full cargo 게이트를 탄다).
- implementer 프롬프트 공통: 첫 줄에 `cd /Users/sgj/develop/handicap/.claude/worktrees/u3-template-editor` 명시. **commit은 `run_in_background:false` + timeout 600000ms 단일 호출, 파이프(`| tail`) 금지, 커밋 후 `git log -1` 확인.** `git add`는 명시 경로만(`-A` 금지). 이벤트 핸들러는 hoisted `function` 금지(const 화살표 — `tsc -b` narrowing 함정).
- tdd-guard: 각 task의 Step 1이 test-path 파일을 먼저 만들거나 편집하므로 keepalive 불필요(self-unblock).
- task별 2단계 리뷰(spec compliance → code quality), 리뷰 fix는 fresh fix-subagent.

---

### Task 1: ko.ts U3 카탈로그 + `templates.ts` 템플릿 4종

**Files:**
- Modify: `ui/src/i18n/ko.ts` (신규 네임스페이스 `editor`·`templates`, `glossary` 3키 추가, `empty.scenarios` 갱신)
- Modify: `ui/src/i18n/__tests__/ko.test.ts`
- Create: `ui/src/scenario/templates.ts`
- Create: `ui/src/scenario/__tests__/templates.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성 — `ui/src/scenario/__tests__/templates.test.ts`** (신규 src보다 테스트 먼저 = tdd-guard 자연 통과)

```ts
import { describe, expect, it } from "vitest";
import { BLANK_TEMPLATE_YAML, SCENARIO_TEMPLATES } from "../templates";
import { parseScenarioDoc, serializeDoc } from "../yamlDoc";
import { useScenarioEditor } from "../store";
import { ko } from "../../i18n/ko";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("SCENARIO_TEMPLATES", () => {
  it("4종(blank/simple-get/login-flow/data-driven)이 이 순서로 있다", () => {
    expect(SCENARIO_TEMPLATES.map((t) => t.id)).toEqual([
      "blank",
      "simple-get",
      "login-flow",
      "data-driven",
    ]);
  });

  it("4종 전부 parseScenarioDoc(Zod 게이트)을 통과한다", () => {
    for (const t of SCENARIO_TEMPLATES) {
      const parsed = parseScenarioDoc(t.yaml);
      expect("model" in parsed, `${t.id}: ${"error" in parsed ? parsed.error : ""}`).toBe(true);
    }
  });

  it("모든 step id가 유효 ULID(I/L/O/U 제외 26자)이고 시나리오 안에서 유일하다", () => {
    for (const t of SCENARIO_TEMPLATES) {
      const ids = [...t.yaml.matchAll(/^\s*-?\s*id:\s*(\S+)$/gm)].map((m) => m[1]);
      for (const id of ids) expect(id, `${t.id}/${id}`).toMatch(ULID_RE);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("한국어 주석이 Document round-trip(serializeDoc) 후에도 보존된다", () => {
    const login = SCENARIO_TEMPLATES.find((t) => t.id === "login-flow")!;
    const parsed = parseScenarioDoc(login.yaml);
    if (!("doc" in parsed)) throw new Error("parse failed");
    const out = serializeDoc(parsed.doc);
    expect(out).toContain("값 추출");
    expect(out).toContain("환경");
  });

  it("blank 템플릿은 store.resetEmpty의 STARTER와 canonical 동일(드리프트 가드)", () => {
    // store.ts의 private STARTER_YAML 사본과의 조용한 drift를 canonical 비교로 차단.
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
    const fromStore = useScenarioEditor.getState().yamlText;
    const parsed = parseScenarioDoc(BLANK_TEMPLATE_YAML);
    if (!("doc" in parsed)) throw new Error("blank template parse failed");
    expect(serializeDoc(parsed.doc)).toBe(fromStore);
  });

  it("name/description은 ko.templates 카탈로그를 쓴다", () => {
    const byId = Object.fromEntries(SCENARIO_TEMPLATES.map((t) => [t.id, t]));
    expect(byId["simple-get"].name).toBe(ko.templates.getName);
    expect(byId["login-flow"].description).toBe(ko.templates.loginDesc);
  });

  it("로그인 흐름은 extract→{{token}} 사용을 시연한다", () => {
    const login = SCENARIO_TEMPLATES.find((t) => t.id === "login-flow")!;
    expect(login.yaml).toContain("var: token");
    expect(login.yaml).toContain("Bearer {{token}}");
    expect(login.yaml).toContain("${BASE_URL}");
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test templates`
Expected: FAIL — `Cannot find module '../templates'` (+ ko.templates 미존재 시 타입 에러는 esbuild 단계에선 안 잡힘 — 정상)

- [ ] **Step 3: `ui/src/i18n/ko.ts`에 카탈로그 추가**

`glossary`에 3키 추가(기존 `run:` 줄 뒤):

```ts
    varFlow: "{{변수}} — 흐름 변수. 시나리오 변수·값 추출·데이터셋 바인딩이 채웁니다.",
    varEnv: "${ENV} — 환경 변수. 실행 시 선택한 환경에서 주입됩니다.",
    varSys: "${vu_id} 등 — 시스템 변수. 엔진이 자동으로 채웁니다(가상 사용자 번호 등).",
```

`empty.scenarios` 값 교체(키·CTA 무변경):

```ts
    scenarios: "시나리오는 부하를 줄 API 요청 흐름입니다. 템플릿에서 시작해 보세요.",
```

`pages` 뒤에 신규 네임스페이스 2개 추가(`as const` 객체 끝, `pages` 다음):

```ts
  editor: {
    // ── 스텝 설정 패널(구 Inspector) ──
    inspectorAria: "스텝 설정",
    inspectorEmpty: "캔버스에서 스텝을 선택하면 여기서 설정합니다.",
    yamlTabNoInspector: "스텝 설정은 캔버스 탭에서 사용할 수 있습니다.",
    httpPanelTitle: "HTTP 스텝",
    loopPanelTitle: "반복(loop)",
    ifPanelTitle: "조건(if)",
    parallelPanelTitle: "동시 실행(parallel)",
    assertionsLegend: "응답 검증",
    extractsLegend: "값 추출",
    extractsHint: "응답에서 값을 꺼내 다음 스텝에서 {{이름}}으로 사용합니다.",
    // ── URL 필수 표시 (§5.2) ──
    urlLabel: "URL *",
    urlPlaceholder: "https://api.example.com/login 또는 ${BASE_URL}/login",
    urlEmptyWarning: "URL을 입력하세요 — 비어 있으면 요청이 실패합니다.",
    urlMissingBadge: "URL이 비어 있습니다",
    // ── 캔버스 (§5.1) ──
    canvasEmpty: "HTTP 스텝을 추가해 시작하세요. 스텝은 부하 중 반복 실행될 HTTP 요청 1개입니다.",
    addHttpStep: "+ HTTP 스텝",
    addHttpStepInLoop: "+ 반복 안에 HTTP 스텝",
    addLoop: "+ 반복(loop)",
    addIf: "+ 조건(if)",
    addParallel: "+ 동시 실행(parallel)",
    containerCaption: "반복·조건·동시 실행은 HTTP 스텝을 묶는 컨테이너입니다.",
    panelHint: "오른쪽 '스텝 설정' 패널에서 URL을 입력하세요.",
    // ── 변수 표기 치트시트 (§5.3) ──
    varCheatSheetLabel: "변수 표기 도움말",
    varCheatSheetContext: "변수 표기",
    // ── Variables 패널 (치트시트 부착 표면 동반 정리) ──
    variablesTitle: "변수",
    variablesEmpty: "변수 없음",
    variablesAdd: "추가",
    // ── 새 시나리오 페이지 chrome (해석 노트 7) ──
    create: "만들기",
    creating: "생성 중…",
    cancel: "취소",
    discardConfirm: "저장하지 않은 변경을 버릴까요?",
  },
  templates: {
    galleryAria: "시나리오 템플릿 선택",
    galleryTitle: "어떤 시나리오로 시작할까요?",
    galleryHint: "선택 후 캔버스·YAML에서 자유롭게 고칠 수 있습니다.",
    blankName: "빈 시나리오",
    blankDesc: "아무것도 없는 상태에서 직접 만듭니다.",
    getName: "단순 GET",
    getDesc: "URL 하나에 GET을 보내는 1스텝 헬스체크 — 가장 단순한 부하 테스트.",
    loginName: "로그인 흐름",
    loginDesc: "로그인(POST) → 토큰 값 추출 → 인증 GET. 값 추출과 {{변수}} 사용법 예시.",
    dataName: "데이터 기반",
    dataDesc: "CSV 데이터셋의 행을 {{변수}}로 주입하는 폼 전송 — 실행 시 데이터 바인딩과 함께 씁니다.",
  },
```

- [ ] **Step 4: `ui/src/scenario/templates.ts` 작성**

**주의: backtick 문자열 안의 `${BASE_URL}`은 반드시 `\${BASE_URL}`로 이스케이프**(TS 보간 방지). `{{var}}`는 이스케이프 불요. step id는 고정 ULID(아래 값 그대로 — `I/L/O/U` 없는 26자 검증 완료).

```ts
import { ko } from "../i18n/ko";

/**
 * 시나리오 템플릿 갤러리 (spec 2026-06-11 UX §4, U3).
 * - 클라 상수(UI-only). 각 YAML은 version 1 + 유효 ULID id + step name 필수 규칙을
 *   만족하는 완전한 시나리오 — templates.test.ts가 Zod 게이트 통과를 락인한다.
 * - 한국어 주석은 Document API round-trip으로 보존돼 YAML 탭에서 "고치며 배우는"
 *   자료가 된다(스텝 노드 통째 교체 시 그 스텝 내부 주석은 소실 — 알려진 한도).
 * - step id는 고정 ULID(fixture 관용 01HX… 스타일): 템플릿은 시나리오당 1회
 *   seed라 시나리오-내 유일성만 필요하다.
 */
export interface ScenarioTemplate {
  id: "blank" | "simple-get" | "login-flow" | "data-driven";
  name: string;
  description: string;
  yaml: string;
}

export const BLANK_TEMPLATE_YAML = `version: 1
name: "Untitled"
cookie_jar: auto
variables: {}
steps: []
`;

const SIMPLE_GET_YAML = `version: 1
name: "단순 GET"
cookie_jar: auto
variables: {}
steps:
  # 가장 단순한 부하: URL 하나에 GET을 반복합니다.
  - id: 01HX0000000000000000000310
    name: "헬스체크"
    type: http
    request:
      method: GET
      # 여기에 테스트할 URL을 넣으세요. 환경을 쓰면 "\${BASE_URL}/health"처럼 적을 수 있습니다.
      url: https://api.example.com/health
    # 응답 검증: 상태코드가 200이 아니면 에러로 집계됩니다.
    assert:
      - status: 200
`;

const LOGIN_FLOW_YAML = `version: 1
name: "로그인 흐름"
cookie_jar: auto
variables: {}
steps:
  # 1단계: 로그인 — 자격증명을 보내고 응답 본문에서 토큰을 꺼냅니다.
  - id: 01HX0000000000000000000320
    name: "로그인"
    type: http
    request:
      method: POST
      # \${BASE_URL}은 실행 시 선택한 환경(예: dev/stage)에서 주입됩니다.
      url: "\${BASE_URL}/login"
      body:
        json:
          username: "tester"
          password: "secret"
    assert:
      - status: 200
    # 값 추출: 응답 JSON의 $.token을 {{token}}으로 저장해 다음 스텝에서 씁니다.
    extract:
      - var: token
        from: body
        path: $.token
  # 2단계: 인증 API 호출 — 헤더에 {{token}}을 넣습니다.
  - id: 01HX0000000000000000000321
    name: "내 정보 조회"
    type: http
    request:
      method: GET
      url: "\${BASE_URL}/me"
      headers:
        Authorization: "Bearer {{token}}"
    assert:
      - status: 200
`;

const DATA_DRIVEN_YAML = `version: 1
name: "데이터 기반"
cookie_jar: auto
variables: {}
steps:
  # {{user}}/{{password}}는 CSV 데이터셋의 열과 연결됩니다.
  # 실행 설정의 '데이터 바인딩'에서 데이터셋을 선택하고 열을 매핑하세요.
  - id: 01HX0000000000000000000330
    name: "로그인(CSV 변수)"
    type: http
    request:
      method: POST
      url: "\${BASE_URL}/login"
      body:
        form:
          username: "{{user}}"
          password: "{{password}}"
    assert:
      - status: 200
`;

export const SCENARIO_TEMPLATES: ReadonlyArray<ScenarioTemplate> = [
  { id: "blank", name: ko.templates.blankName, description: ko.templates.blankDesc, yaml: BLANK_TEMPLATE_YAML },
  { id: "simple-get", name: ko.templates.getName, description: ko.templates.getDesc, yaml: SIMPLE_GET_YAML },
  { id: "login-flow", name: ko.templates.loginName, description: ko.templates.loginDesc, yaml: LOGIN_FLOW_YAML },
  { id: "data-driven", name: ko.templates.dataName, description: ko.templates.dataDesc, yaml: DATA_DRIVEN_YAML },
];
```

- [ ] **Step 5: `ko.test.ts`에 신규 키 단언 추가** (기존 단언 무수정 — `empty.scenarios`의 `toContain("API 요청")`은 새 문구와 양립)

기존 "empty 5종" it 안에 한 줄 추가:

```ts
    expect(ko.empty.scenarios).toContain("템플릿");
```

새 it 2개 추가:

```ts
  it("U3 editor/templates 네임스페이스 키가 비어 있지 않다", () => {
    const editorKeys = [
      "inspectorAria",
      "inspectorEmpty",
      "yamlTabNoInspector",
      "httpPanelTitle",
      "loopPanelTitle",
      "ifPanelTitle",
      "parallelPanelTitle",
      "assertionsLegend",
      "extractsLegend",
      "extractsHint",
      "urlLabel",
      "urlPlaceholder",
      "urlEmptyWarning",
      "urlMissingBadge",
      "canvasEmpty",
      "addHttpStep",
      "addHttpStepInLoop",
      "addLoop",
      "addIf",
      "addParallel",
      "containerCaption",
      "panelHint",
      "varCheatSheetLabel",
      "varCheatSheetContext",
      "variablesTitle",
      "variablesEmpty",
      "variablesAdd",
      "create",
      "creating",
      "cancel",
      "discardConfirm",
    ] as const;
    for (const k of editorKeys) {
      expect(ko.editor[k], `editor.${k}`).toBeTypeOf("string");
      expect(ko.editor[k].length, `editor.${k}`).toBeGreaterThan(0);
    }
    const tplKeys = [
      "galleryAria",
      "galleryTitle",
      "galleryHint",
      "blankName",
      "blankDesc",
      "getName",
      "getDesc",
      "loginName",
      "loginDesc",
      "dataName",
      "dataDesc",
    ] as const;
    for (const k of tplKeys) {
      expect(ko.templates[k], `templates.${k}`).toBeTypeOf("string");
      expect(ko.templates[k].length, `templates.${k}`).toBeGreaterThan(0);
    }
  });

  it("glossary 변수 표기 3분류(ADR-0014)가 표기 원문을 담는다", () => {
    expect(ko.glossary.varFlow).toContain("{{");
    expect(ko.glossary.varEnv).toContain("${ENV}");
    expect(ko.glossary.varSys).toContain("${vu_id}");
  });
```

- [ ] **Step 6: GREEN 확인**

Run: `cd ui && pnpm test templates && pnpm test ko`
Expected: templates 7 pass + ko 전체 pass

- [ ] **Step 7: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/i18n/ko.ts ui/src/i18n/__tests__/ko.test.ts ui/src/scenario/templates.ts ui/src/scenario/__tests__/templates.test.ts
git commit -m "feat(ui): U3 ko 카탈로그(editor/templates/glossary 변수표기) + 시나리오 템플릿 4종 상수"
git log -1
```

---

### Task 2: `RequestModel.url` 완화 + URL 필수 표시·인라인 경고 + 캔버스 ⚠ 배지

**Files:**
- Modify: `ui/src/scenario/model.ts:26` (url `.min(1)` 제거)
- Modify: `ui/src/components/scenario/Inspector.tsx:255-261` (URL Field)
- Modify: `ui/src/components/scenario/CanvasView.tsx:243-256` (emitStep http arm)
- Modify: `ui/src/components/scenario/HttpStepNode.tsx`
- Test: `ui/src/scenario/__tests__/model.test.ts`, `ui/src/components/scenario/__tests__/Inspector.test.tsx`, `ui/src/components/scenario/__tests__/CanvasView.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성 ① — `model.test.ts`에 완화 락인 추가**

```ts
  it("U3: accepts an empty request url (wire parity — engine url is a plain String)", () => {
    const step = {
      id: "01HX0000000000000000000010",
      name: "draft",
      type: "http",
      request: { method: "GET", url: "", headers: {} },
      assert: [],
      extract: [],
    };
    const parsed = StepModel.safeParse(step);
    expect(parsed.success).toBe(true);
  });
```

(파일 상단 import에 `StepModel`이 없으면 추가.)

- [ ] **Step 2: 실패하는 테스트 작성 ② — `Inspector.test.tsx`에 빈 URL 경고 + stale 해소 단언 추가**

파일의 기존 store reset 이디엄(`useScenarioEditor.setState(useScenarioEditor.getInitialState())` — 헬퍼 함수 없음, 직접 호출)을 따라 describe 추가:

```tsx
describe("Inspector URL required marker (U3)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
  });

  it("clearing the URL commits an empty url to the model and shows the inline warning", async () => {
    const user = userEvent.setup();
    const id = useScenarioEditor.getState().addStep("S1");
    useScenarioEditor.getState().select(id);
    render(<Inspector />);
    const url = screen.getByLabelText(/URL/);
    await user.clear(url);
    // 완화 전에는 reparse가 실패해 model이 stale로 남았다(yamlError만 세팅).
    const state = useScenarioEditor.getState();
    expect(state.yamlError).toBeNull();
    expect(state.yamlText).toContain('url: ""');
    expect(screen.getByRole("alert")).toHaveTextContent("URL을 입력하세요");
    expect(url).toHaveAttribute("placeholder", expect.stringContaining("api.example.com"));
  });

  it("non-empty URL shows no warning", () => {
    const id = useScenarioEditor.getState().addStep("S1");
    useScenarioEditor.getState().select(id);
    render(<Inspector />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
```

(주의: `getByLabelText(/URL/)`는 라벨이 "URL *"로 바뀌어도 부분 매치로 통과 — 정확 매치 금지.)

- [ ] **Step 3: 실패하는 테스트 작성 ③ — `CanvasView.test.tsx`에 ⚠ 배지 단언 추가**

```tsx
describe("CanvasView empty-url badge (U3)", () => {
  beforeEach(() => {
    reset();
  });

  it("renders a ⚠ badge on http nodes whose url is empty, and none otherwise", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    name: "no-url"
    type: http
    request:
      method: GET
      url: ""
    assert:
      - status: 200
  - id: "01HX0000000000000000000011"
    name: "has-url"
    type: http
    request:
      method: GET
      url: "/ok"
    assert:
      - status: 200
`);
    render(<CanvasView />);
    const badges = screen.getAllByTitle("URL이 비어 있습니다");
    expect(badges).toHaveLength(1);
    // 배지는 name span과 같은 flex 행 — name의 parentElement가 곧 그 행
    expect(screen.getByText("no-url").parentElement).toContainElement(badges[0]);
  });
});
```

- [ ] **Step 4: RED 확인**

Run: `cd ui && pnpm test model && pnpm test Inspector && pnpm test CanvasView`
Expected: 신규 케이스만 FAIL (빈 url Zod 거부 / 경고·배지 미렌더)

- [ ] **Step 5: `model.ts` 완화**

```ts
    url: z.string(),
```

(line 26의 `z.string().min(1)` → `z.string()`. 다른 필드의 `.min(1)`은 그대로 — url만.)

- [ ] **Step 6: Inspector URL Field 교체**

기존(255-261):

```tsx
        <Field label="URL">
          <input
            className="w-full border border-slate-300 rounded px-2 py-1 font-mono text-xs"
            value={step.request.url}
            onChange={(e) => setStepField(step.id, ["request", "url"], e.target.value)}
          />
        </Field>
```

교체:

```tsx
        <Field label={ko.editor.urlLabel}>
          <input
            className="w-full border border-slate-300 rounded px-2 py-1 font-mono text-xs"
            value={step.request.url}
            placeholder={ko.editor.urlPlaceholder}
            onChange={(e) => setStepField(step.id, ["request", "url"], e.target.value)}
          />
        </Field>
        {step.request.url.trim() === "" && (
          <p role="alert" className="text-xs text-amber-600">
            {ko.editor.urlEmptyWarning}
          </p>
        )}
```

파일 상단에 `import { ko } from "../../i18n/ko";` 추가.

- [ ] **Step 7: CanvasView emitStep http arm에 판정 주입**

```tsx
      data: {
        name: step.name,
        method: step.request.method,
        url: step.request.url,
        urlMissing: step.request.url.trim() === "",
        selected: step.id === selectedStepId,
      },
```

- [ ] **Step 8: HttpStepNode 배지 렌더**

```tsx
export interface HttpStepNodeData extends Record<string, unknown> {
  name: string;
  method: string;
  url: string;
  urlMissing: boolean;
  selected: boolean;
}
```

name 행 교체(기존 `<div className="font-medium text-slate-900 truncate" title={name}>{name}</div>`):

```tsx
      <div className="flex items-center gap-1">
        <span className="min-w-0 font-medium text-slate-900 truncate" title={name}>
          {name}
        </span>
        {urlMissing && (
          <span className="shrink-0 text-amber-600" title={ko.editor.urlMissingBadge}>
            ⚠
          </span>
        )}
      </div>
```

구조분해에 `urlMissing` 추가 + `import { ko } from "../../i18n/ko";`. (배지는 보이는 텍스트+title — LoopStepNode repeat 배지 이디엄. aria-label 중복 금지 컨벤션 준수. `min-w-0`은 flex truncate 필수 — ui/CLAUDE.md 함정.)

- [ ] **Step 9: GREEN 확인 + 전체 영향 확인**

Run: `cd ui && pnpm test model && pnpm test Inspector && pnpm test CanvasView && pnpm test`
Expected: 전부 PASS (url 완화는 허용 확대라 기존 fixture 무영향 — 정찰 검증 완료)

- [ ] **Step 10: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/scenario/model.ts ui/src/scenario/__tests__/model.test.ts ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/CanvasView.tsx ui/src/components/scenario/HttpStepNode.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx ui/src/components/scenario/__tests__/CanvasView.test.tsx
git commit -m "feat(ui): U3 url 모델 완화(min(1) 제거) + URL 필수표시·placeholder·인라인 경고 + 캔버스 ⚠ 배지"
git log -1
```

---

### Task 3: ScenarioNewPage 템플릿 갤러리 (EditorShell mount 이전 단계) + 페이지 chrome 한국어화

**Files:**
- Modify: `ui/src/pages/ScenarioNewPage.tsx` (전면 재구성)
- Create: `ui/src/pages/__tests__/ScenarioNewPage.gallery.test.tsx`
- Modify: `ui/src/pages/__tests__/ScenarioNewPage.testrun.test.tsx` (갤러리 선행 클릭 + 라벨 갱신)
- Modify: `ui/src/pages/__tests__/ScenarioNewPage.test.ts` (STARTER_YAML re-export 경유 — 단언 무수정 확인)

- [ ] **Step 1: 실패하는 테스트 작성 — `ScenarioNewPage.gallery.test.tsx`**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioNewPage } from "../ScenarioNewPage";
import { ko } from "../../i18n/ko";

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

// ScenarioSchema는 created_at/updated_at까지 required — 누락 시 Zod가 응답을 거부한다.
const CREATED = {
  id: "01HX00000000000000000000ZZ",
  name: "n",
  yaml: "version: 1\nname: n\nsteps: []\n",
  version: 1,
  created_at: 0,
  updated_at: 0,
};

function routeFetch(url: string, init?: RequestInit): Response {
  if (url.endsWith("/api/environments")) return jsonResponse({ environments: [] });
  if (url.endsWith("/api/scenarios") && init?.method === "POST")
    return jsonResponse(CREATED, 201);
  return jsonResponse({ error: "unexpected" }, 500);
}

function renderPage() {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    Promise.resolve(routeFetch(String(url), init)),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scenarios/new"]}>
        <Routes>
          <Route path="/scenarios/new" element={<ScenarioNewPage />} />
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/scenarios/:id" element={<div>SAVED</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioNewPage 템플릿 갤러리 (U3)", () => {
  it("진입 시 에디터 대신 템플릿 4종 카드를 보여준다", async () => {
    renderPage();
    const gallery = await screen.findByRole("region", { name: ko.templates.galleryAria });
    expect(gallery).toHaveTextContent(ko.templates.blankName);
    expect(gallery).toHaveTextContent(ko.templates.getName);
    expect(gallery).toHaveTextContent(ko.templates.loginName);
    expect(gallery).toHaveTextContent(ko.templates.dataName);
    // 에디터(만들기 버튼)는 아직 없다
    expect(screen.queryByRole("button", { name: ko.editor.create })).not.toBeInTheDocument();
  });

  it("템플릿 선택 시 그 YAML이 시드된 에디터로 진입한다 (단순 GET → 헬스체크 노드)", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: new RegExp(ko.templates.getName) }));
    expect(await screen.findByText("헬스체크")).toBeInTheDocument(); // 캔버스 노드
    expect(screen.getByRole("button", { name: ko.editor.create })).toBeInTheDocument();
  });

  it("만들기를 누르면 선택한 템플릿 YAML로 POST /api/scenarios 후 상세로 이동한다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: new RegExp(ko.templates.loginName) }),
    );
    await user.click(await screen.findByRole("button", { name: ko.editor.create }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/scenarios") && (i as RequestInit)?.method === "POST",
      );
      expect(call).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/scenarios") && (i as RequestInit)?.method === "POST",
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.yaml).toContain("로그인 흐름");
    expect(body.yaml).toContain("Bearer {{token}}");
    expect(await screen.findByText("SAVED")).toBeInTheDocument();
  });

  it("미수정 템플릿에서 취소해도 confirm이 뜨지 않는다 (baseline 선험 확정)", async () => {
    // chooseTemplate이 store 선적재로 canonical baseline을 확정하므로, 직전 it가
    // store에 다른 시나리오를 남겼어도(싱글톤 잔존물) 가짜 dirty가 나면 안 된다.
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: new RegExp(ko.templates.dataName) }),
    );
    await screen.findByRole("button", { name: ko.editor.create }); // 에디터 mount 대기
    await user.click(screen.getByRole("button", { name: ko.editor.cancel }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await screen.findByText("HOME")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("갤러리 화면의 취소는 confirm 없이 목록으로 돌아간다", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await user.click(await screen.findByRole("button", { name: ko.editor.cancel }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await screen.findByText("HOME")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});
```

(주의: 같은 store 싱글톤이라 it 간 누수가 보이면 기존 페이지 테스트처럼 각 it가 fresh mount로 self-contained — EditorShell mount가 loadFromString으로 매번 덮어쓰므로 reset 불요. RegExp 보간은 템플릿 이름에 정규식 특수문자가 없어 안전.)

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test ScenarioNewPage.gallery`
Expected: FAIL — 갤러리 region 부재

- [ ] **Step 3: `ScenarioNewPage.tsx` 재구성**

```tsx
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateScenario } from "../api/hooks";
import { Breadcrumb } from "../components/Breadcrumb";
import { Button } from "../components/Button";
import { EditorShell } from "../components/scenario/EditorShell";
import { TestRunSection } from "../components/scenario/TestRunSection";
import { ko } from "../i18n/ko";
import { useScenarioEditor } from "../scenario/store";
import { BLANK_TEMPLATE_YAML, SCENARIO_TEMPLATES } from "../scenario/templates";

// 빈 템플릿이 곧 기존 STARTER — 단일 소스는 templates.ts (기존 import 호환 re-export).
export const STARTER_YAML = BLANK_TEMPLATE_YAML;

export function ScenarioNewPage() {
  const navigate = useNavigate();
  const mutation = useCreateScenario();
  // null = 템플릿 선택 단계(EditorShell mount 이전 — initialYaml은 mount 1회 고정이라
  // 선택을 mount 앞에 둔다, spec §4). 선택 후엔 그 YAML이 에디터 시드.
  const [seedYaml, setSeedYaml] = useState<string | null>(null);
  const [yamlText, setYamlText] = useState("");
  const [originalYaml, setOriginalYaml] = useState("");

  const handleEditorChange = useCallback((next: string) => {
    setYamlText(next);
  }, []);

  const dirty = yamlText !== originalYaml;

  // dirty baseline은 여기서 선험 확정한다. EditorShell의 첫 onChange는 mount-렌더에
  // 캡처된 *pre-load* store 텍스트(싱글톤 잔존물)라 baseline 시딩에 쓸 수 없다 —
  // 대신 mount 전에 store를 선적재해 "첫 onChange == canonical 템플릿"을 만들고,
  // 그 canonical을 yamlText/originalYaml 양쪽에 시드한다(미수정 = dirty false).
  const chooseTemplate = (yaml: string) => {
    useScenarioEditor.getState().loadFromString(yaml);
    const canonical = useScenarioEditor.getState().yamlText;
    setSeedYaml(yaml);
    setYamlText(canonical);
    setOriginalYaml(canonical);
  };

  const cancel = () => {
    if (!dirty || window.confirm(ko.editor.discardConfirm)) navigate("/");
  };

  if (seedYaml === null) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb
          items={[{ label: ko.nav.scenarios, to: "/" }, { label: ko.pages.newScenario }]}
        />
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">{ko.pages.newScenario}</h2>
          <Button variant="secondary" onClick={() => navigate("/")}>
            {ko.editor.cancel}
          </Button>
        </div>
        <section aria-label={ko.templates.galleryAria} className="flex flex-col gap-2">
          <p className="text-sm font-medium text-slate-700">{ko.templates.galleryTitle}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-3xl">
            {SCENARIO_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => chooseTemplate(t.yaml)}
                className="rounded-md border border-slate-300 bg-white p-4 text-left hover:border-slate-500 hover:bg-slate-50"
              >
                <span className="block font-medium text-slate-900">{t.name}</span>
                <span className="mt-1 block text-xs text-slate-500">{t.description}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-400">{ko.templates.galleryHint}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb
        items={[{ label: ko.nav.scenarios, to: "/" }, { label: ko.pages.newScenario }]}
      />
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{ko.pages.newScenario}</h2>
        <div className="flex gap-2">
          <Button
            onClick={() =>
              mutation.mutate(yamlText, {
                onSuccess: (created) => navigate(`/scenarios/${created.id}`),
              })
            }
            disabled={mutation.isPending || yamlText.trim().length === 0}
          >
            {mutation.isPending ? ko.editor.creating : ko.editor.create}
          </Button>
          <Button variant="secondary" onClick={cancel}>
            {ko.editor.cancel}
          </Button>
        </div>
      </div>

      {mutation.error && <p className="text-red-600">{(mutation.error as Error).message}</p>}

      <EditorShell initialYaml={seedYaml} onChange={handleEditorChange} />

      <TestRunSection yamlText={yamlText} />
    </div>
  );
}
```

(`TestRunSection`은 한 줄 마운트 그대로 — U4 경계, 파일 무접촉. `chooseTemplate`이 store 선적재로 canonical baseline을 선험 확정하므로 기존 `baselineSeededRef` 첫-onChange 스니핑은 **제거**된다 — 해석 노트 1의 B1 근거 참조. `useRef` import도 함께 제거(lint no-unused).)

- [ ] **Step 4: `ScenarioNewPage.testrun.test.tsx` 갱신** — 각 it 시작에 갤러리 통과 추가 + 라벨 한국어 갱신

`renderPage()` 직후 공통으로:

```tsx
  // U3: 갤러리 단계를 지나야 에디터가 mount된다 — 빈 시나리오 선택
  await user.click(await screen.findByRole("button", { name: /빈 시나리오/ }));
```

(둘째 it `groups Create and Cancel…`은 `const user = userEvent.setup();`가 없으므로 추가.) 라벨 단언 교체: `/Create/`→`ko.editor.create`, `/Cancel/`→`ko.editor.cancel`(갤러리 화면에도 "취소"가 있으므로 **에디터 진입 후** 조회해야 유일 — 위 공통 클릭이 보장). 셋째 it의 confirm 미발화 단언은 그대로(빈 시나리오 → untouched → no confirm)이되, 기존 `// let baseline seed` 주석은 새 설계에 맞게 `// 에디터 mount 대기 (baseline은 템플릿 선택 시 선험 확정)`으로 교체.

라벨 셀렉터는 **카탈로그 상수로 못박는다**(리터럴 정규식 금지 — subagent 재량 제거): 파일 상단에 `import { ko } from "../../i18n/ko";` 추가 후 `{ name: ko.editor.create }` / `{ name: ko.editor.cancel }` 사용. 갤러리 통과 클릭도 `{ name: new RegExp(ko.templates.blankName) }`.

- [ ] **Step 5: GREEN 확인**

Run: `cd ui && pnpm test ScenarioNewPage`
Expected: gallery 5 + testrun 3 + STARTER_YAML 2 전부 PASS

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/pages/ScenarioNewPage.tsx ui/src/pages/__tests__/ScenarioNewPage.gallery.test.tsx ui/src/pages/__tests__/ScenarioNewPage.testrun.test.tsx
git commit -m "feat(ui): U3 새 시나리오 템플릿 갤러리(EditorShell mount 이전 단계) + 페이지 chrome 한국어화"
git log -1
```

---

### Task 4: 캔버스 빈 상태·추가 버튼 재라벨·톤 다운 + 패널 힌트 1회

**Files:**
- Modify: `ui/src/components/scenario/CanvasView.tsx:111-164` (버튼 행 + 빈 상태)
- Test: `ui/src/components/scenario/__tests__/CanvasView.test.tsx`

- [ ] **Step 1: 기존 [B] 단언 갱신 + 신규 단언 작성 (RED)**

`CanvasView.test.tsx` 갱신:
- L33 `/add loop/i` → `{ name: /반복\(loop\)/ }`
- L48 `/add if/i` → `{ name: /조건\(if\)/ }`
- L204 `/add parallel/i` → `{ name: /동시 실행\(parallel\)/ }`
- L54-66 빈 캔버스 힌트 2건: `screen.getByText(/add a step, loop, if, or parallel to begin/i)` → `screen.getByText(/HTTP 스텝을 추가해 시작하세요/)`, `getByRole("button", { name: /add step/i })` → `{ name: /HTTP 스텝/ }` (버튼-행-밖 배치 단언 구조는 유지)

신규 describe 추가:

```tsx
describe("CanvasView relabel + panel hint (U3)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("4 add buttons use Korean labels and a container caption line is always present", () => {
    render(<CanvasView />);
    expect(screen.getByRole("button", { name: "+ HTTP 스텝" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 반복(loop)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 조건(if)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 동시 실행(parallel)" })).toBeInTheDocument();
    expect(screen.getByText(/컨테이너입니다/)).toBeInTheDocument();
  });

  it("selecting a top-level loop morphs the primary button into the in-loop variant", async () => {
    const user = userEvent.setup();
    const loopId = useScenarioEditor.getState().addLoopStep("L");
    useScenarioEditor.getState().select(loopId);
    render(<CanvasView />);
    expect(screen.getByRole("button", { name: "+ 반복 안에 HTTP 스텝" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ 반복 안에 HTTP 스텝" }));
    const steps = useScenarioEditor.getState().model!.steps;
    expect(steps[0].type === "loop" && steps[0].do.length).toBe(2); // seed child + 1
  });

  it("shows the panel hint once after the FIRST add, hides it on the second add", async () => {
    const user = userEvent.setup();
    render(<CanvasView />);
    expect(screen.queryByText(/오른쪽 '스텝 설정'/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ HTTP 스텝" }));
    expect(screen.getByText(/오른쪽 '스텝 설정'/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ HTTP 스텝" }));
    expect(screen.queryByText(/오른쪽 '스텝 설정'/)).not.toBeInTheDocument();
  });

  it("tone-down: the 3 container buttons are muted, the HTTP button is not", () => {
    render(<CanvasView />);
    expect(screen.getByRole("button", { name: "+ 반복(loop)" })).toHaveClass("text-slate-500");
    expect(screen.getByRole("button", { name: "+ HTTP 스텝" })).not.toHaveClass("text-slate-500");
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test CanvasView`
Expected: 갱신·신규 단언 FAIL (영어 라벨 잔존)

- [ ] **Step 3: CanvasView 버튼 행/빈 상태 교체**

상단 import 추가: `import { ko } from "../../i18n/ko";` + react import에 `useState` 추가(`useRef`는 이미 있음 — CanvasView.tsx:1).

컴포넌트 본문(store 구독 아래)에 힌트 state:

```tsx
  // §5.2: 첫 스텝 추가 직후 1회 노출되는 패널 안내. 두 번째 추가/pane 클릭에 숨김,
  // ref 가드로 같은 mount에서 재노출 없음.
  const [panelHint, setPanelHint] = useState(false);
  const hintShownRef = useRef(false);
  const noteAdd = () => {
    if (!hintShownRef.current) {
      hintShownRef.current = true;
      setPanelHint(true);
    } else {
      setPanelHint(false);
    }
  };
```

`onPaneClick`에 `setPanelHint(false);` 추가. 버튼 행 교체(4개 버튼 onClick 기존 로직 유지 + 각 핸들러 첫 줄에 `noteAdd();`):

```tsx
      <div className="mt-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              noteAdd();
              if (selectedLoopId) {
                const id = addStepInLoop(selectedLoopId, `Step ${steps.length + 1}`);
                select(id);
              } else {
                const id = addStep(`Step ${steps.length + 1}`);
                select(id);
              }
            }}
            className="whitespace-nowrap px-3 py-1.5 text-sm font-medium border border-slate-400 rounded text-slate-900 hover:bg-slate-100"
          >
            {selectedLoopId ? ko.editor.addHttpStepInLoop : ko.editor.addHttpStep}
          </button>
          <button
            type="button"
            onClick={() => {
              noteAdd();
              const id = addLoopStep(`Loop ${steps.length + 1}`);
              select(id);
            }}
            className="whitespace-nowrap px-3 py-1.5 text-sm border border-slate-300 rounded text-slate-500 hover:bg-slate-100"
          >
            {ko.editor.addLoop}
          </button>
          <button
            type="button"
            onClick={() => {
              noteAdd();
              const id = addIfStep(`If ${steps.length + 1}`);
              select(id);
            }}
            className="whitespace-nowrap px-3 py-1.5 text-sm border border-slate-300 rounded text-slate-500 hover:bg-slate-100"
          >
            {ko.editor.addIf}
          </button>
          <button
            type="button"
            onClick={() => {
              noteAdd();
              const id = addParallelStep(`Parallel ${steps.length + 1}`);
              select(id);
            }}
            className="whitespace-nowrap px-3 py-1.5 text-sm border border-slate-300 rounded text-slate-500 hover:bg-slate-100"
          >
            {ko.editor.addParallel}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-400">{ko.editor.containerCaption}</p>
        {steps.length === 0 && (
          <p className="mt-2 text-xs text-slate-500">{ko.editor.canvasEmpty}</p>
        )}
        {panelHint && <p className="mt-2 text-xs text-slate-500">{ko.editor.panelHint}</p>}
      </div>
```

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test CanvasView && pnpm test`
Expected: 전부 PASS (다른 파일에 영어 add-button 셀렉터 잔존 시 여기서 드러남 — 같은 커밋에서 갱신)

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/components/scenario/CanvasView.tsx ui/src/components/scenario/__tests__/CanvasView.test.tsx
git commit -m "feat(ui): U3 캔버스 빈 상태·추가 버튼 4종 한국어 재라벨+톤 다운 + 스텝 설정 패널 힌트 1회"
git log -1
```

---

### Task 5: 스텝 설정 패널(구 Inspector)·EditorShell 재라벨

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx` (aria 5곳·h3 4곳·빈 선택 문구·Assertions/Extracts legend·extracts 부연)
- Modify: `ui/src/components/scenario/EditorShell.tsx:46-48` (YAML 탭 placeholder)
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx`, `ui/src/components/scenario/__tests__/EditorShell.test.tsx`

매핑 표 (visible == accessible name 유지):

| 위치 | 기존 | 신규 (카탈로그 키) |
|---|---|---|
| aside aria-label ×5 (56/216/813/906/1238) | `Inspector` | `ko.editor.inspectorAria` "스텝 설정" |
| 빈 선택 문구 (57) | Select a step in the canvas… | `ko.editor.inspectorEmpty` |
| Http h3 (218) | `Step` | `ko.editor.httpPanelTitle` "HTTP 스텝" |
| Loop h3 (908) | `Loop` | `ko.editor.loopPanelTitle` "반복(loop)" |
| If h3 (1240) | `If` | `ko.editor.ifPanelTitle` "조건(if)" |
| Parallel h3 (815) | `Parallel` | `ko.editor.parallelPanelTitle` "동시 실행(parallel)" |
| Assertions legend (493) | `Assertions` | `ko.editor.assertionsLegend` "응답 검증" |
| Extracts legend (639) + fieldset aria-label (637) | `Extracts` | `ko.editor.extractsLegend` "값 추출" (legend·aria 동일 문자열) |
| Extracts 부연 (신규, legend 아래) | — | `ko.editor.extractsHint` |
| EditorShell YAML 탭 (46-48) | Switch to the Canvas tab… | `ko.editor.yamlTabNoInspector` |

- [ ] **Step 1: 기존 [B] 단언 갱신 + 신규 단언 (RED)**

`Inspector.test.tsx`:
- L60 `/Select a step/i` → `/캔버스에서 스텝을 선택/`
- `getByRole("group", { name: /Extracts?/i })` 5곳(71, 96, 109, 130, 159) → `{ name: "값 추출" }`
- heading 단언: `"Loop"`(458) → `"반복(loop)"`, `"If"`(299, 468) → `"조건(if)"`

신규 it (기존 http-step describe에 추가):

```tsx
  it("U3: panel is labeled 스텝 설정 with Korean section titles", () => {
    const id = useScenarioEditor.getState().addStep("S1");
    useScenarioEditor.getState().select(id);
    render(<Inspector />);
    expect(screen.getByRole("complementary", { name: "스텝 설정" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "HTTP 스텝" })).toBeInTheDocument();
    expect(screen.getByText("응답 검증")).toBeInTheDocument();
    expect(screen.getByText(/응답에서 값을 꺼내/)).toBeInTheDocument(); // extracts 부연
  });
```

`EditorShell.test.tsx`(현재 it.todo 3개뿐)에 실제 테스트 1개 추가(todo는 유지). TabBar는 `role="tab"` + 라벨 `"Canvas"`/`"YAML"`(TabBar.tsx 확인 완료):

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorShell } from "../EditorShell";
import { useScenarioEditor } from "../../../scenario/store";

// YAML 탭 전환 시 Monaco 본체 import를 피한다(워커 모킹 불요 — 컴포넌트째 mock).
vi.mock("../MonacoYamlView", () => ({ MonacoYamlView: () => <div data-testid="yaml-view" /> }));

describe("EditorShell YAML tab placeholder (U3)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("U3: YAML 탭에서 스텝 설정 패널 자리는 한국어 안내를 보여준다", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(screen.getByText(/캔버스 탭에서 사용할 수 있습니다/)).toBeInTheDocument();
  });
});
```

(기존 it.todo 3개가 든 파일에 위 import/모킹을 합치되 todo는 유지. store reset 이디엄은 Inspector.test.tsx와 동일 — 직접 `getInitialState()` 호출.)

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test Inspector && pnpm test EditorShell`
Expected: 갱신·신규 단언 FAIL

- [ ] **Step 3: Inspector.tsx 재라벨 적용**

위 매핑 표 그대로 — `import { ko } from "../../i18n/ko";`는 Task 2에서 이미 추가됨. Extracts fieldset:

```tsx
    <fieldset
      className="flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3"
      aria-label={ko.editor.extractsLegend}
    >
      <legend className="px-1 text-xs font-semibold text-slate-600">
        {ko.editor.extractsLegend}
      </legend>
      <p className="text-xs text-slate-500">{ko.editor.extractsHint}</p>
```

(이외 내부 구조·필드 라벨(Name/Method/Headers/Body/Timeout/Think/Repeat/Body steps/Then/Elif/Else/Condition/Branches)·MoveButtons·Delete·placeholder는 **무변경** — 해석 노트 6.)

- [ ] **Step 4: EditorShell.tsx placeholder 교체**

```tsx
          <div className="text-xs text-slate-400 italic">{ko.editor.yamlTabNoInspector}</div>
```

(+ `import { ko } from "../../i18n/ko";`)

- [ ] **Step 5: GREEN + 전체**

Run: `cd ui && pnpm test Inspector && pnpm test EditorShell && pnpm test`
Expected: 전부 PASS ("Inspector"/"Assertions" 원문은 다른 파일 어디서도 미참조 — 정찰 grep 검증)

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx ui/src/components/scenario/__tests__/EditorShell.test.tsx
git commit -m "feat(ui): U3 스텝 설정 패널 재라벨(제목/응답 검증/값 추출+부연/빈 선택) + YAML 탭 안내 한국어화"
git log -1
```

---

### Task 6: 변수 표기 치트시트 (`VarCheatSheet`) + Variables 패널 정리

**Files:**
- Create: `ui/src/components/scenario/VarCheatSheet.tsx`
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (제목 옆 ⓘ + 문구 3건 카탈로그화 — 제목 aria+h3/빈 목록/추가 버튼)
- Modify: `ui/src/components/scenario/Inspector.tsx:239` (Request legend에 ⓘ)
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx` (todo 스텁 → 실테스트), `ui/src/components/scenario/__tests__/Inspector.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성 — `VariablesPanel.test.tsx` 실테스트로 교체**

```tsx
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VariablesPanel } from "../VariablesPanel";
import { useScenarioEditor } from "../../../scenario/store";

const reset = () =>
  useScenarioEditor.setState(
    (
      useScenarioEditor as unknown as {
        getInitialState: () => ReturnType<typeof useScenarioEditor.getState>;
      }
    ).getInitialState(),
  );

describe("VariablesPanel", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("lists variables and adds one via the two-field row", async () => {
    const user = userEvent.setup();
    render(<VariablesPanel />);
    expect(screen.getByText("변수 없음")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("new_var"), "base");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(useScenarioEditor.getState().model!.variables).toHaveProperty("base");
  });

  it("removes a variable", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().setVariable("tok", "x");
    render(<VariablesPanel />);
    await user.click(screen.getByRole("button", { name: "Remove variable tok" }));
    expect(useScenarioEditor.getState().model!.variables).not.toHaveProperty("tok");
  });

  it("U3: 변수 표기 치트시트 popover — 3분류(흐름/환경/시스템)를 연다/ESC로 닫는다", async () => {
    const user = userEvent.setup();
    render(<VariablesPanel />);
    const tip = screen.getByRole("button", { name: "변수 표기 도움말" });
    await user.click(tip);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("흐름 변수");
    expect(note).toHaveTextContent("${ENV}");
    expect(note).toHaveTextContent("${vu_id}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});
```

(기존 it.todo 3개는 위 실테스트로 대체 — 삭제. `Inspector.test.tsx`에도 1건 추가:)

```tsx
  it("U3: Request 섹션에도 변수 표기 치트시트가 붙는다", async () => {
    const user = userEvent.setup();
    const id = useScenarioEditor.getState().addStep("S1");
    useScenarioEditor.getState().select(id);
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: "변수 표기 도움말" }));
    expect(screen.getByRole("note")).toHaveTextContent("환경 변수");
  });
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test VariablesPanel`
Expected: FAIL — 한국어 문구·치트시트 부재

- [ ] **Step 3: `VarCheatSheet.tsx` 작성**

```tsx
import { HelpTip } from "../HelpTip";
import { ko } from "../../i18n/ko";

/** 변수 표기 3분류(ADR-0014) 치트시트 popover — Variables 패널·스텝 설정 공용 (spec §5.3).
 *  본문은 ko.glossary 단일 소스. HelpTip popover는 <span>이라 블록 *요소* 금지 —
 *  display:block 클래스를 단 span 3줄로 줄바꿈한다. */
export function VarCheatSheet() {
  return (
    <HelpTip label={ko.editor.varCheatSheetLabel}>
      <span className="block">{ko.glossary.varFlow}</span>
      <span className="mt-1 block">{ko.glossary.varEnv}</span>
      <span className="mt-1 block">{ko.glossary.varSys}</span>
    </HelpTip>
  );
}
```

- [ ] **Step 4: VariablesPanel 부착 + 문구 카탈로그화**

```tsx
import { useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import { VarCheatSheet } from "./VarCheatSheet";
```

- `<section aria-label="Variables">` → `aria-label={ko.editor.variablesTitle}`
- 제목 행 — **치트시트는 h3 *형제*로**(h3 안에 넣으면 heading accessible name이 "변수 변수 표기 도움말"로 오염됨, Summary.tsx도 heading이 아닌 라벨 div에 부착하는 컨벤션):

```tsx
      <div className="flex items-center">
        <h3 className="text-sm font-semibold text-slate-700">{ko.editor.variablesTitle}</h3>
        <VarCheatSheet />
      </div>
```

- `No variables` → `{ko.editor.variablesEmpty}`, `Add` 버튼 → `{ko.editor.variablesAdd}` (행 삭제 버튼 `Remove variable ${key}` aria-label은 영어 유지 — 연기 절 참조)

(주의: 좌측 칼럼 폭 210px < popover 224px — HelpTip의 edge-flip은 *뷰포트* 기준이라 칼럼을 넘쳐 캔버스 위로 떠도 absolute z-20으로 정상 표시, 칼럼 div에 overflow-hidden 없음 확인됨.)

- [ ] **Step 5: Inspector Request fieldset에 부착**

**legend 안에 넣지 말 것**(fieldset group accessible name이 "Request 변수 표기 도움말"로 오염) — legend는 무변경, fieldset 첫 콘텐츠 행으로 컨텍스트 라벨과 함께 추가:

```tsx
        <legend className="px-1 text-xs font-semibold text-slate-600">Request</legend>
        <div className="flex items-center text-xs text-slate-500">
          <span>{ko.editor.varCheatSheetContext}</span>
          <VarCheatSheet />
        </div>
```

("변수 표기"는 가시 컨텍스트 라벨 — 카탈로그 키 `ko.editor.varCheatSheetContext: "변수 표기"`를 Task 1의 editor 네임스페이스·ko.test.ts 키 목록에 추가해 사용. + `import { VarCheatSheet } from "./VarCheatSheet";`)

- [ ] **Step 6: GREEN + 전체**

Run: `cd ui && pnpm test VariablesPanel && pnpm test Inspector && pnpm test`
Expected: 전부 PASS

- [ ] **Step 7: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/components/scenario/VarCheatSheet.tsx ui/src/components/scenario/VariablesPanel.tsx ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/VariablesPanel.test.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): U3 변수 표기 치트시트(흐름/환경/시스템) popover + Variables 패널 한국어 정리"
git log -1
```

---

## 머지 전 최종 검증 (orchestrator)

1. **최종 handicap-reviewer** (whole-feature): ① ko.ts 키 ↔ 소비처 1:1(죽은 키·하드코딩 문구 잔존 0), ② 기존 RTL matcher 전수 갱신 여부(영어 라벨 셀렉터 잔존 grep), ③ 와이어 무변경(`POST /api/scenarios` 경로·TestRunSection 무접촉) + `url` 완화가 유일한 Zod 변경(허용 확대 방향)인지, ④ 템플릿 YAML ↔ 엔진 serde 1:1(assert/extract/body 와이어 포맷, ULID, two-tier 게이트), ⑤ deferral 추적(아래 "연기" 절이 코드 주석이 아니라 문서에 있는지).
2. **풀 게이트**: `cd ui && pnpm lint && pnpm test && pnpm build` (인자 없는 전체 1회 — S-D 교훈).
3. **라이브 Playwright 1회** (머지 게이트): 워크트리 root에서 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 후 `just ui-build` + `./target/debug/controller --db /tmp/u3.db --ui-dir ui/dist`(격리 DB, 워크트리 자체 바이너리). 확인 항목:
   - `/scenarios/new` → 갤러리 4카드 → "로그인 흐름" 선택 → 캔버스 2노드 + YAML 탭에 한국어 주석 보존.
   - URL 비우기 → 인라인 경고 + 캔버스 ⚠ 배지 → "만들기" → 저장 성공(서버 ULID/serde 통과 = 실서버 검증).
   - "단순 GET" 템플릿으로 시나리오 생성 → url을 로컬 echo(`python3 -m http.server` 등)로 수정 → run 1회 completed + 리포트 확인(run 경로 비접촉 회귀 확인).
   - 치트시트 ⓘ 열기/ESC, 빈 캔버스 한국어 문구, 패널 힌트 1회 노출, 콘솔 에러/Zod 0.
   - 스냅샷은 인라인 `browser_snapshot`/`browser_evaluate`만(파일 저장 금지 — Playwright cwd 함정).
4. 머지: master 전진 시 rebase 후 `git -C /Users/sgj/develop/handicap merge --ff-only <branch>` → `ExitWorktree`(머지 확인 후 `discard_changes: true`) → build-log 한 단락 append + 루트 CLAUDE.md 상태줄 *교체* + 메모리 갱신(U3 완료, U4 unblock).

## 연기 (이 슬라이스에서 의도적으로 안 하는 것)

- Inspector 나머지 필드 라벨(Name/Method/Headers/Body/Timeout/Think/Repeat/Body steps/Then/Elif/Else/Condition/Branches)·MoveButtons/Delete·placeholder 한국어화 — spec §5.2 밖, `ko.common` 후속 일괄(ADR-0035 소급 비목표).
- VariablesPanel 행 삭제 버튼 `Remove variable ${key}` aria-label 영어 잔존 — 같은 후속 일괄(기존 RTL 셀렉터 의존, U3 비범위).
- ScenarioEditPage chrome(Save/저장 확인 다이얼로그) 한국어화 — 동일.
- 갤러리 → 에디터 "뒤로"(템플릿 다시 선택) 동선 — 페이지 재진입으로 충분.
- 검증 배너·test-run 헤더 승격 — U4 (`url` 완화가 그 전제, 이 슬라이스가 unblock).
- `store.ts` private STARTER_YAML와 templates.ts의 물리적 단일화 — 동작 무변경 원칙(드리프트는 테스트가 가드).
