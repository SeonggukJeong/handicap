# run-identity — run 라벨 + 자동 설정 요약 (비교·목록·상세 식별성)

- **날짜**: 2026-08-09 · **유형**: user-path · **슬라이스 브랜치**: `worktree-run-identity`
- **연관**: A4b run 비교(ADR-0030 — `#끝6자` 축약 라벨의 출처) · run-list-filter-sort(필터 툴바 — 검색 축이 여기 얹힌다) · Run 스케줄러(ADR-0034 — 자동 라벨 입력원) · scenario-notes(`a4f5074` — 운반-전용 사용자 텍스트 필드 선례, 단 그건 시나리오 소유·이번엔 run 소유) · compare-view-polish(`runLabel.ts` 단일 소스 구조)
- **ADR**: **ADR-0052 신설(마무리 시)** — run 라벨: 단일 TEXT 컬럼 + 표시 폴백 체인(`label ?? #끝6자`) + 스케줄 자동 라벨. 장문 메모·`schedule_id` 구조 컬럼 기각을 기록.
- **diff 스코프**: 컨트롤러(migration 1·API 3지점·export 1시트) + UI. **proto/엔진/워커 0-diff** — 라벨은 컨트롤러↔UI 사이에만 산다(워커는 라벨을 모른다). 근거 §14 클레임 레저.

## 사용자 스토리 (US)

- **US1**: QA가 비교 화면에서 여러 run을 나란히 볼 때 어느 열이 어떤 시험인지 알아본다 — 성공하면 각 열 헤더에서 라벨(없으면 `#끝6자`)과 시각·설정 요약(예: "고정 20 VU · 60s")을 읽고, 화면 밖 기억 없이 열들을 구분한다.
- **US2**: QA가 run을 돌리기 전에 이 run이 무슨 시험인지 적어둔다 — 성공하면 RunDialog에 적은 라벨(예: "커넥션 풀 2배 후")이 run 목록·상세·비교 헤더에 그대로 보인다.
- **US3**: QA가 시간이 지난 뒤 run 목록에서 과거의 특정 시험을 되찾는다 — 성공하면 검색 칸에 라벨 일부(또는 비교 화면에서 본 `#끝6자`)를 입력했을 때 해당 run 행만 남는 것을 본다.
- **US4**: QA가 이미 끝난 run들을 훑으며 나중에 알게 된 맥락을 붙인다 — 성공하면 run 목록 행(또는 상세 헤더)에서 라벨을 편집하고, 새로고침 후에도 그 라벨이 유지되는 것을 본다.
- **US5**: 운영자가 run 목록에서 스케줄이 자동 발사한 run과 수동 run을 구분한다 — 성공하면 스케줄 발사 run에 스케줄 이름이 라벨로 자동 붙어 목록·상세·비교에서 보이는 것을 확인한다.

## 1. 배경·문제 — 현재 run 식별 수단 (실측)

| 표면 | 지금 보이는 것 | 근거 |
|---|---|---|
| run 목록 | 상태·verdict·VU·시간·생성 시각. **run id 텍스트 없음**(체크박스 aria-label에만). 같은 설정 반복 run은 컬럼상 동일 | C20 |
| 비교 매트릭스/오버레이 | `#끝6자`(`runShortLabel`) + 세션-한정 위치 색. **시각·프로파일 없음** | C3·C14 |
| run 상세 | **앞 8자** `#a1b2c3d4` — 비교 뷰의 끝 6자와 축약이 어긋남 | C4 |
| 생성 시 | 라벨 입력 없음. 유일한 이름 입력(`presetName`)은 프리셋 소유 | C6·C17 |
| 스케줄 발사 run | 수동 run과 전 표면 무구분(`spawn_run` 공유·마커 0) | C7·C19 |
| export | full ULID만. Runs 시트 5열에 라벨 없음 | C15 |

즉 사람이 run을 구분할 안정 수단은 **생성 시각 하나**다. 사용자 확인(2026-08-09): pain은 네 지점 전부(비교 화면·대상 선택·시간 경과 후·상세), 구분 정보는 설정 차이(자동 도출)+의도/맥락(수동) 둘 다, 라벨은 생성 시+사후 둘 다.

## 2. 범위 / Non-goals

**범위**: ① `runs.label` 컬럼 + create/스케줄러/사후-편집 관통 ② 표시 폴백 `label ?? #끝6자` 전 표면(목록·상세·비교 3표면·오버레이) + 비교 헤더에 시각·설정 요약 서브라인 ③ 순수 `profileSummary` 헬퍼 ④ 목록 검색 축(라벨∨id 부분일치) ⑤ 비교 XLSX Runs 시트 label 열 ⑥ 상세 축약 앞8자→끝6자 통일.

**Non-goals (연기·기각 — finish 시 roadmap §B 기록)**:
- run-레벨 장문 메모 — 라벨 한 줄로 한정(시나리오 `notes`가 장문 담당, run 회고 장문은 수요 확인 후).
- `schedule_id`/preset 구조 링크 컬럼 — 라벨 문자열이 출처를 나름(사용자 결정 2026-08-09, 접근 C 기각).
- 비교 export 고정 파일명(`comparison.*`) fix — 사용자 결정으로 이번 제외, 연기 기록만.
- CSV(단일·비교)의 라벨 열, 라벨 정렬 축, 라벨 유니크 강제, InsightCompareMatrix 서브라인(밀도 — 라벨만 공유).
- 라벨 편집 이력·감사 — 단순 UPDATE.

## 3. 데이터 모델·검증 (서버)

**migration**: `runs.label TEXT NULL` — Rust-guarded ALTER(`ensure_runs_label`, `verdict_json` 패턴 C2 미러: pragma_table_info 가드 + `connect()` 배선). 스캐폴드는 구현 시 `/new-migration` 스킬. NULL=라벨 없음(빈 문자열은 저장 전 None으로 정규화되므로 DB에 `''`가 들어갈 경로 없음).

**정규화·검증 단일 소스**: 순수 `normalize_label(raw: Option<String>) -> Result<Option<String>, String>` (`api/runs.rs` 인라인) —

1. `None` → `Ok(None)`.
2. `Some(s)` → trim → 빈 문자열이면 `Ok(None)`.
3. trim 후 `chars().count() > 200` → `Err`(400 메시지 — 한국어, 바이트 아님 문자 수: 한국어 라벨 기준 친화).
4. 그 외 → `Ok(Some(trimmed))`. 개행 등 공백 문자는 별도 거부 안 함(UI 입력이 한 줄 `<input>`이라 정상 경로에선 안 들어오고, curl 주입도 표시 무해 — React escape).

create(REST)와 사후-편집 PUT이 **같은 함수**를 쓴다. 스케줄러만 예외(§4 — 에러 대신 truncate).

**store** (`store/runs.rs`): `RunRow`에 `pub label: Option<String>`(C9) · `insert` 6번째 파라미터 `label: Option<&str>`(C8 — **프로덕션 호출처는 `spawn_run` 안 1곳(`api/runs.rs:679`)뿐이지만 테스트 호출처가 ~14곳**(crash_recovery·export_routes·report·dispatcher_subprocess 통합 + runner/coordinator/schedules 인라인) — 같은 green 커밋에서 전부 `None` 부착, `enqueue` arity 선례) · 신규 `update_label(db, id, label: Option<&str>) -> sqlx::Result<Option<RunRow>>`(UPDATE 후 재조회, 미존재 None→404). 조회 쿼리들(`get`/목록)의 SELECT·row 매핑에 label 추가.

## 4. 라벨 관통 경로 3개

`spawn_run`은 7번째 파라미터 `label: Option<&str>`을 받아 `runs::insert`에 전달(C7 — 시그니처 변경 시 호출처는 **전수 2곳**: REST create `api/runs.rs:954` + 스케줄러 `runner.rs:186`, 컴파일러-driven).

1. **REST create**: `CreateRunRequest`에 `#[serde(default)] pub label: Option<String>`(C6 — 기존 클라·curl·프리셋 저장 경로 무영향). 핸들러가 `normalize_label` 통과 후 `spawn_run`에 전달(400은 insert 전 — run row 잔존 없음).
2. **스케줄러**: `runner.rs:186` 발사에서 `Some(&sched.name)`(C16·C19). 단 자동 경로는 400을 낼 수 없으므로 `normalize_label` 대신 **truncate 정책**: `sched.name` trim 후 200자 초과분은 잘라서 전달(스케줄 이름 자체는 이미 스케줄 CRUD가 검증하는 별개 필드 — 여기선 방어적 클램프만).
3. **사후 편집**: 신규 `PUT /api/runs/{id}/label`, body `{"label": string | null}`(serde `Option<String>` + `#[serde(default)]` — 키 부재·null 동일 취급=라벨 제거). `normalize_label` → `update_label` → 200 갱신된 `RunResponse` / 404 미존재 / 400 검증 실패(레거시 CRUD 컨벤션 — 422 아님). **terminal 여부 무관 허용**(사후 라벨링이 주 용도). 라우팅: `/runs/{id}/label`은 리터럴 세그먼트라 기존 `/runs/{id}` 캡처와 무충돌(`report.csv` 선례).

## 5. 와이어·Zod 계약 (S-D 클래스 명시)

| 지점 | Rust | UI Zod | 근거 |
|---|---|---|---|
| `RunResponse.label` | `Option<String>` **plain**(skip 없음 — None→`null` 직렬화, `message`/`verdict` 선례 C5) | `RunSchema.label: z.string().nullish()`(C10 — `.optional()`이면 서버 null에 파싱 깨짐, S-D 함정) | C5·C10 |
| `ReportRun.label` | `#[serde(default, skip_serializing_if = "Option::is_none")]` — None이면 **absent** → 무라벨 run 리포트 byte-identical + 골든 fixture `compare_golden.json` 무변경(deserialize는 default) | `ReportRunSchema`(`.strict()` C11)에 `label: z.string().optional()`(absent-only라 null 안 옴 — B7-C `download` 패턴) | C11·C12 |
| `CreateRunRequest.label` | `#[serde(default)]` | RunDialog payload: 조건부 spread `...(trimmed ? { label: trimmed } : {})` — `label: undefined` 키 존재 금지(byte-identical 함정, ui/CLAUDE.md `buildProfile` spread 규칙과 동형) | C6 |

`ReportRun` 리터럴 사이트 전수 = 프로덕션 `report.rs:949` + 테스트 픽스처 `export.rs:603`(C12) — 컴파일러가 강제. `RunResponse` 매핑은 `to_response` 1곳(C18). **비교 뷰가 라벨을 받는 경로는 리포트 N-fetch**(비교 페이지는 run 목록을 별도 fetch하지 않는다, C14) — 그래서 `ReportRun.label`이 필수 와이어다.

## 6. 입력 UX

**RunDialog** (C17 — 현재 라벨 입력 없음):
- 최상단(모드 토글 아래·간단/상세 **공통** — 식별 필드는 가시성 게이트 밖)에 선택 `Input` 1개: 라벨(placeholder 예: "예: 커넥션 풀 2배 후"), `maxLength={200}`. 라벨·placeholder·aria 전부 ko 카탈로그 경유(§11).
- **프리셋 로드 시 no-clobber 시드**: `loadPreset`(C17 `:330` 부근)에서 라벨 칸이 비어 있을 때만 `p.name`으로 시드(이미 입력했으면 안 덮음 — KeyValueGrid 헤더 피커 no-clobber 이디엄).
- **retry/즉시 재실행 프리필**: `initial?.label ?? ""` 시드(reseed-by-key 기존 구조 그대로 — 같은 시험 재실행이니 라벨 승계가 자연, 중복 허용 도메인).
- payload는 §5의 조건부 spread. `buildProfile`은 무접촉(라벨은 profile 밖 top-level — ADR-0013의 run config와도 구분되는 run 메타데이터).

**사후 편집 2표면** (US4):
- **RunDetailPage**: h2는 지금처럼 유지하되 축약만 통일(§7), 라벨은 h2 **밖 형제 행**에 표시+편집(연필 버튼 → 인라인 input, Enter/blur 커밋·ESC 취소) — heading accname 오염 금지 캐넌(배지 형제 배치와 동일). mutation 성공 시 run 쿼리 invalidate.
- **ScenarioRunsPage 행**: 신규 라벨 열(§7)의 셀에서 인라인 편집(행별 draft + 편집 버튼, `EnvironmentsPage`/`SettingsPage` per-row draft 관용구 미러). **mutation `onSuccess`에서 해당 행 draft를 비울 것** — 안 비우면 invalidate 재페치 후 stale draft가 남는 문서화된 함정(compare/CLAUDE.md per-row 편집 버퍼).
- 편집 mutation 실패는 swallow 금지 — `role="alert"` 배너(기존 관용구).

## 7. 표시 — 단일 소스 확장

**`runLabel.ts` 확장**(C3): `runDisplayLabel(id: string, label?: string | null): string` = `label?.trim() ? label : runShortLabel(id)`. 기존 `runShortLabel`/`runColor`는 무변경.

- **비교 매트릭스 + 인사이트 매트릭스**: `ScenarioComparePage`의 `runLabels` 맵(C14 `:150-154`)을 `runDisplayLabel(id, report.run.label)`로 채우면 두 표면(`:231`·`:237`)에 자동 전파 — 컴포넌트 쪽 라벨 코드는 무변경.
- **비교 열 헤더 2줄화**(`CompareMatrix.tsx:137-152`, C14): 1줄 = 기존 버튼(스와치+`labels[runId]`+`(base)`) 유지. 2줄 = **버튼 밖 형제** 비대화형 서브라인(muted text-xs): `{시각} · {profileSummary}`. 시각=`report.run.created_at`의 `toLocaleString()`, 요약=§8(리포트의 `run.profile`은 `z.unknown()`(C11)이라 `ProfileSchema.safeParse`로 파싱 — 실패 시 요약 세그먼트 생략, fail-soft). 버튼 안에 넣지 않는 이유: baseline-전환 버튼의 accname이 시각·요약까지 흡수해 오염된다.
- **오버레이 범례**: `overlaySeries.ts:23`(C14 — 유일하게 labels 맵 비경유)을 `runDisplayLabel(r.run.id, r.run.label)`로 교체.
- **run 목록**: "상태" 앞에 신규 **라벨 열** — 셀 = `label`(있으면) / **muted `#끝6자`**(없으면 — "—"가 아니라 id 축약을 노출해 목록의 "id 텍스트 0" 문제(C20)도 함께 해소, US3의 `#끝6자` 검색과 짝). + §6의 인라인 편집.
- **run 상세 축약 통일**(C4): `:133`(breadcrumb)·`:140`(h2 스팬)의 `id.slice(0, 8)`을 `runShortLabel(r.id)`(끝 6자)로 교체 — breadcrumb은 `runDisplayLabel`(라벨 있으면 라벨). `:129`의 **시나리오** id 축약은 대상 아님(run이 아니다). 상세 헤더 아래에 `profileSummary` 한 줄(§8) + 라벨 행(§6).

## 8. 자동 설정 요약 `profileSummary`

순수 헬퍼(배치: `ui/src/runs/profileSummary.ts` — 소비처가 runs 목록·상세·비교라 `runs/`가 자연스러운 집). **기존 단일 소스 조합만**: `deriveLoadMode`로 모드 판정, VU/RPS 강도는 `deriveLoadMode` 결과별 분기(직접 profile 필드 재분기 금지 — ui/CLAUDE.md `profileVuDisplay` 규칙과 동일 정신), 시간은 `profileDurationSeconds`. 파라미터는 `Pick<Profile, …>` leak-free 패턴(중첩 `.default()` 누출 회피).

출력(ko 템플릿 경유, §11): closed+fixed `고정 {vus} VU · {n}s` / closed+curve `곡선 최대 {peak} VU · {n}s` / open+fixed `개방 {rps}/s · {n}s` / open+curve `개방 곡선 최대 {peak}/s · {n}s`. 용어는 기존 표면(`RunVuCell`의 "최대 N (곡선)", 모드 필터 칩)과 어휘 일치 — 정확 문구는 plan에서 기존 카탈로그와 대조 확정.

표시 위치: 비교 헤더 서브라인(§7) + run 상세 헤더 아래. **run 목록엔 추가하지 않는다**(VU·테스트 시간 열이 이미 있음 — 목록의 갭은 라벨뿐, 사용자 승인된 설계).

## 9. 검색 필터 (US3)

`runFilterSort.ts`(C13)에 텍스트 축 1개:

- `RunFilter.q: string`(기본 `""` — `EMPTY_FILTER` 확장). 술어: `q.trim()` 비면 통과. 아니면 소문자 비교로 `label`(없으면 스킵) **∨ full id** 부분일치. **선행 `#` strip**: 비교 화면에서 복사한 `#a1b2c3`를 그대로 붙여넣는 경로 지원(ULID는 대문자 저장이라 case-insensitive 필수).
- URL: `q` 파라미터 — 빈 값이면 미직렬화(**기본 URL byte-identical** — 기존 계약 유지, C13의 parse/serialize에 1키 추가).
- UI: `RunListControls`에 텍스트 `Input` 1개(즉시 URL 반영 — 기존 날짜 입력과 동일 이디엄). 정렬 축 추가 없음.

## 10. export

비교 XLSX **Runs 시트만**: 헤더 `["run_id", "label", "status", "started_at", "ended_at", "count"]`(label을 2열째로, C15) + 행에 `r.run.label.as_deref().unwrap_or("")`. 기존 라운드트립 테스트의 헤더·열 인덱스 단언 갱신. CSV(단일·비교)·비교 Summary/Steps/Insights 시트·파일명 전부 무변경(Non-goals).

## 11. 카피 (ko 카탈로그, ADR-0035)

신규 키(정확 값은 plan에서 확정 — 아래는 기본안): 목록 라벨 열 헤더(`라벨`) · RunDialog 라벨 입력 라벨/placeholder · 편집 버튼 aria(가시 라벨 포함 — WCAG 2.5.3 조립식: `aria = 가시 텍스트 + 꼬리`) · 검색 입력 라벨/placeholder(`라벨·ID 검색`) · `profileSummary` 템플릿 4종 · 라벨 편집 실패 배너. 규율: ① 신규↔기존 카탈로그 **양방향 부분문자열 포함관계 sweep**(`toHaveTextContent` 부분매칭 함정) ② `ko.*(n)` 보간 단언은 자기참조 공허 — 렌더된 숫자/리터럴 별도 단언 병기 ③ 하드코딩 한국어 sweep은 `'"[^"]*[가-힣]'` 패턴(따옴표-직후-한글 패턴의 문서화된 맹점 회피).

## 12. 테스트 전략

**Rust**: `normalize_label` 표 테스트(None/빈/trim/200경계/201) · migration 멱등(connect 2회) · insert→get 라벨 round-trip · `PUT /label` 통합(200 갱신·404·400·null 제거) · 스케줄러 자동 라벨(`process_due_schedules` 기존 인라인 테스트에 발사 run의 `label == sched.name` 단언 추가 — main-only spawn 한계는 34b 노트대로 루프 본체 테스트로 커버) · `ReportRun.label` 직렬화 2상태(무라벨 absent = 기존 리포트 JSON 키셋 불변 / 유라벨 present) · export Runs 시트 라운드트립.

**UI**: `runDisplayLabel`·`profileSummary`(모드 4종)·필터 `q` 술어(라벨/id/`#`-strip/대소문자/빈) 단위 · `RunSchema`/`ReportRunSchema` 파싱(null·absent 각각) · RunDialog payload **정확 `toEqual`**(라벨 유/무 — 조건부 spread 회귀 가드, `not.toHaveProperty("label")`) · 프리셋 no-clobber 시드 2케이스 · 목록 라벨 열+인라인 편집(draft clear 포함) · 상세 라벨 편집 · CompareMatrix 서브라인 렌더 + **baseline 버튼 accname에 시각·요약 미합류** 단언 · 오버레이 범례 라벨.

**이빨 실증**: 회귀 가드 표방 테스트(accname 비오염·조건부 spread·draft clear)는 고의 회귀→RED→원복→GREEN 실증([[plan-mandated-vacuous-tests]]) — plan task에 명시.

**게이트**: `pnpm lint && pnpm test && pnpm build` + cargo 게이트(파이프 금지, `; echo exit=$?`).

## 13. 라이브 검증 (필수 — run 생성/응답 파싱 경로)

`.nullish()` 클래스는 RTL이 원리적으로 못 잡는다(fixture는 absent를 줌) — `/live-verify` US 척추:

| US | 절차 | 통과 신호 |
|---|---|---|
| US2 | RunDialog에 라벨 입력→run 생성 | 목록 라벨 열·상세 헤더에 라벨 표시, 콘솔 Zod 에러 0 |
| US1 | 라벨 run 2개+무라벨 1개 비교 진입 | 열 헤더 1줄=라벨/`#끝6자`, 2줄=시각·요약. 오버레이 범례 동일 |
| US3 | 목록 검색에 라벨 일부·`#끝6자` 입력 | 해당 행만 잔존, URL `q` 반영, 초기화로 전체 복귀 |
| US4 | 목록 행·상세에서 라벨 편집→새로고침 | 편집값 유지(DB 영속) |
| US5 | once 스케줄 1개 생성→발사 대기 | 발사 run 라벨=스케줄 이름 (스케줄러 루프는 main-only wiring이라 라이브가 유일한 end-to-end) |

무라벨 기존 run(마이그레이션 전 생성)이 목록·상세·비교에서 `#끝6자` 폴백으로 정상 렌더되는 것도 확인(하위호환).

## 14. 클레임 레저 (검증 명령 — 디스패치 전 일괄 재실행)

| # | 주장 | 명령 | 결과 요지 |
|---|---|---|---|
| C1 | runs 스코프에 라벨 류 컬럼 0 | `grep -rniE "label\|memo\|note\|tag" crates/controller/src/store/migrations/*.sql` | 매치 2건 전부 비-runs(0005 주석 NOTE·0019 `pool_worker_overrides.label`) |
| C2 | Rust-guarded ALTER 선례 | `grep -n "ALTER TABLE runs" crates/controller/src/store/mod.rs` | `:165` dropped·`:182` verdict_json |
| C3 | 축약 단일 소스 | `grep -n "" ui/src/compare/runLabel.ts` | `:3-5` `#${id.slice(-6)}`·`:8` 5색 |
| C4 | 상세는 앞 8자 | `grep -n "slice(0" ui/src/pages/RunDetailPage.tsx` | `:133`·`:140` run id 앞8자(`:129`는 시나리오 id) |
| C5 | RunResponse 필드·null 직렬화 선례 | `sed -n '32,52p' crates/controller/src/api/runs.rs` | 11필드·label 없음·`message`/`verdict` plain Option |
| C6 | CreateRunRequest 3필드 | `grep -n "struct CreateRunRequest" -A 5 crates/controller/src/api/runs.rs` | `{scenario_id, profile, env(default)}` |
| C7 | spawn_run 시그니처·호출처 전수 | `grep -rn "spawn_run(" crates/ --include="*.rs" \| grep -v "fn spawn_run"` | 정의 `:651`(6-param)·호출 `api/runs.rs:954`+`runner.rs:186` 2곳뿐 |
| C8 | insert 5-param·호출처 전수 | `grep -n "pub async fn insert" -A 6 crates/controller/src/store/runs.rs` + `grep -rn "runs::insert(" crates/ --include="*.rs"` | 정의 `:271-277` · 프로덕션 호출 `api/runs.rs:679` 1곳 + 테스트 ~14곳 |
| C9 | RunRow 12필드 label 없음 | `grep -n "pub struct RunRow" -A 16 crates/controller/src/store/runs.rs` | `:255-269` |
| C10 | RunSchema label 없음·`.nullish()` 선례 | `sed -n '194,216p' ui/src/api/schemas.ts` | `verdict`/`last_metric_ts` `.nullish()` |
| C11 | ReportRunSchema `.strict()` 8키·profile unknown | `grep -n "ReportRunSchema" -A 14 ui/src/api/schemas.ts` | `:379-390` |
| C12 | ReportRun 구조·리터럴 사이트 전수 | `grep -n "pub struct ReportRun" -A 12 crates/controller/src/report.rs` + `grep -rn "ReportRun {" crates/` | 정의 `:55-64`·리터럴 `report.rs:949`+`export.rs:603` |
| C13 | 필터에 텍스트 축 없음 | `sed -n '1,40p' ui/src/runs/runFilterSort.ts` | RunFilter 6필드 enum/날짜뿐 |
| C14 | 비교 라벨 흐름·overlay 예외·리포트-fetch | `grep -n "runShortLabel\|labels\|useReports" ui/src/pages/ScenarioComparePage.tsx` + `sed -n '15,30p' ui/src/compare/overlaySeries.ts` + `sed -n '130,155p' ui/src/components/compare/CompareMatrix.tsx` | 맵 `:150-154`→`:231`/`:237` 전달·overlay `:23`은 직접 호출·헤더 버튼 `:137-152`·데이터는 `useReports` 훅(`:3` import — run 목록 훅 미사용 = ReportRun.label이 필수 와이어) |
| C15 | Runs 시트 5열 | `sed -n '405,428p' crates/controller/src/export.rs` | label 없음 |
| C16 | 스케줄 이름 실존 | `grep -n "pub struct ScheduleRow" -A 10 crates/controller/src/store/schedules.rs` | `:16` `pub name: String` |
| C17 | RunDialog에 run 라벨 입력 없음 | `grep -n "presetName\|setPresetName" ui/src/components/RunDialog.tsx` | `:227` state·`:330` 프리셋 이름 시드(프리셋 소유) |
| C18 | RunResponse 매핑 1곳 | `grep -n "RunResponse {" crates/controller/src/api/runs.rs` | `:33` 정의·`:1256` `to_response` |
| C19 | 스케줄러 발사에 label 전달 없음 | `sed -n '180,210p' crates/controller/src/schedule/runner.rs` | `:186` 6-arg 호출 |
| C20 | 목록 컬럼 구성 | `sed -n '281,318p' ui/src/pages/ScenarioRunsPage.tsx` | 비교/상태/결과/VU/시간/생성시각/액션 — id 텍스트 열 없음 |
