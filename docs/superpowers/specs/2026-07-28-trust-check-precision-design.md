# trust 점검 정밀화 — B 위치 인식·이름 운반 + C 선언-충돌 blind spot

> §A11 도그푸딩 관측 후 코드 후속 (scenario-preflight spec §11.9·§11.10 잔여 한계 해소 + 신규 발견 1건).
> 유형: **correctness-bug** ×3. UI-only, 서버·proto·migration **0-diff**.
> 전신: `2026-07-25-scenario-preflight-design.md` (ADR-0049). 이 문서는 그 spec의 어휘(점검 A/B/C/D, D1~D21, 진리표)를 그대로 상속한다.

### 리뷰 반영 이력

- **1차 리뷰(APPROVE-WITH-FIXES) 반영, 2026-07-28**: F1 `checkBFailWhyCond`에 `이대로 부하를 걸면` 조건절 복원(무조건형은 바인딩-공급 run에서 새 거짓 단정 — US1과 같은 클래스) · F2/C6 §4.2 단조성 조건을 `overwrittenByFlat` 기준으로 정정+전이 3종·분모 변화·"순수 미사용 선언은 C 밖" 명시 · F3 증폭 규칙 경유 `caution→weak` 등급 이동 명시 · R1 `bFailMode` null 폴백=`checkBFailWhy` 확정+입력 계약 중립화 · R2/미정5 `vars` 필수+픽스처 갱신 노트 · C1/C2 P9 각주 대상 확장(전신 §4.2·§8·§5 축① 라벨) · C3 US2 기대를 관찰 조건으로 재작성 · C4 P5 두 갈래 분리 · C5 §6 충돌 서술을 실측으로 교체(신규↔신규 25자 코어가 진짜 위험) · F4 `executor.rs` 인용 4곳(`:137,140,172,177`)으로 교체 · F5 US1의 `runner.rs` 서술 교정(`select_branch:1532`) · F6 점-이름 위험 근거 교체 · R3 라이브 US1 시나리오 모양 고정+`if_breakdown` 증거 · R4/R5 §9 한계 2건 추가. 기각 0건.

## 사용자 스토리 (US)

전부 correctness-bug — 재현/기대/실측 형식(US 스파인 대체 경로).

**US1 — B 문구가 cond-only 미정의 변수에서 거짓 단정 (이 슬라이스 착수 중 신규 발견)**
- 재현: QA가 `if` 조건에만 미정의 `{{seg}}`를 쓰는 시나리오에서 신뢰도 모달 또는 RunDialog(바인딩 없음)를 연다.
- 기대: 실제 결과를 말하는 안내 — 조건이 빈 값으로 평가되어 의도한 분기를 타지 않고, run은 실패 없이 끝나 결함이 숨는다는 것.
- 실측: "이대로 부하를 걸면 시작하자마자 모든 VU가 실패합니다"(`ko.ts:1568`) — **거짓**. 엔진 조건 평가는 lenient(`crates/engine/src/condition.rs:1-7`이 `render_lenient` 사용, 분기 결정은 `select_branch`(`runner.rs:1532`)가 `eval_condition`(`:1536,1547`)으로)라 미해결 변수는 `""`가 되고 run은 completed로 끝난다. 반면 URL/헤더/바디는 strict `render`(`executor.rs:137`(url)·`:140`(헤더)·`:172`(form)·`:177`(raw))라 전멸 단정이 참. → **위치별 문구 분기 필요**. 거짓 단정을 본 사용자가 run 완주를 목격하면 신뢰도 기능 자체를 불신하게 된다(자기부정).

**US2 — 바인딩 있는 RunDialog에서 cond-only 미정의 변수가 등급 한 줄로 약화 (§11.9)**
- 재현: QA가 위 시나리오에 무관한 데이터셋 바인딩(예: `username` 열만 공급)을 더해 RunDialog에서 제출한다.
- 기대: 무관한 바인딩이 있어도 경고가 등급 한 줄로 **약화되지 않고** 결과를 말하는 문구(오분기)가 유지된다 — 그리고 매핑으로 `seg`를 실제 공급하면 그때 등급 한 줄로 완화된다(억제가 "바인딩 존재"가 아니라 "공급 여부"를 따라 움직이는 것이 관찰 조건). soft 유지 — 제출은 막지 않는다(D2).
- 실측: `시나리오 신뢰도: 취약 (1건)` 등급 한 줄(`RunDialog.tsx:1056-1059`의 `bindings.length === 0` 분기) — 바인딩이 실제로 그 변수를 공급하는지 무관하게 문구가 같고, `DataBindingPanel`의 `bindingBlock`도 cond를 안 스캔해(`scanFlowVars`, `scanVars.ts:62-76`) 제출이 그대로 허용된다.

**US3 — C 점검이 선언-이름 충돌 dangling extract를 못 봐 두 표면이 모순 (§11.10)**
- 재현: QA가 `variables`에 `token`을 선언하고 어떤 스텝이 `token`을 extract하지만 아무도 `{{token}}`을 참조하지 않는 시나리오에서 신뢰도 모달을 연다.
- 기대: C 점검이 "추출한 변수 1개를 아무도 쓰지 않습니다"로 실패 — 변수 패널의 `미사용` 배지와 같은 신호.
- 실측: C는 na("추출한 변수가 없어 점검할 것이 없습니다") — `varRows.ts:62-64`가 선언과 겹치는 flat extract 행을 만들지 않아(`!declaredKeys.has(name)` 필터) `trust.ts:69-71`의 C 판정 모집단에서 빠진다. 같은 변수에 변수 패널은 `미사용`(`usageCell`, `VariablesPanel.tsx:122`) + amber `추출 덮어씀` 배지를 붙인다. 두 표면이 모순 신호를 낸다.

---

## 1. 문제와 목표

### 1.1 전신 spec의 사실 오류 (US1의 뿌리)

scenario-preflight spec §4.2는 "B는 **이대로 부하를 걸면 시작하자마자 run이 전멸한다**"로 일반화했고 §11.9는 "실제로는 strict cond 렌더에서 죽는다"고 썼다. 요청 표면(url/헤더/바디)에는 참이지만 **cond 오퍼랜드에는 거짓**이다:

- `crates/engine/src/condition.rs:1-7` — "Uses the **lenient** template resolver (`render_lenient`) so unresolved variables become `""`". `runner.rs:18`이 이 `eval_condition`을 import해 if 분기를 결정한다.
- 귀결: cond-only 미정의 변수가 있는 run은 죽지 않는다. 조건이 매 반복 `""`로 평가되어 **조용히 한쪽 분기로 쏠린 부하**가 completed·초록으로 끝난다 — 이 에픽이 싸우는 "거짓 초록"의 정확한 사례이면서, 현재 문구는 반대 방향(전멸)의 거짓 단정을 낸다.

B 판정 자체는 cond 참조를 이미 센다(`buildVarRefIndex`/`undefinedVarRefs`가 cond 오퍼랜드를 수집 — `scanVars.ts:124-127`·`:400-404`). 판정은 옳고 **문구만 위치를 몰라 거짓말한다**.

### 1.2 §11.9 — RunDialog 게이트가 이름이 없어 정밀할 수 없다

`RunDialog.tsx:1056-1059`는 B fail 시 `bindings.length === 0`일 때만 전멸 단정을 내고, 바인딩이 있으면 등급 한 줄로 내린다. 그 위 주석(`:1049-1055`)은 "바인딩이 있는데도 미매핑 변수가 남으면 bindingBlock이 제출까지 막으므로 사용자가 모르는 채 실행할 길은 없다"고 주장하지만, **cond-only 변수는 `scanFlowVars`가 안 봐서 bindingBlock에 안 걸린다** — 무관한 바인딩 하나로 경고가 등급 한 줄로 약해진 채 제출이 허용된다. 정밀 게이트에는 "바인딩이 공급하는 변수 집합 ⊇ 미정의 변수 집합"의 차집합이 필요하고, 그건 B의 변수 **이름**이 `TrustReport`에 실려야 가능하다(D14가 의도적으로 withhold — 이 spec이 **운반만** 완화하고 표시는 불변).

### 1.3 §11.10 — C의 선언-이름 충돌 blind spot

`varRows.ts:62-64`의 flat-extract 행 생성은 `!declaredKeys.has(name)` 필터를 거치므로, 선언 변수와 이름이 겹치는 dangling extract는 `declared` 행(+`overwritten: true`)으로만 존재한다. `trust.ts:69-71`의 C 판정 모집단은 `flat-extract`/`parallel-extract` 행뿐이라 이 경우 C가 na로 떨어지고, 변수 패널은 같은 행에 `미사용` 배지를 붙여 두 표면이 모순된다. (parallel 쪽은 blind spot이 아니다 — `parallelVarIdentities` 행은 선언과 무관하게 항상 생성되고 shadow 플래그로 충돌을 표시한다.)

### 1.4 목표

1. B fail의 문구가 위치 클래스(요청 표면 = 전멸 / cond-only = 조용한 오분기)에 따라 **참인 결과**를 말한다 — 에디터 모달·RunDialog 공통 (US1).
2. RunDialog의 B 억제가 "바인딩 존재 여부"가 아니라 "바인딩이 실제로 그 변수들을 공급하는가"로 판정된다 (US2).
3. C가 선언-이름 충돌 dangling extract를 세고, 변수 패널과 신호가 일치한다 (US3).

### 1.5 비목표

- `DataBindingPanel`/`scanFlowVars` 변경 없음 — cond 스캔 추가(하드 차단화)는 기각: US1(문구 거짓)을 못 고치고, cond 변수가 매핑 seed 행으로 떠 8c false-alarm 클래스 재발 위험, soft(D2) 성격과 다른 계층. 필요 시 후속.
- 에디터 `checkBFailWhy`에 바인딩 컨텍스트 주입 없음 — 전신 spec §11.9의 경고 유지(에디터에는 run context가 없고 "이대로"는 문자 그대로 참). 에디터 문구는 **위치 분기만** 한다.
- 등급 진리표(§5) 불변 — cond-only B fail도 `weak` 유지(사용자 확정 2026-07-28). 조용한 오분기는 전멸보다 더 기만적인 거짓 초록이므로 가드 강도를 유지한다. 축① 근거 서술만 "돌지 않는다"→"의도대로 돌지 않는다"로 일반화해 읽는다(코드·판정 무변경).
- D 경로(지문·localStorage·`testRunStateFor`) 무접촉 (D19).
- §11.6(A opt-out)·§11.11(false-stale) 연기 유지 — 도그푸딩 마찰 미관측(2026-07-28 확인).
- 서버·proto·migration 0-diff.

---

## 2. 핵심 결정

| # | 결정 | 값 | 이유 |
|---|---|---|---|
| P1 | 위치 판정 위치 | **`undefinedVarRefs` walker에 additive** (`UndefinedRef.hasStrictRef`) | walker가 record 시점에 http arm(요청 표면)인지 if arm(cond)인지 이미 안다(`scanVars.ts:387` vs `:404`). trust.ts 자체 walk(규칙 두 벌 = D15가 막으려던 병)·별도 스캐너 신설 기각 |
| P2 | 이름 운반 | `TrustCheck`에 B 전용 `vars: Array<{name; strict}>` additive. **표시는 불변**(개수+링크, D14 유지) | 게이트에 이름이 필요하다는 것과 이름을 나열한다는 것은 다르다. 밀도 규율(§1.3 1급) 유지 |
| P3 | 문구 분기 판정 | **공유 헬퍼 `bFailMode(vars)`** — strict 하나라도 → `"annihilation"`, 전부 cond → `"misroute"`, 빈 배열 → `null` | TrustBoard·RunDialog가 같은 술어를 쓰게(사본 2벌이면 두 표면 문구가 갈라질 수 있다 — D15와 같은 클래스) |
| P4 | 혼합 케이스 | strict 하나라도 있으면 전멸 문구 | 전멸이 더 급하고 더 확실한 결과다. cond 오분기는 그 다음 문제 |
| P5 | RunDialog 게이트 | `uncovered = B.vars − 바인딩 공급 이름` — 비면 등급 한 줄(현행 억제 유지), 있으면 `bFailMode(uncovered)`로 문구 | "바인딩 존재"는 프록시였고 "공급 여부"가 본질. 두 갈래를 구분하라: ① `bindings.length===0`이면 uncovered=전체라 현행 동작에 수렴(단 cond-only면 이제 정직한 misroute 문구 — US1) ② **바인딩이 있으나 그 변수를 안 공급하면 의도적 행동 변화** — 등급 한 줄이 아니라 전멸/misroute 문구(이게 US2의 본체) |
| P6 | C 모집단 확장 | `declared ∧ overwrittenByFlat ∧ refIds 빈` 행을 C 실패로 추가 카운트, na 조건 동반 확장 | 그 행의 런타임 실체는 "추출했는데 아무도 안 쓰는 변수" — 패널이 `미사용`을 붙이는 그 조건과 일치(D15 정신) |
| P7 | `overwrittenByFlat` | `varRows` declared 행에 additive(= `flatEx.has(name)`), 기존 `overwritten` 불변 | namespaced-overwrite(선언명에 점, 예 `B.v`)를 제외해 **이중 카운트 방지** — 그 경우 parallel-extract 행이 이미 세고 있다. 패널은 새 필드를 안 읽으므로 렌더 byte-identical |
| P8 | RunDialog 문구에 변수 이름 미노출 | 이름은 게이트 로직에만 쓰고 카피는 기존 한 줄 형태 유지 | 밀도 규율. 고치는 자리는 에디터(링크로 이동)다 |
| P9 | 전신 spec 정정 | `2026-07-25-…-design.md`의 **4곳**에 정정/해소 각주 1줄씩 (docs-only): §11.9(strict-cond 거짓 주장)·§11.10(해소됨)·**§4.2 blockquote**(":181"의 "run이 전멸한다" 일반화 — 거짓의 뿌리)·**§8 F1 문단**(":429"의 "'조용히 통과' 서사 금지" — cond 경로에선 이 spec으로 supersede)+**§5 축① 라벨**(":230" "돌지 않는다" → "의도대로 돌지 않는다" 일반화 각주) | 알려진-거짓 주장을 방치하면 후속 세션이 신뢰한다(이번에 실제로 일어날 뻔한 일). 뿌리(§4.2)를 비껴가면 P9 자신의 근거와 모순 |

---

## 3. 데이터 모델 (additive)

```ts
// scanVars.ts
export type UndefinedRef = {
  stepIds: string[];
  candidates: string[];
  kind: "downstream" | "sibling";
  /** 신규: 위반 참조 중 하나라도 http 요청 표면(url/헤더/바디 — strict 렌더)에 있으면 true.
   *  false = 전부 if/elif cond 오퍼랜드(lenient — run은 완주, 분기 오분류). */
  hasStrictRef: boolean;
};

// trust.ts
export interface TrustCheck {
  id: TrustCheckId;
  status: TrustCheckStatus;
  steps: Array<{ id: string; name: string }>;   // A 전용 (불변)
  count: number;
  /** 신규: B 전용 — 미정의 변수 이름 + 위치 클래스(문서 등장순). A·C는 항상 빈 배열.
   *  UI 나열용이 아니다(D14 유지) — RunDialog 게이트(P5)와 문구 분기(P3)의 입력.
   *  **필수 필드**(optional 아님) — 구성 사이트 전수 갱신을 컴파일러가 강제(R2). */
  vars: Array<{ name: string; strict: boolean }>;
}

/** P3 공유 술어. **빈 입력이면 null** — 의미는 호출부가 정한다(게이트로 쓴다):
 *  TrustBoard는 `c.vars`를 넘기므로 null ≈ B pass이지만 폴백을 §5.1이 정의하고,
 *  RunDialog는 `uncovered`를 넘기므로 null = "바인딩이 전부 공급"(B는 여전히 fail일 수 있다). */
export function bFailMode(
  vars: Array<{ name: string; strict: boolean }>,
): "annihilation" | "misroute" | null;
```

- `hasStrictRef` 구현: `undefinedVarRefs`의 `record`(`scanVars.ts:331-345`)에 `strict: boolean` 인자 추가 — http arm의 `judge` 호출(`:387`)은 true, if arm의 cond `judge` 호출(`:404`)은 false를 전파. 누적자에 `sawStrict` 하나 추가. `kind`/`candidates`/`stepIds` 산출 로직 불변.
  - **`judge` 내부의 예외 1곳**: namespaced(점 포함) ref의 `record(name, stepId, false, null)`(`:365`)도 호출자에게서 받은 strict를 그대로 전파한다(namespaced 정책 분기는 sibling/downstream 축의 일이지 위치 축과 무관).
- `vars` 산출: `evaluateTrust`의 B 분기(`trust.ts:60-66`)에서 `undef` 맵을 `[...undef].map(([name, r]) => ({ name, strict: r.hasStrictRef }))`로 변환 — 순서는 맵 삽입순(= walker가 위반 참조를 처음 만난 순서, 결정론). `count = undef.size` 불변.
- `evaluateTrust`는 여전히 순수 함수·test-run 상태 무접촉(D19 불변).

## 4. 판정 변경

### 4.1 B — 판정 불변, 운반만 추가

fail/pass 조건·count·등급 기여 전부 불변. `vars`만 추가 운반.

### 4.2 C — 모집단 확장 (P6·P7)

```
extractRows      = rows.filter(kind ∈ {flat-extract, parallel-extract})       // 기존
overwrittenDecl  = rows.filter(kind === declared ∧ overwrittenByFlat)          // 신규
applicable(na 아님) ⟸ extractRows.length + overwrittenDecl.length > 0
unused           = [...extractRows, ...overwrittenDecl].filter(refIds.length === 0)
fail ⟸ unused.length > 0 ; count = unused.length
```

- overwrittenDecl은 순수 추가 항(flat-extract 행과 declared 행은 `!declaredKeys.has(name)` 필터로 상호배타)이라 변화는 **단조**다. 허용 전이 3종: **`na→pass`**(선언-충돌 extract가 참조됨 — applicable/passed 분모가 2→3으로 늘어 모달 `점검 N개 중 M개 통과`·접힘 라벨 숫자도 바뀐다, 의도됨) / **`na→fail`**(= US3 본체) / **`pass→fail`**(기존 extract 행이 전부 참조돼 pass였어도 선언-충돌 dangling이 있으면 fail — US3의 일반형, count 증가 포함). **`overwrittenByFlat` 행이 하나도 없는 시나리오만 판정·count·분모 완전 불변**.
- **등급 파급(의도됨)**: 위 `na→fail`/`pass→fail` 전이는 §5 증폭 규칙(`noValidationAtAll ∧ C fail → weak`)을 경유해 기존 시나리오의 등급을 **`caution`(진리표 행 3) → `weak`(행 2)** 로 올릴 수 있다. 진리표는 A/B/C status의 함수로서 불변이고, 입력(C status)이 정확해진 결과다.
- **순수 미사용 선언은 C 밖으로 유지한다**: 패널의 `미사용` 배지는 `refIds.length===0`인 모든 행(참조 없는 순수 `declared` 행 포함)에 붙지만, C는 그중 `overwrittenByFlat`인 것만 센다 — 안 쓰는 선언은 "끊긴 추출 체인"이 아니다. 후속 세션이 "패널과의 일관성"을 이유로 전체 declared를 C에 넣지 말 것.
- shadow parallel-extract 행 처리 불변(오늘도 refIds 빈 shadow 행은 카운트된다).
- `checkCFailTitle`("추출한 변수 N개를 아무도 쓰지 않습니다")·`checkCNa`·`checkCFailWhy` 카피는 확장 후에도 참이라 불변.

## 5. UI 표면

### 5.1 TrustBoard — B fail why 분기 (US1)

`TrustBoard.tsx:11-15`의 정적 `FAIL_WHY` Record에서 B만 `bFailMode(c.vars)`에 따라: `"annihilation"` → 기존 `checkBFailWhy` / `"misroute"` → 신규 `checkBFailWhyCond` / **`null` → `checkBFailWhy` 폴백**(방어 — 프로덕션 `evaluateTrust`에선 B fail ⟺ vars 비지 않음이지만, 손-구성 리포트가 fail+빈 vars면 빈 문구가 나가선 안 된다). A·C·FAIL_TITLE·PASS/NA·스텝 칩·링크·접힘·D 줄 전부 불변.

### 5.2 RunDialog — 정밀 게이트 (US1·US2)

`RunDialog.tsx:1044-1070` Callout의 문구 선택을 교체:

```
supplied  = new Set(bindings.flatMap(b => b.mappings.map(m => m.var)))   // column·literal 공통
bVars     = trust.checks에서 undefined_vars의 vars
uncovered = bVars.filter(v => !supplied.has(v.name))
mode      = bFailMode(uncovered)
문구: mode === "annihilation" → runDialogBFail (기존)
      mode === "misroute"     → runDialogBFailCond (신규)
      mode === null            → runDialogLine(등급, failed) (기존)
```

- `useMemo` deps `[trust, bindings]`. 렌더 게이트(`trust && trust.level !== "good"`)·Callout 형태·`에디터에서 보기` 링크·soft(제출 비차단) 전부 불변.
- `:1049-1055`의 거짓 주석("사용자가 모르는 채 실행할 길은 없다")을 새 판정 근거로 교체.
- `bindings.length === 0` → supplied 빈 집합 → uncovered = bVars 전체 → 기존 동작에 수렴(단, cond-only면 이제 정직한 misroute 문구 — US1의 RunDialog 측).
- 등급 자체는 여전히 시나리오 텍스트에 대한 판정(D4)이라 불변 — 바인딩이 전부 공급해도 `취약 (1건)` 한 줄은 남는다(현행과 동일).

## 6. 문구(ko) — 신규 2키

`ko.ts` `trust` 네임스페이스에 추가. **아래가 확정 문안이다**(리뷰·구현에서 바꾸려면 §6 의무의 대조를 다시 돌리고 이 spec을 갱신):

- `checkBFailWhyCond`: `이대로 부하를 걸면 조건이 빈 값으로 평가되어 의도한 분기를 타지 않습니다 — run은 실패 없이 끝나 결함이 숨습니다`
- `runDialogBFailCond`: `이대로 실행하면 조건이 빈 값으로 평가되어 의도한 분기를 타지 않습니다`

**`이대로 부하를 걸면` 조건절은 필수다**(1차 리뷰 F1): 에디터에는 run context가 없고, 전신 spec §11.9가 에디터 문구를 억제하지 않는 유일한 근거가 이 조건절("'이대로'는 문자 그대로 참")이다. 무조건형으로 쓰면 데이터셋 열이 그 변수를 공급하는 run에서 새 거짓 단정이 된다 — 이 슬라이스가 고치려는 그 클래스.

**충돌 대조 실측(1차 리뷰 C5에서 리뷰어가 직접 재실행, 문안 확정 후 구현에서 재확인 의무)**: 신규 2키는 기존 ko 값 전체와 상호 포함 관계 없음(포함되는 것은 `분기`·`조건` 같은 단어 라벨뿐 — 무해). **진짜 위험은 신규↔신규**: 두 안이 25자 코어 `조건이 빈 값으로 평가되어 의도한 분기를 타지 않습니다`를 공유하므로 `toHaveTextContent(코어)`는 어느 키가 렌더돼도 통과한다(잘못된 키를 배선해도 green). → 단언 규칙: **전체일치 정규식 `/^…$/`** 또는 키별 고유 조각(`checkBFailWhyCond`의 꼬리 `— run은 실패 없이 끝나 결함이 숨습니다` / `runDialogBFailCond`의 접두 `이대로 실행하면 조건이`)으로만 단언(§7에 반영).

## 7. 테스트 전략

- **`scanVars.test.ts`** — `hasStrictRef` 4케이스: 요청-표면-only(true) / cond-only(false) / 혼합(true) / sibling-분기(위치 축과 kind 축 독립 확인). 기존 케이스는 필드 추가 외 무수정 green이어야 함(판정 불변의 증거).
- **`trust.test.ts`** — B `vars` 운반(이름·순서·strict) · `bFailMode` 진리표(빈/전부 cond/혼합/전부 strict) · C 확장 4케이스: 선언-충돌 dangling(fail·count) / 선언-충돌이지만 참조됨(pass) / overwrittenDecl만 있고 extract 행 없음(na 아님) / 선언명에 점(namespaced overwrite)은 **비카운트**(이중 카운트 방지 — parallel-extract 행이 센다).
- **`varRows.test.ts`** — `overwrittenByFlat` additive(flat 충돌 true / namespaced-only 충돌 false / 무충돌 false). `VariablesPanel` 기존 테스트 무수정 green(렌더 byte-identical 증거).
- **`TrustBoard.test.tsx`** — B fail why 2분기 + null 폴백. `ko.*` 보간 단언은 자기참조 함정(공허 11호) 회피 — 두 분기를 **서로의 문구 부재**로 교차 단언하되, §6의 25자 코어 공유 때문에 단언은 전체일치 또는 키별 고유 조각으로만. **기존 `WEAK` 픽스처(`:35-46`)를 포함해 손-구성 리포트 픽스처는 `vars`를 실제 값으로 채운다**(`vars` 필수화로 `pnpm build`가 강제 — 방치하면 빈 vars가 null 폴백 경로만 태워 분기 테스트가 공허해진다).
- **`RunDialog.trust.test.tsx`** — 게이트 3분기: uncovered 빈(등급 한 줄) / uncovered에 strict(전멸) / uncovered 전부 cond(misroute). + 부분 공급 케이스(바인딩이 일부만 공급 → uncovered 잔여로 판정). 기존 `bindings.length === 0` 전제 테스트 갱신. 문구 단언은 §6 겹침 때문에 전체일치 정규식 또는 키별 고유 조각(§6에 키별로 명시)으로.
- **이빨 실증 의무(전신 §9.5 계승)**: 회귀 가드 표방 테스트는 고의 회귀(예: `hasStrictRef` 전파를 상수 true로, C의 overwrittenDecl 항 제거, RunDialog uncovered를 `bindings.length===0`로 되돌림) → RED → 원복 → GREEN을 실증.
- 전체 게이트: `pnpm lint && pnpm test && pnpm build` (게이트 판정은 파이프 없이 exit 명시 캡처).

## 8. 라이브 검증 계획 (US 앵커)

`/live-verify` 스택(워크트리 자체 바이너리 + 격리 DB + responder).

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | cond-only 미정의 `{{seg}}` 시나리오 생성 — **모양 고정(1차 리뷰 R3)**: if **밖** 무조건 http 1개(요청 발생 보장) + `then`/`else` 양쪽에 서로 다른 http(else 없으면 lenient 평가가 `none` 분기로 떨어져 요청 0건이 정상이 된다 — `runner.rs:1541-1545`) → 에디터 모달·RunDialog(바인딩 없음) 문구 확인 → **실제 run 실행** | 모달·RunDialog에 misroute 문구(전멸 문구 부재), run이 `completed`·무조건 http의 요청 발생 + **리포트 `if_breakdown`(ADR-0023)이 의도와 반대 분기(`else`)를 셈** — misroute의 직접 실증 |
| US1' | 같은 시나리오의 URL을 `{{ghost}}`로 바꿔 run | 전멸 문구 표시 + run `failed`(`all VUs failed`) — strict 분기 대조 실증 |
| US2 | US1 시나리오 + 무관 열만 있는 데이터셋 바인딩 → RunDialog | misroute 문구(등급 한 줄 아님)·제출은 허용(soft) — 이어서 매핑으로 `seg` 공급 시 등급 한 줄로 완화 |
| US3 | `variables.token` 선언 + `token` extract + 무참조 시나리오 → 에디터 모달 | C가 fail(개수 1)·"변수 패널에서 보기" 링크로 패널 `미사용` 행과 신호 일치 |

## 9. 알려진 한계 (수용)

1. **strict 판정은 참조 위치 기준이지 실행 도달성 기준이 아니다**: `if false` 분기 안 요청 표면의 미정의 변수도 `strict`로 분류돼 전멸 문구가 뜨지만 실제로는 그 분기가 안 돌면 안 죽는다. 정적 분석의 한계(전신 §11.8과 같은 클래스)이고, 조언("만들지 않는 변수를 참조하지 말라")은 여전히 유효하다.
2. **cond 오분기 문구는 방향까지 말하지 않는다**: `""`가 어느 분기로 떨어지는지는 연산자에 따라 다르다(`!=`면 then이 참이 될 수도). "의도한 분기를 타지 않습니다"는 이 불확정성을 포괄하는 표현이다.
3. **`vars`는 운반되지만 나열되지 않는다**(P2·P8): 어떤 변수인지는 변수 패널(⚠ 행)이 보여 준다 — 두 표면 재나열은 D14 기각 사유 그대로.
4. **선언명이 점을 포함하면서 flat extract와도 충돌하는 극단 케이스**(선언 `B.v` + flat extract `B.v`): `overwrittenByFlat` true라 카운트되는데, 그 이름이 동시에 parallel `B`/`v` 조합과도 겹치면 이론상 이중 카운트 가능. 점 든 flat 이름의 위험은 parallel 네임스페이스 충돌로 이미 문서화·비권장(`scanVars.ts:289-293`의 declared-limit 주석)이고 soft 신호라 수용. **bare 변종도 같은 수용**: 같은 이름이 flat extract와 parallel 분기 extract 양쪽에 있고 아무도 안 쓰면 declared(`overwrittenByFlat`) 행 + parallel-extract(shadow) 행 = count 2 — 이름은 하나지만 추출 지점이 실제로 둘이므로 수용(단 `추출한 변수 2개` 카피와의 긴장은 인지).
5. **전신 spec §11.9의 나머지 절반(제출 허용)은 그대로다**: cond-only 미정의 변수는 여전히 `bindingBlock`에 안 걸려 제출된다 — 이 슬라이스는 soft 경고를 정직하게 만들 뿐 하드 게이트를 신설하지 않는다(§1.5 기각 근거).
6. **빈 리터럴 매핑도 "공급"으로 센다**(1차 리뷰 R4): `DataBindingPanel`은 `value: ""`인 literal 매핑도 emit하고 bindingBlock도 막지 않으므로, cond-only 변수에 빈 리터럴을 매핑하면 uncovered가 비어 misroute 경고가 억제되는데 런타임 결과는 정확히 misroute다. 엔진 관점에선 `""` 공급이 실제로 일어나는 것이라(변수는 정의됨) B의 "미정의" 판정 축과 다른 문제(값 품질)이고, soft 신호라 수용.

## 10. 파일 영향 요약

| 파일 | 성격 |
|---|---|
| `ui/src/scenario/scanVars.ts` | `UndefinedRef.hasStrictRef` additive + walker `record`/`judge` strict 전파 |
| `ui/src/scenario/trust.ts` | `TrustCheck.vars` additive · B 분기 운반 · C 모집단 확장 · `bFailMode` 신규 export |
| `ui/src/scenario/varRows.ts` | declared 행 `overwrittenByFlat` additive |
| `ui/src/components/scenario/TrustBoard.tsx` | B fail why 분기 |
| `ui/src/components/RunDialog.tsx` | uncovered 게이트 + 주석 교체 |
| `ui/src/i18n/ko.ts` | `trust` 네임스페이스 신규 2키 |
| `docs/superpowers/specs/2026-07-25-scenario-preflight-design.md` | §4.2·§5 축① 라벨·§8 F1 문단·§11.9·§11.10 정정/해소 각주 (docs-only, P9) |
| 테스트 5파일 (§7) | scanVars·trust·varRows·TrustBoard·RunDialog.trust |
| 서버·proto·migration·엔진·`VariablesPanel`·`DataBindingPanel`·`trustPrefs`·`EditorShell` | **0-diff** |
