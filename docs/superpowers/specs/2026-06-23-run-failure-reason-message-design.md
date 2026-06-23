# 실패 run 진단 사유(message) — Failed run은 항상 사유를 갖는다 (status-transition 갭 G3 — 후속 정리)

- **날짜**: 2026-06-23
- **상태**: 설계 승인(사용자 2026-06-23) → plan 대기
- **출처**: roadmap §B3 / 사용자 선택("status-transition 갭 버그"). systematic-debugging 결과 헤드라인 "stuck running" 버그는 2026-06-05에 이미 수정됨(followups "열린 항목: 현재 없음")을 확인 → 스코프가 "잔존 진단 갭 G3 + 스테일 문서 정정"으로 재정의됨. **왜 지금**: post-register 크래시/워커-보고 실패가 run을 `failed`로 전이하면서 `message=NULL`이라 운영자가 *왜* 실패했는지 못 본다(특히 워커가 보낸 실제 엔진 에러를 컨트롤러가 버린다).
- **연관**: followups `docs/followups-after-mvp1.md`(구 열린 항목 A 처리 기록), `crates/controller/CLAUDE.md`(dispatch 실패 처리 §, A3a coordinator 상태머신 §), ADR-0010(gRPC bidi·워커 pull), ADR-0027(멀티워커 fan-out), 스토어 `runs.rs::mark_failed_if_active`(2026-06-05 reaper 도입분).
- **ADR**: 신규 불필요 — 기존 동작(이미 존재하는 `runs.message` 컬럼[migration 0002]·proto `RunStatus.message`[field 3]·UI `RunDetailPage` 렌더)을 채우는 additive 정합 수정. 와이어/스키마/마이그레이션 무변경.

---

## 1. 문제와 목표

컨트롤러가 run을 `failed`로 전이하는 세 경로가 **사유 메시지를 남기지 않는다**(`runs::set_status(Failed)`는 message 컬럼을 안 쓴다): ① 워커가 `Phase::Failed`를 *보고*(`record_phase`, `coordinator.rs:933`), ② 워커 스트림 비-terminal 단절(`worker_disconnected`, `:982`), ③ 등록 마감 초과(`fail_incomplete_registration`, `:1022`). 특히 ①은 **워커가 이미 `RunStatus.message`(proto field 3 = 엔진 `e.to_string()`)로 실제 실패 사유를 보내는데** 핸들러(`:1316`)가 `s.message`를 버려 컨트롤러가 그 정보를 잃는다. 결과: UI `RunDetailPage`의 "실패 사유:" 줄이 비어 운영자가 connection refused·assertion 실패 같은 원인을 못 본다.

- **목표**: 모든 `Failed` run이 non-null `message`(실패 사유)를 갖게 한다. 워커가 보낸 실제 엔진 에러는 그대로 표면화하고, 워커 사유가 없는 두 경로(②③)는 합성 진단 문구를 남긴다. + 이 갭을 "열린 status-transition 버그"로 오기재한 스테일 문서(root CLAUDE.md·roadmap §B3·controller CLAUDE.md)를 정정한다.
- **비목표(연기)**: §7 참조. 등록 후 *멈춘*(살아있지만 무진행) 워커의 진행 라이브니스(G1)·k8s register-전 사망 reaper(G2)·메시지 한국어화(i18n 후속)는 이번 범위 밖.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST `record_phase`의 워커-보고 Failed 경로가 워커의 `RunStatus.message`(실제 엔진 에러)를 그 run의 `message`로 영속한다 — `message`가 비면 합성 fallback(`"worker {worker_id} reported failure"`). | 단위 `record_phase_failed_persists_worker_message`(비-빈 메시지 영속) + `record_phase_failed_empty_message_falls_back`(빈→fallback) | |
| R2 | MUST `worker_disconnected`의 비-terminal 크래시 경로가 합성 메시지 `"worker {worker_id} disconnected before completing the run"`를 영속한다. | 단위 `worker_disconnected_records_failure_message` | |
| R3 | MUST `fail_incomplete_registration`이 합성 메시지 `"only {registered}/{expected} workers registered before the registration deadline"`를 영속한다(카운트는 runs 락 안에서 캡처). | 단위 `incomplete_registration_records_failure_message` | |
| R4 | MUST 세 Failed 전이가 전부 `runs::mark_failed_if_active`(가드 `WHERE status IN ('pending','running')`)를 쓴다 — 이미 terminal인 run(completed/aborted, 또는 racing 경로가 먼저 finalize)을 절대 클로버하지 않는다(기존 `set_status … WHERE status != 'aborted'`보다 엄격 = 회귀 없음, completed→failed 클로버까지 차단). | 단위 `mark_failed_if_active_is_noop_on_terminal_runs`(기존) green + 각 경로 terminal-가드 단언 | |
| R5 | SHOULD `message`로 영속하기 전 char-safe 길이 절단(≤1000 chars)을 적용한다 — 자유형 엔진 에러의 DB/UI 위생(멀티바이트 경계 분할 금지). 절단은 *자유형 엔진 에러를 삼키는 이 세 경로에만* 적용 — 기존 reaper/dispatch 합성 메시지는 짧고 bounded라 무절단 유지(= 의도된 비대칭, 그 경로 byte-identical). | 단위 `truncate_message_is_char_safe`(멀티-KB·멀티바이트 입력) | |
| R6 | MUST Completed/Aborted/Running `set_status` 호출과 비-Failed 동작은 byte-identical — **proto·worker·engine·migration 무변경**(proto `RunStatus.message` field 3·`runs.message` 컬럼·워커 populate 전부 기존). | proto/`.sql`/engine/worker diff 0 · nextest green · 머지 diff = controller(+docs)만 | |
| R7 | MUST 새 migration 불요·UI 변경 불요 — `runs.message`(migration 0002)와 UI `RunSchema.message`/`RunDetailPage`("실패 사유:")가 이미 컬럼을 렌더/수용한다. | `ui/` diff 비어있음 · `grep -c MIGRATION_SQL` 불변 | |
| R8 | SHOULD 스테일 문서 정정: root CLAUDE.md(status-transition 갭 footgun → 수정됨·잔존=*hung* 워커 G1)·roadmap §B3 본문(stale 라인은 ~:244 한 곳 — `:44`는 *이미* "열린 항목 없음"이라 둘이 모순; `:44`·구-followups 맥락은 건드리지 않음)에서 "열린 항목 A" 제거·followups와 정합·G1/G2 후속 명시·controller CLAUDE.md(message=NULL 노트 갱신 + "`mark_failed`는 message 남기는 *유일* 헬퍼" 절도 정정[**이미 거짓** — 2026-06-05 reaper가 `mark_failed_if_active`로 message를 남겨옴; 이 슬라이스는 세 번째 message-기록 사이트를 추가할 뿐] + record_phase `s.message` 관통 트랩). | grep — "열린 항목 A"/"영영 running"이 *열린 버그*로 더는 안 가리킴 · controller CLAUDE.md에 "유일한 헬퍼" 잔존 0 | |
| R9 | MUST `record_phase` 시그니처에 `message` 파라미터를 추가하고 전 14 호출부를 갱신한다(프로덕션 핸들러는 `&s.message` 전달·13 인라인 테스트는 적절 리터럴) — 워크스페이스 컴파일 + clippy 0. | `cargo build --workspace --tests` 0 에러 · `cargo clippy --workspace --all-targets -- -D warnings` 0 | |

- **seam 없음**: proto field 3·`runs.message` 컬럼·UI Zod·migration이 *전부 기존*이라 새 계약 경계가 없다(R6/R7이 이를 명문화). `record_phase` 시그니처(R9)는 **crate-내부 호출 경계**일 뿐 외부 와이어가 아니다.

---

## 3. 핵심 통찰 (설계 근거)

1. **워커 사유는 이미 와이어 위에 있다 — 컨트롤러가 버릴 뿐.** 워커는 종단 RunStatus의 `message`(proto field 3)에 실제 사유를 두 송신 사이트에서 채운다: `phase_for_result`(`worker/src/lib.rs:645`, `Err(e) => (Phase::Failed, e.to_string())`)와 데이터셋-로드 실패 경로(`:198`, `message: e.to_string()`). 둘 다 같은 핸들러(`coordinator.rs:1316`)로 수렴하는데 핸들러는 `record_phase(&s.run_id, wid, s.phase)`로 `s.message`를 무시한다. 그래서 R1은 **proto/워커 0 변경**으로 달성된다 — `record_phase`에 `message` 파라미터(R9)를 더해 그 줄에서 `&s.message`만 전달하면 두 송신 사이트 모두 커버된다. 이게 이 슬라이스에서 가장 가치 큰 변경(가짜 합성 문구가 아니라 *실제* 원인).
2. **세 경로 모두 `mark_failed_if_active`가 맞다(R4).** 2026-06-05 reaper가 같은 헬퍼(가드 `WHERE status IN ('pending','running')`·`message` 기록·동시 finalize와 race-safe)를 이미 확립했다. 기존 `set_status(Failed, …)`의 `WHERE status != 'aborted'`보다 *엄격*이라 회귀가 아니라 **개선**이다(completed run을 failed로 뒤집는 잠복 클로버까지 차단 — 현재는 terminal-phase 가드가 그 도달을 막지만 DB 레벨 방어가 추가됨). `set_status`(Completed/Aborted/Running)는 그대로 둔다 — 그 전이엔 실패 사유가 없다(R6).
3. **워커 사유 노출은 인가된 운영자 대상이지만 새 영속 표면이다(보안).** transport 에러 문자열은 해석된 요청 URL(따라서 `${ENV}`/`{{var}}` 주입 시크릿: 예 쿼리의 토큰)을 포함할 수 있다. 현재는 워커 로그(휘발)에만 있고, 이번에 DB+UI로 영속된다. 운영자는 시나리오/env 소유자라 노출 자체는 인가됐다 — v1은 redaction 없이 surface하되, **char-safe 길이 절단(R5)** 으로 DB/UI 위생만 둔다(절단이 시크릿을 가리진 못함 — 보안 판단은 security-reviewer 게이트에 위임, §6). redaction은 비목표(§7).
4. **헤드라인 "stuck running" 버그는 이미 죽었다 — 문서만 살아 있다.** followups는 "열린 항목: 현재 없음"인데 root CLAUDE.md·roadmap §B3는 아직 "열린 항목 A"를 가리킨다. R8이 이 드리프트를 닫고, 유일한 *실제* 잔존 stuck-running 시나리오(등록 후 hung 워커 = G1)를 후속으로 명시 분리한다.

---

## 4. 변경 상세

> 파일·함수 단위. 각 묶음에 **충족 R** 태그.

### 4.1 `crates/controller/src/grpc/coordinator.rs::record_phase` — 충족 R: R1, R4, R9
- 시그니처에 `message: &str` 추가: `pub async fn record_phase(&self, run_id: &str, worker_id: &str, phase: i32, message: &str)`.
- `Finalize::Failed(siblings)` 매치 arm(`:932`): 기존 `set_status(Failed, None, Some(now))`를 제거하고, `let reason = failure_message(worker_id, message);`(빈→fallback, char-safe 절단 — R5) 후 `runs::mark_failed_if_active(&self.db, run_id, &reason).await`. 반환 bool은 `let _ =` 또는 `Ok(false)` 시 `debug!`(이미 terminal — 무해).
- 프로덕션 호출부(`:1316`): `state.record_phase(&s.run_id, wid, s.phase, &s.message).await`.
- 13개 인라인 테스트 호출부: `message` 인자 추가(Completed/Aborted는 `""`, Failed 테스트는 의도된 사유 문자열).

### 4.2 `coordinator.rs::worker_disconnected` — 충족 R: R2, R4
- `if let Some(siblings)` 블록(`:982`): `set_status(Failed, None, Some(now))` → `let reason = truncate_message(&format!("worker {worker_id} disconnected before completing the run"));`(R5 헬퍼 공유) + `runs::mark_failed_if_active(&self.db, run_id, &reason).await`. fan_out_abort/cleanup 무변경.
- 풀 busy 워커 evict(L6/L7)도 `pool_disconnect`(`:509`,`:572`)→`worker_disconnected` 경유라 같은 합성 메시지를 받는다(무해 개선, 풀 경로 별도 처리 불요).

### 4.3 `coordinator.rs::fail_incomplete_registration` — 충족 R: R3, R4
- 락 블록에서 `(registered, expected)`를 캡처(현재는 `rw.workers.len()`/`rw.expected`를 락 안에서만 보유) → `Some((siblings, registered, expected))` 형태로 반환.
- `if let Some(...)` 블록(`:1022`): `set_status(Failed)` → `let reason = truncate_message(&format!("only {registered}/{expected} workers registered before the registration deadline"));` + `mark_failed_if_active`.

### 4.4 `coordinator.rs` 헬퍼 — 충족 R: R1, R5
- `fn truncate_message(s: &str) -> String`: char-boundary 안전 절단(≤`MESSAGE_MAX_CHARS=1000`, `s.char_indices().nth(MAX)`로 경계 산출, **초과 시에만** `…` 절단 마커 부착·미초과면 그대로). 순수 함수 — 단위 테스트가 ≤MAX(무마커)·>MAX(마커)·멀티바이트 경계 셋 다 단언.
- `fn failure_message(worker_id: &str, raw: &str) -> String`: `raw` trim이 비면 `format!("worker {worker_id} reported failure")`, 아니면 `truncate_message(raw)`(R1 fallback + R5).

### 4.5 문서 — 충족 R: R8
- `CLAUDE.md`(root): "로컬 dev 실행 함정"의 status-transition 갭 줄 + followups 포인터를 "2026-06-05 수정됨; 잔존 = *hung*(살아있지만 무진행) 워커 G1, 별도 후속"으로 정정. "run이 영영 running + 0 req"는 이제 hung 워커에 한정.
- `docs/roadmap.md` §B3: "현재 열린 항목 A = … status-transition 갭" 제거(followups + roadmap `:44`가 이미 "열린 항목 없음"으로 권위 — §B3를 그것과 정합시킴), 잔존 G1/G2를 후속 후보로 한 줄.
- `crates/controller/CLAUDE.md` "dispatch 실패 처리" § 두 줄 정정: ① "set_status엔 message 컬럼이 없어 watchdog/fail-fast 경로는 message가 NULL" → "이제 세 Failed 경로가 `mark_failed_if_active`로 사유 message를 남긴다(`record_phase`는 워커 `s.message` 관통)", ② "`mark_failed`는 단일 run에 `message`를 남기는 **유일한** 헬퍼" 절도 정정(**이미 거짓** — 2026-06-05 reaper가 `mark_failed_if_active`로 message를 남겨옴; 이 슬라이스는 세 번째 message-기록 사이트를 추가할 뿐).

---

## 5. 무변경 / 불변식 (명시)

- **proto 무변경** — `RunStatus.message`(field 3)는 이미 존재·워커가 이미 populate. 새 필드/메시지 0.
- **워커·엔진 무변경** — `phase_for_result`/`RunStatus` 송신 그대로. 머지 diff에 `crates/worker*`·`crates/engine` 없음.
- **migration 무변경** — `runs.message`(migration 0002) 재사용. 새 `.sql`/`MIGRATION_SQL_*` 0.
- **UI 무변경** — `RunSchema.message`(`schemas.ts`, `.nullable().optional()`)·`RunDetailPage`("실패 사유:") 그대로. `ui/` diff 비어있음.
- **set_status 무변경** — Completed(`:895`)/Aborted(`:922`)/Running(`:333`,`:1285`) 전이는 그대로(실패 사유 없음). `runs::set_status`/`mark_failed`/`mark_aborted` 함수 본문 무변경.
- **byte-identical**: 성공/abort run, dispatch-실패 경로(이미 `mark_failed`로 message 보유), reaper 경로(이미 message)는 동작 변화 없음. 유일 동작 변화 = 세 Failed 경로의 `message` NULL→사유.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | 단위 `record_phase_failed_persists_worker_message` + `record_phase_failed_empty_message_falls_back`(coordinator 인라인, in-memory DB) | ✅ |
| R2 | 단위 `worker_disconnected_records_failure_message` | |
| R3 | 단위 `incomplete_registration_records_failure_message` | |
| R4 | 기존 `mark_failed_if_active_is_noop_on_terminal_runs` green + 각 경로 terminal-run 비클로버 단언 | |
| R5 | 단위 `truncate_message_is_char_safe`(멀티-KB ASCII + 멀티바이트 한글/이모지 경계) | |
| R6 | proto/`.sql`/engine/worker git diff 0 · `cargo nextest run --workspace` green | |
| R7 | `git diff --name-only`에 `ui/` 없음 · `grep -c MIGRATION_SQL crates/controller/src/store/mod.rs` 불변 | |
| R8 | `grep -rn "열린 항목 A\|영영 running\|유일한 헬퍼" CLAUDE.md docs/roadmap.md crates/controller/CLAUDE.md` — stale 라인(root `:104`·roadmap §B3 `:244`·controller `:120`)이 *열린 버그*로 안 가리킴; *해소* 맥락(followups·roadmap `:44`/`:20`·controller `:119`)은 보존 | |
| R9 | `cargo build --workspace --tests` 0 · `cargo clippy --workspace --all-targets -- -D warnings` 0 | |

- **라이브 검증 필수**(run 상태 전이 경로 — S-D 갭): `/live-verify` 스택으로 실 controller+worker 기동 후 ① **워커-보고 실패**(예: `assert status:200`인데 SUT가 500 응답·또는 connection-refused URL) → run `failed` + `GET /api/runs/{id}`의 `message`에 엔진 사유(R1) ② **비-terminal 단절**(run 중 워커 `kill`) → run `failed` + 합성 메시지(R2). 실 `/report`/run 객체가 `RunSchema.parse` 통과(S-D 갭 차단).
- **보안 게이트(path-gated)**: diff가 요청실행 에러 표면화(`record_phase` `s.message` 영속)를 건드리므로 `finish-slice §0` security-reviewer 게이트 적용 — §3.3의 URL/시크릿 노출 표면을 판정(redaction 비목표 확인).

---

## 7. 의도적 연기 (roadmap §B3에 누적)

- **G1 — 등록 후 hung 워커 진행 라이브니스**: 살아있지만 무진행(무한 루프·교착) 워커는 reaper(`child.wait()` 미반환)도 `worker_disconnected`(스트림 유지)도 못 잡아 run이 영영 `running`. **유일하게 남은 실제 stuck-running 시나리오** — per-run 진행 하트비트/watchdog가 필요한 별도 슬라이스(brainstorm→ADR 선행, L6 풀 하트비트와 다른 *실행 경로*).
- **G2 — k8s register-전 사망 reaper**: subprocess는 `child.wait()` reaper가 즉시 잡지만, k8s 모드는 reaper가 없어 register-전 크래시가 60s 등록 watchdog까지 대기(이후 R3 메시지로 닫힘). k8s dispatcher 측 빠른 감지는 별도.
- **메시지 한국어화(i18n)**: 사용자 결정(영어 먼저). 후속 i18n 슬라이스에서 reaper/dispatch-failure 기존 영어 메시지와 함께 일괄 ko 카탈로그로.
- **엔진 에러 redaction/sanitize**: §3.3 — 시크릿-함유 URL을 가리는 정제는 v1 비목표(운영자=인가 소유자). 필요 시 보안 트랙(§A10)에서.

---

## 8. 구현 순서 (plan 입력)

> 워크스페이스 게이트상 미사용 헬퍼만/RED 테스트만 단독 커밋 불가 → **헬퍼+호출+테스트를 한 green 커밋**으로 fold.

1. **Task 1 (코드+테스트, 단일 green 커밋)** — R1·R2·R3·R4·R5·R6·R7·R9: `coordinator.rs`에 `truncate_message`/`failure_message` 헬퍼 추가 → `record_phase` 시그니처+Failed arm → `worker_disconnected`/`fail_incomplete_registration` 두 경로 → 14 호출부(프로덕션 `&s.message`·13 테스트) → 인라인 단위 5종. 같은 커밋에서 컴파일·clippy·nextest green(헬퍼 dead_code/RED 단독 회피).
2. **Task 2 (문서, docs-only 커밋 또는 finish-docs fold)** — R8: root CLAUDE.md·roadmap §B3·controller CLAUDE.md 정정. cargo-비영향 fast-path.
3. **라이브 검증** — §6(필수). **최종 리뷰** — `handicap-reviewer`(R4 가드 불변식·R6 무변경·14 호출부) + `security-reviewer`(§3.3 path-gate).
