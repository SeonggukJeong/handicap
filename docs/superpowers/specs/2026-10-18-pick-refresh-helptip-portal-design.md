# 선택 배열 팝업 "요청마다 새로 뽑기" + HelpTip 클립 해소 — 설계

- 날짜: 2026-10-18 · 워크트리 `worktree-pick-random-tooltip` · 유형: user-path + correctness-bug(UI 클립)
- 선행: pick-array(`2026-10-17-pick-array-design.md`), genvar-per-request(`2026-10-17-genvar-per-request-design.md` §6.3 — "팝업은 refresh를 편집하지 않는다"를 이 spec이 대체)
- 범위 밖(별도 엔진 슬라이스): open-loop 곡선 저레이트 램프 무부하 버그 — 재현·원인만 이 슬라이스에서 roadmap §B34로 기록(§6).

## 사용자 스토리 (US)

- **US1**: QA가 선택 배열 팝업에서 값을 편집하다가, 팝업 안에서 바로 "요청마다 새로 뽑기"를 켜고/끈다 — 성공하면 `적용` 후 변수 행에 `요청마다` 배지가 뜨고(끄면 사라지고) YAML에 `refresh: request`가 생긴다(끄면 키가 사라진다). 체크 즉시 팝업의 미리보기 제목이 "요청마다 새로 뽑힘"으로 바뀐다.
- **US2**: QA가 팝업에서 체크박스를 바꿨다가 `취소`하면 원래 설정이 유지된다 — 성공하면 패널 체크박스·YAML이 변경 전과 같다.
- **US3**: QA가 변수 패널을 좁힌 상태에서 "요청마다 새로 뽑기" `?` 도움말을 열어 설명을 끝까지 읽는다 — 성공하면 popover 전체 폭(224px)이 패널 경계에 잘리지 않고 보인다(라이브 `getBoundingClientRect`로 popover rect가 뷰포트 안 + 패널 클립 없음).
- **US4**(회귀 가드): 다른 곳의 HelpTip(실행 다이얼로그·페이싱 현황판 모달·리포트 화면·새 팝업)도 기존처럼 열고 읽고 닫힌다 — 성공하면 모달 위에 popover가 보이고, popover 안을 클릭해도 모달·popover가 닫히지 않으며, 바깥 클릭/ESC로 popover가 닫힌다. **모달 안에서 popover가 열린 채 ESC를 누르면 popover만 닫히고 모달(=편집 중인 draft)은 유지된다.**

## 1. 배경 — 현재 동작 (코드 사실)

- `PickArrayDialog.tsx:174-191`: 팝업이 만드는 spec은 `initial.refresh`를 그대로 싣는다(주석 "팝업은 refresh를 편집하지 않는다 — spec §6.3"). 미리보기 제목(`:444-448`)도 `initial.refresh` 기준.
- `GenVarEditor.tsx`의 `{spec && …}` 블록: 체크박스(`aria-label=ko.editor.genRefreshAria(name)`, 즉시 커밋 `onCommitGen({...spec, refresh})`) + label 밖 형제 `<HelpTip label=ko.editor.genRefreshHelpLabel>`(본문 `ko.glossary.genRefreshIntro`·`genRefreshPriority`).
- `HelpTip.tsx`: 루트 `<span class="relative inline-block">` 안에 popover `<span role="note" class="absolute top-5 z-20 … w-56 left-0|right-0">`. 열기/닫기는 `usePopover`(ESC=document bubble keydown, 바깥 pointerdown=`rootRef.contains`, 우단 edge-flip=`alignRight`).
- 변수 목록 `VariablesPanel.tsx:267` `<ul class="… overflow-auto …">` — `overflow-auto`가 absolute popover를 패널 폭에서 잘라낸다(한 축 auto면 다른 축 visible도 auto로 강등 — `ui/CLAUDE.md` VarUsagePopover 항목과 같은 원인). 변수 aside 자체는 `overflow-visible`이지만 popover는 그 안쪽 `<ul>` 스크롤 박스 안에 있다.
- `Modal.tsx`: body portal, 백드롭 `onClick={onClose}`·패널 `onClick=stopPropagation`(React 트리 버블), **document capture-phase keydown이 ESC에서 `stopPropagation()` 후 닫기** → 모달 안 HelpTip은 ESC가 모달을 닫는다(`usePopover` 주석·`ui/CLAUDE.md` U1a 기록, 미해결 상태).
- `usePopover` 호출처: `HelpTip.tsx`·`VerdictBadge.tsx`(`grep -rln "usePopover(" ui/src | grep -v __tests__` — `DownloadMenu.tsx`는 주석 언급뿐). HelpTip 소비처 **18파일**(import 기준 `grep -rl "import { HelpTip }" ui/src | grep -v __tests__` — `<HelpTip` 텍스트 grep은 `ExtractConfirmRow.tsx` 주석까지 잡아 19로 부풀린다).

### 1.1 클립 재현 / 기대 / 실측 (US3 근거, 2026-10-18 라이브)

- 재현: 1280×900 뷰포트, 에디터 기본(좁은) 변수 패널, `random_int` 변수 행 펼침 → "요청마다 새로 뽑기 도움말" `?` 클릭.
- 기대: 224px popover 전부 가시.
- 실측: 클리퍼 = 변수 목록 `<ul class="… overflow-auto …">`(left 95.5·right 279.5, clientWidth 184). popover left 215.3·right 439.3 → **오른쪽 159.8px(71%) 잘림**, popover 우단 근처 `elementFromPoint`가 popover 아님, `<ul>`에 가로 스크롤 생김(scrollWidth 344 > clientWidth 184). `ui/src/components/scenario/CLAUDE.md`의 "변수 aside는 `overflow-visible`로 224px HelpTip 미클립" 서술은 aside 레벨만 맞고 `<ul>` 레벨에서 틀렸다(§3.4에서 정정).

## 2. 변경 A — 팝업 "요청마다 새로 뽑기" 체크박스 (US1·US2)

- `PickArrayDialog`에 로컬 draft `refreshDraft: PickArraySpec["refresh"]`(초기값 `initial.refresh` 그대로) 추가. 팝업 내 다른 draft와 같이 **`적용` 시에만 커밋, `취소`/ESC/백드롭은 폐기**(기존 onApply 1회 쓰기 계약 유지).
- 값 도메인은 `RefreshModel = z.enum(["iteration","request"])`(`genVars.ts:19`) + 부재. boolean draft는 손으로 쓴 `refresh: iteration`을 잃으므로 **원값을 draft로 보존**한다: 체크박스 `checked = refreshDraft === "request"`, 토글 시 패널 체크박스와 같은 규칙(`checked ? "request" : undefined`). 사용자가 체크박스를 **안 건드리면** `initial.refresh`가 그대로 나간다(`"iteration"` 포함 — 기존 "initial.refresh 보존" 계약 유지).
- spec 조립: `...(refreshDraft !== undefined ? { refresh: refreshDraft } : {})` — 끄면 키 **부재**(genvar-per-request의 "기본=키 없음" byte-identical 규약, 패널 체크박스와 동일).
- 미리보기 제목: `initial.refresh` → `refreshDraft` 기준(체크 즉시 전환, US1).
- 배치: 값 섹션(`pickSectionValues`)과 미리보기 섹션 사이, h3 없는 한 줄 — `[체크박스] 요청마다 새로 뽑기 [?]`. 체크박스는 `<label>`로 텍스트를 감싸 **accname = 가시 텍스트 `ko.editor.genRefreshLabel`**(패널 체크박스 accname `genRefreshAria(name)`=`"<name> 요청마다 새로 뽑기"`와 정확-문자열이 달라 RTL 정확매치 충돌 없음). HelpTip은 label 밖 형제(U3 accname 오염 방지), label·본문은 패널과 같은 `ko.editor.genRefreshHelpLabel`·`ko.glossary.genRefreshIntro/Priority`(새 카피 0 — ADR-0035 단일 소스).
- 패널 체크박스(`GenVarEditor`)는 그대로 유지(사용자 결정 "양쪽 다 유지"). 팝업은 `initial`(=열 때의 커밋값)으로 시드되므로 패널에서 바꾼 뒤 팝업을 열면 그 값이 보인다.
- `disabled`: 팝업은 열려 있는 동안 store 편집 잠금(`yamlError`)과 무관하게 draft만 다룬다(기존 팝업 입력과 동일).
- genvar-per-request spec §6.3(`2026-10-17-genvar-per-request-design.md:120`)의 "팝업은 refresh를 편집하지 않는다" 문장은 이 spec이 대체한다(그 줄 뒤에 대체 포인터 1줄 + `PickArrayDialog.tsx:189` 코드 주석 갱신).
- **구현 순서: 변경 B(HelpTip) 먼저, A 다음** — A가 모달 안에 HelpTip을 새로 넣으므로 B의 ESC 레이어링 없이 A가 먼저 들어가면 popover 열린 채 ESC가 팝업 draft 전체를 날린다.

## 3. 변경 B — HelpTip popover를 portal + fixed로 (US3·US4)

`HelpTip`이 더 이상 `usePopover`를 쓰지 않고 자체 로직을 갖는다(유일한 잔여 호출처 `VerdictBadge`는 무변경).

### 3.1 렌더
- 버튼은 기존 위치·클래스·`aria-label`/`aria-expanded`/`aria-controls` 그대로.
- 버튼에 열림 시 `aria-describedby={id}` 추가(닫힘 시 미부착) — portal로 popover가 DOM상 버튼 바로 뒤가 아니게 되므로(body 끝 또는 다이얼로그 패널 끝) 브라우즈 모드 SR의 읽기 순서 인접성을 잃는다. describedby로 버튼 포커스 시 본문을 설명으로 읽히게 보완(`aria-controls`는 SR 지원이 약함). 버튼 accname은 `aria-label` 그대로라 RTL `getByRole("button",{name})` 불변.
- 열림 시 popover(`role="note"`, `id`, 기존 시각 클래스 `w-56 whitespace-normal rounded-md border … shadow-lg`, `block`)를 **`createPortal(…, container)`** 로 렌더. `container` = **버튼 루트의 `closest('[role="dialog"][aria-modal="true"]')` ?? `document.body`** — **열 때(`toggle`) 1회 계산해 state에 저장**(렌더 중 ref 읽기 금지·StrictMode 안전):
  - 모달 안이면 다이얼로그 패널 안에 붙여 `aria-modal` 범위 안에 남긴다(body에 붙이면 SR이 aria-modal 밖 콘텐츠를 숨겨 popover를 못 읽는다). Modal 패널은 `transform`/`filter`가 없어 그 안의 `position: fixed`는 뷰포트 기준이고 조상 `overflow`(`Modal.tsx` 본문 `overflow-auto`)에 잘리지 않는다 — **이 전제(컨테이너에 transform/filter/contain 없음)를 HelpTip 코드 주석으로 남긴다**. 셀렉터를 `aria-modal=true`로 좁혀 비-모달 `role=dialog`(예: `WorkerDashboardPage.tsx`)는 body로 간다.
  - 패널 안 portal이면 Modal Tab 트랩의 `querySelectorAll`에 popover가 포함되지만 popover는 포커스 가능 요소가 없어(`span`·텍스트) 트랩 순서 불변.
  - 모달 밖이면 body.
- 위치는 inline style `position: fixed; top; left; width: 224px; max-height: calc(100vh - 16px); overflow-y: auto; z-index: 60`(높이 상한이 있어야 뷰포트보다 긴 본문이 화면 밖으로 밀리지 않고 내부 스크롤로 읽힌다)(Modal 백드롭 `z-50` 위 — 모달 밖 popover가 모달과 겹칠 일은 없지만 일관값). arbitrary Tailwind 클래스 대신 inline style(방출 여부 검증 불필요).
- `top`/`left` 산출(순수 함수 `computeTipPos(anchorRect, popH, viewport)`, VarUsagePopover `computePos` 이디엄): 기본 `top = anchor.bottom + 4`, `left = anchor.left`; `left + 224 > vw − 8`이면 `left = anchor.right − 224`(우단 edge-flip — 기존 `alignRight` 의미 보존); `left`를 `[8, vw − 224 − 8]`로 clamp; 아래 공간 부족(`top + popH > vh − 8`)이고 위 공간이 있으면 `top = anchor.top − 4 − popH`, 둘 다 부족하면 `vh − popH − 8`로 clamp(최소 8). 첫 렌더는 높이 미측정 → `useLayoutEffect`에서 실측 높이로 재계산(페인트 전).
- 앵커 = 버튼 루트 span(`rootRef`)의 `getBoundingClientRect()`.

### 3.2 닫힘·이벤트 격리
- 토글: 버튼 클릭(기존).
- 바깥 pointerdown(document capture): target이 루트 span **또는 popover 패널** 안이면 무시, 그 외 닫기. (portal이라 패널이 루트 밖 DOM — 패널 contains 검사가 없으면 popover 안 클릭이 닫아버린다.)
- **ESC**: `window` **capture-phase** keydown에서 열림 상태면 `stopPropagation()` + 닫기. window capture는 Modal의 document capture보다 먼저 실행되므로 **모달 안에서 popover가 열려 있으면 ESC가 popover만 닫는다**(모달 유지 — US4). popover가 닫혀 있으면 리스너가 없어(open일 때만 구독) Modal ESC 동작 불변.
- 스크롤: `window` capture `scroll`에서 target이 popover 패널 안이 아니면 닫기(`e.target instanceof Node` 가드 — target이 `window`/`document`일 때 `contains` TypeError 방지)(fixed는 열 때 좌표라 조상 스크롤 시 어긋남 — VarUsagePopover 동일 정책). `resize`도 닫기.
- React 트리 격리: popover 패널에 `onClick`·`onMouseDown`·`onPointerDown` `stopPropagation`(portal 이벤트는 React 트리로 버블하므로, HelpTip을 감싼 조상의 React 핸들러 — 예: 클릭으로 펼치는 행/라벨 래퍼 — 가 popover 내부 클릭에 반응하지 않게). Modal 백드롭은 패널의 기존 `stopPropagation`으로 이미 보호되지만 이 격리로 이중 보장.
- 리스너 effect dep는 `[open]`만(콜백은 ref/setter만 참조 — exhaustive-deps 경고 없음).

### 3.3 불변
- 공개 props(`label`, `children`) 무변경 → 18개 소비처 코드 0-diff(import 기준 grep).
- `role="note"`·`aria-controls` 연결·키보드(Tab→Enter) 열기·클릭 토글·바깥 클릭/ESC 닫기 의미 유지. 기존 RTL은 전부 `screen.*`(문서 전역) 쿼리라 portal 이동에 영향 없음(`grep -rn '"note"' ui/src` 결과 `within(…)` 스코프 쿼리 0 — plan 작성 시 재실행).
- `HelpTip.test.tsx`의 `left-0`/`right-0` 클래스 단언 2개는 위치 방식이 inline style로 바뀌므로 `computeTipPos` 단위 테스트 + style 단언으로 교체.

### 3.4 함께 정정할 문서·주석 (portal·ESC 레이어링으로 거짓이 되는 서술)

- `ui/src/components/usePopover.ts:3-8` 주석 — 소비처에서 HelpTip 제거, U1a "현 소비처는 전부 Modal 밖"(이미 ThinkTimeBoard로 거짓) 정정: VerdictBadge만 해당.
- `ui/CLAUDE.md` `<HelpTip>` 항목("Modal 안에서 ESC 레이어링이 안 된다"·"`right-0` edge-flip") → portal+fixed·window-capture ESC로 갱신.
- `ui/src/components/scenario/CLAUDE.md:12` "변수 aside는 `overflow-visible`로 224px HelpTip 미클립" → `<ul>` 레벨 클립 사실 + portal 해소로 정정. 같은 파일 `:84` "중첩 Modal/HelpTip 금지 — ESC 함정" → HelpTip ESC 함정 해소 반영(중첩 Modal 금지는 유지).
- `ui/src/components/scenario/ExtractConfirmRow.tsx:21-24` 주석의 HelpTip ESC 근거 → 갱신(행 자체 구조는 무변경).
- `ui/src/components/scenario/PickArrayDialog.tsx:189` 주석, genvar-per-request spec §6.3 포인터(§2).

## 4. 테스트 전략

- `PickArrayDialog.test.tsx`: ① 체크 → 적용 시 `onApply`가 `refresh:"request"` 포함 ② 체크 해제(초기 request) → 적용 시 `refresh` 키 부재(`not.toHaveProperty`) ③ 체크 후 취소 → `onApply` 미호출 ④ 미리보기 제목이 체크 즉시 전환 ⑤ `initial.refresh:"iteration"`이고 체크박스 미조작 → 적용 결과 `refresh:"iteration"` 보존. 기존 "적용은 initial.refresh를 보존" 테스트(체크 안 건드림 → 보존)는 유지 의미 그대로.
- 패널 통합 `VariablesPanel.test.tsx`: 팝업에서 체크 → 적용 → 패널 체크박스 checked + 행 배지 `요청마다` / 체크 후 취소 → 패널 불변. **팝업 체크박스 쿼리는 반드시 `within(getByRole("dialog")).getByRole("checkbox",{name: ko.editor.genRefreshLabel})`** — 패널 `<label>`이 같은 텍스트를 감싸 `getByLabelText(genRefreshLabel)`는 두 체크박스에 다중매치한다.
- `HelpTip.test.tsx`: portal 렌더(popover가 루트 span의 자손이 **아님**, `document.body` 자손) · 실제 `Modal`(또는 `role=dialog aria-modal=true` 노드) 안 렌더 시 popover가 그 다이얼로그 자손 · `aria-modal` 없는 평범한 `role=dialog` 안이면 `document.body` 자손(셀렉터 좁힘 음수 케이스) · popover 안 pointerdown은 닫지 않음 · 바깥 pointerdown은 닫음 · **Modal 안에서 popover 열림 + ESC → popover 닫힘·`onClose` 미호출**, popover 닫힘 + ESC → `onClose` 호출 · 외부 scroll 닫힘/popover 내부 scroll 유지(높이 상한 overflow-y로 내부 스크롤 가능) · 열림 시 버튼 `aria-describedby`=popover id, 닫힘 시 부재 · `computeTipPos` 순수 테스트(기본·우단 flip·좌 clamp·아래 부족→위·양쪽 부족 clamp).
- 이빨 실증(plan에서 각 회귀 가드 테스트에 고의 회귀→RED→원복): 패널 contains 검사 제거·window capture를 document bubble로 되돌림·dialog container 대신 body·spec 조립에서 refreshDraft 무시(=initial.refresh 고정).
- 라이브(`/live-verify`, Playwright): US3 — 변수 패널 최소 폭에서 pick_array/random_int 변수의 `?` 열기 → popover rect가 뷰포트 안·폭 224 전부 가시(`elementFromPoint`로 popover 우단 근처 점이 popover 자신) · US1/US2 — 팝업 체크·적용/취소 후 저장 YAML(`GET /api/scenarios/{id}`의 `yaml`)에서 `refresh: request` 유무 · US4 — RunDialog(인라인)·ThinkTimeBoard(모달)·리포트 Summary HelpTip 열기/안 클릭/ESC.

## 5. 범위 밖

- `VerdictBadge`·`DownloadMenu` popover의 portal 전환(같은 클립 위험이 있으면 별도).
- 열린 popover의 스크롤 추종(닫기로 대체).
- 엔진 곡선 버그 수정(§6).

## 6. 곡선 버그 기록 (roadmap §B34 — 이 슬라이스는 기록만)

재현 / 기대 / 실측 (2026-10-18, 워크트리 바이너리·responder 50ms·단일 워커·`max_in_flight` 50):

| 곡선(open-loop `stages`) | 기대(∫rate) | 실측 count |
|---|---|---|
| `[{target:5,duration_seconds:10}]` | ~25 | **1** |
| `[{target:10,duration_seconds:6}]` | ~30 | **2** |
| `[{target:20,duration_seconds:6}]` | ~60 | 46 |
| `[{target:20,duration_seconds:6}]`, `worker_count:2` | ~60 | 4 |
| 대조: `[{20,1},{20,7}]` 단일/2워커 | ~150 | 148 / 142 |

원인: `crates/engine/src/runner.rs`의 open-loop 스케줄러가 곡선 interval을 `1/rate_at(stages, next_elapsed)`(예약 tick의 **순간** 레이트)로 잡는다. t=0은 rate 0 → 100ms poll, t≈0.1s에서 0→5/10s 곡선의 rate≈0.05 → interval ≈20s → run 끝까지 다음 arrival 없음. 기울기가 완만할수록(또는 fan-out으로 워커당 레이트가 반으로 줄수록) 손실이 커진다. `crates/engine/CLAUDE.md` S-D 항목("`next` 기준 평가로 ramp 초반 버그 해소")은 `now` 대비 개선일 뿐 이 결함을 못 막는다. 해소 경로: 누적 arrival 적분 역산(다음 arrival 시각 t' = Λ⁻¹(Λ(t)+1), Λ=∫rate, piecewise-linear라 구간별 2차식 해) — 엔진 path-gated(Opus 리뷰)·라이브 RPS 검증 필요한 별도 슬라이스. closed-loop VU 곡선(`vu_stages`)은 같은 증상 없음(실측 0→5 VU 정상).
