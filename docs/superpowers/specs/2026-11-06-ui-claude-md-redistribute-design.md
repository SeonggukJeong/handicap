# ui/CLAUDE.md 재분배 1차 — RunDialog 계열 `components/run/` 이동(§B17) + 하위 문서 원문 이동 + 게이트 확장 (설계)

- 유형: platform(소스 이동 리팩터) + internal-polish(문서) · 날짜: 2026-11-06 · base `57830b90`
- **상태: 완료** (2026-11-07, 코드 `06065f74`..`50591319`). 연기·판단 → `docs/roadmap.md` §B44, 결과 → `docs/build-log.md` ui-claude-md-redistribute 단락.
- 트리거: `just doc-budget`이 `WARN [래칫] ui/CLAUDE.md +10,911 B (기준 102,395 → 113,306)`를 낸다. roadmap-status 문서 행의 "재분배안 B"와 roadmap §B17(2026-07-07 연기)을 함께 회수한다.
- 사용자 우선순위(2026-11-06 대화): **① 비용**(ui/ 세션마다 통째로 로드되는 크기) → **② 효율**(지금 만지는 코드와 무관한 함정은 로드되지 않게) → **③ 경고 제거**. 그리고 **"회귀가 없도록 확실히 검증"**.
- **2단 분할(사용자 결정 2026-11-06, spec 리뷰 R1 권고)**
  - **1차(이 문서)**: 소스 이동 + 불릿 **원문 그대로** 이동 + 게이트 확장.
  - **2차(후속 슬라이스)**: ui/CLAUDE.md에 남은 불릿의 서사 압축 → 60 KiB 이하.
  - 분할 이유: 압축은 선례에서 이관 조각 속 현행 계약 12건이 적발된 오류 다발 작업이다. 검증 방식도 "줄 집합 동치"와 달라 따로 다루는 편이 회귀 위험을 격리한다.
- 선례: ui-claude-md-curation(`docs/superpowers/specs/2026-08-03-ui-claude-md-curation-design.md`), 2026-07-07 ui 하위 분할(`e2a214a`). 절차 정본은 `docs/dev/root-doc-maintenance.md`.
- 동반 파일
  - `2026-11-06-ui-claude-md-redistribute-bullet-map.tsv` — subagent의 **초안 분류**(가설). plan이 §3.2 기준으로 행마다 재판정한다.
  - `2026-11-06-ui-claude-md-redistribute-importers.py` — 이동 모듈 소비처 스캔. 사용법: `python3 -I <이 파일> ui/src`.

## 사용자 스토리 (US)

- **US1**: 개발자-도구가 RunDialog 계열이 아닌 `ui/` 코드를 고치는 세션을 시작할 때, 지금은 ui/CLAUDE.md **113,306 B**가 통째로 로드된다(초안 분류상 run 계열 전용 ~23 KB·에디터 모델/컴포넌트 전용 ~21 KB 포함 — 추정치). 성공하면 ui/CLAUDE.md 자체가 **≤ 92,160 B(90 KiB)**로 줄고, `just doc-budget`의 래칫 WARN이 0건이다.
  - **상한 재설정(사용자 결정 2026-11-07):** plan 단계의 확정 분류 산출이 **≈ 89,369 B**로 원 상한 84 KiB를 넘어 STOP했다. 사용자가 분류 유지 + 상한 90 KiB를 택했다. 경계 5행(86·94·177·178·188)은 숫자 맞추기용 재분류를 하지 않고 잔류한다.
  - 사용자가 승인한 원 목표 60 KiB는 2차 슬라이스(압축)의 US다.
  - 분할 결정 때 제시한 "약 65 KB"는 초안 분류를 그대로 쓴 수치였다. §3.2를 엄격히 적용하면(경계에 걸친 RUN 8행·SCENARIO 2행·REPORT 2행 잔류, compare-15·머리 목록 추가) 리뷰 R2 추정은 **약 80 KB**다. 그래서 처음엔 84 KiB를 상한으로 뒀다(위 재설정으로 대체).
  - **우선순위: no-forget·§3.2 > 수치.** plan 첫 스텝이 확정 `mistake_sites`로 크기를 사전 산출한다. 상한을 넘으면 STOP하고 사용자에게 묻는다. 수치를 맞추려고 분류를 바꾸지 않는다.
  - 에디터 세션은 여전히 ui/CLAUDE.md + 해당 하위 문서를 함께 로드한다. US1은 ui/CLAUDE.md 크기에 대한 약속이다.
- **US2**: 개발자-도구가 RunDialog·스케줄·사이징 파일을 고치는 세션에서, 성공하면 그 계열 함정 전부가 `ui/src/components/run/CLAUDE.md`로 함께 로드된다. 옮긴 함정 중 사라진 것은 **0건**이고 `just doc-coverage`와 독립 보존 검사(§5.2 D3)로 기계 증명된다.
- **US3**: 개발자-도구가 `run/` 밖(pages·`ui/src/scenario/` 모델·print·runs)에서 run 계열 모듈을 쓰는 코드를 고치는 세션에서, 성공하면 그 편집에서 밟는 함정이 **그 세션에 로드되는 파일 안에 규칙 줄로** 있다. 이 기준이 성립하지 않는 함정은 ui/CLAUDE.md에 남는다(§3.2).
- **US4**: QA가 이동 후 앱을 쓸 때, 성공하면 동작이 이동 전과 같다. 증거는 네 가지다.
  - 옮긴 파일의 변경은 모듈 경로 문자열뿐이다.
  - 모든 상대 경로 문자열(import·`vi.mock`·`import()` 포함)이 **이동 전과 같은 파일**로 해석된다.
  - 테스트 집합(파일명·테스트 이름·결과)이 이동 전과 정확히 같다(기준 255 파일 / 3,387 테스트).
  - 이동 모듈이 마운트되는 **모든** 화면의 라이브 확인이 PASS다(§5.3).

## 1. 측정 — claims ledger (base `57830b90`, 워크트리에서 실측)

| 주장 | 명령 | 결과 |
|---|---|---|
| ui/CLAUDE.md 크기 / 래칫 WARN | `just doc-budget; echo "exit=$?"` | 113,306 B · 기준 102,395 · WARN 1 · 절대 122,880의 92.2% · root 32,510 B · exit 0 |
| `##` 섹션 10개 · 최상위 불릿 164개 | `grep -c '^## ' ui/CLAUDE.md` · `grep -c '^- ' ui/CLAUDE.md` | 10 · 164 |
| 들여쓴 하위 불릿 존재 | `grep -n '^  - ' ui/CLAUDE.md` | 182·183(181 불릿의 2차·3차 변종) — R17 `bullets()`는 세지 않음 |
| 섹션별 바이트(헤딩 줄부터 다음 `##` 전까지) | python 섹션 합산(줄 바이트 = `len(line.encode())+1`) | 빌드·타입 게이트 25,739 · API client 2,497 · 폼·입력 UX 24,813 · 다단계 ramp 11,163 · 변수 스코프 2,901 · 데이터 바인딩 7,544 · 워커 대시보드 1,102 · 오프라인/테스트 인프라 29,652 · 운영 모니터 4,303 · 인쇄 보고서 1,266 · preamble 2,327 |
| 기존 하위 문서 4개 | `find ui/src -name CLAUDE.md` + `wc -c` | `components/scenario` 47,353 · `components/report` 9,753 · `components/ui` 11,168 · `compare` 11,596 |
| 이동 대상 소스 23개(전부 `ui/src/components/` 직속) | `ls` | RunDialog·LoadModelFields·DataBindingPanel·EnvironmentPicker·CriteriaFields·StepCriteriaFields·StageCurvePreview·LoadShapePreview·loadShapes·loadModel·profileForm·openLoopChecks·runSummary·sizing·SlotSizingHelper·VuSizingHelper·WorkerSizingHelper·ScheduleForm·TriggerBuilder·triggerCron·ScheduleEventTimeline·RunVuCell·RunListControls |
| 전용 테스트 23개(`components/__tests__/`) | `ls <23개 이름> \| wc -l` | 23 — RunDialog는 `.test`+`.trust.test` 2개, CriteriaFields·loadShapes는 전용 테스트 없음, `scaleVuStages.test.ts`는 `../sizing`을 테스트하므로 포함. 남는 13개 테스트는 이동 모듈을 import하지 않음 |
| 이동 집합 밖 소비처 = 7개 파일 · 지정자 11개 | `python3 -I docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-importers.py ui/src` | `components/scenario/TestRunSection:13` · `pages/RunDetailPage:34` · `pages/ScenarioRunsPage:20,21,25` · `pages/SchedulesPage:12,13,14` · `print/conditions:4` · `runs/profileSummary:2` · `runs/runFilterSort:2`. 이동 집합 밖 테스트의 참조 0 |
| 이동 테스트의 상위 mock | `grep -n 'vi.mock' ui/src/components/__tests__/*.test.*` | `../../api/hooks` 등 상위 mock은 RunDialog.test·RunDialog.trust.test·WorkerSizingHelper.test·SlotSizingHelper.test·VuSizingHelper.test. 형제 mock(`../VuSizingHelper` 등)은 RunDialog.test·RunDialog.trust.test·LoadModelFields.test. `typeof import("../../api/hooks")` 형 존재 |
| 경로 설정 영향 없음 | `grep -nE 'include\|exclude\|content' ui/vitest.config.ts ui/tsconfig.json ui/tailwind.config.ts` | `src/**/__tests__/**` · `["src"]` · `./src/**/*.{ts,tsx}` glob뿐. eslint 경로 규칙 없음. `import.meta.glob`·snapshot·`readFileSync` 없음(리뷰 R1 전수 확인) |
| 살아 있는 문서의 옛 경로 참조 | `grep -rlE 'components/(RunDialog\|…)\b' --exclude-dir=node_modules .` | `docs/build-log.md`·`docs/superpowers/{specs,plans}`(이력)뿐 |
| 테스트 기준값 | `cd ui && pnpm test` | `Test Files 255 passed (255)` · `Tests 3387 passed (3387)` · todo 0 |
| coverage corpus에 `ui/src/**/CLAUDE.md` 없음 | `sed -n '/def corpus_paths/,/^def rows/p' scripts/check-doc-coverage.py` | lits 4개 + `docs/dev/*.md` + `docs/adr/*.md` + `crates/*/CLAUDE.md` |
| R17은 불릿 감소를 merge 행으로만 허용 | 같은 파일 R17 루프 | `c < b - merged_floor` → FAIL. 불릿 통째 이동 경로가 없다 |
| 현재 `just doc-coverage`는 HEAD에서 FAIL | `just doc-coverage; echo "exit=$?"` | `FAIL: manifest 19행` — 활성 manifest가 root용(claude-md-optimize)인데 레시피 기본 FILE이 ui. §4.3 재설정이 필수다 |
| 오배치: `compare/CLAUDE.md` 15–17 | `grep -rln achievable ui/src` + 불릿 본문 | 15 = 구조화 409 에러(`api/client.ts`) · 16·17 = RunDialog 409 clamp(`RunDialog.tsx`·`sizing.ts`) |
| 하위 문서 로드 조건 | 리뷰 R1 세션 실측 | **Read 도구**로 하위 트리 파일을 읽으면 그 디렉토리와 조상 디렉토리의 CLAUDE.md가 주입된다. Bash `grep/cat/sed`는 로드하지 않는다 |

## 2. Part A — 소스 이동 (§B17)

### 2.1 무엇을

- §1의 소스 23개를 `ui/src/components/run/`으로, 전용 테스트 23개를 `ui/src/components/run/__tests__/`로 **`git mv`**한다. 이름은 그대로 둔다.
- 스케줄 4개도 포함한다(내 판단). ScheduleForm이 LoadModelFields·DataBindingPanel·CriteriaFields·StepCriteriaFields·EnvironmentPicker를 RunDialog와 공유한다(`ScheduleForm.tsx:11-25`).
- RunVuCell·RunListControls도 포함한다(곡선 VU 표시·목록 컨트롤 함정이 run 계열 문서 소속).

### 2.2 허용되는 변경 — 경로 문자열뿐

- **이동 파일:** 모듈 지정자 문자열만 바뀐다. 대상은 `import … from`, `export … from`, `import("…")`, `vi.mock("…")`, `vi.importActual("…")`, `typeof import("…")`이다.
  - 이동 집합 **안**을 가리키는 `./X`, 그리고 테스트의 `../X`(형제 소스)는 불변이다.
  - 이동 집합 **밖**을 가리키는 `./HelpTip`·`./ui/Field`·`../api/…`는 한 단계 깊어지고, 테스트의 `../../api/…`는 `../../../api/…`가 된다.
- **소비처 7개:** §1의 지정자 11개만 바뀐다.
- **금지:** 코드·주석·포맷·export 이름 변경, barrel(`index.ts`) 신설, 별칭(`@/`) 도입, **prettier 실행**. prettier는 게이트가 아니고(pre-commit·CI는 lint/test/build만), 경로가 길어진 import(예: `RunListControls.test.tsx:5` 100→103자)를 줄바꿈해 V2를 깨뜨린다.

### 2.3 훅 정합

- `spec-review-guard`: plan의 `REVIEW-GATE: APPROVED` 이후에만 `ui/src` 편집이 가능하다.
- `tdd-guard`: **테스트를 먼저 `git mv`**하면 `git diff --name-only HEAD`에 `__tests__/` 항목이 생겨 pending test로 인정된다(`tdd-guard.sh` 93–100행). 그러면 `it.todo` 언블록이 필요 없다. plan은 이 순서를 실측으로 확정하고, 막히면 `it.todo` 경로로 폴백한다.
- pre-commit UI 게이트(`pnpm lint && pnpm test && pnpm build`)가 이 커밋에서 돈다.

## 3. Part B — 문서 재분배 (원문 그대로 이동)

### 3.1 목적지

| 목적지 | 로드 조건(그 디렉토리 파일을 Read할 때) | 받는 것 |
|---|---|---|
| **신규** `ui/src/components/run/CLAUDE.md` | Part A의 23개 + 테스트 | §3.2 기준을 통과한 RUN 불릿 + `compare/CLAUDE.md` 16·17 + 통째로 빈 섹션의 `>` 포인터 줄(§3.3) |
| **신규** `ui/src/scenario/CLAUDE.md` | 모델 계층 `model.ts`·`cast.ts`·`scanVars.ts`·`yamlDoc.ts`·`store.ts`·`problems.ts`·`editorPrefs.ts` 등 | 실수 지점이 `ui/src/scenario/*.ts`뿐인 불릿. `components/scenario/CLAUDE.md` 머리말이 인정한 "형제 디렉토리라 자동 로드 안 됨" 공백을 해소한다 |
| 기존 `components/scenario/CLAUDE.md` | 에디터 컴포넌트 | 실수 지점이 `components/scenario/`뿐인 불릿 |
| 기존 `components/report/CLAUDE.md` · `components/ui/CLAUDE.md` | 각 디렉토리 | 같은 기준(초안: REPORT 2 · UI-PRIM 1) |
| ui/CLAUDE.md `## API client / React Query / fetch` | `ui/` 전체 | `compare/CLAUDE.md` 15(실수 지점 `api/client.ts` — 지금은 compare 편집 때만 로드되는 오배치) |

**하위 문서를 새로 만들지 않는 곳**(같은 기준 적용): `components/monitor/`, `ui/src/print/`.
- 운영 모니터 불릿 대부분의 실수 지점이 `pages/MonitorDisplayPage.tsx`·`ui/src/monitor/*.ts`이고, 기준을 통과하는 것은 ~1.5 KB(초안 추정)뿐이다.
- 인쇄 보고서는 3행 933 B이고, 그중 한 행(`normalizeProfile` 금지)은 다른 run 화면에도 걸린다.
- 둘 다 ui/CLAUDE.md에 남긴다.

### 3.2 분류 기준 — "실수 지점"이 목적지 디렉토리 안에 **전부** 있을 때만 이동 (no-forget)

- **실수 지점** = 그 함정을 밟는 **잘못된 코드가 쓰이는 파일**이다. 사건이 어디서 났는지가 아니라 다음 세션이 어디를 고치다 틀리는지가 기준이다.
  - 예: `buildProfile` 조건부 spread → `profileForm.ts`(run/). `schemas.ts`에 필드를 추가해도 그 필드를 내보내려면 `profileForm.ts`를 고쳐야 하므로 run/ 문서가 로드되는 편집에서 밟힌다 → 이동.
  - 반례: "새 표면에서 `profile.vus`를 직접 렌더하지 말 것" → 실수가 `pages/`의 새 화면에서 쓰인다 → 잔류.
- **우선순위:** 실수 지점 기준이 범주 규칙보다 우선한다.
  - Zod·React Query·jsdom 등 **라이브러리 일반 거동**에 대한 함정은 실수 지점이 어디서든 생길 수 있으므로 잔류한다.
  - 특정 스키마 구조(`model.ts`의 `ConditionModel z.lazy`·`StepModel` 4-way 등)처럼 실수 지점이 한 디렉토리뿐이면 그곳으로 이동한다.
- 실수 지점이 둘 이상의 문서 경계에 걸치면 **잔류**한다. 포인터 한 줄로 대체하지 않는다(`root-doc-maintenance.md` 3분류의 3번).
- **불릿 쪼개기 금지.** 불릿은 통째로 이동하거나 통째로 잔류한다. "규칙은 잔류, 상세만 이동"은 2차(압축) 슬라이스의 일이다.
- **병합 금지.** 초안이 제시한 205→24·162↔`useThinkTimePair`는 섹션·파일을 넘나드는 병합이라 현 게이트로 검증할 수 없다(리뷰 R1 #4). 2차에서 재검토한다.
- 들여쓴 하위 불릿을 가진 불릿(181–183)은 잔류한다. relocate는 단일 줄 불릿만 다룬다(§4.1).
- **기계 검사:** plan은 bullet-map을 확정판으로 고치고 `mistake_sites` 열(실제 파일 경로들)을 채운다. 이동 행마다 모든 `mistake_sites`가 목적지 디렉토리 하위인지 스크립트로 확인한다(§5.2 D4).

### 3.3 이동 방식 — byte-identical, 선언된 참조 치환만 예외

- 하위 문서로 옮기는 불릿은 **원문 그대로(byte-identical)** 한 줄씩 옮긴다.
- **예외: 상대 참조 치환.** 옮긴 줄 안의 상대 참조("아래 closed+curve 항목"·"위 `normalizeRequest`"·"위 §\"폼·입력 UX\""·"이 섹션 위쪽" 등)는 이동 후 깨진다. 이런 참조는 manifest에 **치환(old, new) 쌍으로 선언**한 것만 허용한다. 게이트는 base 줄에 선언된 치환을 적용한 결과가 목적지 줄과 byte-identical인지 본다(§4.1).
- 잔류 줄이나 다른 하위 문서 안에서 바뀐 섹션 구성을 가리키는 참조도 같은 방식(`refix` 행)으로 고친다. 후보 예: ui/CLAUDE.md 인쇄 섹션의 "§다단계 ramp UI의 `Pick<Profile,…>` 패턴", `components/report/CLAUDE.md:14`의 "\"다단계 ramp UI\" 섹션". **실제로 그 섹션이 비거나 해당 불릿이 옮겨졌을 때만** refix를 선언한다.
- 미선언 참조 깨짐은 D7(§5.2)이 탐지한다.
- 섹션이 통째로 비면(분류 확정 후에야 알 수 있다 — 초안의 `다단계 ramp UI`·`데이터 바인딩 패널`도 엄격 적용 시 남을 수 있다) 헤딩을 지운다. 그 섹션의 `>` 서사 포인터 줄은 받는 문서로 `move` 행으로 옮기고, ui/CLAUDE.md 머리 하위 문서 목록에 "그 주제는 run/CLAUDE.md"를 남긴다. 헤딩 삭제와 그에 딸린 refix는 plan에서 **조건부 스텝**으로 둔다.

### 3.4 배선 (발견 가능성)

- **ui/CLAUDE.md 머리 하위 문서 목록**을 6개로 갱신한다(기존 4 + `components/run` + `scenario`).
  - "RunDialog 등은 flat하게 남아 있다" 문장은 삭제한다.
  - 각 문서마다 옮긴 토픽 키워드를 나열한다. grep으로 발견될 키워드가 안전망이다.
  - "하위 문서는 Read 도구로 그 디렉토리 파일을 열 때 로드된다(Bash grep으로는 안 됨)"를 한 줄로 명시한다.
- **유지 규칙 문단의 "~120KB 넘으면 재분배"**는 새 절대 임계값(§4.2)에 맞춰 고친다. `check-doc-budget.py`의 `ui/CLAUDE.md:9` 인용은 줄번호 대신 섹션명으로 고친다.
- **새 하위 문서 머리말**은 기존 하위 문서 형식을 따른다(로드 조건 한 줄 + 상위 문서 참조 + 다루는 범위 + Read 로드 주의).
- `components/scenario/CLAUDE.md` 머리말의 "형제 디렉토리라 자동 로드 안 됨 — 수동 참고" 문장은 새 `ui/src/scenario/CLAUDE.md`를 가리키도록 고친다.
- root `CLAUDE.md` 도메인 함정 인덱스의 `ui/CLAUDE.md` 행에 "하위 6개 문서 목록은 ui/CLAUDE.md 머리" 한 마디를 덧붙인다.

## 4. 게이트 변경 (`scripts/` 2개 + Justfile + 절차 문서)

### 4.1 `check-doc-coverage.py`

1. **corpus에 `ui/src/**/CLAUDE.md` 추가** — `glob(..., recursive=True)`. 없으면 `**`가 한 단계만 매치해 `components/*`를 놓친다. 이빨 실증은 `components/run` 하위 문서로 한다.
2. **새 kind `relocate`** — 단일 줄 불릿 통째 이동.
   - 형식: `relocate<TAB><anchor><TAB><dest_file><TAB>-<TAB>0[<TAB><old1><TAB><new1>[<TAB><old2><TAB><new2>…]]` — 기본 5컬럼 뒤에 **치환 하나당 컬럼 2개**를 붙인다.
     - 문서 본문에 이미 `=>`(ui 15줄·compare 3줄)와 `|`(ui 21줄)가 있어 문자열 구분자는 모호하다. TAB은 대상 5개 문서에 0건이다(`grep -c "$(printf '\t')"`).
     - relocate·refix는 컬럼 수가 5+2k(k≥0)여야 하고, 아니면 `FAIL [manifest] 컬럼 N개`다. move·merge는 기존대로 5컬럼 고정이다.
   - 판정 ① anchor를 포함한 base 소스의 `- ` 줄이 **정확히 1개**이고, 다음 줄이 들여쓴 연속 줄이 아니다.
   - 판정 ② 그 base 줄에 치환을 순서대로 적용한 결과가 현재 `dest_file`의 한 줄과 byte-identical이다. 각 `old`는 적용 시점의 줄에 정확히 1회 있어야 한다(아니면 FAIL).
   - 판정 ③ 현재 소스에 그 base 줄이 없다.
   - 판정 ④ 그 줄의 **base 섹션** R17 바닥을 1 내린다.
   - 바닥이 0이 된 섹션은 작업트리에서 사라져도 R17 "섹션 실종" FAIL에서 면제한다.
3. **새 kind `refix`** — 같은 자리(또는 다른 문서)에 남는 줄의 참조 치환.
   - 형식: `refix<TAB><anchor><TAB><file><TAB>-<TAB>0<TAB><old1><TAB><new1>[…]`(치환 1개 이상, 컬럼 규칙은 relocate와 같다).
   - 판정: `base:<file>`에서 anchor를 포함한 줄이 정확히 1개이고, 그 줄에 치환을 적용한 결과가 현재 `<file>`에 있으며, 원 줄은 현재 `<file>`에 없다. `<file>`은 검사 대상 소스든 다른 문서든 같은 규칙이다.
   - R17 영향 없음(R17은 검사 대상 소스의 줄 수만 본다).
4. **선택적 3번째 인자 = manifest 경로**. 생략하거나 빈 문자열이면 활성 `scripts/doc-move-manifest.tsv`다(스크립트에서 처리 — Justfile의 빈 `MANIFEST`가 그대로 통과). `compare/CLAUDE.md`를 소스로 하는 이동은 `scripts/doc-move-manifest.compare.tsv`로 검증한다.
   - 이름 규약: 점 접미 = **활성 보조 manifest**, 대시 slug = **이력**. 절차 문서에 명시한다.
5. **이빨 실증**(지정 FAIL 문구가 출력에 있어야 RED로 인정한다. traceback·종료코드만으로는 안 된다). 각각 원복 후 GREEN을 확인한다.
   - relocate 목적지 줄 1 B 변조 → ②
   - 소스에 줄 부활 → ③
   - relocate 행 하나 삭제 → R17
   - 선언하지 않은 참조 수정 → ②
   - `recursive=True` 제거 → 토큰 FAIL
   - 들여쓴 연속 줄 가진 불릿 relocate → ①
   - 치환 컬럼 홀수 개(짝 없는 old) → `FAIL [manifest] 컬럼`
   - base 줄에 없는 `old` → ②

### 4.2 `check-doc-budget.py`

- `BASELINES`의 `ui/CLAUDE.md` 값을 **완료 후 실측 크기로 내린다**. R18은 인상만 잡으므로 인하는 정합이다.
- **ui 하위 문서 전부(6개)**를 완료 후 실측 크기로 `BASELINES`에 추가하고 `BASELINES_MIN`을 6에서 12로 올린다. 대상은 `components/run`·`scenario`·`components/scenario`·`components/report`·`components/ui`·`compare`다. 규칙은 하나다: 분할로 성장이 하위 문서로 옮겨 가므로 모든 하위 문서의 성장을 보이게 한다.
- `ABS_WARN`의 ui 값은 122,880에서 **완료 후 실측 크기 + 8 KiB를 KiB 단위로 올림한 값**으로 내리고, 유지 규칙 문단 숫자("~N KB")와 일치시킨다. 실측이 정해진 뒤 산출하며, 수치를 먼저 정하고 크기를 맞추지 않는다. 더 내리는 것은 2차 슬라이스의 일이다.

### 4.3 Justfile

- `doc-coverage` 레시피를 `BASE="57830b90" FILE="ui/CLAUDE.md" MANIFEST=""`로 바꾸고 3번째 인자를 전달한다.
- 옛 활성 manifest(헤더 `root CLAUDE.md 최적화(claude-md-optimize 2026-10-24) — base c11f8fff`, `head -1 scripts/doc-move-manifest.tsv`로 확인)는 `scripts/doc-move-manifest-claude-md-optimize.tsv`로 rename해 이력으로 둔다.

### 4.4 절차 문서 `docs/dev/root-doc-maintenance.md`

kind 4종(move·merge·relocate·refix), 보조 manifest 인자·이름 규약, `BASELINES` 12개·`BASELINES_MIN(12)`, 래칫 대상 표, `ABS_WARN` 새 값, 하위 문서 Read-로드 조건을 현행화한다. 현재 "kind 2종·단일 manifest·`BASELINES_MIN(6)`" 서술을 대체한다.

## 5. 검증 계획 — 회귀 0 (사용자 요구 "확실히")

모든 항목은 **base와 변경 후 두 상태**의 기대값을 plan에 적고, 둘 다 실행한다.

### 5.1 코드 (Part A)

- **V1 지정자 동일-대상 해석**: `ui/src`의 모든 `.ts/.tsx`에서 상대 지정자(§2.2의 6형)를 추출해 실재 파일(`.ts`·`.tsx`·`/index.*`)로 해석한다.
  - base에서 (파일, 지정자 위치) → 대상 파일 매핑을 저장하고, 이동 후 매핑과 **이동 표를 통해 대응**시켜 동일한 대상인지 비교한다.
  - 기대: base 미해석 0 → 이동 후 미해석 0, 대상 불일치 0.
  - 스크립트 `scripts/check-ui-specifiers.py`를 plan이 고정한다.
  - **이빨:** 이동 테스트 하나의 `vi.mock` 경로를 다른 실재 파일로 바꾸면 "대상 불일치"로 RED, 없는 경로로 바꾸면 "미해석"으로 RED. 원복하면 GREEN.
  - 존재 이유: `vi.mock` 경로가 틀려도 `tsc`·lint는 통과하고, mock이 조용히 빠진 채 테스트가 진짜 모듈로 통과할 수 있다.
- **V2 내용 불변**: 이동 파일 46개 각각에 대해 base 원본(`git show 57830b90:<옛 경로>`)과 이동본에서 지정자 문자열 리터럴을 placeholder로 치환한 뒤 byte 비교한다. 기대 46/46 동일.
  - 소비처 7개는 `git diff -U0 57830b90 -- <파일>`의 `^[+-]` 줄(헤더 제외)이 전부 §1의 지정자 11개 줄이어야 한다.
  - `git diff -M --stat` similarity는 참고 정보로만 기록한다(짧은 파일은 90% 경계).
- **V3 테스트 집합 동치**: `pnpm vitest run --reporter=json`의 `(basename(file), fullName, status)` 다중집합이 base와 동일해야 한다. 총계 255/3,387, todo 0.
- **V4 게이트**: `pnpm lint && pnpm test && pnpm build` green(pre-commit과 같다).
- **V5 번들 동치(보강 증거)**: **편집 전에** base `vite build` 산출물(`dist/assets/*.js`·`*.css`)을 scratchpad에 보존한다(워크트리 checkout 금지). 이동 후 산출물과 해시 파일명 정규화 후 비교한다.
  - 기대: 내용 동일.
  - 차이가 나면 STOP하고 원인을 판정한다. 모듈 순서·경로 문자열만 다르면 근거를 build-log에 기록하고 허용하며, 코드 차이면 V2 결함이다.
- **V6 옛 경로 0**: `python3 -I docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-importers.py ui/src`. 기대: base 11줄(§1) → 이동 후 0줄.
  - 이 스크립트는 `components/<이름>` 옛 위치를 대상으로 해석하므로 `git grep`의 `\b` 미지원 함정(리뷰 R1 #6)을 우회한다.
  - 추가로 `ls ui/src/components/__tests__/`에 이동 테스트 이름 23개가 base에 있고 이동 후 0이어야 한다.

### 5.2 문서 (Part B)

- **D1** `just doc-coverage` → OK. 기본값 BASE `57830b90`, FILE ui/CLAUDE.md, 활성 manifest.
- **D2** `python3 scripts/check-doc-coverage.py 57830b90 ui/src/compare/CLAUDE.md scripts/doc-move-manifest.compare.tsv` → OK.
- **D3 독립 보존 검사(1:1)** — 게이트 버그에 기대지 않으려고 따로 둔다.
  - 대상: **base의 ui 문서 전부**(`ui/CLAUDE.md` + `ui/src/**/CLAUDE.md` — base 5개 파일, `- `·`  - ` 줄 270개)의 모든 불릿 줄. `ui/**` glob은 쓰지 않는다(`node_modules`·`dist` 유입 차단).
  - 사전조건: base에서 이 270줄이 서로 유일하다(R2 실측 중복 0). 위반 시 FAIL.
  - 각 줄에 그 줄을 지목한 manifest relocate/refix 치환(두 manifest 모두, (file, 줄)로 키; 없으면 항등)을 적용한다. 그 결과가 이동 후 `ui/CLAUDE.md` + `ui/src/**/CLAUDE.md` 전체에서 **정확히 1회** 나타나야 한다.
  - 기대: 미귀속 0, 중복 0.
  - 1차엔 압축이 없으므로 모든 불릿이 byte 단위로 추적된다. 스크립트는 `scripts/check-bullet-conservation.py`다.
- **D4 실수 지점 기계 검사**: 확정 bullet-map의 이동 행마다 `mistake_sites` 전 경로가 목적지 디렉토리 하위인지 확인한다. 기대 위반 0.
- **D5** `just doc-budget` → FAIL 0 / **WARN 0**. ui/CLAUDE.md ≤ 92,160 B(US1).
- **D6 분류 표본 검토**: 이동 행 무작위 5개·잔류 행 무작위 5개에 대해 리뷰어가 실수 지점을 코드에서 재판정한다.
- **D7 미선언 참조 탐지**: 이동 후 ui 문서 6개(`ui/CLAUDE.md` + `ui/src/**/CLAUDE.md`)의 모든 줄에서 상대 참조 패턴을 추출한다. 패턴은 `위 `·`아래 `·`이 섹션`·`위쪽`·`아래쪽`·`§`·`"…" 섹션`이다.
  - base 6개 상태(신규 파일 제외)와 이동 후 상태 둘 다 실행한다.
  - 이동 후 **새로 생긴 문맥 변화**(줄이 다른 파일·섹션으로 갔거나, 가리키던 섹션·불릿이 사라짐)의 각 적중은 둘 중 하나로 판정해 plan에 기록한다: (a) 선언된 치환으로 처리됨, (b) 이동 후에도 참이 유지됨(사유 1줄).
  - 미판정 적중이 0이어야 한다.
  - `§` 참조의 기계 대조 해석 규칙은 다음과 같다.
    - 바로 앞에 `.md` 경로가 있으면 그 파일의 헤딩과 대조한다(예: `docs/dev/ui-gotcha-narratives.md` §…).
    - `§` 뒤가 숫자이거나 `[A-Z]\d`(spec·roadmap 번호 — base 실측 15건: `§4.1`·`§B12`·`§A12` 등)면 기계 대조에서 제외하고 판정 목록으로 보낸다.
    - 그 밖은 ui 문서 6개의 헤딩과 대조한다.
    - **일치 규칙:** 참조 텍스트의 감싼 따옴표를 벗긴 뒤 둘 중 하나면 일치다.
      - (a) 헤딩 짧은 제목(첫 ` (` 또는 ` /` 앞까지)이 참조 텍스트의 접두사다. 조사 `의` 등 꼬리를 허용한다.
      - (b) 참조 텍스트가 헤딩 전체의 접두사다.
    - 해석 실패 = FAIL.
    - **base 상태 기대값:** 해석 실패 **1건** — `ui/CLAUDE.md:131`의 `§폼 UX`(약어라 어떤 헤딩과도 일치하지 않음, R4 실측). 이 슬라이스에서 선언된 치환(그 불릿이 잔류하면 refix, 이동하면 relocate 치환)으로 고친다.
    - **이동 후 기대값: 0.**
- **manifest↔소스 대응과 키 유일성**(D3·게이트 공통)
  - 활성 `scripts/doc-move-manifest.tsv`의 행은 소스 `ui/CLAUDE.md`, `scripts/doc-move-manifest.compare.tsv`의 행은 `ui/src/compare/CLAUDE.md`에 속한다.
  - refix 행은 자신이 지목한 `<file>`에 속한다.
  - 한 base 줄((file, 줄))을 지목하는 relocate·refix 행은 두 manifest를 통틀어 **최대 1개**다. 2개 이상이면 D3 FAIL이다.

### 5.3 라이브 (S-D — 이동 모듈이 마운트되는 **모든** 진입 화면, `/live-verify` 스택)

| 화면 | 이동 모듈 | 확인 |
|---|---|---|
| 시나리오 run 목록 → RunDialog → run 생성 → 리포트 | RunDialog·LoadModelFields·DataBindingPanel·EnvironmentPicker·Criteria·StepCriteria·Sizing 3종·LoadShapePreview·StageCurvePreview·runSummary | 간단/상세 모드. closed 고정·open·곡선 각각 미리보기 렌더. run 1개 완료·리포트 렌더 |
| run 목록 정렬·필터 | RunListControls·RunVuCell·`runs/runFilterSort` | 정렬·필터 변경 시 목록 반응, VU 칸 표시 |
| run 상세 | RunVuCell | VU 칸·자동 설정 요약 |
| 시나리오 비교 페이지 | `runs/profileSummary` → loadModel | 2개 run 비교 렌더 |
| 스케줄 생성 | ScheduleForm(+ LoadModelFields·Criteria·StepCriteria·DataBindingPanel·EnvironmentPicker)·TriggerBuilder·triggerCron·ScheduleEventTimeline | 부하 입력·트리거 빌더 → cron 미리보기, 저장, 이벤트 타임라인 |
| 에디터 시험 실행 — 편집 페이지와 **새 시나리오 페이지** 둘 다 | EnvironmentPicker(via `TestRunSection`) | 환경 선택 → 시험 실행 |
| 인쇄 보고서 `/runs/:id/print` | `print/conditions` → loadModel | 표준판 렌더 |

각 화면에서 콘솔 에러 0을 확인한다. DOM 존재만으로 PASS하지 않고 요소 실측(rect/텍스트)으로 판정한다.

## 6. 파이프라인 메모

- 구현 task 순서(plan이 확정)
  1. 게이트 확장(§4.1·§4.4, 이빨) + 검증 스크립트 2종(V1 `check-ui-specifiers.py`·D3 `check-bullet-conservation.py`) + base 산출물 보존(V3 JSON·V5 dist)
  2. Part A 소스 이동(V1–V6)
  3. Part B relocate·refix + 하위 문서 2개 신설·머리말
  4. 배선·budget·roadmap(§3.4·§4.2·§4.3, roadmap §B17 해소 표기·현황판에 2차 등록)
- 분류 확정(bullet-map `mistake_sites`)과 그에 따른 **크기 사전 산출**(US1 상한 판정 — 완료: ≈ 89,369 B, 상한 90 KiB로 재설정)은 plan 작성 단계에서 한다. 구현 중 재분류는 STOP 사유다. per-task 리뷰는 `model: opus`로 받는다.
- Part A(소스·테스트 이동 + 소비처 경로 수정)는 **단일 커밋**이다. tdd-guard pending 상태와 UI 게이트가 갈라지지 않게 한다.
- 최종 `handicap-reviewer` + 라이브(§5.3).
- 보안 표면: production 의미 변경 0. 단 `finish-slice` §0 grep이 지배하므로 직접 돌린다.
- STOP-gate: spec과 plan을 이 세션에서 쓰므로 구현은 `/clear` 후 fresh 세션에서 한다.

## 7. 비목표 (→ 2차 슬라이스 또는 후속)

- **잔류 불릿의 서사 압축 → 2차 슬라이스**(US1 60 KiB, `ABS_WARN` 추가 인하, 병합 2건 재검토, 불릿 쪼개기).
- 하위 문서로 옮긴 불릿의 압축.
- `components/monitor/`·`ui/src/print/`·`ui/src/monitor/`·`pages/` 하위 문서(§3.1).
- 코드 리팩터(이름 변경·barrel·별칭·의존 정리) — §2.2 금지.
- 코드 주석 속 "(ui/CLAUDE.md …)" 포인터 갱신 → 2차. 예: `report/PercentileCurveChart.tsx:42` — StageCurvePreview 함정이 run/으로 가므로 낡는다. 주석의 함정명은 grep으로 여전히 찾힌다.
- `compare/CLAUDE.md`의 기타 오배치 11·13·14·18. 관찰만 기록한다(18은 `api/download*.ts`·에디터 두 경계에 걸쳐 §3.2상 이동 대상이 아님).
