# 저장 안 됨 이탈 가드 — 에디터 dirty 상태에서 페이지 이동 시 확인 다이얼로그 (UX 갭 수정)

- **날짜**: 2026-07-12
- **상태**: 설계 승인(사용자 2026-07-12) → plan 대기
- **출처**: 사용자 요청 — "저장되지 않은 변경이 있는 상태에서 다른 곳을 눌렀을 때, 저장할지 물어보지 않고 페이지를 이동해서 데이터가 날아가버리는 문제". 긴 YAML 편집 세션이 무경고 유실되는 실사용 데이터-손실 버그라 지금 한다.
- **연관**: 시나리오 복제 dirty 확인 다이얼로그(`docs/superpowers/specs/2026-06-06-scenario-clone-design.md` — 3버튼 패턴 선례), scenario-clone-error-fixes(모달 backdrop이 Callout 가림 함정), ADR-0035(ko.ts 카탈로그), ADR-0043(디자인 시스템 Modal).
- **ADR**: 신규 불필요 — UI-only additive. react-router 내장 `useBlocker` + 기존 `Modal` 재사용으로 아키텍처 결정 없음(중앙 가드 레지스트리 기각은 §3-4에 근거 기록).

---

## 1. 문제와 목표

에디터 두 페이지(`ScenarioNewPage`, `ScenarioEditPage`)는 `dirty`(yamlText ≠ originalYaml)를 이미 계산하지만 라우터 이동을 막는 장치가 전혀 없다. 상단 네비 링크 7개·브랜드 타이틀 링크·브레드크럼·편집 페이지 "실행 목록" 버튼·브라우저 뒤로가기 전부 무경고 이동으로 편집 내용이 유실된다(부분 가드는 신규 페이지 "취소" `window.confirm`과 편집 페이지 "복제" 모달 둘뿐). 이 슬라이스는 dirty 상태의 **모든 라우터 이동**에 확인 다이얼로그를, **탭 닫기/새로고침**에 브라우저 기본 확인창을 보장한다.

- **목표**: 에디터 2페이지에서 저장 안 된 변경이 사용자 확인 없이 사라지는 경로를 0으로.
- **비목표(연기)**: §7 참조. HAR 가져오기 위저드·기타 폼 페이지 가드, Tauri 네이티브 창 닫기 가드, 중앙 가드 레지스트리.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법: 테스트명 또는 관찰) | seam? |
|---|---|---|---|
| R1 | MUST — 에디터 2페이지에서 dirty 상태의 라우터 이동 시도(네비 링크·브레드크럼·페이지 내 `Link`·`navigate`·브라우저 뒤로/앞으로)를 차단하고 확인 다이얼로그를 띄운다 — 차단 기준은 **pathname 변경**(search/hash-only 이동은 통과 — 두 페이지에 그런 이동은 현재 존재하지 않음, implementer는 이 기준을 임의로 '고치지' 말 것) | 페이지 RTL: dirty 후 링크 클릭 → 다이얼로그 노출·라우트 미전환 / 라이브: 헤더 링크·뒤로가기 실측 | |
| R2 | MUST — 편집 페이지 다이얼로그는 3버튼: [취소]=잔류, [저장 안 하고 이동]=즉시 이동, [저장 후 이동]=저장 성공 시 이동(primary=저장 후 이동) | RTL: 버튼 3개·각 동작(라우트 전환/미전환·mutateAsync 호출) 단언 | |
| R3 | MUST — 신규 페이지 다이얼로그는 2버튼: [계속 편집]=잔류, [버리고 이동]=즉시 이동(primary=계속 편집) | RTL: 버튼 2개·각 동작 단언 | |
| R4 | MUST — dirty가 아니면 모든 이동이 기존과 동일하게 무프롬프트(byte-identical 동작) | RTL: clean 상태 링크 클릭 → 즉시 전환·다이얼로그 부재 | |
| R5 | MUST — 의도된 프로그램적 이동은 dirty여도 무프롬프트: 신규 "생성" 성공 후 navigate, 편집 `cloneAndGo`의 navigate(복제 플로우는 자체 다이얼로그가 이미 확인) | RTL: 생성 성공/복제 확정 후 다이얼로그 없이 라우트 전환 | |
| R6 | MUST — [저장 후 이동]의 저장 실패 시 이동하지 않고 다이얼로그를 닫으며(잔류) 기존 `update.error` Callout이 보인다 | RTL: mutate reject → 라우트 미전환·다이얼로그 닫힘·Callout 노출 | |
| R7 | MUST — dirty일 때만 `beforeunload` 리스너가 등록되어 탭 닫기/새로고침에 브라우저 기본 확인창이 뜬다(clean/unmount 시 해제) | 훅 테스트: dispatchEvent(beforeunload)의 defaultPrevented가 dirty에서만 true / 라이브: reload 시 dialog | |
| R8 | MUST — 신규 페이지 "취소" 버튼의 `window.confirm`을 제거하고 가드 모달로 일원화(dirty면 모달, clean이면 즉시 이동) | RTL: 취소 클릭 → window.confirm 미호출·모달 노출 / `grep window.confirm ScenarioNewPage.tsx` = 0(다른 confirm 소비처 실측 10곳 — 에디터 트리 내부의 `InsertTemplateModal`·`YamlFileActions` 포함 — 은 범위 밖·무변경) | |
| R9 | MUST — 다이얼로그 제목·본문·버튼 라벨·aria 라벨 전부 `ko.ts` 카탈로그 경유(ADR-0035, 하드코딩 한글/영어 금지) | 신규 문자열 grep: 컴포넌트 내 한글 리터럴 0 | |
| R10 | MUST — 신규 페이지 갤러리 단계(`seedYaml === null`)에서는 가드 비활성(잃을 편집 없음) | RTL: 갤러리 단계에서 이동 → 무프롬프트 | |
| R11 | MUST — `crates/`·proto·migration·`ui/src/api/`·deploy 0-diff(UI-only 슬라이스) | `git diff --stat master` 검사 | |
| R12 | MUST — 에디터 2페이지를 렌더하는 기존 테스트 파일의 render 하니스를 `<MemoryRouter>` → `createMemoryRouter`+`<RouterProvider>`로 이주하되 케이스 로직·단언은 불변, 전부 green 유지 | `pnpm test` 전체 green(이주 커밋 단독으로도 green) | |
| R13 | MUST — [저장 후 이동] 진행 중(`saving`)엔 다이얼로그의 **모든 dismiss 경로가 봉쇄**된다: 버튼 3개 전부([취소] 포함) disable + ESC/backdrop/✕ 닫기 no-op — in-flight 저장 완료 후 stale `blocker.proceed()/reset()` 레이스를 구조적으로 차단(§3-8) | RTL: pending 중 버튼 3개 disabled + ESC 눌러도 다이얼로그 유지·`reset` 미호출 단언 | |
| R14 | MUST — 다이얼로그 ESC/backdrop 닫기 = 잔류(`reset()`), 절대 이동 아님 | RTL: ESC → 라우트 미전환·다이얼로그 닫힘 | |

---

## 3. 핵심 통찰 (설계 근거)

1. **`useBlocker`가 유일한 완결 경로** — 이 앱은 `createBrowserRouter`(data router, `routes.tsx`)라 react-router-dom `^6.27`(설치본 6.30.3)의 `useBlocker`를 그대로 쓸 수 있고, 이것만이 네비 링크·`navigate()`·브라우저 뒤로/앞으로를 전부 한 지점에서 잡는다(R1). 링크마다 onClick 가드를 붙이는 대안은 뒤로가기를 못 잡고 누락 지점이 생겨 기각.
2. **테스트 하니스 이주가 선행 비용** — `useBlocker`는 data router 밖에서 throw하는데 기존 페이지 테스트 전부가 plain `<MemoryRouter>` 하니스다. 에디터 2페이지를 렌더하는 테스트 파일 **정확히 9개**(ScenarioEditPage.{dirty,name,save,clone,chrome,testrun} + ScenarioNewPage.{gallery,import,testrun})의 render 헬퍼를 `createMemoryRouter`로 이주해야 한다(R12). `ScenarioNewPage.test.ts`·`ScenarioPages.test.tsx`는 렌더 없는 순수 로직 테스트라 제외(실측 확인). 이주는 `useBlocker` 도입 *전*에도 동작하므로 독립 green 커밋으로 선행 가능. StrictMode 래핑(dirty/name 테스트 선례)은 유지.
3. **`window.confirm`은 2버튼 고정이라 요구를 못 채운다** — 편집 페이지 [저장 후 이동](R2)은 "이동을 멈춰놓고 → 비동기 저장 → 성공 시 진행"이 필요해 `blocker.proceed()/reset()` 상태기계 + 커스텀 `Modal`이 필수. 복제 다이얼로그(3버튼 Modal)와 시각 패턴도 일치.
4. **중앙 가드 레지스트리(전역 store + Layout 모달) 기각** — 가드 *메커니즘*은 공유 훅으로 이미 중앙화되고, 다이얼로그는 페이지마다 다르며(3버튼+저장 콜백 vs 2버튼) 저장 액션이 페이지 소유(mutation·version)라 레지스트리도 결국 콜백 등록 API가 필요 — 간접층만 늘고 실익이 없다(사용자 논의로 기각, 2026-07-12). 미래에 가드 페이지가 늘면 훅+공유 다이얼로그를 레지스트리로 감싸는 리팩터가 쉽다.
5. **one-shot `bypassNext()`가 이중 프롬프트를 막는 명시 장치 — 소비는 dirty 검사보다 반드시 먼저(무조건)** — 생성 성공 직후·복제 확정 직후의 navigate는 dirty가 아직 true인 시점에 일어난다(setState 비동기 타이밍에 의존해 dirty 해소를 기다리는 설계는 취약). 의도된 이동 직전에 `bypassNext()`를 호출하고 `shouldBlock`이 플래그를 1회 소비한다(R5). **소비 순서가 correctness**: 술어를 `dirty && !consume() && …`로 쓰면 short-circuit 때문에 clean 이동에서 플래그가 소비되지 않고 잔존한다 — `cloneAndGo`는 non-dirty 경로에서도 `bypassNext()`를 arm하고, 복제의 `/scenarios/A`→`/scenarios/B`는 param-only 이동이라 컴포넌트·ref가 마운트 유지되므로, 잔존 플래그가 *나중의 dirty 이동*을 조용히 통과시킨다(이 슬라이스가 잡으려는 바로 그 유실). 따라서 `shouldBlock` 첫 단계에서 **무조건 소비**: `if (consume()) return false; return dirty && pathname차이;` — arm은 항상 navigate 직전이므로 그 navigate가 반드시 플래그를 태운다(§4.2에 명문). one-shot 소비 후엔 기존 `seededId` effect가 리시드하며 dirty가 자연 해소된다.
6. **저장 실패 시 모달을 닫는다(R6)** — `Modal`은 풀스크린 backdrop이라 열린 채로는 페이지-레벨 `update.error` Callout이 가려진다(scenario-clone-error-fixes에서 확립된 함정). 복제의 "저장 실패 → 저장본으로 복제?" 2차 모달 같은 분기는 이탈 가드에선 불필요 — 잔류가 안전한 기본이고 사용자는 Callout을 보고 수정/재시도한다.
7. **라우터당 blocker 1개 제약** — react-router는 동시 blocker를 1개만 지원한다. 가드 페이지 둘은 상호배타 leaf 라우트라 충돌 없음(`scenarios/new` 정적 세그먼트가 `scenarios/:id`보다 우선 매치). 훅 docstring에 제약을 명문화해 미래 오용(동시 마운트되는 컴포넌트에서 호출)을 막는다.
8. **in-flight 저장 중 dismiss 봉쇄가 stale-proceed 레이스의 유일한 견고한 해법(R13)** — `Modal`은 ESC(capture keydown)·backdrop·✕를 전부 `onClose`로 배선하므로, `update.mutateAsync` 대기 중 사용자가 ESC를 누르면 `blocker.reset()`으로 unblock된 뒤 저장 성공 콜백이 **이미 unblocked인(또는 stale 캡처된) blocker**에 `proceed()`를 호출하는 레이스가 생긴다(react-router는 unblocked 상태에서 `proceed: undefined`). 사후 `blocker.state === "blocked"` 가드는 클로저가 stale blocker 객체를 캡처하는 문제를 완전히 못 막는다 — 레이스를 소스에서 제거: `saving`인 동안 다이얼로그의 모든 dismiss 경로(버튼 3개·ESC·backdrop·✕)를 no-op으로. 저장은 짧고(단건 PUT) 실패 시 스스로 닫히므로(R6) UX 비용은 미미하다.

---

## 4. 변경 상세

### 4.1 `ui/src/i18n/ko.ts` — 충족 R: R9
`ko.editor`에 신규 키: 다이얼로그 제목(`unsavedTitle`)·편집용 본문(`unsavedBodyEdit`)·버튼 5종(`leaveCancel` 취소·`leaveDiscard` 저장 안 하고 이동·`leaveSave` 저장 후 이동·`stayEditing` 계속 편집·`discardAndLeave` 버리고 이동). **신규용 본문은 기존 `discardConfirm`("저장하지 않은 변경을 버릴까요?")을 재사용**(확정) — R8이 그 키의 유일 소비처(`window.confirm`)를 제거하므로 재사용하지 않으면 dead key가 된다(lint 미적발). 정확한 자구는 plan에서 확정.

### 4.2 `ui/src/hooks/useUnsavedGuard.ts` (신규) — 충족 R: R1, R4, R5, R7
```ts
function useUnsavedGuard(dirty: boolean): { blocker: Blocker; bypassNext: () => void }
```
- `useBlocker(({ currentLocation, nextLocation }) => ...)` 함수형 — **소비 순서 normative(§3-5)**:
  ```ts
  if (consumeBypass()) return false; // 무조건 먼저 소비 — dirty 검사 뒤에 두면 clean 이동에서 플래그 잔존(silent bypass)
  return dirtyRef.current && currentLocation.pathname !== nextLocation.pathname;
  ```
  `dirtyRef`는 매 렌더 갱신(스테일 클로저 회피). bypass는 one-shot ref(소비 시 리셋).
- `beforeunload` effect: `dirty`일 때만 `window.addEventListener("beforeunload", h)`(핸들러는 `e.preventDefault()` + legacy `e.returnValue = ""`), clean/unmount 시 해제(R7).
- docstring에 "라우터당 blocker 1개 — 동시 마운트되는 컴포넌트에서 호출 금지" 명문화(§3-7).

### 4.3 `ui/src/components/UnsavedChangesDialog.tsx` (신규) — 충족 R: R2, R3, R13, R14
Props: `open`, `onStay`, `onDiscard`, `onSave?`, `saving?`. 기존 `Modal` 래핑, `Modal.onClose`는 `saving`이 아닐 때만 `onStay`(saving 중엔 no-op — ESC/backdrop/✕ 봉쇄, R13·§3-8), 평시엔 `onStay`(R14). `onSave` 있으면 3버튼([취소]=secondary·[저장 안 하고 이동]=secondary·[저장 후 이동]=primary), 없으면 2버튼([계속 편집]=primary·[버리고 이동]=secondary). `saving`이면 버튼 3개 전부 disable(R13). 문구는 전부 ko 키(R9), 본문은 prop으로 받아 페이지별 카피 허용.

### 4.4 `ui/src/pages/ScenarioEditPage.tsx` — 충족 R: R1, R2, R5, R6, R13
- `const { blocker, bypassNext } = useUnsavedGuard(dirty)` — **주의: 현재 `dirty` 계산(line ~69)은 로딩/에러 early-return *뒤*에 있다. 훅 호출은 조건부일 수 없으므로(Rules of Hooks) `dirty` 계산과 훅 호출을 early-return 앞으로 호이스팅**(state 두 개 비교라 자명하게 안전).
- `<UnsavedChangesDialog open={blocker.state === "blocked"} saving={update.isPending} onStay={() => blocker.reset()} onDiscard={() => blocker.proceed()} onSave={saveThenLeave} />`.
- `saveThenLeave`: `loadedVersion !== null` 가드 → `update.mutateAsync({yaml: yamlText, version: loadedVersion})` → 성공 시 `setLoadedVersion`/`setOriginalYaml` 갱신 후 `blocker.proceed()` / 실패 시 `blocker.reset()`(모달 닫힘 → `update.error` Callout 노출, R6).
- `cloneAndGo`: `navigate(...)` 직전에 `bypassNext()` 한 줄 추가(R5) — 복제 다이얼로그 자체는 무변경.

### 4.5 `ui/src/pages/ScenarioNewPage.tsx` — 충족 R: R1, R3, R5, R8, R10
- `const { blocker, bypassNext } = useUnsavedGuard(dirty)` — 갤러리 단계는 `yamlText === originalYaml === ""`이라 dirty=false로 자연 비활성(R10).
- `cancel`: `window.confirm` 제거, 단순 `navigate("/")`(가드가 모달로 물음, R8).
- 생성 `onSuccess`: `bypassNext()` 후 `navigate(...)`(R5).
- `<UnsavedChangesDialog>` 2버튼(onSave 미전달).

### 4.6 기존 테스트 하니스 이주 — 충족 R: R12
에디터 2페이지를 렌더하는 테스트 파일 9개(§3-2 목록)의 render 헬퍼에서 `<MemoryRouter initialEntries><Routes>…` → `createMemoryRouter(routes, { initialEntries })`+`<RouterProvider router>`로 교체. 케이스 로직·단언 불변. 렌더 없는 로직 테스트 2개와 다른 페이지 테스트(에디터 미렌더)는 건드리지 않는다. (참고: react-router 6.30은 `createMemoryRouter` 생성마다 v7 future-flag `console.warn`을 찍는다 — 테스트 실패 요인은 아니나 출력 노이즈 증가 예상, 억제 시도로 케이스를 바꾸지 말 것.)

---

## 5. 무변경 / 불변식 (명시)

- `crates/`·proto·migration·`deploy/`·`ui/src/api/` **0-diff** — 네트워크 페이로드·와이어 변화 없음(R11).
- **clean 상태의 모든 내비게이션 동작 byte-identical**(R4) — 가드는 dirty에서만 관측 가능.
- 복제 확인 다이얼로그(3버튼)·저장 실패 2차 모달·`saveThenClone` 로직 무변경 — `cloneAndGo`에 `bypassNext()` 1줄만.
- `dirty` 계산식(`yamlText !== originalYaml`)·시드 로직(`seededId`/`chooseTemplate`) 무변경.
- `EditorShell`·Zustand store·`ScenarioModel`·YAML sync 무변경.
- 저장 버튼(헤더)의 동작·disabled 조건 무변경.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | 페이지 RTL(dirty 후 Link 클릭 → 다이얼로그·라우트 미전환) + 라이브 헤더 링크·뒤로가기 | ✅ |
| R2, R3 | `UnsavedChangesDialog` 단위(버튼 수·라벨) + 페이지 RTL(각 버튼 동작) | |
| R4 | clean 상태 즉시 전환 RTL | |
| R5 | 생성 성공·복제 확정 후 무프롬프트 전환 RTL | |
| R6 | mutate reject → 잔류·다이얼로그 닫힘·Callout RTL | |
| R7 | 훅 테스트(dispatchEvent defaultPrevented — jsdom에선 `new Event("beforeunload", { cancelable: true })` 필수, 기본 cancelable:false면 preventDefault가 no-op) + 라이브 reload dialog | ✅ |
| R8 | window.confirm spy 미호출 + grep 0 | |
| R9 | 신규 컴포넌트 내 한글 리터럴 grep 0(`'"[^"]*[가-힣]'` 패턴) | |
| R10 | 갤러리 단계 무프롬프트 RTL | |
| R11 | `git diff --stat master`로 diff 범위 검사 | |
| R12 | 이주 커밋 단독 `pnpm test` 전체 green | |
| R13, R14 | 다이얼로그 단위 RTL(pending disable·ESC 잔류) | |

- **라이브 검증**: run-생성/리포트/엔진 경로는 0-diff지만, 모달·라우팅·beforeunload는 jsdom 신뢰 천장이 낮다(모달은 DOM-존재만으로 PASS 금지 — 사용자 피드백) → `/live-verify` 스택 없이 vite dev + Playwright로: ① dirty 후 헤더 링크 클릭 → 모달 실측(스크린샷/`getBoundingClientRect`) ② [저장 후 이동] → 저장 반영+이동 확인 ③ [저장 안 하고 이동]·[취소] ④ 브라우저 뒤로가기 차단 ⑤ reload 시 beforeunload dialog(Playwright — **`page.on("dialog", d => d.accept())`를 reload *전에* 선등록**, 미등록 시 auto-dismiss=잔류로 hang/timeout) ⑥ 신규 페이지 취소 → 2버튼 모달.

---

## 7. 의도적 연기 (roadmap에 누적)

- **HAR 가져오기 위저드(`ScenarioImportPage`) 가드**: 위저드 로컬 상태(파일 파싱·호스트 매핑)의 dirty 정의가 별도 설계 필요 — 에디터와 유실 규모가 다르고 범위 확정(사용자, 2026-07-12)에서 제외.
- **기타 폼 페이지(환경·스케줄·템플릿 등) 가드**: 소규모 입력이라 유실 피해 작음. 필요해지면 이 슬라이스의 훅+다이얼로그 재사용으로 페이지당 ~2줄.
- **Tauri 데스크톱 네이티브 창 닫기 가드**: wry는 창 닫기에 `beforeunload`를 발화/존중하지 않음 — `onCloseRequested` 핸들링은 `desktop/` 워크스페이스 별도 슬라이스.
- **중앙 가드 레지스트리**: 가드 페이지가 5–6개로 늘면 훅+다이얼로그를 감싸는 리팩터로(§3-4).

---

## 8. 구현 순서 (plan 입력)

UI-only라 cargo 게이트는 fast-path. 각 task 독립 green 커밋:

1. **테스트 하니스 이주**(R12) — `createMemoryRouter` 전환만, 프로덕션 0-diff, 단독 green. `useBlocker` 도입의 전제.
2. **ko 키 + `UnsavedChangesDialog`**(R9, R2/R3 표면, R13, R14) — 컴포넌트 단위 테스트와 함께.
3. **`useUnsavedGuard` 훅**(R1 메커니즘, R4, R5, R7) — createMemoryRouter 하니스 훅 테스트와 함께.
4. **`ScenarioNewPage` 배선**(R1, R3, R5, R8, R10) — window.confirm 제거 포함.
5. **`ScenarioEditPage` 배선**(R1, R2, R5, R6, R13) — saveThenLeave·cloneAndGo bypass.
6. **전체 게이트**(`pnpm lint && pnpm test && pnpm build`) + **라이브 검증**(§6) — R11 diff 범위 확인.
