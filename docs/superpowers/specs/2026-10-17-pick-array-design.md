# 선택 배열 생성 변수 (pick-array) — 설계

- 날짜: 2026-10-17 · 유형: **user-path** · 워크트리: `genvar-array` (브랜치 `worktree-genvar-array`)
- **목업(구현 참조본)**: `docs/superpowers/mockups/2026-10-17-pick-array-mockup.html` — 패널 행·팝업 배치·문구·상호작용(텍스트↔칸 동기화·draft→적용)의 기준. 구현이 목업과 다르면 이 spec의 명시 규칙이 우선하고, spec이 침묵하는 시각·상호작용 디테일은 목업을 따른다. **목업의 JS 로직은 복사 금지** — 목업 파서는 빈 항목을 건너뛰고(§4.3은 거부) 길이 규칙을 `change` 이벤트에 걸었다(§6.3 커밋 경계 규칙이 권위). 목업은 시각·흐름 참조일 뿐이다.
- 선행: dynamic-vars(`2026-07-24-dynamic-vars-design.md`, 생성 변수 4종)·genvar-preview-ux(`2026-07-24-genvar-preview-ux-design.md`, 결정적 미리보기)·json-cast-extend(`:json` 캐스트)
- 관련 ADR: 0003(양방향 sync)·0014(변수 표기)·0029(JSON 캐스트)·0035(한국어 카피)

## 사용자 스토리 (US)

- **US1**: QA가 체크박스·좌석 선택처럼 요청 바디에 `[true,false,…]` 배열이 들어가는 API를 부하 테스트할 때, 지금은 고정 배열을 바디에 하드코딩하거나 데이터셋 파일을 따로 만들어야 한다 — 성공하면 `flags`를 선택 배열(길이, 선택 개수 최소~최대)로 선언하고 바디에 `"flags": "{{flags:json}}"`을 쓰면, 에코 서버 와이어와 test-run trace에서 반복마다 다른 진짜 JSON 배열이 나가고 선택 개수가 항상 범위 안임을 본다.
- **US2**: QA가 특정 자리(품절 좌석·비활성 옵션)는 절대 선택되면 안 되는 상황에서 — 성공하면 선택될 수 있는 자리를 `1-5, 8`처럼 쓰거나 칸을 클릭해 지정하면, 다반복 와이어에서 선택 값이 그 자리에만 나타나고 나머지 자리는 항상 나머지 자리 값임을 본다.
- **US3**: QA의 대상 서버가 `true/false` 대신 `1/0`·`"Y"/"N"`·`"True"/"False"`(또는 그 밖의 JSON 스칼라 — 직접 입력, `null` 포함)를 요구할 때 — 성공하면 값 형식을 바꾸면 와이어에 `[0,1,0,…]`·`["N","Y",…]`가 나가고, 숫자는 숫자 타입·문자열은 문자열 타입·`null`은 `null`로 나간다(미리보기와 와이어가 일치).
- **US4**: QA가 기본 210px 변수 패널에서 길이 1000짜리 배열을 다뤄도 — 성공하면 패널 행은 요약 한 줄·예시 한 줄로 넘치지 않고, 편집 팝업에선 텍스트 입력과 칸 그리드가 항상 같은 상태로 보이며, 적용 전엔 시나리오 YAML이 바뀌지 않고, 잘못된 설정(후보 0개·최소>최대·최소>후보 수)은 적용 자체가 막힌다.
- **US5**: QA가 바디에 `"{{flags:json}}"`을 먼저 쓰고 변수 선언을 나중에 할 때 — 성공하면 미정의 변수 행의 "배열로 추가"로 팝업을 열어 바로 선택 배열로 선언할 수 있고, 취소하면 아무것도 선언되지 않는다.

(YAML↔GUI 양방향 왕복 보존은 US1~3의 수용 기준 — ADR-0003 불변식.)

## 1. 문제

생성 변수 4종(date·random_int·uuid·random_string)은 모두 스칼라 문자열을 만든다. 배열 값이 필요한 바디 필드는 고정 리터럴 하드코딩이나 데이터셋 우회뿐이라, "N칸 중 k개를 특정 자리에서만 랜덤 선택"하는 실사용 패턴(체크박스·좌석·옵션 플래그)을 부하 테스트에서 반복마다 바꿔 보낼 수 없다.

## 2. 목표 / 비목표

**목표**: 5번째 생성기 `pick_array` — 길이 N 배열에서 후보 자리 중 k개(최소~최대)를 반복마다 랜덤 선택해 선택 자리엔 `pick` 값, 나머지엔 `rest` 값을 넣은 **JSON 배열 문자열**을 만든다. 사용은 기존 `"{{var:json}}"` 캐스트(새 캐스트 키워드 없음). 편집은 변수 패널의 팝업.

**비목표(v1)**: 원소별 생성기 배열(랜덤 정수 × N 등) · 자리별 "항상 선택" 3상태 · 길이 1000 초과 · 기존 정적 `""` 변수가 `:json`으로 쓰일 때의 신뢰도 경고(선재 갭 — 별도) · `:arr` 같은 새 캐스트 · 시드 재현성(dynamic-vars와 동일하게 엔트로피).

**plan 구조 가이드**: 엔진(모델·게이트·평가 — US1~3은 YAML/curl/에코로 검증 가능)과 UI(모델·순수 함수·팝업·패널·배열로 추가)를 독립 green 단위로 나눈다. 순수 함수(범위 파서/포매터·값 리터럴 파서)는 컴포넌트보다 먼저 별 task.

## 3. 문구 (모든 사용자 노출 문구는 `ko.ts` 경유 — ADR-0035)

**값이 불리언이어야 한다는 인상을 주는 문구 금지**(사용자 지시). 사용자 노출 문구에 "true 개수"·"true 자리"·"불리언 배열" 같은 표현을 쓰지 않는다(값 형식 프리셋의 `true / false` 라벨·예시 값 자체는 예외).

| 위치 | 문구 |
|---|---|
| 타입 배지·타입 select 옵션 | `선택 배열` |
| 팝업 섹션 | `크기` / `선택될 수 있는 자리` / `값 형식: {pick} / {rest}`(접힘 토글) / `미리보기 (반복마다 새로 뽑힘)` |
| 필드 라벨 | `배열 길이 (1~1000)` / `선택 개수 최소` / `선택 개수 최대` / (직접 입력 시) `선택 자리 값` · `나머지 자리 값` |
| 패널 요약 | `{N}칸 · {min}~{max}개 선택 · 후보 {c}자리` — min=max면 `{k}개 선택`, 전체 자리면 `전체 자리`, 값이 기본(true/false)이 아니면 ` · {pick}/{rest}` 접미(각 값은 `formatValueLiteral` 표기 — `"1"/"0"`과 `1/0` 구분) |
| 사용 안내 | `JSON 바디에서 "{{name:json}}" 로 쓰면 배열로 들어갑니다.` |
| 미정의 행 버튼 | `배열로 추가` (기존 `선언 추가` 옆) |

정확한 오류/경고 문구는 plan이 `ko.ts` 키로 확정한다(목업 문구가 출발점).

## 4. 모델·와이어 (엔진 `crates/engine/src/genvars.rs`)

```yaml
variables:
  flags:
    gen: pick_array
    length: 30                  # 필수, 1~1000
    min: 2                      # 필수, 선택 개수 최소 (≥0)
    max: 3                      # 필수, 선택 개수 최대
    positions: "1-5, 8, 12-20"  # 선택, 1부터. 생략 = 전체 자리
    pick: true                  # 선택, 선택 자리 값. 생략 = true
    rest: false                 # 선택, 나머지 자리 값. 생략 = false
```

### 4.1 serde — 기존 단일 메커니즘(wire-struct + `TryFrom`) 확장

- `GenSpec`에 `PickArray(PickArrayGen)` 변형 추가. `PickArrayGen { length: u32, min: u32, max: u32, positions: Option<String>, pick: Option<serde_json::Value>, rest: Option<serde_json::Value>, pub(crate) candidates: Vec<u32> }` — `candidates`는 파싱 결과(1-based, 오름차순, 중복 제거). `serde_json::Value`는 `Eq`를 구현하므로(`Cargo.lock`이 고정한 serde_json 1.0.150 `src/value/mod.rs:115` `#[derive(Clone, Eq, PartialEq, Hash)]`) 기존 `GenSpec`의 `PartialEq, Eq` derive 유지 가능.
- `GenSpecWire`에 `positions: Option<String>`, `pick: Option<serde_json::Value>`, `rest: Option<serde_json::Value>` 필드 추가. `length`/`min`/`max`는 기존 필드 재사용(`length: Option<u32>`·`min/max: Option<i64>` → 검증 후 `u32`로 변환; §4.2의 `max ≤ length ≤ 1000`이 변환 안전을 보장).
- **부재 vs 명시 `null` 구분 (필수)**: serde_yaml 0.9의 `deserialize_option`은 평문 `null`/`~`/빈 값을 `visit_none`으로 보낸다(`serde_yaml-0.9.34/src/de.rs:1546,1554-1559`) — `#[serde(default)] Option<Value>`만으로는 `rest: null`이 `None`(=기본 `false`)이 되어 **미리보기는 null인데 와이어는 false**가 된다. `pick`/`rest`에 `#[serde(default, deserialize_with = "present_value")]` 헬퍼를 단다 — 먼저 `serde_yaml::Value`로 받아 **스칼라만** 수동 변환한다(`Null`→`Value::Null`·`Bool`·`String`·`Number`; 시퀀스/맵/태그는 에러). `Number`가 `f64`이고 비유한(`.inf`/`.nan`)이면 **변환 전에 에러** — `Value::deserialize(d).map(Some)`이나 `serde_json::to_value`를 거치면 비유한 수가 조용히 `Null`이 되므로(`serde_json-1.0.150/src/value/de.rs:69-71`) 그 경로는 금지. 결과는 존재하면 항상 `Some(v)`(`null`은 `Some(Value::Null)`). 평가 테스트로 `rest: null` → 출력 배열에 `null` 단언(round-trip만으로는 공허 — None↔None도 통과).
- **`positions`의 스칼라 형태 (plan 리뷰 개정)**: 엔진은 `present_positions` 헬퍼로 `serde_yaml::Value`를 받아 **문자열 또는 0 이상 정수**(→ 10진 문자열)만 수용하고 `null`·빈 값·실수·음수·컬렉션은 거부한다(기본 `Option<String>` 경로는 `positions: null`을 None=전체로 조용히 받아 Zod와 갈렸다). UI Zod는 `z.union([z.string(), z.number().int().min(0)]).transform(String)` — `8`·`0x8`·`+5`가 양쪽 모두 `"8"`/`"5"`로 일치. **남은 문서화된 예외**: `1e3`은 yaml 패키지가 정수 1000으로, serde_yaml은 실수로 읽어 UI 수용·엔진 거부(저장 시 가시적 400 — 벡터 `known_divergence` 1건). positions 항목 trim은 양쪽 모두 **ASCII 공백만**(JS `trim()`·Rust `trim()`의 유니코드 공백 집합 차이 제거).
- **per-gen allow-list 갱신 필수 (회귀 함정)**: 기존 4종의 `deny(...)` 조건에 새 필드 3개(`positions`/`pick`/`rest`)를 **추가**해야 한다 — 안 하면 `{gen: uuid, pick: 1}`이 조용히 통과한다(현재 allow-list는 필드를 명시 열거). `pick_array`는 `format`/`offset`/`tz`/`step`을 거부.
- **Serialize 방출 규칙**: `gen`, `length`, `min`, `max` 항상 · `positions`/`pick`/`rest`는 `Some`일 때만(원문 그대로 — 엔진은 정규화하지 않는다). 순서 = 위 YAML 예시 순서.
- `pick`/`rest`의 YAML 해석은 serde_yaml 규칙 그대로: 따옴표 없는 `True`/`TRUE`/`true`는 **불리언**(serde_yaml-0.9 `de.rs:932` `parse_bool`), `"True"`는 문자열, `1`은 숫자, `"1"`은 문자열. 따라서 문자열 프리셋(`"True"`/`"Y"`/`"1"` 등)은 **UI yamlDoc 방출과 엔진 Serialize 양쪽에서 따옴표로 보존**되어야 한다(§9 테스트 필수).

### 4.2 검증 (파싱 시 거부 → 시나리오 저장 400·test-run 422, 기존 경로)

| 규칙 | 거부 예 |
|---|---|
| `length` 필수, `1 ≤ length ≤ 1000` | 누락·0·1001 |
| `min`·`max` 필수, `0 ≤ min ≤ max ≤ length` | 누락·음수·`min > max`·`max > length` |
| `positions` 문자열 길이 ≤ 4096 | 4097자 |
| `positions`(있으면) 범위 문법(§4.3) + 모든 자리 `1..=length` | `"0"`·`"31"`(length 30)·`"5-3"`·`"a"`·`""`·`"1,,2"` |
| 후보 수 ≥ 1 그리고 `min ≤ 후보 수` | positions 결과 0개 · `min: 5` + 후보 3 |
| `pick`/`rest`는 JSON 스칼라(bool·**유한** number·string·null) | 시퀀스·맵·`.inf`/`.nan`(serde_json이 비유한 수를 조용히 `Null`로 바꾸므로 — `serde_json-1.0.150/src/value/de.rs:69-71` — 원 YAML 스칼라 단계에서 거부) |
| 다른 생성기 키 혼입 | `{gen: pick_array, …, format: x}` |

- `max > 후보 수`는 **허용**(평가 시 후보 수로 상한 — UI는 경고). `max > length`는 거부(위 표).
- 오류 문구는 값-free·고정 형식(기존 `"min({min}) > max({max})"` 수준 — 사용자 입력 숫자는 포함 가능, 임의 문자열은 원문 전체 대신 문제 토큰만).

### 4.3 자리 범위 문법 (엔진 ↔ UI lockstep — 같은 테스트 벡터를 양쪽에)

- 쉼표로 항목 분리 → 각 항목 앞뒤 공백 trim → `N` 또는 `N-M`(하이픈 주변 공백 허용), `N`/`M`은 ASCII 숫자 1~4자리. **빈 항목(`"1,,2"`·후행 쉼표 `"1,"`)은 문법 오류로 거부.** 빈 문자열/공백만은 문법상 **빈 집합**이고 §4.2 "후보 수 ≥ 1" 규칙으로 거부된다(UI는 이 둘을 구분해 칸 그리드 동작을 정한다 — §6.3).
- `N ≥ 1`, `M ≤ length`, `N ≤ M`. 중복·겹침(`"1-5, 3-8"`)은 허용(합집합). 전개는 길이 `length`의 고정 bitmap에 표시(집합 자료구조 불요) — 문자열 ≤ 4096자 ⇒ 항목 ≤ ~2048개 × 구간 ≤ 1000 ⇒ 최악 ~2×10⁶ 표시로 상한.
- **정규형(UI 포매터 출력)**: 오름차순·연속 구간 병합·`", "` 구분·단일 자리는 숫자만(`"1-5, 8, 12-20"`). 엔진은 정규형을 강제하지 않는다(손편집 YAML 수용).

### 4.4 평가 (반복 시드, 기존 `seed_iter_vars` 단일 헬퍼)

- `seed_iter_vars`(`genvars.rs:341`)의 `match`에 arm 추가 → 3개 부하 진입점(`runner.rs:425/1189/1556`)과 test-run(`trace.rs:255`)이 자동으로 공유. 진입점 배선 변경 0.
- 알고리즘: `hi = min(max, 후보 수)`, `lo = min`(검증으로 `lo ≤ 후보 수`·`lo ≤ max` 보장 → `lo ≤ hi`), `k = rng.gen_range(lo..=hi)`, `rand::seq::index::sample(rng, 후보 수, k)`(rand 0.8 — `seq/index.rs:222`)로 후보 인덱스 k개 → 해당 자리에 `pick`(기본 `true`), 나머지 `rest`(기본 `false`) → `serde_json::to_string(&Vec<Value>)`(공백 없는 compact).
- 런타임 무오류(infallible) — 모든 파라미터는 파싱 시 검증 완료. 산술은 `length ≤ 1000` 범위라 오버플로 없음.
- 사용: `"{{flags:json}}"` → 기존 `coerce_json`이 파싱해 배열로 삽입. `{{flags}}`(캐스트 없음)는 문자열로 나간다(기존 의미 그대로 — §3·§6.3 ④의 사용 안내가 이를 예방).

### 4.5 호환성

생성기 미사용 시나리오는 파싱·재직렬화·실행 byte-identical. proto·migration·controller src·worker src 0-diff(워커는 엔진 재컴파일만 — 옛 워커 바이너리는 새 `gen`을 못 읽는 기존 함정 그대로). template.rs·cast.rs·executor.rs 0-diff.

## 5. UI 모델·순수 함수 (`ui/src/scenario/`)

- **Zod** (`genVars.ts`): `PickArrayGenModel = z.object({ gen: z.literal("pick_array"), length: int 1..1000, min: int ≥0, max: int ≥0, positions: z.union([z.string(), z.number().int()]).transform(String).optional(), pick: JsonScalar.optional(), rest: JsonScalar.optional() }).strict()`, `JsonScalar = z.union([z.boolean(), z.number().finite(), z.string(), z.null()])`. (필드 레벨 transform은 멤버를 ZodObject로 유지하므로 discriminatedUnion과 양립 — 멤버 레벨 `.superRefine`/`.transform` 금지 규칙과 별개. 단 input≠output 타입이 되므로 `GenSpec` 소비처가 output 타입을 쓰는지 plan에서 `tsc -b`로 확인.) cross-field(min≤max≤length·positions 4096자 상한(먼저)·문법/범위·후보≥1·min≤후보)는 기존처럼 **union 레벨 `superRefine`**(멤버에 붙이면 discriminatedUnion이 거부 — `genVars.ts:31-37` 주석). 엔진 §4.2와 lockstep.
- **기존 switch 4곳 확장**: `genTypeLabel`·`canonicalGenKey`·`genParamsSummary`·`sampleFor`(+ `declSearchText`은 위 둘을 경유). TS strict가 누락 arm을 `tsc -b`에서 잡는다.
- **신규 순수 모듈 `pickArray.ts`**:
  - `parsePositions(text, length) → { ok: true, set: number[] } | { ok: false, reason }` — §4.3 규칙. 빈 문자열/공백만 → `{ ok: true, set: [] }`(후보 0은 상위 검증이 판정).
  - `formatPositions(set) → string` — §4.3 정규형.
  - `isFullRange(set, length)`.
  - `parseValueLiteral(text) → { ok: true, value: JsonScalar } | { ok: false, reason }` — 직접 입력 칸 규칙(입력은 먼저 앞뒤 공백 trim):
    - 빈 문자열 → **invalid**("값을 입력하세요").
    - `"`로 시작 → `JSON.parse`가 문자열을 돌려줘야 함, 실패하면 **invalid**("따옴표 문자열이 올바르지 않아요") — 예 `"a"b"`.
    - `true`/`false`/`null` → 그 타입.
    - JSON number 문법(`-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`) → `Number(text)`; **비유한(`1e999`→Infinity)이면 invalid**.
    - 그 밖 → trim된 원문 문자열(앞뒤 공백이 필요한 문자열은 따옴표로 표기).
  - `formatValueLiteral(v) → string` — **파서 기준 정의**: 비문자열은 `JSON.stringify(v)`(`true`/`1`/`null`), 문자열 `s`는 `parseValueLiteral(s)`가 `{ok:true, value: s}`(같은 문자열)를 돌려줄 때만 그대로, 아니면 `JSON.stringify(s)`(따옴표 표기) — `"1e999"`·`"true"`·`" a"`·`""` 같은 경우가 자동으로 따옴표가 된다. **왕복 불변식**: 모든 JsonScalar(유한 수, `-0` 제외 — `-0`은 `"0"`이 되어 `+0`으로 돌아오며 `Object.is`로 다르므로 프로퍼티 생성기에서 제외하거나 `+0`으로 정규화) `v`에 대해 `parseValueLiteral(formatValueLiteral(v))`가 `{ok:true, value: v}`.
  - `VALUE_PRESETS` = `true/false`·`"True"/"False"`·`1/0`·`"Y"/"N"` + `presetIndexOf(pick, rest)`(불일치=-1=직접 입력).
- `sampleFor`의 `pick_array` arm은 엔진과 같은 분포(k 균등·후보 균등 비복원)로 `seededRand`를 써 결정적 미리보기를 만든다(genvar-preview-ux 규약). JS 숫자 직렬화 차이(YAML `1.0` → 엔진 `1.0`, JS `1`)는 미리보기 한정 허용.
- **yamlDoc**: 기존 `setVariableGen`(`yamlDoc.ts:168`) 재사용 — spec 객체 키 순서 = §4.1 방출 순서, `positions`가 전체 범위면 **키 생략**, `pick`/`rest`가 기본(`true`/`false`)이면 키 생략. `yaml` 라이브러리가 `"True"`/`"1"` 같은 문자열을 따옴표로 방출하는지 테스트로 락인(§9).
- **`:json` 참조 스캔**: 신규 순수 함수 `jsonCastVarNames(scenario) → Set<string>` — 모든 http 스텝(중첩 loop/if/parallel 포함, `flattenHttpSteps`)의 `body.kind === "json"` 값을 재귀 walk해 **순수 단일 flow 토큰**(`cast.ts:11`의 모듈-비공개 `PURE_FLOW` 정규식과 동일 판정 — export해 재사용) + `splitFlowToken(inner).cast === "json"`인 leaf의 `base`를 모은다. env 토큰(`${…}`)은 대상 아님.

## 6. UI 컴포넌트

### 6.1 변수 패널 행 (`VariablesPanel.tsx` declared 행, 기본 폭 210px)

- **접힘**: 기존 생성기 행(`VariablesPanel.tsx:301-319`)과 동일 구조 — 배지 `선택 배열` + `genParamsSummary` + `GenSampleLine`. 추가로 요약 줄에 **`편집` 버튼**(팝업 열기). 모든 텍스트는 truncate + `title`.
- **펼침**: `GenVarEditor`의 타입 select는 유지(타입 전환 통로). `pick_array`일 때 인라인 필드 대신 **`편집…` 버튼** 하나 + `GenSampleLine`.
- **타입 전환**: 다른 타입(고정값 포함)에서 select로 `선택 배열`을 고르면 **즉시 커밋하지 않고** 기본값 draft(`length 10 · min 1 · max 3 · 전체 · true/false`)로 팝업을 연다 — 적용 시 커밋, 취소 시 원래 타입 유지(select 값도 원래대로). `선택 배열`에서 다른 타입으로의 전환은 기존처럼 즉시 커밋.
- `yamlError !== null`이면 `편집`·`편집…`·타입 select·`배열로 추가` 전부 disabled(기존 게이트 이디엄).

### 6.2 미정의 행 — `배열로 추가` (US5)

- 미정의 행(`VariablesPanel.tsx:420-450`)에서 `row.candidates.length === 0`이고(기존 `선언 추가` 노출 조건과 동일) **`jsonCastVarNames`에 그 이름이 있을 때만** `선언 추가` 옆에 `배열로 추가` 버튼.
- 클릭 → 기본값 draft로 팝업. 적용 → `setVariableGen(name, spec)`으로 선언(행이 declared로 전이). 취소/ESC/바깥 클릭 → 아무 것도 선언 안 됨.
- 기존 `선언 추가`(고정값 `""`) 동작·노출 조건은 불변.

### 6.3 편집 팝업 `PickArrayDialog` (신규, 기존 `components/Modal.tsx` 사용)

- `Modal`(`open`/`onClose`/`title` — ESC·바깥 클릭·✕가 `onClose`) 위에 구성. 제목 = 변수명. **팝업 안에 `HelpTip` 금지**(Modal capture-phase ESC가 HelpTip ESC를 먹는 기존 함정 — `ui/CLAUDE.md`).
- **상태 소유**: 팝업 상태는 `VariablesPanel`이 단일 소유 — `{ name, initial: PickArraySpec, origin: "edit" | "switch" | "declare" }`. 진입 4곳(접힘 `편집`·펼침 `편집…`·타입 select·`배열로 추가`)이 모두 이 상태를 세팅한다. `GenVarEditor`는 프레젠테이셔널 규약(`GenVarEditor.tsx:53-56`) 유지 — 신규 prop `onOpenPickArray(initial)`로만 위임. **`changeKind`의 삼항 체인은 미지 kind를 `random_string`으로 떨어뜨리므로(`GenVarEditor.tsx:81-89`) `pick_array` 분기를 명시 추가하고 테스트로 락인**(tsc는 이 누락을 못 잡는다).
- **draft 모델**: 열 때 `{ lengthText, minText, maxText, positionsText, valueMode: 0..3(프리셋) | "custom", pickText, restText }`를 `initial`에서 시드(`valueMode = presetIndexOf(pick, rest)`, -1이면 `"custom"`; 커스텀 텍스트는 `formatValueLiteral`). 팝업 내부 편집은 로컬 state만 — **YAML/store 쓰기는 `적용` 1회뿐**. `onClose`(취소·✕·ESC·바깥 클릭) = draft 폐기.
- **섹션 순서**(목업): ① 크기 — 길이·선택 개수 최소·최대 (3칸 그리드) ② 선택될 수 있는 자리 — 텍스트 입력 + 안내/오류 줄 + `[전체] [모두 끄기]` + 범례 + 칸 그리드 ③ 값 형식 — 접힘 토글(라벨에 현재 값 표시), 펼치면 프리셋 4종 radio + `직접 입력` radio(선택 시 두 칸·타입 표시 `불리언/숫자/문자열/null`) ④ 미리보기 — 줄바꿈 전체 표시(높이 상한·세로 스크롤) + `↻ 다시 뽑기` + 사용 안내 ⑤ 하단 `취소`·`적용`.
- **값 형식 초기 펼침**: 현재 값이 기본(true/false)이 아니면 펼친 채 연다. 접힘 라벨·패널 요약 접미의 값 표기는 `formatValueLiteral`(문자열 `"1"`과 숫자 `1`을 구분).
- **텍스트 ↔ 칸 동기화**: 단일 `positionsText` draft가 진실의 원천. 칸 상태 = `parsePositions(positionsText)` 결과. **문법 오류**(읽을 수 없음·범위 밖·역순·빈 항목) 동안은 칸 그리드가 직전 유효 집합을 흐리게 보여 주고 칸과 `[모두 끄기]`는 비활성, `[전체]`는 활성(오류 탈출구); 텍스트를 고쳐 문법이 유효해지면 다시 활성. **빈 문자열**은 문법 오류가 아니라 빈 집합이라 칸이 전부 꺼진 채 **활성**(→ `모두 끄기` 후 칸을 눌러 고르는 흐름이 동작)이고, 오류 줄은 "후보 0" 문구. 칸 클릭/키보드 토글 → 집합 갱신 → `formatPositions`로 텍스트 교체. `전체` → `1-{length}`, `모두 끄기` → `""`(오류 표시).
- **길이 변경 — 커밋 경계 = 길이 칸 blur 또는 Enter**(키 입력마다 아님): `onChange`는 `lengthText`만 갱신하고, 길이 규칙은 칸이 커밋될 때 **포커스 진입 시 캡처한 기준 집합·기준 길이**로 1회 적용한다 — 직전 집합이 기준 길이의 전체 범위였으면 새 `1-{length}`, 아니면 `≤ length` 자리만 남김(텍스트 재정규화). 파싱 실패 상태·무효 길이면 positions 텍스트 유지. (키마다 적용하면 30→"25" 재입력 중 "2"를 지나며 `1-5, 8, 12-20`이 `1-2`로 깎여 복구 불가 — RED 테스트로 "25" 타이핑 후 positions 보존 단언.) 커밋 경계는 **positions 깎기 규칙에만** 적용된다 — 적용 비활성 판정과 칸 그리드 칸 수는 **현재 `lengthText`**(유효하면 그 값, 무효면 마지막 유효 길이)를 쓰고, 그 판정은 positions에 **깎기 규칙을 비파괴적으로 미리 적용한 결과**(`trimPreview`)를 검증한다 — 그래서 30→25로 줄이는 중 `28`이 범위 밖 오류로 깜빡이지 않고, 적용 버튼도 mousedown 시점에 이미 올바른 활성 상태다. 그래야 무효 길이를 유효하게 고친 직후 적용을 누를 때 버튼이 mousedown 시점에 이미 활성이라 첫 클릭이 삼켜지지 않는다(그 클릭의 mousedown이 일으킨 blur가 positions 규칙을 커밋하고, click은 갱신된 draft로 적용). 무효 길이 입력은 커밋 시 positions를 건드리지 않고 "마지막 유효 길이"도 갱신하지 않는다. 적용 핸들러는 실행 직전 draft를 다시 검증한다(blur 커밋 결과로 무효가 되면 적용하지 않음).
- **적용 비활성 조건**(US4): positions 파싱 실패/후보 0/4096자 초과 · `min > max` · `max > length` · `min > 후보 수` · length 범위 밖·비정수 · min/max 비정수·음수 · (커스텀 모드) 직접 입력 값 invalid. **경고(적용 허용)**: `max > 후보 수` → "최대 {c}개까지만 선택돼요".
- **적용**: draft → spec 변환(`positions` 전체면 생략·`pick`/`rest` 기본이면 생략) → `setVariableGen` → 닫기.
- **닫힌 뒤 포커스(경로별)**: `edit`(접힘 `편집`/펼침 `편집…`)와 `switch`(타입 select)는 트리거가 살아 있으므로 적용·취소 모두 `Modal` 기본 복원(그 트리거로). `declare`의 **취소**도 트리거(`배열로 추가`)가 살아 있어 기본 복원. `declare`의 **적용**만 트리거가 행 전이로 사라지므로 새 declared 행의 `편집` 버튼으로 이동 — var-delete-confirm의 "확정 경로만 1회성 ref 플래그" 이디엄(양-경로 공통 effect 금지).
- **칸 그리드 a11y·레이아웃**: `role="group"` + `aria-label`, 각 칸 `<button aria-pressed aria-label="{i}번 자리">`. **roving tabindex** — 그리드 전체가 Tab 정지 1개(1000칸 = 1000 탭 정지 방지), ←/→/↑/↓·Home/End 이동(keydown 처리). 토글은 **네이티브 `<button>` 활성화(Space/Enter→click)에 맡긴다** — keydown에서 Space/Enter를 또 처리하면 이중 토글. 범위: Shift+클릭은 click 핸들러의 `shiftKey`로, Shift+Space는 keydown에서 처리 + `preventDefault`(네이티브 click 억제) — 둘 다 직전 토글 자리부터 범위. 칸은 고정 최소폭 `auto-fill` 그리드로 줄바꿈, 그리드 높이 상한 + `overflow-y-auto`·`overflow-x-hidden`. 팝업 폭은 `Modal`의 `max-w-3xl` 그대로(가로 성장 없음).

## 7. 보안·범위 노트

- 생성 값은 비밀이 아니다. 새 sink 없음(값은 기존 iter_vars → 렌더 경로). diff가 `genvars.rs`(시나리오 파싱 게이트)를 건드리므로 `finish-slice §0` grep 결과에 따라 `security-reviewer` 판단. 파싱 비용 상한 = §4.3의 `positions` 4096자 상한 × bitmap 전개(최악 ~2×10⁶ 표시) — 숫자 자릿수 제한만으로는 상한이 아니다(항목 반복으로 무한 확장 가능했음). UI Zod `superRefine`도 같은 상한을 먼저 검사해 모델 재파싱마다의 비용을 묶는다.
- 생성기 Zod `superRefine` 오류 문구(예: `min > max`)의 한국어 매핑(`problems.ts`)은 기존 생성기들도 미매핑인 선재 갭 — 이 슬라이스 범위 밖(팝업이 무효 설정의 적용을 막으므로 GUI 경로에선 도달하지 않고 YAML 손편집만 영어 문구).
- 오류 문구에 사용자 입력 원문 전체를 싣지 않는다(§4.2).

## 8. 수용 기준 요약 (US ↔ 검증)

| US | 증거 |
|---|---|
| US1 | 에코 서버 run: 와이어 바디의 `flags`가 JSON 배열·길이 N·선택 개수 ∈ [min, max]·반복 간 상이 / test-run trace 동일 |
| US2 | 다반복 와이어: 선택 값 위치 ⊆ 후보 자리 (pick ≠ rest인 값으로 — 같으면 단언이 공허) |
| US3 | `1/0` → 숫자 배열, `"Y"/"N"`·`"True"/"False"` → 문자열 배열 (와이어 JSON 타입) + 저장 YAML 따옴표 보존 |
| US4 | 210px 패널에서 길이 1000: 행의 모든 텍스트 요소 `scrollWidth`가 잘림(truncate)으로 처리되고 행 박스가 열 폭 초과 없음(`getBoundingClientRect().right ≤ 열.right`) · 팝업 그리드 `scrollHeight > clientHeight`(세로 스크롤)·`scrollWidth ≤ clientWidth`(가로 없음) · 팝업 편집 중·취소 후 store `yamlText` 불변 + 저장 dirty 표시 없음(서버 YAML은 저장 없이 원래 안 바뀌므로 증거 아님) · 무효 설정에서 적용 disabled |
| US5 | `"{{seats:json}}"` 바디 → 미정의 행에 `배열로 추가` 존재(`:json` 없는 미정의 변수엔 부재) → 적용 시 declared 전이 / 취소 시 미정의 유지 |

라이브 검증은 에디터 두 진입 화면(`/scenarios/new`·`/scenarios/{id}`) 모두에서([[live-verify-all-mount-paths]]).

## 9. 테스트 전략

- **공유 벡터 파일 `testdata/pick_array_vectors.json`** (주의: `testdata/`는 pre-commit의 cargo·UI 게이트 경로 패턴 밖(`.githooks/pre-commit:43,59`) — 벡터 편집은 항상 `crates/`·`ui/` 파일과 같은 커밋에 스테이징하거나 두 게이트를 수동 실행) (ADR-0030 `testdata/compare_golden.json` 선례 — vitest는 `readFileSync(path.resolve(__dirname, …))`): positions 문법 수용/거부 벡터(+기대 집합·정규형)와 생성기 YAML 수용/거부 벡터(수용: `positions: 8`·`rest: null`·`pick: "True"` / 거부: `max > length`·`.inf`·`.nan`·시퀀스 pick·4097자 positions / known_divergence: `positions: 0x8` 등 — 각 벡터에 `expect: accept|reject|known_divergence` 라벨)를 **Rust 테스트와 vitest가 같은 파일로** 돈다 — 한 방향(엔진 거부⇒Zod 거부)만 보는 테스트는 반대 방향 불일치(엔진 수용·Zod 거부)를 못 잡는다.
- **엔진**: round-trip(`from_yaml(to_yaml(x)) == x`, 문자열 `"True"`/`"1"`/`"Y"` 및 숫자 `1`·불리언·null pick/rest 포함) + **`rest: null` 평가 출력에 `null`**(round-trip만으로는 공허) + `crates/engine/tests/proptests.rs`의 `arb_var_decl`(4종 열거)에 `pick_array` 추가(serde 경로로 구성 — `candidates`가 `pub(crate)`) · §4.2 거부 매트릭스 1케이스씩 + **기존 4종에 새 키 혼입 거부**(`{gen: uuid, pick: 1}`·`{gen: date, positions: "1"}` 등) · 평가 불변식(시드 rng로 다회 평가: 길이 = N, 선택 개수 ∈ [lo, hi], 선택 위치 ⊆ 후보, 비후보 위치 = rest, pick/rest JSON 타입 보존) · `max > 후보`일 때 상한 · `min = max = 0`(전부 rest) · 범위 문법 테스트 벡터(§4.3) · trace 시드 1건(`tests/genvars_wiring.rs` 확장) · 컨트롤러 게이트 400/422 1건씩(`tests/scenario_genvars_gate_test.rs` 확장).
- **UI 순수**: `parsePositions`/`formatPositions` — §4.3 벡터(엔진과 동일 목록) + 프로퍼티(`formatPositions(parsePositions(formatPositions(S)).set) == formatPositions(S)`, numRuns 40) · `parseValueLiteral`/`formatValueLiteral` 왕복 프로퍼티 · `presetIndexOf` · `jsonCastVarNames`(중첩 loop/if/parallel·혼합 leaf 제외·env 제외·캐스트 없음 제외) · Zod lockstep은 공유 벡터 파일로 **양방향**(엔진 수용⇔Zod 수용·엔진 거부⇔Zod 거부; §4.1의 known_divergence 예외만 제외).
- **UI 컴포넌트(RTL)**: 패널 접힘 행(배지·요약·예시·편집) · `PickArrayDialog` — 텍스트↔칸 동기화 양방향 · 적용 전 store `yamlText` 불변 · 취소/ESC 후 불변 · 적용 disabled 조건 각각 · `max > 후보` 경고(적용 가능) · 길이 변경 규칙("25" 재입력 중간값에서 positions 보존) · 값 형식 프리셋/직접 입력 · roving 키보드(Tab 정지 1개·화살표·Space·Shift+Space 범위) · 타입 전환(적용/취소 시 원래 타입) + `changeKind`의 `pick_array` 분기 락인(`random_string` 낙하 회귀) · 경로별 닫힘 포커스 · `배열로 추가` 노출 조건·적용/취소 · yamlError 시 disabled · yamlDoc 왕복(`"True"` 따옴표 보존, 전체 범위 positions 생략).
- **이빨 실증 의무**: 회귀 가드를 표방하는 테스트(allow-list 새 키 거부·적용 전 YAML 불변·roving 단일 Tab 정지·따옴표 보존)는 고의 회귀→RED→원복→GREEN을 plan/brief에 명시([[plan-mandated-vacuous-tests]]).
