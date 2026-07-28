# trust 점검 정밀화 — B 위치 인식·이름 운반 + C 선언-충돌 blind spot

> §A11 도그푸딩 관측 후 코드 후속 (scenario-preflight spec §11.9·§11.10 잔여 한계 해소 + 신규 발견 1건).
> 유형: **correctness-bug** ×3. UI-only, 서버·proto·migration **0-diff**.
> 전신: `2026-07-25-scenario-preflight-design.md` (ADR-0049). 이 문서는 그 spec의 어휘(점검 A/B/C/D, D1~D21, 진리표)를 그대로 상속한다.

### 리뷰 반영 이력

(작성 시점 — 아직 없음)

## 사용자 스토리 (US)

전부 correctness-bug — 재현/기대/실측 형식(US 스파인 대체 경로).

**US1 — B 문구가 cond-only 미정의 변수에서 거짓 단정 (이 슬라이스 착수 중 신규 발견)**
- 재현: QA가 `if` 조건에만 미정의 `{{seg}}`를 쓰는 시나리오에서 신뢰도 모달 또는 RunDialog(바인딩 없음)를 연다.
- 기대: 실제 결과를 말하는 안내 — 조건이 빈 값으로 평가되어 의도한 분기를 타지 않고, run은 실패 없이 끝나 결함이 숨는다는 것.
- 실측: "이대로 부하를 걸면 시작하자마자 모든 VU가 실패합니다"(`ko.ts:1568`) — **거짓**. 엔진 조건 평가는 lenient(`crates/engine/src/condition.rs:1-7`이 `render_lenient` 사용, `runner.rs:18`이 그 `eval_condition`을 호출)라 미해결 변수는 `""`가 되고 run은 completed로 끝난다. 반면 URL/헤더/바디는 strict(`executor.rs:87`)라 전멸 단정이 참. → **위치별 문구 분기 필요**. 거짓 단정을 본 사용자가 run 완주를 목격하면 신뢰도 기능 자체를 불신하게 된다(자기부정).

**US2 — 바인딩 있는 RunDialog에서 cond-only 미정의 변수가 등급 한 줄로 약화 (§11.9)**
- 재현: QA가 위 시나리오에 무관한 데이터셋 바인딩(예: `username` 열만 공급)을 더해 RunDialog에서 제출한다.
- 기대: 바인딩이 `seg`를 공급하지 않음을 아는 정확한 경고(cond 오분기 귀결 포함). soft 유지 — 제출은 막지 않는다(D2).
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
| P5 | RunDialog 게이트 | `uncovered = B.vars − 바인딩 공급 이름` — 비면 등급 한 줄(현행 억제 유지), 있으면 `bFailMode(uncovered)`로 문구 | "바인딩 존재"는 프록시였고 "공급 여부"가 본질. `bindings.length===0`이면 uncovered=전체라 현행과 동일하게 수렴 |
| P6 | C 모집단 확장 | `declared ∧ overwrittenByFlat ∧ refIds 빈` 행을 C 실패로 추가 카운트, na 조건 동반 확장 | 그 행의 런타임 실체는 "추출했는데 아무도 안 쓰는 변수" — 패널이 `미사용`을 붙이는 그 조건과 일치(D15 정신) |
| P7 | `overwrittenByFlat` | `varRows` declared 행에 additive(= `flatEx.has(name)`), 기존 `overwritten` 불변 | namespaced-overwrite(선언명에 점, 예 `B.v`)를 제외해 **이중 카운트 방지** — 그 경우 parallel-extract 행이 이미 세고 있다. 패널은 새 필드를 안 읽으므로 렌더 byte-identical |
| P8 | RunDialog 문구에 변수 이름 미노출 | 이름은 게이트 로직에만 쓰고 카피는 기존 한 줄 형태 유지 | 밀도 규율. 고치는 자리는 에디터(링크로 이동)다 |
| P9 | 전신 spec 정정 | `2026-07-25-…-design.md` §11.9·§11.10에 정정/해소 각주 1줄씩 (docs-only) | 알려진-거짓 주장을 방치하면 후속 세션이 신뢰한다(이번에 실제로 일어날 뻔한 일) |

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
   *  UI 나열용이 아니다(D14 유지) — RunDialog 게이트(P5)와 문구 분기(P3)의 입력. */
  vars: Array<{ name: string; strict: boolean }>;
}

/** P3 공유 술어. vars가 비면 null(B pass — 호출부가 게이트로 쓴다). */
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

- overwrittenDecl은 순수 추가 항(flat-extract 행과 declared 행은 `!declaredKeys.has(name)` 필터로 상호배타)이라 변화는 **단조**다: 기존 fail은 fail 유지(count는 늘 수 있음), 기존 pass·na는 선언-충돌 dangling이 있을 때만 fail로 이동 — 그게 이 fix의 목적(US3의 일반형). 선언-충돌 dangling이 없는 시나리오는 판정·count 완전 불변.
- shadow parallel-extract 행 처리 불변(오늘도 refIds 빈 shadow 행은 카운트된다).
- `checkCFailTitle`("추출한 변수 N개를 아무도 쓰지 않습니다")·`checkCNa`·`checkCFailWhy` 카피는 확장 후에도 참이라 불변.

## 5. UI 표면

### 5.1 TrustBoard — B fail why 분기 (US1)

`TrustBoard.tsx:11-15`의 정적 `FAIL_WHY` Record에서 B만 `bFailMode(c.vars)`에 따라: `"annihilation"` → 기존 `checkBFailWhy` / `"misroute"` → 신규 `checkBFailWhyCond`. A·C·FAIL_TITLE·PASS/NA·스텝 칩·링크·접힘·D 줄 전부 불변.

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

- `checkBFailWhyCond`: `조건이 빈 값으로 평가되어 의도한 분기를 타지 않습니다 — run은 실패 없이 끝나 결함이 숨습니다`
- `runDialogBFailCond`: `이대로 실행하면 조건이 빈 값으로 평가되어 의도한 분기를 타지 않습니다`

의무(전신 spec §8 계승): **신규 2키 ↔ 기존 ko 값 전체 양방향 부분문자열 대조**를 orchestrator가 직접 재실행. 특히 기존 `checkBFailWhy`/`runDialogBFail`과 접두·접미가 겹치지 않게(겹치면 `toHaveTextContent` 분기 테스트가 공허해진다 — thinkboard-defaults 4번째 패턴). 위 두 안은 `이대로 실행하면`을 `runDialogBFail`과 공유하므로 **전체일치 정규식 또는 뒤쪽 고유 문자열로 단언**할 것을 테스트 전략에 명시(§7).

## 7. 테스트 전략

- **`scanVars.test.ts`** — `hasStrictRef` 4케이스: 요청-표면-only(true) / cond-only(false) / 혼합(true) / sibling-분기(위치 축과 kind 축 독립 확인). 기존 케이스는 필드 추가 외 무수정 green이어야 함(판정 불변의 증거).
- **`trust.test.ts`** — B `vars` 운반(이름·순서·strict) · `bFailMode` 진리표(빈/전부 cond/혼합/전부 strict) · C 확장 4케이스: 선언-충돌 dangling(fail·count) / 선언-충돌이지만 참조됨(pass) / overwrittenDecl만 있고 extract 행 없음(na 아님) / 선언명에 점(namespaced overwrite)은 **비카운트**(이중 카운트 방지 — parallel-extract 행이 센다).
- **`varRows.test.ts`** — `overwrittenByFlat` additive(flat 충돌 true / namespaced-only 충돌 false / 무충돌 false). `VariablesPanel` 기존 테스트 무수정 green(렌더 byte-identical 증거).
- **`TrustBoard.test.tsx`** — B fail why 2분기. `ko.*` 보간 단언은 자기참조 함정(공허 11호) 회피 — 두 분기를 **서로의 문구 부재**로 교차 단언(`annihilation` 렌더에 `checkBFailWhyCond` 부재, 역방향 동일).
- **`RunDialog.trust.test.tsx`** — 게이트 3분기: uncovered 빈(등급 한 줄) / uncovered에 strict(전멸) / uncovered 전부 cond(misroute). + 부분 공급 케이스(바인딩이 일부만 공급 → uncovered 잔여로 판정). 기존 `bindings.length === 0` 전제 테스트 갱신. 문구 단언은 §6 겹침 때문에 전체일치 또는 고유 접미로.
- **이빨 실증 의무(전신 §9.5 계승)**: 회귀 가드 표방 테스트는 고의 회귀(예: `hasStrictRef` 전파를 상수 true로, C의 overwrittenDecl 항 제거, RunDialog uncovered를 `bindings.length===0`로 되돌림) → RED → 원복 → GREEN을 실증.
- 전체 게이트: `pnpm lint && pnpm test && pnpm build` (게이트 판정은 파이프 없이 exit 명시 캡처).

## 8. 라이브 검증 계획 (US 앵커)

`/live-verify` 스택(워크트리 자체 바이너리 + 격리 DB + responder).

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | cond-only 미정의 `{{seg}}` 시나리오 생성 → 에디터 모달·RunDialog(바인딩 없음) 문구 확인 → **실제 run 실행** | 모달·RunDialog에 misroute 문구(전멸 문구 부재), run이 `completed`·요청 발생(전멸 아님을 실측 — 문구 진실성의 증거) |
| US1' | 같은 시나리오의 URL을 `{{ghost}}`로 바꿔 run | 전멸 문구 표시 + run `failed`(`all VUs failed`) — strict 분기 대조 실증 |
| US2 | US1 시나리오 + 무관 열만 있는 데이터셋 바인딩 → RunDialog | misroute 문구(등급 한 줄 아님)·제출은 허용(soft) — 이어서 매핑으로 `seg` 공급 시 등급 한 줄로 완화 |
| US3 | `variables.token` 선언 + `token` extract + 무참조 시나리오 → 에디터 모달 | C가 fail(개수 1)·"변수 패널에서 보기" 링크로 패널 `미사용` 행과 신호 일치 |

## 9. 알려진 한계 (수용)

1. **strict 판정은 참조 위치 기준이지 실행 도달성 기준이 아니다**: `if false` 분기 안 요청 표면의 미정의 변수도 `strict`로 분류돼 전멸 문구가 뜨지만 실제로는 그 분기가 안 돌면 안 죽는다. 정적 분석의 한계(전신 §11.8과 같은 클래스)이고, 조언("만들지 않는 변수를 참조하지 말라")은 여전히 유효하다.
2. **cond 오분기 문구는 방향까지 말하지 않는다**: `""`가 어느 분기로 떨어지는지는 연산자에 따라 다르다(`!=`면 then이 참이 될 수도). "의도한 분기를 타지 않습니다"는 이 불확정성을 포괄하는 표현이다.
3. **`vars`는 운반되지만 나열되지 않는다**(P2·P8): 어떤 변수인지는 변수 패널(⚠ 행)이 보여 준다 — 두 표면 재나열은 D14 기각 사유 그대로.
4. **선언명이 점을 포함하면서 flat extract와도 충돌하는 극단 케이스**(선언 `B.v` + flat extract `B.v`): `overwrittenByFlat` true라 카운트되는데, 그 이름이 동시에 parallel `B`/`v` 조합과도 겹치면 이론상 이중 카운트 가능. flat extract 변수명에 점을 쓰는 것 자체가 비권장(cast 함정 문서화 존재)이고 soft 신호라 수용.
5. **전신 spec §11.9의 나머지 절반(제출 허용)은 그대로다**: cond-only 미정의 변수는 여전히 `bindingBlock`에 안 걸려 제출된다 — 이 슬라이스는 soft 경고를 정직하게 만들 뿐 하드 게이트를 신설하지 않는다(§1.5 기각 근거).

## 10. 파일 영향 요약

| 파일 | 성격 |
|---|---|
| `ui/src/scenario/scanVars.ts` | `UndefinedRef.hasStrictRef` additive + walker `record`/`judge` strict 전파 |
| `ui/src/scenario/trust.ts` | `TrustCheck.vars` additive · B 분기 운반 · C 모집단 확장 · `bFailMode` 신규 export |
| `ui/src/scenario/varRows.ts` | declared 행 `overwrittenByFlat` additive |
| `ui/src/components/scenario/TrustBoard.tsx` | B fail why 분기 |
| `ui/src/components/RunDialog.tsx` | uncovered 게이트 + 주석 교체 |
| `ui/src/i18n/ko.ts` | `trust` 네임스페이스 신규 2키 |
| `docs/superpowers/specs/2026-07-25-scenario-preflight-design.md` | §11.9·§11.10 정정/해소 각주 (docs-only, P9) |
| 테스트 5파일 (§7) | scanVars·trust·varRows·TrustBoard·RunDialog.trust |
| 서버·proto·migration·엔진·`VariablesPanel`·`DataBindingPanel`·`trustPrefs`·`EditorShell` | **0-diff** |
