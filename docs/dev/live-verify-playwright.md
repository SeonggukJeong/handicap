# 라이브 검증 — Playwright-MCP 운전법 (도구 메커니즘)

> 이 문서는 **`/live-verify` 할 때만** 읽으면 되는 Playwright-MCP *도구 자체의* 함정 모음이다 — UI 코드 지식과 무관한 순수 도구 메커니즘이라, `ui/` 작업마다 자동 로드되던 `ui/CLAUDE.md`에서 빼냈다(2026-06-28 최적화). UI 거동에 *결합된* 검증 노트("jsdom이 X를 못 잡으니 계약테스트 Y→Playwright Z 실측" 류)는 여전히 `ui/CLAUDE.md`에 인라인으로 남아 있다(그건 UI 짤 때 필요하므로).
>
> **참고**: 아래 "부하 페이싱·일반 라이브 검증" 섹션은 루트 `CLAUDE.md` "로컬 dev 실행 함정"에서 이주한 것(2026-06-28) — 루트엔 토픽 나열 포인터만 남겼다. 이 문서는 그 외에도 `ui/CLAUDE.md`에서 이주한 UI-슬라이스 시각 검증 함정을 담는다.

## 포트 선점 + stale dist = "마이그레이션 안 된 옛 UI 서빙" (design-system-editor 2026-07-04)

- **메인 체크아웃(`/Users/sgj/develop/handicap`)의 dev 컨트롤러가 8080을 선점하고 있으면, 내가 띄운 워크트리 컨트롤러는 bind 실패(또는 곧 죽고 그 자리를 stray가 차지)하고 브라우저는 *메인의 stale dist*를 받는다 — 마이그레이션한 컴포넌트가 옛 markup으로 렌더돼 "구현이 안 됐다"고 오진하게 된다** (포트 선점 footgun의 stale-dist 변종): 증상 = 소스·워크트리 dist는 새 코드(grep 확인)인데 브라우저 렌더는 옛 것. **결정적 진단**: `curl -s http://127.0.0.1:8080/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js'`(서빙 중인 청크 해시) vs `grep -oE 'assets/index-…' ui/dist/index.html`(디스크 해시) — **불일치면 다른 dist를 서빙**. 누가 8080을 쥐었나: `lsof -ti :8080` → `lsof -a -p <PID> -d cwd`(cwd)·`ps -o command= -p <PID>`(args — `--db ./handicap.db` = 메인 dev; `--db /tmp/x.db` = 내 것). ⚠ `ps -o cwd= -p <PID>`는 macOS에서 헤더만 출력하는 버그 있음 → `lsof -a -p <PID> -d cwd` 사용. **회피(안전·비파괴)**: 메인 컨트롤러를 죽이지 말고 **전용 포트 + 절대 `--ui-dir`**로 내 스택을 띄운다 — `./target/debug/controller --db /tmp/x.db --rest 127.0.0.1:8090 --grpc 127.0.0.1:8091 --ui-dir "$PWD/ui/dist"` → Playwright는 `http://127.0.0.1:8090`(다른 origin이라 브라우저 캐시도 fresh). 상대 `--ui-dir ui/dist`는 컨트롤러 cwd 기준이라 드리프트 위험(위 청크 해시 불일치의 근원) → **절대경로**로 못박는다. 시나리오도 8090에 새로 만들어야(POST가 8080 stray로 가면 그 db에 생성됨).

## computed-style 실측 — live 객체 함정

- **`getComputedStyle(el)` 반환은 *live* CSSStyleDeclaration — 변수에 담아두고 포커스/상태를 바꾼 뒤 프로퍼티를 읽으면 *현재*(바뀐) 상태 값이 나온다** (design-system-variants 2026-07-16): focus ring 실측에서 `el.focus(); const cs = getComputedStyle(el); other.focus(); … cs.boxShadow`가 blur 상태 `"none"`을 반환해 거짓 FAIL. 측정 즉시 `String(getComputedStyle(el).boxShadow)`처럼 프리미티브로 고정하고, 요소 하나당 focus→읽기→blur를 한 흐름으로 끝낼 것.

## 스크린샷 경로 / MCP cwd 고정 (시각-충실도 슬라이스)

- **시각-충실도 슬라이스의 라이브 검증 스크린샷: Playwright-MCP cwd가 *삭제된* 과거 워크트리에 고정돼 상대/스크래치패드 경로가 ENOENT/access-denied** (rundialog-mockup-fidelity, 루트 "Playwright cwd 고정" 함정의 스크린샷 변형): `browser_take_screenshot`의 허용 루트는 MCP temp(`/var/folders/.../T/.playwright-mcp`)와 (죽었을 수 있는) 첫-기동 워크트리뿐 → 스크린샷은 **그 MCP temp 절대경로**로 저장 후 `Read`로 뷰. 목업 PNG 대조는 라이브 렌더 스크린샷 vs `docs/superpowers/mockups/*.png`를 둘 다 `Read`(vision)로 비교 — 의도적 잔존(번호 Section 배지·고정 footer 미니그래프·R9 사이징 도우미 카드는 목업이 단순화)은 미스매치 아님. **라이브 검증은 main dev 컨트롤러(8080) 안 죽이게 `--rest 8090 --grpc 8091`로**(소유 PID `lsof`+`ps -o cwd=` 확인 후 내 포트만 kill).

## 파일 업로드 루트 제한

- **Playwright MCP `browser_file_upload`는 repo 루트 밖 경로를 거부한다** (Slice 8c): 허용 루트는 `/Users/sgj/develop/handicap`(워크트리 포함) + `.playwright-mcp/`뿐 — `/tmp`의 파일은 `File access denied`. 브라우저 업로드 점검(데이터셋 등) 시 업로드 대상 파일을 repo 안(예: `.playwright-mcp/`)에 써둔 뒤 절대경로로 넘길 것.
  - **정정(editor-yaml-io 2026-06-29): 허용 루트는 *현재* 워크트리가 아니라 MCP 서버가 *처음 기동된* 워크트리 + MCP temp(`/var/folders/.../T/.playwright-mcp/`)에 고정된다** (MCP cwd 고정 footgun의 업로드판) — 다른 워크트리에서 검증하면 현재 워크트리의 `.playwright-mcp/`도 거부(`outside allowed roots. Allowed roots: …/T/.playwright-mcp, …/worktrees/<옛-워크트리>`). **회피: 업로드 픽스처를 MCP temp 디렉터리에 쓰고 그 절대경로로 `browser_file_upload`**(다운로드도 거기 떨어지니 같은 디렉터리). 그리고 **MCP가 file chooser를 자체 인터셉트**하므로 인라인 `page.once('filechooser', fc=>fc.setFiles())`보다 MCP가 우선 — 보이는 버튼을 `browser_click`한 뒤 `browser_file_upload`로 파일을 넘기는 게 정석(인라인 setFiles는 무시됨).

## 다운로드(File System Access / blob) 검증 — headless picker 함정

- **headless Chromium에서 `window.showSaveFilePicker`는 *함수로 존재*한다(localhost=secure context)** (editor-yaml-io): 그래서 picker-우선 다운로드 코드(`saveViaPicker`→실패 시 blob 폴백)를 헤드리스로 클릭하면 실 picker가 UI 없이 **hang**(`waitForEvent('download')` 타임아웃) — plan이 "headless엔 picker 부재"를 가정하면 어긋난다. **blob 폴백 경로(=air-gapped 실사용 경로)를 결정적으로 실측하려면 클릭 전에 `page.evaluate(()=>{ window.showSaveFilePicker=undefined })`로 picker를 지워** `saveViaPicker`가 즉시 false→`saveViaBlobUrl`(anchor download)로 떨어지게 한 뒤 `page.waitForEvent('download')`로 `suggestedFilename()`+`createReadStream()` 내용 검증. 실 picker.call(window) bound-call 자체는 헤드리스로 못 덮으니(non-Abort throw→blob 폴백이라 bound-this 버그조차 같은 결과로 흡수됨) real-Chrome nice-to-have(비차단).

## 라이브 검증 도중 src 편집(fold-in fix)은 HMR full-reload로 페이지 상태를 리셋한다

- **vite dev로 라이브 검증하다가 검증 대상 컴포넌트 src를 고치면(사용자 fold-in fix 흐름) HMR이 full-reload로 떨어져 클라이언트-only 페이지 상태가 초기화된다** (extract-var-name-visibility): `/scenarios/new`가 템플릿 피커로 되돌아가 이전에 구성한 시나리오/변수/선택이 증발 — 이전 툴 호출에서 잡아둔 ref/좌표도 전부 무효. 편집 후 재검증은 **셋업(템플릿 선택→변수 추가→필드 fill)부터 다시 구동**하고, fresh `browser_snapshot`으로 ref를 재취득할 것(오류가 아니라 정상 리로드 — "구현이 사라졌다" 오진 금지).

## 트랜지언트 상태는 단일 `browser_evaluate`로

- **트랜지언트 UI 상태(예: '복사됨' 1.5s 후 복귀)는 Playwright MCP 툴 호출 *사이*로 못 잡는다** (본문 뷰어 수동검증): `browser_click` → `browser_snapshot`을 별도 호출로 쪼개면 inter-call 지연이 revert 윈도우를 넘겨 이미 되돌아온 값을 본다. **단일 `browser_evaluate`** 안에서 `el.click()` → `await sleep(150)`(writeText microtask+React 렌더) → label 확인 → `await sleep(1700)` → revert 확인까지 한 번에. clipboard 검증도 같은 evaluate에서 `navigator.clipboard.readText()`(localhost=secure context라 허용).

## 부하 페이싱·일반 라이브 검증 (루트 CLAUDE.md에서 이주)

- UI 라운드트립은 Playwright — `browser_take_screenshot` 상대경로 파일은 **repo 루트**, `browser_snapshot`은 `.playwright-mcp/*.yml`에 떨어지고 **둘 다 gitignore 안 됨** → 머지 전 `rm -rf .playwright-mcp` + 루트 png 정리(안 하면 worktree 머지 시 untracked 잔류). **함정: Playwright MCP 서버의 cwd는 그 서버가 처음 기동된 워크트리에 고정된다 — 이전 세션의(삭제됐을 수 있는) 워크트리일 수 있다** (phase-breakdown): 그래서 `filename:` 상대 저장은 *현재* 워크트리가 아니라 그 고정-cwd로 가고(삭제됐으면 `ENOENT`), 위 "현재 디렉터리 정리"가 못 잡는다(역으로 현재 워크트리는 안 더럽혀질 수도). **라이브 검증은 `filename` 없는 인라인 `browser_snapshot`/`browser_evaluate`로** — 페이지 상태를 텍스트로 직접 뽑는 게 저장-경로 의존 없이 결정적이다(이번엔 step 테이블 헤더/셀을 `browser_evaluate`로 추출해 다운로드 컬럼 유무를 검증). **React controlled input은 `browser_type`이 아니라 evaluate 안에서 native setter로**: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v)` + `el.dispatchEvent(new Event('input',{bubbles:true}))` (U3 라이브 검증). **같은 evaluate 안에서 `el.click()` 직후 DOM을 읽으면 React 렌더 *전* 상태를 본다**(React 18 batching) — 클릭과 단언을 별도 evaluate 호출로 분리. **특히 접이식 섹션을 토글한 *같은* evaluate에서 `document.body.innerText`로 그 안의 힌트/배지 존재를 판정하면 아직 렌더 전이라 *거짓 부재*가 나온다**(think-time-defaults: 타이밍 섹션 토글+상속 힌트 읽기를 한 호출에 묶어 "기능이 안 붙었다"로 오진 → 별도 evaluate에서 정상 확인). 힌트가 접힌 섹션 안에 산다면 "펼치기"와 "읽기"는 반드시 두 호출. **`browser_console_messages({all:true})`는 cross-session 버퍼를 돌려준다** (lan-l7 라이브): MCP 서버가 세션을 넘어 살아 있어 *이전 세션*의 stale 메시지(예: 컨트롤러가 죽었던 때의 `ERR_CONNECTION_REFUSED` 수백 개)가 섞여 나와 "라이브 실패"로 오인하게 한다 — 이번 슬라이스의 Zod-0 체크는 `all` 없이(현재 navigation만) 보고, fresh `browser_navigate` 직후 확인할 것. CONNECTION_REFUSED 같은 *네트워크-리소스* 에러는 Zod/앱 에러가 아니다(controller `curl 200`으로 살아있음 교차확인). **stale 판별 신호(dataset-preview-optin 2026-07-16)**: `all:true`가 돌려준 에러들이 *이 슬라이스가 폐기한 옛 상수*(예: `limit=50` — 새 기본은 10)나 *현재 격리 DB에 없는 리소스 id*를 담고 있으면 확실히 이전 세션 잔재다 — `all:false`가 현재-세션 0을 확증하면 PASS.

## 에디터 held-drag 검증 (editor-reparent-dnd 2026-07-02)

- **상대 URL fixture는 "시나리오 문제 N건" 검증 배너를 만들고, 이 배너가 *늦게* 렌더되며 아웃라인을 ~200px 밀어낸다** — 별도 툴 호출에서 미리 추출해 둔 행 좌표가 드래그 도중 무효화되어 엉뚱한(합법인) 행을 잡거나 엉뚱한 밴드에 드롭된다(재현: s1 드래그가 L1↔I1 재정렬/P.branch_0 착지로 둔갑). 회피 3종 세트: ① fixture URL은 절대(`http://127.0.0.1:9999/...`)로 만들어 배너 자체를 제거 ② 좌표 추출→드래그→검증을 **단일 `browser_run_code_unsafe`** 안에서 ③ 드래그 전 레이아웃 안정 대기(행 rect 스냅샷 2회 연속 일치까지 폴링).
- **dnd-kit PointerSensor 활성화 플레이크**: `mouse.down` 직후 바로 `mouse.move`하면 드래그가 활성화되지 않을 수 있다(한 세션 1회 재현 — 샘플이 전부 idle 상태로 나와 "불법이라 제외"로 오독할 뻔). down→move 사이 ~100ms 대기 + `document.querySelector('[aria-pressed="true"]')` 프로브로 **활성화를 단언한 뒤** 판정 샘플을 신뢰할 것. mid-drag 상태 프로브는 소스 wrapper `[class*="opacity-0"]` 존재(드래그 생존)·인디케이터 `[class*="border-t-accent-500"],[class*="border-b-accent-500"]`·밴드 하이라이트 `[class*="bg-accent-50/60"]` 카운트 + **드래그 전 baseline 샘플**(대시보드에 상시 존재하는 border-dashed류 오염 제거)이 결정적이다.

## Monaco(YAML 모달) 자동화 (scenario-delete-name-sync 2026-07-03)

- **멀티라인 `document.execCommand('insertText')`는 Monaco auto-indent를 타서 라인마다 들여쓰기가 복리로 붕괴**(YAML 파싱 실패 → 커밋 안 됨 — 첫 N줄만 확인하면 못 본다, 전체 라인 덤프로 검증). **`{`로 시작하는 삽입은 auto-closing bracket이 잉여 `}` 1개를 덧붙인다**(brace 불균형 → "Unexpected flow-map-end token"). 회피: **한 줄 flow-style YAML**(`{version: 1, name: x, steps: [{...}]}`)로 전체 교체(개행 0 = auto-indent 원천 회피) 후 `ControlOrMeta+End`+`Backspace`로 끝 잉여 문자 제거. 삽입 전 `.monaco-editor .view-lines` 클릭(hidden textarea는 view-line이 포인터 가로챔) + `ControlOrMeta+a`.
- **YAML 모달 편집은 디바운스 300ms 후 `commitPendingYaml`로 *모달 닫기 없이* 라이브 커밋된다**(`MonacoYamlView.tsx`) — 헤더/브레드크럼 즉시-갱신 단언은 모달 열린 채 ~500ms 대기로 충분. 파싱 실패 시 커밋되지 않고 pendingYamlText가 남아 재오픈 시 깨진 버퍼가 그대로 보인다("시나리오 문제 N건" 배너 = 제품 정상 동작, 자동화 아티팩트와 구분할 것). 모달 내 키보드 Cmd+Z undo는 안 먹을 수 있다.

## 뷰포트-고정(내부 스크롤) 레이아웃 실측 (editor-space-qol 2026-07-03)

- **뷰포트에 고정되고 내부에서 스크롤되는 컨테이너(예: '스텝 넓게 보기' 와이드 셀 `max-h-[calc(100vh-16rem)]`)의 '페이지가 안 커진다' 검증은 *캡된 셀의* `getBoundingClientRect().height`로 판정 — `document.documentElement.scrollHeight`는 오염된다**: 상대/빈-URL fixture는 '시나리오 문제 N건' amber 검증 배너(스텝 수에 비례, 24스텝 = ~622px)를 그리드 *위에* 렌더해 페이지 높이를 수백 px 부풀린다(page overflow가 레이아웃 결함처럼 보임). 실제 셀은 정상적으로 뷰포트 캡돼 내부 스크롤(`scroller.scrollHeight > clientHeight`)한다 → 셀 rect 높이가 `calc(100vh-오프셋)`와 일치하고 스텝 수에 불변인지, 그리고 같은 시나리오에서 wide-ON page height ≤ wide-OFF page height인지(더 커지지 않음)를 본다. 배너를 없애려면 fixture URL을 절대(`http://127.0.0.1:.../x`)로. (배너 자체 footgun은 위 held-drag 섹션.)

## yamlError 편집 게이트 라이브 검증 (editor-gate-errpct-fixes 2026-07-04)

- **깨진 YAML(`yamlError`) 상태를 만들려면 Monaco 모달에 `x: y: z`(멀티콜론 매핑 — brackets/braces가 없어 auto-close 회피, 한 줄이라 auto-indent 오염도 0)를 select-all 후 타이핑**: `.monaco-editor .view-lines` 클릭→`ControlOrMeta+a`→`Delete`→`type('x: y: z')`→`waitForTimeout(700)`(디바운스 300ms 후 `commitPendingYaml`이 parse 실패로 `yamlError` 설정). 순수 UI라 백엔드 불필요 — `pnpm exec vite --port 5199 --strictPort` dev 서버 + `localhost`(vite는 IPv6 `[::1]`만 바인드) navigate로 충분.
- **브라우저는 store(`useScenarioEditor`)를 window에 안 노출** → R1 store no-op은 직접 못 읽고 **outline 라벨 + block-notice 배너 지속으로 프록시 검증**: Inspector name 입력을 native setter(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'HACKED')`+`input`/`change`/`blur` dispatch)로 "HACKED"로 편집 후 별도 evaluate에서 (a) 아웃라인 행 `[role=option]` aria-label 불변(=`model.name` 미변이=게이트 no-op) (b) 편집차단 배너 지속(=`yamlError` 미클리어 = 이 슬라이스가 고친 **버그 시그니처**의 부재)을 단언. 로컬 draft 입력값은 "HACKED"로 보여도 model은 불변(commit-on-blur draft라 정상).
- **연필(R2)은 `/scenarios/new`(ScenarioNewPage=plain name Input, 연필 없음)엔 없고 저장 시나리오 `ScenarioEditPage`(`/scenarios/{id}`)에만 렌더**(aria `시나리오 이름 편집`) — 메인 dev 컨트롤러(8080)의 기존 시나리오를 전용포트 Vite dev로 로드해 read-only 검증(YAML을 깨도 저장 안 하면 DB 무변경). native `disabled` 드래그 무이동은 disabled 핸들에 `page.mouse.down→move(+80px)→up` 후 row `getBoundingClientRect().y` delta 0 + `[aria-pressed="true"]` 미발생(dnd-kit 미활성)으로 실측(disabled 버튼은 pointer 이벤트 미수신). 콘솔 `favicon.ico` 404는 네트워크 리소스라 앱 에러 아님(Zod/getSnapshot/key 경고 0이 진짜 clean 신호).

## RunDialog 라디오 타일·라벨 겹침 스코핑 (open-loop-rate-labels 2026-07-12)

- **RunDialog 부하모델 타일 radio는 `<label>` 요소가 아니라 `label:has-text(...)` 셀렉터가 미매치하고, accname도 `aria-label`이 아니라 `input.labels[0]`에서 온다** — evaluate 안에서 `input[type=radio]`를 모아 `labels[0].textContent`로 이름을 뽑아 `.click()`. 카피 개명으로 타일 제목·입력 라벨·HelpTip이 같은 단어("도착률")를 공유하면 전체-input 스캔의 첫 매치가 radio일 수 있다 — **값 입력 대상은 `input[type="number"]`로 스코프**하고, 정확 라벨은 공백 유무로 구분(타일 "도착률 (초당 반복)" vs 입력 "도착률(초당 반복)" — ko 표 #13/#9의 의도적 구분·RTL 정규식 tightening과 같은 트릭). 다이얼로그 제출 버튼("실행하기")도 `[role="dialog"]` 스코프 셀렉터가 미매치할 수 있어 evaluate에서 텍스트 정확일치로 찾는 게 결정적.

## useBlocker/beforeunload 이탈 가드 검증 (unsaved-changes-guard 2026-07-12)

- **차단된 내비게이션에서 `browser_navigate_back`(=page.goBack)은 "waiting for navigation until commit" 60s 타임아웃으로 끝난다 — 이게 차단 *성공*의 정상 신호다**(에러로 오진 금지: useBlocker가 POP을 막아 commit할 내비게이션이 없다). 검증은 goBack 대신 `browser_evaluate`로 `history.back()`(즉시 반환) 발사 후 **별도 evaluate**에서 모달 존재/URL 잔류 단언.
- **cross-document back은 라우터 blocker가 아니라 beforeunload가 잡는다**: `browser_navigate`(page.goto)는 풀 로드 = 새 문서라, 그 직후 back은 이전 *문서*로의 언로드 → dirty면 네이티브 beforeunload 다이얼로그가 뜬다(MCP가 "Modal state: beforeunload dialog"로 표면화 → `browser_handle_dialog`). useBlocker의 POP 차단을 실측하려면 **same-document 히스토리**가 필요 — SPA 링크 체인(헤더/목록 링크 클릭으로 엔트리 축적) 후 `history.back()`. 둘 다 "가드 동작"이지만 발동 레이어가 다르다.
- **beforeunload 실측은 비동기 스케줄 후 handle**: `browser_evaluate`로 `setTimeout(()=>location.reload(),100)`(evaluate가 다이얼로그 전에 반환) → 다음 툴 호출의 Modal state 보고를 `browser_handle_dialog(accept:…)`로 처리. accept=true면 reload 진행(dirty 데이터 소실 확인 가능), false면 잔류. clean 상태 대조군은 같은 스케줄-reload가 무다이얼로그로 통과하는지로.

## 클라-only 에디터 검증 — 동명 버튼·vite proxy 500 (editor-var-conflict-quickadd 2026-07-12)

- **동명 버튼을 페이지-wide 스캔으로 클릭하지 말 것**: 변수 패널 하단 "추가"와 테스트 패널 환경변수 "추가"가 같은 텍스트라 `[...querySelectorAll('button')].filter(t==='추가')`의 last-match `.click()`이 엉뚱한 버튼을 잡고도 `clicked:true`로 성공처럼 보인다(패널 상태 무변화가 유일한 신호 — 별도 evaluate 재검증으로만 발견). 앵커 요소(예: `input[placeholder="new_var"]`)에서 `parentElement`를 타고 올라가며 같은 컨테이너 안의 버튼을 찾아 클릭.
- **백엔드 없는 클라-only 검증(`pnpm dev` 단독)에서 `/api/*`는 CONNECTION_REFUSED가 아니라 vite proxy가 500으로 표면화**: 콘솔 `Failed to load resource: 500 (/api/environments)`는 네트워크 리소스 에러(앱/Zod 에러 아님) — favicon 404와 같은 부류로 취급하고, 진짜 clean 신호는 Zod/React/getSnapshot 에러 0.
