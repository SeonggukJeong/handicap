# 실행 전 시나리오 신뢰도 (A11 2차) — preflight 등급 + 고칠 곳

- **날짜**: 2026-07-25
- **상태**: spec 개정 4판 — `spec-plan-reviewer` 4라운드 완료 (1판 `NEEDS-REWORK` → 2·3·4판 `APPROVE-WITH-FIXES` 반영). 마지막 라운드의 잔여 지적(모달 보류 prop 계약 · #7 변이 이빨 · 정리 4건)까지 반영 완료 — 리뷰어가 "판단 필요 항목 없음, 반영 후 재리뷰 없이 진행 무방"으로 명시
- **유형**: `user-path`
- **출처**: `/start-slice A11` 세션(2026-07-25) — roadmap `§A11` 회고가 남긴 미결정 방향에서 **(A) 에픽 본체**를 사용자가 선택. 회고가 기록한 갭: 로드맵 기둥 문구는 "시나리오 신뢰도 + 개선 가이드"로 읽히는데 1차(`f93544a`)는 **사후 soft 라벨**만 출하했다.
- **연관**: A11 1차 `trustworthy-open-test`(`crates/controller/src/validity.rs`) · ADR-0033 parallel 분기 변수 스코프 · ADR-0044 에디터 아웃라인 · ADR-0026 에디터 test-run · `parallel-var-scope`(위치 인식 `undefinedVarRefs`) · `editor-var-tools-b`(`parallelVarIdentities`) · `think-time-dashboard`(칩 → 모달 현황판 선례)
- **ADR**: **필요 — ADR-0049**(다음 번호 확인됨). 이 슬라이스가 정하는 것은 **사용자 대면 판정 축 신설**(§2 D3)과 **검증 상태를 브라우저에 두되 등급과 분리한다는 결정**(§2 D19)이며, 후속(서버 승격·팀 공유·목록 확산)이 반드시 참조한다. UI-only 결정도 ADR을 받은 선례가 있다(ADR-0043, ADR-0044).

### 리뷰 반영 이력

**1판 `NEEDS-REWORK`** — 블로커 3건:
- **F1**: "미해결 토큰이 원문 전송돼 조용히 통과"는 **거짓**. 엔진은 strict다(`crates/engine/src/executor.rs:87` → `template.rs:92,145` `UnknownVar` → `all VUs failed`). 1판은 UI측 `ui/src/scenario/template.ts`의 lenient 동작을 엔진으로 일반화했는데, 그 doc 자체가 `not request execution`이라 명시하고 있었다. → B의 성격이 "조용한 결함"에서 "run 전멸"로 바뀜.
- **C1**: 지문 *내용*에 시나리오 id를 못 넣는다는 이유로 **저장소 키까지** 시나리오 무관으로 만들어 US4가 구조적으로 달성 불가였다. → 시나리오별 버킷(§6.2).
- **FR3**: B·C는 `VariablesPanel`이 **이미 렌더 중인 정보**다(`:129` 미정의, `:206` `usageCell`→`ko.ts:505` `미사용`). → 모달을 나열이 아닌 **종합**으로 재정의(§7.2), 판정을 패널과 단일 소스로 수렴(§4.4). 그 결과 추출-사이트 walker가 소멸.

**2판 `APPROVE-WITH-FIXES`** — must-fix 10건. 가장 중요한 것:
- **FR1(설계 결정)**: D는 `na`가 없고 브라우저-로컬이라 **시나리오 작성자 외 모두에게 D=never → `level ≠ good` → RunDialog 한 줄이 상시 노출**된다. US3의 "양호하면 아무것도 뜨지 않는다"가 두 번째 사용자에겐 도달 불가가 되고, §1.3의 "조건부 표면은 위험할 때만"이 무조건으로 붕괴한다. **근본 원인은 D가 다른 종류의 진술이라는 것** — A·B·C는 시나리오 텍스트의 속성이고 D는 *이 브라우저가 아는 것*이다. 인식 상태를 시나리오 등급에 섞으면 등급이 사람마다 달라진다. → **등급은 A·B·C로만**(§5), D는 등급 미반영 별도 표시(D19).
- 나머지 9건(FR2 `__draft__` 이관 · FR3 지문 스냅샷 시점 · if 분기 정체성 · JSON 키 정렬 · `disabled` 제외 · 이빨 쌍 정정 · RunDialog B 분기 · tdd-guard · 이동 범위)도 전부 반영. 상세는 각 절.

---

### 사용자 스토리 (US)

- **US1**: QA가 **시나리오를 편집하는 동안** 이 시나리오가 믿을 만한 시험인지 판단하려 한다 — 성공하면 에디터에서 등급과 통과 카운트(`주의 · 점검 3개 중 1개 통과`)를 보고, 결함을 고치는 즉시 등급이 올라가는 것을 본다.
- **US2**: QA가 **등급이 낮게 나왔을 때** 어디를 손봐야 하는지 찾으려 한다 — 성공하면 실패한 점검마다 이유 한 줄과 영향받는 스텝·변수를 보고, 클릭해서 그 스텝으로 바로 이동한다.
- **US3**: QA(또는 운영자)가 **부하를 걸기 직전** 이 시나리오가 못 미더운 상태인지 알려 한다 — 성공하면 실행 다이얼로그에서 한 줄 경고와 건수를 보고 실행을 계속할지 에디터로 돌아갈지 정한다. 신뢰도가 양호하면 아무것도 뜨지 않는다.
- **US4**: QA가 **한 번도 실제로 돌려보지 않은 시나리오로 부하를 거는 상황**을 인지하려 한다 — 성공하면 `아직 시험 실행 안 함`과 `시험 실행 이후 시나리오가 바뀜`을 구분해서 보고, 스텝 이름만 고친 경우엔 그 표시가 뜨지 않는 것을 확인한다.
- **US5**: 부하 테스트가 처음인 QA가 **신뢰도 `양호`를 "결과가 좋다"로 오독하지 않으려 한다** — 성공하면 양호 등급과 함께 "실패를 감지할 수 있는 시험"이라는 정의와 "대상 시스템 성능이 좋다는 뜻은 아니다"라는 경계를 같이 보고, 성능 판단은 실행 후 리포트로 넘어간다.

> **US4의 실현 표면 (3판 명시)**: 에디터 칩 접미 `(미확인)` + 모달의 D 전용 줄. **RunDialog에는 D를 싣지 않는다** — 그러면 FR1이 그대로 재발한다(작성자 외 모두에게 상시 노출). US4의 관찰 조건은 "두 상태를 구분해서 본다"이지 특정 화면을 지정하지 않으므로 에디터 표면으로 충족된다.

---

## 1. 문제와 목표

### 1.1 1차가 남긴 갭

1차(`crates/controller/src/validity.rs:68` `derive_validity`)는 run이 **끝난 뒤** 리포트에 `ok|limited|suspect` 라벨을 붙인다. 규칙 5종 중 4종은 실측값이 있어야 하는 **본질적 사후 신호**이고, 정적으로 알 수 있는 것은 `no_response_validation` 하나뿐이다(`validity.rs:110-121`).

그래서 1차는 "이 결과를 어떻게 읽어라"는 말해 주지만 **"무엇을 고치면 다음 시험이 믿을 만해지는가"는 말하지 않는다.** 사후에는 이미 run 시간과 대상 시스템 부담을 다 쓴 뒤다.

### 1.2 에디터에는 시험 품질을 *종합*하는 눈이 없다

| 표면 | 무엇을 |
|---|---|
| `ValidationBanner` (`problems.ts:12`) | 빈 URL, 스킴 없는 리터럴 URL, YAML/Zod 게이트 — 전부 **하드 에러** |
| `VariablesPanel` (`VariablesPanel.tsx:129`) | 미정의 변수 ⚠ (행 단위) |
| `VariablesPanel` (`:206` `usageCell`) | 참조 0건 변수 = `미사용` (행 단위) |

**없는 것**: ① "요청은 다 나가는데 아무것도 검증하지 않는다" ② "한 번도 실제로 돌려본 적 없다" ③ **이 사실들을 하나의 판단으로 묶는 것**.

이 슬라이스의 가치는 "새 사실 4개 나열"이 아니라 **새 사실 2개(A·D) + 기존 사실 2개(B·C)의 종합**이다. 이 구분이 §7.2 모달 설계를 지배한다.

### 1.3 밀도 제약 (1급) — 측정 가능한 형태

회고 #3·#4: 리포트 상단이 이미 나열형이라 초보자에게 피로하고 **"배지 더 붙이기" 2차는 기각**됐다. 필요한 것은 "정보 추가"가 아니라 **오해 유발 초록 억제 + 한 문장 권위**다.

- 상시 **배너** +0 (에디터·RunDialog·리포트 전부)
- 상시 **칩** +1 이내 (에디터 칩 줄 안)
- **리포트 표면 0-diff**
- 조건부 표면(RunDialog 한 줄)은 **위험할 때만** 렌더 — *이 제약이 §5에서 D를 등급에서 뺀 직접 근거다(FR1)*
- 모달 안에서도 **이미 다른 표면이 렌더 중인 정보는 재나열하지 않고 개수 + 링크로 접는다**
- 모달의 **실패 항목은 최대 3** (등급 점검이 A·B·C 셋이므로 구조적으로 보장 — 회고의 "고칠 곳 ≤3"이 실제로 참이 된다)

### 1.4 목표

1. 시나리오의 **정적 신뢰도**를 실행 *전에* 판정한다 — 등급 + 통과 카운트.
2. 실패한 점검마다 **고칠 곳**을 짚는다(새 사실은 스텝 이동, 기존 사실은 기존 표면으로 위임).
3. §1.3 제약 준수.
4. **soft only** — 실행을 막지 않는다.

### 1.5 비목표

실행 차단·자동 수정·AI 제안·돌연변이 검사(§A13-j) · 서버 계산/영속/proto/migration/엔진 변경 · 시나리오 **목록** 등급 열 · 1차 `validity` 로직·리포트 표면 변경 · run 설정(SLO·데이터셋·부하 모델) 판정(D4) · 점검 **억제(opt-out)**(§11.6).

---

## 2. 핵심 결정

| # | 결정 | 값 | 이유 |
|---|---|---|---|
| D1 | 계산 위치 | **클라이언트 TS 순수 함수** | US1이 "고치면 즉시 등급이 오른다"를 요구 — 저장 안 된 라이브 store 모델을 매 편집마다 서버로 보낼 수 없다. `RunDialog`도 이미 파싱된 `scenario`를 갖고 있다(`ui/src/components/RunDialog.tsx:60`) |
| D2 | 정책 | **soft only** | 1차 D2 계승. 스케줄/야간 run 비차단 |
| D3 | 축 | `신뢰도(시나리오)` ⟂ `validity(결과 해석)` ⟂ `verdict(SLO)` ⟂ `status(run 상태)` | 1차 D4 확장. **네 번째 판정 축 신설 = ADR-0049 사유** |
| D4 | 판정 입력 | **시나리오 모델 + test-run 이력만**. run 설정 미참조 | 같은 시나리오가 run마다 다른 등급이면 "시나리오 신뢰도"가 무너진다 |
| D5 | 측정 형태 | **등급 3단계 + 통과 카운트** | 숫자 점수는 가중치 근거가 없다. 카운트만이면 심각도가 뭉개진다 |
| D6 | 등급 규칙 | **2축 모델**(§5) — 축① 실행 가능성(B) + 축② 시험 유의미성(A·C) | F1 정정의 직접 귀결. B는 "조용한 결함"이 아니라 "run 전멸"이다 |
| D7 | na 처리 | 해당 없는 점검은 **분모에서 제외** | extract 없는 시나리오에 "끊긴 체인 통과"를 세는 건 정직하지 않다 |
| D8 | 표면 | 에디터 **칩** + **모달** + RunDialog **한 줄**(양호면 미표시) | §1.3 |
| D9 | 색 | **양호 = 중립 회색**. 주의 = amber, 취약 = red | 거짓 초록과 싸우는 기능이 새 초록을 만들면 자기모순 |
| D10 | 오독 방어 | 양호일 때 "성능이 좋다는 뜻은 아니다"를 **모달 + 칩 `title`/`aria-label` 둘 다** | 모달 안에만 두면 안 여는 사용자에게 US5가 실현되지 않는다 |
| D11 | D 근거 | **실행 지문 해시 + 시나리오별 localStorage 버킷** | 이름·메모 수정으로 무효화되면 사용자가 이 점검을 무시한다. 버킷 분리로 `never`/`stale` 구분(US4) |
| D12 | 빈 시나리오 | http 스텝 0개면 **평가하지 않음**(칩 미렌더) | 빈 시나리오에 등급은 무의미 |
| D13 | 항목 단위 | 점검당 1항목. **통과 항목은 기본 접힘. D 줄은 상시 표시**(접지 않음) | 스텝마다 한 줄이면 회고가 경계한 나열이 된다. 단 D는 US4의 두 번째 표면이라 한 클릭 뒤로 숨기면 "두 상태를 구분해서 본다"가 두 클릭이 된다 — 한 줄이라 밀도 비용도 없다 |
| D14 | B·C 표시 | **개수 + `변수 패널에서 보기` 링크**(스텝 칩 없음) | 이미 패널이 렌더 중인 정보다. 재나열은 §1.3 위반 |
| D15 | B·C 판정 소스 | `VariablesPanel` 행 빌더를 **공유 모듈로 추출** | 규칙 두 벌이면 같은 변수가 패널엔 `미사용`, 모달엔 `사용됨`으로 갈린다 |
| D16 | `verified` 정의 | `trace.ok === true && trace.truncated === false` | mutation 성공(HTTP 200)만 보면 **전 스텝이 죽은 test-run도 "확인했습니다"** — 이 에픽이 싸우는 그 거짓말 |
| D17 | 반응성 | store에 `testRunEpoch`(`renameEpoch` 이디엄) | `EditorShell`·`TestRunSection`은 형제(`ScenarioEditPage.tsx:270,277`)라 localStorage 쓰기가 칩을 재렌더시키지 않는다 |
| D18 | 억제 기능 | **만들지 않음** | assert 없는 스텝을 침묵시키는 장치는 이 에픽이 싸우는 대상을 정확히 숨긴다(§11.6) |
| **D19** | **D의 등급 관여** | **없음** — 등급은 A·B·C만. **`evaluateTrust`는 test-run 상태를 인자로도 받지 않고 `TrustReport`에 담지도 않는다**(타입으로 강제). D는 칩 중립 접미 `(미확인)` + 모달 별도 줄로, 호출부가 `testRunStateFor`를 직접 읽어 렌더 | **FR1**: D는 `na`가 없고 브라우저-로컬이라 작성자 외 모두에게 `never` ⇒ 등급에 넣으면 `good`이 사실상 도달 불가가 되어 US3·§1.3이 붕괴한다. A·B·C는 *시나리오 텍스트의 속성*이고 D는 *이 브라우저가 아는 것*이라, 섞으면 등급이 사람마다 달라진다. **불변식을 사람 규약("넘기되 무시하라")이 아니라 시그니처로 강제**해야 후속 편집이 조용히 FR1을 되살리지 못한다 |
| D20 | 지문 스냅샷 시점 | **`fire()` 시점**에 계산해 클로저로 전달 | `onSuccess`에서 그때 모델을 해시하면 사용자가 사이에 편집한 **다른 내용**이 `verified`로 기록된다 — D16과 같은 클래스의 거짓말(FR3) |
| D21 | `scenarioKey` 획득 | **`useParams<{ id: string }>()` + `id ?? "__draft__"`** — `EditorShell`·`TestRunSection` 각자 읽는다(prop drilling 없음) | `ScenarioNotesCallout.tsx:19`가 이미 같은 이디엄으로 에디터 스코프에서 `id`를 읽고 `/scenarios/new`(undefined)를 분기한다. **라우터 없는 렌더에서도 안전함이 이미 회귀 테스트로 고정돼 있다** — `ScenarioNotesCallout.test.tsx:135-138` "EditorShell 통합 — 라우터 없이도 안전"이 라우터 없이 `EditorShell`을 렌더해 통과하므로, 기존 `EditorShell`/`TestRunSection` 테스트(둘 다 Router 미포함)가 깨지지 않는다. 정하지 않으면 구현자가 route 의존을 몰래 넣거나 임의 prop 사슬을 만든다 |

---

## 3. 데이터 모델

신규 순수 모듈 **`ui/src/scenario/trust.ts`**.

```ts
/** 등급에 관여하는 점검 (§5). */
export type TrustCheckId = "response_validation" | "undefined_vars" | "broken_extract_chain";

export type TrustCheckStatus = "pass" | "fail" | "na";

export interface TrustCheck {
  id: TrustCheckId;
  status: TrustCheckStatus;
  /** A 전용: 검증이 없는 http 스텝 id(문서순). B·C는 항상 빈 배열(D14). */
  stepIds: string[];
  /** B·C 전용: 걸린 변수 개수(표시용). A는 0. */
  count: number;
}

export type TrustLevel = "good" | "caution" | "weak";

export interface TrustReport {
  level: TrustLevel;
  /** 항상 3개, 고정 순서 A→B→C (결정론). */
  checks: TrustCheck[];
  passed: number;      // pass 개수
  applicable: number;  // na가 아닌 개수 = 통과 카운트 분모
  failed: number;      // fail 개수 = 칩 숫자 = RunDialog 건수 (최대 3)
  noValidationAtAll: boolean;  // §5 판정 근거 + UI 문구 분기
}

export function evaluateTrust(scenario: Scenario): TrustReport;
export function isTrustApplicable(scenario: Scenario): boolean;

/** D는 등급과 무관한 별개 상태(D19). 타입은 여기서 선언·export하고
 *  `trustPrefs.ts`가 import한다(의존은 trustPrefs → trust 단방향). */
export type TestRunState = "verified" | "stale" | "never";
```

**`evaluateTrust`는 test-run 상태를 인자로 받지 않는다**(D19). 1판~3판 초안은 `TrustReport.testRun`을 실어 나르며 "RunDialog는 무시하라"는 *사람 규약*으로 FR1을 막았는데, 그러면 ① 후속 편집이 조용히 D를 `level`에 되살릴 수 있고 ② RunDialog가 쓰지도 않을 지문 해시·localStorage 읽기를 **폼 입력 키마다** 수행하게 된다. 시그니처에서 빼면 불변식이 **타입으로 강제**되고 RunDialog는 D 경로를 아예 건드리지 않는다.

`evaluateTrust`는 **순수 함수**다 — localStorage·시간·난수를 쓰지 않는다. 그래야 단위 테스트가 진리표를 전수로 돈다.

**칩 숫자 = RunDialog 건수 = `failed`** 로 통일한다. 모달 머리글의 `3개 중 1개 통과`는 `passed`/`applicable`이라 **다른 수**이므로 칩 `aria-label`이 모호성을 해소한다(§7.1).

**계약**: `isTrustApplicable === false`(http 스텝 0개)면 UI는 `evaluateTrust`를 호출하지 않는다(D12). 호출되더라도 결정론적으로 `good`을 낸다(A=na, B·C도 참조·추출이 없어 pass/na) — 정의되지 않은 동작을 남기지 않기 위한 방어값이며, 진리표(§5)는 이 경로를 다루지 않는다.

---

## 4. 점검 정의

### 4.1 A `response_validation` — 응답 검증 없음

- **대상**: `flattenHttpSteps(scenario.steps)` (`ui/src/scenario/model.ts:264`) — loop `do`·if `then`/`elif[].then`/`else`·parallel `branches`까지 **모든 http 스텝**(이 함수가 parallel 분기에 하강함을 확인).
- **통과**: 모든 http 스텝이 `assert`에 `kind === "status"` 항목을 하나 이상 갖는다.
- **실패**: 그렇지 않은 스텝이 하나라도 있음. `stepIds` = 그 스텝들(문서순).
- **na**: http 스텝 0개(§3 계약대로 실질 도달 불가).
- `AssertionModel`은 `{ kind: "status", code }` **단일 원소** discriminated union이다(`model.ts:41`). 그래서 조언이 실행 가능하다 — 방법이 하나뿐이다.

> **1차 서버 판정과의 차이 3가지 (전부 의도적)** — 문구를 가르는 근거(§8):
> 1. **양화사(지배적 차이)**: 서버는 `.any(...)` + `!any_status` = **하나라도 있으면 통과**(존재 한정, `validity.rs:115-118`). preflight는 **모두 있어야 통과**(전칭). 10스텝 중 9개에 assert가 있으면 서버는 조용하고 preflight는 실패다.
> 2. **스코프**: 서버는 `collect_unconditional`로 무조건 실행 스텝만. preflight는 조건부·병렬 분기 포함(조언은 분기가 돌든 안 돌든 유효하므로).
> 3. **SLO**: 서버는 `has_active_criteria`도 검증으로 침. preflight는 미참조(D4).
>
> §5의 `noValidationAtAll`은 (스코프 차이를 빼면) 서버 규칙과 **사실상 동치**다 — 서버의 "하나도 없음"이 preflight의 "전무"다.

### 4.2 B `undefined_vars` — 미정의 변수 참조

- **판정**: `undefinedVarRefs(scenario)` (`scanVars.ts:295`)가 비어 있지 않으면 실패. `count` = 맵 크기. `stepIds` 비움(D14).
- **na 없음**.

> **왜 신뢰도인가 (1판 정정)**: 엔진은 **strict**다. `crates/engine/src/executor.rs:87`이 `render(&bare, ctx)?`로 렌더하고(주석 "strict: 미바인딩이면 여기서 UnknownVar"), `template.rs:92,145`가 `EngineError::UnknownVar`를 낸다. 결과는 요청 전송이 아니라 **VU 전멸** — run이 `all VUs failed (N/N): template: unknown variable ...`로 끝난다(`error.rs:8`). 따라서 B는 **"이대로 부하를 걸면 시작하자마자 run이 전멸한다"**이다.

`undefinedVarRefs`는 parallel 분기 스코프를 위치 기반으로 판정한다(`parallel-var-scope` 산출물). **의도된 false-negative를 상속한다** — 같은 parallel 노드 안 `{{B.v}}` 참조를 정의됨으로 본다(`scanVars.ts:289-291`). §11.7.

### 4.3 C `broken_extract_chain` — 끊긴 추출 체인

extract로 뽑은 변수를 아무도 참조하지 않는 상태. 로그인 토큰을 뽑아 놓고 안 쓰면 **인증 없이 도는 시험**이 된다.

- **판정**: §4.4 공유 행 빌더 결과 중 `kind`가 `flat-extract` 또는 `parallel-extract`이고 `refIds.length === 0`인 행이 하나 이상이면 실패. `count` = 그 개수. `stepIds` 비움.
- **na**: 그 두 종류의 행이 하나도 없음.

이 정의는 **패널이 `미사용` 배지를 붙이는 조건과 동일**하다(`VariablesPanel.tsx:206` `usageCell`이 `refIds`로 분기). 두 표면이 어긋날 수 없다.

### 4.4 공유 행 빌더 (D15)

`VariablesPanel.tsx`의 **`:123-172`** `useMemo` 본문 전체(여는 줄 `const rows = useMemo<VarRow[]>(() => {`·`:124` null 가드·`:125-127` 입력 집합 포함)와 **`VarRow` 타입(`:27-51`** — `:51`의 `};`가 유니온을 닫는 줄이다. `:50`에서 자르면 타입이 미완결로 이동한다)을 `ui/src/scenario/varRows.ts`로 **순수 이동**한다. 패널은 그 함수를 import해 쓰고(렌더 byte-identical), `trust.ts`도 같은 함수를 쓴다.

**시그니처 확정**: `export function buildVarRows(model: Scenario | null): VarRow[]` — 빌더가 `if (!model) return []`을 포함하므로 nullable 수용이 순수 이동이다. `VarRow`도 이 모듈에서 export.

**순수성 근거(리뷰 확인)**: `useMemo` 본문의 컴포넌트 스코프 의존은 `model` **하나뿐**이고(deps `[model]`, `:172`), 사용되는 `scanVars` 헬퍼 7개는 **전부 이 블록 안에서만** 쓰인다(파일 내 다른 사용처 0). 숨은 결합이 없다.

옮겨지는 규칙(현재 코드가 정본 — 바꾸지 않는다):

| 행 종류 | 산출 | `refIds` |
|---|---|---|
| `declared` | `model.variables` 키 | `buildVarRefIndex(model).get(name) ?? []` |
| `flat-extract` | `produced − 선언 − parallelNames` | 같음 |
| `parallel-extract` | `parallelVarIdentities(model)` | `isShadow ? namespacedRefIds : union(branchRefIds, namespacedRefIds)` |
| `undefined` | `undefinedVarRefs(model)` | `ref.stepIds` |

### 4.5 D `test_run_unverified` — 시험 실행 미검증 (등급 미반영)

`TestRunState` 3상태. **등급에 관여하지 않는다**(D19).

- **`verified`**: 이 시나리오 버킷에 현재 실행 지문 해시가 있음.
- **`stale`**: 버킷에 기록은 있으나 현재 지문이 없음 → "시험 실행 이후 시나리오가 바뀜".
- **`never`**: 이 시나리오 버킷이 비어 있음 → "아직 시험 실행 안 함".

---

## 5. 등급 — 2축 모델 (A·B·C)

- **축 ① 실행 가능성**: B — 이 시나리오가 **돌기는 하는가**.
- **축 ② 시험 유의미성**: A·C — 돌면 **뭔가를 검증하는가**.
- D는 축이 아니다(D19).

```
noValidationAtAll  =  http 스텝 ≥ 1  AND  status assert를 가진 http 스텝 수 == 0

weak     ⟸  B fail                                 (축 ① — 돌지 않는다)
         ∨  ( noValidationAtAll  AND  C fail )      (축 ② — 조용히 무의미하다)
caution  ⟸  ¬weak  AND  failed ≥ 1
good     ⟸  failed == 0
```

**`noValidationAtAll`은 한 가지로만 정의한다**: *status assert를 가진 http 스텝 수 == 0*. 1판은 "assert 있는 스텝 0개"와 "모든 스텝에 status assert 없음"을 병기했는데, `AssertionModel`이 현재 단일 원소라 우연히 동치일 뿐 body assert가 추가되면 갈라진다.

**왜 "전무"인가**: A가 증폭기인 이유는 검증이 없으면 다른 결함이 조용해지기 때문이다. 10스텝 중 9개에 assert가 있으면 그 9개에서는 시끄럽게 실패한다 — 실수이지 "틀려도 조용한" 상태가 아니다.

**진리표 (전수 테스트 대상)**:

| # | B | A | C | level |
|---|---|---|---|---|
| 1 | fail | * | * | **`weak`** |
| 2 | pass | fail(전무) | fail | **`weak`** |
| 3 | pass | fail(전무) | pass 또는 na | `caution` |
| 4 | pass | fail(부분) | fail | `caution` |
| 5 | pass | fail(부분) | pass 또는 na | `caution` |
| 6 | pass | pass | fail | `caution` |
| 7 | pass | pass | pass 또는 na | `good` |

**이빨 있는 쌍은 행 2 vs 행 4**다(리뷰 C2 정정). 둘 다 `C fail`이고 A의 전무/부분만 다른데 등급이 갈린다. 증폭 조건을 `noValidationAtAll` 대신 `A fail`로 바꾸면 **행 4만** `caution→weak`로 뒤집힌다 — 다른 행은 무반응이므로 행 3·5를 이빨로 지목하면 공허하다.

---

## 6. 실행 지문 + 영속 (D)

### 6.1 지문

```ts
export function executionFingerprint(scenario: Scenario): string;
```

**명시적** 직렬화다 — `JSON.stringify(scenario)`가 아니다(키 순서가 Zod 스키마 구현에 묶이면 리팩터로 조용히 깨진다).

**원칙: 지문 = test-run이 실제로 행사하는 실행 표면.** 실행에 영향이 없는 것은 전부 뺀다 — 무의미한 무효화는 사용자가 이 점검을 무시하게 만든다(D11).

**레코드/객체형 필드는 키를 정렬한 뒤 직렬화한다**: `headers`, `variables`, form body, **JSON 바디 객체(중첩 전 depth 재귀)**. 근거 — 엔진 헤더는 `BTreeMap`(`crates/engine/src/scenario.rs:232,247`)이고, JSON 바디는 `serde_json::Value`인데 워크스페이스가 `preserve_order`를 켜지 않아(`Cargo.toml` grep 0매치) `Value::Object`도 `BTreeMap`이다. **엔진이 어차피 정렬해 전송**하므로 키 순서는 실행 무영향인데, 삽입 순서로 직렬화하면 YAML에서 두 줄 순서만 바꿔도 `verified → stale`이 된다.

**JSON 바디 정렬은 반드시 재귀여야 한다** — `Value::Object`의 `BTreeMap` 성질은 **모든 깊이에** 적용된다. 최상위만 정렬하면 중첩 객체의 키 두 줄 순서만 바꿔도 `stale`이 되어, 고치려던 버그가 한 단계 안쪽에 그대로 남는다.

**배열형(`assert`·`extract`·`elif`·`steps`)은 정렬하지 않는다** — 순서가 실행 의미를 갖는다(예: `extract` 순서는 같은 이름을 덮어쓸 때 결과를 바꾼다).

| 포함 | 제외 |
|---|---|
| `version`, `cookie_jar`, `variables`(키 정렬) | `name`(시나리오 이름) |
| 스텝 트리: `type`, `request.method`, `request.url`, `request.headers`(정렬), `request.body`(JSON은 키 정렬), `assert`, `extract` | `notes`(공유 메모) |
| loop `repeat` · if `cond` · **`elif[i]`의 `cond`↔`then` 짝과 순서** · parallel 분기 `name`·순서 | 스텝 `name`(라벨) |
| **if 분기 정체성** — `then` / `elif[i].then` / `else`를 **구분해** 직렬화 | 스텝 `id`(ULID) |
| 컨테이너 구조·순서 | `request.disabled` |
| | `think_time`, `default_think_time`, `timeout_seconds` |

**if 분기 정체성 명시 근거(리뷰 must-fix 4)**: 스텝을 `then`에서 `else`로 옮기면 실행 의미가 정반대인데, "컨테이너 구조·순서"라고만 쓰면 구현자가 분기 라벨 없이 자식 목록만 이어 붙여 **지문이 같아질** 수 있다 = 거짓 `verified`.

**`disabled` 제외 근거(리뷰 F2)**: `crates/engine/src/scenario.rs:235-240`이 명시한다 — "**The executor NEVER reads this**". 행을 끄고 켜면 `headers`/form이 바뀌므로 그쪽이 이미 지문에 잡힌다. 꺼진 행의 *값*만 고쳐서 `stale`이 되는 건 위 원칙 위반이다.

**`think_time`/`timeout_seconds` 제외 근거**: 에디터 test-run은 `applyThinkTime` 기본값이 `false`이고(`ui/src/components/scenario/TestRunSection.tsx:30`) 단발 trace라 타임아웃도 사실상 행사하지 않는다. test-run이 검증하지 않은 필드로 test-run 검증을 무효화하면 근거가 뒤집힌다.

**분기 `name` 포함 근거**: 분기 이름은 `{{분기.변수}}` 네임스페이스의 일부라 **실행 의미를 바꾼다**(ADR-0033).

**데이터셋 바인딩은 지문에 없다** — 시나리오 모델이 아니라 test-run/run 설정이다(`ScenarioModel`, `model.ts:399`). §11.4.

### 6.2 영속 — 시나리오별 버킷

`ui/src/scenario/trustPrefs.ts` — `notesPrefs.ts`/`editorPrefs.ts` 이디엄(try/catch fail-soft; 실패 시 기능 저하는 "항상 `never`"뿐).

```ts
const KEY = "handicap:trust-testrun:v1";
/** 시나리오 키 → 성공한 test-run 실행 지문 해시(최신이 뒤, 시나리오당 상한 5).
 *  저장 안 된 새 시나리오는 "__draft__" 버킷. 버킷 총수 상한 50. */
type Buckets = Record<string, number[]>;

export function recordVerified(scenarioKey: string, hash: number): void;
export function testRunStateFor(scenarioKey: string, scenario: Scenario): TestRunState;
/** 저장 성공 시 "__draft__" 버킷을 새 시나리오 id로 이관(FR2). */
export function adoptDraftBucket(newScenarioId: string): void;
```

- 해시 = `hashSeed(executionFingerprint(scenario))` — 기존 FNV-1a 32bit(`ui/src/scenario/genVars.ts:79`).
- `testRunStateFor`: 버킷이 없거나 비면 `never`, 현재 해시가 있으면 `verified`, 아니면 `stale`.
- **`scenarioKey`** = `useParams<{ id: string }>()`의 `id ?? "__draft__"`(D21) — `EditorShell`(칩 읽기)과 `TestRunSection`(기록)이 **각자** 읽는다. `ScenarioNotesCallout.tsx:19`가 이미 같은 이디엄을 쓴다.
- **LRU 갱신은 쓰기 시에만**(`recordVerified`). 읽기는 순서를 바꾸지 않는다 — 결정론적이고 테스트 가능하다.
- **`adoptDraftBucket` fail-soft 규약**: 이관은 "새 키에 복사 → `__draft__` 삭제"를 **한 번의 write로** 수행한다. 실패하면 **아무것도 바꾸지 않고 조용히 포기**한다(반쯤 이관돼 양쪽 다 비는 상태 금지). 최악의 결과는 `never` 한 번이며, 그건 거짓 `verified`보다 안전하다.

**`__draft__` 이관 (FR2)**: 표준 흐름은 **작성 → test-run → 저장**이다. `ScenarioNewPage.tsx:126`이 저장 성공 후 `navigate('/scenarios/${created.id}')` 하는데, 해시는 `__draft__`에 있고 조회 키는 새 id다 ⇒ **내용이 1바이트도 안 바뀌었는데 `아직 시험 실행으로 확인하지 않았습니다`**. 모든 신규 시나리오에서 100% 발생하며 US4의 신뢰를 첫 사용에서 깬다. 저장 `onSuccess`에서 `adoptDraftBucket(created.id)`를 호출해 이관하고 `__draft__`를 비운다.

### 6.3 기록 시점 — `verified`의 정의 (D16·D20)

**지문은 `fire()` 시점에 계산해 클로저로 넘긴다**(D20). `fire()`는 그 시점 `yamlText`를 보내고 응답은 나중에 오므로(`TestRunSection.tsx:49-72`), `onSuccess`에서 *그때의* 모델을 해시하면 사용자가 사이에 편집한 **다른 내용**이 `verified`로 기록된다.

**`fire()` 시점 클라 파싱이 실패하면 기록을 스킵한다**(지문을 만들 수 없으므로). 서버 호출은 그대로 나갈 수 있으나 `recordVerified`를 부르지 않는다 — 무기록이 거짓 `verified`보다 안전하다.

**성공 판정은 HTTP 200이 아니라 trace 내용으로 한다**:

| 경로 | 조건 |
|---|---|
| 단발 `useTestRun` (`TestRunSection.tsx:67`) | `trace.ok === true && trace.truncated === false` (`ui/src/api/schemas.ts:560,564`) |
| 순차 `useTestRunSequential` (`TestRunSection.tsx:61`) | 최상위 `ok === true && truncated === false` (`schemas.ts:595,596`) |

전 스텝이 connection-refused로 죽은 test-run을 `현재 내용으로 시험 실행해 확인했습니다`로 기록하면 이 에픽이 싸우는 거짓말을 우리가 만든다.

> 구현 주의: `:61`의 `testRunSeq.mutate`에는 이미 `onSuccess`가 있지만(`:63`), **`:67`의 `testRun.mutate({...})`에는 옵션 인자 자체가 없다** — 두 번째 인자를 새로 만들어야 한다.

**`TestRunSection`은 현재 `{ yamlText }`만 받고(`:23`) `.steps`만 추출한다(`:37-40`)**. 지문 계산에는 전체 `Scenario`가 필요하므로 `parseScenarioDoc` 결과를 재사용한다. `scenarioKey`는 **prop이 아니라 `useParams`로 직접 읽는다**(D21) — 두 페이지에 prop을 새로 뚫지 않는다.

### 6.4 반응성 (D17)

`EditorShell`(칩)과 `TestRunSection`(기록)은 **형제**다(`ScenarioEditPage.tsx:270,277`, `ScenarioNewPage.tsx:142,144`). `localStorage` 쓰기는 `EditorShell`을 재렌더시키지 않으므로, 그대로 두면 **test-run 성공 후에도 칩이 `never`인 채**로 남아 US1·US4가 라이브에서 실패한다(RTL은 컴포넌트를 따로 렌더해 이걸 못 잡는다).

store에 `testRunEpoch: number`를 추가하고 기록 시 증가시킨다. `EditorShell`이 구독해 `testRunStateFor` 재계산 트리거로 쓴다. **선례**: `renameEpoch`(`ui/src/scenario/store.ts:46,215,243`).

**재계산 위치**: `EditorShell`이 `TrustReport`를 `useMemo([model])`로, `TestRunState`를 `useMemo([model, testRunEpoch])`로 각각 한 번 계산해 칩·모달에 내려 준다(등급은 epoch와 무관하다 — D19가 시그니처로 보장). `VariablesPanel`은 자기 `useMemo`를 유지하므로 에디터에서 행 빌더가 2회 돈다 — 순수 함수이고 시나리오 규모(수십 스텝)에서 무시할 비용이라 수용한다.

---

## 7. UI 표면

### 7.1 칩 (에디터, 상시)

`EditorShell` 칩 줄의 **6번째** — `⏱ 페이싱`(`EditorShell.tsx:130-134`) 다음.

- 문구: `◈ 신뢰도 · 양호` / `◈ 신뢰도 · 주의 2` / `◈ 신뢰도 · 취약 1`. 숫자 = `failed`(최대 3).
- **D 접미(D19)**: `EditorShell`이 `testRunStateFor`를 **직접 읽어**(`TrustReport`에는 없다) `!== "verified"`면 중립 톤 `(미확인)`을 덧붙인다 — `◈ 신뢰도 · 양호 (미확인)`. **등급을 떨어뜨리지 않고 색도 바꾸지 않는다.** 기존 칩 내부 텍스트라 §1.3의 "상시 칩 +1 이내"를 다시 쓰지 않는다. `never`/`stale` 구분은 모달이 한다.
- 색: 양호 = 기존 칩과 같은 중립(D9), 주의 = amber, 취약 = red 계열 텍스트.
- **`aria-label`/`title`**: 모호성 해소(칩 숫자 vs 모달 카운트) + **US5 경계 문장**(D10). 양호일 때 `시나리오 신뢰도: 양호 — 시험이 실패를 감지할 수 있다는 뜻이며, 대상 시스템 성능 평가가 아닙니다. 열기`. 그 외 `시나리오 신뢰도: 주의, 고칠 곳 2개 — 열기`.
- 클릭 → 모달. 상태는 `thinkBoardOpen`(`EditorShell.tsx:35`)과 같은 지역 `useState`.

### 7.2 모달 `TrustBoard` — 나열이 아니라 종합

`ThinkTimeBoard`(`EditorShell.tsx:200`)와 같은 `open`/`onClose` 계약.

```
┌─ 시나리오 신뢰도 ────────────────────────────┐
│  ⚠ 주의   ·   점검 3개 중 1개 통과            │
│  이 점검은 시나리오가 실패를 감지할 수         │
│  있는 시험인지를 봅니다.                      │  ← 상시 부제
│                                              │
│  ✗ 응답 검증이 없는 스텝이 있습니다            │
│      4xx·5xx가 와도 실패로 잡히지 않습니다     │
│      [로그인] [주문 조회]                     │  ← A만 스텝 칩(새 정보)
│  ✗ 추출한 변수 2개를 아무도 쓰지 않습니다      │
│      인증 토큰이 끊겼을 수 있습니다            │
│      변수 패널에서 보기 →                     │  ← C는 개수+링크(기존 표면)
│                                              │
│  ▸ 통과한 점검 1개                            │  ← 기본 접힘
│  ○ 아직 시험 실행으로 확인하지 않았습니다      │  ← D: 등급 미반영, 별도 줄
│      이 브라우저 기준입니다                    │
└──────────────────────────────────────────────┘
```

- **A만** 스텝 칩 + 이동(`select(stepId)` + 모달 닫기 — `ValidationBanner.tsx:13`의 `select` 이디엄).
- **B·C**는 개수 + `변수 패널에서 보기` → 모달을 닫고 변수 패널을 연다. `EditorShell`이 `varsOpen`을 소유하고(`:36`) **세 레이아웃 모두에서** `varsOpen=true`가 패널을 드러내므로(`:147`) 배선 가능.
- **통과·na 항목은 기본 접힘** 한 줄. 사용자 선호(대량 뷰는 opt-in)와 §1.3에 부합.
- **D 줄은 접지 않고 상시 표시한다**(D13). 등급 블록과 시각적으로 분리해 "등급에 반영되지 않음"이 읽히게 하고(중립 아이콘·톤), `never`/`stale`/`verified` 세 문구를 구분해 렌더한다(US4). 한 줄이라 밀도 비용이 없고, 접으면 US4의 "두 상태를 구분해서 본다"가 두 클릭이 된다. `TestRunState`는 `TrustReport`가 아니라 `EditorShell`에서 별도 prop으로 내려온다.
- **양호일 때만** 부제 아래 한 줄 추가(US5·D10):
  > 대상 시스템의 성능이 좋다는 뜻은 아닙니다 — 그건 실행 후 리포트에서 확인하세요.

  상시 부제와 **부분문자열이 겹치지 않게** 쓴다(§8).

**prop 계약**: `TrustBoard` prop = `{ open, onClose, report: TrustReport | null, testRun: TestRunState }`. **`report === null`(§7.4 보류)이면 등급 블록·점검 목록·D 줄을 모두 렌더하지 않고 `YAML 오류를 먼저 해결하세요` 한 줄만 낸다.** 이걸 정해 두지 않으면 구현자가 보류 상태를 표현하려고 가짜 `TrustReport`를 만들어 넘길 수 있고, 그러면 stale 모델 기준 등급이 모달에 떠서 §7.4의 취지가 무너진다.

### 7.3 RunDialog 한 줄

- `level === "good"`이면 **미렌더**. **D는 여기 싣지 않는다**(D19·FR1).
- `scenario`가 `null`이거나 `isTrustApplicable`이 false면 미렌더.
- **B fail 전용 문구 분기(리뷰 C3)**: `weak`이면서 B가 실패면, 등급 단어 대신 **결과를 말한다** — `◈ 이대로 실행하면 시작하자마자 모든 VU가 실패합니다` + `에디터에서 보기`. 확실히 전멸할 run 직전인데 `취약 (1건)`만 보여 주면, US3의 정보가 가장 필요한 순간에 가장 빈약해진다. soft-only(D2)는 유지 — 막지 않고 말만 정확히 한다.
- 그 외: `◈ 시나리오 신뢰도: 주의 (2건)` + `에디터에서 보기` 링크(`/scenarios/{scenarioId}`). `2건` = `failed`.
- **기존 `blockedReasons` Callout(`RunDialog.tsx:1002`) *아래*에 놓는다.** `blockedReasons`는 **제출을 막는** 설정 오류라 먼저 보여야 하고, 신뢰도는 막지 않으며 고치는 자리도 다른 화면이다.
- **RunDialog는 D 경로를 전혀 건드리지 않는다** — `evaluateTrust(scenario)`가 test-run 상태를 받지 않으므로(§3) `testRunStateFor`·`executionFingerprint`·localStorage 읽기가 이 화면에 아예 없다. 폼 입력 키마다 지문 해시를 계산하고 버리는 일이 구조적으로 불가능하다. `evaluateTrust`는 `useMemo([scenario])`로 감싼다.

### 7.4 게이트 상태(`yamlError !== null`)에서의 칩

전제 확인됨: `commitPendingYaml`은 `set({ yamlError: ... })`만 하고 **모델을 일부러 안 갈아끼운다**(`ui/src/scenario/store.ts:419-422`, 주석 "MUST NOT replace model"). 즉 **stale 모델 + yamlError** 상태가 실재한다. 반면 `loadFromString` 실패는 `model: null`이다(`:135-142`).

`collectProblems`가 게이트 시 "모델이 stale이므로 모델-가용 항목을 내지 않는다"고 처리하는 것과 **같은 규약**을 따른다(`problems.ts:12-18`): `yamlError !== null`이면 stale 등급 대신 **판정 보류**(`◈ 신뢰도 · —`, 클릭 시 모달에 "YAML 오류를 먼저 해결하세요").

**검사 우선순위 고정(리뷰 C4)**: ① `yamlError !== null` → 보류 ② `model === null` → 칩 미렌더 ③ `!isTrustApplicable(model)` → 칩 미렌더 ④ 평가. `isTrustApplicable`을 `null` 모델에 호출하지 않도록 이 순서를 지킨다.

**보류 상태에서는 `(미확인)` 접미도 붙이지 않는다** — 판정 자체를 보류한 상태이므로 D 표시만 남기면 일관성이 깨진다. 모달은 `report: null`로 받는다(§7.2 prop 계약).

---

## 8. 문구(ko) 정책

전부 `ui/src/i18n/ko.ts`의 신규 `trust` 네임스페이스. **1차 `validity` 네임스페이스는 손대지 않는다.**

**충돌 회피 의무**: 1차가 이미 `응답 검증(status assert)과 SLO 기준이 없어 성공·실패를 확정할 수 없습니다`를 쓴다(`ko.ts:1050`, 키는 `:1049`). preflight의 A는 §4.1대로 **양화사·스코프·SLO 세 가지가 다르므로** 같은 문구를 쓰면 두 화면이 모순되는 것처럼 보인다. "10스텝 중 9개에 assert" 시나리오에서 서버는 조용하고 preflight는 실패하므로, preflight는 **"검증이 없는 스텝이 있다"**(전칭 위반)로, 서버는 **"검증이 없다"**(존재 부정)로 구분한다.

구현 시 **신규 ko 값 전부를 기존 ko 값 전체와 양방향 부분문자열 대조**한다(신규↔신규만 보면 안 된다 — `thinkboard-defaults`에서 plan의 "충돌 회피됨" 주장이 신규↔기존을 안 봐서 거짓이었다). 대조는 orchestrator가 직접 재실행한다.

**등급 어휘**(1차의 `해석 가능/제한적 해석/해석 주의`와 겹치지 않는다): `good`=`양호`, `caution`=`주의`, `weak`=`취약`.

**두 오독 방어 문구는 부분문자열이 겹치지 않아야 한다** — 겹치면 `toHaveTextContent`가 두 분기 모두에서 통과해 테스트가 공허해진다(`thinkboard-defaults` 4번째 공허 패턴).

- 상시 부제: `이 점검은 시나리오가 실패를 감지할 수 있는 시험인지를 봅니다.`
- 양호 전용: `대상 시스템의 성능이 좋다는 뜻은 아닙니다 — 그건 실행 후 리포트에서 확인하세요.`

**B 문구는 F1 정정을 반영한다** — "조용히 통과" 서사 금지:
- 제목 `만들지 않는 변수를 참조합니다` / 이유 `이대로 부하를 걸면 시작하자마자 모든 VU가 실패합니다`
- RunDialog 전용(§7.3) `이대로 실행하면 시작하자마자 모든 VU가 실패합니다`

**D 문구**: `never`=`아직 시험 실행으로 확인하지 않았습니다` · `stale`=`시험 실행 이후 시나리오가 바뀌었습니다` · `verified`=`현재 내용으로 시험 실행해 확인했습니다` · 보조 `이 브라우저 기준입니다` · 칩 접미 `(미확인)`.

---

## 9. 테스트 전략

### 9.1 `trust.test.ts` — 판정의 심장

- **진리표 §5 전수 7행**. **행 2 vs 행 4**(전무 vs 부분, 둘 다 `C fail`)를 이빨 있는 쌍으로 명시.
- 점검별 경계: A(중첩 컨테이너·parallel 분기 스텝 포함), B(`undefinedVarRefs` 위임), C(공유 행 빌더 위임 — flat 미사용 / 분기 내부 참조만 있는 non-shadow는 **사용됨** / shadow는 namespaced만).
- `na` 분모 제외: extract 없는 시나리오가 `applicable === 2`이고 문구가 `점검 2개 중 …`.
- `failed`가 칩·RunDialog가 쓰는 수와 같은지.

**FR1 회귀 가드는 이제 타입이 진다**(D19): `evaluateTrust(scenario)`에 test-run 인자가 없고 `TrustReport`에 `testRun` 필드가 없으므로, D를 등급에 되살리려면 시그니처를 바꿔야 한다 — 테스트가 아니라 컴파일이 막는다. 런타임 가드는 §9.4의 컴포넌트 단언(칩 접미가 등급·색을 안 바꿈, RunDialog 렌더 여부가 test-run 상태와 무관)이 담당한다.

### 9.2 `varRows.ts` 이동

**tdd-guard 대응(리뷰 C6)**: 루트 CLAUDE.md가 명시하듯 `tdd-guard.sh`는 작업트리에 수정/미추적 테스트 파일이 0건이면 production 편집을 `exit 2`로 막는다 — "테스트 무수정"이 acceptance인 순수 리팩터 task는 **구조적으로 통과 불가**다. 따라서 이 task는 **`varRows.test.ts`를 먼저 만든 뒤** 이동한다(임시 `it.todo` 우회를 쓸 경우 제거를 독립 체크박스 스텝으로 승격).

acceptance: **`VariablesPanel` 기존 테스트가 수정 없이 통과** + 신규 `varRows.test.ts`가 4행 종류를 덮는다.

### 9.3 `executionFingerprint` — 양방향

| 변경 | 지문 |
|---|---|
| 시나리오 `name` / `notes` / 스텝 `name` / 스텝 `id` | **불변** |
| 헤더 키 순서 · `variables` 키 순서 · **JSON 바디 최상위 객체 키 순서** | **불변** |
| **중첩 JSON 객체 키 순서**(재귀 정렬 확인) | **불변** |
| `think_time` / `default_think_time` / `timeout_seconds` | **불변** |
| **`request.disabled`** | **불변** |
| URL·헤더 값·바디 값 변경 | **변함** |
| `assert` 추가 | **변함** |
| **스텝을 `then` → `else`로 이동** | **변함** |
| **`elif[i]` 순서 변경** | **변함** |
| parallel 분기 `name` 변경 | **변함** |
| 스텝 순서 변경 | **변함** |

### 9.4 컴포넌트

- 칩: 등급 3종 문구·`failed` 수 · `(미확인)` 접미가 `testRun !== "verified"`에서만 · **접미가 색·등급을 바꾸지 않음** · `isTrustApplicable` false면 미렌더 · `yamlError` 시 보류(§7.4 우선순위) · **`aria-label`이 양호일 때 경계 문장 포함**(US5).
- 모달: A 스텝 칩 클릭 → `select` + 닫힘 / B·C 링크 → 패널 열림 + 닫힘 / 통과 항목 기본 접힘 / **D 줄은 접힘 없이 상시 렌더되고 3상태를 구분** / **양호 전용 문구가 `good`에만**.
- RunDialog: `good`이면 **미렌더** / `caution`이면 한 줄 + 링크 / **B fail이면 전용 문구** / `blockedReasons` **아래** 순서 / **localStorage에 어떤 test-run 기록이 있어도 렌더 여부가 안 바뀜**(FR1 런타임 가드 — 버킷을 채운 채/비운 채 두 번 렌더해 동일함을 단언).
- **반응성(§6.4)**: test-run 성공 기록 → `testRunEpoch` 증가 → 칩 접미가 사라지는 것을 **페이지 레벨 한 트리**로 렌더해 단언한다. 형제를 따로 렌더하면 이 결함을 재현할 수 없다.
- **`__draft__` 이관(§6.2)**: 드래프트 test-run → 저장 → 새 id로 조회 시 `verified` 유지.

**테스트 하네스(정본 재사용)**: D21로 bare 렌더 테스트는 자동으로 `__draft__` 키를 쓰므로 **버킷 오염 격리가 필수**다. 저장소에 그대로 쓸 정본이 있다 — `ScenarioNotesCallout.test.tsx:36-39`의 `beforeEach(() => { reset(); window.localStorage.clear(); })`, 그리고 "id 있는 키" 경로(이관 테스트)에는 `:23-31`의 `renderWithId`(`MemoryRouter` + `Route path="/scenarios/:id"`). 하네스를 새로 발명하지 말 것.

### 9.5 이빨 실증 의무

회귀 가드를 표방하는 테스트는 **고의 회귀 → RED → 원복 → GREEN**을 실행해 증명한다(메모리 [[plan-mandated-vacuous-tests]]). 최소:

1. 진리표 **행 2 vs 행 4** — 증폭 조건을 `A fail`로 되돌리면 **행 4가 RED**(행 3·5는 무반응이므로 이빨이 아니다).
2. 지문 "불변" 단언 — 제외 필드(`disabled`·`think_time`) 하나를 지문에 넣으면 RED.
3. **중첩 JSON 키 정렬** — 정렬을 최상위로만 한정하면 RED(M4가 막으려는 그 버그).
4. 양호 전용 문구 — 상시 렌더로 바꾸면 RED.
5. 반응성 — `testRunEpoch` 구독을 빼면 RED.
6. `__draft__` 이관 — `adoptDraftBucket` 호출을 빼면 RED.
7. **if 분기 정체성** — 직렬화를 §6.1 근거가 경고한 형태(**분기 구분 없이 `then`·`elif[i].then`·`else` 세 자식 목록을 평탄하게 이어 붙임**)로 되돌리면 "`then`→`else` 이동 → 변함"이 RED. **라벨만 제거하고 배열 구분자를 남기면 RED가 나지 않는다** — `[S1][][S2]`와 `[S1,S2][][]`는 여전히 다르다. 변이는 반드시 **평탄 연결**이어야 두 경우가 `S1S2`로 같아진다.

(D의 등급 누출은 §9.1대로 **타입이 막으므로** 변이 실증 대상이 아니다 — 시그니처를 바꿔야만 재현되고, 그건 컴파일 실패다.)

---

## 10. 라이브 검증 계획

**에디터와 RunDialog 두 진입 화면 모두**에서 확인한다(메모리 [[live-verify-all-mount-paths]]).

| US / 결정 | 확인 |
|---|---|
| US1 | `/scenarios/{id}`·`/scenarios/new` 양쪽 칩 등급 → assert 추가 → 등급 즉시 상승 |
| US2 | 모달 A 스텝 칩 클릭 → 해당 스텝 선택(Inspector 확인) · B/C 링크 → 변수 패널 열림 |
| US3 | RunDialog: `caution` → 한 줄 / `good` → **미노출** / `blockedReasons`와의 순서 |
| **FR1 회귀** | **test-run을 한 번도 안 한 상태의 `good` 시나리오**에서 RunDialog가 **아무것도 안 띄우는 것** — D가 등급에 새면 여기서 잡힌다 |
| US4 | 새 시나리오에서 `(미확인)` + **모달을 열어** `never` 확인(다른 시나리오를 test-run한 뒤에도 `never`) → test-run 성공 → **새로고침 없이** 접미 사라짐 → 스텝 **이름만** 변경 → 여전히 `verified` → URL 변경 → 접미 재등장 + **모달을 열어** `stale` 확인. **칩만 보면 `never`와 `stale`이 둘 다 `(미확인)`으로 같으므로, "구분해서 본다"는 모달을 열어야 증명된다** |
| **FR2** | 드래프트에서 test-run → **저장** → 새 id 화면에서 `verified` 유지(접미 없음) |
| US5 | 전 점검 통과 시나리오에서 양호 전용 문구 + 칩 `aria-label` 경계 문장, `caution`에서 미노출 |
| D16 | **전 스텝이 실패하는 test-run**(존재하지 않는 포트) → `verified`로 **기록되지 않음** |
| C3 | B가 실패하는 시나리오로 RunDialog → **전멸 예고 문구**가 뜨는지 |

test-run 실행이 필요하므로 `/live-verify` 스택(워크트리 자체 바이너리 + responder)을 띄운다. **포트 8080은 피한다**(다른 프로세스 점유 가능 — 죽이기 전 `ps` 확인).

---

## 11. 알려진 한계 (수용)

1. **브라우저 로컬**: D는 `localStorage` 기반이라 다른 기기·다른 사람에겐 `never`다. **그래서 등급에 넣지 않았다**(D19) — 등급은 누가 보든 같아야 한다. 문구에 "이 브라우저 기준"을 명시. 팀 공유가 필요해지면 서버 영속으로 승격(ADR-0049가 이 경로를 기록).
   - **귀결(의도된 산출물)**: 시나리오를 만든 사람이 아닌 브라우저에서는 칩 접미 `(미확인)`가 **영구 표시**된다. 이건 버그가 아니라 D19의 정직한 결과다 — 그 브라우저는 실제로 확인한 적이 없다. **후속 세션이 이걸 결함으로 오인해 "고치지" 말 것**: 접미를 없애려면 검증 상태를 서버로 올려야 하고(별 슬라이스), 등급에 섞어 해결하려 하면 FR1이 재발한다.
2. **해시 충돌**: FNV-1a 32bit, 시나리오당 5개 버킷이라 무시할 수준이나 0은 아니다. 충돌하면 미검증을 `verified`로 오판한다. soft 신호라 수용.
3. **`__draft__` 버킷 공유**: 저장 안 된 새 시나리오들이 한 버킷을 쓴다. 드래프트 A를 test-run한 뒤 저장 없이 드래프트 B를 만들면 B는 `stale`로 뜬다. 저장 시 이관되므로(§6.2) 저장된 시나리오에는 전이되지 않는다.
4. **데이터셋 바인딩 미반영**: 데이터셋 행만 바꿔 test-run해도 지문은 그대로다.
5. **A와 1차 `no_response_validation`의 판정이 다를 수 있다** — 의도된 차이이고 문구로 가른다(§8).
6. **점검 억제(opt-out) 없음**(D18): 워밍업/teardown처럼 정당하게 assert 없는 스텝이 하나만 있어도 A는 영구 실패하고 등급이 `주의`로 고정된다. 그럼에도 만들지 않는다 — "검증 없는 스텝"을 침묵시키는 장치는 이 에픽이 싸우는 대상을 **정확히** 숨긴다. 실사용에서 이 고정이 실제 마찰이 되면 그때 근거를 갖고 재검토한다.
7. **`undefinedVarRefs`의 의도된 false-negative 상속**: 같은 parallel 노드 안 `{{B.v}}` 참조를 정의됨으로 본다(`scanVars.ts:289-291`).
8. **값이 틀린 변수**는 못 잡는다. 정적 분석의 한계이며 그게 D(test-run)가 들어간 이유다.

---

## 12. 파일 영향 요약

| 파일 | 성격 |
|---|---|
| `ui/src/scenario/trust.ts` | **신규** — 판정 순수 함수 (§3~§5) |
| `ui/src/scenario/varRows.ts` | **신규** — `VariablesPanel.tsx:123-172` 빌더 + `VarRow` 타입(`:27-51`) 순수 이동 (§4.4) |
| `ui/src/scenario/trustPrefs.ts` | **신규** — 지문 해시 시나리오별 버킷 + `adoptDraftBucket` (§6.2) |
| `ui/src/components/scenario/TrustBoard.tsx` | **신규** — 모달 (§7.2) |
| `ui/src/components/scenario/VariablesPanel.tsx` | 빌더·타입을 import로 교체(렌더 byte-identical) |
| `ui/src/components/scenario/EditorShell.tsx` | 칩 +1, 모달 마운트, `varsOpen` 배선, `testRunEpoch` 구독, `TrustReport`/`TestRunState` `useMemo`, **`useParams`로 `scenarioKey` 획득**(D21) |
| `ui/src/components/scenario/TestRunSection.tsx` | **`useParams`로 `scenarioKey` 획득**(D21 — prop 아님), `fire()` 시점 지문 스냅샷(파싱 실패 시 스킵), `ok && !truncated`면 `recordVerified` + epoch 증가 |
| `ui/src/pages/ScenarioNewPage.tsx` | 저장 `onSuccess`에서 `navigate` **이전에** `adoptDraftBucket(created.id)` (§6.2) |
| `ui/src/scenario/store.ts` | `testRunEpoch` 추가 (§6.4) |
| `ui/src/components/RunDialog.tsx` | 조건부 한 줄 + B fail 전용 분기 (§7.3) |
| `ui/src/i18n/ko.ts` | `trust` 네임스페이스 |
| `docs/adr/0049-*.md` | **신규 ADR** — 신뢰도 판정 축 + 검증 상태를 등급과 분리한 결정 |
| 서버·proto·migration·엔진 | **0-diff** |
