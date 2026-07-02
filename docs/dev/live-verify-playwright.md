# 라이브 검증 — Playwright-MCP 운전법 (도구 메커니즘)

> 이 문서는 **`/live-verify` 할 때만** 읽으면 되는 Playwright-MCP *도구 자체의* 함정 모음이다 — UI 코드 지식과 무관한 순수 도구 메커니즘이라, `ui/` 작업마다 자동 로드되던 `ui/CLAUDE.md`에서 빼냈다(2026-06-28 최적화). UI 거동에 *결합된* 검증 노트("jsdom이 X를 못 잡으니 계약테스트 Y→Playwright Z 실측" 류)는 여전히 `ui/CLAUDE.md`에 인라인으로 남아 있다(그건 UI 짤 때 필요하므로).
>
> **참고**: 아래 "부하 페이싱·일반 라이브 검증" 섹션은 루트 `CLAUDE.md` "로컬 dev 실행 함정"에서 이주한 것(2026-06-28) — 루트엔 토픽 나열 포인터만 남겼다. 이 문서는 그 외에도 `ui/CLAUDE.md`에서 이주한 UI-슬라이스 시각 검증 함정을 담는다.

## 스크린샷 경로 / MCP cwd 고정 (시각-충실도 슬라이스)

- **시각-충실도 슬라이스의 라이브 검증 스크린샷: Playwright-MCP cwd가 *삭제된* 과거 워크트리에 고정돼 상대/스크래치패드 경로가 ENOENT/access-denied** (rundialog-mockup-fidelity, 루트 "Playwright cwd 고정" 함정의 스크린샷 변형): `browser_take_screenshot`의 허용 루트는 MCP temp(`/var/folders/.../T/.playwright-mcp`)와 (죽었을 수 있는) 첫-기동 워크트리뿐 → 스크린샷은 **그 MCP temp 절대경로**로 저장 후 `Read`로 뷰. 목업 PNG 대조는 라이브 렌더 스크린샷 vs `docs/superpowers/mockups/*.png`를 둘 다 `Read`(vision)로 비교 — 의도적 잔존(번호 Section 배지·고정 footer 미니그래프·R9 사이징 도우미 카드는 목업이 단순화)은 미스매치 아님. **라이브 검증은 main dev 컨트롤러(8080) 안 죽이게 `--rest 8090 --grpc 8091`로**(소유 PID `lsof`+`ps -o cwd=` 확인 후 내 포트만 kill).

## 파일 업로드 루트 제한

- **Playwright MCP `browser_file_upload`는 repo 루트 밖 경로를 거부한다** (Slice 8c): 허용 루트는 `/Users/sgj/develop/handicap`(워크트리 포함) + `.playwright-mcp/`뿐 — `/tmp`의 파일은 `File access denied`. 브라우저 업로드 점검(데이터셋 등) 시 업로드 대상 파일을 repo 안(예: `.playwright-mcp/`)에 써둔 뒤 절대경로로 넘길 것.
  - **정정(editor-yaml-io 2026-06-29): 허용 루트는 *현재* 워크트리가 아니라 MCP 서버가 *처음 기동된* 워크트리 + MCP temp(`/var/folders/.../T/.playwright-mcp/`)에 고정된다** (MCP cwd 고정 footgun의 업로드판) — 다른 워크트리에서 검증하면 현재 워크트리의 `.playwright-mcp/`도 거부(`outside allowed roots. Allowed roots: …/T/.playwright-mcp, …/worktrees/<옛-워크트리>`). **회피: 업로드 픽스처를 MCP temp 디렉터리에 쓰고 그 절대경로로 `browser_file_upload`**(다운로드도 거기 떨어지니 같은 디렉터리). 그리고 **MCP가 file chooser를 자체 인터셉트**하므로 인라인 `page.once('filechooser', fc=>fc.setFiles())`보다 MCP가 우선 — 보이는 버튼을 `browser_click`한 뒤 `browser_file_upload`로 파일을 넘기는 게 정석(인라인 setFiles는 무시됨).

## 다운로드(File System Access / blob) 검증 — headless picker 함정

- **headless Chromium에서 `window.showSaveFilePicker`는 *함수로 존재*한다(localhost=secure context)** (editor-yaml-io): 그래서 picker-우선 다운로드 코드(`saveViaPicker`→실패 시 blob 폴백)를 헤드리스로 클릭하면 실 picker가 UI 없이 **hang**(`waitForEvent('download')` 타임아웃) — plan이 "headless엔 picker 부재"를 가정하면 어긋난다. **blob 폴백 경로(=air-gapped 실사용 경로)를 결정적으로 실측하려면 클릭 전에 `page.evaluate(()=>{ window.showSaveFilePicker=undefined })`로 picker를 지워** `saveViaPicker`가 즉시 false→`saveViaBlobUrl`(anchor download)로 떨어지게 한 뒤 `page.waitForEvent('download')`로 `suggestedFilename()`+`createReadStream()` 내용 검증. 실 picker.call(window) bound-call 자체는 헤드리스로 못 덮으니(non-Abort throw→blob 폴백이라 bound-this 버그조차 같은 결과로 흡수됨) real-Chrome nice-to-have(비차단).

## 트랜지언트 상태는 단일 `browser_evaluate`로

- **트랜지언트 UI 상태(예: '복사됨' 1.5s 후 복귀)는 Playwright MCP 툴 호출 *사이*로 못 잡는다** (본문 뷰어 수동검증): `browser_click` → `browser_snapshot`을 별도 호출로 쪼개면 inter-call 지연이 revert 윈도우를 넘겨 이미 되돌아온 값을 본다. **단일 `browser_evaluate`** 안에서 `el.click()` → `await sleep(150)`(writeText microtask+React 렌더) → label 확인 → `await sleep(1700)` → revert 확인까지 한 번에. clipboard 검증도 같은 evaluate에서 `navigator.clipboard.readText()`(localhost=secure context라 허용).

## 부하 페이싱·일반 라이브 검증 (루트 CLAUDE.md에서 이주)

- UI 라운드트립은 Playwright — `browser_take_screenshot` 상대경로 파일은 **repo 루트**, `browser_snapshot`은 `.playwright-mcp/*.yml`에 떨어지고 **둘 다 gitignore 안 됨** → 머지 전 `rm -rf .playwright-mcp` + 루트 png 정리(안 하면 worktree 머지 시 untracked 잔류). **함정: Playwright MCP 서버의 cwd는 그 서버가 처음 기동된 워크트리에 고정된다 — 이전 세션의(삭제됐을 수 있는) 워크트리일 수 있다** (phase-breakdown): 그래서 `filename:` 상대 저장은 *현재* 워크트리가 아니라 그 고정-cwd로 가고(삭제됐으면 `ENOENT`), 위 "현재 디렉터리 정리"가 못 잡는다(역으로 현재 워크트리는 안 더럽혀질 수도). **라이브 검증은 `filename` 없는 인라인 `browser_snapshot`/`browser_evaluate`로** — 페이지 상태를 텍스트로 직접 뽑는 게 저장-경로 의존 없이 결정적이다(이번엔 step 테이블 헤더/셀을 `browser_evaluate`로 추출해 다운로드 컬럼 유무를 검증). **React controlled input은 `browser_type`이 아니라 evaluate 안에서 native setter로**: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v)` + `el.dispatchEvent(new Event('input',{bubbles:true}))` (U3 라이브 검증). **같은 evaluate 안에서 `el.click()` 직후 DOM을 읽으면 React 렌더 *전* 상태를 본다**(React 18 batching) — 클릭과 단언을 별도 evaluate 호출로 분리. **`browser_console_messages({all:true})`는 cross-session 버퍼를 돌려준다** (lan-l7 라이브): MCP 서버가 세션을 넘어 살아 있어 *이전 세션*의 stale 메시지(예: 컨트롤러가 죽었던 때의 `ERR_CONNECTION_REFUSED` 수백 개)가 섞여 나와 "라이브 실패"로 오인하게 한다 — 이번 슬라이스의 Zod-0 체크는 `all` 없이(현재 navigation만) 보고, fresh `browser_navigate` 직후 확인할 것. CONNECTION_REFUSED 같은 *네트워크-리소스* 에러는 Zod/앱 에러가 아니다(controller `curl 200`으로 살아있음 교차확인).

## 에디터 held-drag 검증 (editor-reparent-dnd 2026-07-02)

- **상대 URL fixture는 "시나리오 문제 N건" 검증 배너를 만들고, 이 배너가 *늦게* 렌더되며 아웃라인을 ~200px 밀어낸다** — 별도 툴 호출에서 미리 추출해 둔 행 좌표가 드래그 도중 무효화되어 엉뚱한(합법인) 행을 잡거나 엉뚱한 밴드에 드롭된다(재현: s1 드래그가 L1↔I1 재정렬/P.branch_0 착지로 둔갑). 회피 3종 세트: ① fixture URL은 절대(`http://127.0.0.1:9999/...`)로 만들어 배너 자체를 제거 ② 좌표 추출→드래그→검증을 **단일 `browser_run_code_unsafe`** 안에서 ③ 드래그 전 레이아웃 안정 대기(행 rect 스냅샷 2회 연속 일치까지 폴링).
- **dnd-kit PointerSensor 활성화 플레이크**: `mouse.down` 직후 바로 `mouse.move`하면 드래그가 활성화되지 않을 수 있다(한 세션 1회 재현 — 샘플이 전부 idle 상태로 나와 "불법이라 제외"로 오독할 뻔). down→move 사이 ~100ms 대기 + `document.querySelector('[aria-pressed="true"]')` 프로브로 **활성화를 단언한 뒤** 판정 샘플을 신뢰할 것. mid-drag 상태 프로브는 소스 wrapper `[class*="opacity-0"]` 존재(드래그 생존)·인디케이터 `[class*="border-t-accent-500"],[class*="border-b-accent-500"]`·밴드 하이라이트 `[class*="bg-accent-50/60"]` 카운트 + **드래그 전 baseline 샘플**(대시보드에 상시 존재하는 border-dashed류 오염 제거)이 결정적이다.
