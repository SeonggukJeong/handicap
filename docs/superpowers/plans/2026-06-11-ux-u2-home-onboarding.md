# U2 — 홈 온보딩 · 빈 상태 · 길찾기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 홈(시나리오 목록)에 3단계 시작 가이드 카드를 얹고, 5개 페이지의 빈 상태를 "무엇+언제+다음 행동" 3요소 문구로 교체하고, 네비를 한국어화(+구분선)하고, run 상세·실행 목록·에디터·비교 페이지에 공유 `<Breadcrumb>`을 단다.

**Architecture:** 전부 **UI-only** (백엔드/proto/migration 무변경, spec §1.3 결정 5). 온보딩 진행 판정은 ①=서버 진실(`useScenarios().data.scenarios.length`), ②③=`localStorage["handicap.onboarding.v1"]` 플래그 — 순수 헬퍼 모듈(`ui/src/onboarding/state.ts`)로 추출해 단위 테스트(spec §9). 신규 문구는 전부 `ko.ts` 카탈로그 경유(ADR-0035). 신규 공유 컴포넌트 3종: `Breadcrumb`(5페이지), `EmptyState`(5페이지), `OnboardingGuide`(홈).

**Tech Stack:** React + TS + Tailwind + React Query v5 + vitest/RTL(jsdom). 신규 라이브러리 없음.

**Spec:** `docs/superpowers/specs/2026-06-11-ux-beginner-friendly-redesign-design.md` §3 (+§2 카탈로그 규칙). 의존 U1a(머지됨 — `ko.ts`/`HelpTip` 존재).

---

## Spec 해석 노트 (reviewer 확인 포인트)

spec §3은 "요지" 수준이라 다음 5가지를 plan 레벨에서 확정한다:

1. **시나리오 빈 상태에서 "템플릿" 언급 제거**: spec §3.2 표의 "템플릿에서 시작해보세요"는 U3(템플릿 갤러리) 출하 전엔 거짓말이 된다(U2/U3 순서 자유 — spec §8). U2 문구는 "첫 시나리오를 만들어 보세요"로 쓰고, U3가 갤러리를 출하할 때 그 슬라이스에서 문구를 갱신한다.
2. **페이지 chrome 한국어화 최소 보완**: §3.2 CTA 문구("→ 환경 만들기" 등)가 같은 화면의 영어 버튼("New environment")과 충돌하므로, **빈 상태가 가리키는 표면에 한해** 한국어화한다 — 4개 네비 페이지 h2 제목, 생성 버튼(New scenario/New environment/New schedule), Environments/Schedules 인라인 폼 h3, ScenarioRunsPage h2·"Run scenario" 버튼, ScenarioNewPage h2(breadcrumb "새 시나리오"와 일치), 홈 테이블 헤더·행 액션(Duplicate/runs →). **이 목록 밖 문구(Save/Cancel/Create/Loading…/에러 문구 등)는 불변** — 소급 추출 비목표(spec §2.1), 에디터 표면은 U3 영역.
3. **가이드 카드 step②③ 링크 타깃**: 전역 run 목록 API가 없으므로(`GET /api/runs` 부재) ②③은 **첫 시나리오의 실행 목록**(`/scenarios/{첫 id}/runs`)으로 링크. 시나리오가 없으면 ②③은 회색 안내 문구(링크 없음).
4. **ScenarioRunsPage에도 breadcrumb**: spec은 run 상세·에디터·비교만 명시하지만 run 상세의 "실행 목록" crumb이 가리키는 페이지가 breadcrumb 없이 비면 위계가 끊긴다 — `시나리오 > {이름} > 실행 목록` 추가, 기존 "← Edit scenario"/"← Scenario runs" 임시 링크는 breadcrumb으로 대체(중복 제거).
5. **비교 페이지**: `useScenario(scenarioId)` fetch 1개 추가(spec §3.3 명시). 기존 raw ULID chip은 breadcrumb의 시나리오 이름 crumb으로 대체(제거). 가드 상태(2개 미만/로딩/에러)에서도 breadcrumb이 보이도록 각 가드 div에도 삽입. 이름 fetch 실패 시 `scenarioId` fallback(관대).

## 사전 준비 (orchestrator — task 아님)

- 워크트리: `.claude/worktrees/u2-home-onboarding` (`worktree.baseRef: head` 설정 확인, EnterWorktree 거부 시 `git worktree add` fallback — U1b 전례).
- `cd ui && pnpm install` (새 워크트리엔 node_modules 없음).
- `cargo build -p handicap-worker && cargo build --workspace` (pre-commit cold-build flake 예방 warm).
- implementer 프롬프트 공통: **commit은 `run_in_background:false` + timeout 600000ms 단일 호출, 파이프(`| tail`) 금지, 커밋 후 `git log -1` 확인**. `git add`는 명시 경로만(`-A` 금지).
- 기존 RTL matcher 잔존 확인 grep (Task 4·5 후): `grep -rn "No scenarios yet\|No datasets yet\|No environments yet\|No schedules yet\|No runs yet\|New scenario\|New environment\|New schedule\|Run scenario\|Duplicate" ui/src`
  - **해석 가이드**: 에디터 표면(`ScenarioEditPage.tsx`의 Duplicate/Runs 버튼, `Inspector.tsx`, 그 테스트들)과 ScenarioNewPage의 Create/Cancel은 **의도적으로 영어 유지**(U3 영역) — 거기 매치는 잔존이 아니라 정상. U2 변경 표면(홈/보조 3페이지/runs 페이지/네비)의 매치만 처리.

---

### Task 1: ko.ts U2 카탈로그 + 온보딩 상태 모듈

**Files:**
- Modify: `ui/src/i18n/ko.ts` (네임스페이스 4개 추가: `nav`/`breadcrumb`/`onboarding`/`empty` + `pages`)
- Modify: `ui/src/i18n/__tests__/ko.test.ts` (신규 키 존재 단언 추가)
- Create: `ui/src/onboarding/state.ts`
- Create: `ui/src/onboarding/__tests__/state.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성 — `ui/src/onboarding/__tests__/state.test.ts`** (신규 src 파일보다 테스트 먼저 = tdd-guard 자연 통과)

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  dismissOnboarding,
  markReportViewed,
  markRunCreated,
  readOnboarding,
} from "../state";

const KEY = "handicap.onboarding.v1";

describe("onboarding state (localStorage 순수 헬퍼)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("키가 없으면 전부 false", () => {
    expect(readOnboarding()).toEqual({
      runCreated: false,
      reportViewed: false,
      dismissed: false,
    });
  });

  it("깨진 JSON·비객체 값은 전부 false로 관대 파싱", () => {
    window.localStorage.setItem(KEY, "not-json{");
    expect(readOnboarding()).toEqual({
      runCreated: false,
      reportViewed: false,
      dismissed: false,
    });
    window.localStorage.setItem(KEY, '"a string"');
    expect(readOnboarding().runCreated).toBe(false);
  });

  it("markRunCreated는 다른 플래그를 보존하며 merge한다", () => {
    dismissOnboarding();
    markRunCreated();
    expect(readOnboarding()).toEqual({
      runCreated: true,
      reportViewed: false,
      dismissed: true,
    });
  });

  it("markReportViewed / dismissOnboarding 각각 해당 플래그만 켠다", () => {
    markReportViewed();
    expect(readOnboarding().reportViewed).toBe(true);
    expect(readOnboarding().dismissed).toBe(false);
    dismissOnboarding();
    expect(readOnboarding().dismissed).toBe(true);
  });

  it("truthy 비불리언 값은 false로 정규화한다", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ runCreated: "yes", dismissed: 1 }));
    expect(readOnboarding()).toEqual({
      runCreated: false,
      reportViewed: false,
      dismissed: false,
    });
  });
});
```

- [ ] **Step 2: ko.test.ts에 신규 네임스페이스 단언 추가** — 기존 패턴(required 키 배열 + `toBeTypeOf("string")` + 비어있지 않음) 그대로. 기존 `it`들은 무수정.

```ts
// ko.test.ts에 추가하는 describe (기존 스타일 미러)
describe("U2 카탈로그 (nav/breadcrumb/onboarding/empty/pages)", () => {
  it("nav/breadcrumb 키가 존재한다", () => {
    const navKeys = ["scenarios", "datasets", "environments", "schedules"] as const;
    for (const k of navKeys) {
      expect(ko.nav[k], `nav.${k}`).toBeTypeOf("string");
      expect(ko.nav[k].length).toBeGreaterThan(0);
    }
    const bcKeys = ["runs", "compare"] as const;
    for (const k of bcKeys) {
      expect(ko.breadcrumb[k], `breadcrumb.${k}`).toBeTypeOf("string");
      expect(ko.breadcrumb[k].length).toBeGreaterThan(0);
    }
  });

  it("onboarding 3단계 문구가 존재한다", () => {
    const keys = [
      "ariaLabel", "title", "dismiss", "done",
      "step1Title", "step1Desc", "step1Cta",
      "step2Title", "step2Desc", "step2Cta", "step2Blocked",
      "step3Title", "step3Desc", "step3Cta", "step3Blocked",
    ] as const;
    for (const k of keys) {
      expect(ko.onboarding[k], `onboarding.${k}`).toBeTypeOf("string");
      expect(ko.onboarding[k].length).toBeGreaterThan(0);
    }
  });

  it("empty 5종은 무엇+다음 행동 3요소 패턴", () => {
    expect(ko.empty.scenarios).toContain("API 요청");
    expect(ko.empty.datasets).toContain("CSV");
    expect(ko.empty.environments).toContain("BASE_URL");
    expect(ko.empty.schedules).toContain("cron");
    expect(ko.empty.runs).toContain("실행");
    const ctaKeys = ["scenariosCta", "datasetsCta", "environmentsCta", "schedulesCta", "runsCta"] as const;
    for (const k of ctaKeys) {
      expect(ko.empty[k], `empty.${k}`).toBeTypeOf("string");
      expect(ko.empty[k].length).toBeGreaterThan(0);
    }
  });

  it("pages chrome 라벨 스모크", () => {
    expect(ko.pages.newScenario).toBe("새 시나리오");
    expect(ko.pages.runScenario).toBe("실행하기");
    expect(ko.pages.newEnvironment).toBe("새 환경");
    expect(ko.pages.newSchedule).toBe("새 스케줄");
  });
});
```

- [ ] **Step 3: RED 확인** — `cd ui && pnpm test state` → state.test FAIL(모듈 없음), `pnpm test ko` → 신규 describe FAIL.

- [ ] **Step 4: `ui/src/onboarding/state.ts` 구현**

```ts
/**
 * 홈 시작 가이드(U2, spec §3.1)의 진행 플래그.
 * ①(시나리오 존재)은 서버 진실이므로 여기 없음 — ②(run 생성)·③(리포트 열람)·dismiss만 저장.
 * localStorage 불가 환경(사파리 프라이빗 등)에선 조용히 no-op (가이드는 항상 미완으로 보임).
 */
export type OnboardingState = {
  runCreated: boolean;
  reportViewed: boolean;
  dismissed: boolean;
};

const KEY = "handicap.onboarding.v1";

const DEFAULTS: OnboardingState = {
  runCreated: false,
  reportViewed: false,
  dismissed: false,
};

export function readOnboarding(): OnboardingState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULTS };
    }
    const o = parsed as Record<string, unknown>;
    return {
      runCreated: o.runCreated === true,
      reportViewed: o.reportViewed === true,
      dismissed: o.dismissed === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(patch: Partial<OnboardingState>): void {
  try {
    const next = { ...readOnboarding(), ...patch };
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // fail-soft: 저장 불가면 가이드가 계속 보일 뿐, 기능엔 영향 없음
  }
}

export function markRunCreated(): void {
  write({ runCreated: true });
}

export function markReportViewed(): void {
  write({ reportViewed: true });
}

export function dismissOnboarding(): void {
  write({ dismissed: true });
}
```

- [ ] **Step 5: `ko.ts` 네임스페이스 추가** — `validation: { … },` 닫는 줄과 `} as const;` 사이에 삽입:

```ts
  nav: {
    scenarios: "시나리오",
    datasets: "데이터셋",
    environments: "환경",
    schedules: "스케줄",
  },
  breadcrumb: {
    runs: "실행 목록",
    compare: "런 비교",
    // "새 시나리오" crumb은 ko.pages.newScenario 재사용(단일 소스) — 별도 키 만들지 말 것.
  },
  onboarding: {
    ariaLabel: "시작 가이드",
    title: "처음이신가요? 3단계로 시작해 보세요",
    dismiss: "가이드 닫기",
    done: "완료",
    step1Title: "시나리오 만들기",
    step1Desc: "테스트할 API 요청 흐름을 정의합니다.",
    // "새 시나리오 만들기"(empty.scenariosCta)와 다른 문구여야 한다 — 같은 화면(빈 홈)에서
    // 두 링크의 accessible name이 충돌하면 RTL getByRole 단독 조회가 깨지고 UX상도 중복.
    step1Cta: "시나리오 만들러 가기",
    step2Title: "실행하기",
    step2Desc: "동시 사용자 수와 시간을 정해 부하를 보냅니다.",
    step2Cta: "실행하러 가기",
    step2Blocked: "먼저 시나리오를 만들어 주세요.",
    step3Title: "결과 읽기",
    step3Desc: "응답 속도와 에러로 합격 여부를 판단합니다.",
    step3Cta: "결과 보러 가기",
    step3Blocked: "먼저 실행(run)을 만들어 주세요.",
  },
  empty: {
    scenarios: "시나리오는 부하를 줄 API 요청 흐름입니다. 첫 시나리오를 만들어 보세요.",
    scenariosCta: "새 시나리오 만들기",
    datasets:
      "데이터셋은 시나리오의 {{변수}}에 줄 단위로 주입할 CSV/XLSX 표입니다. 시나리오가 변수를 쓸 때만 필요해요.",
    datasetsCta: "위 업로드 패널에서 CSV/XLSX 파일을 올려 보세요.",
    environments:
      "환경은 ${BASE_URL} 같은 환경 변수 묶음입니다. 같은 시나리오를 dev/stage에 번갈아 쏠 때 씁니다.",
    environmentsCta: "환경 만들기",
    schedules:
      "스케줄은 시나리오를 정해진 시각(1회) 또는 주기(cron)로 자동 실행합니다. 합격 기준과 함께 쓰면 회귀 감시가 됩니다.",
    schedulesCta: "스케줄 만들기",
    runs: "아직 실행 기록이 없습니다. 부하 설정을 정해 첫 실행을 만들어 보세요.",
    runsCta: "실행하기",
  },
  pages: {
    newScenario: "새 시나리오",
    nameCol: "이름",
    versionCol: "버전",
    updatedCol: "수정",
    duplicate: "복제",
    runsLink: "실행 →",
    newEnvironment: "새 환경",
    editEnvironment: "환경 편집",
    newSchedule: "새 스케줄",
    editSchedule: "스케줄 편집",
    runsTitle: "실행 목록",
    runScenario: "실행하기",
  },
```

(주의: `empty.environments`의 `${BASE_URL}`은 일반 따옴표 문자열이라 안전 — 백틱 템플릿 리터럴로 쓰지 말 것. 페이지 h2 제목은 `ko.nav.*` 재사용 — 단일 소스.)

- [ ] **Step 6: GREEN 확인** — `pnpm test state` → 5 pass, `pnpm test ko` → 전체 pass.

- [ ] **Step 7: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/i18n/ko.ts ui/src/i18n/__tests__/ko.test.ts ui/src/onboarding/state.ts ui/src/onboarding/__tests__/state.test.ts
git commit -m "feat(ui): U2 ko 카탈로그(nav/breadcrumb/onboarding/empty/pages) + 온보딩 localStorage 상태 모듈"
git log -1
```

---

### Task 2: 공유 컴포넌트 3종 — Breadcrumb · EmptyState · OnboardingGuide

**Files:**
- Create: `ui/src/components/Breadcrumb.tsx` / Test: `ui/src/components/__tests__/Breadcrumb.test.tsx`
- Create: `ui/src/components/EmptyState.tsx` / Test: `ui/src/components/__tests__/EmptyState.test.tsx`
- Create: `ui/src/components/OnboardingGuide.tsx` / Test: `ui/src/components/__tests__/OnboardingGuide.test.tsx`

- [ ] **Step 1: 실패하는 테스트 3개 작성**

`ui/src/components/__tests__/Breadcrumb.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Breadcrumb } from "../Breadcrumb";

function renderCrumbs(items: Array<{ label: string; to?: string }>) {
  return render(
    <MemoryRouter>
      <Breadcrumb items={items} />
    </MemoryRouter>,
  );
}

describe("Breadcrumb", () => {
  it("마지막 전 항목은 링크, 마지막 항목은 aria-current=page 텍스트", () => {
    renderCrumbs([
      { label: "시나리오", to: "/" },
      { label: "demo", to: "/scenarios/S1" },
      { label: "실행 목록" },
    ]);
    expect(screen.getByRole("navigation", { name: "breadcrumb" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "시나리오" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "demo" })).toHaveAttribute("href", "/scenarios/S1");
    const current = screen.getByText("실행 목록");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "실행 목록" })).toBeNull();
  });

  it("to 없는 중간 항목은 일반 텍스트(aria-current 없음)", () => {
    renderCrumbs([{ label: "시나리오", to: "/" }, { label: "이름없음" }, { label: "끝" }]);
    expect(screen.getByText("이름없음")).not.toHaveAttribute("aria-current");
  });

  it("빈 items면 아무것도 렌더하지 않는다", () => {
    const { container } = renderCrumbs([]);
    expect(container.querySelector("nav")).toBeNull();
  });
});
```

`ui/src/components/__tests__/EmptyState.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "../EmptyState";

describe("EmptyState", () => {
  it("본문과 action을 렌더한다", () => {
    render(<EmptyState body="아직 없습니다." action={<button type="button">만들기</button>} />);
    expect(screen.getByText("아직 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "만들기" })).toBeInTheDocument();
  });

  it("action 없으면 본문만", () => {
    render(<EmptyState body="아직 없습니다." />);
    expect(screen.getByText("아직 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
```

`ui/src/components/__tests__/OnboardingGuide.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { ko } from "../../i18n/ko";
import { OnboardingGuide } from "../OnboardingGuide";

const KEY = "handicap.onboarding.v1";

function renderGuide(firstScenarioId: string | null) {
  return render(
    <MemoryRouter>
      <OnboardingGuide firstScenarioId={firstScenarioId} />
    </MemoryRouter>,
  );
}

describe("OnboardingGuide (홈 시작 가이드 카드)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("시나리오 없음 → ① CTA 링크, ②③은 회색 안내", () => {
    renderGuide(null);
    const card = screen.getByRole("region", { name: ko.onboarding.ariaLabel });
    expect(within(card).getByRole("link", { name: `${ko.onboarding.step1Cta} →` })).toHaveAttribute(
      "href",
      "/scenarios/new",
    );
    expect(within(card).getByText(ko.onboarding.step2Blocked)).toBeInTheDocument();
    expect(within(card).getByText(ko.onboarding.step3Blocked)).toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: `${ko.onboarding.step2Cta} →` })).toBeNull();
  });

  it("시나리오 있음 → ① 완료(CTA 없음), ② 첫 시나리오 실행 목록 링크", () => {
    renderGuide("S1");
    const card = screen.getByRole("region", { name: ko.onboarding.ariaLabel });
    expect(within(card).queryByRole("link", { name: `${ko.onboarding.step1Cta} →` })).toBeNull();
    expect(within(card).getByRole("link", { name: `${ko.onboarding.step2Cta} →` })).toHaveAttribute(
      "href",
      "/scenarios/S1/runs",
    );
    // ③은 아직 run이 없으므로 회색 안내
    expect(within(card).getByText(ko.onboarding.step3Blocked)).toBeInTheDocument();
  });

  it("runCreated 플래그 → ② 완료, ③ 링크 활성", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ runCreated: true }));
    renderGuide("S1");
    const card = screen.getByRole("region", { name: ko.onboarding.ariaLabel });
    expect(within(card).queryByRole("link", { name: `${ko.onboarding.step2Cta} →` })).toBeNull();
    expect(within(card).getByRole("link", { name: `${ko.onboarding.step3Cta} →` })).toHaveAttribute(
      "href",
      "/scenarios/S1/runs",
    );
  });

  it("3단계 모두 완료면 카드 자체를 렌더하지 않는다", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ runCreated: true, reportViewed: true }));
    renderGuide("S1");
    expect(screen.queryByRole("region", { name: ko.onboarding.ariaLabel })).toBeNull();
  });

  it("✕ dismiss → 즉시 사라지고 localStorage에 영구 기록", async () => {
    const user = userEvent.setup();
    renderGuide(null);
    await user.click(screen.getByRole("button", { name: ko.onboarding.dismiss }));
    expect(screen.queryByRole("region", { name: ko.onboarding.ariaLabel })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toMatchObject({ dismissed: true });
  });

  it("이미 dismissed면 처음부터 렌더하지 않는다", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ dismissed: true }));
    renderGuide(null);
    expect(screen.queryByRole("region", { name: ko.onboarding.ariaLabel })).toBeNull();
  });
});
```

- [ ] **Step 2: RED 확인** — `pnpm test Breadcrumb`, `pnpm test EmptyState`, `pnpm test OnboardingGuide` 전부 FAIL(모듈 없음).

- [ ] **Step 3: 구현**

`ui/src/components/Breadcrumb.tsx`:

```tsx
import { Link } from "react-router-dom";

export type Crumb = { label: string; to?: string };

/** 상위 복귀 길찾기 (U2, spec §3.3). 마지막 항목 = 현재 페이지(aria-current="page", 링크 아님). */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="breadcrumb" className="mb-2 text-sm text-slate-500">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${i}-${c.label}`} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden="true">›</span>}
              {!last && c.to ? (
                <Link to={c.to} className="hover:underline hover:text-slate-700">
                  {c.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={last ? "text-slate-700" : undefined}
                >
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
```

`ui/src/components/EmptyState.tsx`:

```tsx
import type { ReactNode } from "react";

/** 빈 상태 3요소(무엇 + 언제 + 다음 행동) 공통 래퍼 (U2, spec §3.2). */
export function EmptyState({ body, action }: { body: string; action?: ReactNode }) {
  return (
    <div className="text-sm text-slate-500">
      <p>{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
```

`ui/src/components/OnboardingGuide.tsx`:

```tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { ko } from "../i18n/ko";
import { dismissOnboarding, readOnboarding } from "../onboarding/state";

const CTA_CLASS = "text-slate-700 underline hover:text-slate-900";

/**
 * 홈 시작 가이드 카드 (U2, spec §3.1).
 * ①은 서버 진실(firstScenarioId 존재), ②③은 localStorage 플래그.
 * 3단계 완료 또는 dismiss 시 영구 숨김. ②③ 링크는 첫 시나리오의 실행 목록
 * (전역 run 목록 API 부재 — 루트 CLAUDE.md).
 */
export function OnboardingGuide({ firstScenarioId }: { firstScenarioId: string | null }) {
  const [state, setState] = useState(readOnboarding);
  const hasScenario = firstScenarioId !== null;
  if (state.dismissed) return null;
  if (hasScenario && state.runCreated && state.reportViewed) return null;

  const runsHref = hasScenario ? `/scenarios/${firstScenarioId}/runs` : null;
  const steps = [
    {
      done: hasScenario,
      title: ko.onboarding.step1Title,
      desc: ko.onboarding.step1Desc,
      cta: (
        <Link to="/scenarios/new" className={CTA_CLASS}>
          {ko.onboarding.step1Cta} →
        </Link>
      ),
    },
    {
      done: state.runCreated,
      title: ko.onboarding.step2Title,
      desc: ko.onboarding.step2Desc,
      cta: runsHref ? (
        <Link to={runsHref} className={CTA_CLASS}>
          {ko.onboarding.step2Cta} →
        </Link>
      ) : (
        <span className="text-slate-400">{ko.onboarding.step2Blocked}</span>
      ),
    },
    {
      done: state.reportViewed,
      title: ko.onboarding.step3Title,
      desc: ko.onboarding.step3Desc,
      cta:
        state.runCreated && runsHref ? (
          <Link to={runsHref} className={CTA_CLASS}>
            {ko.onboarding.step3Cta} →
          </Link>
        ) : (
          <span className="text-slate-400">{ko.onboarding.step3Blocked}</span>
        ),
    },
  ];

  return (
    <section
      aria-label={ko.onboarding.ariaLabel}
      className="mb-6 border border-slate-200 rounded-md p-4 bg-white"
    >
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-semibold">{ko.onboarding.title}</h3>
        <button
          type="button"
          aria-label={ko.onboarding.dismiss}
          onClick={() => {
            dismissOnboarding();
            // localStorage 불가 환경에서도 세션 내에선 숨김 (영속 실패 시 fail-soft의 보완)
            setState((s) => ({ ...s, dismissed: true }));
          }}
          className="text-slate-400 hover:text-slate-600"
        >
          ✕
        </button>
      </div>
      <ol className="mt-3 grid gap-4 sm:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-2 text-sm">
            <span aria-hidden="true" className={s.done ? "text-emerald-600" : "text-slate-400"}>
              {s.done ? "✓" : i + 1}
            </span>
            <span className="min-w-0">
              <span className="font-medium">
                {s.title}
                {s.done && <span className="sr-only"> ({ko.onboarding.done})</span>}
              </span>
              <span className="block text-slate-500">{s.desc}</span>
              {!s.done && <span className="block mt-1">{s.cta}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
```

(설계 노트: 완료 표시는 색 단독이 아니라 글리프 차이(✓ vs 숫자) + sr-only "(완료)" — a11y 색단독 금지 컨벤션. `min-w-0`은 flex overflow 함정(ui/CLAUDE.md) 예방.)

- [ ] **Step 4: GREEN 확인** — 세 파일 테스트 전부 pass.

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/components/Breadcrumb.tsx ui/src/components/EmptyState.tsx ui/src/components/OnboardingGuide.tsx ui/src/components/__tests__/Breadcrumb.test.tsx ui/src/components/__tests__/EmptyState.test.tsx ui/src/components/__tests__/OnboardingGuide.test.tsx
git commit -m "feat(ui): U2 공유 컴포넌트 Breadcrumb/EmptyState/OnboardingGuide"
git log -1
```

---

### Task 3: 홈 온보딩 통합 — ScenarioListPage + 플래그 배선(useCreateRun·RunDetailPage)

**Files:**
- Modify: `ui/src/pages/ScenarioListPage.tsx` (카드 mount + 빈 상태 + chrome 한국어화)
- Modify: `ui/src/api/hooks.ts:108-124` (`useCreateRun` onSuccess에 `markRunCreated()`)
- Modify: `ui/src/pages/RunDetailPage.tsx` (리포트 열람 시 `markReportViewed()` effect)
- Create: `ui/src/pages/__tests__/ScenarioListPage.home.test.tsx`
- Modify: `ui/src/pages/__tests__/ScenarioListPage.clone.test.tsx` (`"Duplicate"` matcher → `"복제"`)
- Modify: `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx` (run 생성 테스트에 runCreated 플래그 단언 + `beforeEach` localStorage.clear)
- Modify: `ui/src/pages/__tests__/RunDetailPage.test.tsx` (리포트 렌더 테스트에 reportViewed 플래그 단언 + `beforeEach` localStorage.clear)

- [ ] **Step 1: 실패하는 테스트 작성 — `ScenarioListPage.home.test.tsx`** (fetch stub/renderPage 패턴은 `ScenarioListPage.clone.test.tsx` 그대로 미러)

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { ScenarioListPage } from "../ScenarioListPage";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DEMO = {
  id: "S1",
  name: "demo",
  yaml: "version: 1\nname: demo\nsteps: []\n",
  version: 1,
  created_at: 0,
  updated_at: 0,
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ScenarioListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioListPage 홈 온보딩 + 빈 상태 (U2)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("빈 목록: 3요소 빈 상태 + CTA + 가이드 카드(① 미완)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ scenarios: [] }));
    renderPage();
    expect(await screen.findByText(ko.empty.scenarios)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: `${ko.empty.scenariosCta} →` })).toHaveAttribute(
      "href",
      "/scenarios/new",
    );
    const card = screen.getByRole("region", { name: ko.onboarding.ariaLabel });
    expect(within(card).getByRole("link", { name: `${ko.onboarding.step1Cta} →` })).toBeInTheDocument();
    // 한국어 chrome
    expect(screen.getByRole("heading", { name: ko.nav.scenarios })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ko.pages.newScenario })).toHaveAttribute(
      "href",
      "/scenarios/new",
    );
  });

  it("시나리오 있으면 카드 ② 링크가 첫 시나리오 실행 목록을 가리킨다", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ scenarios: [DEMO] }));
    renderPage();
    await screen.findByRole("link", { name: "demo" });
    const card = screen.getByRole("region", { name: ko.onboarding.ariaLabel });
    expect(within(card).getByRole("link", { name: `${ko.onboarding.step2Cta} →` })).toHaveAttribute(
      "href",
      "/scenarios/S1/runs",
    );
    // 테이블 행 액션 한국어화
    expect(screen.getByRole("button", { name: ko.pages.duplicate })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ko.pages.runsLink })).toHaveAttribute(
      "href",
      "/scenarios/S1/runs",
    );
  });

  it("dismissed 상태면 카드 없이 목록만", async () => {
    window.localStorage.setItem(
      "handicap.onboarding.v1",
      JSON.stringify({ dismissed: true }),
    );
    fetchMock.mockResolvedValue(jsonResponse({ scenarios: [DEMO] }));
    renderPage();
    await screen.findByRole("link", { name: "demo" });
    expect(screen.queryByRole("region", { name: ko.onboarding.ariaLabel })).toBeNull();
  });
});
```

- [ ] **Step 2: 기존 테스트 갱신(같은 step에서 RED 목록 확정)**
  - `ScenarioListPage.clone.test.tsx`: `getByRole("button", { name: "Duplicate" })` → `{ name: "복제" }` (2개 테스트 모두).
  - `ScenarioRunsPage.test.tsx`: 파일 상단 `beforeEach`에 `window.localStorage.clear();` 추가. run 생성 후 네비게이션을 단언하는 기존 테스트(`screen.getByText("run page")` 사용처)에 아래 단언 추가:
    ```ts
    expect(
      JSON.parse(window.localStorage.getItem("handicap.onboarding.v1")!),
    ).toMatchObject({ runCreated: true });
    ```
  - `RunDetailPage.test.tsx`: 파일 상단(첫 describe 위) `beforeEach(() => window.localStorage.clear());` 추가. 리포트 렌더를 단언하는 기존 테스트(`findByRole("region", { name: /Report summary/ })` 사용처)에 아래 단언 추가:
    ```ts
    expect(
      JSON.parse(window.localStorage.getItem("handicap.onboarding.v1")!),
    ).toMatchObject({ reportViewed: true });
    ```
    또 "no-fetch-while-running" 테스트(running 상태, `/report` 0회 단언)엔 **플래그가 안 켜졌음을** 추가 단언: `expect(window.localStorage.getItem("handicap.onboarding.v1")).toBeNull();`

- [ ] **Step 3: RED 확인** — `pnpm test ScenarioListPage` (home 신규 FAIL + clone matcher FAIL), `pnpm test ScenarioRunsPage`, `pnpm test RunDetailPage` FAIL.

- [ ] **Step 4: `ScenarioListPage.tsx` 교체** (전체 — 변경점: import 3개, h2/버튼/테이블 헤더/행 액션 카탈로그화, 카드 mount, 빈 상태 EmptyState화. `onClone`·로딩/에러/복제에러 줄은 무수정):

```tsx
import { Link } from "react-router-dom";
import { useCloneScenario, useScenarios } from "../api/hooks";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { OnboardingGuide } from "../components/OnboardingGuide";
import { ko } from "../i18n/ko";

export function ScenarioListPage() {
  const { data, isLoading, error } = useScenarios();
  const clone = useCloneScenario();

  function onClone(scenario: { yaml: string; name: string }) {
    const existingNames = data?.scenarios.map((s) => s.name) ?? [];
    clone.reset();
    clone.mutate({ sourceYaml: scenario.yaml, sourceName: scenario.name, existingNames });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">{ko.nav.scenarios}</h2>
        <Link to="/scenarios/new">
          <Button>{ko.pages.newScenario}</Button>
        </Link>
      </div>

      {data && <OnboardingGuide firstScenarioId={data.scenarios[0]?.id ?? null} />}

      {isLoading && <p className="text-slate-500">Loading…</p>}
      {error && <p className="text-red-600">Failed to load: {(error as Error).message}</p>}
      {clone.error && (
        <p role="alert" className="mb-3 text-sm text-red-600">
          복제 실패: {(clone.error as Error).message}
        </p>
      )}

      {data && data.scenarios.length === 0 && (
        <EmptyState
          body={ko.empty.scenarios}
          action={
            <Link to="/scenarios/new" className="text-slate-700 underline hover:text-slate-900">
              {ko.empty.scenariosCta} →
            </Link>
          }
        />
      )}

      {data && data.scenarios.length > 0 && (
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="py-2 pr-4 font-medium">{ko.pages.nameCol}</th>
              <th className="py-2 pr-4 font-medium">{ko.pages.versionCol}</th>
              <th className="py-2 pr-4 font-medium">{ko.pages.updatedCol}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.scenarios.map((s) => (
              <tr key={s.id} className="border-b border-slate-100">
                <td className="py-3 pr-4 font-medium">
                  <Link to={`/scenarios/${s.id}`} className="hover:underline">
                    {s.name}
                  </Link>
                </td>
                <td className="py-3 pr-4 text-slate-600">v{s.version}</td>
                <td className="py-3 pr-4 text-slate-600">
                  {new Date(s.updated_at).toLocaleString()}
                </td>
                <td className="py-3 pr-4 text-right">
                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => onClone(s)}
                      disabled={clone.isPending}
                      className="text-slate-700 hover:underline disabled:text-slate-400"
                    >
                      {ko.pages.duplicate}
                    </button>
                    <Link to={`/scenarios/${s.id}/runs`} className="text-slate-700 hover:underline">
                      {ko.pages.runsLink}
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 5: `hooks.ts` `useCreateRun` onSuccess 배선** — UI의 모든 run 생성 경로(RunDialog·즉시 재실행·동일 설정 재실행)가 이 훅을 지나는 단일 chokepoint:

```ts
// 파일 상단 import에 추가
import { markRunCreated } from "../onboarding/state";

// useCreateRun의 onSuccess (hooks.ts:120-122) 교체
    onSuccess: (run) => {
      markRunCreated(); // U2 온보딩 ②: UI 경유 run 생성 성공 시 1회성 플래그
      qc.invalidateQueries({ queryKey: queryKeys.scenarioRuns(run.scenario_id) });
    },
```

- [ ] **Step 6: `RunDetailPage.tsx` reportViewed effect** — import 줄 2곳 + effect 1개 (hooks는 early-return 가드 *앞*에):

```tsx
// 1행: import { useEffect, useMemo } from "react";
// import 블록에 추가: import { markReportViewed } from "../onboarding/state";

// 컴포넌트 본문, `const scenario = useScenario(...)` 아래 / stepOrder useMemo 위에:
  // U2 온보딩 ③: 종료된 run의 리포트가 실제 화면에 렌더된 시점 기록
  useEffect(() => {
    if (terminal && report.data) markReportViewed();
  }, [terminal, report.data]);
```

(deps `[terminal, report.data]`는 exhaustive-deps 클린 — `markReportViewed`는 모듈 함수라 deps 불요.)

- [ ] **Step 7: GREEN 확인** — `pnpm test ScenarioListPage && pnpm test ScenarioRunsPage && pnpm test RunDetailPage` 전부 pass.

- [ ] **Step 8: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/pages/ScenarioListPage.tsx ui/src/api/hooks.ts ui/src/pages/RunDetailPage.tsx ui/src/pages/__tests__/ScenarioListPage.home.test.tsx ui/src/pages/__tests__/ScenarioListPage.clone.test.tsx ui/src/pages/__tests__/ScenarioRunsPage.test.tsx ui/src/pages/__tests__/RunDetailPage.test.tsx
git commit -m "feat(ui): U2 홈 시작 가이드 카드 + 시나리오 빈 상태 + run생성/리포트열람 온보딩 플래그"
git log -1
```

---

### Task 4: 보조 페이지 빈 상태 + chrome — Datasets · Environments · Schedules

**Files:**
- Modify: `ui/src/pages/DatasetsPage.tsx` (h2 + 빈 상태)
- Modify: `ui/src/pages/EnvironmentsPage.tsx` (h2, 생성 버튼, 폼 h3, 빈 상태+CTA)
- Modify: `ui/src/pages/SchedulesPage.tsx` (h2, 생성 버튼, 폼 h3, 빈 상태+CTA)
- Modify: `ui/src/pages/__tests__/DatasetsPage.test.tsx` (matcher 2곳)
- Modify: `ui/src/pages/__tests__/EnvironmentsPage.test.tsx` (matcher 3곳 + 버튼 name)
- Modify: `ui/src/pages/__tests__/SchedulesPage.test.tsx` (빈 상태 테스트 신규)

- [ ] **Step 1: 기존 테스트 matcher 갱신 + Schedules 빈 상태 테스트 추가 (RED 작성)**
  - `DatasetsPage.test.tsx`: `findByText(/No datasets yet/i)` → `findByText(ko.empty.datasets)` (상단에 `import { ko } from "../../i18n/ko";`), 51–55의 전용 테스트와 79의 post-delete `waitFor` 둘 다.
  - `EnvironmentsPage.test.tsx`: `/No environments yet/i` 3곳(42–46 전용 테스트, 76 settle 대기, 102 post-delete) → `ko.empty.environments`. `getByRole("button", { name: /new environment/i })` → `{ name: "새 환경" }`. 전용 빈 상태 테스트에 CTA 단언 추가:
    ```ts
    expect(screen.getByRole("button", { name: `${ko.empty.environmentsCta} →` })).toBeInTheDocument();
    ```
  - `SchedulesPage.test.tsx`: 신규 테스트 추가. **주의(리뷰어 확인)**: 이 파일엔 `renderPage()`가 없고 `wrap(<SchedulesPage />)` 헬퍼(7–14행)를 쓰며, fetch stub은 `beforeEach`에 fixture로 박혀 있다 — 신규 테스트 안에서 stub을 빈 응답으로 **재설치**한 뒤 `wrap`으로 렌더:
    ```ts
    it("빈 상태: 3요소 문구 + 스케줄 만들기 CTA", async () => {
      // 기존 beforeEach stub을 빈 목록 응답으로 덮어쓴다
      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/schedules")) return Promise.resolve(jsonResponse({ schedules: [] }));
        if (url.endsWith("/api/scenarios")) return Promise.resolve(jsonResponse({ scenarios: [] }));
        return Promise.resolve(jsonResponse({}, 404));
      });
      render(wrap(<SchedulesPage />));
      expect(await screen.findByText(ko.empty.schedules)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `${ko.empty.schedulesCta} →` })).toBeInTheDocument();
    });
    ```
    (파일의 실제 mock 헬퍼명·jsonResponse 시그니처에 맞춰 미세 조정 — 구조는 기존 테스트와 동일하게.)

- [ ] **Step 2: RED 확인** — `pnpm test DatasetsPage && pnpm test EnvironmentsPage && pnpm test SchedulesPage` FAIL.

- [ ] **Step 3: 페이지 3개 수정** (각 파일 상단에 `import { ko } from "../i18n/ko";` + `import { EmptyState } from "../components/EmptyState";` 추가)

`DatasetsPage.tsx`:
- h2(line 33): `<h2 className="text-lg font-semibold">Datasets</h2>` → `{ko.nav.datasets}`
- 빈 상태(line 47):
  ```tsx
  {data && data.datasets.length === 0 && (
    <EmptyState body={ko.empty.datasets} action={<p className="text-slate-500">{ko.empty.datasetsCta}</p>} />
  )}
  ```
  (업로드 패널이 같은 화면 위에 항상 떠 있으므로 CTA는 링크가 아니라 그 패널을 가리키는 안내 문구.)

`EnvironmentsPage.tsx`:
- h2(line 105): `Environments` → `{ko.nav.environments}`
- 생성 버튼(line 106): `New environment` → `{ko.pages.newEnvironment}`
- 폼 h3(lines 114–116): `"New environment"`/`"Edit environment"` → `{ko.pages.newEnvironment}`/`{ko.pages.editEnvironment}`
- 빈 상태(lines 230–232, `mode === "none"` 게이트 유지):
  ```tsx
  {data && data.length === 0 && mode === "none" && (
    <EmptyState
      body={ko.empty.environments}
      action={
        <button
          type="button"
          onClick={startNew}
          className="text-slate-700 underline hover:text-slate-900"
        >
          {ko.empty.environmentsCta} →
        </button>
      }
    />
  )}
  ```

`SchedulesPage.tsx`:
- h2(line 121): `Schedules` → `{ko.nav.schedules}`
- 생성 버튼(line 122): `New schedule` → `{ko.pages.newSchedule}`
- 폼 h3(lines 130–132): `"New schedule"`/`"Edit schedule"` → `{ko.pages.newSchedule}`/`{ko.pages.editSchedule}`
- 빈 상태(lines 161–163, 게이트 유지): Environments와 동일 패턴, `body={ko.empty.schedules}` / CTA `{ko.empty.schedulesCta} →` + `onClick={startNew}`.

- [ ] **Step 4: GREEN 확인** — 세 페이지 테스트 pass.

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/pages/DatasetsPage.tsx ui/src/pages/EnvironmentsPage.tsx ui/src/pages/SchedulesPage.tsx ui/src/pages/__tests__/DatasetsPage.test.tsx ui/src/pages/__tests__/EnvironmentsPage.test.tsx ui/src/pages/__tests__/SchedulesPage.test.tsx
git commit -m "feat(ui): U2 보조 페이지(데이터셋/환경/스케줄) 빈 상태 3요소 교체 + chrome 한국어화"
git log -1
```

---

### Task 5: 길찾기 — 네비 한국어화·구분선 + breadcrumb 5페이지

**Files:**
- Modify: `ui/src/components/Layout.tsx` / `ui/src/components/__tests__/Layout.test.tsx`
- Modify: `ui/src/pages/RunDetailPage.tsx` (breadcrumb, "← Scenario runs" 제거)
- Modify: `ui/src/pages/ScenarioRunsPage.tsx` (breadcrumb, h2·버튼 한국어화, "← Edit scenario" 제거, 빈 상태)
- Modify: `ui/src/pages/ScenarioEditPage.tsx` (breadcrumb)
- Modify: `ui/src/pages/ScenarioNewPage.tsx` (breadcrumb + h2 한국어화)
- Modify: `ui/src/pages/ScenarioComparePage.tsx` (useScenario + breadcrumb, ULID chip 제거)
- Modify: `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx`, `__tests__/RunDetailPage.test.tsx`, `__tests__/ScenarioNewPage.testrun.test.tsx`, `__tests__/ScenarioComparePage.test.tsx`

- [ ] **Step 1: 테스트 갱신/추가 (RED 작성)**
  - `Layout.test.tsx` — 기존 1개 테스트 교체 + 확장:
    ```tsx
    import { render, screen } from "@testing-library/react";
    import { MemoryRouter } from "react-router-dom";
    import { describe, expect, it } from "vitest";
    import { ko } from "../../i18n/ko";
    import { Layout } from "../Layout";

    describe("Layout nav", () => {
      it("네비 4개가 한국어 라벨로 올바른 경로를 가리킨다", () => {
        render(
          <MemoryRouter>
            <Layout />
          </MemoryRouter>,
        );
        expect(screen.getByRole("link", { name: ko.nav.scenarios })).toHaveAttribute("href", "/");
        expect(screen.getByRole("link", { name: ko.nav.datasets })).toHaveAttribute("href", "/datasets");
        expect(screen.getByRole("link", { name: ko.nav.environments })).toHaveAttribute("href", "/environments");
        expect(screen.getByRole("link", { name: ko.nav.schedules })).toHaveAttribute("href", "/schedules");
      });
    });
    ```
    (주의: 브랜드 "Handicap" 링크도 `/`를 가리키지만 name이 달라 충돌 없음.)
  - `ScenarioRunsPage.test.tsx`:
    - "Run scenario" 이름으로 버튼을 찾는 matcher가 있으면 → `ko.pages.runScenario`("실행하기")로 (`grep -n "Run scenario" ui/src/pages/__tests__/ScenarioRunsPage.test.tsx`로 확인 — 리뷰어 grep 기준 **0건 예상**, 다이얼로그 열림은 `findByLabelText(/동시 사용자/)`로 감지하는 구조라 이 항목은 no-op일 수 있음).
    - breadcrumb 단언 추가(기존 ≥1 run fixture 테스트에): `expect(screen.getByRole("link", { name: "demo" })).toHaveAttribute("href", "/scenarios/S1")` — 단 기존에 같은 name의 링크가 있다면 `within(screen.getByRole("navigation", { name: "breadcrumb" }))`로 스코프.
    - 빈 상태 신규 테스트: runs mock `{ runs: [] }` → `findByText(ko.empty.runs)` + CTA 버튼 `{ name: `${ko.empty.runsCta} →` }` 클릭 시 다이얼로그 열림(`findByLabelText(/동시 사용자/)`).
  - `RunDetailPage.test.tsx`: breadcrumb 단언은 **retry (A1) describe**(232행 부근 — `/api/scenarios/S1`을 mock하는 describe)에 추가. **주의(리뷰어 확인)**: "report on terminal" describe는 시나리오가 **S9**라 거기에 S1 단언을 넣으면 즉시 FAIL:
    ```ts
    const bc = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(bc).getByRole("link", { name: "실행 목록" })).toHaveAttribute("href", "/scenarios/S1/runs");
    ```
    파일 상단 import에 `within` 추가 필요(현재 `render, screen, waitFor`만). 기존 "← Scenario runs" 텍스트를 참조하는 단언은 없음(조사 확인) — 추가 갱신 불요. abort describe(시나리오 404)는 breadcrumb 이름 crumb이 `r.scenario_id.slice(0, 8)` fallback으로 렌더돼 기존 단언과 충돌 없음.
  - `ScenarioNewPage.testrun.test.tsx`: 헤더 구조 테스트의 `getByRole("heading", { name: /New scenario/ })` → `{ name: "새 시나리오" }` (breadcrumb의 "새 시나리오"는 heading role이 아니라 충돌 없음).
  - `ScenarioEditPage.testrun.test.tsx`: breadcrumb 단언 1개 추가 (5개 breadcrumb 표면 중 에디터만 무단언이면 안 됨 — spec §9):
    ```ts
    const bc = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(bc).getByRole("link", { name: "시나리오" })).toHaveAttribute("href", "/");
    ```
    (기존 `within(header).getByRole("heading", …)` 단언들은 breadcrumb이 헤더 형제라 충돌 없음 — 리뷰어 확인.)
  - `ScenarioComparePage.test.tsx`: **`beforeEach`에 공통으로** `vi.spyOn(api, "getScenario").mockResolvedValue({ id: "S1", name: "demo", yaml: "version: 1\nname: demo\nsteps: []\n", version: 1, created_at: 0, updated_at: 0 });` 설치 — **개별 테스트 1곳이 아니라 전 테스트**. 이유(리뷰어 확인): 이 파일은 global fetch stub 없이 `vi.spyOn(api, …)`만 쓰므로, `useScenario` 추가 후 spy 없는 테스트(로딩/에러/가드)는 진짜 `fetch("/api/scenarios/S1")`(jsdom 상대 URL TypeError)를 발화한다 — RQ가 삼켜 통과는 해도 비결정적 노이즈 + 가드 breadcrumb 단언이 fallback 상태를 검증하게 됨. 정상 렌더 테스트에 breadcrumb 단언(이름 crumb은 scenario 쿼리 settle 의존이라 `findByRole`):
    ```ts
    const bc = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(await within(bc).findByRole("link", { name: "demo" })).toHaveAttribute("href", "/scenarios/S1");
    expect(within(bc).getByText("런 비교")).toHaveAttribute("aria-current", "page");
    ```
    가드 테스트(2개 미만)에도 breadcrumb 존재 단언 1줄. ULID chip(`getByText("S1")` 류 단언이 있으면) 제거에 맞춰 갱신.

- [ ] **Step 2: RED 확인** — 위 4개 테스트 파일 FAIL.

- [ ] **Step 3: `Layout.tsx` 수정** — nav 블록(lines 11–24) 교체 + `import { ko } from "../i18n/ko";`:

```tsx
<nav className="flex items-center gap-4 text-sm text-slate-600">
  <Link to="/" className="hover:text-slate-900">
    {ko.nav.scenarios}
  </Link>
  <span aria-hidden="true" className="h-4 w-px bg-slate-300" />
  <Link to="/datasets" className="hover:text-slate-900">
    {ko.nav.datasets}
  </Link>
  <Link to="/environments" className="hover:text-slate-900">
    {ko.nav.environments}
  </Link>
  <Link to="/schedules" className="hover:text-slate-900">
    {ko.nav.schedules}
  </Link>
</nav>
```

(주 동선(시나리오) vs 보조 리소스 3개 사이 세로 구분선 — spec §3.3. 구조·라우트 무변경.)

- [ ] **Step 4: `RunDetailPage.tsx`** — `import { Breadcrumb } from "../components/Breadcrumb";` + `import { ko } from "../i18n/ko";`. root `<div>` 첫 자식으로 breadcrumb 삽입, 기존 `<p className="text-sm text-slate-600"><Link …>← Scenario runs</Link></p>`(lines 104–108) **삭제**:

```tsx
return (
  <div>
    <Breadcrumb
      items={[
        { label: ko.nav.scenarios, to: "/" },
        {
          label: scenario.data?.name ?? r.scenario_id.slice(0, 8),
          to: `/scenarios/${r.scenario_id}`,
        },
        { label: ko.breadcrumb.runs, to: `/scenarios/${r.scenario_id}/runs` },
        { label: `#${r.id.slice(0, 8)}` },
      ]}
    />
    <div className="flex items-center justify-between mb-6">
      …(기존 헤더 — h2는 무변경, "← Scenario runs" p만 제거)…
```

(시나리오 fetch 실패(404)에 관대 — name crumb은 id 앞 8자 fallback. 기존 abort describe fixture가 이 경로를 지난다.)

- [ ] **Step 5: `ScenarioRunsPage.tsx`** — import 3개(`Breadcrumb`, `EmptyState`, `ko`) 추가. 헤더(lines 110–121) 교체:

```tsx
<Breadcrumb
  items={[
    { label: ko.nav.scenarios, to: "/" },
    { label: scenario.data.name, to: `/scenarios/${scenario.data.id}` },
    { label: ko.breadcrumb.runs },
  ]}
/>
<div className="flex items-center justify-between mb-4">
  <h2 className="text-xl font-semibold">
    {ko.pages.runsTitle} · {scenario.data.name}
  </h2>
  {!showDialog && <Button onClick={openBlank}>{ko.pages.runScenario}</Button>}
</div>
```

("← Edit scenario" 링크는 breadcrumb의 이름 crumb(→ 에디터)으로 대체 — 삭제. `?retry=` effect와 그 deps는 **절대 건드리지 말 것**(ui/CLAUDE.md exhaustive-deps 함정).)

빈 상태(line 155) 교체:

```tsx
{runs.data && runs.data.runs.length === 0 && (
  <EmptyState
    body={ko.empty.runs}
    action={
      !showDialog ? (
        <button
          type="button"
          onClick={openBlank}
          className="text-slate-700 underline hover:text-slate-900"
        >
          {ko.empty.runsCta} →
        </button>
      ) : undefined
    }
  />
)}
```

- [ ] **Step 6: `ScenarioEditPage.tsx`** — import(`Breadcrumb`, `ko`) 추가, 헤더 wrapper(line 81 `<div className="flex items-center justify-between">`) 바로 위에:

```tsx
<Breadcrumb items={[{ label: ko.nav.scenarios, to: "/" }, { label: data.name }]} />
```

(이 지점은 `data` 가드 통과 후라 non-null. 다른 문구는 무변경 — 에디터 표면은 U3.)

- [ ] **Step 7: `ScenarioNewPage.tsx`** — import(`Breadcrumb`, `ko`) 추가, 헤더 wrapper 위에 breadcrumb + h2 교체:

```tsx
<Breadcrumb
  items={[{ label: ko.nav.scenarios, to: "/" }, { label: ko.pages.newScenario }]}
/>
<div className="flex items-center justify-between">
  <h2 className="text-xl font-semibold">{ko.pages.newScenario}</h2>
  …(Create/Cancel 버튼 무변경 — U3 영역)…
```

- [ ] **Step 8: `ScenarioComparePage.tsx`** — outer 컴포넌트에 `useScenario` + breadcrumb(가드 포함), Inner의 ULID chip 제거:

```tsx
// import 추가
import { useReports, useScenario } from "../api/hooks";
import { Breadcrumb, type Crumb } from "../components/Breadcrumb";
import { ko } from "../i18n/ko";

// outer 본문 (useReports 아래에)
const scenario = useScenario(scenarioId);
const crumbs: Crumb[] = [
  { label: ko.nav.scenarios, to: "/" },
  { label: scenario.data?.name ?? scenarioId ?? "", to: `/scenarios/${scenarioId}` },
  { label: ko.breadcrumb.runs, to: `/scenarios/${scenarioId}/runs` },
  { label: ko.breadcrumb.compare },
];
```

- 가드 3개(2개 미만 line 30–36 / 로딩 41–49 / 에러 51–61): 각 `<div className="p-6">` 첫 자식으로 `<Breadcrumb items={crumbs} />` 삽입.
- Inner 호출에 `crumbs={crumbs}` prop 추가, `InnerProps`에 `crumbs: Crumb[]` 추가.
- Inner 렌더: `<div className="p-6 max-w-6xl">` 첫 자식으로 `<Breadcrumb items={crumbs} />`, 헤더 row의 ULID chip `<span …>{scenarioId}</span>`(lines 155–157) **삭제** (h2 "런 비교"·"N개 런" 유지).

(useScenario는 가드 return보다 앞(훅 규칙). 시나리오 fetch 실패 시 `scenarioId` fallback — 페이지는 시나리오 fetch에 안 막힘.)

- [ ] **Step 9: GREEN 확인** — `pnpm test Layout && pnpm test ScenarioRunsPage && pnpm test RunDetailPage && pnpm test ScenarioNewPage && pnpm test ScenarioComparePage` 전부 pass.

- [ ] **Step 10: 잔존 영어 matcher/문구 전수 grep** (계획 밖 누락 탐지):

```bash
grep -rn "No scenarios yet\|No datasets yet\|No environments yet\|No schedules yet\|No runs yet\|Run scenario\|← Edit scenario\|← Scenario runs" ui/src && echo "잔존 있음 — 처리 필요" || echo "클린"
```

- [ ] **Step 11: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/components/Layout.tsx ui/src/components/__tests__/Layout.test.tsx ui/src/pages/RunDetailPage.tsx ui/src/pages/ScenarioRunsPage.tsx ui/src/pages/ScenarioEditPage.tsx ui/src/pages/ScenarioNewPage.tsx ui/src/pages/ScenarioComparePage.tsx ui/src/pages/__tests__/ScenarioRunsPage.test.tsx ui/src/pages/__tests__/RunDetailPage.test.tsx ui/src/pages/__tests__/ScenarioNewPage.testrun.test.tsx ui/src/pages/__tests__/ScenarioComparePage.test.tsx ui/src/pages/__tests__/ScenarioEditPage.testrun.test.tsx
git commit -m "feat(ui): U2 네비 한국어화+구분선 + breadcrumb 5페이지(run상세/실행목록/에디터/새시나리오/비교)"
git log -1
```

---

## 머지 전 최종 검증 (orchestrator)

1. **최종 handicap-reviewer** (whole-feature): 특히 ① ko.ts 키 ↔ 소비처 1:1(죽은 키·하드코딩 문구 잔존), ② 기존 RTL matcher 전수 갱신 여부, ③ payload/와이어 무변경(이 슬라이스는 GET-only UI — `POST /api/runs` 경로는 hooks.ts onSuccess 한 줄만, 요청 페이로드 불변), ④ exhaustive-deps(`?retry=` effect 불가침).
2. **풀 게이트**: `cd ui && pnpm lint && pnpm test && pnpm build` (인자 없는 전체 1회 — S-D 교훈).
3. **라이브 Playwright 1회** (S-D 머지 게이트): 격리 DB로 `./target/debug/controller --db /tmp/u2.db --ui-dir ui/dist`(워크트리 자체 바이너리, 사전 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`) →
   - 빈 DB 홈: 가이드 카드(① 미완) + 한국어 빈 상태 + 네비 4개 한국어.
   - 시나리오 생성 → run 생성(RunDialog) → `localStorage["handicap.onboarding.v1"].runCreated === true` (`browser_evaluate`).
   - run 상세 리포트 렌더 → `reportViewed === true`, breadcrumb 4단 + 링크 동작.
   - 홈 복귀: ①②③ ✓ → 카드 자동 숨김. localStorage 초기화 후 dismiss(✕) → 새로고침에도 숨김 유지.
   - 비교 페이지(run 2개): breadcrumb에 시나리오 이름.
   - 콘솔 Zod/에러 0. 스크린샷은 인라인 `browser_snapshot`/`browser_evaluate`만(저장 파일 금지 — Playwright cwd 함정).
4. 머지: master 전진 시 rebase 후 `git -C /Users/sgj/develop/handicap merge --ff-only <branch>` → 워크트리 정리 → build-log append + 루트 상태줄 교체 + 메모리 갱신.
