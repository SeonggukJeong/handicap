# parallel 분기 변수 스코프 (슬라이스 8a) — 설계

- **날짜**: 2026-07-19
- **슬라이스**: parallel-var-scope (8a — 진단·엔진 병합. 원클릭 수정은 8b로 분리)
- **유형**: `correctness-bug`
- **관련 ADR**: ADR-0033(parallel·`{{branch.var}}` key-origin merge), ADR-0014, ADR-0022(데이터셋 바인딩). **신규 ADR 불필요** — 결함 2는 ADR-0033 규약에 대한 *conformance* 버그(규약 자체 불변), 결함 1·3은 진단이다. 중첩 parallel 재귀를 **하지 않기로** 했으므로 `B.inner.v` 다층 네임스페이스 문제도 발생하지 않는다(§3.2).

> **리뷰 이력**: spec-plan-reviewer 1차 `APPROVE-WITH-FIXES` → F1–F4·R1·R3–R6·C1–C5 반영, **원클릭 수정(구 §2.3)을 8b로 분리**(R2/R3 동반 이관 → 현 §7). 2차 `APPROVE-WITH-FIXES`(8a는 전건 검증 통과, 신규 §4만 지적) → G1–G8 반영: 수용 문자열 정정(`template:` 접두사)·캡처를 `Aborted` 게이트 안으로·`Arc<OnceLock>`·open-loop 기술 정정·라이브 결정성 고정·run-생성-시 검증을 §7 후보로. **양 라운드 기각 0건**(모든 finding이 코드 대조로 확인됨).

---

## 사용자 스토리 (US)

**US1** (correctness-bug): QA가 에디터에서 parallel 분기 extract를 그 뒤 스텝에 `{{token}}`이라 적었을 때, 아무 경고가 없어 부하 run이 통째로 `all VUs failed`로 죽는다 — 성공하면 변수 패널이 그 참조를 **미정의 ⚠로 표시하고 올바른 이름 `{{auth.token}}`을 제시**한다.

**US2** (correctness-bug): parallel 분기 **안에 loop/if를 넣어** 변수를 추출한 시나리오(YAML/API 저작)로 run을 돌렸을 때, 규약대로 `{{auth.token}}`을 써도 값이 비어 잘못된 요청이 나간다 — 성공하면 중첩 extract도 병합되어 `final_vars`에 `auth.token`이 나타나고 요청에 실제 값이 실린다.

> **US2 경로 주의(리뷰 R6)**: 이 시나리오는 UI Zod 게이트(`model.ts:210` `steps: z.array(HttpStepModel)`)가 막아 **에디터로 열리지 않는다**(`parseScenarioDoc` 실패 → 검증 배너). 즉 US2의 가치는 "에디터 저작"이 아니라 **run이 올바르게 도는 것**이고, 검증 경로는 `POST /api/test-runs`/`/api/runs`다. 분기 안 컨테이너의 **UI 저작 개방은 명시적 비목표**(§7).

**US3** (correctness-bug): QA·개발자가 **에디터를 거치지 않고**(YAML 모달·`curl`·HAR) 만든 시나리오로 run을 돌렸을 때 실패 사유가 `all VUs failed (2/2)`뿐이라 원인을 못 찾는다 — 성공하면 run `message`가 **첫 실패 원인을 표본으로 덧붙여** `all VUs failed (2/2): template: unknown variable token`이 되어, UI 없이도 고칠 지점을 안다.

> **"첫 실패 원인" = 표본이지 대표값이 아니다(리뷰 G6)**: 캡처는 시간순 첫 non-`Aborted` 원인이라, 한 VU가 몇 ms 먼저 connect timeout을 맞고 나머지가 `UnknownVar`를 맞으면 메시지는 timeout을 지목한다. 그래서 US3의 약속은 "원인 **지목**"이 아니라 **"첫 실패 원인 제시"**다(문구도 그렇게 쓴다). 진단 가치는 "아무 정보 없음 → 표본 1건"의 차이에서 나온다.

### 재현 / 기대 / 실측 (2026-07-19 실측, 워크트리 `parallel-var-scope`)

controller `--rest 127.0.0.1:8099` + python echo responder `127.0.0.1:9111`(`{"id":"ID-<PATH>"}`).

**결함 1 — 다운스트림 bare 참조**
- **재현**: 분기 `auth`의 http가 `$.id → token` 추출 → 최상위 다음 스텝 `…/use?t={{token}}`.
- **기대**: 에디터가 `{{token}}`을 미정의로 표시(엔진은 ADR-0033대로 `auth.token`만 노출).
- **실측**: 에디터 경고 **0건**(`scanVars.ts:151` `collectProducedVars`가 `flattenHttpSteps`[`model.ts:268-270`]로 분기까지 하강해 bare `token`을 "생산됨"으로 등록) · 부하 run **`status=failed`, `message="all VUs failed (2/2)"`**(원인 미언급) · test-run `ok:true`인데 URL `…/use?t=`(빈 값), `unbound_vars:["token"]`, `final_vars={"auth.token":"ID-AUTH"}`.

**결함 2 — 분기 안 중첩 컨테이너의 extract**
- **재현**: 분기 `auth` 안 `loop(repeat:1)` → 그 안 http가 `token` 추출 → 다운스트림 **올바른** `{{auth.token}}`.
- **기대**: 병합·해석.
- **실측**: `final_vars={}` — extract는 실행됐는데(`extracted:{"token":"ID-AUTH"}`) 병합 **0건**, `{{auth.token}}`조차 `unbound_vars`. 서버도 이 YAML을 accept.
- **원인**: `output_var_names()`(`scenario.rs:165-175`)가 분기 **최상위 `Step::Http`만** 순회. `Branch.steps: Vec<Step>`(`scenario.rs:158`)는 자유 중첩 허용.

**결함 3 — 실패 원인 소실**
- **재현**: 위 결함 1 시나리오로 closed-loop run.
- **기대**: 어느 변수가 미해결인지 run에서 확인 가능.
- **실측**: `message="all VUs failed (2/2)"`뿐. 원인 `EngineError::UnknownVar("token")`은 `runner.rs:209`에서 WARN 로그로만 나가고 `AllVusFailed{failed,total}`(`error.rs:14`)에 **안 실린다** → 워커 `e.to_string()`(`worker/lib.rs:651`)에도 원인 없음.

---

## 1. 범위와 방향

세 결함은 증상이 같다("분기 변수를 못 쓴다"). 따로 고치면 재발 신고가 반복되므로 함께 닫는다.

**방향(사용자 승인 2026-07-19)**:
- 결함 1 = **에디터가 잡아준다**(경고·힌트). 엔진 `{{branch.var}}` 규약 불변 — 엔진/proto/와이어 0-diff.
- 결함 2 = **엔진이 재귀 병합**(loop/if만 — §3.2).
- 결함 3 = **run 실패 메시지에 원인**. 저작 경로 무관하게 모두 커버.

**서버측 저장-시 400 거부는 기각**: 데이터셋 바인딩(ADR-0022)이 시나리오에 없는 변수를 **run-config 시점에** 주입하므로, 시나리오만 보는 검증은 데이터셋 기반 시나리오를 전부 거절한다. 진단(결함 3)이 안전한 대안.

**비목표**: 저장 차단(미정의는 비차단 advisory 유지) · 분기 안 컨테이너의 UI 저작 · 중첩 parallel 병합 · 원클릭 수정(→ 8b) · 변수 merge/재연결 rename.

---

## 2. 결함 1 — 에디터 스코프 인식 미정의 판정

### 2.1 현재 규칙 (틀림)

```
undefinedVars = refs − collectProducedVars − collectNamespacedProducers
```

`collectProducedVars`가 분기까지 하강해 분기 extract의 **bare 이름이 전역으로 샌다** → 위치 무관하게 bare가 "정의됨". `scanVars.test.ts:606`이 이 관대함을 "분기 내부 bare는 collectProducedVars가 해소(conservative)"로 문서화했는데, 의도(분기 **내부** 오탐 방지)는 옳지만 집합이 전역이라 **다운스트림**까지 면제된다.

### 2.2 새 규칙 (위치 인식)

엔진 실제 가시성(`runner.rs:595-658` 실측 확인)을 모델링한다. 각 참조를 **그 참조가 있는 위치** 기준으로 판정:

| # | 참조 위치 | 해석 가능한 이름 |
|---|---|---|
| 1 | parallel 노드 N의 분기 B 서브트리 **안** | 선언 키 ∪ flat extract ∪ **B 자신의** extract (bare) |
| 2 | 그 외(최상위·비-parallel loop/if 내부) | 선언 키 ∪ flat extract (bare) |
| 3 | 모든 위치 | namespaced `X.v` ∈ `collectNamespacedProducers` — **단 §2.2.2 한계** |

근거(엔진):
- 분기는 parallel **진입 시점** vars를 본다 — `let entry = iter_vars.clone()`(`runner.rs:598`) → `let mut branch_vars = entry.clone()`(`:605`). ⇒ 행 1의 "선언 ∪ flat extract" 항.
- **형제 분기 출력은 안 보인다** — 분기마다 독립 clone, 병합은 `join_all` **이후**(`:648-658`). ⇒ 형제 분기 bare 참조를 새로 잡는 건 **정탐 추가**(오탐 아님).
- loop/if는 새 스코프를 안 만든다(`Step::If` arm이 `ctx`를 그대로 전달) ⇒ 분기 안 loop/if 내부 extract도 `branch_vars`에 bare로 남는다.

**구현 함정(리뷰 지적 — 반드시 명시)**: 행 1의 "B 자신의 extract"를 계산하는 walker는 **분기 서브트리를 재귀**해야 한다(분기 안 loop/if 포함). 최상위 http만 보면 loop-in-branch 안의 bare 참조가 전부 **오탐**이 된다 — 이건 결함 2와 *같은 실수*를 UI에서 반복하는 것이다(`scenario.rs:165`가 그 실수의 원본).

**`flatExtractNames`는 선언 키를 포함하지 않는다**(`scanVars.test.ts:713`이 고정). §2.2.1이 그 함수 변경을 금지하므로 **선언 키 union은 새 walker 안에서** 수행한다.

**순서 무감 유지**: "뒤 스텝이 추출할 변수를 앞에서 참조"는 지금도 안 잡는다 — 이 축은 **건드리지 않는다**(새 오탐 유입 방지).

### 2.2.1 `collectProducedVars`는 건드리지 않는다 (blast-radius)

"분기를 하강하지 않게 한다"는 수정은 **금지**. 이 함수는 서로 다른 의미로 3곳이 쓴다(직접 grep 확인):

| 소비처 | 용도 | 분기 extract 포함이 옳은가 |
|---|---|---|
| `store.ts:175` | rename 충돌 집합 | **예** — 분기 bare와도 충돌해야 안전 |
| `DataBindingPanel.tsx:308` | "다른 곳에서 채워짐" | **예** — 분기 extract도 채움 |
| `VariablesPanel.tsx:70` | flat-extract 행 열거 | **예** — 현행 행 구성 유지 |

⇒ **`collectProducedVars`·`flatExtractNames`·`parallelExtractNames`·`collectNamespacedProducers`·`parallelVarIdentities`·`collectBranchInternalRefs`는 전부 불변.** 교체 대상은 `undefinedVars` 하나 — 소비처는 **프로덕션 1곳**(`VariablesPanel.tsx:12`/`:73`) **+ 테스트 1파일**(`scanVars.test.ts:10`/`:604`/`:621`)이다. `ui/tsconfig.json`의 `include: ["src"]`라 테스트도 `tsc -b` 대상이므로 export 제거 시 **둘 다 같은 커밋에서** 처리해야 한다(plan Task 4).

### 2.2.2 알려진 한계 — 같은 노드 안의 namespaced 참조 (비플래그)

병합이 `join_all` **이후**라 `{{auth.token}}`을 **그 parallel 노드의 어느 분기 안에서든**(분기 `auth` 자신 포함) 참조하면 런타임에 미해결이다(`UnknownVar` → `AllVusFailed`). 행 3은 이 경우를 **잡지 않는다** — 8a는 bare 축만 닫고, 이건 **선언된 한계**로 §7에 남긴다(결함 3의 메시지 개선이 최소한 진단은 해준다). 행 3을 "그 노드 밖"으로 좁히는 건 8b 후보.

### 2.3 반환 계약 (리뷰 R1)

같은 이름이 한 위치에선 유효하고 다른 위치에선 미정의일 수 있으므로(`{{s}}`가 분기 안 **그리고** 다운스트림) `Set<string>`으로는 표현 불가. 현 소비처는 `refIds: refIndex.get(name) ?? []`(`VariablesPanel.tsx:106`)라 **정당한 분기 내부 참조까지** 미정의 행의 usage 팝오버가 가리키게 된다.

⇒ `undefinedVars`를 다음으로 **교체**한다:

```ts
undefinedVarRefs(scenario): Map<string, { stepIds: string[]; candidates: string[] }>
```

- `stepIds` = **문제가 되는 참조의** 문서순 stepId만(정당한 위치의 참조는 제외).
- `candidates` = 그 bare 이름을 추출하는 **분기명** 배열(문서순·dedup). 힌트·행 구성의 단일 소스.
- 혼합 위치 이름은 **미정의 행 1개**만 만들고 `stepIds`엔 위반 참조만 담는다.
- `VariablesPanel`의 미정의 행 `refIds`는 `refIndex.get(name)`이 아니라 **이 `stepIds`**를 쓴다.

### 2.4 표면 (VariablesPanel)

미정의 ⚠ 행에 `candidates` 기반 분기:

| `candidates` | 표시 | "선언 추가" 버튼 |
|---|---|---|
| 1개 | "parallel 분기 `auth`에서 추출됨 — `{{auth.token}}`으로 참조하세요" | **숨김** (§2.4.1) |
| 2개 이상 | 후보 나열 — "`auth`, `cart`에서 추출됨 — `{{분기명.token}}` 형태로 참조하세요" | **숨김** |
| 0개 | 현행 그대로(오타·미선언) | **유지** |

**형제 분기 참조**(분기 A 안에서 B의 extract를 bare로): `candidates`에 B가 잡히지만 `{{B.v}}`도 그 안에선 안 통하므로(§2.2.2) 전용 문구 — "형제 분기의 값은 참조할 수 없습니다(동시 실행)". 8a엔 수정 버튼 없음.

문구는 전부 `ko.ts` 경유(ADR-0035).

### 2.4.1 기존 "선언 추가" 버튼과의 충돌 (리뷰 R4 — 조용한 부하 왜곡)

미정의 행엔 **이미** 원클릭 "선언 추가"(`ko.editor.variableDeclareAddAria`, editor-var-conflict-quickadd R5–R8)가 있어 `variables[name] = ""`를 넣는다. 이 슬라이스가 다운스트림 bare를 새로 점등시키는 순간, 그 버튼은 사용자에게 **`token: ""` 선언**을 권하게 된다 → ⚠는 사라지고 run은 `…/use?t=`를 **성공적으로** 보낸다. 경고를 켜서 오히려 **조용한 잘못된 부하**를 만드는 역효과 — [[load-divergence-explain-confirm]] 클래스다.

⇒ **`candidates.length >= 1`이면 그 행의 "선언 추가"를 숨긴다**(빈 선언이 정답인 경우가 없다). `candidates`가 0이면 현행 유지. 이 규칙은 §5 변경 표면에 포함되고 전용 회귀 테스트로 고정한다.

---

## 3. 결함 2 — 엔진 재귀 병합

### 3.1 walker

`output_var_names()`가 분기 서브트리를 재귀:

| 자식 | 처리 |
|---|---|
| `Http` | extract var 이름 (현행) |
| `Loop` | `do` 재귀 |
| `If` | `then` · `elif[].then` · `else` 재귀 |
| `Parallel`(중첩) | **재귀하지 않음** — §3.2 |

**시그니처 `Vec<&str>` 불변** ⇒ 호출부·테스트 churn 0.

**전체 호출부(직접 grep 확인 — 이게 전부)**: `runner.rs:652`, `trace.rs:471`(둘 다 `for k in …` 루프, 조정 불요), 단위 테스트 `scenario.rs:1248`(`assert_eq!(…, vec!["id","code"])`, **불변**). 호출부 조정이 0이므로 **컴파일러가 완성도를 보장하지 않는다** — 재귀 walker 자체의 정확성은 **테스트로만** 지켜진다(§6.1).

**lockstep 필수**: `runner.rs`(부하·`join_all` 동시)와 `trace.rs`(test-run·순차)는 병합 의미가 byte-identical이어야 한다(engine CLAUDE.md). walker가 `scenario.rs` 한 곳이라 자동 공유되지만, 양쪽 테스트로 고정한다.

**엔진만 변경** — proto·워커·컨트롤러·migration 0-diff. 중첩 컨테이너 없는 시나리오는 **byte-identical**.

### 3.2 중첩 parallel을 재귀하지 않는 이유 (리뷰 R5)

분기 안 parallel은 **UI가 표현 불가**(`model.ts:210` `z.array(HttpStepModel)`)라 raw API로만 도달하고, UI 저작 개방은 §7 비목표다. 재귀하면 안쪽 병합이 만든 `inner.v`를 노출해 **`B.inner.v` 다층 네임스페이스**가 생기는데 ADR-0033은 분기명 1단 prefix만 규정하므로 ADR 수정이 따라온다 — 도달 불가 경로를 위해 규약을 넓히는 건 비용이 크다. **명시적 비목표**로 §7에 남긴다(현행대로 조용히 누락 — 알려진 한계).

## 4. 결함 3 — 실패 원인 전파

`AllVusFailed`가 첫 원인을 싣는다.

**변경 사이트(직접 grep 확인)**:

| 위치 | 내용 |
|---|---|
| `error.rs:14` | `AllVusFailed { failed, total }` → `+ cause: Option<String>`, `#[error]`에 조건부 접미 (아래 이디엄) |
| `runner.rs:209-210` | closed-loop VU 실패 — **`Aborted` 게이트 *안***(`if !matches!(e, EngineError::Aborted)`)에서 `e`를 슬롯에 캡처 |
| `runner.rs:847-848` | vu-curve VU 실패 — 동일 |
| `runner.rs:321` | closed-loop 구성 — `cause` 채움 |
| `runner.rs:940` | vu-curve 구성 — `cause` 채움 |
| `worker/lib.rs:708` | 테스트 구성부 — 필드 추가 |
| `tests/all_vus_failed.rs:54` | `{ failed, total }` 구조분해 → `{ failed, total, .. }` |

**`#[error]` 조건부 접미 이디엄**: `thiserror` 1.x는 trailing format 인자를 지원하므로 **손수 `Display` impl을 쓰지 말 것**(다른 variant 포맷을 조용히 잃는다):

```rust
#[error("all VUs failed ({failed}/{total}){}", .cause.as_ref().map(|c| format!(": {c}")).unwrap_or_default())]
AllVusFailed { failed: u32, total: u32, cause: Option<String> },
```

**캡처 위치 주의(리뷰 G3)**: `failed.fetch_add`가 있는 `:212`/`:850`은 `Aborted` 게이트 **밖**이다 — 거기 넣으면 사용자 abort까지 "실패 원인"으로 잡힌다. 반드시 `:209-210`/`:847-848` 게이트 안.

**단 이 배치는 방어적이며 오늘은 관측 불가(plan 리뷰 후속)**: cancel 시 `runner.rs:314`(closed)/`:928`(curve)가 `AllVusFailed` 구성 **전에** `Err(Aborted)`로 조기 반환하므로, 게이트 밖에 둬도 도달 가능한 모든 입력에서 출력이 같다 ⇒ **런타임 테스트로 지킬 수 없다**(그런 테스트를 쓰면 실제로는 `Err(Aborted)`를 단언하게 되어 잘못된 배치도 통과하는 false-PASS). 게이트 안에 두는 근거는 그 조기 반환이 미래에 재정렬·제거될 때의 안전이고, 보호 수단은 테스트가 아니라 **캡처 지점의 코드 주석**이다.

**변경 불요(grep 완전성 감사용)**: `runner.rs:278`·`:888`은 `JoinError`(태스크 패닉)라 `EngineError` 아님 — 캡처 대상 아님. `tests/vu_curve.rs:235`는 이미 `AllVusFailed { .. }`라 무변경. `tests/if_node.rs:220`은 doc 주석. **struct variant에 필드 추가는 명시적 구조분해만 깨뜨리므로 `grep AllVusFailed`가 완전성 오라클이다.**

**슬롯 타입**: `Arc<OnceLock<String>>`(리뷰 G4 — VU 태스크가 `tokio::spawn`이라 owned 핸들 필요, 기존 `failed: Arc<AtomicU32>`와 동형). 쓰기는 `let _ = slot.set(e.to_string());`(첫 쓰기 승자). 읽기(`:321`/`:940`)는 JoinSet 드레인 완료(`:275-280`/`:885-890`) **이후**라 happens-before가 성립 — torn/missed read 없음.

전파는 기존 `e.to_string()`(`worker/lib.rs:651`) → gRPC → `failure_message`(`coordinator.rs:1186`, 워커 raw 메시지를 비어있지 않으면 그대로 사용) → `runs.message` 경로를 그대로 타므로 **새 와이어·proto·migration 0**. `truncate_message`(`coordinator.rs:1176`, `MESSAGE_MAX_CHARS=1000`)를 통과하지만 이 길이엔 충분.

**open-loop 비대칭(정책은 비목표·§7)**: 정정 — `run_arrival`은 에러를 **전파**한다(`runner.rs:1460` `.await?;`). 삼키는 곳은 **호출부 `runner.rs:1352`** (`Err(e) => warn!(vu_id, error = ?e, "arrival failed")`)로, `:209-210`과 **구조적으로 동일한 WARN 사이트**다. 결과적으로 open-loop은 `failed` 카운터도 `AllVusFailed` 구성도 없어 run 실패도 진단도 없다. ⇒ **진단 절반(원인 캡처)은 값싸지만, "몇 %의 arrival 실패가 run 실패인가"라는 정책 결정이 남아** 이 슬라이스 밖이다(§7).

---

## 5. 변경 표면 요약

| 레이어 | 파일 | 변경 |
|---|---|---|
| 엔진 | `crates/engine/src/scenario.rs` | `output_var_names()` 재귀(Http/Loop/If) — 시그니처 불변 |
| 엔진 | `crates/engine/src/error.rs` | `AllVusFailed.cause` 추가 + Display |
| 엔진 | `crates/engine/src/runner.rs` | 원인 캡처 2곳(**`:209-210`/`:847-848` — `Aborted` 게이트 *안***, §4 주의) + 구성 2곳(`:321`/`:940`) |
| 엔진 | `crates/worker/src/lib.rs` (테스트), `crates/engine/tests/all_vus_failed.rs` | 필드 추가 대응 |
| UI | `ui/src/scenario/scanVars.ts` | **새** 위치 인식 walker + `undefinedVars` → `undefinedVarRefs` 교체 (다른 export 6종 불변) |
| UI | `ui/src/components/scenario/VariablesPanel.tsx` | 미정의 행: `stepIds` 사용 · 분기 힌트 · "선언 추가" 조건부 숨김 |
| UI | `ui/src/i18n/ko.ts` | 문구 |

**0-diff**: proto · controller · migration · `schemas.ts` · `yamlDoc.ts`(8a엔 **쓰기 경로 변경 없음**) · run payload · UI Zod 모델.

---

## 6. 검증

### 6.1 자동

**엔진**
- 분기 안 loop / if(then·elif·else) extract가 `{{B.v}}`로 병합 — **부하·trace 양쪽**.
- 비중첩 분기 병합 결과 불변(회귀).
- 중첩 parallel은 여전히 미병합(§3.2 한계 고정 — 의도 명시 테스트).
- `AllVusFailed.cause`가 `UnknownVar` 이름을 담고 `to_string()`이 정확히 `all VUs failed (1/1): template: unknown variable token` — **`vus: 1` 단일 원인** 시나리오로(리뷰 G6: 다중 VU는 어느 원인이 먼저인지 비결정 → flaky 단언). `Aborted`는 cause 미설정(게이트 안 캡처 가드).

**UI** — 기존 `parallelScen`(`scanVars.test.ts:478`)은 다운스트림 bare 참조가 **없어 red가 안 된다**(리뷰 확인: 현 4개 단언 전부 새 규칙에서도 green). ⇒ **새 fixture 필수**: `parallelScenDownstreamBare`(= `parallelScen` + `after` 스텝이 `{{s}}`를 bare로 참조). 이걸 안 만들면 RED 단계가 **공허**하다.
- 다운스트림 bare → 미정의(**핵심 가드**) · `stepIds`가 다운스트림 스텝만 담고 분기 내부 스텝은 **제외**.
- 분기 내부 bare → 미정의 아님(기존 :606 의도 보존).
- **분기 안 loop 내부** bare → 미정의 아님(§2.2 구현 함정 가드).
- 형제 분기 bare → 미정의 + 전용 문구.
- namespaced → 정의됨 · flat extract가 같은 이름 생산 시 다운스트림 bare는 정의됨(shadow).
- `candidates>=1`이면 "선언 추가" 미렌더 / `candidates==0`이면 렌더(§2.4.1 가드).
- `VariablesPanel.test.tsx:278`(행 집합 단언) 새 행 구성으로 갱신.

### 6.2 라이브 (US 척추)

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 에디터에서 분기 extract + 다운스트림 bare | 미정의 ⚠ + `{{auth.token}}` 힌트 · "선언 추가" 부재 |
| US1 | 힌트대로 수동 수정 → 저장 → run | run `completed`, errors 0 (PRE: `failed`) |
| US2 | 분기 안 loop + `{{auth.token}}` → `POST /api/test-runs` | `final_vars`에 `auth.token`, 요청 URL에 실제 값 (PRE: `final_vars={}`) |
| US3 | 결함 1 시나리오로 closed-loop run(**`vus:1`·단일 워커**) → `GET /api/runs/{id}` | `message` == `all VUs failed (1/1): template: unknown variable token` (PRE: `all VUs failed (1/1)`뿐) |

> **US3 라이브 결정성(리뷰 G5)**: `mark_failed_if_active`(`store/runs.rs:406`)는 **먼저 보고한 워커가 이긴다** — 멀티워커 fan-out(ADR-0027/0038)에선 per-VU 비결정 위에 워커 비결정이 한 겹 더 쌓인다. 그래서 US3 행은 `worker_count=1`·`vus:1`로 고정한다.

**필수** — 엔진 실행 경로 변경(`/live-verify`).

---

## 7. 연기 (의도적 비목표)

- **8b**: 원클릭 `{{token}}`→`{{auth.token}}` 재작성(새 `yamlDoc` Edit 변형·store action·형제 분기 제외·동명 분기 across-node 후보 판별 필요 — 리뷰 R2/R3).
- **같은 parallel 노드 안의 namespaced 참조**(§2.2.2) — 런타임 실패지만 8a는 비플래그.
- **중첩 parallel 병합**(§3.2) 및 분기 안 컨테이너의 **UI 저작 개방**(`model.ts:210` Zod 확대).
- **open-loop 실패 정책**(§4 — `runner.rs:1352`가 원인을 WARN으로만 흘림). 진단 절반(원인 캡처)은 `:209-210`과 동형이라 값싸므로 **분리 가능한 더 싼 옵션**이지만, run-실패 판정 정책이 선결이라 함께 연기.
- **run 생성-시 검증**(`POST /api/runs`) — 저장-시 400은 데이터셋 바인딩 때문에 불가(§1)지만, **run 생성 시점엔 바인딩이 알려져 있어** `선언 ∪ extract ∪ namespaced ∪ 바인딩 컬럼`으로 미해결 변수를 계산해 400으로 fail-fast할 수 있다(ADR-0022 반론이 적용되지 않는 유일한 지점). 사후 메시지(§4)보다 강한 후속 후보.
- extract 선언은 있으나 **런타임 미발화** 진단(`runner.rs:653` `if let Some` silent drop).
- 미정의의 저장-차단 게이트화 · 순서 인식 판정 · 시나리오 저장-시 서버 검증(§1 기각 근거).

---

## 8. 리스크

| 리스크 | 완화 |
|---|---|
| 미정의 강화가 기존 시나리오에 **오탐** | 비차단 advisory(저장·run 무영향). 순서 축 미변경. §2.2 3행 + 형제 케이스로 경계 고정. 리뷰가 오탐 shape 구성 실패 확인 |
| 분기 서브트리 walker를 비재귀로 짜 loop-in-branch bare가 오탐 | §2.2 구현 함정 명시 + 전용 테스트(§6.1) |
| "선언 추가"가 빈 값 선언으로 조용한 잘못된 부하 | §2.4.1 조건부 숨김 + 회귀 테스트 |
| RED 단계 공허(기존 테스트가 안 깨짐) | 새 fixture `parallelScenDownstreamBare` 명시(§6.1) |
| runner/trace 병합 drift | walker 단일 소스(`scenario.rs`) + 양쪽 테스트 |
| `cause` 캡처가 VU 태스크 간 경합 | 첫-쓰기 승자(`Arc<OnceLock>`), 읽기는 JoinSet 드레인 후 = happens-before 성립. **대표값이 아니라 표본**임을 US3 문구가 명시(오해 방지) |
| 라이브 US3 신호가 멀티워커/멀티VU 비결정으로 흔들림 | `vus:1`·`worker_count=1` 고정(§6.2) + 단위 테스트도 단일 원인 |
