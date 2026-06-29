# `JSON 바디 캐스트 확장` — `${env}`/시스템 토큰 캐스트 + `:json` + 발견성 HelpTip (ADR-0029 확장)

- **날짜**: 2026-06-29
- **상태**: 설계 승인(사용자 2026-06-29) → plan 대기
- **출처**: 사용자 요청. ADR-0029(JSON 바디 캐스트)가 v1을 flow `{{var}}` 토큰 + `:num`/`:bool`/`:str`로 한정하고 **env/시스템 토큰 캐스트·`:json`·변수 기반 null을 연기**했는데, 그 연기분 중 *와이어에 효과가 있는*(JSON 타입을 실제로 바꾸는) 것들을 완성한다. 발견성: 사용자(기능 작성자)조차 캐스트 문법을 잊었고 UI에 안내가 0이라 1차 사용자 QA는 더더욱 모른다.
- **연관**: ADR-0029(`docs/adr/0029-json-body-type-cast-injection.md`), spec `2026-06-03-json-typed-body-injection-design.md`. 코드: `crates/engine/src/{cast.rs,executor.rs,error.rs}`, `ui/src/scenario/cast.ts`, `ui/src/components/scenario/Inspector.tsx`, `ui/src/components/HelpTip.tsx`, `ui/src/i18n/ko.ts`.
- **ADR**: 신규 불필요 — **ADR-0029 §범위/§결과 개정**(env/시스템 토큰 캐스트 + `:json` + 변수 기반 null을 "연기"→"구현"으로 이동). 같은 결정의 연기분 완성이라 새 번호 불요(사용자 승인).

---

## 1. 문제와 목표

ADR-0029 이후 JSON 바디 문자열 leaf의 **flow** 토큰만 타입 캐스트가 된다(`{"age":"{{age:num}}"}`→`{"age":30}`). 그래서 ① 환경/시스템 변수를 JSON 숫자/불리언으로 넣을 방법이 없고(`{"timeout":"${TIMEOUT_MS:num}"}`는 거부됨 — 우회로도 없음), ② 변수에 든 JSON 조각(객체/배열)을 주입할 수 없고, ③ 변수 값에 따른 JSON `null`을 만들 수 없다. 또 캐스트 문법 자체가 UI 어디에도 안내되지 않아 발견 불가능하다.

- **목표**: JSON 바디에서 (a) `${env}`/시스템 토큰도 `:num`/`:bool`/`:str`로 캐스트, (b) 4번째 캐스트 `:json`(값을 JSON으로 파싱해 주입 — 객체/배열/숫자/불리언/문자열/**null**), (c) JSON 바디 편집기에 캐스트 문법 HelpTip 안내. 캐스트는 flow `{{}}`와 env/시스템 `${}` **두 토큰 군에 동일하게** 적용.
- **비목표(연기)**: §7 참조. form/쿼리/raw 바디 캐스트(와이어가 전부 문자열이라 무의미)·empty/unbound→null 같은 nullable 편의 규칙.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `cast.rs::parse_cast_leaf`는 `${name:cast}`(env/시스템 토큰)도 인식해 `("${name}", cast)`를 반환한다 — 기존 `{{name:cast}}` 경로와 대칭. | `parse_cast_leaf("${PORT:num}") == Some(("${PORT}".into(), Cast::Num))`; `parse_cast_leaf("${vu_id:num}")` 동형 (cargo test) | |
| R2 | 4번째 캐스트 `Cast::Json` + `cast.rs::coerce_json`(렌더 문자열을 `serde_json::from_str`로 임의 JSON 값으로 파싱; 실패 시 `None`)을 추가하고, flow·env 두 토큰에서 동작. | `coerce_json("{\"a\":1}")`=Object, `coerce_json("null")`=Null, `coerce_json("42")`=42, `coerce_json("")`/`coerce_json("abc")`=None (cargo test) | |
| R3 | 평범한 env 기본값 `${VAR:-default}`(default가 `:keyword`로 끝나지 않는 경우)는 **캐스트로 오인되지 않는다** — 마지막 `:` 기준 분리 시 키워드 후보가 선행 `-`를 단 채(`-default`/`-8080`)라 str/num/bool/json 어느 것과도 안 맞음 → `None` → 기존 `render`가 default로 해석. (경계: default가 `:num` 등으로 *끝나면*(`${FOO:-bar:num}`) 마지막 콜론이 캐스트로 해석된다 — UI·엔진이 **동일하게** 그렇게 보므로 seam 어긋남 없음, §3-2.) | `parse_cast_leaf("${PORT:-8080}")==None`·`parse_cast_leaf("${PORT:-num}")==None`·`parse_cast_leaf("${FOO:-bar:num}")==Some(("${FOO:-bar}",Num))`(핀 테스트) (cargo test) | |
| R4 | strict 부하 경로(`executor.rs::render_json_value`)와 lenient trace 경로(`render_json_collecting`)는 새 env-토큰·`:json` 캐스트를 **기존 num/bool과 동형으로 lockstep** 처리한다 — strict는 coerce 실패 시 `EngineError::CastFailed`, trace는 best-effort 문자열 폴백. | strict `:json` 실패→`CastFailed`, trace 동일 입력→`Value::String` 폴백 단언 (cargo test, executor twin 테스트) | |
| R5 | `${x:json}`/`{{x:json}}`의 렌더 값이 문자열 `"null"`이면 JSON `null`을 낸다(= "변수 기반 null", 엄격 — empty/unbound는 `CastFailed`/`UnknownVar`). | `{{x:json}}`+`x="null"`→`Value::Null`; `{{x:json}}`+`x=""`→`CastFailed` (cargo test) | |
| R6 | UI `cast.ts::jsonBodyCastErrors`는 `${env}` 토큰의 **유효 캐스트를 통과**시키고(기존 "not supported yet" 거부 제거), flow 검증과 **동일 규칙**(미지원 키워드 → 에러, non-standalone 캐스트 → 에러)을 env 토큰에도 적용한다. `CAST_KEYWORDS`에 `"json"` 추가. | `${COUNT:num}`/`${x:json}` 무에러, `${x:int}` "unknown cast", `"a ${x:num} b"` "standalone only", `${PORT:-8080}` 무에러 (vitest cast.test.ts) | ✅ UI Zod 검증 ↔ engine `parse_cast_leaf` lockstep |
| R7 | JSON 바디 편집기(`Inspector.tsx`)는 캐스트 문법(`:num`/`:bool`/`:str`/`:json`, flow+env 토큰, "따옴표 안 standalone 값만") 안내 `<HelpTip>`을 노출하고, 본문은 `ko.glossary` 단일 소스에서 온다. | RTL: JSON kind 선택 시 ⓘ 버튼 + popover 텍스트(예시 포함) 단언; ⓘ가 heading/label accname 비오염 | |
| R8 | 캐스트 없는 leaf·리터럴·기존 flow 캐스트(`{{x:num}}` 등)는 **출력 byte-identical**이고 proto/controller/worker/migration/`Body::Json` 모델·UI 모델/스키마/store는 **무변경**. (예외: env-토큰 *거부*를 단언하던 기존 테스트 2건은 의도적으로 뒤집힘 — §4.1·§4.4.) | 기존 `cast.rs`/`executor.rs`/`cast.test.ts` 테스트(거부-단언 2건 갱신 제외) green; engine no-cast round-trip 보존 | |
| R9 | `:json`은 leaf **하나**를 파싱된 단일 JSON 값으로 치환할 뿐 형제 키로 새는 문자열 주입이 **구조적으로 불가능**하다(파싱 후 serde 재직렬화). | security-reviewer APPROVE + `:json` 주입이 형제 leaf 불변 단언 테스트 | |
| R10 | ADR-0029 §범위/§결과를 개정해 env/시스템 토큰 캐스트·`:json`·변수 기반 null을 "구현"으로 이동(루트 CLAUDE.md ADR 인덱스 한 줄은 불변 — 본문만). | ADR 파일 diff | |

- **`seam?`** = R6만 계약 경계(UI 검증 ↔ 엔진 파서). 엔진(R1–R5)이 권위이고 UI(R6)가 *더 엄격하거나 동일*하게 미러 — 위험 방향(UI 통과·엔진 실패)은 없음(ADR-0029 기존 비대칭 노트와 동일). plan은 엔진 task를 먼저, UI 검증을 lockstep으로 배치.

---

## 3. 핵심 통찰 (설계 근거)

1. **executor는 이미 cast-타입·토큰-군 무관** — `render_json_value`/`render_json_collecting`은 `parse_cast_leaf`가 준 `bare` 토큰을 기존 `render`/`render_collecting`에 넘길 뿐이다. `render`는 `{{flow}}`와 `${env/sys}`(vu_id·iter_id·loop_index·env·`${VAR:-default}`)를 **이미** 처리한다(`template.rs`). 따라서 env 토큰 캐스트는 `parse_cast_leaf`가 `${name}`을 bare로 재구성하기만 하면 executor·`render` **무변경**으로 동작한다(R1). `:json`은 새 `Cast` 변형 1개 + executor 두 경로에 arm 1개씩 추가(R2, num/bool 미러).
2. **`:-default` 비충돌은 대부분 "대시를 키워드에서 떼지 않음"으로 자동 보장(R3)** — `${PORT:-8080}`을 마지막 `:` 기준 분리하면 키워드 후보가 `-8080`(대시 포함)이 되어 str/num/bool/json 어디에도 안 맞는다. 즉 캐스트 감지가 *추가 분기 없이* 평범한 기본값 토큰을 자연 통과시킨다(기존 flow 코드의 `kw.trim()`+match 그대로, 대시 strip 금지). **단 절대적이진 않다**: `rsplit_once(':')`는 *마지막* 콜론에서 자르므로 default가 `:keyword`로 끝나면(`${FOO:-bar:num}`) 마지막 `:num`이 캐스트로 해석돼 bare `${FOO:-bar}`+Num이 된다. 이는 병리적이고(default 값에 의도적으로 `:num`을 둠) **UI `trailingCast`도 동일하게 캐스트로 보므로 seam 어긋남이 없다**(엔진=UI 같은 판정) — 핀 테스트로 *문서화*하고 받아들인다(별도 처리 안 함). `template.rs:128`의 `find(":-")` 기반 default 파싱은 무변경.
3. **`:json` 하나가 "JSON 주입"과 "변수 기반 null"을 동시에 충족(R2,R5)** — `from_str`는 객체/배열/숫자/불리언/문자열/null 전부를 파싱하므로, 변수 값이 리터럴 `null`이면 JSON `null`이 된다. 별도 `:null` 키워드는 불필요(YAGNI). 엄격(empty/unbound→실패)은 `:num`/`:bool`과 일관 — "빈데→null" 같은 암묵 변환은 의도를 흐려 거부(사용자 승인).
4. **`:json`은 구조적으로 안전(R9)** — ADR-0029가 거부한 *raw-text 캐스트*(문자열 연결로 JSON 구조 주입 가능)와 달리, `:json`은 **순수 단일 토큰 leaf**에서만 발동해 그 leaf 하나를 파싱된 *한 개의* `Value`로 치환한다. 형제 키·구조로 새어나갈 수 없다(파싱→serde 재직렬화). 데이터셋·env 값이 객체/배열을 결정하는 것은 이 기능의 *의도된* 권능이며, 부하 도구에서 그 입력은 사용자가 작성/통제한다.
5. **display resolver 무영향** — `ui/src/scenario/template.ts`(resolveForDisplay)에는 캐스트 처리가 0이다(grep 확인). 캐스트는 JSON leaf 레벨(엔진)에서만 의미가 있고 test-run 본문 표시는 엔진 trace를 그대로 렌더하므로, 새 토큰/문법을 추가해도 UI display resolver는 **건드릴 필요가 없다**(ADR-0029와 동일 — `template.rs` 무변경, 캐스트는 leaf 레벨).

---

## 4. 변경 상세

### 4.1 `crates/engine/src/cast.rs` — 충족 R: R1, R2, R3, R5
- `enum Cast`에 `Json` 추가.
- `parse_cast_leaf(s)`: 현재 `{{`…`}}`만 벗기는 것을 **`${`…`}`도** 처리하도록 일반화(trim 후 `{{`로 시작하면 flow 경로, `${`면 env 경로). 토큰 종류를 기억해 bare를 `{{name}}` 또는 `${name}`로 재구성. 캐스트 키워드 매칭에 `"json" => Cast::Json` 추가. **대시 strip 금지**(R3 — `${VAR:-default}` 자연 통과).
- **flow 경로 단일-토큰 가드는 현행 그대로**(`inner.contains("{{")||inner.contains("}}")`) — flow 출력 byte-identical 보존(R8). **env 경로엔 신규 가드**: inner에 내부 토큰 마커(`{`/`}`/`$`)가 있으면 `None`(예: `${a}${b}`·`${a}-${b}` 다중 토큰 거부). 두 경로의 가드를 분리해 flow 회귀 0.
- `coerce_json(v: &str) -> Option<serde_json::Value>` = `serde_json::from_str(v).ok()`(모든 JSON 값 허용; `coerce_num`/`coerce_bool`과 같은 시그니처).
- 단위 테스트: env 토큰 num/bool/str/json·`${vu_id:num}`·`${PORT:-8080}`=None·`${PORT:-num}`=None·**`${FOO:-bar:num}`=Some(("${FOO:-bar}",Num))**(R3 경계 핀)·`${a}${b}`=None(다중)·`coerce_json` 6케이스(object/array/num/bool/null/실패).
- **의도된 테스트 변경**: 기존 `parse_rejects_non_cast`의 `assert_eq!(parse_cast_leaf("${X:num}"), None)` 단언은 이제 `Some(("${X}".into(), Cast::Num))`로 이동한다(R8의 "기존 테스트 green" 예외 — 이건 *출력 변경*이 아니라 의도된 *기능*이다).

### 4.2 `crates/engine/src/error.rs` — 충족 R: R2, R4
- 변경 없음(기존 `CastFailed { var, cast: &'static str, value }` 재사용; `:json` 실패 시 `cast: "json"`).

### 4.3 `crates/engine/src/executor.rs` — 충족 R: R2, R4, R5
- `render_json_value`(strict): `Some((bare, Cast::Json)) => { let r = render(&bare, ctx)?; coerce_json(&r).ok_or(EngineError::CastFailed{var:bare, cast:"json", value:r})? }` arm 추가(num/base 미러).
- `render_json_collecting`(trace): `Some((bare, Cast::Json)) => { let r = render_collecting(&bare, ctx, unbound); coerce_json(&r).unwrap_or(Value::String(r)) }` arm 추가(best-effort).
- 기존 num/bool/str arm·None arm·재귀(array/object)·`render`/`render_collecting` 시그니처는 **무변경**(env 토큰은 bare 재구성만으로 흐른다).
- 테스트: `${PORT:num}` env로 number·`${vu_id:num}` 시스템 토큰·`{{x:json}}` object/null·strict 실패=`CastFailed`/trace 동일 입력=문자열 폴백.

### 4.4 `ui/src/scenario/cast.ts` — 충족 R: R6
- `CAST_KEYWORDS`에 `"json"` 추가.
- `checkLeaf`의 `${env}` 분기(현재 유효 캐스트도 "not supported yet"로 거부)를 **flow 분기와 동일 로직으로 통일**: `PURE_ENV` 정규식으로 standalone 판정 → 미지원 키워드 = "unknown cast", 유효 키워드+non-standalone = "standalone only", 유효+standalone = 무에러. `trailingCast`(콜론 뒤 공백 허용·`:-` 제외)는 재사용(엔진 `kw.trim()`+대시-비-strip과 lockstep).
- 테스트(`cast.test.ts`): `${COUNT:num}`/`${x:json}` 통과, `${x:int}` unknown, `"a ${x:num} b"` standalone-only, `${PORT:-8080}` 통과(기본값 무에러), `{{x:json}}` 통과.
- **의도된 테스트 변경**: 기존 `flags an env/system token cast (flow-only in v1)` 테스트(`${COUNT:num}`이 "not supported yet" 에러를 내길 단언)는 *무에러*로 뒤집고, `${x:int}`(미지원 키워드)가 "unknown cast"를 내는 테스트로 대체(R8 예외 — 의도된 기능).

### 4.5 `ui/src/i18n/ko.ts` — 충족 R: R7
- `glossary`에 **plain string 키**로 캐스트 안내 추가 — 멀티라인은 `VarCheatSheet` 선례대로 **여러 string 키**(예: `jsonCastIntro`/`jsonCastNum`/`jsonCastJson`/`jsonCastRule`)를 컴포넌트가 `<span className="block">` 줄로 조립한다(**JSX를 ko.ts 값에 넣지 않는다** — 기존 glossary는 전부 string, ADR-0035). 내용: "JSON 값에 변수를 넣을 땐 따옴표 안에 캐스트를 붙입니다" + `:num`/`:bool`/`:str`/`:json` 예시 + flow `{{}}`·env `${}` 둘 다 가능 + "따옴표 안 standalone 값만" + **"`:json`은 *유효한 JSON*이어야 합니다(객체/배열/숫자/불리언/null·따옴표 친 문자열) — 평범한 문자열은 `:str`"**(reviewer 지적: bare word는 `CastFailed`).

### 4.6 `ui/src/components/scenario/Inspector.tsx` — 충족 R: R7
- **HelpTip 앵커는 `JsonBodyField`로 고정**(kind-gated — R7 "JSON kind 선택 시"를 보장; `bodyLabel`은 kind 무관 항상 렌더라 none/form/raw에도 ⓘ가 새어 RTL "kind=form엔 ⓘ 없음" 단언이 깨진다 — reviewer 지적). `JsonBodyField` 내부 상단(textarea 위)에 `<HelpTip label={…}> … </HelpTip>` 추가, children은 `ko.glossary` string 키들을 `<span className="block">` 줄로 조립(`VarCheatSheet` 패턴).
- accname: `JsonBodyField`는 `<h3>`/`<legend>`/`<label htmlFor>`가 아닌 일반 컨테이너라 U3 accname 오염 비대상이고, Inspector는 `<aside>`(Modal 아님)라 HelpTip ESC-레이어링 함정 무관(`VarCheatSheet`가 이미 같은 위치에서 HelpTip 사용).
- `HelpTip` 컴포넌트 자체는 무변경.

### 4.7 `docs/adr/0029-json-body-type-cast-injection.md` — 충족 R: R10
- §범위: env/시스템 토큰 캐스트·`:json`·변수 기반 null을 "연기" 목록에서 제거하고 "구현" 범위로 이동. 잔여 연기 = form/raw/URL 캐스트·nullable 규칙.
- §결과: `:json`의 구조적 안전성(단일 leaf 치환) 한 줄 추가.

---

## 5. 무변경 / 불변식 (명시)

- **proto / controller / worker / migration**: 무변경(캐스트는 엔진 leaf 레벨, 와이어 스키마 무관).
- **`Body::Json` 모델 / serde**: 무변경.
- **UI 모델(`scenario/model.ts`) / Zod 스키마 / Zustand store / yamlDoc**: 무변경(`cast.ts`는 `BodyModel.superRefine`이 이미 호출 중 — 검증 *내용*만 확장, 배선 무변경).
- **UI display resolver(`template.ts::resolveForDisplay`)**: 무변경(§3-5).
- **`template.rs`(`render`/`render_collecting`/`render_lenient`)**: 무변경(env/시스템 토큰 해석 기존 그대로).
- **byte-identical**: 캐스트 없는 leaf, 기존 flow `:num`/`:bool`/`:str` 출력, `${VAR:-default}` 렌더는 모두 변화 없음(R8, R3).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `cast.rs` 단위 — env 토큰 cast 파싱 | |
| R2 | `cast.rs` 단위 — `coerce_json` 6케이스 + Cast::Json | |
| R3 | `cast.rs` 단위 — `${PORT:-8080}`=None + executor 렌더 default | |
| R4 | `executor.rs` 단위 — strict `CastFailed` vs trace 문자열 폴백(env·json) | |
| R5 | `executor.rs`/`cast.rs` 단위 — `:json` "null"→Null, ""→CastFailed | |
| R6 | `cast.test.ts` — env 캐스트 통과/거부 매트릭스 + json | |
| R7 | `Inspector.test.tsx` — JSON kind에서 HelpTip 노출 + accname 비오염 | |
| R8 | 기존 engine/UI 테스트 전부 green(회귀 0) | |
| R9 | `:json` 형제 leaf 불변 단위 테스트 + security-reviewer | |
| R10 | ADR diff 리뷰 | |

- **라이브 검증**: 엔진 렌더 경로만 바뀌고 run 생성/리포트 파싱 스키마·UI 모델은 무변경이라 **S-D급 라이브 필수는 아님**(cargo 단위 테스트가 엔진 캐스트를, vitest가 UI 검증을 커버). 와이어 바이트 확인이 필요하면 — **경로마다 재빌드할 바이너리가 다르다**:
  - **happy-path(number/object/null)** → `POST /api/test-runs`. 이 엔드포인트는 컨트롤러가 `trace_scenario`를 **in-process**로 돈다(`api/test_runs.rs:57` — 워커 subprocess **미사용**). 따라서 **컨트롤러를 fresh로** 띄워야(새 `cargo run -p handicap-controller --bin controller`/`cargo build`가 엔진 lib relink) 새 캐스트가 반영됨 — **워커 재빌드 불요**. 반환 trace의 `steps[].request.body`에서 `{"k":"${PORT:num}"}`·`{"o":"{{obj:json}}"}`·`{"n":"{{x:json}}"}`(x="null")가 number/object/null로 렌더됐는지 확인(echo 타깃 불요). **주의: test-run은 trace 경로(`render_json_collecting`, lenient)라 coerce 실패=문자열 폴백 — strict `CastFailed`는 여기서 안 보인다.**
  - **strict 실패(`CastFailed`)** → 실제 `POST /api/runs`가 부하 경로(`render_json_value`)를 타며 잘못된 캐스트(`{"a":"{{x:num}}"}`+x="abc")는 run을 실패시킨다. 이 경로는 **`target/debug/worker`를 spawn**하므로 먼저 `cargo build -p handicap-worker --bin worker`(엔진 변경 트랩 — 이 경로에만 해당).
  - **HelpTip 노출** → `/scenarios/new` 클라이언트-only Playwright 1회(백엔드 불요).

---

## 7. 의도적 연기 (roadmap §A/B 캐스트 항목에 누적)

- **form / 쿼리스트링 / raw 바디 캐스트**: 와이어가 전부 문자열(number 타입 없음)이라 `:num`을 붙여도 전송 바이트가 동일 → 검증-only 가치뿐. 별도 슬라이스로도 우선순위 낮음(사용자 합의).
- **empty/unbound → null (nullable 규칙)**: `:json`은 엄격 유지. "선택적 필드가 비면 null" 같은 편의는 별도 nullable 캐스트(`:json?` 등) 설계가 필요 — 이번 범위 밖.
- **`${ENV}` 캐스트의 mixed-leaf**(`"x ${a:num} y"`): flow와 동일하게 엔진은 `UnknownVar`, UI가 "standalone only"로 사전 차단(R6) — 새 동작 아님(기존 비대칭 유지).

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트. 엔진(R1–R5)을 먼저 green fold, 그다음 UI 검증(R6), 그다음 발견성(R7), 마지막 ADR(R10). 테스트-우선(tdd-guard: UI는 test 파일 먼저 — ui/CLAUDE.md).

1. **엔진 캐스트 확장**(R1–R5): `cast.rs`(`Cast::Json`·`coerce_json`·env 토큰 파싱·`:-` 비충돌) + `executor.rs` 두 경로 arm + 단위 테스트. 한 커밋(헬퍼+소비처+테스트 green fold). **tdd-guard**: 첫 `cast.rs` production 편집 전 인라인 `#[cfg(test)]` 테스트(작성 중이라도)가 pending이어야 차단을 안 받는다 — 테스트부터 적고 src 편집.
2. **UI 검증 확장**(R6): `cast.test.ts` RED 먼저 → `cast.ts` env 분기 통일 + `"json"`. 한 커밋.
3. **발견성 HelpTip**(R7): `Inspector.test.tsx` RED 먼저 → `ko.ts` glossary + `Inspector.tsx` HelpTip. 한 커밋.
4. **ADR 개정**(R10): docs-only(fast-path 커밋).
