# Disabled Row Toggle (Postman식) — 헤더 & 폼 body — 설계

- 날짜: 2026-06-03
- 영역: B4 (Header/Form 벌크 입력 연기 항목) — `docs/roadmap.md` §B4 "disabled 행 토글"
- 출처: `docs/roadmap.md` §B4, auto-memory `header-form-bulk-entry`(연기 항목). 사용자가 "편의 기능으로 먼저 해볼 만"이라 판단 → KeyValueGrid 후속 UI 슬라이스.
- 선행: Header/Form 벌크 입력(`KeyValueGrid`/`BulkEditPanel`/`kvBulk.ts`, master `102794f`) 완료. Slice 8a(form/JSON body 템플릿팅) 완료.

## 1. 목표 한 줄

Postman처럼 **헤더·폼 body의 KV 행을 지우지 않고 체크박스로 잠시 끌 수 있게** 한다. 꺼둔 행은 시나리오 YAML에 보존돼 save·reload·git 공유 후에도 살아남고, 부하 실행 시엔 전송되지 않는다.

## 2. 범위 (이 슬라이스에서 하는 것 / 안 하는 것)

### IN

- 엔진 `Request`에 **executor가 절대 읽지 않는** `disabled: DisabledRows` 사이드카 필드 추가(`headers`/`form` 두 맵). 비활성 행 보존용.
- `KeyValueGrid`(= `HeadersEditor` + `FormBodyField`)에 **행별 enabled 체크박스**. 기본 on. 토글로 active ↔ disabled 맵 사이 이동.
- 비활성 행도 **평소처럼 정상 편집 가능**(텍스트 입력 살아있음). 시각적 muting(취소선/회색) **없음** — 체크박스로만 상태 표현.
- UI Zod `RequestModel`에 `disabled?` 추가 — 엔진 serde와 **와이어 1:1**.
- `yamlDoc.ts`: active 키와 `request.disabled.*`를 타깃 edit으로 쓰고, 비면 `disabled`(및 하위 맵) 제거.
- `BulkEditPanel`: 비활성 행은 벌크 텍스트에 **안 보임**. 붙여넣기(active 전체교체) 시 비활성 행 **보존**(key 충돌 시 active 우선).
- 테스트: 엔진 serde round-trip + executor 무시 + byte-identical, UI 토글/커밋 분할/yamlDoc round-trip/scanFlowVars 제외/bulk 보존/모델 패리티.

### OUT (의도적 연기)

- **변수(Variables) 토글** — 변수는 별도 `VariablesPanel`(KeyValueGrid 미사용)이고, 변수를 끄면 그걸 참조하는 모든 곳(URL·헤더·바디·if 조건)에 빈 렌더/lenient-false로 *확산*돼 의미가 모호·위험. 직접적 "행 미전송" 의미가 없어 제외.
- **멀티값 헤더** — 기존 결정대로 de-scoped(중복 입력 필요성 낮음).
- **비활성 행 시각 dim** — 체크박스만으로 충분. 필요 시 후속에서 옵션으로.
- **JSON/raw body의 부분 비활성** — JSON/raw는 KV 구조가 아니라 토글 대상 아님(form만).

## 3. 핵심 결정 (확정)

| 결정 | 값 | 이유 |
|---|---|---|
| 지속성 | **시나리오 YAML에 저장** | Postman식 "끄되 보존". ADR-0013(시나리오=git/YAML)과 일치. |
| 저장 위치 | **엔진 `Request.disabled` 사이드카 필드** | 시나리오 파싱 구조체(`Scenario`/`HttpStep`/`Request`)가 전부 `deny_unknown_fields`라 구조화된 사이드카 키를 어디 넣어도 엔진 파싱이 깨짐 → known 필드로 선언해야 함. 주석 인코딩(엔진 0변경)은 취약·유지보수 리스크라 기각. 전면 per-entry 모델(map→list)은 executor 필터+전 fixture/test 영향으로 과함. |
| 헤더+폼 한곳 | **`Request.disabled.{headers,form}`** (form을 `Body::Form` 안에 안 넣음) | `Body`는 손수 짠 round-trip 함정 serde(`crates/engine/CLAUDE.md`)라 무변경 유지. 비활성 행 둘을 한곳에 모음. |
| executor | **`request.disabled` 절대 안 읽음** | hot-path는 `request.headers`/`body`(active)만 순회 → per-request 비용 0. 비면 `skip_serializing_if`로 YAML 키 사라져 byte-identical. proto·migration·워커 로직 무변경. |
| UI 시각 처리 | **체크박스만, muting 없음** | 비활성 행도 편집 가능해야 하므로 "못 만지는 것"처럼 보이는 취소선/회색 배제(사용자 결정). |
| bulk × 비활성 | **보존**(active만 교체, 충돌 시 active 우선) | 화면에 안 보이는 행을 조용히 날리는 footgun 회피. "잠시 끄기"의 가치 보전. |

## 4. 데이터 모델 (엔진 `crates/engine/src/scenario.rs`)

`Request`에 필드 추가 + 새 구조체:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub method: HttpMethod,
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<Body>,
    #[serde(default, skip_serializing_if = "DisabledRows::is_empty")]
    pub disabled: DisabledRows,   // ← 추가. executor 미사용(authoring-only).
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DisabledRows {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub form: BTreeMap<String, String>,
}

impl DisabledRows {
    pub fn is_empty(&self) -> bool { self.headers.is_empty() && self.form.is_empty() }
}
```

YAML 형태(비활성 행 있을 때만 등장):

```yaml
- type: http
  id: 01J...
  name: login
  request:
    method: POST
    url: https://api/login
    headers:
      Content-Type: application/json
    body:
      form:
        keep: "1"
    disabled:                 # skip_serializing_if → 비면 키 자체가 사라짐
      headers:
        X-Debug: "on"
      form:
        skip: "2"
```

- `Request`의 `deny_unknown_fields` 유지(disabled는 이제 known). `DisabledRows`도 `deny_unknown_fields`.
- `disabled.form`은 body kind가 form일 때만 의미. body가 json/raw로 바뀌면 UI가 `disabled.form`을 떨군다(§7).

### 4.1 기존 `Request {…}` 구조체 리터럴 11곳 갱신 (필수 — 컴파일 게이트)

`Request`에 5번째 필드를 더하면 named 구조체 리터럴(`..Default::default()` 미사용)이 전부 `E0063: missing field 'disabled'`로 깨진다. pre-commit hook이 비-`.md` 커밋마다 `cargo build/clippy/test --workspace`를 돌리므로 런타임이 아니라 **하드 컴파일 게이트**다. 갱신 대상:
- `crates/engine/src/executor.rs` — `#[cfg(test)] mod tests`의 10곳: 라인 473·516·559·601·639·670·714·754·796.
- `crates/engine/tests/proptests.rs:76` — `arb_http_step()` 내부.

**방침**: `Request`에 `#[derive(Default)]`를 추가하지 **않는다**(필수 `method: HttpMethod`/`url`이 있어 `HttpMethod: Default`까지 끌고 가야 하므로). 대신 11곳에 한 줄씩 `disabled: DisabledRows::default()`를 명시 추가(최소·국소 변경). round-trip 테스트는 안전: `arb_http_step`이 `disabled`를 안 세팅해 양쪽 `DisabledRows::default()`라 `prop_assert_eq!` 통과, `scenario.rs` 단위는 `.contains(...)` 부분일치라 `skip_serializing_if`로 disabled가 빠져도 green. (controller `report.rs`는 시나리오를 opaque 문자열로 다뤄 `engine::Request`로 역직렬화 안 함, worker도 `Request` 리터럴 미구성 → 엔진 밖 영향 없음.)

## 5. 엔진 불변식 (성능·하위호환)

- **executor 무시 불변식**: `executor.rs`의 요청 빌드 경로는 `request.headers`·`request.body`(active)만 읽는다. `request.disabled`는 run 중 어디서도 참조되지 않는다 → 비활성 행은 per-request 비용 0.
- **byte-identical**: 비활성 행이 없으면 `skip_serializing_if`로 `disabled` 키가 직렬화에서 빠지고, `#[serde(default)]`로 기존 시나리오(YAML에 disabled 없음)도 그대로 파싱 → 부하 경로 byte-identical.
- **무변경 레이어**: proto·controller·worker 로직·migration 전부 무변경(워커는 scenario_yaml 문자열을 통과시킬 뿐). 엔진 변경은 추가·무시 필드 1개 + serde.
- **trace 일관성 (trace.rs 무변경)**: test-run trace는 `executor.rs::execute_step_traced`(`execute_step`의 의도된 두 번째 구현, `crates/engine/CLAUDE.md`)를 쓰고 이것도 url/headers/body(active)만 읽는다 → trace는 active만 표시(부하와 동일). `disabled`를 읽는 코드를 **두 인터프리터 어디에도 넣지 않는다** — 명시적 "trace 무변경"으로 lockstep 불변식 보존.

## 6. UI 동작

### 6.1 모델 (`ui/src/scenario/model.ts`)

`RequestModel`에 와이어 1:1로 추가:

```ts
disabled: z
  .object({
    headers: z.record(z.string(), z.string()).optional(),
    form: z.record(z.string(), z.string()).optional(),
  })
  .optional(),
```

- `.default({})` **금지** — 중첩 `.default()`는 부모 `z.infer`에 `T | undefined` 누출(`pnpm build`에서만 잡힘, `ui/CLAUDE.md`). `.optional()`로.
- 필드명(`disabled.headers`/`disabled.form`)은 엔진 serde와 정확히 일치.
- `RequestModel`은 `.strict()`라, 스키마에 `disabled`를 더해야 unknown 키로 거부되지 않는다(known 필드가 되면 `.strict()`는 통과).

### 6.1a `normalizeRequest` passthrough (필수 — 안 하면 write-only)

**`ui/src/scenario/yamlDoc.ts::normalizeRequest`(현 470–478)는 request를 정확히 `{method, url, headers, body}`로 재구성**하며 `disabled`를 **버린다**(`...r` 스프레드 없음). 이 함수는 `parseScenarioDoc → normalizeForModel → normalizeStep → normalizeRequest` 경로로 `ScenarioModel.safeParse` **이전**에 돈다. 그래서 §6.1만으로는 부족하다 — `normalizeRequest`가 `disabled`를 통과시키지 않으면 YAML의 `request.disabled.*`가 파싱 모델에 **영영 도달 못 해** `step.request.disabled`가 항상 `undefined`가 되고, 토글이 YAML에 **쓸 수는 있어도 reload 시 읽지 못한다**(§1 목표 무력화). (이것이 §7 scanFlowVars 제외가 "변경 불필요"인 진짜 이유이기도 함 — 우연히 맞는 것.)

**수정**: `normalizeRequest`가 `disabled`를 통과시킨다(빈/`undefined`면 키 자체를 안 실어 하위호환 유지):
```ts
...(r.disabled === undefined ? {} : { disabled: r.disabled }),
```
`normalizeRequest`를 **변경 사이트로 plan에 명시**.

### 6.2 `KeyValueGrid` — 컴포넌트 계약 변경 (active + disabled 둘 다 소유)

현재 `KeyValueGrid`는 단일 `entries: Record<string,string>`(active)만 받고 `onChange(active)` 하나만 emit하는 범용 컴포넌트다. disabled 셋은 **다른 경로**(`request.disabled.*`)에 살고 Inspector 래퍼가 소유하므로, 보존/충돌 병합은 그리드 안에서밖에 못 한다. 따라서 **계약을 확장**한다(공유 컴포넌트 + 기존 RTL 테스트도 같이 바뀜 — `<input list>`=`combobox` role 함정 포함, `ui/CLAUDE.md`):

- props: `entries`(active) **+ 신규 `disabledEntries?: Record<string,string>`**.
- callback: `onChange(active, disabled)` **2-맵 시그니처**로 변경(또는 `{active, disabled}` 단일 객체). `HeadersEditor`/`FormBodyField` 둘 다 갱신.
- 내부 행 모델 `{key, value}` → `{key, value, enabled}`. 마운트/`resetKey` 변경 시 `entries`(enabled rows) + `disabledEntries`(disabled rows)를 합쳐 행 리스트 구성(active 먼저, 그다음 disabled). `resetKey`(=step.id) 재시드 규칙 유지(`entries` deep-compare 금지 함정).
- 각 행에 enabled 체크박스(기본 checked). 비활성 행도 key/value `<input>` 정상 편집 가능(읽기전용 아님, muting 없음).
- 커밋(텍스트 onBlur / 체크박스 토글은 **즉시** 커밋 = ExtractEditor 구조변경 패턴): 행 리스트를 `enabled`로 분할 → enabled→active 맵, disabled→disabled 맵, `onChange(active, disabled)` emit. 빈 key 행은 양쪽 맵에서 제외.
- **편집 경로 key 충돌 규칙(§3 "한 key=한 행" 보존)**: 분할 시 같은 key가 enabled·disabled 행에 동시 존재하면 **active(enabled)가 이기고** disabled 쪽 중복은 버린다(bulk 충돌 규칙과 동일). 각 맵 내 중복 key는 last-write-wins.

### 6.3 Inspector 배선

- `HeadersEditor`: `entries=step.request.headers ?? {}`, `disabledEntries=step.request.disabled?.headers ?? {}`, `onChange=(active, disabled) → setStepField`로 `request.headers`와 `request.disabled.headers`를 함께 갱신(빈 disabled면 키 제거).
- `FormBodyField`: `entries=body.value`(form), `disabledEntries=step.request.disabled?.form ?? {}`, `onChange`로 `request.body.form`과 `request.disabled.form`을 함께 갱신.

### 6.4 `yamlDoc.ts`

- **read 경로**: `normalizeRequest` passthrough(§6.1a) — `disabled`가 파싱 모델에 도달하게.
- **write 경로**: active 키 edit은 기존대로. `request.disabled.headers`/`request.disabled.form`을 타깃 `setIn`/제거(`setStepField.path`가 `ReadonlyArray<string>`라 `["request","disabled","headers"]` 수용). `setStepField`가 `value===undefined`면 `deleteIn` — extract 제거 선례와 동일.
- 맵이 비면 해당 키 제거, `disabled` 전체가 비면 `disabled` 제거 → YAML 클린 + byte-identical 보장.

### 6.5 `BulkEditPanel`

- `BulkEditPanel` 자체는 **active만** 다룬다(현 계약 유지): `entries`=active를 prepopulate, `onApply(parsed active map)`. 비활성 행은 벌크 텍스트에 안 보임.
- **보존/충돌 병합은 `KeyValueGrid` 안에서**(그리드가 active+disabled 둘 다 소유 — §6.2): 벌크 적용 시 그리드가 active = 파싱된 벌크 맵으로 교체, disabled 행은 보존. 벌크 key가 disabled key와 충돌하면 disabled에서 제거(active 우선). 그 뒤 `onChange(active, disabled)` emit. → `BulkEditPanel`/`kvBulk.ts` 시그니처 무변경, 병합 책임은 한곳(그리드).

## 7. 상호작용 / 엣지

- **data-binding(`scanFlowVars`)**: active만 스캔. `scanVars.ts`가 `request.headers`/`body.form`만 walk하므로 `disabled`를 walk에 **안 넣으면** 변경 없이 비활성 행 제외. (단 §6.1a로 `disabled`가 파싱 모델엔 들어오므로, `scanVars`가 `disabled`를 안 도는 것은 **명시적 설계**로 둔다 — 함수가 `request.headers`/`body`만 보는 현 구조 유지.)
- **body kind 전환**: form → json/raw 전환 시 `disabled.form`은 무의미 → UI가 떨군다(orphan 방지). 헤더 disabled는 body kind와 무관하게 유지.
- **한 key = 한 행**: 같은 key가 active·disabled 양쪽에 동시 존재 불가. 편집 경로(§6.2)·bulk 경로(§6.5) 모두 충돌 시 **active 우선**으로 해소.
- **test-run trace**: 엔진이 disabled 무시 → 패널에 active만(부하와 일관).

## 8. 테스트

### 엔진 (`scenario.rs` 단위 / `executor` 통합)
- serde round-trip: disabled present/absent 양쪽.
- `skip_serializing_if`: disabled 비면 직렬화 출력에 `disabled` 키 부재(byte-identical 단언).
- `#[serde(default)]`: 기존 YAML(disabled 없음) 파싱 OK.
- `deny_unknown_fields` 유지: 진짜 unknown 키는 여전히 거부.
- executor/wiremock: 비활성 헤더·폼 행이 실제 요청에 **포함 안 됨** 단언.
- (F1) 11개 `Request {…}` 리터럴에 `disabled: DisabledRows::default()` 추가 후 `cargo test --workspace` green.

### UI
- KeyValueGrid 체크박스 토글(RTL): enabled 플립, 비활성 행도 편집 가능.
- 커밋 분할: enabled→active, disabled→disabled 맵, `onChange(active, disabled)` 2-맵 emit.
- **(F2) read 경로**: `disabled` 든 YAML을 `parseScenarioDoc`→모델에 `step.request.disabled` 살아있음(`normalizeRequest` passthrough) → reload 시 비활성 행이 그리드에 체크 꺼진 채 렌더.
- yamlDoc round-trip: disabled write + 보존 + 빈 것 제거.
- scanFlowVars: 비활성 행 토큰 제외.
- BulkEditPanel: 벌크 텍스트에 비활성 행 부재 + 붙여넣기 후 disabled 보존(+충돌 시 active 우선).
- 편집 경로 충돌: enabled·disabled 동일 key → active 우선(§6.2).
- 모델 패리티: Zod `disabled.{headers,form}` ↔ 엔진 serde 필드명 1:1.

### 최종 리뷰
- `handicap-reviewer`로 UI Zod ↔ 엔진 serde 와이어 1:1, executor 무시 불변식, byte-identical 재확인.

## 9. 연기 항목 출처

- 변수 토글 / 멀티값 헤더 / 비활성 dim / JSON·raw 부분 비활성 → §2 OUT.
- ADR: 신규 ADR 불필요(기존 ADR-0014 변수 표기·ADR-0013 시나리오=YAML 범위 내, 와이어 포맷 additive 확장). 단 루트 CLAUDE.md "알아둘 결정들"엔 별도 추가 안 하고 도메인 CLAUDE.md 함정으로 기록.

## 10. 구현 주의 (plan 반영 — spec-plan-reviewer 발견)

- **(F1, CRITICAL)** `Request`에 `disabled` 추가 = `Request {…}` 리터럴 11곳 컴파일 깨짐(executor.rs 테스트 라인 473·516·559·601·639·670·714·754·796 + proptests.rs:76). 같은 커밋에서 `disabled: DisabledRows::default()` 추가. pre-commit이 `cargo build/clippy/test --workspace`라 첫 엔진 커밋이 안 빠지면 막힘.
- **(F2, CRITICAL)** `yamlDoc.ts::normalizeRequest`(470–478)가 `disabled`를 통과시키도록 수정 + `RequestModel`에 `disabled` 추가(§6.1/6.1a). 안 하면 write-only(reload 못 읽음).
- **(F3, IMPORTANT)** `KeyValueGrid` 계약 변경(`disabledEntries` prop + `onChange(active, disabled)`)은 공유 컴포넌트라 `HeadersEditor`/`FormBodyField` + 기존 RTL 테스트가 같이 바뀜. `<input list>`=`combobox` role 함정 유의(`ui/CLAUDE.md`).
- **커밋 fold (tdd-guard / 전체-게이트)**: `DisabledRows::is_empty`는 배선 전까진 `#[cfg(test)]`만 호출 = dead-code clippy 에러, RED 테스트 단독 커밋도 `test --workspace` 게이트 실패. 엔진 task는 **헬퍼+테스트+배선(11 리터럴 포함)을 하나의 green 커밋으로 fold**(루트 CLAUDE.md 함정).
- **워커 재빌드**: 엔진 필드 추가 후 로컬 e2e/수동확인 전 `cargo build -p handicap-worker` 필수(subprocess가 spawn하는 `target/debug/worker`는 controller 빌드로 안 갱신됨).
- **UI 게이트**: UI 변경 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`(`tsc -b`가 Zod widening·default 누출 잡음, hook은 cargo만 돌림).
