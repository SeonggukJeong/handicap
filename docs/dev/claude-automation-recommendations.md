# Claude Code 자동화 추천 (handicap)

> 2026-06-15 생성 (`claude-automation-recommender`). 이 repo에 **아직 없는** 자동화 후보만 — 기존 강한 셋업과 중복되지 않는 것. **추천 문서이지 구현물이 아님**; 각 항목 "구현" 라인을 시작점으로 다음 세션에서 선택 구현.
>
> **이미 있는 것(중복 추천 안 함)**: hooks `tdd-guard`·`git-guard`·`controller-bin-guard`·`spec-review-guard`·`format.sh`·`ui-gate-reminder`·`rebuild-worker-reminder` / skills `start-slice`·`finish-slice`·`live-verify`·`new-migration`·`dev-doctor`·`curate-memory` / agents `handicap-reviewer`·`spec-plan-reviewer` / 층상 pre-commit 게이트.

## 코드베이스 프로필
- **Rust 워크스페이스**(engine/controller/worker/worker-core/proto): axum 0.8 · tonic gRPC · SQLite · HDR Histogram · prost · rust_xlsxwriter · calamine
- **UI**: React + TS (Vite · React Flow · Monaco · Zustand · Zod · React Query · vitest)
- **배포**: K8s / Helm / kind. **git remote 없음**(로컬 ff-merge 워크플로).

---

## 우선순위 요약
① context7 MCP(즉효·버전-함정 클래스 차단) → ② proto-ripple 훅(저비용·고빈도 함정) → ③ security-reviewer 서브에이전트(보안 표면 실재) → ④ `/curl-verify` 스킬(반복 footgun 제거) → ⑤ SQLite read-only MCP(선택).

## 구현 상태 (2026-06-15)
- **① context7 MCP** — ✅ 이미 사용 가능(플러그인/유저 스코프, 이 repo에 `.mcp.json` 없음). 로컬 대화용으로 유효.
- **② proto-ripple 훅** — ✅ 구현·배선(`.claude/hooks/proto-ripple-reminder.sh` + `settings.json` PostToolUse `Write|Edit`). `.proto` 편집 시 5분 디바운스 리마인드.
- **③ security-reviewer 서브에이전트** — ✅ 구현(`.claude/agents/security-reviewer.md`, read-only, SSRF·시크릿 누출·템플릿 인젝션 렌즈 + 인가 컨텍스트). 머지 전 수동 호출.
- **④ `/curl-verify` 스킬** — ✅ 구현(`.claude/skills/curl-verify/{SKILL.md,parse.py}`, `disable-model-invocation: true`=user-only). 떠 있는 controller에 대한 생성→run→폴링→report 레시피 + stdin-직결 `parse.py`.
- **⑤ SQLite read-only MCP** — ⏸ 미구현(선택 — `sqlite3 /tmp/x.db` Bash로 갈음).
- **(+) pre-commit 휴대성** — ✅ 추천 문서엔 없던 별개 인프라 갭 해소: 층상 pre-commit 게이트를 tracked `.githooks/pre-commit`로 버전관리 + `just install-hooks`(`core.hooksPath .githooks`)로 클론마다 활성화(과거 untracked `.git/hooks/`라 클론에 안 따라왔다). 상대 경로라 worktree에도 적용.

---

## 🔌 MCP

### context7 — 라이브 문서 ★최우선
**왜**: 이 repo 함정의 큰 갈래가 **버전-특정 API 변화**다 — axum 0.8 path(`{id}` not `:id`)·`ServeDir::fallback` vs `not_found_service`(tower-http 0.6)·calamine 0.26 reader 타입·tonic 에러 타입·prost exhaustive·React Flow/Zod default 누출. CLAUDE.md에 "0.7 문서 검색하면 함정"이 반복 등장. context7가 **현재 버전** 문서를 온디맨드로 가져와 이 클래스를 선제 차단(훈련 데이터의 옛 API 대신).
**설치**: `claude mcp add context7` — 또는 `.mcp.json`에 넣어 팀 공유. 네트워크 필요.
**caveat**: 헤드리스/cron 런에선 인증 MCP가 부재할 수 있음(CLAUDE.md) → 로컬 대화용으로 가장 유효.

### SQLite read-only — dev DB 인스펙션 (선택)
**왜**: "run이 영영 running + 0 req"·status-transition 갭 디버깅에서 dev DB(`/tmp/x.db`의 `runs`/`run_metrics`/`run_loop_metrics`/`run_if_metrics`)를 직접 조회하면 빠르다. loop overflow sentinel(`loop_index=4294967295`), `run_metrics` worker_id PK 등 스키마-인지 조회가 잦음.
**설치**: read-only SQLite MCP를 dev DB 경로로(쓰기 금지 — 앱이 권위).
**대안**: `sqlite3 /tmp/x.db` Bash로도 충분 — 빈도 낮으면 skip.

---

## ⚡ Hooks

### proto 변경 ripple 리마인더 (PostToolUse) ★
**왜**: CLAUDE.md 반복 함정 — "**새 proto 필드 추가 = crate-wide grep 필수**". prost struct는 exhaustive이고 `..Default::default()`가 안 돼서 `MetricBatch`/`RunAssignment`/`Profile` 등 모든 struct-literal 사이트(특히 worker `main.rs`·테스트 literal)가 컴파일 에러. `.proto` 편집 직후 자동 리마인드하면 누락 방지.
**구현**: `.claude/hooks/proto-ripple-reminder.sh`(PostToolUse·Write|Edit; 내부에서 `file_path`가 `*.proto`일 때만 출력). 메시지: 변경 메시지 타입의 `grep -rn "<Struct> {" crates/` 안내 + "rebuild + 모든 literal 사이트 갱신". `rebuild-worker-reminder.sh`와 동일 패턴.
**배선**: `.claude/settings.json` 기존 PostToolUse `Write|Edit` 배열에 한 줄 추가.

### (추가 format/lint/tdd 훅은 비추천)
`format.sh`·`tdd-guard`·UI 게이트가 이미 커버. 새 포맷/린트 훅은 중복.

---

## 🤖 Subagents

### security-reviewer — SSRF·시크릿·인젝션 (tailored)
**왜**: 이 도구는 **사용자 정의 HTTP를 임의 URL로 실행**하고 **인증(VU별 쿠키 jar·JWT, ADR-0018)·`${ENV}` 시크릿**을 다룬다. 보안 표면:
- **SSRF**: 시나리오 URL이 내부 메타데이터(169.254.169.254)·localhost·사내망 타격.
- **시크릿 누출**: 토큰·`${ENV}` 값이 리포트·`ScenarioTrace`(test-run body 뷰어)·로그·에러 메시지로 새는지.
- **템플릿 인젝션**: `{{var}}`/`${ENV}`/`{{var:num}}` body 캐스트(ADR-0029)·form/JSON 템플릿팅의 경계.
`handicap-reviewer`는 정확성·repo-함정용이라 **보안 렌즈가 비어 있음**. engine 요청 실행·`template.rs`·env/binding·test-run trace를 건드리는 변경에 전용 리뷰.
**구현**: `.claude/agents/security-reviewer.md`(read-only: Read/Grep/Glob/Bash). 시스템 프롬프트에 위 표면 + **권한 컨텍스트 명시**(사내 QA·인가된 부하 테스트 도구 — 방어/검토 목적). 머지 전 수동 호출(run-실행/template/env/trace 변경 시).

---

## 🎯 Skills

### `/curl-verify` — curl 레시피 스캐폴드 (user-only)
**왜**: CLAUDE.md "로컬에서 curl로 직접 구동" 절이 길고 **footgun 밀집**: 생성 응답에 멀티라인 `scenario_yaml`이 임베드돼 `jq`/`python json.load`가 raw 개행으로 깨짐 / zsh `echo "$json" | python3`이 `\n`을 실제 개행으로 풀어 JSON 파싱 깨짐 / heredoc이 pipe stdin을 덮어씀 / `GET /api/runs` 목록 엔드포인트 부재(→ id 재조회) / step id는 유효 ULID(I/L/O/U 제외)·`version: 1`+각 step `id/type/name` 필수. **매번 같은 함정을 다시 밟는다.**
**구현**: `.claude/skills/curl-verify/SKILL.md`(+ `parse.py` 번들) — 이미 떠 있는 controller에 대해 올바른 curl(시나리오 생성→run 생성→완료 폴링→report fetch)을 생성. `live-verify`(전체 스택 기동)보다 가벼운 "controller만 떠 있을 때" 버전. 페이로드 키(닫힌 `vus`/열린 `target_rps,max_in_flight`/곡선 `vu_stages|stages`·`duration_seconds`)·summary 키(`count/errors/rps/p50_ms/mean_ms/p95_ms/p99_ms`) 내장.
**호출**: 부수효과(run 생성) 있어 user-only(`disable-model-invocation: true`).

---

## ❌ 추천하지 않음 (이유)
- **GitHub MCP / PR 자동화**: remote 미설정(로컬 ff-merge) — 사내 K8s 도입 후 remote 붙이면 재검토.
- **추가 TDD/format/lint 훅**: 기존 가드·`format.sh`·UI 게이트가 이미 커버.
- **commit 스킬**: 커밋 규약(파이프 금지·`Co-Authored-By`·green fold·명시 경로 add)이 CLAUDE.md + pre-commit + git-guard에 이미 강제됨.
- **frontend-design 플러그인**: UI는 신규 디자인보다 기존 이디엄(접이식 disclosure·`ScenarioSnapshot`) 일관성이 우선 — 케이스별로 충분.

---

**다음 단계**: 다음 세션에서 "이 문서의 N번 만들어줘"로 요청. 위 우선순위대로 ①·② 먼저가 비용 대비 효과 큼.
