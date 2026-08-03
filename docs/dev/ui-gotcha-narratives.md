# ui/CLAUDE.md 함정 서사 아카이브 (on-demand)

> `ui/CLAUDE.md`의 함정 불릿에서 이관된 **발견 경위·정정 이력·실측 전문**. 규칙 자체는
> ui/CLAUDE.md에 남아 있다(그쪽이 정본) — 이 파일은 "왜 그 규칙이 생겼나"가 필요할 때만
> 읽는다. 유래: ui-claude-md-curation 슬라이스(2026-08-03, spec
> `docs/superpowers/specs/2026-08-03-ui-claude-md-curation-design.md`).

## 오프라인(CSP) · 테스트 인프라

### `fast-check` numRuns 40 — 축소 경위

CI 시간을 아끼려고 round-trip 프로퍼티에서 40으로 줄였다.

### clipboard 모킹 순서 — configurable defineProperty가 유일 경로인 이유

(jsdom은 `navigator.clipboard` 미구현+read-only라 configurable defineProperty가 유일 경로 — `URL.createObjectURL` 폴리필과 같은 부류)

### `TextDecoder`의 BOM 조용한 삭제 — 적발 경로

`urlDecode.ts::decodeRun`이 디코딩 문자를 원문 escape 슬라이스에 재대응하는데 BOM 삭제로 text가 3바이트 짧아져 byteIdx desync(`%EF%BB%BF%26`→`%EF`)+멱등 위반(`김%EF%BB%BF`→2차 적용에 `김`).

Sonnet 리뷰 self-flag escalate→Opus 재패스가 node 실측으로 적발한 클래스.

### data router navigate가 깨진 근인 — undici brand-check

vitest `populateGlobal`이 `AbortController`/`AbortSignal`은 jsdom 구현으로 덮지만 `Request`/`fetch`는 Node(undici) 유지 → data router가 navigate마다 만드는 `new Request(url,{signal})`이 undici webidl brand-check에서 거부돼("Expected signal … instance of AbortSignal") **모든 실질 클라 내비게이션이 unhandled rejection**으로 깨진다(초기 마운트-only 테스트는 무증상, Link 클릭/`navigate()` 케이스만 발화 — 격리 실행에서도 재현되는 결정 실패라 flake 아님).

### 검증값 trim — HAR import 후행공백 변수명의 적발 경로

`ScenarioImportPage` 호스트→env 섹션에서 `hostEnv.ts::validateEnv`가 `name.trim()`으로 검증(ok 판정)하지만 `buildEnvInput`(env 키)·`parameterizeUrl`(`${VAR}` 토큰)이 *미트림* override를 그대로 써서, 후행공백 변수명(`"BASE_URL "`)이 검증은 통과하고 런타임엔 미해결 `${BASE_URL }` 토큰이 된다(silent 깨진 시나리오).

(RTL/`tsc -b`는 못 잡고, 머지 전 `security-reviewer`가 correctness 렌즈로 flag→fold·라이브 Playwright로 `${MYVAR}` clean 실증.)

같은 페이지의 빈 미리보기 선택 툴바는 `previewEntries.length > 0` 게이트로 숨김(호스트→env 섹션과 동일 게이트·전부 정적/제외 호스트로 preview 비면 "0/0" 무의미 툴바 제거).

### fan-out memo 안 per-item 전패스 — 20k 엔트리 HAR 실측

20k 엔트리 HAR에서 pass당 31.5s×21회 메인스레드 블록(중단 UI도 안 뜸)

### commit-on-blur 짝 편집 — 발견·제품 결함 확인·해소 이전 이디엄

`min`에 `1000`을 치고 `max`로 포커스를 옮기면 **그 순간** draft가 `{min:"1000", max:"500"}`(옛 max)이라 `min > max` → `revert`로 떨어져 방금 친 값이 사라진다. 기존 테스트들이 안 깨진 건 중간 상태가 항상 "한 칸 빔 → `noop`"이었기 때문이고(`ThinkTimeBoard.test.tsx:237-239`가 이 메커니즘을 이미 주석으로 못박아 뒀다), **쌍을 둘 다 유효값으로 바꾸는 테스트가 처음 이 경로를 밟았다**. → **min/max 쌍 편집은 포커스를 안 옮기는 `fireEvent.change`(min) + `fireEvent.change`(max) + `fireEvent.blur`(max)로** (선례 `ScenarioDefaults.test.tsx:52-58` — 그 픽스처엔 `default_think_time`이 **없는데** 커밋이 성립하므로 `fireEvent.change`가 controlled draft를 실제로 갱신함까지 증명된다. `:117-120`의 revert 케이스는 draft가 안 바뀌어도 같은 단언이 통과해 **단독 증명력이 없다**). 파생 함정: 이 부작용은 "회귀를 주입해도 안 주입해도 **항상 RED**"를 만들 수 있어 이빨 실증(주입→RED→원복→GREEN)의 마지막 GREEN에 원리적으로 도달 못 하게 한다 — 공허한 테스트("항상 GREEN")의 거울상. **후속 확인(thinkboard-defaults 라이브 L3, 2026-07-19): 이건 테스트 함정이기 이전에 *제품 동작*이다** — Playwright `fill()`도 같은 포커스 이동을 하므로 `200/500`에서 `1000`·`2000`을 치면 **`200–2000`이 커밋**된다(사용자 의도 `1000–2000`). 범위를 **올릴 때만** 발현(내릴 땐 중간 쌍이 유효), 순서를 바꾸면(max 먼저) 정상. 소비처 3곳(`Inspector.commitThinkTime`·`ScenarioDefaults.commit`·`ThinkTimeBoard.commitDefault`+`BoardRow.commit`) 공통이라 고칠 땐 한 슬라이스에서 전부(예: `relatedTarget`이 형제 입력이면 커밋 보류). **위 `fireEvent` 이디엄은 테스트를 통과시킬 뿐 이 결함을 가린다** — 회귀 가드를 세우기 전엔 "테스트 green = 편집이 옳다"로 읽지 말 것(roadmap-status B13 추천 항목).

### `user.type` 키 디스크립터 — 트리거 사례

(예: 테스트에서 `matches` 연산자에 깨진 정규식을 입력해 유효성 경고를 트리거할 때)

### 무조건 발화 훅이 one-shot `fetchMock` 큐를 깬 사례

`SettingsPage`가 `usePoolWorkers()`(→`fetch("/api/pool/workers")`)를 마운트마다 무조건 호출하게 바꾸자, 전역 `fetch`를 `mockResolvedValueOnce` 큐로 1건씩 떠먹이던 기존 ~13 테스트가 *2차 fetch*에 큐가 어긋나 깨졌다.

### `aria-label`도 `ko.ts` 경유 — 리뷰가 반복 적발한 영어 라벨

리뷰가 `aria-label="template form"`/per-token `rename ${name}` 같은 영어 라벨을 반복 적발

### grep-0 불변식과 음수 단언의 충돌 — 회귀 가드가 삭제된 경위

(여기선 implementer가 "vacuously true"라며 단언을 통째 삭제 → 슬라이스 헤드라인 회귀 가드 소실, 최종 리뷰가 적발)

(이 슬라이스 plan의 내부 모순)

### no-op 콜백 `MutationObserver` — plan-verbatim 테스트가 이빨 없이 통과한 경위

(plan-verbatim stale-model 테스트가 이렇게 이빨 없이 통과했었다)

### 부분모킹이 살린 훅과 raw `dispatchEvent` — 틀린 첫 가설의 전개

`vi.mock("../VuSizingHelper", () => ({VuSizingHelper: () => null}))`(완전 auto-mock)를 `importOriginal` spread(`usePriorClosedRunAnchor` 실물 보존, 컴포넌트만 stub)로 바꾸자, 그 훅이 이제 파일의 모든 테스트 렌더에서 진짜로 돈다 — 두 무관한 기존 테스트가 `act()` 경고를 새로 냄. 처음 가설(테스트 종료 전 비동기 미대기 → `await findByRole(...)`/`waitFor` 류 end-of-test flush로 해소)은 실측으로 틀림(여러 변형 시도, 전부 무효) — 실제 원인은 그 두 테스트가 쓰는 `setNativeValue` 헬퍼의 raw `el.dispatchEvent(...)`(RTL act-래핑 진입점 `render`/`fireEvent`/`user.*`/`waitFor`/`findBy*` 전부 우회)가 act-커버리지의 유일한 공백이고, 정확히 그 지점에서 React Query `notifyManager`(기본 `setTimeout(cb,0)`)의 쿼리-settle 갱신과 충돌 — 즉 경고가 **테스트 종료 시점이 아니라 mid-test**에 발생해 뒤쪽 flush가 무의미.

### 병렬 리뷰 subagent의 src 편집이 HMR로 검증 페이지를 리셋한 사건

리뷰 subagent를 라이브 검증과 **병렬로** 돌리던 중 리뷰어가 `expandable` 제거/추가로 테스트 이빨을 확인하자, 브라우저의 105스텝 시나리오가 템플릿 초기 2스텝으로 되돌아가고 토글이 사라졌다(HMR reload가 클라-only 드래프트를 초기화 — 기존 "fold-in fix가 페이지 상태 리셋" 함정의 *타 에이전트* 변종).

### master 대조 실험으로 선재 결함을 확정한 사례

스크립트로 103스텝을 tight loop 추가할 때 "Maximum update depth exceeded"가 떠 새 `ResizeObserver` effect의 무한루프를 의심했으나, 스택이 zustand `setState`→`handleStoreChange`(우리 effect 미경유)였고 **master 버전 src를 얹어도 동일 재현** → 선재 결함 확정(수동 클릭 속도에선 미발화).

### 같은 값 ko 키 2개 — `getAllByText(...)[0]`이 열을 못 집은 사례

`ko.editor.thinkStateNoWait`(설정 배지)와 `ko.editor.thinkNoWait`(실효 대기 셀)가 둘 다 `"대기없음"`이라, 행-스코프 `getAllByText(...)[0]`이 "DOM 순서상 먼저 오는 노드"를 집을 뿐이라 배지가 빠지거나 다른 상태 문구로 매핑돼도 실효 `<td>`가 잡혀 green.

(후속 task가 열을 추가하면 인덱스가 밀린다 — 실제로 다음 task가 체크박스 열을 앞에 끼웠다)

### `toHaveTextContent` 부분문자열 — 두 분기를 구별 못 한 단언과 plan 짝 교훈

`thinkBoardDefaultNone`("없음 — 상속 스텝은 모두 **대기없음**")이 `thinkNoWait`("대기없음")를 포함해, `{0,0}` 분기를 검증하려던 `toHaveTextContent(ko.editor.thinkNoWait)`가 `undefined` 분기(=다른 문구)에서도 green이었다 — 두 분기를 구별 못 하는 단언. 이빨 실증(요약을 undefined 분기로 고정 → RED)으로 확인.

**plan 단계의 교훈이 짝을 이룬다**: 그 plan은 신규 ko 4개의 충돌 회피표를 만들며 **신규↔신규만 대조하고 신규↔기존을 안 봤다**("부분문자열 충돌까지 회피된 값"이라 단언했으나 거짓).

### WCAG 2.5.3 — 보이는 라벨과 어긋난 `aria-label` 사례

`aria-label`이 텍스트 콘텐츠를 **덮어쓰므로**, 보이는 라벨이 "페이싱"인데 aria가 "think time 현황판 열기"면 음성 제어 사용자가 화면에 보이는 말로 버튼을 호출할 수 없다.

### CI-only 간헐 실패 1차 — flake 판별 3종 세트의 실측 근거

(이번엔 `desktop/src-tauri/` 버전 3줄)

2026-07-11 클러스터는 `ui` 잡이 아니라 `rust` 잡의 Clippy였다.

### CI-only 간헐 실패 2차 — 중간 상태 커밋(`ScenarioEditPage.name` R2)

`ScenarioEditPage.name` R2의 `await findByRole(연필)` 직후 `expect(pencil).toBeEnabled()`가 `disabled=""`로 실패. 위 1차는 "B가 아직 없다"(쿼리 실패)지만 이건 **찾은 그 요소의 속성이 아직 옛 값**이라 `findBy`로 바꿔도 안 낫는다 — `nameEditable`이 `seeded`(=시드 `useEffect`가 `setSeededId`)에 걸려 있어 "data 도착 + 미시드" 중간 커밋이 **구조적으로 존재**한다(MutationObserver 실측: `null→disabled→enabled`). 즉 타이밍 운이 아니라 *반드시 있는* 창이고, 로컬은 이펙트 flush가 옵저버 콜백보다 먼저라 항상 통과할 뿐.

### CI-only 간헐 실패 3차 — 시드 신호로 오인된 data 신호(`ScenarioNewPage.genvars`)

`ScenarioNewPage.genvars`가 `await findByRole("저장")`을 시드 완료로 믿고 곧장 `getByRole(varExpandAria("checkin"))`를 동기 호출 → CI에서 `Unable to find … "checkin 펼치기/접기"`. 헤더 "저장"은 `if (!data) return` 통과 직후 커밋에 있고 변수 행은 `loadFromString` 시드 *이후* 커밋이라 한 틱 늦다(프로브 실측: `save=0/var=0` → **`save=1/var=0`** → `save=1/var=1`).

### CLAUDE.md 규칙 스코프 — `ValidityBadge` 표면을 지울 뻔한 경위

`ValidityBanner`를 "level==ok면 미렌더"로 바꾸면서 위 A11 불릿을 `ValidityBadge/Banner`를 함께 지칭하는 문장 안에서 확장해버렸는데, `ValidityBadge.tsx`는 `!validity`만 가드하고 **ok도 의도적으로 렌더**한다(`NarrativeBlock` 삭제 후 ok run의 **유일한 잔여** 유효성 표면). 문서를 믿은 다음 편집자가 그 표면을 지울 함정 — per-task 리뷰는 두 컴포넌트가 한 diff에 없어 원리적으로 못 본다(최종 whole-branch가 적발).

### 자기참조 단언 — `checkCFailTitle(2)` 실측

`checkCFailTitle(2)`에서 `${n}`을 지워도 통과했다(같은 홀이 기존 C 단언에 선재).

### 가시 라벨 ⊄ aria — 신뢰도 칩의 적발 사례

신뢰도 칩이 가시 `신뢰도 · 보완 필요 2 (미확인)`인데 aria가 `시나리오 신뢰도: 보완 필요, 고칠 곳 2개 — 열기`여서 구분자(`·`↔`:`)·`(미확인)`·맨숫자가 접근명에 없어 음성제어로 호출 불가였다(바로 옆 페이싱 칩은 `페이싱`⊂`페이싱 현황판 열기`로 규약을 지키고 있어서 더 변명 불가).

### 파괴적 액션 Modal 포커스 유실 — 오진했던 원인

(`previouslyFocused?.focus?.()`가 detached 노드에 no-op — **원인은 그 옵셔널 체인이 아니라 포커스된 요소의 언마운트**)

### 비대화형 `overflow-auto` 목록 — 대조 사례

(`VarUsagePopover`는 항목이 `<button>`이라 이 문제가 없다)

### `tdd-guard` 주석 예외가 JSX 주석을 못 본 사례

따라서 `RunDialog.tsx`의 stale 주석 1줄 정정 같은 편집이 단독으로는 pending test 없음으로 deny된다.

### `Field` grep 오염 — plan verbatim "3개 사이트" 사실 오류의 적발 경위

(실소비처는 `LoadModelFields`·`RunDialog` 2파일 13곳 — plan verbatim "3개 사이트" 사실 오류가 이 오염+cross-file 카운트 필요 탓에 per-task 리뷰 5회를 통과하고 whole-branch에서야 적발됨)

## 빌드·타입 게이트

### `pnpm build`가 최종 게이트 — `fc.constantFrom` widening 사례

예: `fc.constantFrom("GET","POST",...)`는 런타임에 동작하지만 `Arbitrary<string>`으로 widening돼서 discriminated union과 안 맞아 `tsc -b`에서 깨짐 → 각 인자에 `as const` 또는 명시적 `fc.Arbitrary<"GET"|"POST"|...>` 선언.

### 게이트-에러 한국어 매핑 — empty-path 분기를 두지 않은 근거

`unrecognized_keys`는 normalize 허용리스트가 root/step/request 여분 키를 제거해 passthrough 사이트(extract 원소·cond·request.disabled)에서만 도달=path 항상 non-empty(empty-path 분기 불요).

### hoisted `function` 선언이 잃는 narrowing — 메커니즘 상세

early-return 가드(`if (!data) return …`) 뒤에서 `data`는 non-undefined로 narrow되지만, 그 아래 `function onClick(){ … data.yaml … }`(hoisted 선언)의 본문은 스코프 최상단(가드 *이전*) 기준으로 분석돼 `data: T|undefined`로 되돌아가 `TS18048 'data' is possibly undefined`. JSX 인라인 화살표(`onClick={() => …data.yaml…}`)는 in-place 평가라 narrowing 보존 → 안 깨진다. 그래서 한 컴포넌트 안에 핸들러가 선언/인라인 섞이면 선언만 빨갛다.

### targeted green ≠ full green — 실제로 놓쳤던 red

(예: `ReportSchema` fixture가 필수 `dropped` 누락)

### 같은 라벨 버튼 다중매치 — G1b stall advisory 사례

mid-run advisory 배너의 [중단] 버튼과 헤더 abort 버튼이 둘 다 `ko.common.abort`('중단') 라벨이라(midrun이면 run이 `running`=헤더 버튼도 렌더) `getByRole('button',{name:'중단'})`가 2개 매치로 throw.

### 필터 칩 라벨 변경 회피 시도 — 리뷰 기각 기록

(implementer 시도→리뷰 기각)

### 상시 미러 컴포넌트의 스텝명 복제 — 기존 테스트 2건 수정

(기존 `ScenarioNewPage` 테스트 2건이 이 함정으로 role-스코프 수정됨)

### RTL `getByText`는 직계 텍스트 노드만 — `InsightPanel` 조치문 사례

`InsightPanel` 조치문은 `<div><span aria-hidden>→ </span>{action.text}</div>` 구조인데 div의 직계 텍스트 노드는 `action.text` 하나뿐이라 `getByText(ko.errorOnset.sutExhaustion)`가 **정확히 매치한다**.

### suite-wide 비결정 테스트 격리 flake — 발견·근인·CI 2차 재발

`ScenarioEditPage.name`·`ScenarioEditPage.dirty`·`DataBindingPanel`이 full-suite에서 각기 다르게 red였다가 재실행하면 green — 코드 결함이 아니라 공유-글로벌 누수(vitest 기본 `isolate:true`라 모듈/zustand store는 파일별 리셋되지만, `ui/src/test/setup.ts`엔 **글로벌 `afterEach(cleanup)`가 없고** localStorage 폴리필의 in-memory `store`가 워커 내 파일간 잔존한다 — install-guard `if (typeof globalThis.localStorage?.clear !== "function")`가 2번째 파일부터 재init을 skip해 1번째 파일의 데이터가 남음).

**증상 오독 주의**: pre-commit UI 게이트가 `pnpm test`를 돌리므로 이 flake가 커밋을 간헐 reject한다(FAIL 라인이 출력에 안 보일 때도 exit 1) — "게이트가 내 변경을 막는다"로 오인 말고 실패 파일을 *격리 실행*(`pnpm test <file>`)해 green이면 flake 확정, 커밋 재시도.

localStorage 픽스 후에도 GitHub Actions에서 `ScenarioEditPage.name.test.tsx`의 R2 케이스(`yamlError` 세팅 직후 disabled 단언)가 재실패 — 같은 파일의 다른 케이스들이 이미 쓰는 "`findByRole` 뒤 EditorShell 마운트 이펙트(`loadFromString` 자기-재시드, StrictMode 이중 호출 포함)를 비우는 빈 `await act(async () => {})`" 방어 flush가 이 케이스에만 빠져 있었다(`194cfa3`).

### `pnpm lint`가 hook에 없어 경고가 잠복한 사례

(`react-hooks/exhaustive-deps` 누락 한 건이 이렇게 통과했었음 — `ScenarioRunsPage.tsx` effect deps)

### 응답 스키마 top-level `.default()` 누출 — `request<T>` 시그니처 완화 기각

`client.ts`의 `request<T>` 시그니처를 `z.ZodType<T,def,unknown>`로 푸는 우회는 불필요(plain 타입이면 누출 자체가 없다).

### JSON 캐스트 검증에서 `${env}` 캐스트 *거부* — json-cast-extend로 뒤집힘

(**`${env}` 캐스트 *거부*는 아래 json-cast-extend로 뒤집힘** — 위 "`${env}` 캐스트를 에러로"는 이제 틀림.)

### 0029 캐스트 확장 — 무변경 범위와 알려진 한계의 도입-경위 단서

모델/Zod/store 무변경(`BodyModel.superRefine` 배선 그대로·검증 내용만 확장).

(=드문 'UI 통과·엔진 실패' 방향이나 **fail-closed·loud**·이 슬라이스가 도입 아님=`ENV_TOKEN` regex 불변·테스트/요구사항 미커버)

### `tsc -b` 전체 타입체크 — 9c widening이 나중 task 테스트를 깬 사례

9c: Task2 모델 widening이 `proptests.test.ts` 직렬화기(`httpStepToYaml`→`stepToYaml`, 원래 Task5 Step1b)를 깨 Task2로 당김.

## 폼·입력 UX / 진단 표시 (RunDialog, RunDetail)

### 새 런타임 옵션이 RunDialog에서 빠진 채 머지된 경위 (Slice 4 M1)

Slice 4 plan은 ramp_up/env를 엔진·controller·proto에 다 넣었지만 `RunDialog`가 두 값을 하드코딩(`ramp_up_seconds: 0`, `env: {}`)으로 보내고 있었다. 단위/통합 테스트는 백엔드만 검증해 회귀가 안 잡혔다.

### 한 칸짜리 add row가 만든 잘못된 env entry (Slice 4 M5)

RunDialog Env 입력 1차 구현이 placeholder="BASE_URL" 한 칸 + Add였는데, 사용자가 URL을 키 칸에 통째로 적어 `key=http://..., value=""` 잘못된 entry를 만들었다.

### Run 상세 step_id 진단성 — 도입 동기

ULID만 보이면 점검자가 어떤 URL을 때리는지 모른다.

### `KeyValueGrid` active+disabled 2-맵 — 도입 동기와 무변경 범위

Postman식 "행 끄되 보존".

`BulkEditPanel`/`kvBulk.ts` 시그니처 무변경

### RunDialog 간단/상세 모드 — prefill 갭의 적발 경위

양 최종 리뷰어[handicap+security]가 독립 수렴 적발

### 타일·Segmented teeth — RED가 사실 green이었던 자가플래그와 teeth 입증

(implementer가 RED 단계가 사실 green이라 자가플래그)

**teeth 입증**: 게이트(`loadModelTiles ?`)를 일시 `false ?`로 뒤집어 radiogroup 단언 FAIL 확인 후 복원(production diff empty).

### `LoadShapePreview` 조각화(R10) — 리팩터 당시 제약

`runSummary`를 string→`{main:SummarySegment[];sub;tone;curve}`로 조각화할 땐 **판정 로직(warn 게이트·curve 분기·total 식) byte-identical 유지**(반환 *모양*만 변경=R10)·`SummarySegment`는 로컬 TS 타입(schemas.ts 미접촉)·footer는 `toHaveTextContent`로 단언(`<b>` 단편화 무관).

### 번호 `Section` 재구성 — `scenario={null}` 번호 갭을 LOW로 수용한 기록

테스트 헬퍼 `renderDialog`가 `scenario={null}`이면 `scenario` 게이트 Section(데이터셋 index 3)은 미렌더 → 그 번호 갭(1,2,(빠짐),4,5,6)은 깨진-시나리오 degraded 상태의 수용된 LOW 한계(테스트는 *번호*가 아니라 *텍스트 존재+DOM 순서*만 단언).

### HelpTip popover 고정폭 — 라이브 검증이 잡은 57px 오버플로

라이브 검증이 1200px에서 57px 오버플로를 잡아 추가

### `VarUsagePopover` 클립 — 라이브에서 관측된 증상

(라이브: 팝오버가 열 우단 밖으로 렌더)

### 프리셋 드롭다운 — state 클리어가 게이트된 기능까지 지운 경위

프리셋 드롭다운이 "불러온 뒤 폼 수정 시 — 선택 —으로 복귀"해야 하는데 `loadedPresetId`를 클리어하면 그것에 *게이트된 다른 기능*(rename/delete 버튼·`renamePreset`/`removePreset` 대상)이 같이 사라진다.

### stretched-label 오버레이 — 코드베이스 선례 0의 주의 근거

(코드베이스에 `after:`/`before:` 의사요소 선례 0이라 특히 주의)

### native radio 전환의 accname 충돌 — 전파 범위 오예측

(plan이 RunDialog.test 14곳만 예상했으나 ScenarioRunsPage.test의 다이얼로그 open/close 판정 10곳도 깨짐)

### 한 aria-label을 두 요소가 공유 — 측정 섹션 switch/HelpTip 사례

측정 섹션은 같은 `aria-label`("응답 시간 단계 분해")을 토글 `role="switch"` 카드 *와* HelpTip `?` 버튼 둘 다 가져 `[...].find(b=>aria-label===…)`가 switch를 먼저 잡는다(엉뚱한 토글 클릭).

## 다단계 ramp UI (RunDialog stages 편집·미리보기, S-D)

### 곡선 run이 `0s`/`0 RPS`로 떴던 회귀 — 발견 경위

RunDetailPage Duration·Avg RPS 카드, ScenarioRunsPage Duration 열이 곡선 run에서 `0s`/`0 RPS`로 떴었다(리포트 Summary는 자체 윈도라 정상).

### 곡선 fan-out 워커별 active-VU — SUM 머지가 가렸던 것(도입 동기)

기존 `active_vu_series`는 worker별 행을 `SUM…GROUP BY ts_second`로 머지해 "어느 워커가 desired 미달인지"를 못 본다.

### 부하 모드 셀렉터 2축 — closed+curve가 도달 불가였던 시절 (해체됨)

closed+curve는 disabled "곧 지원"(closed-loop VU 곡선=미래 슬라이스).

closed 라디오 `onChange`가 `setRateMode("fixed")` eager 리셋 + 곡선 라디오 `disabled` 둘이 함께 "closed+curve" 상태를 도달 불가로 만들었다 (**이제 해체됨 — ADR-0037, 아래 closed+curve 항목**).

(3모드 라이브 검증: closed 36k req / open-fixed ~100 RPS / open-curve stages)

### 사이징 헬퍼 게이트 패턴 — 3회 검증·4번째(WorkerSizingHelper) 전개

**이 게이트 패턴은 이제 3회 검증됨** (open+curve 슬롯 힌트 2026-06-15): open+fixed arm의 `SlotSizingHelper`(open-loop 슬롯 사이징, `onApplyMaxInFlight && sizingScenarioId!==undefined`)에 이어 **open+curve arm도 동일** 헬퍼를 같은 게이트로 렌더(`peakBased` prop만 추가). 즉 슬롯 헬퍼는 이제 open(fixed/curve) **양 arm**에 뜨고 closed 2모드만 미렌더 — 슬롯 락인 `it.each`를 open+curve "미렌더→렌더"로 flip하고 closed+fixed·closed+curve만 미렌더로 남긴다. VU 헬퍼(`onApplyVus`·testid `sizing-helper`)는 **여전히 closed+fixed 전용**이라 open+curve에선 미렌더(슬롯 testid `slot-sizing-helper`와 별개라 무충돌 — 두 `it.each` 락인이 공존).

② **count 기반 앵커**(`usePriorOpenRunWorkerAnchor`의 peak=`peakThroughput(windows)`=초별 Σcount 최대) — p50 기반 슬롯/VU 앵커와 달리 localhost sub-ms run에서도 `peak>0`이라 앵커가 산다. ③ **env/measure 경로 없음**(워커당 천장은 포화 시에만 관측 → 무부하 측정 무의미, prior-run-only).

### closed+curve(VU 곡선) 활성화 — "곧 지원" 게이트 해체 (ADR-0037)

위 "곧 지원" 해체.
