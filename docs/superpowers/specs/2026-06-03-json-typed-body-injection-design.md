# JSON Body 타입 캐스트 주입 (`{{var:num}}` / `{{var:bool}}`) 설계 명세

- **상태**: 작성 완료 (사용자 브레인스토밍 합의 반영)
- **날짜**: 2026-06-03
- **대상 범위**: JSON body 문자열 leaf를 명시적 캐스트 토큰으로 **JSON 숫자/불리언으로 주입**. flow `{{var}}` 토큰 + JSON body 한정. 단일 구현 plan으로 출하 가능한 자족 기능.
- **참조**: [Slice 8 data-driven 명세](2026-05-30-slice-8-data-driven-design.md) §1(8a 본문 템플릿팅)·§12(연기 항목 "JSON 숫자·타입 주입"), `docs/roadmap.md` "JSON 숫자 주입" 항목, ADR-0014(변수 표기 `{{var}}`/`${ENV}`/`${vu_id}`), ADR-0022(data-driven)

Slice 8a부터 form/JSON body가 템플릿팅되지만(`render_json_value`가 문자열 leaf만 치환), **값은 항상 문자열**로 나간다 — `{"age": "{{age}}"}` → `{"age": "30"}`. 데이터셋·env·extract로 흘러온 흐름 변수는 전부 `String`이라, 타겟 API가 `age`를 number로, `isReserve`를 bool로 기대하면 현재는 표현할 수 없다. 이 기능은 **명시적 캐스트 토큰**(`{{age:num}}`)으로 그 leaf만 JSON number/bool로 coerce한다.

---

## 목차

1. 범위 (IN / OUT)
2. 아키텍처 결정
3. 캐스트 문법 & 적용 규칙
4. 엔진 구현 (`render_json_value` + trace twin)
5. UI (Zod 검증)
6. 에러·경계·하위호환
7. 테스트
8. 명시적 연기 (Future)
9. 완료 기준
10. 의존성 & 호환성 검사
11. ADR

---

## 1. 범위

### IN
- **캐스트 문법** `{{var:num}}` / `{{var:bool}}` (+ 선택적 명시 `{{var:str}}`) — **JSON body 문자열 leaf가 순수 단일 토큰일 때만** number/bool으로 coerce.
- **엔진**: `executor.rs::render_json_value`(부하 hot path, strict) + `render_json_collecting`(trace twin, lenient) 두 곳에 공유 캐스트 헬퍼 적용. `template.rs`는 **무변경**.
- **엄격 실패**: 캐스트 대상 값이 파싱 불가(예: `:num`인데 `"abc"`)면 새 `EngineError::CastFailed` → 요청 빌드 실패(엔진 기존 fail-fast와 동일).
- **UI Zod 검증**: 시나리오 모델 검증에서 잘못된 캐스트 사용(미지원 keyword, 혼합-leaf 위치)을 authoring 시점에 에러로 표시(코드베이스 "Zod = strict authoring gate" 패턴).

### OUT (§8 연기)
- `:json` 캐스트(임의 JSON 리터럴) + **변수 기반 null** 주입.
- `${env}`/`${vu_id}` 등 **시스템/환경 토큰 캐스트** (flow `{{}}`만 먼저).
- form 값·URL·헤더·`Body::Raw` 캐스트(본질적으로 문자열뿐 — 무의미).
- "빈 셀/미바인딩 → null" 같은 nullable 규칙.
- 배열/객체 주입, 정수/실수 세분(`:int`/`:float`) 구분.

---

## 2. 아키텍처 결정

**명시적 캐스트 토큰 (채택).** typed `Body::Json`(`serde_json::Value`)을 유지하고, 토큰에 타입 힌트를 단다. 거절한 대안:
- **자동 형변환**(순수 토큰 leaf가 숫자처럼 보이면 자동 coerce): leading-zero(`"01234"`)·전화번호·`"true"` 문자열이 의도치 않게 변환되고, 기존 시나리오 출력이 바뀌어 하위호환이 깨진다.
- **raw-text 템플릿**(따옴표 없이 bare `{{age}}`, 렌더 후 그대로 전송): 직관적이나 문자열 값에 `"`·쉼표·개행이 들어가면 JSON이 깨지거나 **JSON 주입**이 된다 — 임의 CSV/XLSX에서 값을 끌어오는 도구라 실재 위험. typed `Value`는 serde가 escape를 보장한다. (raw 모드로 이미 가능하나 escape 책임이 작성자에게 넘어가는 trade-off.)

**캐스트 파싱은 leaf 레벨 (채택).** `render_json_value`가 단일-토큰 leaf를 감지해 캐스트 keyword를 분리하고, bare 토큰을 **기존 `render`로 그대로** 렌더한 뒤 결과 문자열을 coerce한다. `template.rs::render`/`render_lenient`/`render_collecting`는 캐스트를 영영 보지 않는다 → 엔진 hot-path 템플릿 파서 무변경, "엔진/UI 두 번 구현"·"세 진입점 동기화" 함정 회피.

**bare `{{var}}` = 문자열 기본 (채택, `:str`은 옵션).** URL·헤더·form·raw·조건에서 `{{var}}`는 이미 문자열 치환을 뜻한다. 캐스트는 **JSON leaf 전용 추가 기능**이고 bare=문자열은 모든 곳에서 단일 규칙으로 남는다(하위호환). `:str`은 의도 가드(`"{{zip:str}}"` = "leading-zero 유지, 숫자로 바꾸지 마")로만 **선택적** 제공 — 강제하지 않는다(흔한 케이스를 짧게, 예외에만 주석).

## 3. 캐스트 문법 & 적용 규칙

```yaml
body:
  json:
    age:       "{{age:num}}"        # age="30"    → 30      (JSON number)
    score:     "{{score:num}}"      # score="9.5" → 9.5     (int/float 모두)
    isReserve: "{{isReserve:bool}}" # value="true"→ true    (JSON bool)
    zip:       "{{zip:str}}"        # zip="01234" → "01234" (명시적 문자열, 선택)
    name:      "{{name}}"           # → "Lee"               (기본 = 문자열, 기존과 동일)
```

| 캐스트 | 의미 | 파싱 규칙 | 실패 시 |
|---|---|---|---|
| (없음) / `:str` | 문자열 (기본) | 렌더값을 그대로 `Value::String` | — |
| `:num` | JSON 숫자 | 렌더값을 **JSON number 문법**으로 파싱해 `Value::Number`(int/float/지수, **leading-zero 불허**). 정확한 API는 plan에서 확정(예: `serde_json::from_str::<Value>` 후 `Value::Number`인지 확인 — `"true"`가 bool로 새지 않게 number 타입 강제) | `CastFailed` |
| `:bool` | 불리언 | 렌더값이 **정확히** `"true"`→`true`, `"false"`→`false`, 그 외 모두 | `CastFailed` |

**적용 규칙 (정확한 정의):**

1. **순수 단일 토큰 leaf에만 발동.** JSON 문자열 leaf `s`를 trim 했을 때, 전체가 **정확히 하나의 `{{…}}` 토큰**(앞은 `{{`, 뒤는 `}}`, 내부에 다른 `{{`/`}}` 없음)이고 그 토큰 내부가 trailing `:<keyword>`(keyword ∈ `{str,num,bool}`)로 끝날 때만 캐스트로 본다.
2. **혼합/비-토큰 leaf는 캐스트 아님.** `"나이는 {{age:num}}살"`처럼 토큰이 문자열 일부면 캐스트로 처리하지 않는다 — 이 경우 leaf는 일반 문자열 경로로 가고, `render`가 `{{age:num}}`를 보면 변수명 `age:num`을 찾다 `UnknownVar` 에러를 낸다(loud). **UI Zod 검증(§5)이 이 오용을 authoring 시점에 먼저 막는다.**
3. **`{{flow}}` 토큰만.** `${env}`/`${vu_id}`/`${loop_index}` 토큰은 v1 캐스트 대상 아님(§8 연기). 순수 `${…}` leaf는 캐스트 분기에 안 들어가고 기존 문자열 경로 유지.
4. **bare 토큰 재구성 후 `render` 호출.** 캐스트 keyword를 떼고 `{{var}}`만 남겨 `render(bare, ctx)`(strict) / `render_collecting`(trace)로 문자열을 얻은 뒤 coerce. 즉 변수 해석 로직(미바인딩 → 기존 `UnknownVar`)은 그대로 재사용.
5. **JSON body 전용.** `Body::Form`/`Body::Raw`/URL/헤더 경로는 무변경.

## 4. 엔진 구현

### 4.1 공유 캐스트 헬퍼 (신규, `executor.rs` 또는 `template.rs` 인접 모듈)

```rust
enum Cast { Str, Num, Bool }

/// 순수 단일 `{{…}}` 토큰 leaf면 (bare 토큰, 캐스트) 반환. 아니면 None.
/// - 전체 trim 후 `{{`…`}}` 한 개로 정확히 둘러싸였는지 검사(내부에 `{{`/`}}` 없음).
/// - 내부 trailing `:num` / `:bool` / `:str` 분리(없으면 Cast::Str).
fn parse_cast_leaf(s: &str) -> Option<(String /*"{{var}}"*/, Cast)>;
```

- `Cast::Str`이거나 `parse_cast_leaf`가 `None`이면 **기존 문자열 경로**(byte-identical).
- `Cast::Num`/`Cast::Bool`이면 bare 토큰을 렌더한 문자열 `v`를 coerce:
  - `Num`: `v`를 JSON number로 파싱(타입이 number인지 강제 — `"true"`/`"01234"`/`"abc"`는 실패) → `Value::Number`.
  - `Bool`: `v == "true" → true`, `v == "false" → false`, 그 외 실패.
  - 실패 → strict 경로는 `Err(EngineError::CastFailed{ var, cast, value })`, trace 경로는 best-effort(§4.3).

### 4.2 부하 hot path — `render_json_value` (strict)

`Value::String(s)` arm을 분기:
```rust
Value::String(s) => match parse_cast_leaf(s) {
    Some((bare, Cast::Num))  => coerce_num(render(&bare, ctx)?)?,   // Err → CastFailed
    Some((bare, Cast::Bool)) => coerce_bool(render(&bare, ctx)?)?,
    _ => Value::String(render(s, ctx)?),                            // 기존 경로 (Str/None)
}
```
- **미바인딩**(`{{missing:num}}`)은 `render(&bare, …)`가 먼저 `UnknownVar`로 실패 → 기존 fail-fast와 동일(캐스트 단계 도달 전).
- **캐스트 토큰 없으면 함수 출력 byte-identical** = 하위호환.

### 4.3 trace twin — `render_json_collecting` (lenient, ADR-0026)

- `render_collecting`(lenient, 미해결 토큰 수집)로 bare 토큰을 렌더한 뒤 coerce 시도.
- coerce **실패 시 run을 죽이지 않음**: 원문 문자열(`{{age:num}}` 또는 렌더된 `"abc"`)을 `Value::String`으로 유지하고, 해당 토큰명을 `unbound`에 추가하지 않더라도 **trace가 "숫자로 안 들어감"을 사용자가 알 수 있게** 문자열로 표시(부하 경로의 `CastFailed`와 의도된 차이 — trace는 절대 Err 안 냄).
- **lockstep 유지**: `execute_steps`/`trace_steps` 함정과 동일하게, `render_json_value`에 캐스트를 넣으면 `render_json_collecting`도 같은 PR에서 갱신. 안 하면 trace가 부하 실행과 다른 body를 보여준다.

### 4.4 에러 타입

`EngineError`에 `CastFailed { var: String, cast: &'static str, value: String }` 추가(또는 기존 `MalformedTemplate` 재사용 — 명확성 위해 신규 권장). `Display`는 `"cannot cast {{var}} value \"{value}\" to {cast}"` 류.

## 5. UI (Zod 검증)

- **모델 구조 변경 없음**: `BodyModel`의 json 변형은 `z.object({ kind: z.literal("json"), value: z.unknown() })` 그대로 — 캐스트 문자열이 구조적으로 round-trip.
- **신규 `.superRefine` 검증**(json body value를 재귀 walk):
  - 문자열 leaf가 **순수 단일 `{{…}}` 토큰 + trailing `:<keyword>`**인데 keyword ∉ `{str,num,bool}` → 에러(`"unknown cast ':<kw>' — use :num, :bool, or :str"`).
  - **혼합 leaf**(토큰이 문자열 일부)에 캐스트 keyword가 보이면 → 에러(`"cast only applies to a standalone value"`). 정의: `:num`/`:bool`/`:str`로 끝나는 `{{…}}` 토큰이 leaf 전체가 아닐 때.
  - `${env}` 토큰 캐스트(예: `"${X:num}"`)도 v1 미지원 → **에러**(`"env/system token cast not supported yet — flow {{var}} only"`). (flow만 지원, §3-3.)
- **검증 false-positive 주의**(data-binding 함정 연장): 캐스트 없는 일반 토큰·리터럴은 절대 건드리지 않는다 — trailing cast keyword가 **명시적으로** 붙은 토큰만 검사.
- **test-run 패널 / resolveForDisplay 무변경**: 엔진이 coerce한 `body_display`(`serde_json::to_string`)를 `TestRunPanel`이 그대로 렌더 → `{"age":30}` 자동 표시. `resolveForDisplay`는 `{{}}`를 verbatim 유지하므로 `{{age:num}}`이 그대로 보여 무해(거짓말 안 함). 표시용 캐스트 strip은 비목표.

## 6. 에러·경계·하위호환

- **하위호환 (최우선 불변식)**: 캐스트 토큰이 하나도 없는 시나리오는 `render_json_value`·`render_json_collecting` 출력이 **byte-identical**. 회귀 테스트로 못 박는다(기존 8a 동작 보존).
- **미바인딩**: `{{x:num}}`에서 `x` 미바인딩 → `render` 단계 `UnknownVar`(캐스트 도달 전). 기존과 동일.
- **빈 문자열**: `{{x:num}}`인데 `x=""` → `Number::from_str("")` 실패 → `CastFailed`(엄격). 빈 셀 자동 null은 비목표.
- **leading-zero**: `{{zip:num}}`에 `"01234"` → JSON number 문법상 leading-zero 불허 → `from_str` 실패 → `CastFailed`. 이건 **버그를 드러내는 바람직한 실패**(ZIP은 문자열이어야 함). 의도적으로 문자열을 원하면 `:str` 또는 캐스트 없이.
- **공백**: `:num` 파싱은 렌더값 그대로(trim 안 함) — `" 30"` 실패. 필요 시 후속에서 정책화.
- **trace vs 부하의 의도된 차이**: 부하는 `CastFailed`로 요청 실패(메트릭 error), trace는 문자열로 표시하고 진행(진단 우선). 명시 기록.

## 7. 테스트

- **엔진 단위(`executor.rs` 인라인 `mod tests`)**:
  - `:num` int/float coerce(`"30"`→30, `"9.5"`→9.5), `:bool`(`"true"`/`"false"`), `:str` = 문자열.
  - `CastFailed`: `:num`+`"abc"`, `:num`+`"01234"`(leading-zero), `:num`+`""`, `:bool`+`"yes"`.
  - **혼합 leaf** `"x {{age:num}} y"` → 캐스트 미발동 → 일반 문자열 경로 → `render`가 변수 `age:num`을 못 찾아 `UnknownVar` 검증(UI Zod가 먼저 막지만 엔진 안전망 확인).
  - **no-cast byte-identical**: 기존 8a fixture가 동일 출력(회귀 가드).
  - `${env}` 순수 leaf는 캐스트 미발동(문자열 유지).
- **proptest**: 캐스트 없는 임의 JSON value round-trip 불변(하위호환 property).
- **trace 단위(`trace.rs`/executor traced)**: `render_json_collecting`이 `:num` coerce 표시 + coerce 실패를 문자열로 유지(Err 없음).
- **UI(`ui/src/scenario/__tests__`)**: Zod 검증 — 미지원 keyword·혼합 leaf 에러, 정상 `:num`/`:bool`/`:str` 통과, 캐스트 없는 시나리오 무영향. (`pnpm test` + `pnpm build`(`tsc -b`) 게이트.)
- **(선택) e2e**: 숫자 주입 body가 wiremock 타겟에 JSON number로 도달하는지 1개.

## 8. 명시적 연기 (Future)

- **`:json` 캐스트 + 변수 기반 null**: 임의 JSON 리터럴(`null`/배열/객체) 주입. `serde_json::from_str` 1줄이라 저렴하나 v1 범위 밖.
- **`${env}`/시스템 토큰 캐스트**: 문법은 구별 가능(`${X:-num}` default vs `${X:num}` cast — cast keyword는 `:` 직후, default는 `:-`). v1은 flow만.
- **nullable 규칙**(빈 셀/미바인딩 → null), **정수/실수 구분**(`:int`/`:float`), **공백 trim 정책**.
- form/raw/URL/헤더 캐스트.

## 9. 완료 기준

- [ ] `{{var:num}}`/`{{var:bool}}`이 JSON body에서 number/bool로 주입됨(엔진 단위 + 부하 경로).
- [ ] `:str` 및 캐스트 없는 토큰은 기존과 동일(문자열); **no-cast byte-identical 회귀 통과**.
- [ ] coerce 실패가 `CastFailed`로 요청 실패(엄격) — 부하 경로.
- [ ] trace twin이 coerce 결과를 표시(실패 시 문자열, Err 없음).
- [ ] UI Zod 검증이 미지원 keyword·혼합 leaf·`${env}` 캐스트를 authoring 에러로 표시.
- [ ] `cargo fmt`/`clippy -D warnings`/`cargo test --workspace` + `cd ui && pnpm lint && pnpm test && pnpm build` 모두 green.
- [ ] 로드맵 "JSON 숫자 주입" 항목 close, `crates/engine/CLAUDE.md`·`ui/CLAUDE.md` 함정 추가, ADR 갱신.

## 10. 의존성 & 호환성 검사

- **proto/controller/worker/migration 무변경**: 캐스트는 순수 엔진 렌더 단계 + UI 검증. 와이어·DB·메트릭 무영향.
- **`Body::Json` 모델 무변경**: `serde_json::Value` 그대로(캐스트는 문자열 leaf 내부 텍스트).
- **`template.rs` 무변경**: `render`/`render_lenient`/`render_collecting` 시그니처·동작 불변(캐스트는 leaf 레벨).
- **8a/8c 데이터 바인딩과 직교**: 데이터셋 값은 여전히 문자열로 `{{var}}`에 바인딩되고, 캐스트는 그 문자열을 JSON leaf에서 coerce할 뿐. 바인딩 정책·전송 무변경.

## 11. ADR

- ADR-0022(data-driven)에 "JSON 타입 캐스트 주입" 결정 한 줄 추가, 또는 신규 ADR(다음 번호)로 분리 — 명시적 캐스트 채택/자동변환·raw-text 거절 근거 + flow-only/`:num`·`:bool` 범위. 루트 `CLAUDE.md` "알아둘 결정들"에 한 줄.
