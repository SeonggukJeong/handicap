# 라이브 검증 — Playwright-MCP 운전법 (도구 메커니즘)

> 이 문서는 **`/live-verify` 할 때만** 읽으면 되는 Playwright-MCP *도구 자체의* 함정 모음이다 — UI 코드 지식과 무관한 순수 도구 메커니즘이라, `ui/` 작업마다 자동 로드되던 `ui/CLAUDE.md`에서 빼냈다(2026-06-28 최적화). UI 거동에 *결합된* 검증 노트("jsdom이 X를 못 잡으니 계약테스트 Y→Playwright Z 실측" 류)는 여전히 `ui/CLAUDE.md`에 인라인으로 남아 있다(그건 UI 짤 때 필요하므로).
>
> **참고**: 루트 `CLAUDE.md`의 "로컬 dev 실행 함정" 섹션에도 Playwright-MCP 함정이 더 있다(상시 로드) — `browser_take_screenshot` 상대경로=repo 루트·`browser_snapshot`=`.playwright-mcp/*.yml`(둘 다 gitignore 안 됨→머지 전 정리)·React controlled input은 native setter+`dispatchEvent('input')`·`el.click()` 직후 같은 evaluate 내 DOM 읽기는 React 18 batching으로 렌더 *전* 상태·`browser_console_messages({all:true})`는 cross-session 버퍼. 그쪽은 부하 페이싱/일반 라이브 검증용이고, 이 문서는 `ui/CLAUDE.md`에서 이주한 UI-슬라이스 검증용.

## 스크린샷 경로 / MCP cwd 고정 (시각-충실도 슬라이스)

- **시각-충실도 슬라이스의 라이브 검증 스크린샷: Playwright-MCP cwd가 *삭제된* 과거 워크트리에 고정돼 상대/스크래치패드 경로가 ENOENT/access-denied** (rundialog-mockup-fidelity, 루트 "Playwright cwd 고정" 함정의 스크린샷 변형): `browser_take_screenshot`의 허용 루트는 MCP temp(`/var/folders/.../T/.playwright-mcp`)와 (죽었을 수 있는) 첫-기동 워크트리뿐 → 스크린샷은 **그 MCP temp 절대경로**로 저장 후 `Read`로 뷰. 목업 PNG 대조는 라이브 렌더 스크린샷 vs `docs/superpowers/mockups/*.png`를 둘 다 `Read`(vision)로 비교 — 의도적 잔존(번호 Section 배지·고정 footer 미니그래프·R9 사이징 도우미 카드는 목업이 단순화)은 미스매치 아님. **라이브 검증은 main dev 컨트롤러(8080) 안 죽이게 `--rest 8090 --grpc 8091`로**(소유 PID `lsof`+`ps -o cwd=` 확인 후 내 포트만 kill).

## 파일 업로드 루트 제한

- **Playwright MCP `browser_file_upload`는 repo 루트 밖 경로를 거부한다** (Slice 8c): 허용 루트는 `/Users/sgj/develop/handicap`(워크트리 포함) + `.playwright-mcp/`뿐 — `/tmp`의 파일은 `File access denied`. 브라우저 업로드 점검(데이터셋 등) 시 업로드 대상 파일을 repo 안(예: `.playwright-mcp/`)에 써둔 뒤 절대경로로 넘길 것.

## 트랜지언트 상태는 단일 `browser_evaluate`로

- **트랜지언트 UI 상태(예: '복사됨' 1.5s 후 복귀)는 Playwright MCP 툴 호출 *사이*로 못 잡는다** (본문 뷰어 수동검증): `browser_click` → `browser_snapshot`을 별도 호출로 쪼개면 inter-call 지연이 revert 윈도우를 넘겨 이미 되돌아온 값을 본다. **단일 `browser_evaluate`** 안에서 `el.click()` → `await sleep(150)`(writeText microtask+React 렌더) → label 확인 → `await sleep(1700)` → revert 확인까지 한 번에. clipboard 검증도 같은 evaluate에서 `navigator.clipboard.readText()`(localhost=secure context라 허용).
