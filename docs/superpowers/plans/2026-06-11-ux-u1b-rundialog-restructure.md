# U1b — RunDialog 3그룹 재구성 + 크기 프리셋 chips + 용어 한국어화·HelpTip + 막힘 사유 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run 설정(RunDialog)을 초보자가 기본값으로 바로 실행할 수 있는 3그룹 구조(부하 정의 / 대상 설정 / 판정·고급 접힘)로 재편하고, 전문 용어를 한국어 라벨+HelpTip으로, 막힘(비활성) 사유를 가시화한다. **제출 payload는 byte-identical.**

**Architecture:** spec `docs/superpowers/specs/2026-06-11-ux-beginner-friendly-redesign-design.md` §6 (U1b). UI-only. U1a가 깐 `ko.ts` 카탈로그·`<HelpTip>`을 소비. 변경 파일: `ko.ts`(확장) / `LoadModelFields.tsx`(chips+한국어화) / `CriteriaFields.tsx`(라벨) / `DataBindingPanel.tsx`(reasons 계약 확장+자동연결 배지) / `RunDialog.tsx`(3그룹 재편) / `ScheduleForm.tsx`(고유 문구 정리+reasons 소비). 테스트는 spec §6.6 두 부류: **A=payload 단언 무수정**(드라이버 셀렉터만 기계적 갱신), **B/C=라벨·문구·펼침 단언 갱신 허용**.

**Tech Stack:** React 18 + TS + Tailwind, vitest + RTL. 신규 의존성 0.

**워크트리·게이트 주의 (orchestrator):**
- `.claude/worktrees/<name>` 워크트리(`EnterWorktree`, baseRef head). 첫 task 전 `cd ui && pnpm install` + `cargo build -p handicap-worker && cargo build --workspace` warm(cold-build flake 예방).
- 각 task = RED→GREEN 확인 후 **하나의 green 커밋**. implementer 커밋은 foreground 단일 호출(timeout 600000ms), 파이프 금지, 커밋 후 `git log -1`. e2e flake(worker ENOENT/SIGKILL/sig 15)면 동일 커밋 1회 재시도.
- UI 게이트(`pnpm lint && pnpm test && pnpm build`)는 hook 미실행 — 각 task에서 수동.
- `pnpm test <name>` 필터에 `--` 붙이지 말 것.

**테스트 분류 권위 (2026-06-11 master 추출, RunDialog.test.tsx 53 it):**
- **[A] payload 단언 무수정 16개**: L64, L150, L196, L237, L409, L427, L548, L627, L659, L695, L749, L878, L980, L1124, L1213, L1311 — `toMatchObject`/`toEqual`/`toBeCloseTo`/`toBeUndefined` payload 검사 줄은 **글자 하나 못 바꾼다**. 드라이버 셀렉터(아래 매핑 표)만 갱신.
- **[C] 혼합 2개**: L443(rename), L1085(http timeout) — payload 줄 무수정, 라벨 줄 갱신.
- **[B] 라벨·문구·펼침 35개**: 매핑 표대로 갱신. 단 **단언의 의미(존재/부재/disabled/값)는 유지** — 셀렉터만 교체.

---

## 라벨·셀렉터 매핑 표 (전 task 공통 권위 — visible 라벨과 aria-label을 **함께** 변경해 WCAG label-in-name 유지)

| 현재 (visible + aria) | 변경 후 (visible = aria) | 테스트 셀렉터 갱신 |
|---|---|---|
| `New run` (h3) | `새 실행` | (셀렉터 의존 없음) |
| `Run` / `Starting…` (버튼) | `실행` / `시작 중…` | `/^Run$/`→`/^실행$/` (L1348의 `/^run$/i`도 `/^실행$/`) |
| `Cancel` | `취소` | (의존 없음) |
| `Closed-loop (VU)` (라디오) | `사용자 수 기준 (closed-loop)` | `/closed-loop/i` → `/사용자 수 기준/` |
| `Open-loop (rate)` (라디오) | `요청 속도 기준 (open-loop)` | `/open-loop/i` → `/요청 속도 기준/` |
| `VUs` | `동시 사용자(VU)` | `"VUs"` → `/동시 사용자/` |
| `Duration (s)` (closed·open 2곳) | `테스트 시간(초)` | `/Duration/`·`"Duration (s)"` → `/테스트 시간/` |
| `Ramp-up (s)` | `점진 시작(초)` | `/Ramp-up/` → `/점진 시작/` |
| `Target RPS` | `목표 RPS` | `/target rps/i` → `/목표 RPS/i` |
| `Max in-flight` | `동시 요청 상한` | `/max in.?flight/i`·`"Max in-flight"` → `/동시 요청 상한/` |
| `HTTP timeout (s)` | `HTTP 타임아웃(초)` | `/HTTP timeout/i` → `/HTTP 타임아웃/` |
| `Loop breakdown cap` / aria `loop breakdown cap` | `루프 집계 상한` | `/loop breakdown cap/i` → `/루프 집계 상한/` |
| `Think min (ms)` / `Think max (ms)` / `Think seed (선택)` | `think 최소(ms)` / `think 최대(ms)` / `think 시드 (선택)` | `/Think min/`→`/think 최소/`, `/Think max/`→`/think 최대/`, `/Think seed/`→`/think 시드/` |
| `Max p50 (ms)` 등 CriteriaFields 11종 | `최대 p50(ms)` / `최대 p95(ms)` / `최대 p99(ms)` / `최대 에러율(%)` / `최소 RPS` / `최대 4xx 비율(%)` / `최대 5xx 비율(%)` / `최대 4xx 수` / `최대 5xx 수` / `최소 윈도 RPS` / `RPS 워밍업(초)` | `/Max p50/`→`/최대 p50/`, `/Max p95/`→`/최대 p95/`, `/Max p99/`→`/최대 p99/`, `/Max error rate/`→`/최대 에러율/`, `/Min RPS/`→`/최소 RPS/`(주의: `/최소 윈도 RPS/`와 구분 — 정확매치 `"최소 RPS"` 권장), `/Max 5xx rate/`→`/최대 5xx 비율/`, `/Max 5xx count/`→`/최대 5xx 수/`, `/Min window RPS/`→`/최소 윈도 RPS/`, `/RPS warmup/`→`/RPS 워밍업/` |
| 에러 `Ramp-up must be ≤ duration.` | `점진 시작은 테스트 시간 이하여야 합니다.` | `/Ramp-up must be ≤ duration/` → `/점진 시작은 테스트 시간 이하/` |
| 에러 `Target RPS must be between 1 and 1,000,000.` | `목표 RPS는 1 ~ 1,000,000 사이여야 합니다.` | → `/목표 RPS는 1 ~ 1,000,000 사이/` |
| 에러 `Max in-flight must be between 1 and 10,000.` | `동시 요청 상한은 1 ~ 10,000 사이여야 합니다.` | → `/동시 요청 상한은 1 ~ 10,000 사이/` |
| 에러 `HTTP timeout must be between 1 and 600 seconds.` | `HTTP 타임아웃은 1 ~ 600초 사이여야 합니다.` | → `/HTTP 타임아웃은 1 ~ 600초 사이/` |
| SLO 토글 `SLO 기준 (선택)` (fieldset) | 그룹 3 토글 `판정·고급 (선택)`로 흡수, 그룹 안 소제목 `합격 기준(SLO)` | `getByRole("button",{name:/SLO 기준/})` → `getByRole("button",{name:/판정·고급/})` |
| Pacing 토글 `Pacing (think time, 선택)` | 그룹 3 안 소제목 `페이싱 (think time)` — 전용 토글 삭제 | `getByRole("button",{name:/Pacing/})` 클릭 → `/판정·고급/` 클릭으로 교체 |
| 진단/고급 토글 `진단/고급 (선택)` | 그룹 3 토글로 흡수, 소제목 `진단` | `/진단\/고급/` 의존 테스트 없음(확인됨) |

**불변(변경 금지)**: `stage target ${i}`/`stage duration ${i}`/`remove stage ${i}` aria-label, `부하 모델`/`프로파일` legend, `고정`/`곡선` 라디오, `부하 모양` select, `+ 단계 추가`, EnvironmentPicker의 모든 aria-label(`Environment variables` region·`select environment`·`env key N`·`new env key`…)과 내부 문구, DataBindingPanel의 기존 aria-label·문구(reasons·배지 추가분 제외), 프리셋 행 문구(`프리셋 불러오기`·`프리셋으로 저장`·`이름 변경`·`프리셋 삭제`·`preset name` aria), `0 ~ 10000 사이여야 합니다.`(이미 한국어), `min ≤ max ≤ 600000, 둘 다 입력`, 인라인 헬퍼 3종(`각 단계가 끝날 때의…`/`이 단계가 지속되는…`/`동시 처리 상한 —…`), 시나리오 드리프트 경고 문구.

---

### Task 1: `ko.ts` 카탈로그 확장 (runDialog·loadModel·validation 네임스페이스)

**Files:**
- Modify(Test): `ui/src/i18n/__tests__/ko.test.ts`
- Modify: `ui/src/i18n/ko.ts`

- [ ] **Step 1: 실패하는 테스트 추가** — `ko.test.ts` describe 끝에:

```ts
  it("U1b 네임스페이스(runDialog/loadModel/validation)가 비어 있지 않다", () => {
    expect(ko.runDialog.title).toBe("새 실행");
    expect(ko.runDialog.groupAdvanced).toContain("판정·고급");
    expect(ko.loadModel.vus).toContain("동시 사용자");
    expect(ko.loadModel.sizePresets.length).toBe(3);
    for (const p of ko.loadModel.sizePresets) {
      expect(p.vus).toBeGreaterThan(0);
      expect(p.durationSeconds).toBeGreaterThan(0);
    }
    expect(ko.validation.httpTimeout).toContain("1 ~ 600");
  });
```

- [ ] **Step 2: RED 확인** — Run: `cd ui && pnpm test ko` / Expected: 신규 1개 FAIL(`runDialog` 프로퍼티 없음 — esbuild 경로라 TS 에러가 아니라 런타임 undefined 접근 실패), 기존 3개 PASS

- [ ] **Step 3: 구현** — `ko.ts`의 `glossary` 뒤(같은 `ko` 객체 안)에 추가:

```ts
  runDialog: {
    title: "새 실행",
    run: "실행",
    running: "시작 중…",
    cancel: "취소",
    groupLoad: "부하 정의",
    groupTarget: "대상 설정",
    groupAdvanced: "판정·고급 (선택)",
    sectionSlo: "합격 기준(SLO)",
    sectionPacing: "페이싱 (think time)",
    sectionDiag: "진단",
    blockedReasonsIntro: "실행하려면 다음을 해결하세요:",
    bindingReasonPrefix: "데이터 바인딩: ",
  },
  loadModel: {
    closedLoop: "사용자 수 기준 (closed-loop)",
    openLoop: "요청 속도 기준 (open-loop)",
    vus: "동시 사용자(VU)",
    duration: "테스트 시간(초)",
    rampUp: "점진 시작(초)",
    targetRps: "목표 RPS",
    maxInFlight: "동시 요청 상한",
    httpTimeout: "HTTP 타임아웃(초)",
    loopCap: "루프 집계 상한",
    thinkMin: "think 최소(ms)",
    thinkMax: "think 최대(ms)",
    thinkSeed: "think 시드 (선택)",
    sizePresetsLabel: "부하 크기 프리셋",
    sizePresets: [
      { label: "가볍게", vus: 10, durationSeconds: 30, hint: "10명 · 30초" },
      { label: "보통", vus: 50, durationSeconds: 60, hint: "50명 · 1분" },
      { label: "세게", vus: 200, durationSeconds: 180, hint: "200명 · 3분" },
    ],
  },
  validation: {
    rampUp: "점진 시작은 테스트 시간 이하여야 합니다.",
    targetRps: "목표 RPS는 1 ~ 1,000,000 사이여야 합니다.",
    maxInFlight: "동시 요청 상한은 1 ~ 10,000 사이여야 합니다.",
    httpTimeout: "HTTP 타임아웃은 1 ~ 600초 사이여야 합니다.",
  },
```

(파일 끝 `} as const;` 유지. `sizePresets`는 `as const` 하 readonly 튜플이 됨 — 소비처에서 `readonly`로 받는다.)

- [ ] **Step 4: GREEN** — Run: `cd ui && pnpm test ko` / Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add ui/src/i18n/ko.ts ui/src/i18n/__tests__/ko.test.ts
git commit -m "feat(ui): ko 카탈로그 U1b 네임스페이스(runDialog/loadModel/validation) (U1b)"
```

---

### Task 2: LoadModelFields — 크기 chips + 한국어화 + HelpTip

**Files:**
- Modify(Test): `ui/src/components/__tests__/LoadModelFields.test.tsx`
- Modify(Test): `ui/src/components/__tests__/RunDialog.test.tsx` (이 task가 바꾸는 라벨의 드라이버만 — 매핑 표)
- Modify: `ui/src/components/LoadModelFields.tsx`

**범위**: 매핑 표 중 LoadModelFields 소유분(라디오 2종·VUs·Duration·Ramp-up·Target RPS·Max in-flight + 영어 에러 3종) + chips + HelpTip 4곳(VU·점진 시작·동시 요청 상한·라디오 fieldset legend 옆 2개는 glossary closedLoop/openLoop을 라디오 라벨 옆에). **불변**: stage aria 3종, `부하 모델`/`프로파일`/`고정`/`곡선`/`부하 모양`/`+ 단계 추가`/인라인 헬퍼 3종/stages role=alert 에러.

- [ ] **Step 1: LoadModelFields.test.tsx 갱신 + chips 테스트 추가** — 기존 8개를 매핑 표대로 셀렉터 교체(예: L42 `/부하 모델/i` 유지, L48 `/곡선/` 유지, L59 `/closed-loop/i`→`/사용자 수 기준/`, L66 `"VUs"`→`/동시 사용자/`, L67 `"Ramp-up (s)"`→`/점진 시작/`, L68 `"Target RPS"`→`/목표 RPS/i` 부재 단언, L69·L75·L81 `"Max in-flight"`→`/동시 요청 상한/`, L74 `"Target RPS"`→`/목표 RPS/i`, L76 `"VUs"`→`/동시 사용자/` 부재, L82 stage aria 유지, L83 `"부하 모양"` 유지, L88 `/HTTP timeout/i`→`/HTTP 타임아웃/` 부재 단언). describe 끝에 chips 신규 3개:

```tsx
  it("closed 모드에서 부하 크기 프리셋 chips가 보이고 클릭하면 VU·시간을 채운다", async () => {
    const user = userEvent.setup();
    const props = setup();
    expect(screen.getByRole("group", { name: /부하 크기 프리셋/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /보통/ }));
    expect(props.setVus).toHaveBeenCalledWith(50);
    expect(props.setDuration).toHaveBeenCalledWith(60);
  });

  it("open 모드에선 크기 chips가 없다", () => {
    setup({ loadModel: "open" });
    expect(screen.queryByRole("group", { name: /부하 크기 프리셋/ })).toBeNull();
  });

  it("현재 VU·시간이 프리셋과 일치하면 해당 chip이 눌린 상태(aria-pressed)다", () => {
    setup({ vus: 10, duration: 30 });
    expect(screen.getByRole("button", { name: /가볍게/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /보통/ })).toHaveAttribute("aria-pressed", "false");
  });
```

(`setup` 헬퍼는 기존 L14–37 그대로 — overrides 지원 확인, 기본 `loadModel:"closed"`.)

- [ ] **Step 2: RED 확인** — Run: `cd ui && pnpm test LoadModelFields` / Expected: 갱신 셀렉터·chips 신규가 FAIL(구 라벨 렌더 중), 일부 유지 셀렉터 테스트 PASS

- [ ] **Step 3: 구현** — `LoadModelFields.tsx`:

  **⚠ HelpTip 배치 제약 (HTML 유효성)**: HelpTip은 `<button>`이라 **`<label>` 안에 넣으면 안 된다**(label 내 interactive 요소는 불법이고, 클릭이 라디오/입력 활성화로 전달됨). 패턴:
  - 입력(aria-label 보유: VU/시간/점진 시작/목표 RPS/동시 요청 상한): 기존 `<label>` 래핑을 `<div className="block text-sm">`로 바꾸고, `<span>{라벨}</span><HelpTip…/><input aria-label={라벨} …/>` — accessible name은 이미 있는 aria-label이 계속 제공(라벨 텍스트와 동일 문자열로 갱신).
  - 라디오(aria-label 없음, label 텍스트가 accessible name): 라디오+텍스트는 `<label>` 안에 유지하고 **HelpTip은 label 닫은 뒤 형제로** 배치.

  1. import 추가: `import { ko } from "../i18n/ko";` + `import { HelpTip } from "./HelpTip";`
  2. 라디오 라벨(L66·L76): `Closed-loop (VU)` → `{ko.loadModel.closedLoop}` + 라벨 텍스트 뒤 `<HelpTip label="closed-loop 설명">{ko.glossary.closedLoop}</HelpTip>`; `Open-loop (rate)` → `{ko.loadModel.openLoop}` + `<HelpTip label="open-loop 설명">{ko.glossary.openLoop}</HelpTip>`
  3. closed 분기 그리드(L115) **위에** chips 삽입:

```tsx
      {loadModel === "closed" && (
        <div role="group" aria-label={ko.loadModel.sizePresetsLabel} className="mb-2 flex flex-wrap gap-2">
          {ko.loadModel.sizePresets.map((p) => {
            const active = vus === p.vus && duration === p.durationSeconds;
            return (
              <button
                key={p.label}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setVus(p.vus);
                  setDuration(p.durationSeconds);
                }}
                className={`rounded-full border px-3 py-1 text-sm ${
                  active
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {p.label} <span className="text-xs text-slate-400">{p.hint}</span>
              </button>
            );
          })}
        </div>
      )}
```

  4. 입력 라벨·aria 교체(visible과 aria 동일하게): `VUs`→`{ko.loadModel.vus}`/aria-label `ko.loadModel.vus` + 라벨 span 뒤 `<HelpTip label="VU 설명">{ko.glossary.vu}</HelpTip>`; `Duration (s)`(2곳)→`ko.loadModel.duration`; `Ramp-up (s)`→`ko.loadModel.rampUp` + `<HelpTip label="점진 시작 설명">{ko.glossary.rampUp}</HelpTip>`; `Target RPS`→`ko.loadModel.targetRps` + `<HelpTip label="RPS 설명">{ko.glossary.rps}</HelpTip>`; `Max in-flight`→`ko.loadModel.maxInFlight` + `<HelpTip label="동시 요청 상한 설명">{ko.glossary.maxInFlight}</HelpTip>`
  5. 에러 3종 교체: L154→`{ko.validation.rampUp}`, L183→`{ko.validation.maxInFlight}`, L218→`{ko.validation.targetRps}`
  6. 기타 문자열·구조·stage 행·미리보기 일절 무변경.

- [ ] **Step 4: LoadModelFields GREEN** — Run: `cd ui && pnpm test LoadModelFields` / Expected: PASS (11 tests)

- [ ] **Step 5: RunDialog.test.tsx 드라이버 갱신 (이 task가 바꾼 라벨만)** — 매핑 표대로: `"VUs"`(L305,L539,L865,L873 등)→`/동시 사용자/`, `/Duration/`·`"Duration (s)"`(L137,L306,L540,L875,L1006)→`/테스트 시간/`, `/Ramp-up/`(L82,L141,L307,L541,L866,L874,L1165)→`/점진 시작/`, `/target rps/i`(L800,L809,L846,L849,L1010)→`/목표 RPS/i`, `/max in.?flight/i`·`"Max in-flight"`(L801,L822,L854,L901,L1013)→`/동시 요청 상한/`, `/closed-loop/i`(L834,L864,L1053)→`/사용자 수 기준/`, `/open-loop/i`(L799,L807,L820,L835,L843,L872,L894,L921,L933,L962,L972,L1004,L1050,L1055,L1064)→`/요청 속도 기준/`, 에러 문구 L147→`/점진 시작은 테스트 시간 이하/`, L812→`/목표 RPS는 1 ~ 1,000,000 사이/`, L825→`/동시 요청 상한은 1 ~ 10,000 사이/`. **payload 단언 줄(분류 A)은 무수정.**

- [ ] **Step 6: 전체 GREEN** — Run: `cd ui && pnpm test RunDialog && pnpm test LoadModelFields` / Expected: 53 + 11 PASS

- [ ] **Step 7: 커밋**

```bash
git add ui/src/components/LoadModelFields.tsx ui/src/components/__tests__/LoadModelFields.test.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): LoadModelFields 크기 chips + 한국어 라벨·HelpTip + 검증 문구 통일 (U1b)"
```

---

### Task 3: DataBindingPanel — `onValidityChange(ok, reasons)` 확장 + 자동 연결 배지

**Files:**
- Modify(Test): `ui/src/components/__tests__/DataBindingPanel.test.tsx`
- Modify: `ui/src/components/DataBindingPanel.tsx`

- [ ] **Step 1: 실패하는 테스트 추가** — `DataBindingPanel.test.tsx`의 mock 타입 4곳(L125·L186·L203·L313)을 `(ok: boolean, reasons?: string[]) => void`로 갱신하고, describe 끝에:

```tsx
  it("미커버 변수가 있으면 reasons에 변수명 사유가 들어간다", async () => {
    // 기존 'uncovered → onValidityChange(false)' 테스트(L203 근방)의 setup·mock 변수를
    // 그대로 복제 재사용(이 파일의 기존 onValidityChange mock 변수명을 따를 것 — 새 fixture 금지).
    const calls = onValidity.mock.calls; // ← 기존 mock 변수명으로 치환
    const last = calls[calls.length - 1];
    expect(last[0]).toBe(false);
    expect((last[1] as string[]).join(" ")).toContain("user");
  });

  it("자동 매칭된 행에 '자동 연결됨' 배지가 보인다", async () => {
    // 기존 auto-match 테스트와 동일 setup(데이터셋 컬럼명 == 변수명) 후
    expect(await screen.findByText(/자동 연결됨/)).toBeInTheDocument();
  });
```

(주의: 두 테스트의 setup은 이 파일의 기존 헬퍼·fixture를 그대로 재사용 — 새 fixture를 만들지 말 것. 기존에 auto-match를 검증하는 테스트가 없으면 컬럼명==변수명 데이터셋 fixture로 신규 작성.)

- [ ] **Step 2: RED** — Run: `cd ui && pnpm test DataBindingPanel` / Expected: 신규 2개 FAIL

- [ ] **Step 3: 구현** — `DataBindingPanel.tsx`:
  1. Props L14: `onValidityChange: (ok: boolean, reasons: string[]) => void;`
  2. emit effect(L123–170) 재작성 — 사유 수집:

```ts
    if (!selectedId) {
      onChange(null);
      onValidityChange(true, []);
      return;
    }
    // …기존 mapping 조립 로직 유지…
    const uncovered = [...scannedVars].filter(
      (v) => !mappedVars.has(v) && !availableElsewhere.has(v),
    );
    const staleCols = rows.filter(
      (r) => r.sourceKind === "column" && r.column && !columnSet.has(r.column),
    );
    const reasons: string[] = [
      ...uncovered.map((v) => `{{${v}}} 변수의 열을 선택하거나 매핑을 추가하세요`),
      ...staleCols.map((r) => `{{${r.varName}}}에 선택한 열(${r.column})이 현재 데이터셋에 없습니다`),
      ...(datasetGone ? ["이 프리셋의 데이터셋이 삭제되었습니다 — 다시 선택하세요"] : []),
    ];
    onValidityChange(reasons.length === 0, reasons);
```

  (기존 `uncoveredCount`/`noStaleColumns` boolean 파생은 위 배열에서 도출하도록 교체 — 판정 의미 무변경: `uncovered.length === 0 && staleCols.length === 0 && !datasetGone`.)
  3. 자동 매칭 effect(L101–120): 자동 매칭된 변수명 집합을 state로 기록 — `const [autoMatchedVars, setAutoMatchedVars] = useState<Set<string>>(new Set());` 추가, effect에서 변환된 행의 varName을 수집해 set. 리셋 2곳(L93·L217–218)에서 `setAutoMatchedVars(new Set())` 동반.
  4. 행 렌더: `autoMatchedVars.has(r.varName) && r.sourceKind === "column"`이면 행에 `<span className="ml-1 rounded bg-emerald-50 px-1 text-xs text-emerald-700">자동 연결됨</span>` 배지.
  5. 기존 aria-label·문구 일절 무변경.

- [ ] **Step 4: GREEN** — Run: `cd ui && pnpm test DataBindingPanel` / Expected: 전체 PASS. 이어서 `pnpm build`(tsc -b)로 **RunDialog/ScheduleForm의 기존 1-인자 콜백(`setBindingValid`)이 2-인자 타입에 그대로 할당 가능함**(컴파일 통과) 확인 — reasons *소비*는 Task 4/5.

- [ ] **Step 5: 커밋**

```bash
git add ui/src/components/DataBindingPanel.tsx ui/src/components/__tests__/DataBindingPanel.test.tsx
git commit -m "feat(ui): DataBindingPanel 막힘 사유(reasons) emit + 자동 연결 배지 (U1b)"
```

---

### Task 4: RunDialog 3그룹 재구성 + 한국어화 + 막힘 사유 표시

**Files:**
- Modify(Test): `ui/src/components/__tests__/RunDialog.test.tsx`
- Modify: `ui/src/components/RunDialog.tsx`
- Modify: `ui/src/components/CriteriaFields.tsx` (FIELDS label 11종만 — 매핑 표)

**구조 변경 요지** (state·헬퍼·프리셋 로직·buildProfile은 전부 무변경 — JSX 재배치 + 라벨만):

1. `sloOpen`/`pacingOpen`/`advancedOpen` 3개 토글 state → **`advancedOpen` 1개로 통합** (single-level, spec §6.1):
   - 초기값: `useState(() => criteriaHasValue(initCriteria) || initTT != null || initial?.profile.think_seed != null || (initial?.profile.measure_phases ?? false) || (initial?.profile.http_timeout_seconds != null && initial.profile.http_timeout_seconds !== 30) || (hasLoop && initial?.profile.loop_breakdown_cap != null && initial.profile.loop_breakdown_cap !== 256))`
   - 프리셋 load(L175·L180의 `setSloOpen(true)`/`setPacingOpen(true)`)는 `setAdvancedOpen(true)` 한 곳으로 (criteria/think/measure_phases/타임아웃≠30/루프캡≠256 중 하나라도 해당 시).
   - 접힘 힌트 카운트: `sloActiveCount + pacingActiveCount + (measurePhases ? 1 : 0)` (타임아웃·캡은 항상 값이 있는 기본 입력이라 카운트 제외 — 주석으로 명시).
2. JSX 새 순서 (root div 안):

```
h3 {ko.runDialog.title}
드리프트 경고 (무변경)
프리셋 불러오기 / 프리셋 에러 (무변경)
<fieldset> legend "부하 정의"            ← 항상 펼침, 토글 없음
  <LoadModelFields …/>                    (Task 2 결과물)
</fieldset>
<fieldset> legend "대상 설정"            ← 항상 펼침
  <EnvironmentPicker …/>                  (props 무변경)
  {scenario && <DataBindingPanel …/>}     (props 무변경 — onValidityChange만 아래 3번)
</fieldset>
<fieldset> legend = 토글 버튼 "{open?▾:▸} 판정·고급 (선택)" + "· N개 설정됨" 힌트
  {advancedOpen && (
    <h4>{ko.runDialog.sectionSlo}<HelpTip label="SLO 설명">{ko.glossary.slo}</HelpTip></h4>
    <CriteriaFields value={criteriaState} onChange={setCriteria} />
    {loadModel === "closed" && (
      <h4>{ko.runDialog.sectionPacing}<HelpTip label="think time 설명">{ko.glossary.thinkTime}</HelpTip></h4>
      …기존 think 3입력+에러/힌트 블록 그대로(라벨만 매핑 표)…
    )}
    <h4>{ko.runDialog.sectionDiag}</h4>
    …HTTP 타임아웃 입력(기존 L450–466, 라벨만 교체)…
    {hasLoop && …루프 집계 상한 입력(기존 L468–488, 라벨만 교체)…}
    …타임아웃/캡 에러 p 2개(문구는 ko.validation.httpTimeout / 기존 한국어 유지)…
    …measure_phases 체크박스(문구 무변경)…
  )}
</fieldset>
프리셋 저장 행 (무변경)
mutation 에러 (무변경)
막힘 사유 블록 (신규, 아래 4번)
실행/취소 버튼 행 (라벨만 ko.runDialog.run/running/cancel)
```

3. `bindingValid` state를 `const [bindingBlock, setBindingBlock] = useState<{ ok: boolean; reasons: string[] }>({ ok: true, reasons: [] });`로 교체 — `onValidityChange={(ok, reasons) => setBindingBlock({ ok, reasons })}`. `canSubmit`의 `bindingValid` 3곳 → `bindingBlock.ok` (불리언 의미 무변경 = payload·게이트 동작 무변경).
4. 막힘 사유 블록 (실행 버튼 위):

```tsx
      {!bindingBlock.ok && bindingBlock.reasons.length > 0 && (
        <div role="status" className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800">
          <p className="font-medium">{ko.runDialog.blockedReasonsIntro}</p>
          <ul className="list-disc pl-5">
            {bindingBlock.reasons.map((r) => (
              <li key={r}>{ko.runDialog.bindingReasonPrefix + r}</li>
            ))}
          </ul>
        </div>
      )}
```

   (다른 invalid — 범위·think — 는 기존 인라인 에러가 이미 가시적이므로 이 블록은 바인딩 사유 전용. spec §6.4의 예시 문구와 합치.)
5. `CriteriaFields.tsx`: FIELDS 11종 label만 매핑 표대로 교체(구조·props·min/max/step 무변경).
6. **금지**: state 초기화 식·`loadPreset`·`buildProfile`·`currentInput`·프리셋 CRUD·`canSubmit`의 불리언 구조(이름 교체 제외)·`env` 계산·`setCriteria` cross-field — 전부 무변경.

- [ ] **Step 1: RunDialog.test.tsx 갱신** — 매핑 표의 나머지(Task 2에서 안 한 것): `/^Run$/`→`/^실행$/`(전 테스트), `/HTTP timeout/i`→`/HTTP 타임아웃/`(L309,L1063,L1065,L1067,L1076,L1103), `/loop breakdown cap/i`→`/루프 집계 상한/`(L187,L214,L234,L308), think 3종(L677–679,L732–744), criteria 라벨(L566–567,L586–590,L623–624,L1142–1144,L1170–1172), 에러 L1082→`/HTTP 타임아웃은 1 ~ 600초 사이/`, 토글: `getByRole("button",{name:/SLO 기준/})`(L565,L585,L596,L619,L1141,L1169)→`/판정·고급/`, `/Pacing/`(L676,L730)→`/판정·고급/`. **disclosure 테스트 재작성 2개**: L593(기본 접힘+토글 펼침)은 `/판정·고급/` 버튼 + `/최대 p95/` 부재→존재 + **타임아웃 입력도 접힘 시 부재**(`queryByLabelText(/HTTP 타임아웃/)` null) 단언으로 확장; L604(seed 자동 펼침)는 동일 구조에 `/판정·고급/` aria-expanded="true". **타임아웃·캡이 접힘으로 들어갔으므로 그 입력을 만지는 모든 테스트(L187,L214,L1076,L1103,L1063-구간,L309)는 먼저 `await user.click(screen.getByRole("button",{name:/판정·고급/}))`로 펼친다**(ui/CLAUDE.md collapsible 함정 — 접힌 입력은 DOM에 없음). 마지막으로 **payload 기본값 불변식 테스트 1개 추가**:

```tsx
  it("payload byte-identical: 기본값 제출 payload가 재구성 전과 동일하다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /^실행$/ }));
    const body = JSON.parse(lastRunPost().body as string);
    expect(body).toEqual({
      scenario_id: "S1",
      profile: {
        vus: 2,
        duration_seconds: 5,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
      },
      env: {},
    });
  });
```

  (`lastRunPost()`는 파일 내 기존 payload 캡처 패턴(L94–101 동형)을 헬퍼로 추출하거나 동일 인라인 패턴 사용. **이 `toEqual`은 깊은 완전 일치** — 재구성이 필드를 추가/누락하면 즉시 RED. 기대 객체는 RED 단계에서 현 master의 실제 payload를 캡처해 확정할 것 — buildProfile이 undefined 필드를 생략하므로 JSON.stringify 결과 기준.)

- [ ] **Step 2: RED 확인** — Run: `cd ui && pnpm test RunDialog` / Expected: 갱신·신규 테스트 다수 FAIL(구 구조 렌더 중)

- [ ] **Step 3: 구현** — 위 구조 변경 요지 1–6 적용.

- [ ] **Step 4: GREEN** — Run: `cd ui && pnpm test RunDialog` / Expected: 54 PASS (53 + 불변식 1)

- [ ] **Step 5: 커밋**

```bash
git add ui/src/components/RunDialog.tsx ui/src/components/CriteriaFields.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): RunDialog 3그룹 재구성(부하 정의/대상 설정/판정·고급) + 한국어화 + 막힘 사유 (U1b)"
```

---

### Task 5: ScheduleForm 정리 (고유 문구 한국어화 + reasons 소비)

**Files:**
- Modify(Test): `ui/src/components/__tests__/ScheduleForm.test.tsx`
- Modify: `ui/src/components/ScheduleForm.tsx`

**범위**: ScheduleForm 구조는 유지(전면 재편 없음 — spec §6.7은 공유 컴포넌트 수혜 + 고유 문구 정리만). 변경: ① 자체 소유 영어 라벨 2종 — `HTTP timeout (s)`(L296/301)→`ko.loadModel.httpTimeout`, `Loop breakdown cap`(L314/319)→`ko.loadModel.loopCap` ② reasons 소비 — `bindingValid`→`bindingBlock` 패턴(Task 4와 동일)으로 교체하고 저장 버튼 위에 동일한 막힘 사유 블록 ③ SLO fieldset 토글 텍스트는 RunDialog와 달리 유지(`SLO 기준 (선택)` — ScheduleForm은 그룹 재편 없음).

- [ ] **Step 1: 테스트** — ScheduleForm.test.tsx 기존 3개는 셀렉터가 전부 한국어(`/이름/`·`/시나리오/`·`/저장/`·`/활성화/`)라 무수정 통과 예상 — 확인만. 신규 1개 추가:

```tsx
  it("바인딩 사유가 있으면 저장 버튼 위에 막힘 사유가 보인다", async () => {
    // 기존 첫 테스트의 setup을 재사용하되 DataBindingPanel이 reasons를 emit하는
    // 시나리오(미커버 {{var}} 포함 YAML + 데이터셋 선택)로 구성.
    // DataBindingPanel 단위 테스트가 이미 emit을 검증하므로, 여기선 폼이
    // reasons를 렌더하는지만 — onValidityChange를 직접 트리거하기 어려우면
    // 시나리오 fixture에 {{user}}를 넣고 fetch stub에 데이터셋 1개를 추가해
    // 실제 경로로 유도한다.
    expect(await screen.findByText(/실행하려면 다음을 해결하세요|데이터 바인딩/)).toBeInTheDocument();
  });
```

  (이 테스트의 fixture 구성이 기존 stub(L16–21 `{scenarios:[]}`)과 안 맞으면 — 시나리오 select가 비어 바인딩 경로 유도 불가 — **테스트를 RunDialog 쪽 막힘 사유 테스트로 대체**하고 ScheduleForm은 코드 경로 공유(동일 블록 JSX)만으로 충분하다고 판단해 신규 테스트 생략 가능. implementer가 RED 단계에서 판단해 보고할 것.)

- [ ] **Step 2: RED → 구현 → GREEN** — Run: `cd ui && pnpm test ScheduleForm` / Expected: 전체 PASS

- [ ] **Step 3: 커밋**

```bash
git add ui/src/components/ScheduleForm.tsx ui/src/components/__tests__/ScheduleForm.test.tsx
git commit -m "feat(ui): ScheduleForm 고유 라벨 한국어화 + 바인딩 막힘 사유 (U1b)"
```

---

### Task 6: 전체 게이트

- [ ] **Step 1**: Run: `cd ui && pnpm lint && pnpm test && pnpm build` / Expected: lint 0 경고 · 전체 스위트 PASS(스냅샷: U1a 종료 시 594 + 신규 ~8) · tsc-b+vite 클린
- [ ] **Step 2**: 실패 시 별도 fix 커밋(amend 금지) 후 재실행.

---

### 머지 전 체크리스트 (orchestrator)

- [ ] **라이브 Playwright run 1회 필수** (S-D 규칙 — 이 슬라이스는 payload 경로를 직접 건드림): 워크트리 자체 바이너리(`cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`, `just ui-build` 후 `./target/debug/controller --db /tmp/u1b.db --ui-dir ui/dist`)로 ① closed 기본값 run(2 VU·5s — chips '보통' 클릭 후 50·60으로 변하는지 확인하고 직접 입력으로 되돌려 제출) ② open-fixed run(목표 RPS 100) ③ 판정·고급 펼쳐 SLO p95 입력 run — 3개 전부 completed + 리포트 + **콘솔 Zod 에러 0**. 막힘 사유: `{{var}}` 시나리오에서 바인딩 미완 시 사유 표시 확인.
- [ ] HelpTip 동작: VU ⓘ·closed-loop 라디오 ⓘ 클릭(인라인 `browser_evaluate`, filename 저장 금지) + `.playwright-mcp/` 잔류물 rm.
- [ ] 최종 handicap-reviewer (U1b 전체 diff, payload byte-identical·매핑 표 준수·EnvironmentPicker/DataBindingPanel 불변 문자열 확인).
- [ ] master ff-merge → `ExitWorktree(remove, discard_changes: true)` → build-log/roadmap §A8/상태줄 docs 커밋 → 메모리 갱신.
