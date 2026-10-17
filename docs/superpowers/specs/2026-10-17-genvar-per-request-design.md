# 생성 변수 "요청마다 새로 뽑기" (`refresh: request`) — 설계

- 날짜: 2026-10-17 · 유형: **user-path** · 워크트리: `pick-array-per-request` (브랜치 `worktree-pick-array-per-request`)
- **상태: 설계 중**
- 선행: dynamic-vars(`2026-07-24-dynamic-vars-design.md` — 생성 변수 4종·반복 시드, §2 비목표 "요청 위치마다 새 값(per-use)"을 이번에 해소) · genvar-preview-ux(`2026-07-24-genvar-preview-ux-design.md`) · pick-array(`2026-10-17-pick-array-design.md` — 5번째 생성기·팝업 편집기)
- 관련 ADR: 0003(양방향 sync)·0014(변수 표기)·0035(한국어 카피). 새 ADR 없음 — ADR-0014 범위 안의 additive YAML 키(`Request.disabled` B4 선례와 같은 부류).

## 사용자 스토리 (US)

- **US1**: QA가 선택 배열 변수를 쓰는 요청 스텝이 여러 개인 시나리오를 test-run 하면, 지금은 모든 스텝이 같은 배열을 보낸다 — 성공하면 변수 편집기에서 "요청마다 새로 뽑기"를 켜고 test-run trace를 볼 때 스텝마다 서로 다른 배열이 나가고, 선택 개수는 모두 범위 안에 있다.
- **US2**: QA가 loop 스텝으로 같은 요청을 N번 반복할 때, 지금은 N회 모두 같은 랜덤 값(배열·정수·UUID·문자열)이 나간다 — 성공하면 옵션을 켠 변수는 에코 서버 와이어에서 회차마다 다른 값으로 나간다.
- **US3**: QA가 주문번호 UUID는 한 반복 안에서 공유하고 배열만 요청마다 바꾸고 싶을 때 — 성공하면 두 변수를 따로 설정할 수 있다. 옵션을 안 켠 UUID는 같은 반복의 모든 스텝에서 같은 값이고, 켠 배열만 매번 바뀐다. 옵션을 안 쓴 기존 시나리오는 YAML과 동작이 그대로다.
- **US4**: QA가 요청마다 보낸 시각을 바디에 넣고 싶을 때 — 성공하면 날짜 변수에 옵션을 켜면 요청마다 그 요청 시점의 시각이 나간다.
- **US5**: 개발자가 YAML에서 `refresh: request`를 직접 쓰거나 지우면, GUI 편집기의 체크박스와 변수 요약 표시("요청마다")가 함께 바뀐다. 정적 변수에 이 키를 쓰면 저장할 때 거부된다.

(YAML↔GUI 왕복 보존은 US3·US5의 수용 기준 — ADR-0003 불변식.)

## 1. 문제

생성 변수 5종은 **반복(시나리오 1회 실행)이 시작될 때 한 번** 평가되어 그 반복 동안 고정된다 — `seed_iter_vars`(`crates/engine/src/genvars.rs:570`)를 부하 진입점 3곳(`runner.rs:425`·`:1189`·`:1556`)과 test-run 1곳(`trace.rs:255`)이 부른다(확인 명령: `grep -n "seed_iter_vars" -r crates/engine/src`). 이건 dynamic-vars가 의도한 성질("같은 반복 안의 두 스텝은 같은 값을 공유" — 주문 생성 후 같은 id로 조회)이지만, 반대로 **요청마다 달라야 하는 값**(체크박스 배열·회차별 수량·요청 시각)은 표현할 방법이 없다. 사용자가 test-run 1회에서 모든 스텝이 같은 배열을 보내는 것을 직접 관찰했다(2026-10-17).

## 2. 목표 / 비목표

**목표**: 생성 변수 선언에 선택 키 `refresh: request`를 더한다. 켠 변수는 **그 변수를 참조하는 HTTP 요청이 나가기 직전마다** 새로 평가된다. 생략(또는 `refresh: iteration`)은 지금과 같다. 5종 생성기 전부(date·random_int·uuid·random_string·pick_array)에 적용. GUI는 펼침 편집기의 체크박스 1개 + 접힘 요약의 `요청마다` 배지.

**비목표(v1)**: 한 변수를 위치마다 다르게(공유/새로) 쓰는 사용처 표기(`{{x:fresh}}` — 렌더러 3진입점·캐스트·UI resolver lockstep 비용이 커서 기각, 필요하면 변수를 2개 선언) · 시나리오 전체 스위치 · 정적 변수의 refresh · `if` 조건 평가 시점의 재평가(§4.4) · 시드 재현성(dynamic-vars와 동일하게 엔트로피).

**plan 구조 가이드**: 엔진(모델·게이트 → 평가 배선)과 UI(모델·표시 → 편집기)를 독립 green 단위로 나눈다. 엔진의 "요청이 참조하는 변수" 판정(§4.3)은 순수 함수로 배선보다 먼저 별 task.

## 3. 문구 (모든 사용자 노출 문구는 `ko.ts` 경유 — ADR-0035)

| 위치 | 문구 |
|---|---|
| 펼침 편집기 체크박스 라벨 | `요청마다 새로 뽑기` |
| 체크박스 옆 HelpTip | 켜면 이 변수를 쓰는 요청이 나갈 때마다 새 값을 뽑습니다. 끄면 반복(시나리오 1회 실행) 동안 같은 값을 씁니다. 같은 이름을 데이터셋이나 추출 값이 채우면 그 값이 우선합니다. |
| 접힘 요약 배지(켰을 때만) | `요청마다` |
| 예시 줄 ↻ 버튼 title | 켬: `다시 뽑기 — 실행 시 요청마다 새 값이 생성됩니다` / 끔: 기존 `genSampleRefreshTitle` 그대로 |
| 선택 배열 팝업 미리보기 제목 | 켬: `미리보기 (요청마다 새로 뽑힘)` / 끔: 기존 `pickPreviewTitle` 그대로 |

정확한 키 이름은 plan이 확정한다.

## 4. 엔진 (`crates/engine`)

### 4.1 모델·와이어

```yaml
variables:
  flags: {gen: pick_array, length: 10, min: 1, max: 3, refresh: request}
  sent_at: {gen: date, format: unix_ms, refresh: request}
  order_ref: {gen: uuid}            # 생략 = iteration (지금과 같음)
```

- `GenSpecWire`(`genvars.rs:86`, `deny_unknown_fields`)에 `refresh` 추가. 값은 문자열 `"request"` | `"iteration"`만 수용, 그 밖(`Request`·`true`·`step` 등)은 파싱 거부(값-free 고정 문구). **명시 `refresh: null`·빈 `refresh:`도 거부** — `#[serde(default)] Option<String>` 기본 경로는 null을 None(=생략)으로 조용히 받아 UI(Zod `.optional()`은 null 거부)와 판정이 갈리므로, `present_positions`(`genvars.rs:150`)와 같은 방식으로 `serde_yaml::Value`를 받아 문자열만 통과시키는 deserializer를 단다(같은 부류 함정의 기존 해법). 5종 생성기 **모두** 수용 — per-gen allow-list(`deny(...)` 조건)에 넣지 않는다(공통 키).
- 정적 변수(문자열)는 맵이 아니므로 `refresh`를 붙일 자리가 없다. `{refresh: request}`(gen 없음)는 기존대로 `gen` 누락으로 거부 → US5 "정적 변수에 쓰면 거부"가 추가 코드 없이 성립(테스트로 고정).
- 저장: `pub enum Refresh { Iteration, Request }`(기본 `Iteration`)을 생성기 선언에 붙인다. 형태는 `VarDecl::Gen { spec: GenSpec, refresh: Refresh }`(이름 있는 필드). `GenSpec`의 5개 변형은 무변경 — 기존 평가 함수 시그니처도 그대로.
- **Serialize**: 기존 `GenSpec` 방출 규칙 뒤에 `refresh: request`를 **`Request`일 때만** 맨 끝 키로 추가. `Iteration`은 키를 내지 않는다 — 엔진이 재직렬화하면 명시 `refresh: iteration`은 생략형이 된다. 옵션을 안 쓴 시나리오는 엔진 재직렬화 결과가 지금과 byte-identical. 현재 `GenSpec::serialize`의 각 arm이 스스로 `m.end()`를 부르므로(`genvars.rs:428-483`) 맵 항목 방출을 헬퍼로 빼고 `serialize_map(Some(n))` 개수에 refresh를 더하는 리팩터가 필요하다(plan 작업량).
- **컨트롤러는 시나리오 YAML을 원문 그대로 저장·반환한다**(`crates/controller/src/api/scenarios.rs` create/update는 `from_yaml`로 검증만 하고 `body.yaml`을 저장) — 저장된 YAML에서 `refresh`가 사라지는 경로는 없다. **엔진 Serialize의 실제 소비처는 `maybe_strip_think`**(`crates/controller/src/api/runs.rs:599-613` — open-loop이면서 시나리오 think time을 무시하는 run에서 `sc.to_yaml()`로 재직렬화해 워커에 보냄). 여기서 `refresh`가 빠지면 그 run만 조용히 반복 단위로 되돌아가므로, 이 경로의 왕복 테스트를 둔다(§9).
- 기존 match 사이트(`VarDecl::Gen(...)` 패턴: `genvars.rs` 10곳, `crates/engine/tests/proptests.rs:248-256`, `crates/engine/tests/pick_array.rs:254`)는 새 형태로 갱신(확인 명령: `grep -rn 'VarDecl::Gen' crates/ --include='*.rs'`). 엔진 밖(controller·worker src)엔 `VarDecl`/`GenSpec` 매치가 없다(같은 grep).

### 4.2 평가 시점 규칙

| 상황 | 동작 |
|---|---|
| 반복 시작 | 지금처럼 **모든** 생성 변수를 평가해 `iter_vars`에 넣는다(`refresh: request` 포함 — 첫 요청 전의 `if` 조건이 값을 볼 수 있게). |
| HTTP 요청 직전 | 그 요청이 참조하는(§4.3) `refresh: request` 변수 중 **살아 있는** 것만 새로 평가해 `iter_vars`에 덮어쓴다. 같은 요청 안의 여러 참조(URL·바디)는 같은 값. |
| 데이터셋이 같은 이름을 주입 | 그 반복 동안 **죽은** 상태 — 재평가하지 않는다(우선순위 생성 < 데이터셋 유지). 판정은 그 반복에서 실제로 주입된 키. |
| 추출(extract)이 같은 이름에 씀 | **실제로 쓴 키**(`outcome.extracted`에 들어 있는 키)만 그 순간부터 그 반복의 남은 요청 동안 죽은 상태(생성 < 추출 유지). 스텝에 선언된 추출 이름이 아니다 — 추출은 전부-아니면-전무라 하나라도 실패하면 `extracted`가 비고(`extract.rs` `evaluate_extracts` Err → `executor.rs:279-282`), assert 실패면 추출 자체를 건너뛴다(`executor.rs:272`). 이때 변수는 살아 있어 계속 재평가된다(값이 써지지 않았으므로 생성 값이 맞다). |
| loop | 회차마다 요청이 새로 나가므로 회차마다 새 값(별도 처리 없음). |
| parallel | 각 분기는 진입 시점의 살아 있는 집합을 복사하고 **분기별 생성기 rng**로 재평가한다. 시드는 **부모 생성기 rng**에서 분기마다 1개씩 뽑는다 — 기존 분기 think rng 시드(`runner.rs:665`, VU think rng에서 뽑음)와 별개라 `think_seed` 재현성에 영향이 없다. 분기 안 추출로 죽은 변수는 그 분기에만 해당(분기 변수 스코프와 같은 규칙). 분기 안에서 뽑힌 값은 부모로 돌아오지 않는다(부모로 병합되는 건 추출 값 `{branch}.{k}`뿐 — `runner.rs:715-718`). |
| `if` 조건 | 재평가하지 않는다 — `iter_vars`에 남은 값(같은 스코프에서 직전에 그 변수를 쓴 요청의 값, 아직 없으면 반복 시작 값)을 본다. **알려진 한계**: parallel 노드 뒤의 `if`는 분기 안에서 뽑힌 값을 못 보고 parallel 진입 전 값을 본다(위 행). |
| date | 재평가 때 현재 시각을 새로 읽는다 → 요청 시점의 시각(US4). |

**rng**: 생성기 전용 entropy rng(dynamic-vars §4의 `gen_rng`)를 반복 시드 이후에도 VU 루프 스코프에서 계속 쓴다. think rng(`think_seed`)와 공유 금지 규칙 유지.

### 4.3 "요청이 참조하는 변수" 판정 (순수 함수, 실행 시작 시 1회)

- **run당 1회**(부하 3진입점 각각 VU spawn 전에 1번, `Arc`로 VU들이 공유) · test-run은 trace 호출당 1회. 시나리오에서 `refresh: request` 선언을 모은다. **0개면 아무 상태도 만들지 않고** 요청 경로는 지금과 같은 코드를 탄다(옵션 미사용 시나리오의 hot path 비용 = 분기 1회).
- 1개 이상이면 HTTP 스텝마다(중첩 loop/if/parallel 포함) 그 스텝 요청이 참조하는 `refresh: request` 변수 집합을 미리 계산해 `step_id → 재평가 대상 목록`을 만든다. **같은 step_id가 여러 스텝에 있으면 집합을 합친다**(합집합) — 엔진·컨트롤러·UI 어디도 step_id 유일성을 강제하지 않으므로(YAML 복사·붙여넣기로 중복 가능), 덮어쓰면 한 스텝의 참조가 사라져 위험한 쪽(과소)으로 틀린다. 합치면 과대(무해)로만 틀린다.
- 판정은 **렌더러 자신의 토큰 해석을 재사용**한다 — hot path 렌더 지점과 같은 필드(URL·헤더 값·JSON 문자열 leaf[캐스트 접미 제거 포함]·form 값·raw 바디)를 수집 렌더(`render_collecting`/`render_json_collecting` 계열)해 미해결 이름을 얻는다. 새 토큰 파서를 쓰지 않는다(`{{ flags }}` 같은 공백 허용 문법을 렌더러와 다르게 해석할 위험 제거).
- **판정 컨텍스트** — 수집 렌더는 미해결 `{{x}}`(flow)와 미해결 `${X}`(env·시스템)를 **같은 목록에 구분 없이** 넣는다(`template.rs` `render_inner`의 두 sink push). 그래서 컨텍스트를 이렇게 만든다: flow 변수 = **빈 맵**, env = **모든 `refresh: request` 이름을 키로 갖는 더미 맵**, `loop_index = Some(0)`. 그러면 `${flags}`·`"${flags:json}"`은 더미로 해석돼 수집되지 않고, `${loop_index}`도 수집되지 않으며, 수집 결과 중 `refresh: request` 이름과 겹치는 것은 `{{…}}` 참조뿐이다. 수집 결과를 `refresh: request` 이름 집합과 교집합해 대상으로 삼는다(`${BASE_URL}` 같은 다른 미해결 env 이름은 교집합에서 빠진다).
- 렌더 지점(확인 명령: `grep -n 'render(\|render_json_value(' crates/engine/src/executor.rs`): `execute_step`의 url(`:150`)·헤더 값(`:153`)·JSON(`:179`)·form 값(`:185`)·raw(`:190`). 판정 함수는 이 목록과 **lockstep** — 새 렌더 필드를 추가하면 판정 함수도 갱신해야 한다(빠뜨리면 그 필드에서만 반복 값이 나간다 — 조용한 실패라 §9 테스트가 필드별로 고정). 엔진 `CLAUDE.md`에 한 줄 기록.
- 과대 판정은 무해(불필요한 재평가 1회), 과소 판정이 위험(그 요청에 이전 값) — 판정이 애매하면 포함하는 쪽.

### 4.4 배선

- `execute_steps`에 재평가 상태(대상 목록·생성기 rng·살아 있는 집합)를 넘긴다. 비재귀 호출부 3곳(`run_vu`·`run_vu_curve`·`run_arrival`) + 재귀 arm(loop·if·parallel) + test-run 쌍둥이 `trace_steps`(엔진 `CLAUDE.md` "시나리오-레벨 파라미터를 추가하면 3진입점 + trace" 함정). `Step::Http` arm에서 ctx를 만들기 직전에 재평가, extract 반영 직후 죽은 집합 갱신.
- trace(test-run)는 행/반복마다 상태를 새로 만든다(dynamic-vars §4 "행=반복" 규칙과 동일). `seed_vars`(데이터셋 행) 키가 죽은 집합의 초기값.
- template.rs·cast.rs·executor.rs의 렌더 경로 0-diff(판정 함수가 executor.rs에 추가되더라도 기존 함수 본문은 불변). proto·migration·worker src 0-diff, controller는 **프로덕션 코드 0-diff**(`maybe_strip_think`가 private이라 §9의 왕복 테스트는 `crates/controller/src/api/runs.rs`의 인라인 `#[cfg(test)]`에 추가된다 — 그래서 controller src 파일이 diff에 나타나며, `finish-slice §0` 보안 grep 매치 여부에 영향을 줄 수 있다)(워커는 엔진 재컴파일만 — 옛 워커 바이너리는 `refresh` 키를 못 읽는 기존 함정 그대로).

### 4.5 성능 (사용자 질문, 2026-10-17 실측)

release 빌드 `seed_iter_vars` 1회 평가(2만 회 평균, 측정 코드는 삭제): random_int·date·길이 10 선택 배열 0.2–0.3µs · uuid 0.7µs · 64자 문자열 1.4µs · 선택 배열 길이 1000(불리언) ~7µs · 길이 1000 + 64자 문자열 값(허용 최대) ~43µs·67KB. 옵션 미사용 시 비용 0(§4.3 분기 1회), 사용 시 참조하는 요청에서만 평가하므로 평가 비용은 그 요청이 실제로 렌더·전송하는 값의 크기에 비례한다.

## 5. UI 모델 (`ui/src/scenario/`)

- **Zod** (`genVars.ts`): 5개 멤버 모두에 `refresh: z.enum(["iteration", "request"]).optional()` 추가(각 멤버가 `.strict()`라 빠뜨린 멤버는 `refresh` 키를 거부 — 엔진과 판정이 갈린다). discriminatedUnion·superRefine 구조 무변경.
- 정적 값(`string`)에는 붙일 자리가 없다(엔진과 동일).
- **공유 판정 벡터**: `testdata/pick_array_vectors.json`의 `generators` 목록에 refresh 케이스를 추가해 엔진·Zod가 같은 파일로 양방향 판정(기존 선례). 수용: 5종 각각 `refresh: request`, `refresh: iteration` / 거부: `refresh: Request`·`refresh: true`·`refresh: step`·`refresh: null`·빈 `refresh:`·`{refresh: request}`(gen 없음). (파일명은 pick-array 출신이지만 `generators` 절은 생성기 선언 전반의 lockstep 벡터다 — 이름 변경은 범위 밖.)
- **yamlDoc** `setVariableGen`: 객체 키 순서가 곧 방출 순서인데, **refresh가 자연히 마지막에 머물지 않는다** — 파싱된 spec은 Zod 스키마 순서라 refresh가 끝이지만, spec에 없던 키를 추가하는 편집(`{...dateSpec, offset}`·`tz`·`step`·`length` — `GenVarEditor.tsx:160·165·195·220`)은 그 키를 refresh **뒤에** 붙인다. 그래서 `setVariableGen`이 노드를 만들기 전에 `refresh`를 명시적으로 맨 끝으로 옮긴다(엔진 방출 순서와 일치). 체크 해제는 `refresh` 키 **삭제**(`refresh: iteration`으로 쓰지 않음 — 엔진 방출형과 일치). `setVariableGen`은 변수 노드를 통째로 교체하므로 **그 변수 노드 안의 주석은 원래도 보존되지 않고**(기존 동작), 다른 변수·문서의 주석만 보존된다.
- `canonicalGenKey`·`samplePreview`는 refresh를 무시한다(예시 분포가 같으므로 토글해도 예시가 바뀌지 않는다).
- **신뢰도 지문(ADR-0049)**: refresh 토글은 `variables`를 바꾸므로 test-run 신뢰도 상태가 "stale"로 표시된다(§11.11의 `variables` 통째 지문 — 기존 동작). 실행 의미가 실제로 바뀌는 변경이라 정당한 stale이다.
- `genParamsSummary`는 무변경 — `요청마다`는 별도 배지로(§6.1; 210px 요약 줄 truncate에 잘려 사라지지 않게).

## 6. UI 컴포넌트

### 6.1 변수 패널 접힘 행 (`VariablesPanel.tsx`)

- 생성기 행 요약 줄(`VariablesPanel.tsx:339-365`)의 타입 배지 바로 뒤에 `refresh === "request"`일 때만 `요청마다` 배지(`shrink-0`, 타입 배지와 같은 크기·다른 색조). 파라미터 요약이 대신 truncate된다. 행 `title`(`genRowTitle`)에도 `· 요청마다` 포함.
- 210px 기본 폭에서 선택 배열 행(타입 배지 + 요청마다 배지 + 요약 + `편집` 버튼)이 한 줄을 넘지 않는지 라이브 실측(§8).

### 6.2 펼침 편집기 (`GenVarEditor.tsx`)

- 생성기 타입일 때(정적 제외) 파라미터 필드들 아래·예시 줄 위에 체크박스 `요청마다 새로 뽑기` + HelpTip(패널 안 — Modal 밖이라 ESC 레이어링 함정 무관; HelpTip은 `<label>` 밖 형제로 두어 체크박스 accname을 오염시키지 않는다 — U3 규칙). pick_array도 같은 자리(`편집…` 버튼 아래).
- 토글은 **즉시 커밋**(구조 변경 — 타입 select·형식 프리셋과 같은 이디엄): `onCommitGen({...spec, refresh: checked ? "request" : undefined})`. `yamlError !== null`이면 disabled(기존 게이트).
- **타입 전환 시 refresh 보존**: 생성기 → 다른 생성기로 바꾸면 현재 `refresh`를 새 spec에 그대로 실어 커밋(`changeKind`의 4종 리터럴 + pick_array 팝업 `initial`). 정적으로 바꾸면 사라진다(정적은 refresh가 없다). 기존 파라미터 커밋들은 `{...spec, …}` 스프레드라 자동 보존 — 스프레드가 아닌 커밋 지점이 있는지 plan이 전수 확인.
- ↻ 버튼 title은 refresh에 따라 §3 문구.

### 6.3 선택 배열 팝업 (`PickArrayDialog.tsx`)

- 팝업은 refresh를 편집하지 않는다. 단 **적용 시 `initial.refresh`를 결과 spec에 그대로 싣는다** — 현재 적용 spec 생성(`PickArrayDialog.tsx:182` 객체 리터럴)은 필드를 새로 조립하므로, 손대지 않으면 팝업에서 길이만 바꿔도 `refresh: request`가 **조용히 사라진다**(회귀 테스트 필수, 이빨 실증 대상).
- 미리보기 섹션 제목은 refresh에 따라 §3 문구.
- `배열로 추가`(미정의 행) 경로는 refresh 없음으로 시작(기본값).

## 7. 보안·범위 노트

- 생성 값은 비밀이 아니다. 새 sink 없음 — 재평가 값은 기존 `iter_vars` → 렌더 경로로만 나간다. diff가 `genvars.rs`(파싱 게이트)·`executor.rs`·`trace.rs`를 건드리므로 `finish-slice §0` grep이 `security-reviewer`를 트리거할 것으로 예상(grep이 지배).
- **roadmap §B31 R-b(시나리오 전체 pick_array 크기 무상한)와의 관계**: 재평가는 **참조하는 요청에서만** 일어나므로 요청당 생성 비용은 그 요청이 실제로 렌더하는 값의 크기에 비례한다 — 요청 바디 렌더 비용과 같은 차수라 R-b의 증폭을 새 차원으로 키우지 않는다(반복당 → 요청당이지만 렌더는 이미 요청당이었다). R-b는 그대로 연기.
- 오류 문구에 사용자 입력 원문 전체를 싣지 않는다(`refresh` 거부 문구는 고정).

## 8. 수용 기준 요약 (US ↔ 검증)

| US | 증거 |
|---|---|
| US1 | test-run trace(UI): 선택 배열 `refresh: request`(`length: 20, min: 10, max: 10` — 가능한 배열 C(20,10)=184,756개라 3개가 우연히 겹칠 확률 무시 가능)를 쓰는 HTTP 스텝 3개의 요청 바디 배열이 서로 다르고, 각 배열의 선택 개수 = 10 |
| US2 | 에코 서버 run: loop `repeat: 5` 안 요청의 와이어 값이 회차마다 다름 — 배열·random_int(넓은 범위)·uuid·random_string 각각 |
| US3 | 같은 run 와이어: `refresh` 없는 uuid는 한 반복 안 모든 요청에서 동일·반복 간 상이 / 켠 배열은 요청마다 상이 · `refresh` 없는 변수의 파라미터를 GUI로 편집해 저장 → GET `yaml`에 `refresh` 키가 생기지 않음 · 엔진 재직렬화(`to_yaml`) 결과가 옵션 미사용 시나리오에서 지금과 byte-identical(단위 테스트 — 저장 경로는 원문 저장이라 GET 비교는 증거가 못 된다) |
| US4 | 와이어: `date`(`format: unix_ms`, `refresh: request`)가 한 반복 안에서 think time 간격만큼 증가 / 끈 쪽은 반복 안에서 동일 |
| US5 | Monaco/YAML 모달에서 `refresh: request` 추가 → 체크박스 체크·`요청마다` 배지 표시 / 삭제 → 둘 다 사라짐 · GUI 체크 → 저장 YAML 마지막 키 `refresh: request` · 정적 변수 자리에 `{refresh: request}` → 저장 400 |

라이브 검증은 에디터 두 진입 화면(`/scenarios/new`·`/scenarios/{id}`) 모두에서([[live-verify-all-mount-paths]]). 와이어 검증은 요청 바디를 찍는 로깅 echo responder로(번들 `responder.py`는 요청을 안 찍는다 — 루트 CLAUDE.md).

## 9. 테스트 전략

- **엔진 모델**: round-trip(`refresh: request` 5종 각각 방출·재파싱 동일, `refresh: iteration` → 생략형으로 정규화, 미사용 선언 byte-identical) · 거부 매트릭스(§5 벡터 공유, null·빈 값 포함) · proptests `arb_var_decl`에 refresh 차원 추가 · **`maybe_strip_think` 경로 왕복**: open-loop + `apply_scenario_think_time: false` + think time 있는 시나리오에서 워커로 가는 YAML에 `refresh: request`가 남는다(컨트롤러 단위 테스트).
- **판정 함수(§4.3)**: 필드별 1케이스 — url·헤더 값·JSON leaf·JSON 캐스트 leaf(`"{{flags:json}}"`)·form 값·raw 바디·공백 토큰(`{{ flags }}`) 각각에만 참조가 있을 때 대상에 포함 / 참조 없는 스텝은 비어 있음 / env 토큰(`${flags}`·`"${flags:json}"`)은 이름이 같아도 대상 아님(§4.3 더미 env 컨텍스트의 이빨 — 더미를 빼면 RED) / `${loop_index}`·`${BASE_URL}`은 대상에 섞이지 않음 / 같은 step_id 두 스텝의 참조는 합집합.
- **평가 배선**: 세 부하 진입점을 `Mode::{Closed,Curve,Open}`으로 직접 spawn(`tests/think_time.rs` 헬퍼 패턴 — `run_scenario`만 테스트하면 곡선·open 누락이 green) 해 wiremock 요청 기록으로: 켠 변수 = 같은 반복 내 요청 간 상이 / 끈 변수 = 반복 내 동일 · 데이터셋 주입 이름은 재평가 안 됨 · 추출이 실제로 쓴 뒤로는 추출 값 · **추출 실패(전부-아니면-전무)면 계속 재평가** · parallel 분기에서도 재평가 · loop 회차별 상이 · 옵션 미사용 시나리오는 기존 테스트 무변경 green.
- **trace**: test-run 1회에서 스텝별 요청 바디 상이(US1의 엔진 측 증거) · 데이터셋 행 루프에서 행마다 상태 재생성.
- **UI 모델**: 공유 벡터 양방향 · yamlDoc 왕복(`refresh` 마지막 키·해제 시 키 삭제·다른 변수의 주석 보존) · **키 순서 이빨**: `refresh: request`가 있는 date spec에 `offset`을 추가 커밋 → 방출 YAML에서 `refresh`가 여전히 마지막(재배치를 빼면 RED).
- **UI 컴포넌트(RTL)**: 체크박스 표시/커밋/해제 · yamlError 시 disabled · 접힘 `요청마다` 배지 유무 · 타입 전환 시 refresh 보존(생성기→생성기 4방향 중 대표 + pick_array 팝업 initial) · 정적 전환 시 제거 · **팝업 적용이 refresh를 보존**(§6.3) · ↻ title·팝업 미리보기 제목 분기.
- **이빨 실증 의무**: 회귀 가드를 표방하는 테스트(팝업 refresh 보존·판정 함수 필드별·데이터셋/추출 우선·옵션 미사용 byte-identical)는 고의 회귀 → RED → 원복 → GREEN을 plan/brief에 명시([[plan-mandated-vacuous-tests]]). 특히 "요청 간 값이 다르다" 단언은 값 공간이 작으면 우연히 같아 flaky하거나, 반대로 버그가 있어도 우연히 다를 수 있다 — 값 공간이 큰 생성기(uuid·`length: 20, min: 10, max: 10` 배열 — 선택 개수 범위가 1~3처럼 좁으면 배열 3개 중 둘이 겹칠 확률이 약 2%라 flaky)로 단언하고, "반복 내 동일"(끈 쪽) 단언을 짝으로 둬 재평가가 아예 없거나 모든 변수에 적용되는 구현을 구분한다.
