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

## 5. 엔진 불변식 (성능·하위호환)

- **executor 무시 불변식**: `executor.rs`의 요청 빌드 경로는 `request.headers`·`request.body`(active)만 읽는다. `request.disabled`는 run 중 어디서도 참조되지 않는다 → 비활성 행은 per-request 비용 0.
- **byte-identical**: 비활성 행이 없으면 `skip_serializing_if`로 `disabled` 키가 직렬화에서 빠지고, `#[serde(default)]`로 기존 시나리오(YAML에 disabled 없음)도 그대로 파싱 → 부하 경로 byte-identical.
- **무변경 레이어**: proto·controller·worker 로직·migration 전부 무변경(워커는 scenario_yaml 문자열을 통과시킬 뿐). 엔진 변경은 추가·무시 필드 1개 + serde.
- **trace 일관성**: test-run trace(`trace.rs`)도 `disabled`를 안 본다 → trace는 active만 표시(부하와 동일).

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

### 6.2 `KeyValueGrid`

- 각 행에 enabled 체크박스(기본 checked). 행 모델이 `{key, value}` → `{key, value, enabled}`로 확장.
- 표시 entries = active 맵(enabled rows) + disabled 맵(disabled rows) 병합. 정렬은 기존 그대로(active 먼저, 그다음 disabled — 또는 단순히 active→disabled 연결).
- 커밋(텍스트 onBlur / 체크박스 토글은 **즉시** 커밋 = ExtractEditor 구조변경 패턴): 행을 `enabled`로 분할 → enabled는 active 맵(`headers`/`body.form`), disabled는 `disabled.headers`/`disabled.form`. 빈 key 행은 양쪽 맵에서 제외.
- 비활성 행도 key/value `<input>` 정상 동작(읽기전용 아님).
- `resetKey`(=step.id) 재시드 규칙 유지(`entries` deep-compare 금지 함정).

### 6.3 Inspector 배선

- `HeadersEditor`: active=`step.request.headers ?? {}`, disabled=`step.request.disabled?.headers ?? {}`.
- `FormBodyField`: active=`body.value`(form), disabled=`step.request.disabled?.form ?? {}`.

### 6.4 `yamlDoc.ts`

- active 키 edit은 기존대로. `request.disabled.headers`/`request.disabled.form`을 타깃 `setIn`/제거.
- 맵이 비면 해당 키 제거, `disabled` 전체가 비면 `disabled` 제거 → YAML 클린 + byte-identical 보장.

### 6.5 `BulkEditPanel`

- 벌크 텍스트는 **active 행만** prepopulate(비활성 행 제외).
- 적용 시: active 맵 = 파싱된 벌크 entries. disabled 맵은 **보존**. 단, 벌크 key가 disabled key와 충돌하면 그 key를 disabled에서 제거(active 우선) → "한 key=한 행" 불변식.

## 7. 상호작용 / 엣지

- **data-binding(`scanFlowVars`)**: active만 스캔. 현재 `scanVars.ts`가 `request.headers`/`body.form`만 walk하므로 `disabled`를 walk에 **안 넣으면** 변경 없이 비활성 행 제외(꺼둔 행이 `{{var}}` 매핑 요구를 안 만듦).
- **body kind 전환**: form → json/raw 전환 시 `disabled.form`은 무의미 → UI가 떨군다(orphan 방지). 헤더 disabled는 body kind와 무관하게 유지.
- **한 key = 한 행**: 같은 key가 active·disabled 양쪽에 동시 존재 불가(토글이 둘 사이를 이동, bulk 충돌은 active 우선).
- **test-run trace**: 엔진이 disabled 무시 → 패널에 active만(부하와 일관).

## 8. 테스트

### 엔진 (`scenario.rs` 단위 / `executor` 통합)
- serde round-trip: disabled present/absent 양쪽.
- `skip_serializing_if`: disabled 비면 직렬화 출력에 `disabled` 키 부재(byte-identical 단언).
- `#[serde(default)]`: 기존 YAML(disabled 없음) 파싱 OK.
- `deny_unknown_fields` 유지: 진짜 unknown 키는 여전히 거부.
- executor/wiremock: 비활성 헤더·폼 행이 실제 요청에 **포함 안 됨** 단언.

### UI
- KeyValueGrid 체크박스 토글(RTL): enabled 플립, 비활성 행도 편집 가능.
- 커밋 분할: enabled→active, disabled→disabled 맵.
- yamlDoc round-trip: disabled 보존 + 빈 것 제거.
- scanFlowVars: 비활성 행 토큰 제외.
- BulkEditPanel: 벌크 텍스트에 비활성 행 부재 + 붙여넣기 후 disabled 보존(+충돌 시 active 우선).
- 모델 패리티: Zod `disabled.{headers,form}` ↔ 엔진 serde 필드명 1:1.

### 최종 리뷰
- `handicap-reviewer`로 UI Zod ↔ 엔진 serde 와이어 1:1, executor 무시 불변식, byte-identical 재확인.

## 9. 연기 항목 출처

- 변수 토글 / 멀티값 헤더 / 비활성 dim / JSON·raw 부분 비활성 → §2 OUT.
- ADR: 신규 ADR 불필요(기존 ADR-0014 변수 표기·ADR-0013 시나리오=YAML 범위 내, 와이어 포맷 additive 확장). 단 루트 CLAUDE.md "알아둘 결정들"엔 별도 추가 안 하고 도메인 CLAUDE.md 함정으로 기록.
