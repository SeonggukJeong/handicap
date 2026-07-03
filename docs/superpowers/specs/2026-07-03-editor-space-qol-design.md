# 에디터 공간·이름 QoL — 접이식 인스펙터 섹션 + 스텝 넓게 보기 + 이름 blur-Untitled (도그푸딩 불편 1·8·7)

- **날짜**: 2026-07-03
- **상태**: 설계 초안
- **출처**: 사용자 도그푸딩 불편 8건(2026-07-03) 중 항목 1(스텝 디테일 세로 길이)·8(스텝만 넓게 보기)·7(이름 즉시-Untitled 스냅). 왜 지금: 에디터 일상 사용의 가장 아픈 마찰("화면 위아래로 왔다갔다 너무 불편")이고 셋 다 UI-only라 게이트가 가볍다.
- **연관**: ADR-0044(에디터 아웃라인 재설계 — `FlowOutline`이 1차 표현), ADR-0035(ko.ts 카탈로그), 2026-07-02-editor-test-chips(`TestFlowChips` 재사용), 2026-07-03-scenario-delete-name-sync(이름 편집 함정 선례), 메모리 [[ui-optional-sections-collapsible]](접이식 선호)·[[implementation-rigor-over-spec]](시각 실측).
- **ADR**: 신규 불필요 — ADR-0044 범위 내 additive(아웃라인 뷰 모드 추가·인스펙터 재배치), 모델/와이어 무접촉.

---

## 0. 시각 컴패니언 확정 사항 (구현 시 이 목록이 권위)

브레인스토밍 시각 컴패니언에서 사용자가 클릭으로 확정. **목업 원본은 tracked로 보존**: `docs/superpowers/specs/assets/2026-07-03-editor-space-qol/`(`wide-layout.html`·`wide-layout-v2.html` — 브라우저로 열면 프레임 CSS 없이도 레이아웃·주석 판독 가능). 구현·리뷰 시 아래 표와 목업 원본을 함께 참조할 것:

| 화면 | 선택 | 의미 |
|---|---|---|
| `wide-layout.html` | **A `a-fullwidth-list`** | 넓게 보기 = **전폭 세로 리스트**(실행 순서 위→아래 유지·드래그 유지·행에 URL 전체+부가 칩). B(가로 카드 플로우, 구 캔버스 감각) **기각** — URL 재잘림·드래그 재작업·랩 지점 Z자 읽기. |
| `wide-layout-v2.html` | **A `v2-with-chips`** | 목록 상단에 **흐름 칩 스트립**(`TestFlowChips` 재사용) 포함. 칩 클릭=점프(스크롤+하이라이트, 모달 없음), 행 클릭=편집 모달. 스텝 영역은 뷰포트 높이 고정+내부 스크롤. |
| (터미널 답변) | 섹션 접기 | 핵심(이름·메서드·URL) 제외 전부 접기, 기본 접힘+"N개" 힌트, **열림 상태는 페이지 이동·새로고침에도 유지**(사용자: "DB 필요할 줄 알았지" → localStorage로 충족). 와이드 토글 영속은 요청 범위 밖(§7). |

목업의 시각 요소 중 normative인 것: 와이드 행 부가 칩(검증 N·추출·think), 칩 스트립(흐름 라벨+`→` 구분 — 긴 시나리오는 여러 줄 wrap, 재사용 컴포넌트 `flex-wrap`의 기존 동작), 점프된 행 하이라이트, 편집 모달 안 접이식 섹션 재사용. 나머지(색·간격)는 기존 디자인 토큰/아웃라인 스타일을 따른다.

---

## 1. 문제와 목표

http 스텝 인스펙터는 이름부터 추출까지 전 섹션이 상시 펼침이라 헤더·검증·추출이 몇 개만 쌓여도 세로로 길어져, 편집 중 화면을 위아래로 오간다. 아웃라인 열은 260–300px 고정폭이라 URL·부가 정보가 잘려 시나리오 전체 검토가 어렵다. 이름 입력은 빈 값을 매 키스트로크 `"Untitled"`로 치환해 이름 수정 시 커서 뒤에 "Untitled"가 박힌다.

- **목표**: ① 인스펙터를 접이식 섹션(핵심 제외 기본 접힘, 열림 상태 영속)으로 압축, ② "스텝 넓게 보기" 모드(전폭 리스트+칩 점프+모달 편집+내부 스크롤), ③ 이름은 blur 시에만 Untitled 폴백.
- **비목표(연기)**: §7 참조 — 컨테이너 인스펙터 섹션화, 와이드 토글 영속, 칩 스트립 test-run 결과색 연동, 도그푸딩 항목 2·3·4·5·6.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법: 테스트명 또는 관찰) | seam? |
|---|---|---|---|
| R1 | MUST `HttpStepInspector`에서 이름·메서드·URL(+빈 URL 경고)은 항상 노출하고, **헤더·바디·타이밍(타임아웃+think time)·검증·추출** 5개는 disclosure(`<button aria-expanded>` + 접힘 시 자식 미렌더)로 전환하며 기본은 전부 접힘. | RTL: 초기 렌더에 헤더/바디/검증/추출 입력 부재 + 5개 `aria-expanded=false` 버튼 존재, 펼치면 기존 편집기 렌더 | |
| R2 | MUST 접힌 disclosure에 내용이 있으면 힌트 배지 표시 — 헤더 "N개"(활성+비활성 합), 검증 "N개", 추출 "N개", 바디는 kind 라벨(기존 카탈로그 재사용: `bodyJson`/`bodyForm`/`bodyRaw`="원문" — none이면 배지 없음), 타이밍 "설정됨"(타임아웃 또는 think 존재 시). | RTL: fixture 스텝으로 각 배지 텍스트 정확-매치 단언 | |
| R3 | MUST 섹션 열림 상태는 **섹션 종류별 전역**(스텝 간 공유)이고 localStorage로 영속(페이지 이동·새로고침 유지); localStorage 불가/오염 시 fail-soft로 기본값(전부 접힘)·세션 메모리 동작(`onboarding/state.ts` 이디엄). | RTL: 헤더 펼침→다른 스텝 선택→헤더 여전히 펼침; localStorage에 기록·재마운트 시 복원; malformed 값 주입 시 기본값+무throw | |
| R4 | MUST 컨테이너(loop/if/parallel) 인스펙터 본문은 무변경(섹션화 대상 아님 — 이름 입력 R12만 공유). | 기존 컨테이너 인스펙터 테스트 green 유지 + diff 스코프 확인 | |
| R5 | MUST 에디터 툴바(변수·YAML 버튼 옆)에 "스텝 넓게 보기" 토글(`aria-pressed`)을 추가하고, ON이면 인스펙터 열 미렌더 + 아웃라인이 나머지 전폭(1fr) 사용, 변수 패널 토글은 독립 동작. | RTL: 토글 ON 시 인스펙터 `aria-label` 부재·그리드 클래스 전환; Playwright: 아웃라인 `getBoundingClientRect().width` 확장 실측 | |
| R6 | MUST 와이드 ON 시 스텝 목록 영역은 뷰포트 기준 **최대높이**를 갖고 넘치는 스텝은 영역 **내부에서만** 스크롤(페이지 스크롤 증가 없음; 칩 스트립·툴바는 스크롤 영역 밖·스텝이 적으면 내용만큼만). | Playwright: 다스텝 시나리오에서 목록 `scrollHeight>clientHeight` + `document.documentElement` 스크롤 높이 비증가 실측 | |
| R7 | MUST 와이드 ON 시 목록 상단에 흐름 칩 스트립(`TestFlowChips` 재사용, `trace={null}` 명시 전달 — required prop; 긴 시나리오 wrap 허용)을 **구분 wrapper**(`<section aria-label>` 신규 ko 키 — test-run 섹션의 동일 `role="group"` "테스트 흐름"과 구분) 안에 렌더하고, 칩 클릭은 선택+해당 행 scrollIntoView(`block:"nearest"`)+선택 하이라이트만(편집 모달 미오픈·`detailOpen` 불변). | RTL: wrapper region within-스코프로 칩 존재+칩 클릭 후 모달 부재(bare `getByRole("group",{name:"테스트 흐름"})` 금지 — 이중 매치); Playwright: 칩 클릭 시 목록 `scrollTop` 변화 실측 | |
| R8 | MUST 와이드 ON에서 아웃라인 행 활성화(클릭/키보드 Enter·Space — 기존 행 활성화 핸들러 동승; 드래그 핸들 클릭은 제외)는 선택+편집 모달(기존 `Modal`+`Inspector` 재사용)을 열고, ✕/ESC/backdrop 닫기 시 선택은 유지하며, 모달 onClose는 `detailOpen` 리셋 **전에** 포커스된 입력을 동기 blur해 blur-커밋 draft를 flush하고, `detailOpen`은 ①모달 onClose ②`selectedStepId===null` 전이(모달 내 스텝 삭제 포함) ③와이드 OFF 세 지점에서 리셋되어 **삭제 후 칩 점프·와이드 재토글이 모달을 재오픈하지 않는다**. | RTL: 행 클릭→모달 내 인스펙터 렌더·닫기 후 선택 유지·삭제 시 모달 닫힘·**삭제 후 칩 클릭 시 모달 미재오픈**·**draft(JSON 바디/타임아웃) 타이핑 후 ESC 닫기 → store 커밋 확인(blur-flush)** | |
| R9 | MUST 와이드 모드에서만 http 행에 부가 칩(검증 "N"·추출 "N"(title=var 나열)·think "min–max ms")을 렌더하고, 일반 모드 행 렌더는 byte-identical(기존 아웃라인 테스트 무수정 green). | RTL: 와이드 시 칩 존재/일반 시 부재; 기존 FlowOutline 테스트 무수정 통과 | |
| R10 | MUST 와이드 토글 상태는 에디터 마운트 수명(페이지 이동 시 OFF 리셋) — 영속은 §1 섹션 상태(R3)만. | RTL: 재마운트 후 토글 OFF 확인 | |
| R11 | MUST 와이드 모드에서 dnd-kit 드래그 재정렬(그룹내·경계·re-parent)은 기존과 동일 동작(드래그 경로 코드 무변경). | `reorder.ts`/`dropRules` 0-diff + Playwright 와이드에서 `browser_drag` 1회 실측 | |
| R12 | MUST 4곳(http/loop/if/parallel) 이름 입력을 draft+하이브리드 커밋으로 — onChange는 raw `v !== ""`이면 즉시 커밋(아웃라인·칩 라이브 갱신 유지; trim 검사는 blur에서만 — 공백-only 커밋은 현행과 동일), 빈 값은 미커밋(draft 유지), blur 시 draft가 trim-빈이면 "Untitled" 커밋; 타이핑 중 "Untitled" 스냅 없음; draft는 `[step.id]` dep로 재시드. | RTL: 이름 전체 삭제 → 입력값 ""·store는 직전 이름 유지 → blur → 둘 다 "Untitled"; 부분 수정 타이핑 중 스냅 없음 | |
| R13 | MUST store/model엔 빈 이름이 절대 기록되지 않고(`min(1)` 불변·YAML reparse 실패 경로 없음), blur 없이 언마운트되면 store는 마지막 유효 이름을 유지한다(잔여 플래그·지연 커밋 없음). | RTL: 빈 draft 상태로 모달 ESC 닫기 → store 이름 불변·재편집 정상(scenario-delete-name-sync T6 클래스 회귀 가드) | |
| R14 | MUST 엔진/컨트롤러/proto/migration/모델(Zod)/YAML 직렬화 0-diff — `ui/src` 밖 무접촉, `model.ts`·`yamlDoc.ts`·store 액션 시그니처 무변경. | diff 스코프 grep + 기존 model/yamlDoc/store 테스트 무수정 green | |
| R15 | MUST 신규 사용자 노출 문구(토글·섹션 제목·힌트 배지·모달 제목·aria-label 전부)는 `ko.ts` 카탈로그 경유(ADR-0035), 인라인 한글/영어 0. | 하드코딩 sweep(`'"[^"]*[가-힣]'` + ternary-attr 패턴) + 리뷰 | |
| R16 | SHOULD 이번에 선택 안 된 도그푸딩 항목 2(변수 충돌 감지)·3(Think Time 일괄)·4(HAR host 힌트)·5(데이터셋 미리보기)·6(에디터 데이터셋)을 `docs/roadmap.md`에 등재해 보존. | roadmap.md diff 확인 | |

seam 없음 — 전 요구사항이 UI 렌더/로컬 상태 한정(계약 경계 무접촉).

---

## 3. 핵심 통찰 (설계 근거)

1. **와이드 = 전폭 세로 리스트(§0 확정)**: "넓게 보기"의 목적이 *스텝 내용을 더 보는 것*(잘리던 URL·부가 정보)이므로 리스트를 넓히는 A가 정답. 가로 카드(B)는 구 캔버스 감각이지만 카드 폭이 좁아 URL이 다시 잘리고, 드래그(세로 리스트 전제·`nearestByHeader` y-기반)를 재작업해야 하며 ADR-0044가 캔버스를 걷어낸 이유로 회귀한다. B의 유일 장점(가로 조망)은 기존 `TestFlowChips` 재사용(긴 시나리오 wrap 허용 — §0)으로 흡수(v2 확정) — 새 UI 발명 없음.
2. **칩=점프, 행=모달**: 모달 오픈을 선택 상태의 부수효과로 만들면 칩 클릭(선택 변경)도 모달을 열어버린다 — 모달은 행 활성화 핸들러가 명시적으로 연다(R7/R8 분리). `TestFlowChips`는 프레젠테이셔널이라 `trace={null}`(required prop, 타입 `ScenarioTrace | null`) 명시 전달로 test-run 섹션의 기존 마운트와 독립 재마운트 가능.
3. **섹션 상태는 localStorage**: 사용자가 "페이지 이동에도 유지(가능하다면)"로 확정. Zustand store는 싱글톤이라 SPA 세션 내 잔존하지만 새로고침에 리셋되고, localStorage는 둘 다 커버. 선례 `onboarding/state.ts`(try/catch fail-soft, 프라이빗 모드 no-op) 이디엄 재사용 — 실패 시 기능 저하는 "기본 접힘"일 뿐(fail-soft). jsdom엔 `test/setup.ts` localStorage 폴리필이 이미 있으나 **테스트 간 누수 방지로 관련 테스트 `beforeEach` `localStorage.clear()` 필수**(plan에 명시).
4. **이름 하이브리드 커밋은 liveName 슬라이스 함정의 회피 설계**: 빈 값만 blur에 의존하고 비-빈 값은 즉시 커밋이므로, blur-on-unmount 미발화(jsdom·실브라우저 비보장 — scenario-delete-name-sync T6)여도 store는 항상 마지막 유효 이름을 유지한다. Escape-취소류 잔여 플래그 없음(리셋할 상태가 draft뿐이고 draft는 step.id 재시드). 기존 `onChange … || "Untitled"` 4곳이 정확히 같은 자리의 draft 패턴(timeout/think 선례)으로 바뀐다.
5. **와이드 행 확장은 wide 게이트로 격리**: 일반 모드 행 렌더를 byte-identical로 두면(R9) 기존 FlowOutline/페이지 테스트가 무수정 green — 회귀 표면이 와이드 경로에 갇힌다.
6. **기존 인스펙터 테스트 대량 갱신은 계획된 비용**: 접힘 기본(R1)은 헤더/바디/검증/추출 입력을 직접 집는 기존 RTL을 깨뜨린다 — RunDialog SLO 접이식 전환(A4a follow-up) 때와 같은 클래스로, 각 테스트 선두에 disclosure 펼침을 추가한다(동작 변경이 아니라 접근 경로 변경). **예외 1건은 구조 재작성**: 헤더-shrinkable 테스트(`Inspector.test.tsx:493-499`)는 `getByPlaceholderText(…).closest("fieldset")`에 `min-w-0`을 단언하는데 헤더가 Request fieldset 밖 `InspectorSection`으로 이동하면 전제 자체가 깨진다 — 새 컨테이너 기준으로 재작성(§4.1의 min-w-0 요구와 짝).
7. **단일 슬라이스 유지(리뷰어 8a/8b 분할 권고 기각)**: 전부 UI-only이고 §8 task가 저위험(이름·섹션) → 와이드 순의 독립 green 커밋이라 리스크가 이미 격리된다. 와이드 설계 홀(detailOpen 리셋·스크롤 소유자·ESC 한계)은 본 spec에서 해소 — 분할은 spec/plan/리뷰/머지 파이프라인 2회전 비용만 추가한다.

---

## 4. 변경 상세

### 4.1 `components/scenario/Inspector.tsx` — 충족 R: R1, R2, R4
- 공용 `InspectorSection`(제목·`aria-expanded` 토글 버튼·힌트 배지·`{open && children}`) 도입 — RunDialog SLO disclosure 이디엄(`<button aria-expanded>` + caret `▸/▾`). **컨테이너에 `min-w-0` 필수**(fieldset `min-width:auto` overflow 함정은 컨테이너 자신에도 적용 — ui/CLAUDE.md canvas-fix; 헤더/바디가 Request fieldset을 떠나므로 새 래퍼가 같은 가드를 이어받는다). 헤더-shrinkable 기존 테스트는 `.closest("fieldset")` 전제가 깨져 새 컨테이너 기준 구조 재작성(§3-6).
- `HttpStepInspector` 재배치: 이름/메서드/URL(+경고)은 유지, `HeadersEditor`·`BodyEditor`(Request fieldset에서 분리)·타임아웃+think 필드(타이밍 섹션으로 묶음)·`AssertEditor`·`ExtractEditor`를 각 `InspectorSection`으로 래핑. 힌트 배지 카운트: 헤더 = active+disabled 합, 검증 = `step.assert.length`, 추출 = `step.extract.length`, 바디 = kind 라벨, 타이밍 = timeout 또는 think 존재.
- 컨테이너 인스펙터(loop/if/parallel) 본문 무변경.

### 4.2 `scenario/editorPrefs.ts` (신규) — 충족 R: R3
- `loadSectionPrefs(): SectionPrefs` / `saveSectionPrefs(p)` — localStorage key `handicap:editor:inspector-sections:v1`, JSON `{headers,body,timing,assert,extract}: boolean`. try/catch fail-soft(불가 시 기본값·no-op), malformed는 기본값. 열림 상태 소유자는 `Inspector()` 최상위(useState lazy-init → toggle 시 save) — 스텝 간 공유가 자연 충족.

### 4.3 `components/scenario/EditorShell.tsx` — 충족 R: R5, R6, R7, R8, R10
- `wideOpen` useState(마운트 수명). 툴바에 토글 버튼(`aria-pressed`, ko 키).
- ON: 그리드를 `[변수?][1fr 아웃라인]`으로 전환(인스펙터 열 미렌더)하고 그리드의 `min-h-[680px]`는 와이드에서 해제(짧은 뷰포트에서 R6 "페이지 스크롤 불증가"와 충돌). **두 번째 스크롤 래퍼를 추가하지 않는다** — `FlowOutline`이 이미 행 영역 `flex-1 overflow-auto` + 하단 add-버튼 고정 구조(`FlowOutline.tsx:578-632`)이므로, 와이드 셀에 뷰포트-기준 bounded 높이(`calc(100vh - 오프셋)`, 오프셋은 구현에서 실측)만 주면 내부 스크롤은 기존 구조가 담당하고 add-버튼은 스크롤 밖 하단 고정(항상 접근 가능). 칩 스트립(`TestFlowChips steps={model.steps} trace={null} selectedStepId onSelect=점프`)은 구분 wrapper `<section aria-label=신규 ko 키>`로 스크롤 영역 **밖** 상단(R7). **셀 flex 체인 제약(plan 전달)**: 와이드 셀은 `flex flex-col`(칩 스트립 `shrink-0`·`FlowOutline` 래퍼 `flex-1 min-h-0`)이어야 하고 셀 자신의 overflow는 와이드에서 스크롤하지 않아야 한다 — 아니면 셀의 기존 `overflow-auto`(`EditorShell.tsx:72`)가 스크롤러가 되어 칩 스트립까지 함께 스크롤돼 R6/R7("스크롤 영역 밖") 위반.
- 편집 모달: `open={wideOpen && detailOpen && selectedStepId!=null}`로 `<Modal title=ko…><Inspector/></Modal>`. 행 활성화 → `detailOpen=true`; 칩 클릭 → 선택+scrollIntoView(`block:"nearest"` — 중첩 스크롤에서 페이지 이동 최소화)만, `detailOpen` 불변. **`detailOpen` 리셋 3지점**(R8): ①모달 onClose ②`selectedStepId===null` 전이(`useEffect` — `removeStep`이 선택을 먼저 clear하므로 모달 내 삭제 닫힘도 이 경로) ③와이드 OFF. 이 리셋이 없으면 삭제 후 stale `detailOpen=true`가 다음 칩 점프에서 모달을 재오픈한다(리뷰어 적발 상태머신 홀).
- **blur-flush(draft 유실 방지, R8)**: 모달 onClose는 `detailOpen` 리셋 **전에** `(document.activeElement as HTMLElement|null)?.blur?.()`를 동기 호출해 blur-커밋 draft(타임아웃·think·JSON 바디·추출 행·loop repeat·분기명·조건 left/right)를 flush한다 — ESC 닫기는 blur 없이 Inspector를 언마운트해 draft를 버리는 경로(T6 blur-on-unmount 미발화 클래스, 리뷰어 적발)이고, 이 flush가 있어야 "닫아도 편집 손실 없음·선택 유지·재오픈 가능"이 성립한다(✕/backdrop은 mousedown이 자연 blur라 원래 안전 — ESC가 유일한 유실 경로였음).
- **알려진 한계(수용·§7 연기)**: 모달 내 팝오버(`VarCheatSheet`·JSON-cast `HelpTip`)가 열린 채 ESC를 누르면 팝오버가 아니라 모달이 닫힌다 — `Modal.tsx` capture-phase ESC `stopPropagation` vs HelpTip bubble-phase ESC(ui/CLAUDE.md 문서화 함정). 위 blur-flush로 편집은 보존되므로 수용; "Inspector 동작 그대로"의 명시적 예외.
- 구현 함정 2건(plan 전달): ① jsdom은 `scrollIntoView` 미구현 — 호출부는 `el.scrollIntoView?.()` 옵셔널 호출 또는 테스트 폴리필. ② 와이드 칩 스트립은 스텝명 DOM 사본을 **세 번째**로 추가(아웃라인 행·test-run 칩·와이드 칩) — 페이지-레벨 RTL 단언은 role/within 스코프 필수(ui/CLAUDE.md editor-test-chips 다중매치 함정의 확장). steps 셀렉터는 인라인 `?? []` 금지(EMPTY_STEPS 모듈 상수 — getSnapshot 함정).

### 4.4 `components/scenario/FlowOutline.tsx` — 충족 R: R7(점프 타깃), R8(행 활성화 훅), R9, R11
- optional prop `wide?: boolean`·`onActivateStep?: (id)=>void` — 미전달(일반 모드) 렌더 byte-identical.
- `wide`/`onActivateStep`은 `FlowOutline` → 재귀 `OutlineRow` → 공유 `RowContent`로 prop 드릴링. `data-step-id`(scrollIntoView 타깃)와 http 행 부가 칩(검증 N·추출 N(title=var 나열)·think min–max)은 **둘 다 wide 게이트** — 비-와이드 DOM이 문자 그대로 byte-identical(R9·R14 정직성). 드래그 오버레이 프리뷰(`RowContent` 재사용)는 wide=false로 전달해 칩 미렌더(오버레이 간결 유지). 행 활성화는 기존 핸들러 동승(클릭/Enter/**Space** — `FlowOutline.tsx:268`)으로 select에 더해 `onActivateStep` 호출(와이드에서만 전달됨). **드래그 핸들의 무이동 클릭은 행으로 버블돼 현재는 무해한 select였지만 와이드에선 모달을 열게 되므로 `onActivateStep` 호출에서 제외**(핸들 타깃 검사 또는 핸들 `stopPropagation` — select 동작은 기존 유지). 드래그 경로(`reorder.ts`·`dropRules.ts`) 무변경.

### 4.5 `Inspector.tsx` 이름 입력 4곳 → 공용 `StepNameField` — 충족 R: R12, R13
- draft useState + step.id 재시드(기존 timeout/think 패턴), onChange: setDraft + non-empty면 `setStepField(...,["name"], v)`, onBlur: trim-빈이면 `setStepField(...,"Untitled")`+draft 동기화. http/loop/if/parallel 4곳 교체(분기 이름 `ParallelBranchEditor`는 기존 draft 패턴 유지·무변경).

### 4.6 `i18n/ko.ts` — 충족 R: R15
- 신규 키: 와이드 토글 라벨/aria, 섹션 제목 5종(기존 키 재사용 가능하면 재사용: `headersLabel` 등), 힌트 배지 포맷(`N개`·"설정됨"·바디 kind 라벨은 기존 `bodyJson`/`bodyForm`/`bodyRaw` 재사용), 편집 모달 제목, **와이드 칩 스트립 구분 wrapper aria-label(신규 키 — `testFlowTitle` 재사용 금지: region-레벨 이름 중복 재발, R7)**. 칩 내부 라벨은 기존 `TestFlowChips` 키 그대로.

### 4.7 `docs/roadmap.md` — 충족 R: R16
- 도그푸딩 잔여 항목 2·3·4·5·6을 §A(또는 성격에 맞는 기존 절)에 등재 — Python 스플라이스 규칙 준수(초장문 라인 Edit 금지).

---

## 5. 무변경 / 불변식 (명시)

- `crates/**`·proto·migration·CSV/XLSX export 0-diff. `ui/src`의 `model.ts`(Zod)·`yamlDoc.ts`·store 액션 시그니처·`reorder.ts`·`dropRules.ts` 무변경.
- 일반(비-와이드) 모드: 아웃라인 행 렌더·그리드 배치 byte-identical(기존 EditorShell/FlowOutline/페이지 테스트 무수정 green이 증거). `TestRunSection`의 기존 `TestFlowChips` 마운트 무변경.
- 이름 커밋 값 규칙 불변: store에 들어가는 값은 기존과 동일하게 "비-빈 문자열 또는 Untitled" — YAML 출력에 새 형태 없음.
- 시나리오 이름(liveName·연필 인라인 편집, scenario-delete-name-sync)은 무접촉 — 이 spec은 *스텝* 이름만 다룬다.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1·R2 | `Inspector.sections.test.tsx`(신규): 기본 접힘·배지 정확-매치·펼침 시 편집기 렌더 + 기존 Inspector 테스트에 펼침 선행 추가(예외: 헤더-shrinkable `min-w-0` 테스트는 새 컨테이너 기준 구조 재작성 — §3-6) | |
| R3 | 같은 파일: 스텝 전환 유지·localStorage 기록/복원/malformed fail-soft (`beforeEach` `localStorage.clear()`) | |
| R4·R14 | 기존 컨테이너/model/yamlDoc/store 테스트 무수정 green + diff 스코프 grep | |
| R5·R6 | RTL 그리드/미렌더 + **Playwright 실측**: 아웃라인 rect 폭 확장·목록 `scrollHeight>clientHeight`·페이지 스크롤 불변 | ✅(시각) |
| R7 | RTL 칩 스트립 within-스코프·칩 클릭 후 모달 부재 + Playwright `scrollTop` 변화 | ✅(시각) |
| R8 | RTL 행 클릭→모달·닫기 후 선택 유지·삭제 시 닫힘·삭제 후 칩 클릭 모달 미재오픈·draft 타이핑 후 ESC 닫기 → store 커밋(blur-flush) | |
| R9 | RTL 와이드 칩 존재/일반 부재 + 기존 FlowOutline 테스트 무수정 | |
| R10 | RTL 재마운트 후 OFF | |
| R11 | 코드 0-diff + Playwright 와이드 `browser_drag` 1회 | ✅(시각) |
| R12·R13 | `StepNameField` RTL: 삭제 중 무스냅·blur Untitled·빈 draft ESC-언마운트 후 store 불변·재편집 정상 | |
| R15 | 한글 하드코딩 sweep 2종(리터럴+ternary-attr) — orchestrator 직접 재실행 | |
| R16 | roadmap.md diff | |

- **라이브 검증**: run-생성/report-파싱/엔진 경로 무접촉이라 `/live-verify` 백엔드 스택 필수 아님. 단 [[implementation-rigor-over-spec]]에 따라 **Playwright 시각 실측은 필수** — `/scenarios/new`는 클라이언트-only(vite dev만으로 가능). DOM-존재·텍스트만으로 PASS 금지: rect 폭·scrollHeight·scrollTop·모달 높이(`getBoundingClientRect`) 실측. 페이지-레벨 RTL은 StrictMode 래핑(scenario-delete-name-sync 선례).
- 게이트: `pnpm lint && pnpm test && pnpm build`(전체). 보안 표면 게이트 N/A 예상(finish-slice §0 grep이 최종 판정).

---

## 7. 의도적 연기 (roadmap §B에 누적)

- **컨테이너(loop/if/parallel) 인스펙터 섹션화**: 본문이 짧고 if 조건 빌더는 접으면 오히려 마찰 — http 대비 편익 낮음. 필요 시 `InspectorSection` 재사용으로 소형 후속.
- **와이드 토글 영속(localStorage)**: 사용자 요청 범위가 §1 섹션 상태만 — 원하면 R3 패턴 1줄 확장.
- **와이드 칩 스트립의 test-run 결과색 연동**: trace가 `TestRunSection` 로컬 state라 끌어올리기 필요 — 조망 목적엔 불필요.
- **모달 내 팝오버 ESC 레이어링(`HelpTip`/`VarCheatSheet`)**: `Modal` capture-ESC가 팝오버보다 먼저 먹는 기존 함정(ui/CLAUDE.md U1a) — 편집 모달에서는 수용된 한계(§4.3), 레이어링 설계(ESC 스택/포커스 위임)는 U5 VerdictBadge 등 다른 Modal-내 popover 수요와 묶어 별도 후속.
- **도그푸딩 항목 2·3·4·5·6**: R16으로 roadmap 등재(각각 별도 슬라이스 — 3은 엔진/와이어, 5·6은 컨트롤러 API 포함).

---

## 8. 구현 순서 (plan 입력)

UI-only라 cargo 게이트는 매 커밋 skip(fast-path). 각 task 독립 green 커밋, **각 task는 테스트 파일 편집을 가장 먼저**(`tdd-guard`가 pending test 없는 `ui/src` 편집을 차단 — ui/CLAUDE.md; import 미해결 RED 무방):

1. **`StepNameField`(R12·R13)** — 독립·최소 diff, 회귀 테스트 포함(RED 먼저).
2. **`InspectorSection` + `HttpStepInspector` 재배치(R1·R2) + `editorPrefs.ts`(R3)** + 기존 Inspector 테스트 펼침-선행 갱신(같은 커밋 — 접힘 기본이 즉시 깨뜨리므로 fold).
3. **와이드 모드 골격(R5·R6·R10)**: EditorShell 토글·그리드·뷰포트 높이·내부 스크롤.
4. **칩 스트립+점프(R7) + 편집 모달(R8)**.
5. **와이드 행 확장(R9) + FlowOutline 훅(R11 확인)**.
6. **ko sweep(R15)·roadmap 등재(R16)·Playwright 시각 실측(§6)**.
