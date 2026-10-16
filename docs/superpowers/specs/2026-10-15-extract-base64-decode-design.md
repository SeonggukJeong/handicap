# extract-base64-decode — 추출 단계 base64/JWT 디코딩 + claim 추출

- **날짜**: 2026-10-15 · **유형**: user-path · **슬라이스 브랜치**: `worktree-extract-base64-decode`
- **상태**: ✅ 구현·머지 완료(2026-10-16, 코드 `46e72d44`..`74e3f382`) — spec 4R·plan 2R APPROVE → SDD 4 task + 최종 fix wave 1 → handicap-reviewer·security-reviewer APPROVE → 라이브 US1~3+R10 PROVEN. 연기 → `docs/roadmap.md` §B30.
- **plan 메모(리뷰 비차단 제안)**: `Base64TextError`·`JwtShapeError`는 데이터 없는 변형으로 유지 — 하위 라이브러리 에러 문구가 메시지에 섞일 경로 자체를 없앤다(R6).
- **출처**: 사용자 요청 2026-10-15 — "BASE64 URL Safe 형식으로 인코딩하거나 디코딩해야 하는 경우"(동기 = JWT). 슬라이스 **1/2**. 2 = 요청 측 인코딩(`{{var:b64}}`·`{{var:b64url}}`, 합성 문자열 인코딩[Basic 인증 `id:pw`] 설계 미결 — §7).
- **연관**: Slice 4(extract 모델·`ExtractFailed`) · 응답기반 extract 작성(`ExtractConfirmRow`·`+추출`) · C-1/C-2(test-run trace가 같은 `evaluate`를 공유) · parallel-var-scope(`safe_cause` allowlist가 `ExtractFailed`를 persisted 표면에서 차단)
- **ADR**: 신규 불필요 — ADR-0013(시나리오 YAML 소유)·Slice 4 extract 모델 범위 내 additive 와이어 확장(`Request.disabled`·B4와 같은 부류). 대안(B안 `from: var`) 기각은 §3.1에 기록.
- **diff 스코프**: 엔진(`scenario.rs` 모델·`extract.rs` 처리·의존성 `base64`) + UI(Zod 모델·추출 편집기·게이트 한국어 매핑). **컨트롤러·proto·워커·migration 코드 0-diff** — 컨트롤러는 시나리오를 엔진 `Scenario`로 파싱(validity·insights)하고 test-run trace를 in-process로 돌리지만 `Extract` 변형을 직접 만들거나 나열하지 않으며, 워커는 엔진을 그대로 쓴다(§9 C1·C2). 두 바이너리 모두 엔진 재컴파일로 기능을 자동으로 얻는다.

## 사용자 스토리 (US)

- **US1**: QA가 로그인 응답 본문의 JWT(`access_token`) 안에 든 사용자 ID를 다음 요청에 써야 할 때, 추출 편집기에서 디코딩 `JWT`와 claim 경로(`$.sub`)를 지정한다 — 성공하면 미리 실행 결과의 추출 칩에 `user_id=<claim 값>`이 보이고, 실제 부하 run에서 다음 요청의 URL/헤더에 그 값이 실려 나가는 것을 echo 서버 와이어로 확인한다. `Authorization: Bearer eyJ…` 형태로 헤더에서 꺼낸 JWT도 같은 결과를 낸다.
- **US2**: QA가 헤더·쿠키로 오는 base64 값을 쓸 때 형식(표준/URL-safe)이나 패딩을 고르지 않고 디코딩 `base64`만 지정한다 — 성공하면 표준±패딩·URL-safe±패딩 네 변형이 모두 같은 원문으로 디코딩돼 추출 칩에 보인다.
- **US3**: QA가 대상 값이 JWT/base64가 아니거나 claim이 없을 때 미리 실행을 돌린다 — 성공하면 그 스텝의 에러에서 **어느 변수의 추출이 왜 실패했는지**(디코딩 실패 / JWT 아님 / claim 없음)를 구분해 보고, 그 문구에 토큰 원문이나 디코딩된 값은 나오지 않는다.

---

## 1. 문제와 목표

로그인 API가 돌려주는 JWT 안의 값(사용자 ID·테넌트 등)을 다음 요청에 써야 하는 시나리오가 흔한데, 지금 추출은 응답 본문 JSONPath·헤더·쿠키·상태 코드 네 가지를 **문자열 그대로**만 꺼낸다. 엔진 어디에도 base64 처리가 없어(§9 C3) JWT payload 안의 claim이나 base64로 감싼 헤더 값을 변수로 만들 방법이 없다.

- **목표**: 기존 네 추출 중 값이 문자열인 세 종류(body/header/cookie)에 선택 후처리 `decode`(`base64` | `jwt`)와 `claim`(디코딩된 JSON 안의 JSONPath)을 붙인다. 형식·패딩은 자동 판별하고, 실패는 기존 추출 실패와 같은 경로로 값 없이 보고한다.
- **비목표**: §7 — 서명 검증·바이너리·`from: var`·요청 인코딩(슬라이스 2).

---

## 2. 요구사항 (정규 — R-id)

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance | seam? |
|---|---|---|---|
| R1 | MUST `Extract`의 `body`/`header`/`cookie` 변형에 선택 필드 `decode: base64 \| jwt`와 `claim: <JSONPath>`를 추가하고, 둘 다 없으면 직렬화 YAML이 기존과 byte-identical이다(`status` 변형은 필드를 받지 않는다). | 엔진 serde 왕복 테스트(필드 없음 → 키 부재 / 필드 있음 → 왕복 동일) + proptests `arb_extract` 확장 + 엄격성 핀: `from: status`+`decode` → 파싱 거부 · `decode: base64url` → 파싱 거부 | ✅ wire: engine serde ↔ UI Zod |
| R2 | MUST UI `ExtractModel`이 R1과 1:1로 `decode`/`claim`을 수용하고(`status`는 `.strict()`로 거부), `claim`이 있는데 `decode`가 없으면 검증 실패로 거부한다. | `model.test.ts`: body/header/cookie + `decode`/`claim` 수용 · `status`+`decode` 거부 · `claim`만 → 거부(issue path `["claim"]`) · `decode: base64url` → 거부 | ✅ wire: UI Zod ↔ engine serde |
| R3 | MUST `decode: base64`는 앞뒤 공백 제거·후행 `=` 제거 후 알파벳을 자동 판별(`-`/`_` 포함 → URL-safe, `+`/`/` 포함 → 표준, 둘 다 없으면 표준)해 디코딩하고, 결과가 UTF-8 텍스트일 때만 성공한다. | `extract.rs` 단위: 같은 원문(예: `"hello?>~"` — 표준/URL-safe 알파벳 차이가 드러나는 바이트 포함)에서 만든 표준±패딩·URL-safe±패딩 4변형 → 같은 원문 / 알파벳 혼합(`"ab+c-d__"`) · 무효 문자(`"!!!!"`) → `not base64` / `0xFF` 바이트의 base64(`/w==`) → `not UTF-8 text` / 경계 핀: 과잉 패딩(`QQ=====`) → 성공 · 비정규 후행 비트(`AAAAQR`) → `not base64` | |
| R4 | MUST `decode: jwt`는 대소문자 무관 `Bearer ` 접두어(뒤따르는 공백 포함)를 제거하고, `.`으로 나눈 조각이 정확히 3개일 때 두 번째 조각을 R3 규칙으로 디코딩하며, 그 결과가 JSON이어야 성공한다. | 단위: 실 JWT(`header.payload.sig`) 접두 有/無 · `bearer ` · `BEARER  `(공백 2) → 같은 결과 / `aaaa.bbbb` · `aaaa.bbbb.cccc.dddd` → `not a JWT …` / payload가 `"plain text"`의 base64 → `decoded value is not JSON` | |
| R5 | MUST `claim`이 있으면 디코딩 결과를 JSON으로 파싱해 JSONPath 첫 매치를 기존 `body` 추출과 같은 문자열화(`stringify`)로 변수에 넣고, `claim`이 없으면 디코딩된 텍스트를 그대로 넣는다(`jwt`는 payload JSON 텍스트 원문). | 단위: claim `$.sub`(문자열) · `$.n`(42 → `"42"`) · `$.o`(객체 → JSON 텍스트) · claim 없는 jwt → payload 원문 · `from: cookie`(Set-Cookie 값이 base64) + `decode: base64` → 원문(US2 쿠키 경로) · claim `$[`(무효 경로) → `invalid claim path` · `decode: base64` + 디코딩 결과 비-JSON + claim → `decoded value is not JSON` | |
| R6 | MUST 디코딩·claim 단계의 모든 실패는 `EngineError::ExtractFailed`로 보고하고, 메시지는 `"{var}: <고정 사유>"` 형태(사유 = `not base64` / `not UTF-8 text` / `not a JWT (expected 3 segments)` / `decoded value is not JSON` / `invalid claim path: {claim}` / `claim not found: {claim}` / `claim requires decode`)로 **값·값의 일부·하위 라이브러리 에러 Display를 포함하지 않는다**. | 단위(`extract::evaluate`가 돌려주는 `Err(ExtractFailed(msg))`의 **내부 `msg` 층**): 사유 7종 각각 `msg`를 **정확 문자열**로 단언 · 실패 입력은 전부 길이 ≥4 · `msg`에서 작성자 텍스트(앞의 `{var}: ` 접두와, 사유에 echo된 claim 경로)를 **제거한 나머지**에 입력 원문과 (디코딩 성공 후 실패하는 케이스의) **디코딩된 텍스트** 양쪽의 길이 ≥4 부분문자열이 없음(제거 없이 비교하면 `user_id`처럼 변수명·claim과 payload 키가 겹칠 때 누출 없이도 실패한다) · 이빨 실증: 문구에 하위 에러 `{e}`를 섞는 고의 회귀 → RED | |
| R7 | MUST `decode`가 없는 추출의 동작·에러 문구는 변경 전과 동일하다. | 기존 `extract::tests`의 **단언·기대값 무변경** green(struct 리터럴에 `decode: None, claim: None`을 더하는 기계적 수정만 허용 — diff에 `assert` 줄 변화 0) | |
| R8 | MUST 부하 실행(`execute_step`)과 미리 실행(`execute_step_traced`)이 같은 `evaluate`를 통해 디코딩을 적용해, 같은 응답에 대해 같은 변수 값을 낸다. | 엔진 통합: 같은 wiremock 응답으로 부하 1회·trace 1회 → `extracted` 동일 | |
| R9 | MUST 추출 편집기 각 행(body/header/cookie)에 `디코딩` 선택(없음/base64/JWT)이 있고, 디코딩을 고르면 `claim 경로` 입력이 나타나며, `없음`으로 되돌리거나 `status`로 바꾸면 `decode`/`claim`이 YAML에서 제거된다. 커밋 타이밍은 기존 행과 같다(선택=즉시, 텍스트=onBlur). | RTL `Inspector`: 디코딩 선택→YAML에 `decode: jwt` / claim 입력 blur→`claim: $.sub` / 없음→두 키 부재 / status 전환→두 키 부재 / 깨진 YAML(`setPendingYamlText`+`commitPendingYaml`)에서 두 새 컨트롤 `toBeDisabled()` | |
| R10 | MUST 편집기가 쓴 `decode`/`claim`이 저장·재로드 후에도 모델에 남는다(write-only 금지). | `yamlDoc`/store 왕복 테스트: setStepExtract → 재파싱 모델에 두 필드 존재 | |
| R11 | MUST 빈 `claim` 입력은 키를 쓰지 않고(빈 문자열 `claim: ""` 금지), `decode` 미선택 행은 `decode` 키를 쓰지 않는다(기존 YAML byte-identical). | RTL/yamlDoc: 미설정 행 YAML에 두 키 문자열 부재 | |
| R12 | MUST R2의 `claim requires decode` 검증 실패가 에디터 검증 배너에 한국어로 표시된다(`ko.editor.gate*` 경유). | `problems.test.ts` 매핑 + 실-Zod 드리프트 가드(실 fixture를 `parseScenarioDoc` 통과) | |

---

## 3. 핵심 통찰 (설계 근거)

### 3.1 대안 기각 — `from: var`(B안)
이미 있는 변수에서 꺼내는 새 추출 종류는 데이터셋 값 디코딩까지 덮어 더 일반적이지만, `evaluate`가 반복별 `iter_vars`를 받아야 해 부하/trace 호출 시그니처가 바뀌고, 같은 스텝 안 추출 순서 의존·UI 변수 스코프 판정(`scanVars`)의 새 생산-소비 관계가 생긴다. JWT 용도는 A안(기존 추출의 후처리)으로 완결되고, B안이 필요해지면 `decode`/`claim` 필드를 그대로 재사용할 수 있다(사용자 결정 2026-10-15). 단점(원본 토큰과 claim을 둘 다 쓰면 같은 경로를 두 행으로 적음)은 수용.

### 3.2 디코더는 하나, 판별은 알파벳으로 (R3)
표준과 URL-safe는 62·63번째 문자만 다르다(`+/` vs `-_`). 한 값에 두 쌍이 섞일 수 없으므로 문자 존재로 판별이 결정적이고, 둘 다 없으면 두 알파벳에서 같은 바이트로 디코딩되므로 표준을 고른다. 패딩은 후행 `=`를 먼저 지우고 no-pad 엔진으로 디코딩해 "있든 없든" 같게 만든다(R3). 사용자에게 형식·패딩 옵션을 노출하지 않는 근거 — 디코딩 쪽은 고를 이유가 없다(인코딩 관례 고정은 슬라이스 2의 몫).

### 3.3 에러 문구는 고정 사유 + 변수명 (R6)
`base64::DecodeError`의 Display는 `Invalid symbol 45, offset 3.`처럼 **입력 바이트**를 담고, 미래 버전이 더 많은 내용을 담을 수도 있다 → 하위 에러 Display를 문구에 섞지 않는다. 변수명·claim 경로는 시나리오 작성자가 쓴 authoring 텍스트라 노출해도 된다. 기존 추출 실패 문구(`no match: {path}` 등)에는 변수명이 없어 US3의 "어느 추출이"를 못 보이므로, **새 디코딩 문구에만** `{var}: ` 접두를 붙이고 기존 문구는 R7로 보존한다.

이 문구가 닿는 표면: 부하 경로는 `ExecOutcome.error`를 **에러 여부(bool)로만** 집계하고(§9 C5), run `message`로 가는 경로는 `safe_cause`가 `ExtractFailed`를 이미 차단한다(§9 C6). 미리 실행 trace는 문구를 화면에 그대로 보여주는 유일한 표면 — 그래서 값-free가 필요하다. (trace는 응답 본문을 원래 보여주므로 값 노출 자체가 신규 위험은 아니지만, 디코딩된 claim이 에러 문구로 **다른 맥락에** 새는 것을 원천 차단한다.)

### 3.4 `claim requires decode`는 런타임 거부 + UI 작성 게이트 (R2·R6)
엔진 `Extract`는 enum 레벨 `deny_unknown_fields`가 struct 변형에 **실제로 강제**되어(§9 C4 — 2026-10-15 probe로 재현: `unknown field \`decode\`, expected \`var\` or \`path\``) 모르는 키·잘못된 `decode` 값·`status`+`decode`는 파싱 단계에서 거부된다. 컨트롤러는 저장(`POST/PUT /api/scenarios`) 시 엔진으로 파싱하므로 이들은 저장 시점 **400**(`ApiError::Scenario` → `BAD_REQUEST`)이 된다(§9 C12·C16). 남는 것은 **교차 필드 규칙** `claim ⇒ decode`뿐인데, derive로는 표현할 수 없고 `from_yaml`은 serde만 돈다(§9 C7). 그래서 UI Zod가 작성 시점에 거부하고, 엔진은 API로 직접 들어온 YAML에서도 조용히 원문을 넣지 않도록 **평가 시점에 `claim requires decode`로 실패**시킨다.

**고려 후 기각**: 컨트롤러 저장 경로의 기존 post-parse 검증(`validate_parallel_branch_names`·`validate_scenario_think_times`, `scenarios.rs`)에 `claim ⇒ decode` 검사를 추가해 저장 시 400으로 막는 안. 더 이른 실패지만 컨트롤러 diff가 생기고, UI 경로는 Zod가 이미 막으므로 이득은 API 직접 호출자뿐이다 — 런타임 `ExtractFailed`(미리 실행에서 즉시 보임)로 충분하다고 판단.

### 3.5 버전 혼재 위험 (수용·문서화)
§3.4의 엄격성 덕분에 **구버전 워커**는 `decode`가 붙은 시나리오를 조용히 잘못 실행하지 않고 **시끄럽게 실패**한다 — `crates/worker/src/lib.rs`의 `Scenario::from_yaml(...).context("parse scenario YAML")`가 상태 보고 전에 에러를 낸다(§9 C2). 단 **원인(`unknown field \`decode\``)은 워커 로그에만 남고 run 메시지에는 없다**: subprocess·K8s 워커는 종료해 run이 프로세스 reaper("worker process exited before completing…") 또는 disconnected("worker … disconnected before completing the run") 일반 문구로 `failed`가 되고, LAN pool 워커는 종료하지 않고 `back to idle`로 재연결해 run이 일반 disconnected 문구로 `failed`가 된다(§9 C17) — 그 구버전 pool 워커는 이후 `decode`를 쓰는 run마다 같은 식으로 실패한다. 로컬 subprocess·데스크톱 임베드·Helm 배포는 컨트롤러와 워커를 같은 버전으로 묶어 배포하지만, **LAN pool 워커**(ADR-0041)는 별도 배포이고 `Register`에 버전 필드가 없어(§9 C13) 혼재가 현실적이다. 실패가 시끄러우므로 수용하되, 운영자는 run 메시지가 아니라 **워커 로그**(pool이면 원격 PC)에서 원인을 찾아야 한다. 로컬 dev의 기존 함정("엔진/시나리오 모델 변경 후 `cargo build -p handicap-worker` 필수")이 정확히 이 경우라 새 함정 문구는 추가하지 않는다(라이브 검증에서 워커 재빌드 필수).

### 3.6 `status`에는 붙이지 않는다 (R1·R2)
상태 코드는 세 자리 숫자라 디코딩 의미가 없다. 엔진 `Status` 변형에 필드를 추가하지 않고, UI는 `.strict()`로 거부하며 편집기는 상태 행에서 디코딩 선택을 숨긴다. (설계 대화에서 "문법상 허용·UI만 숨김"으로 말했던 것을 정밀화 — 엔진은 §3.4대로 `status`+`decode`를 파싱 거부한다.)

---

## 4. 변경 상세

### 4.1 엔진 의존성 — 충족 R: R3
- 루트 `Cargo.toml` `[workspace.dependencies]`에 `base64 = "0.22"`, `crates/engine/Cargo.toml` `[dependencies]`에 `base64.workspace = true`. `Cargo.lock`엔 이미 `base64 0.22.1`이 전이 의존으로 존재(§9 C8) → 새 크레이트 다운로드 없음(오프라인 빌드 영향 없음).

### 4.2 `crates/engine/src/scenario.rs` — 충족 R: R1
- 신규 `#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)] #[serde(rename_all = "lowercase")] pub enum Decode { Base64, Jwt }` — 데이터 없는 enum이라 derive 왕복 OK(`CompareOp`·`CookieJarMode` 부류, engine CLAUDE.md).
- `Extract::{Body, Header, Cookie}`에 두 필드 추가: `#[serde(default, skip_serializing_if = "Option::is_none")] decode: Option<Decode>`, 같은 속성의 `claim: Option<String>`. `Status`는 무변경.
- `Extract::var()`는 `..` 패턴이라 무변경. 필드를 나열하는 struct **리터럴**(§9 C9: `extract.rs` 테스트·`executor.rs`·`scenario.rs`·`tests/proptests.rs`)은 `decode: None, claim: None`을 추가하고, 필드를 나열하는 **패턴**(예: `scenario.rs`의 `Extract::Body { var, path } =>` match arm)은 `..`를 붙인다(컴파일러가 전수 강제).
- `tests/proptests.rs`의 `arb_extract`가 `decode`·`claim`을 `prop::option::of`로 생성하도록 확장 — 와이어 왕복 프로퍼티가 새 필드를 덮는다.

### 4.3 `crates/engine/src/extract.rs` — 충족 R: R3, R4, R5, R6, R7, R8
- 기존 `match`가 꺼낸 원문 문자열(`raw`)과 `(decode, claim)`을 받는 `fn post_process(var: &str, raw: String, decode: Option<Decode>, claim: Option<&str>) -> Result<String>`를 추가하고, `Body`/`Header`/`Cookie` arm의 `out.insert` 직전에 거친다. `decode == None && claim == None`이면 `raw`를 그대로 반환(R7 — 기존 경로 무변경).
- **판정 순서 고정**(다중 결함 입력의 사유가 결정적이도록, r2 N4): ① `claim`이 있고 `decode`가 없으면 `claim requires decode` → ② (`jwt`) `Bearer` 제거·3조각 검사 → ③ base64 디코딩 → ④ UTF-8 → ⑤ (`jwt`이거나 `claim`이 있으면) JSON 파싱 → ⑥ claim 경로 파싱(`invalid claim path`) → ⑦ 쿼리(`claim not found`). 원문 추출 자체의 실패(`no match`/`no header` 등)는 이 단계들보다 먼저이며 기존 문구 그대로다(R7).
- 순수 헬퍼 2개: `decode_base64_text(s: &str) -> Result<String, Base64TextError>`(`NotBase64` | `NotUtf8` — R6의 두 사유를 구분해야 하므로 `Option` 아님; R3: trim → `trim_end_matches('=')` → 알파벳 판별 → `STANDARD_NO_PAD`/`URL_SAFE_NO_PAD` → `String::from_utf8`), `jwt_payload(s: &str) -> Result<&str, JwtShapeError>`(R4: `Bearer` 접두 제거 → `split('.')` 3조각 검사 → 두 번째 조각).
- claim 평가는 기존 `stringify` 재사용(R5 — body 추출과 같은 문자열화 규칙). 경로 파싱 실패와 매치 없음을 구분해야 하므로(R6 `invalid claim path` vs `claim not found`) `JsonPath::parse`를 먼저 호출해 실패를 따로 보고하고, 매치는 기존 `jsonpath_first`와 같은 `query(...).first()`로 얻는다. (기존 body 추출의 `jsonpath_first`는 두 경우를 `no match`로 합치는데, R7 때문에 그쪽은 건드리지 않는다.)
- 실패 문구는 R6의 고정 사유만. 하위 에러(`DecodeError`·`serde_json::Error`·`Utf8Error`)는 `map_err(|_| …)`로 버린다.
- `executor.rs`의 두 호출부(부하 `execute_step`·trace `execute_step_traced`)는 이미 같은 `evaluate`를 부르므로 무변경(R8 — §9 C5).

### 4.4 `ui/src/scenario/model.ts` — 충족 R: R2
- `ExtractModel`의 body/header/cookie 객체에 `decode: z.enum(["base64", "jwt"]).optional()`, `claim: z.string().min(1).optional()` 추가(`.strict()` 유지, `.default()` 금지 — 중첩 default 누출 함정). `status`는 무변경(`.strict()`가 두 키를 거부).
- `claim ⇒ decode` 검증은 discriminatedUnion **멤버가 아니라 union 전체에 `.superRefine`**(`BodyModel`·`StepModel` 선례 — 멤버에 붙이면 ZodEffects라 discriminatedUnion이 거부). 메시지는 영어 고정 문구 `"claim requires decode"`, issue `path: ["claim"]`로 고정(와이어 모델 문구는 영어 유지 규칙 — ui/CLAUDE.md 게이트 매핑 항목). 결과 세그먼트는 `steps.N.extract.M.claim: claim requires decode`이며 R12의 매핑 정규식·드리프트 가드가 이 형태를 기준으로 한다.
- `type Extract`는 infer 유지 — 소비처 타입만 넓어진다.

### 4.5 `ui/src/scenario/problems.ts` · `ko.ts` — 충족 R: R12
- `formatSegment`에 `claim requires decode` → `ko.editor.gateExtractClaimNeedsDecode` 매핑 분기 추가(기존 분기 뒤·`return seg;` 앞). 실-Zod 드리프트 가드 테스트 동반(ui/CLAUDE.md 규칙 ④).

### 4.6 `ui/src/components/scenario/Inspector.tsx` `ExtractEditor` — 충족 R: R9, R11
- `DraftExtract` 타입에 `decode?`/`claim?` 추가.
- body/header/cookie 행에 `<Select size="sm" aria-label={ko.editor.extractDecodeAria(idx)}>`(옵션: 없음/base64/JWT) — 변경 시 **즉시 커밋**(구조 변경 = `setFromKind`와 같은 취급). `없음` 선택 시 draft에서 `decode`와 `claim`을 **키째 삭제**(R11 — `undefined` 대입이 아니라 키 제거).
- `decode`가 있을 때만 claim `<Input size="sm" placeholder="$.sub" aria-label={ko.editor.extractClaimAria(idx)}>` 렌더 — onChange는 draft만, **onBlur 커밋**(기존 path/name 입력과 같은 F5 패턴). 빈 문자열이면 커밋 시 키 제거(R11).
- `setFromKind`: body/header/cookie 간 전환은 `decode`/`claim` 보존, `status`로 전환하면 두 키 제거(R9).
- `commitDrafts`의 valid 필터는 무변경(claim은 decode 없이 만들 수 없는 UI라 별도 필터 불요 — 단 R11 정규화를 commit 직전 한 곳에서 수행: 빈 `claim`·`undefined` 값 키 제거).
- 새 편집 어포던스이므로 디코딩 선택·claim 입력에 `disabled={yamlError !== null}` 게이트를 단다(scenario/CLAUDE.md "새 편집 어포던스는 `yamlError !== null` disabled 필수"). **같은 행의 기존 입력(var/path/name)은 현재 무게이트**(§9 C11 — Inspector 전체가 `yamlError`를 안 읽는다)라 행 안에 비대칭이 생기지만, 기존 입력 게이트는 범위 밖(§7 연기)이다.
- `ko.ts`: `extractDecodeAria(idx)`·`extractClaimAria(idx)`·옵션 라벨 3종(`extractDecodeNone`·`extractDecodeBase64`·`extractDecodeJwt`)·claim placeholder는 리터럴 `$.sub`(코드 예시라 비번역).

### 4.7 `ui/src/scenario/yamlDoc.ts` — 충족 R: R10
- `normalizeStep`이 `extract` 배열을 원소 단위 정규화 없이 그대로 넘기고(§9 C10), `setStepExtract`는 `doc.createNode(edit.extract)`로 통째 기록한다. yaml 2.9의 `createNode`는 `undefined` 값 키를 **생략**하지만 `claim: ""`는 그대로 쓴다(리뷰 r1 node probe) → R11은 §4.6의 커밋 직전 정규화가 담당하고, 여기선 R10을 테스트로 닫는다.
- `Edit` union의 `setStepExtract.extract` 타입(손으로 쓴 4변형 union, §9 C14)을 `ReadonlyArray<Extract>`(model.ts의 infer 타입)로 넓힌다 — 지금도 구조적으로 컴파일되지만 새 필드를 타입이 모르게 두지 않는다.

---

## 5. 무변경 / 불변식

- **컨트롤러·proto·워커·migration 코드 0-diff** — 컨트롤러는 저장 시 YAML을 엔진으로 검증하고(§9 C12), open-loop + 시나리오 think 미적용 run에선 `maybe_strip_think`가 YAML을 **재파싱→`to_yaml()` 재직렬화해 워커에 보낸다**(§9 C15) — 즉 R1의 serde 왕복이 실제 워커 와이어에 걸린다(R1 왕복 테스트가 그 보증). 워커는 엔진 `Scenario`를 그대로 역직렬화한다(§9 C2). 단 워커 **재빌드**는 필요(§3.5). `desktop/src-tauri/Cargo.lock`(별도 workspace)은 엔진이 `base64`를 직접 의존하게 되면서 갱신될 수 있다 — 코드 diff가 아니라 lock 동기화.
- `decode`/`claim` 없는 시나리오는 YAML·엔진 동작·에러 문구 byte-identical(R1·R7·R11).
- `Extract::var()`·`Branch::output_var_names()`·UI `scanVars`/`buildVarRefIndex`·변수 rename(`extract[].var`만 재작성) 무변경 — 변수 **이름** 생산 관계는 그대로이고 값만 달라진다.
- 응답 기반 `+추출`(`ExtractConfirmRow`/`ResponseBodyTree`)은 `decode` 없는 추출을 만든다(이번 범위 밖, §7).
- 추출 실패 시 그 스텝의 추출 전체가 버려지는 기존 의미(첫 실패에서 `Err`) 유지.

---

## 6. 테스트 / 검증

**R별 검증 방법은 §2 표의 acceptance 셀이 단일 소스다**(여기 복제하지 않는다 — r2 리뷰 N1: 두 표가 따로 놀았다). 이 절은 라이브로도 닫히는 R과 라이브 절차만 소유한다.

| R-id | 라이브로도 닫힘 |
|---|---|
| R5 | ✅ US1·US2 |
| R6 | ✅ US3 |
| R8 | ✅ US1 (미리 실행 칩 값 == 부하 run 와이어 값) |
| R10 | ✅ 저장→새로고침 후 `GET /api/scenarios/{id}`의 `yaml` |

**라이브 검증 (필수 — 엔진 추출 경로 변경)**, `/live-verify` 스택 + 워커 재빌드:

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | JWT를 본문(`access_token`)과 `Authorization: Bearer …` 헤더로 돌려주는 responder → 시나리오: 1스텝 추출 `decode: jwt, claim: $.sub` → 2스텝 URL `/u/{{user_id}}`. 에디터 미리 실행 + 실제 run(로깅 echo) | 미리 실행 칩 `user_id=<sub>` · echo 로그에 `GET /u/<sub>` 실재 · 헤더 경로도 동일 |
| US2 | 4변형(표준±패딩·URL-safe±패딩)을 헤더 4개로 주는 responder → 각 `decode: base64` 추출 | 칩 4개가 같은 원문 |
| US3 | 비-base64·3조각 아님·claim 없음 응답 → 미리 실행 | 스텝 에러에 `{var}: <사유>` 표시, 토큰 원문/디코딩 값 부재 |
| — | UI 편집기로 디코딩 지정 → 저장 → 새로고침 | `GET /api/scenarios/{id}`의 `yaml`에 `decode`/`claim` 존속(R10 라이브) |

- **보안 게이트**: diff가 추출·trace 경로를 건드리므로 `security-reviewer` 필수(finish-slice §0 grep이 판정 — 예측으로 생략 금지).

---

## 7. 의도적 연기

- **요청 측 인코딩**(`{{var:b64}}`·`{{var:b64url}}`, 관례: 표준=패딩, URL-safe=무패딩) — 슬라이스 2. 미결: Basic 인증처럼 **여러 값을 합친 문자열**(`{{id}}:{{pw}}`)의 인코딩 표현(현행 캐스트는 단일 토큰 단위). roadmap에 기록.
- **`from: var`(B안)** — 데이터셋/변수 값 디코딩 수요 확인 시. `decode`/`claim` 재사용.
- **`+추출`(응답 트리)에서 JWT 감지·디코딩 제안** — 편집기 경로로 충분한지 도그푸딩 후.
- **JWT 서명 검증·`exp` 검사**, **바이너리 디코딩(hex 등)**, **JWE(5조각)** — 부하 도구 범위 밖.
- 기존 추출 실패 문구에 변수명 붙이기 — R7(byte-identical) 유지를 위해 이번엔 신규 문구만.
- **퍼센트 인코딩된 쿠키 값**(`abc%3D%3D`처럼 `=`가 `%3D`로 온 base64) — `%`는 base64 문자가 아니라 `not base64`로 실패한다. URL 디코딩 단계 추가 여부는 실사용 사례 확인 후(US2의 쿠키 경로는 퍼센트 인코딩 없는 값만 보장).
- Inspector 기존 입력(추출 var/path/name 포함) 전반의 `yamlError` 게이트 — 선재 갭(§9 C11), 이번엔 새 컨트롤만 게이트.

---

## 8. 구현 순서 (plan 입력)

1. **엔진 계약+처리** (R1, R3–R8): 의존성 → `Decode`·필드 추가(리터럴 전수 수정) → `post_process`+헬퍼+단위 → R8 통합. 모델 필드만 먼저 넣으면 clippy dead_code는 없지만(필드는 serde가 씀) 처리 없는 필드는 R7 외 의미가 없으므로 **한 green 커밋으로 fold** 권장(cargo 게이트가 RED-only 커밋 불가).
2. **UI 계약** (R2, R12): Zod 필드+superRefine+게이트 매핑 — R1과 같은 와이어 경계라 1과 연속 머지.
3. **UI 편집기** (R9–R11): ExtractEditor + ko + RTL + yamlDoc 왕복.
4. (CLAUDE.md 신규 함정 없음 — §3.5: 기존 워커-재빌드 함정이 이 경우를 덮는다. 마무리 시 구현 중 새로 발견한 함정만 기록.)

---

## 9. 클레임 레저 (사실 주장 ↔ 확인 명령, 디스패치 전 재실행)

| # | 주장 | 확인 명령 |
|---|---|---|
| C1 | 컨트롤러는 엔진 `Scenario`를 파싱하지만 `Extract` 변형을 만들거나 나열하지 않는다(필드 추가로 컴파일 영향 없음) | `grep -rn 'Extract::' crates/controller/src --include='*.rs'` → 0건 |
| C2 | 워커는 엔진 `Scenario`를 그대로 역직렬화한다 | `grep -rn 'Scenario::from_yaml\|serde_yaml::from_str' crates/worker crates/worker-core --include='*.rs'` |
| C3 | 엔진·UI에 base64 처리가 없다 | `grep -rniE 'base64\|b64\|urlsafe' crates/engine/src crates/controller/src ui/src` → `kvBulk.test.ts` 주석 1건뿐 |
| C4 | `Extract`의 enum 레벨 `deny_unknown_fields`는 struct 변형에서 **강제된다**(scenario.rs:49의 "강제 안 됨" 주석은 `Step` 얘기) | `grep -n 'tag = "from"' crates/engine/src/scenario.rs` + 엔진 테스트 probe: `from: body` 행에 `decode: jwt` → `Err(unknown field \`decode\`)`, `from: status` 행에 `bogus: 1` → `Err(unknown field)` (2026-10-15 재현; 구현 후엔 R1 엄격성 핀 테스트가 상시 보증) |
| C5 | 부하·trace 두 경로가 같은 `evaluate`를 부르고, 부하 경로는 `error`를 bool로만 쓴다 | `grep -n 'evaluate_extracts(' crates/engine/src/executor.rs` (호출 2건 — 괄호 없이 grep하면 import 줄까지 3건) · `grep -n 'outcome.error' crates/engine/src/runner.rs` (`is_some()`만) |
| C6 | `safe_cause`가 `ExtractFailed`를 `None`으로 거른다 | `grep -n 'ExtractFailed' crates/engine/src/error.rs` |
| C7 | `from_yaml`은 serde만 돈다(별도 검증 없음) | `grep -n 'pub fn from_yaml' -A3 crates/engine/src/scenario.rs` |
| C8 | `base64 0.22.1`이 이미 lock에 있다·workspace 직접 의존은 없다 | `grep -A1 '^name = "base64"$' Cargo.lock` · `grep -n base64 Cargo.toml crates/engine/Cargo.toml` → lock만 |
| C9 | `Extract` 변형 리터럴/패턴 사이트 | `grep -rn 'Extract::\(Body\|Header\|Cookie\|Status\)' crates --include='*.rs'` (2026-10-15 기준: extract.rs 외 22줄 — executor.rs·scenario.rs·tests/proptests.rs — **+ `extract.rs` 테스트 리터럴 10곳**) |
| C10 | UI `normalizeStep`이 extract 배열을 그대로 통과시킨다 | `grep -n 'src.extract' ui/src/scenario/yamlDoc.ts` |
| C11 | Inspector(추출 편집기 포함)는 `yamlError`를 읽지 않는다 | `grep -c yamlError ui/src/components/scenario/Inspector.tsx` → 0 |
| C12 | 컨트롤러는 시나리오 생성·수정 시 엔진으로 파싱·검증한다 | `grep -n 'Scenario::from_yaml' crates/controller/src/api/scenarios.rs` |
| C13 | proto `Register`에 버전 필드가 없다 | `grep -n 'message Register' -A10 crates/proto/proto/*.proto` |
| C14 | `Edit.setStepExtract.extract`는 손으로 쓴 4변형 union이다 | `grep -n 'type: "setStepExtract"' -A8 ui/src/scenario/yamlDoc.ts` |
| C15 | `maybe_strip_think`가 open-loop think 미적용 run의 YAML을 재직렬화해 워커에 보낸다 | `grep -n 'fn maybe_strip_think' -A15 crates/controller/src/api/runs.rs` |
| C16 | 시나리오 저장 경로의 파싱 실패는 400이다(422는 test-run 경로뿐) | `grep -n 'ApiError::Scenario(e) =>' crates/controller/src/error.rs` → `BAD_REQUEST` |
| C17 | pool 워커는 배정 실패 후 종료하지 않고 idle로 재연결한다 | `grep -n 'back to idle' crates/worker/src/lib.rs` |
