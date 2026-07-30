# 릴리즈 위생 — 버전 신원 + 릴리즈 파이프라인 견고성·노트 (설계)

- 출처: roadmap `§B24`(릴리즈 버저닝 정리 — workspace crate version + `--version` 표면화, 2026-07-17 v0.4.0에서 표면화) + `§B25`(릴리즈 워크플로 견고성 — 산출물/게시 분리 + 릴리즈 노트, 2026-07-20 v0.5.0에서 표면화)
- 유형: **platform** (US1~US3은 user-path 성격)
- ADR: **불필요** — 모델/와이어 불변식 무변경, 절차 규약의 단일 소스는 `docs/dev/tauri-desktop-build.md`

## 규모·분해 (리뷰 반영, 2026-07-30)

`spec-plan-reviewer` 1라운드가 **8a/8b 분해**를 권고했다(근거: 8b는 실패 단위가 18분 CI 이터레이션이고 로컬 증명이 불가하므로, 묶으면 8a의 라이브 증명이 8b의 스텁 하니스를 기다린다). **사용자는 이 묶음을 명시 선택했고**(대안 "B25 단독"·"범위 트림"을 보고 기각) CI-only 부분의 라이브 검증 불성립도 선택 시 고지됐다 → **단일 슬라이스 유지**. 다만 권고를 절반 수용해 **task 순서를 8a 먼저**로 고정하고 8b가 8a에 의존하지 않게 둔다:

- **8a — 버전 신원**(R1–R5, R11): US1+US2. **오늘 라이브 증명 가능**(헤더 렌더 + `--version` 3경로).
- **8b — 릴리즈 파이프라인·노트**(R6–R10): US3+US4+US5. 8a에 대한 의존은 "루트 workspace version이 존재한다" 하나. 로컬 증명은 대체 수단(스크립트 양방향 실행·`gh` 스텁)뿐.
- **R9(노트)는 자립**: 워크플로 변경 0으로도 출하 가능(`gh release edit v0.6.0 --notes-file`).

즉 8b를 드롭해도 8a는 그대로 출하 가능한 순서다. 규모는 **중형**으로 재표기(`crates/*` 6개 manifest + 락 2개 + `controller/src/{main.rs,in_process.rs,app.rs}` + `worker/src/{main.rs,lib.rs}` + UI 프로덕션 4파일(`api/hooks.ts`·`api/schemas.ts`·`components/Layout.tsx`·`i18n/ko.ts`) + UI 테스트 2파일 + 워크플로 + 스크립트 + 노트 + docs).

## 사용자 스토리 (US)

- **US1**: **QA**가 데스크톱 앱으로 부하를 돌리다 이상을 보고할 때, 지금 쓰는 앱이 어느 릴리즈인지 확인하려 한다 — 성공하면 화면 헤더에서 `v0.7.0`을 읽어 그대로 전달할 수 있다.
- **US2**: **도입담당**이 여러 머신에 복사·개명해둔 포터블 `handicap.exe` 중 어느 게 최신인지 가려내려 한다 — 성공하면 `handicap.exe --version`이 릴리즈 버전을 출력해 파일명·설치 이력 없이 판별된다(현재는 어디에도 안 드러남).
- **US3**: **QA**가 릴리즈 페이지에서 새 버전을 받을 때, 이전 대비 무엇이 달라졌고 인스톨러 3종 중 무엇을 받아야 하는지 알려 한다 — 성공하면 지금 비어 있는 v0.6.0 본문이 채워지고, 이후 릴리즈는 본문이 빈 채로 발행될 수 없다(노트 파일이 있으면 그 본문, 없으면 자동 초안).
- **US4**: **개발자-도구**(릴리즈 담당)가 GitHub API 장애 중에 발행을 마치려 한다 — 성공하면 빌드 산출물이 artifact로 남아 실패한 게시 잡만 재실행해 수십 초에 릴리즈가 올라간다(현재는 18분 빌드가 통째로 폐기).
- **US5**: **개발자-도구**가 버전 bump를 일부만 하고 태그를 밀었을 때 잘못 라벨된 에셋 발행을 막으려 한다 — 성공하면 preflight가 태그↔`tauri.conf`↔workspace 불일치를 빌드 시작 전에 실패시킨다(현재는 `v0.8.0` 태그에 `Handicap_0.7.0_*`가 조용히 첨부된다).

## 배경 — 실측 (2026-07-30, 착수 시 + 리뷰 1라운드 확인)

요구사항은 로드맵 문구가 아니라 이 실측을 따른다.

1. **릴리즈 노트**: 릴리즈 9개 중 **6개 본문이 비어 있다**(`v0.1.0`·`v0.2.0`·`v0.2.1`·`v0.2.2`·`v0.4.0`·**`v0.6.0`**). 작성된 것은 `v0.3.0`(2854 B)·`v0.5.0`(3210 B)·`v0.7.0`(4970 B). §B25의 "v0.1.0~v0.4.0 전부 비어 있고 v0.5.0만 수동"은 stale이고, 실제 패턴은 **"수동이라 자주 잊힌다"**(5일 전 v0.6.0도 빈 채 발행). `v0.7.0` 본문은 사용자 관점 한국어 문서라 **커밋 목록 자동생성은 품질 하향** — 자동화 방향은 "생성"이 아니라 "빈 본문 불가 + 초안 폴백".
2. **버전**: `crates/*` 5개 전부 `version = "0.1.0"`(workspace 상속 없음), controller/worker clap에 `version` 부재, `CARGO_PKG_VERSION` 소비처 0, UI 버전 표면 0. 포터블 exe는 `crates/controller`에서 나오므로 **지금 `#[command(version)]`만 붙이면 `0.1.0`을 출력** → workspace 버전이 선결.
3. **태그↔버전 검사 0**: 인스톨러 파일명은 `desktop/src-tauri/tauri.conf.json`의 `version`만 따르므로 bump 누락 시 `v0.8.0` 릴리즈에 `Handicap_0.7.0_*`가 **무경고** 첨부.
4. **v0.2.1 stale-lock 사고의 실제 대상은 `desktop` 패키지 항목**이다(`docs/dev/tauri-desktop-build.md:53` — "`name = "desktop"` 블록도 같이 확인"). 현재 `desktop/src-tauri/Cargo.lock:1109-1110` = `desktop 0.7.0`. handicap-* 항목만 검사하면 **US5가 인용하는 그 사고를 못 막는다**(리뷰 F1).
5. **CI 형상**: `macos-dmg`는 이미 `tauri-action`을 `tagName` 없이(=빌드만) 호출하고 artifact를 올린 뒤 20초×90회 폴링해 `gh release upload`한다. build/publish 분리는 그 패턴의 windows 확장이고, 부수 효과로 폴링(생성 레이스 회피 해킹)이 불필요해진다.
6. **내부 의존**: `crates/*` 상호 의존은 전부 bare `path = "..."`(버전 요구 없음) → workspace 버전 bump가 **해상도 영향 0**.
7. **`gh`는 HTTP 상태를 노출하지 않는다**(실측 gh 2.96.0: `gh release view v9.9.9` → stderr `release not found`, exit **1**; `gh help exit-codes`는 0/1/2/4만 문서화. `(HTTP nnn)`은 `gh api`에서만). → 재시도 로직에서 4xx/5xx **분류가 불가능**(리뷰 FR3).
8. **`gh release edit`엔 `--generate-notes`가 없다**(실측: `--notes`/`--notes-file`만). 이미 존재하는 릴리즈의 빈 본문을 채우려면 `gh api .../releases/generate-notes`가 필요(리뷰 FR4).
9. **axum 0.8 nested router는 outer fallback을 상속한다**(`app.rs:147` `nest("/api", api)` + `:149-167` SPA fallback). `--ui-dir`나 bundle 임베드 UI가 있으면 미매치 `/api/*`는 **404가 아니라 200 `index.html`**(`crates/controller/CLAUDE.md`의 `ServeDir::fallback` 함정·`tests/static_test.rs:84-106` `unknown_path_falls_back_to_index`). 404는 UI 미서빙 비-bundle 케이스뿐(리뷰 F2).
10. **루트 `Cargo.toml`의 `^version` 라인은 오늘 `[workspace.dependencies.wiremock]`의 `version = "0.6"`(:56) 하나뿐** — 열 0에 있어 naive `grep -m1 '^version'`이 **틀린 줄을 읽는다**(리뷰 FR5, 실측 확인).
11. **헤더는 2자녀 `justify-between` flex**(`Layout.tsx:8`, 자녀 = 로고 `<Link>` :9-11 + `<nav>` :12-35). 세 번째 자녀를 그냥 추가하면 버전이 **헤더 중앙에 떠 로고와 붙지 않는다**(리뷰 FR8).
12. **다른 곳의 버전 문자열**: `deploy/helm/handicap/Chart.yaml:5-6`(`version: 0.1.0`/`appVersion: "0.1.0"`)·`ui/package.json:3`(`0.1.0`)(리뷰 C2, 실측 확인).

## 결정 요약 (브레인스토밍 확정)

| 결정 | 내용 |
|---|---|
| 버전 단일 소스 | **(A) workspace 버전 상속** — 루트 `[workspace.package] version` + 5 crate 상속. build.rs·git SHA·태그 주입 기각(인스톨러 파일명이 `tauri.conf.json` 지배라 진짜 단일 소스가 못 되고 dev/tarball에서 unknown). **주의: "단일 소스"는 *cargo 크레이트 5개에 대해서만* 참이다** — 릴리즈 1회당 사람이 맞추는 값은 3개(루트·desktop Cargo·tauri.conf)이고 락 2개는 생성물, R6이 그 정합을 기계로 강제한다 |
| 버전 표면 | **CLI + 시작 로그 + `GET /api/version` + UI 헤더 한 줄** — 이 질문을 하는 QA는 터미널을 안 열고 창만 연다 |
| UI 자리 | **헤더 로고 옆 muted 텍스트**(로고와 한 래퍼 안). 설정 '정보' 섹션 기각(찾아가야 함) |
| 노트 정책 | **레포 내 `docs/release-notes/v<ver>.md` + 없으면 자동 초안 폴백**. "파일 없으면 릴리즈 실패" 기각(핫픽스 마킴) |
| 소급 | **v0.6.0만**. 6개 전부는 기각(쓰기 작업이 무게중심을 차지) |
| CI 구조 | **3-잡 재구성**(preflight → build ×2 → publish). "최소 개입"은 기각(재실행이 여전히 18분 빌드) |
| 재시도 분류 | **분류 없음** — `gh`가 상태코드를 안 주므로(실측 7) 모든 실패를 유한 재시도. 4xx도 5회를 소모하지만 총 5.2분이고 재실행이 수십 초라 저렴하다. stderr 문자열 매칭 기각(문서화되지 않은 문구 의존 + 검증이 공허해진다 — 리뷰 FR3) |

## 요구사항

### R1. workspace 버전 상속 (US2 선결)

- 루트 `Cargo.toml` `[workspace.package]`에 `version = "0.7.0"` 추가(현 릴리즈 버전에서 출발 — 이 슬라이스는 bump가 아니다).
- `crates/{engine,proto,worker-core,worker,controller}/Cargo.toml`의 `version = "0.1.0"` → `version.workspace = true`.
- 두 락파일(`Cargo.lock`·`desktop/src-tauri/Cargo.lock`)의 handicap 5개 항목이 `0.7.0`으로 갱신된 상태로 커밋.
- 불변: 내부 path 의존에 **버전 요구를 추가하지 않는다**(실측 6 — 추가하면 상호 해상도가 버전에 묶여 다음 bump가 5개 파일을 더 건드린다).

### R2. `--version` 플래그 (US2)

- `crates/controller/src/main.rs`의 `Cli`와 `crates/worker/src/main.rs`의 `Cli`에 `#[command(version)]`. clap이 `CARGO_PKG_VERSION`을 자동 사용.
- 출력은 clap 기본(`{패키지명} {버전}`, 예 `handicap-controller 0.7.0`). 이름 커스터마이즈는 비목표.
- bundle 빌드에서도 동작해야 한다(포터블 exe = `--features bundle`, bundle-only `worker` 서브커맨드 공존). **plan은 실제로 세 경로를 실행해 확인한다**(비-bundle controller·worker·bundle controller) — clap 문서만 근거로 삼지 않는다.
- **불변(CLI 표면 parity)**: 기존 인자·기본값·`ControllerArgs`/`WorkerArgs` 필드 무변경. 이 불변식의 근거는 `crates/controller/src/main.rs:121-122`의 load-bearing 주석("bundle 전용 — 비-bundle 빌드엔 이 플래그가 없다(off=CLI 표면까지 byte-identical)")이다.
  - `--version`은 **양 빌드에 공통으로** 추가되므로 이 parity를 깨지 않는다(bundle-only 플래그가 아니다). ~~ADR-0039 D3~~ 인용은 삭제 — 그 라벨은 ADR에 없고(실물 grep 0) 내용도 "bundle 신규 동작은 feature 게이트"라 여기에 해당하지 않는다(리뷰 F3).

### R3. 시작 로그 버전 필드 (US1·US2 보조 — 지원 시 로그만 받아도 버전이 특정된다)

**다섯 곳 전부**에 `version = env!("CARGO_PKG_VERSION")` 필드를 추가한다(리뷰 F5/M3 — "기존 라인"은 단수가 아니다. **#3은 리뷰 2라운드 N1**로 추가됐고 유일하게 bundle-gated다 — 아래 테스트 전략의 bundle 수동 확인 대상):

| # | 위치 | 비고 |
|---|---|---|
| 1 | `crates/controller/src/main.rs:~154` (`#[cfg(not(feature="bundle"))]` 블록) | 로컬 dev·K8s |
| 2 | `crates/controller/src/main.rs:~367` (`run_bundle`) | **포터블 exe = US2가 실제로 보는 라인** |
| 3 | `crates/controller/src/in_process.rs:~256` (`info!(rest, grpc, "listeners (in-process)")`) | **Tauri 데스크톱(NSIS/MSI/dmg) = US1의 채널.** `desktop/src-tauri/src/backend.rs:4,31`이 `run_in_process`를 **직접** 부르므로 데스크톱 셸은 `main.rs`를 **아예 실행하지 않고**(#1·#2 미발화), 셸 자체엔 `info!`/`println!`이 0건이다(실측) → 이 행이 없으면 인스톨러 채널의 로그엔 버전이 **없다**. 인라인 `#[cfg(test)]` 보유(`:439`)라 tdd-guard 자유 |
| 4 | `crates/worker/src/lib.rs:~489` (`run`) | run-scoped 워커 |
| 5 | `crates/worker/src/lib.rs:~539` (`run_pool`, `info!(%worker_id, "pool worker starting (idle)")`) | LAN 풀 워커 |

- **보안 불변**: `info!(?args, …)` 구조체 Debug 덤프를 도입하지 않는다(`--worker-token` PSK 평문 유출 — `crates/controller/CLAUDE.md` LAN L1 S1/S2, 그리고 `main.rs:366`의 "args를 통째 ?-덤프하지 말 것" 주석). 명시 필드만.

### R4. `GET /api/version` (US1 데이터원)

- `crates/controller/src/app.rs`에 `/api/version` 라우트. 응답 `{"version": "0.7.0"}`(Serialize+Deserialize 양방향 derive — 통합 테스트의 typed 파싱 관행).
- 값은 controller crate의 `env!("CARGO_PKG_VERSION")`(=R1의 workspace 버전).
- `/health`(plain `"ok"`)는 무변경. 인증 없음(단일 테넌트 — §A10 RBAC 착수 시 다른 엔드포인트와 함께).
- 응답 필드는 **`version` 하나로 못 박는다** — 경로·호스트명·설정값을 담지 않는다(공개 표면에 정보를 얹지 않기 위한 의도적 최소화).
- 데스크톱(ADR-0042 in-process)은 같은 라우터라 추가 배선 0.

### R5. UI 헤더 버전 (US1)

- `ui/src/api/hooks.ts`에 `useVersion()`(React Query, `staleTime: Infinity`) + `ui/src/api/schemas.ts`에 `VersionSchema = z.object({ version: z.string() }).strict()`.
  - 서버가 항상 직렬화하는 non-Option 필드라 **plain `z.string()`**(`.optional()`/`.nullish()`/`.default()` 금지 — `ui/CLAUDE.md` top-level `.default()` 누출 함정).
- `ui/src/components/Layout.tsx`: **로고 `<Link>`와 버전 텍스트를 한 래퍼로 감싼다**(예 `<div className="flex items-baseline gap-2">`) → 헤더는 `justify-between` 2자녀 구조를 유지한다. 세 번째 자녀로 넣으면 버전이 헤더 중앙에 뜬다(실측 11).
  - 버전은 `<Link>` **밖**에 둔다(로고 접근명 오염 방지 — U3 함정). 정적 텍스트이므로 링크·버튼이 아니다.
- **`data` 없으면(로딩·에러) 아무것도 렌더하지 않는다** — 에러 배너 없음, 레이아웃 점프 없음.
- i18n(ADR-0035): 보이는 텍스트는 `v0.7.0`뿐이고 보조 설명 `title`만 한국어. 신규 키 **`ko.common.versionTitle = "컨트롤러 버전"`**.
  - 그룹 선택 근거(리뷰 3라운드 관찰 2): `ko.nav`(`ko.ts:248-256`)는 **목적지 링크 라벨 7개**로만 구성돼 헤더 툴팁이 이질적이다 → 앱 셸 공용 문자열이 사는 `ko.common`에 둔다. 값은 동일하므로 아래 충돌 실측 결과는 그대로 유효하다.
  - 충돌 실측(2026-07-30, `ko.ts`의 한국어 포함 문자열 리터럴 전수 대상 양방향 부분문자열 — 카운트는 추출 정규식에 따라 달라지므로 수치는 적지 않는다, 리뷰 2라운드 N4): 채택값에 대해 **기존 값 `"버전"`(`ko.ts:395` `versionCol`, 스텝 템플릿 표 열머리)만** 걸리고 역방향(채택값 ⊂ 기존값)은 없다. 다른 화면이라 실제 충돌은 없지만, **헤더 단언은 정확매치/testid로** 쓸 것(`toHaveTextContent(ko.nav.versionTitle)` 류의 부분문자열 단언 금지 — thinkboard-defaults 함정). 후보 `"실행 중인 컨트롤러 버전"`은 `"실행"`·`"실행 중"`·`"행"`까지 걸려 기각.

### R6. 버전 정합 검사 스크립트 (US5)

- `scripts/check-release-versions.sh <tag>` (신규, **`#!/usr/bin/env bash` + `set -euo pipefail`, 모드 100755 커밋**, `jq` 사용 — ubuntu-latest·개발 머신 둘 다 보유). exit 0=정합 / 1=불일치. **불일치 항목 전부를 이름과 함께 출력**한 뒤 실패한다(첫 항목에서 중단하지 않는다 — 한 번에 다 고치게).
- 기대값 `want` = `tag`에서 선행 `v` 1개 제거.
- 검사 5종:

| # | 대상 | 파싱 방법 |
|---|---|---|
| 1 | 루트 `Cargo.toml` `[workspace.package] version` | **섹션 스코프**: `[workspace.package]`부터 다음 `[`까지에서 `version` (실측 10 — 열 0의 `version = "0.6"`(wiremock)가 있어 naive `grep '^version'`은 틀린 줄을 읽는다) |
| 2 | `desktop/src-tauri/Cargo.toml` `[package] version` | 같은 섹션 스코프 방식(현재는 :3이라 우연히 안전하지만 재정렬에 썩는다) |
| 3 | `desktop/src-tauri/tauri.conf.json` `.version` | `jq -r .version` |
| 4 | `Cargo.lock` + `desktop/src-tauri/Cargo.lock`의 `handicap-{engine,proto,worker-core,worker,controller}` | 각 `name = "..."` 블록의 다음 `version` 줄 |
| 5 | **`desktop/src-tauri/Cargo.lock`의 `name = "desktop"` 블록** | 같은 방식. **v0.2.1이 실제로 stale이던 항목**(실측 4) — 이 검사가 US5가 인용하는 사고를 막는다. 루트 락엔 `desktop` 항목이 없다(별도 워크스페이스) |

- `docs/release-notes/v<ver>.md` 존재 여부는 **stdout 알림만**(`notes: present|absent`) — 실패시키지 않는다(R9 폴백 정책과 정합: 파일이 없어도 자동 초안으로 발행된다).
- 워크플로가 이 스크립트를 호출한다(로직을 YAML에 인라인하지 않는다 — 태그 밀기 전 로컬 실행·양방향 테스트가 가능해야 한다).

### R7. `justfile` bump 헬퍼 (US5 예방 축)

> **US 앵커 주의**: US5가 요구하는 것은 *빌드 전 탐지*(R6)다. 이 헬퍼는 그 탐지가 발동할 일 자체를 줄이는 **예방 축**이고, 사용자가 "범위 트림(bump-version 제거)" 선택지를 보고 기각해 명시 채택했다(2026-07-30). 리뷰 C4에 대한 답 = 유지 + 이 앵커 명시.

- `just bump-version <ver>`: 3개 파일(루트 `Cargo.toml`·`desktop/src-tauri/Cargo.toml`·`desktop/src-tauri/tauri.conf.json`) 버전 갱신 → 두 워크스페이스에서 락 재생성 → `scripts/check-release-versions.sh v<ver>`로 **자기 결과를 검증**(락 재생성 명령이 틀리면 여기서 잡힌다).
- 락 재생성: **`cargo update --workspace`를 1차 후보로 두되 provisional로 취급한다**(리뷰 2라운드 N2) — 루트와 `--manifest-path desktop/src-tauri/Cargo.toml` 각각. `cargo generate-lockfile`은 전체 재해상도라 **금지**(무관한 의존이 함께 올라간다). 폴백은 앞서 실측된 `cargo metadata --format-version 1 >/dev/null`.
  - **왜 provisional인가**: ① `desktop/src-tauri/Cargo.toml:15`는 빈 `[workspace]`라 그 워크스페이스의 유일한 *멤버*는 `desktop`이고, `handicap-*`는 비-멤버 path 의존이라 `--workspace`(멤버 한정) 의미론에 안 걸린다 ② 현재 bump 안 된 트리에서의 `--dry-run`은 매니페스트·락이 모두 `0.1.0`으로 일치하므로 **원리적으로 no-op** — 올바른 명령과 틀린 명령을 구별할 수 없었다.
  - **수락 조건은 명령 이름이 아니라 결과다**: bump 후 `scripts/check-release-versions.sh v<ver>`가 **exit 0**(R6 #4가 두 락파일을, #5가 `desktop` 항목을 검사한다). plan은 실제로 bump를 돌려 어떤 명령이 두 락을 다 갱신하는지 확정한다.
- **네트워크 의존**: `--offline`을 붙이지 말 것(실측 2026-07-30 macOS: `error: failed to download linux-raw-sys v0.4.15 … --offline was specified` exit 101 — 락에 타 플랫폼 의존이 있어 오프라인 resolve가 실패).
- 커밋·태그·push는 **하지 않는다**(사람이 확인 후 수행 — 외부 영향 행위).

### R8. CI 3-잡 재구성 (US4)

```
preflight (ubuntu-latest, ~10s)
   ├─→ windows-build (windows-latest,  빌드만 + upload-artifact)
   └─→ macos-build   (macos-latest, matrix ×2, 빌드만 + upload-artifact)
              ↓
        publish (ubuntu-latest)   needs: [windows-build, macos-build]
```

- **모든 잡의 checkout에 `ref: ${{ inputs.tag || github.ref }}`**(리뷰 FR7): 현재는 어느 잡도 `ref:`를 안 줘서 `workflow_dispatch` 경로가 **디스패치 브랜치를 체크아웃**한다 → preflight가 임의 `inputs.tag`를 master 매니페스트와 비교하고 빌드는 master 코드를 그 태그로 라벨한다(=US5가 겨냥한 그 버그의 잔여 사례).
- **preflight**: checkout 후 `scripts/check-release-versions.sh "${{ inputs.tag || github.ref_name }}"`. 실패면 빌드 잡이 시작조차 하지 않는다(18분 낭비 차단).
- **windows-build**: 현행 스텝(UI 빌드 → protoc → rust → rust-cache) 유지. `tauri-action`에서 `tagName`/`releaseName`/`releaseDraft`/`prerelease` **제거**(=빌드만) → 포터블 exe 빌드 → 리네임까지 잡 안에서 마친 뒤 artifact 업로드. **릴리즈를 만들지 않는다.** 산출물 경로(리뷰 FR6 — `--target` 미지정이라 macOS와 비대칭):
  - `desktop/src-tauri/target/release/bundle/nsis/*.exe`
  - `desktop/src-tauri/target/release/bundle/msi/*.msi`
  - `target/release/controller.exe` → `Handicap_<ver>_x64-portable.exe`로 복사(현행 스텝 그대로)
  - 경로 확정은 **CI에서만 검증 가능**(~18분/이터레이션, macOS 개발기 재현 불가) → plan은 `tauri-action`의 `artifactPaths` 출력을 폴백으로 병기한다.
- **macos-build**: 현행 유지 + `Attach dmg to release` 스텝(폴링 루프 + `gh release upload`) **삭제**. artifact 2종:
  - 발행용 `release-assets-macos-<target>` — `.dmg`만
  - 회수용 `macos-bundle-<target>` — `if: always()`, bundle 디렉터리 전체(dmg 변환 실패 시 `.app` 확인용 현행 경로 **보존**)
  - windows도 발행용은 `release-assets-windows` → publish가 `release-assets-*`만 내려받아 회수용이 섞이지 않는다.
- **publish**: `actions/download-artifact@v4`(`pattern: release-assets-*`, `merge-multiple: true` — v4.1.0+ 입력) + **자체 checkout**(노트 파일을 읽어야 한다 — 리뷰 FR7).
  - 릴리즈 없으면 `gh release create <tag> --title "Handicap <tag>" <에셋들>` + 노트(아래), 있으면 `gh release upload --clobber` + 노트 갱신 → **재실행 멱등**.
  - 노트 결정(실측 8 — `gh release edit`엔 `--generate-notes`가 없다):
    1. `docs/release-notes/v<ver>.md` 있음 → create/edit 둘 다 `--notes-file <파일>`
    2. 없음 + **create 경로** → `--generate-notes`
    3. 없음 + **edit 경로**(재실행) + 기존 본문이 비어 있음 → `gh api --method POST repos/{owner}/{repo}/releases/generate-notes -f tag_name=<tag> | jq -r .body`를 `gh release edit <tag> --notes-file -`로 주입
       - **"비어 있음" 술어는 `[ -z "$(gh release view "$tag" --json body -q .body)" ]`**(명령치환이 개행을 제거). 바이트 수로 판정하지 말 것 — 실측: 빈 본문은 `-q .body | wc -c` = **1**(개행), `-q '.body|length'` = 0이라 `wc -c`-기반 조건은 오발화한다(리뷰 2라운드 N3. US3 통과 신호의 "길이 1 B"는 *관찰* 표현이고 *판정식*이 아니다)
    4. 없음 + edit 경로 + 기존 본문 있음 → 그대로 둔다(같은 런의 1차 시도가 이미 채운 경우)
  - 재시도: **최대 5회 시도**(=최초 1회 + 재시도 4회), 지연 10/20/40/80초 → **총 대기 150초(≈2.5분)**. **오류 분류 없음**(실측 7) — 4xx도 5회를 소모하지만 총 2.5분이고 재실행이 수십 초다. 지연은 로컬 스텁 테스트를 위해 env로 오버라이드 가능해야 한다(`PUBLISH_RETRY_DELAYS`).
  - **스크립트는 bash 3.2에서 동작해야 한다**(개발 머신 실측: `GNU bash 3.2.57`, `mapfile` **없음**) — 게시 로직을 로컬에서 `gh` 스텁으로 테스트하는 것이 이 슬라이스의 유일한 검증 수단이므로, `mapfile`/`declare -A` 같은 bash 4+ 문법을 쓰지 말고 `while IFS= read -r` 루프를 쓴다.
  - **없는 glob이 publish를 죽이면 안 된다**: `set -euo pipefail` 하에서 매치 없는 dmg glob이 에러가 되지 않게 존재 파일만 수집한다(현행 `release.yml:162-163`의 dmg 하드-fail은 **의도적이었고 publish에는 옮기지 않는다** — 리뷰 C1).
  - 실행 조건: `if: always() && needs.windows-build.result == 'success'` — macOS **양쪽이 다 실패해도 발행**하고 누락 에셋을 로그에 남긴다(리뷰 M6). windows 빌드 실패면 발행하지 않는다.
- **불변(에셋 *이름*)**: `Handicap_<ver>_x64-setup.exe`·`..._x64_en-US.msi`·`..._x64-portable.exe`·`..._aarch64.dmg`·`..._x64.dmg`와 릴리즈 이름 `Handicap v<ver>`은 v0.7.0과 동일하게 유지한다. **이는 *네이밍* 불변식이고 *완전성* 불변식이 아니다**(리뷰 C1): macOS가 실패하면 3개만 올라간다(v0.6.0 실물도 Windows 3종뿐).

### R9. 릴리즈 노트 파일 (US3)

- 신규 디렉터리 `docs/release-notes/`. 파일명 `v<ver>.md`, 내용은 **본문만**(제목은 릴리즈 이름 담당).
- 이번 산출물: **`docs/release-notes/v0.6.0.md`** — 원천은 `docs/build-log.md`의 v0.5.0~v0.6.0 구간(실측 65커밋: trustworthy-open-test §A11 1차·pair-input-blur-commit·dynamic-vars·scenario-notes·genvar-preview-ux·scenario-preflight).
- 섹션 구성은 v0.7.0 본문 선례(하이라이트 / 다운로드 표 / 참고+compare 링크)를 따르되 **v0.6.0 실물 에셋은 Windows 3종뿐**이므로 macOS 행과 "macOS 첫 실행" 절을 **복사하지 않는다**(리뷰 지적 — v0.6.0 에셋 실측: `Handicap_0.6.0_{x64-portable.exe,x64-setup.exe,x64_en-US.msi}`).
- **게시는 별개 행위**: `gh release edit v0.6.0 --notes-file ...`은 공개 레포 릴리즈 본문 변경이므로 **파일 리뷰 후 사용자 확인을 받고** 실행한다(슬라이스가 자동 실행하지 않는다).

### R10. 문서 갱신

- `docs/dev/tauri-desktop-build.md` §CI 릴리즈: 새 3-잡 그래프, **bump 대상**(사람이 고치는 3파일 + 생성물 락 2개, 5 crate는 1회성 상속), `just bump-version` 사용, **노트 작성을 명시 체크 단계로**, 장애 시 재실행 레시피(실패한 publish 잡만 재실행 → artifact 재사용), 수동 폴백(`gh release create v<ver> <파일들>`).
- 같은 파일 `:51`의 릴리즈 이력 나열에 `v0.5.0`·`v0.6.0`이 빠져 있다 → 채운다.
- `:53`의 stale-lock 함정 노트에 "이제 `scripts/check-release-versions.sh`가 기계로 검사한다" 한 줄 추가.

### R11. 불변 (회귀 경계)

- 비-bundle 빌드의 **런타임 동작 무변경**(추가는 `--version` 처리·로그 한 필드·라우트 1개).
- 기존 REST 응답 shape·기존 UI 화면 무변경(헤더 텍스트 1개 추가 외).
- proto·migration·엔진 **0-diff**. `.github/workflows/ci.yml` 무변경.

## 엣지 케이스

- **`workflow_dispatch` 태그 입력**: preflight·publish가 같은 표현식(`inputs.tag || github.ref_name`)을 쓰고, checkout `ref`도 태그를 가리켜야 한다(R8 — 안 그러면 태그와 다른 트리를 검사·빌드한다).
- **태그에 `v` 접두 없음**(수동 입력 `1.2.3`): 스크립트는 선행 `v`만 제거하므로 그대로 비교된다 — 자동 경로(`v*` 트리거)에선 발생하지 않고 수동 오입력은 preflight 불일치로 드러난다.
- **재실행 시 릴리즈가 이미 존재**: `upload --clobber` + 노트 4분기(R8) — 멱등.
- **macOS 한 아키텍처만 성공 / 양쪽 실패**: `fail-fast: false` 유지, publish는 존재 에셋만 올리고 누락을 로그에 남긴다(발행은 계속).
- **UI가 구 컨트롤러에 붙음**: `/api/version`이 **404가 아니라 200 `index.html`**을 줄 수 있다(실측 9 — SPA fallback 상속). Zod 파싱이 실패해 `data`가 없으므로 **R5의 미렌더 규칙이 그대로 fail-soft**로 동작한다(결과는 같지만 메커니즘이 404가 아니라 파싱 실패임을 plan/테스트가 알아야 한다 — 404를 가정한 검증은 성립하지 않는다).

## 비목표 (후속 후보)

- **`deploy/helm/handicap/Chart.yaml`(`version`/`appVersion`)·`ui/package.json`의 `0.1.0` 동기화**(실측 12): Helm 차트는 `v*` 태그 릴리즈 채널이 **아니고**(K8s 경로는 태그로 배포되지 않는다) 차트 `version`은 앱 버전과 다른 의미론(차트 개정)을 갖는다. `ui/package.json`은 미배포 패키지다. → R6 검사에 넣지 않는다. **결과: 이 슬라이스 후 레포엔 `0.7.0` 3곳 + `0.1.0` 3곳이 공존한다**(의도된 상태, 이 불릿이 근거).
- git SHA·빌드 신원 표면화(dev 빌드 식별) — additive로 나중에.
- v0.1.0·v0.2.0·v0.2.1·v0.2.2·v0.4.0 소급 작성(자료는 build-log에 있음, 우선순위 낮음).
- 코드 서명·공증(SmartScreen/Gatekeeper) — 데스크톱 배포 테마 별건.
- 설정 화면 '정보' 섹션(데이터 경로 등 지원 정보 묶음).
- 릴리즈 노트 자동 생성(커밋→사용자 관점 번역) — 품질 하향이라 기각 상태.
- `--version` 출력 이름 커스터마이즈(`handicap 0.7.0`).
- `gh api` 경유 HTTP 상태 기반 재시도 분류 — 실측 7의 제약을 우회하려면 업로드까지 raw API로 옮겨야 해서 비용이 이득을 넘는다.

## 테스트 전략

- **Rust(controller)**: ① `/api/version` 통합 테스트(신규 `crates/controller/tests/version_api_test.rs`) — 200 + typed 파싱 + `env!("CARGO_PKG_VERSION")` 일치. ② `Cli::command().render_version()`이 `CARGO_PKG_VERSION`을 포함하는지 인라인 단위 테스트(`main.rs`엔 인라인 test mod가 이미 있다).
- **Rust(worker)**: `worker/src/main.rs`의 `--version` 배선 테스트. **이 파일엔 인라인 `#[cfg(test)]`가 없다** → 아래 tdd-guard 순서 참조.
- **UI**: ① 신규 테스트 — 훅이 값을 주면 `v0.7.0` 렌더 / 값 없으면 **미렌더**(`queryBy…` not). 훅 모킹은 `vi.mock("../../api/hooks", importOriginal spread)`(bare auto-mock 금지 — 형제 모듈이 죽는다). ② **기존 `ui/src/components/__tests__/Layout.test.tsx`가 `MemoryRouter`만으로 렌더한다(:9-13)** → `useVersion()` 추가 시 *No QueryClient set*으로 **확정 RED**이고, `vi.mock`은 파일 스코프라 새 테스트의 모킹이 구 파일을 구제하지 못한다. `pnpm test`는 pre-commit UI 게이트 안이므로 **이 파일 갱신(QueryClientProvider 래핑 또는 훅 모킹)을 명시 스텝으로** 둔다(리뷰 FR1).
  - 회귀 가드는 **이빨 실증** 필수: 렌더 조건을 고의로 뒤집어 RED 확인 후 원복.
  - 헤더 인접 배치(실측 11)는 DOM 존재로 증명되지 않는다 → **라이브 `getBoundingClientRect`**로 로고와의 간격을 잰다([[review-findings-are-hypotheses]]·[[implementation-rigor-over-spec]]).
- **스크립트(R6)**: 정합 태그로 exit 0. **검사 5종을 하나씩 어긋나게 만들어** 그 항목이 실제로 잡히는지 확인(특히 #4·#5 락 검사 — 나머지가 통과하는 상태에서만 이빨이 증명된다). 섹션 스코프 파싱은 wiremock `version = "0.6"`(실측 10)이 답으로 나오지 않는지도 확인.
- **publish 재시도**: PATH 앞단에 **2회 실패 후 성공하는 `gh` 스텁**을 놓고 루프를 로컬 실행 → 3회차 성공·총 3회 호출. **이 테스트가 증명하는 것은 "루프가 유한 재시도한다"뿐이고 오류 분류는 아니다**(분류를 하지 않기로 했으므로 — 스텁이 판정 대상 문자열을 저작하는 공허한 분류 테스트는 만들지 않는다, 리뷰 FR3).
- **게이트**: `crates/*/Cargo.toml`+`Cargo.lock` 변경이라 pre-commit **full cargo 게이트**(수 분) + `ui/src` 변경이라 **UI 게이트**.
  - **bundle 수동 확인은 `R3 #2`와 `R3 #3` 둘 다 대상이다**(리뷰 3라운드 P1): `crates/controller/src/lib.rs:11-12`가 `#[cfg(feature="bundle")] pub mod in_process;`이므로 **`in_process.rs`는 pre-commit도, 기본 feature `cargo build --workspace`도 컴파일하지 않는다** — 오타 하나가 모든 green 게이트를 통과한 뒤 릴리즈 CI의 desktop 빌드 18분째에 처음 드러난다. (이 사실은 N1과 정합한다: `desktop/src-tauri/Cargo.toml:33`이 `handicap-controller`를 `features = ["bundle"]`로 의존한다.)
  - 따라서 `cargo build/clippy -p handicap-controller --features bundle`(`ui/dist` 선빌드 필요) + **필터 없는 전체** `cargo test -p handicap-controller --features bundle`을 수동 실행한다. 필터 실행이 "기능이 켜질 때 깨지는 기존 테스트"를 놓친 선례가 `crates/controller/CLAUDE.md`에 기록돼 있고, `in_process.rs`의 인라인 테스트 mod(`:439`)도 bundle-only라 이번엔 그 위험이 더 크다.

## 라이브 검증 (US 앵커 표)

CI 경로(US3~US5)는 실제 태그를 밀지 않고는 종단 확인이 불가하므로 **대체 증명**을 명시한다.

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 워크트리 자체 바이너리로 기동(`./target/debug/controller --db /tmp/relhyg.db --ui-dir ui/dist`) → 브라우저 진입 | 헤더 로고 **바로 오른쪽**에 `v0.7.0`. `getBoundingClientRect`로 로고와 인접(중앙 부유 아님) 확인 + `getComputedStyle`로 muted 계열 + 로고 `<Link>` 접근명에 버전 문자열 **미포함** |
| US1' | **`pnpm dev`(5173)로 SPA를 띄우고 8080 컨트롤러를 죽인 상태**로 진입(리뷰 FR9 — 컨트롤러가 SPA를 서빙하는 US1 구성에서 컨트롤러를 죽이면 `ERR_CONNECTION_REFUSED`로 헤더 자체가 없어 관찰 불가) | 헤더에 버전이 **없고** 에러 배너·레이아웃 붕괴 없음. 콘솔에 Zod raw 에러 배너 미표시 |
| US2 | `cargo run -p handicap-controller --bin controller -- --version` / `cargo run -p handicap-worker --bin worker -- --version` / `cargo run -p handicap-controller --bin controller --features bundle -- --version` | 세 경로 모두 `0.7.0` 출력(bundle 포함) |
| US3 | `docs/release-notes/v0.6.0.md` 리뷰 → **사용자 확인 후** `gh release edit v0.6.0 --notes-file` | `gh release view v0.6.0 --json body` 길이 1 B → 수 KB. 다운로드 표가 실제 v0.6.0 에셋 3종과 일치(macOS 행 없음) |
| US4 | 재시도 루프를 `gh` 스텁으로 로컬 실행 + 워크플로 grep | 스텁 3회차 성공·총 3회 호출. build 잡에 릴리즈 생성 스텝 **없음**(grep `tagName` 0) · publish에 `download-artifact` 존재 |
| US5 | `scripts/check-release-versions.sh v0.7.0` → exit 0. 검사 5종을 하나씩 어긋나게 만들어 재실행 | 정합 0 / 각 불일치 1 + 불일치 항목이 이름과 함께 출력. `workflow_dispatch` 경로의 `ref:`가 태그를 가리키는지 워크플로 grep |

## 진행 시 유의 (repo 함정 결합)

- **`spec-review-guard`**: `crates/*/src`·`ui/src` 편집이라 plan clean APPROVE 후 `REVIEW-GATE: APPROVED` 마커 필수.
- **`tdd-guard` 파일별 순서**(리뷰 FR2 — 실측: 훅은 `/crates/.+/src/.+\.rs$`를 감시하고 인라인 `#[cfg(test)]`를 가진 파일은 통과시킨다):

| 파일 | 인라인 test | 결론 |
|---|---|---|
| `crates/controller/src/app.rs` | **0** | R4 라우트 편집이 **차단됨** → `crates/controller/tests/version_api_test.rs`를 **먼저** 생성(라우트 한 줄에 `#[cfg(test)]`를 붙일 수는 없다) |
| `crates/worker/src/main.rs` | **0** | R2 편집 차단 → 버전 테스트를 **같은 Edit에 포함**하거나 pending 테스트 파일을 먼저 만든다 |
| `crates/controller/src/main.rs` · `crates/controller/src/in_process.rs` · `crates/worker/src/lib.rs` | 있음(`:439` 등) | 자유 |
| `crates/*/Cargo.toml`·워크플로·스크립트·docs | 미감시 | 자유 |
| `ui/src/**` | — | 테스트 파일 편집을 **첫 스텝**으로(`ui/CLAUDE.md`) |

- **커밋 비용**: cargo-영향 경로라 매 커밋 full 게이트 수 분 → 커밋은 `run_in_background`, 그동안 다른 `cargo` 호출 금지(`target/` 락 경합).
- **보안 게이트**: `finish-slice §0` grep이 지배한다(예측으로 스킵 금지 — think-time-defaults 선례). grep이 N/A여도 **판단 재검토**: 이 슬라이스는 버전 문자열을 **새 sink(공개 REST 응답·공개 릴리즈 본문)로** 옮기므로 ① `/api/version`이 버전 외 정보를 담지 않는지(R4가 필드를 1개로 못 박은 이유) ② v0.6.0 노트 본문에 내부 경로·호스트명·토큰류가 섞이지 않는지 확인한다.
