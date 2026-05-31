# 엔진 (`crates/engine`) 함정

이 파일은 `crates/engine/` 파일을 건드릴 때 자동 로드되는 중첩 CLAUDE.md다. 프로젝트 전역 규칙·git 토폴로지·검증 훅·일하는 모드는 루트 `CLAUDE.md` 참고. 컨트롤러/워커/UI 함정은 각 디렉토리의 CLAUDE.md.

엔진은 부하 생성 라이브러리: 시나리오 모델(`scenario.rs`) + HTTP 실행(`executor.rs`) + 템플릿(`template.rs`) + 인터프리터(`runner.rs`/`execute_steps`) + 집계(`aggregator.rs`) + 퍼센타일(`percentiles.rs`).

## 시나리오 모델 / serde

- **serde_yaml 0.9 + externally-tagged enum w/ map variants** (Slice 1): derive(Serialize, Deserialize)가 round-trip 안 됨. `Assertion::Status(u16)`, `Body::{Json|Form|Raw}` 같은 enum은 손수 `Serialize`/`Deserialize` 구현해서 `{key: value}` 맵 형태로 처리. derive 그대로 두면 직렬화 시 `!variant value` YAML 태그가 나오고, 사용자/UI가 만든 `{variant: value}` 맵을 역직렬화하려 하면 `invalid type: map, expected a YAML tag starting with '!'` 에러. Slice 1 fixture에 body가 없어서 Body 쪽은 Slice 3 UI(BodyEditor)가 처음 트리거할 때까지 잠복. **새 enum 추가할 때마다 이 패턴 확인.** (`crates/engine/src/scenario.rs::{Assertion, Body}` 참고.)
- **serde_yaml 0.9 + internally-tagged enum w/ struct variants은 round-trip OK** (Slice 4): 위 외부 태그(externally-tagged) map-shape enum이 깨지는 버그(`Body`, `Assertion`)와 달리 `#[serde(tag = "from")]` 형태의 internally-tagged + struct 변형은 정상 동작. `Extract`는 이 패턴으로 모델링.
- **serde 내부 태그는 enum 레벨에서 `deny_unknown_fields`를 강제하지 않는다** (Slice 7): `#[serde(tag="type")]` 만으로는 loop 스텝에 `request:`를, http 스텝에 `repeat:`를 적어도 조용히 무시된다(strict authoring gate 아님). 그래서 각 variant 구조체(`HttpStep`/`LoopStep`)에 개별로 `#[serde(deny_unknown_fields)]` 를 달았고, 진짜 strict 검증은 UI Zod 스키마가 담당한다. 엔진 타입은 `do_: Vec<Step>` 로 느슨하고(자유 중첩), 중첩 loop 거부는 Zod가 http만 받는 것으로 강제 — 두 레이어의 strict 책임이 다르다 (UI 쪽은 `ui/CLAUDE.md`).
- **`Condition`(if 노드 조건)도 map-shape 수동 serde** (Slice 9a): `{all: [...]}`/`{any: [...]}`/`{left, op, right?}` 세 모양이라 `Body`/`Assertion`과 같은 부류 — derive 금지, 수동 `Serialize`/`Deserialize`. visitor는 키 존재(`all`/`any`/`left`)로 변형을 구별하고, 키 순서 무관(`{op, right, left}`도 OK)하게 `Option` 누적 후 disambiguate. `left`/`all`/`any` 어느 것도 없으면(예: `{op: eq}`) `de::Error::custom`로 거부. `CompareOp`는 데이터 없는 enum이라 derive + `rename_all="lowercase"`로 round-trip OK. `IfStep`/`ElifBranch`는 `HttpStep`/`LoopStep`처럼 개별 `#[serde(deny_unknown_fields)]`. (구현 `scenario.rs::Condition`.)

## HTTP 실행 / extract / 템플릿팅 (`executor.rs`, `template.rs`)

- **form/JSON body가 이제 템플릿팅된다** (Slice 8a): `executor.rs`는 `Body::Form` 값 전체와 `Body::Json` 문자열 leaf에 `render`를 적용한다(이전엔 url·header·`Body::Raw`만). JSON은 number/bool/null·object 키를 보존하고 문자열 leaf만 치환(`render_json_value`). 따라서 `{{var}}`/`${ENV}`를 **form 값**·**JSON 문자열 leaf**에 써도 동작한다(form 키·JSON object 키는 렌더 안 됨 — authored 식별자로 그대로 전송). 숫자 주입(`{"age": {{age}}}`로 number)은 미지원 — 값은 문자열로만 들어간다. 미바인딩(`{{}}` 토큰 없음)이면 출력 불변 = 하위 호환.
- **`reqwest::Response::cookies()` vs Set-Cookie 헤더 직접 읽기** (Slice 4): 자동 쿠키 jar가 활성화돼도 응답의 raw Set-Cookie 헤더는 그대로 노출된다. 우리는 `from: cookie` extract에서 raw Set-Cookie 헤더를 파싱(첫 `key=value` 페어)한다 — jar에서 끄집어내려고 하면 reqwest 내부 jar 인터페이스가 stable하지 않음.
- **JSONPath 라이브러리 선택** (Slice 4): `serde_json_path` (RFC 9535 compliant). `jsonpath-rust`는 의존성이 더 무겁고 API가 변동적. `JsonPath::parse(path).query(json).first()` 패턴이면 충분.
- **엔진과 UI에 같은 템플릿 문법을 두 번 구현** (Slice 4 M3): 엔진 `template.rs`는 runtime/엄격, UI `template.ts::resolveForDisplay`는 display/관대(미해결 토큰은 그대로). 새 토큰(`${session_id}` 등)이나 새 문법을 엔진에 추가하면 **반드시 UI resolver도 동시에**, 아니면 Run 상세의 진단 표시가 거짓말을 한다.

## 제어 흐름 (loop, `execute_steps`)

- **`async fn` 재귀는 `Box::pin` 필요** (Slice 7): `execute_steps` 가 `Step::Loop` arm 에서 자기 자신을 재귀 호출하므로 `async fn` 의 무한-크기 future 문제를 `Box::pin(execute_steps(...))` 로 푼다. **`Step::Loop` arm 에서만 박싱**하고 flat http 경로는 추가 박스 0개 — hot path 보존. 박싱 오버헤드가 진짜 무시 가능한지 Task 11 처리량 A/B로 검증(flat ~19,974 vs loop(repeat:1) ~19,449 RPS, 변동 범위 내).
- **loop body 의 deadline 은 iteration 사이 AND body step 사이 둘 다 체크된다** (Slice 7): run window 끝에서 마지막 loop 이 mid-body 로 잘릴 수 있어 inner http 스텝의 `count` 가 정확히 `repeat` 의 배수가 아닐 수 있다(부분 iteration). 통합/e2e 테스트는 `count > 0 && error_count == 0` 만 단언하고, 정확한 `count % repeat == 0` 검증은 deadline 영향이 없는 엔진 통합 테스트(`crates/engine/tests/loop_node.rs`, fixed iteration 수)가 담당한다.
- **조건 평가는 lenient·infallible** (Slice 9a): `if`/`elif` 조건은 `template.rs::render_lenient`(strict `render`와 `render_inner(lenient)` 코어 공유)로 평가 — 미해결 `{{var}}`/`${NAME}`/loop 밖 `${loop_index}` → 빈 문자열, unclosed marker → literal, **절대 `Err` 안 냄**. `eval_condition`(`condition.rs`)은 이걸 써서 extract 실패/미바인딩이 run을 죽이는 대신 자연 분기하게 한다. 숫자 op(lt/gt/lte/gte)는 양쪽 f64 파싱(한쪽 실패 → false), `matches`는 `regex::Regex::new` 컴파일 실패 시 lenient false + warn(authoring 검증은 UI 9b). `exists`/`empty`는 미바인딩과 빈 문자열을 동일 취급.
- **`Step::If` arm은 들어온 `ctx`(loop_index)를 분기 자식에 그대로 넘긴다** (Slice 9a): 새 스코프를 만들지 않으므로 if-in-loop에서 분기 안 http가 바깥 loop의 `loop_index`를 본다. arm 안에서 `ctx`(iter_vars 불변 차용)는 **블록으로 스코핑**해 `taken: &[Step]` 계산 직후 drop — 안 그러면 이어지는 재귀에 `iter_vars`를 `&mut`로 못 넘긴다(borrow 에러). deadline/cancel은 `execute_steps` for-루프 머리가 이미 검사하므로 arm 안 추가 검사 불필요(loop arm과 달리 if는 재귀 1회).

## 메트릭 / 집계 / 퍼센타일 (`aggregator.rs`, `percentiles.rs`)

- **엔진 메트릭 채널 payload를 `Vec<StepWindow>`에서 `MetricFlush`로 변경하면 모든 `run_scenario` 호출 사이트가 `flush.windows`로 바꿔야 한다** (Slice 7-1): `run_scenario`의 반환값/채널 타입을 교체하면 엔진을 직접 쓰는 모든 테스트(단위·통합·e2e)가 빌드 에러를 낸다. 새 타입으로 wrapping할 때 **모든 consumer를 한 PR에서 같이** 수정해야 한다 — 중간 상태 "일부만 새 타입" 은 컴파일이 안 됨.
- **`hdrhistogram` add 의 bound 일치** (Slice 5): `Histogram::add(other)` 는 두 히스토그램의 lo/hi/sigfig 가 같을 때 lossless. 다른 컨피그면 일부 샘플이 누락된다. `fresh_hist()` 헬퍼로 모든 누적용 히스토그램이 같은 bound 를 갖게 통일. (리포트 빌드 쪽 BLOB 내성은 `crates/controller/CLAUDE.md`.)
- **overflow는 엔진에서 `u32::MAX` sentinel** (Slice 7-1): loop_index cap 초과는 엔진 `aggregator.rs` 에서 `u32::MAX` 버킷으로 fold. controller가 이를 `null` 로 변환한다 — sentinel 의미를 아는 레이어는 엔진과 controller `build_report` 뿐. (변환 쪽은 `crates/controller/CLAUDE.md`.)
- **분기 결정은 `Step::If` arm 에서 `Aggregator::record_branch(step_id, branch)` 로 기록** (Slice 9d): counts-only, **cap 없음**(브랜치 수 유한, `loop_breakdown_cap` 무관). `MetricFlush.branch_stats` 는 세 번째 드레인 벡터(periodic + final flush 둘 다). 레이블: `"then"` / `"elif_{j}"` / `"else"` / `"none"`. **`"none"` = 조건 false + elif 모두 false + else 비어있거나 absent** — http leaf가 없어 step 메트릭에 붙일 수 없는 전용 결정 카운터.

## 런타임 / 동시성

- **mpsc 플러셔 종료** (Slice 1): 워커 self-cloned `Sender`를 가진 flusher 태스크는 `is_closed()`로 종료 감지가 안 된다 (자기 자신이 살아있으니까). 메인 루프가 끝나면 `flusher.abort()` 후 `flusher.await.ok()`. (`crates/engine/src/runner.rs::run_scenario` 참고.)
- **CancellationToken은 `tokio_util::sync` 모듈에서** (Slice 4): tonic이 transitively 가져오긴 하지만 dev에 명시적으로 의존 추가하는 게 안전 (tonic minor 업데이트로 token 사라질 위험 회피).
- **`u32::div_ceil`은 Rust 1.79+** (Slice 4): workspace MSRV 1.85라 OK. `ceil_div(a, b)` 헬퍼를 손수 작성할 필요 없음.

## 테스트

- **Ramp-up 테스트의 flakiness 한계** (Slice 4): 1초 윈도우 단위에서 "first window count < later window count" 검증은 환경 부하에 민감. 매 초마다 정확히 `floor(target/ramp)` VU spawn을 검사하지 말고 monotonic non-decreasing trend만 검사.
- **plan/fixture 의 placeholder ULID `01HX000000000000000000000L` 은 INVALID** (Slice 7): ULID 는 Crockford base32(`[0-9A-HJKMNP-TV-Z]`)라 `I`/`L`/`O`/`U` 를 제외한다. spec/plan 의 `01HX...` 자리표시자를 그대로 테스트 fixture 에 박으면 ULID 파서가 거부한다. 테스트용 ULID 는 이 네 글자를 피해서 적을 것(`...0010` 등).
