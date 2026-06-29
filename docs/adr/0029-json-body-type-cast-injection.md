# 0029. JSON Body 타입 캐스트 주입 (`{{var:num}}`/`{{var:bool}}`)

- 상태: 채택
- 날짜: 2026-06-03

## 맥락

Slice 8a부터 JSON body 문자열 leaf가 템플릿팅되지만 값은 항상 문자열로 나갔다
(`{"age":"{{age}}"}` → `{"age":"30"}`). 흐름 변수가 전부 `String`이라 타겟이
number/bool을 기대하면 표현 불가.

## 결정

flow `{{var}}` 토큰에 명시적 캐스트 접미사(`:num`/`:bool`, 선택적 `:str`)를 두고,
JSON 문자열 leaf가 **순수 단일 토큰일 때만** number/bool로 coerce. 파싱은 JSON leaf
레벨(`executor.rs::render_json_value` + trace twin)에서, `template.rs`는 무변경.
coerce 실패는 엄격 실패(`EngineError::CastFailed`). UI는 Zod `.superRefine`으로
잘못된 캐스트를 authoring 시점에 거부.

거절: ① 자동 형변환(leading-zero·"true" 의도치 않은 변환, 하위호환 깨짐),
② raw-text 템플릿(escape 책임 전가·JSON 주입 위험).

## 범위

v1 = flow `{{}}` + `:num`/`:bool`(+`:str`) + JSON body 한정. **확장(2026-06-29)**: 같은
캐스트를 env/시스템 토큰 `${}`에도 적용 + `:json`(값을 임의 JSON으로 파싱 → 객체/배열/
숫자/불리언/문자열/null·변수 기반 null 포함). 잔여 연기: form/raw/URL 캐스트·empty/unbound→null
같은 nullable 규칙.

## 결과

proto/controller/worker/migration/`Body::Json` 모델 무변경. 캐스트 없으면 출력
byte-identical(하위호환). 데이터바인딩(8c)과 직교 — 데이터셋 값은 여전히 문자열로
바인딩되고 캐스트가 JSON leaf에서 coerce.

`:json`은 순수 단일 토큰 leaf 하나를 파싱된 단일 JSON 값으로 치환할 뿐이라, 형제 키로 새는
문자열 주입이 구조적으로 불가능하다(파싱→serde 재직렬화). env/시스템 토큰 캐스트는
`parse_cast_leaf`가 `${name}` bare를 재구성하고 기존 `render`가 해석 — executor·`render` 무변경.
