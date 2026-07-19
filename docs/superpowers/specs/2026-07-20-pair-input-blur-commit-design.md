# 짝(min/max) 입력 commit-on-blur 오커밋 수정 — 설계

- 날짜: 2026-07-20
- 유형: `correctness-bug`
- 범위: UI-only (`ui/src`) — crates/proto/migration/서버 store **0-diff**, 와이어 무변경
- 출처: thinkboard-defaults 라이브 L3 실측(2026-07-19) → `docs/roadmap-status.md` §B13 추천 항목
- 관련 함정: `ui/CLAUDE.md`(“`user.clear/type/click`의 포커스 이동 = 암묵 blur” 항목의 **제품 동작** 후속), `ui/src/components/scenario/CLAUDE.md`(S-B “짝(paired) 입력” 항목)

## 사용자 스토리 (US)

버그 슬라이스이므로 `재현 / 기대 / 실측`이 US를 대체한다(규약 `docs/dev/user-story-spine.md` — 대체 경로 1급). US1/US2는 그 위에 얹는 관찰 가능한 결과·불변식이다.

### B1 — 핵심 결함 (4개 커밋 사이트 공통, 단일 원인)

- **재현**: 대기 시간이 `200/500`인 상태에서, 최소 칸에 `1000`을 치고 → **최대 칸을 클릭**(또는 Tab) → `2000`을 치고 → 바깥으로 포커스를 옮긴다.
- **기대**: `1000–2000`이 저장된다.
- **실측**: **`200–2000`**이 저장된다(thinkboard-defaults 라이브 L3, 2026-07-19). 최소 칸에 친 `1000`이 사라지고 옛 `200`이 살아남는다.
- **원인**: 최대 칸으로의 포커스 이동이 최소 칸의 암묵 blur를 일으켜, 그 순간의 **중간 쌍** `{1000, 500}`이 `min>max`로 판정돼 `revert`로 떨어진다. `resolveThinkDraft`의 규칙은 옳고, **커밋이 발화되는 시점**이 틀렸다.
- **방향 의존**: 범위를 **올릴 때만** 발현한다(내릴 땐 중간 쌍이 유효). 최대 칸부터 고치면 정상이라, QA에겐 “가끔 값이 안 먹는다”로 나타난다 — 재현 조건을 모르면 추적이 어렵다.

### US1

QA가 대기 시간 범위를 **더 큰 값으로** 바꿀 때, 두 칸을 차례로 채우고 **편집을 마치면** 친 그대로 저장된 것을 본다 — 4개 표면 어디서든.

“편집을 마치면”의 정의(A2 — 두 가지로 읽히므로 여기서 고정): ① 포커스가 짝 **바깥**으로 나가거나, ② 짝이 속한 모달이 닫히거나(ESC·백드롭·✕ — R5), ③ 창/탭을 떠난다. 세 경로 모두에서 마지막으로 친 쌍이 저장돼야 한다.

### US2 (불변식 — 이번 수정이 넘지 않을 선)

QA가 **실제로** 유효하지 않은 쌍(`min>max`)을 남긴 채 편집을 마치면, 지금과 똑같이 마지막 저장값으로 조용히 복귀한다. 이번 수정은 커밋이 발화하는 *시점*만 바꾸고 **유효성 규칙은 0-diff**다 — `resolveThinkDraft`는 한 글자도 바뀌지 않는다.

> **주의(리뷰 C1이 반증한 초안 문구)**: 이 US를 “같은 입력에 대해 저장되는 YAML이 이전과 동일하다”로 쓰면 **거짓**이다. 편집을 중도 포기하는 경로에서 수정 전후 결과가 실제로 갈린다 — 상세와 근거는 §7.1. 불변식은 “YAML 동일”이 아니라 “**유효성 규칙 동일**”이다.

## 1. 영향 표면 (전수)

`resolveThinkDraft`를 쓰는 커밋 사이트는 정확히 4개, 파일 3개다(`grep -rln "minDraft\|thinkMinDraft\|defMinDraft" ui/src` 기준).

| # | 파일 | 커밋 함수 | 드래프트 | 입력 `onBlur` | 재시드 dep (현재) |
|---|---|---|---|---|---|
| 1 | `Inspector.tsx` | `commitThinkTime` (`:243`) | `:225`,`:228` | `:396`,`:408` | `[step.id, step.think_time]` (객체, `:239`) |
| 2 | `ScenarioDefaults.tsx` | `commit` (`:41`) | `:31`,`:32` | `:85`,`:97` | `[defaultThink]` (객체, `:37`) |
| 3 | `ThinkTimeBoard.tsx` (BoardRow) | `commit` (`:60`) | `:46`,`:47` | `:134`,`:149` | `[row.stepId, cfgMin, cfgMax]` (원시값, `:56`) |
| 4 | `ThinkTimeBoard.tsx` (기본값 행) | `commitDefault` (`:205`) | `:197`,`:198` | `:302`,`:318` | `[defMin, defMax]` (원시값, `:203`) + `!open` 재시드 effect `:235`–`:245`(재시드문 `:242`–`:243`) |

**면역이라 손대지 않는 것** — 결함 성립 조건은 *교차 필드 유효성 제약* **AND** *revert 결과*의 조합이다. 둘 중 하나만 없어도 면역이므로, 아래는 “어느 쪽이 없어서” 면역인지까지 적는다(조건 하나만 대면 열거를 재사용할 수 없다):

- `KeyValueGrid`(key/value, `:217`/`:232`): 커밋만 하고 **revert가 없다**(빈 key 행은 커밋 map에서만 제외, draft는 보존).
- `ExtractEditor`(var/path/name, `:804`/`:828`/`:844`): **교차 필드 제약은 있다**(`commitDrafts` `:740`–`:747` — `var` 필수, body면 `path`가 `""`/`"$."`가 아닐 것). 면역의 근거는 오직 **revert가 없다**는 점 — 유효하지 않은 행은 저장 목록에서 빠질 뿐 사용자가 친 draft를 되돌리지 않는다.
- `ConditionEditor`(left/right, `:1299`/`:1332`): 짝 입력 + 양쪽 blur 커밋이지만 교차 제약도 revert도 없다(트리 전체를 그대로 persist).
- `RunDialog`의 `thinkMin`/`thinkMax`(`:136`–`:137`): `onBlur` 자체가 **0개** — 제출 시점에만 읽는 평범한 state.
- `ThinkTimeBoard`의 일괄 입력 `bulkMin`/`bulkMax`: `bulkValid` 게이트 + 명시 버튼 적용이라 blur 커밋 없음.

전수 확인 방법(구현자·리뷰어가 재실행할 것): `grep -rn "onBlur={" --include="*.tsx" --include="*.ts" ui/src | grep -v __tests__` → **23개**. 위 4개 외에 `resolveThinkDraft`를 소비하거나 제약+revert 조합을 갖는 것은 없다.

## 2. 설계

### R1 — 공유 훅 `useThinkTimePair`

신규 **`ui/src/components/scenario/useThinkTimePair.ts`**. 4 사이트에 4× 복제된 상태기계(드래프트 state·시드·재시드 effect·4분기 스위치)를 흡수하고, 그 안에서 커밋 시점을 고친다. `resolveThinkDraft`가 *규칙*을 수렴시킨 것의 다음 한 수로 *상태기계*를 수렴시킨다.

**위치 주의(리뷰 M3)**: `ui/src/scenario/`는 React-free 순수 로직 디렉토리이며 그 안의 어떤 파일도 React를 import하지 않는다 — 훅을 거기 두면 규약이 깨진다. 소비처 3파일이 모두 `components/scenario/`에 있으므로 훅도 그 옆에 둔다(범용 훅은 `ui/src/hooks/`, 컴포넌트 인접 훅은 `components/` — `components/usePopover.ts` 선례).

**왜 훅인가(리뷰 C5 — 이 항목만 버그 자체가 아니라 리팩터다)**: R2의 가드를 4곳에 손으로 복제하면 미배선 기회가 4번 생기고, 그 미배선은 조용하다(테스트 이디엄이 가려온 결함이라 더욱). `resolveThinkDraft` 수렴 선례와 같은 논리다. **폴백**: 훅이 침습적으로 판명되면 **R2만** 단독 적용(사이트당 ref 2개 + 가드 1줄)해도 버그는 고쳐지고 동작 변화는 R2 범위로 한정된다 — 그 경우 R3·§6.5는 함께 드롭한다.

```ts
useThinkTimePair({
  value,      // ThinkTime | undefined — 마지막 커밋값
  resetKey?,  // string | undefined — 편집 대상 identity, 바뀌면 재시드
  onCommit,   // (v: ThinkTime) => void
  onClear,    // () => void
}) => { minProps, maxProps, reseed }
```

- `minProps`/`maxProps`는 `{ value, onChange, onBlur, ref }`. 기존 `<Input>`에 **스프레드**한다.
- `reseed()`는 명령형 재시드 — ThinkTimeBoard 기본값 행의 모달 닫힘 경로 전용(그 코드의 주석이 부르는 이름이 `R2-f`인데, 그건 **이전 슬라이스(thinkboard-defaults) plan의 식별자**이지 이 spec의 R2 하위항목이 아니다 — A1 혼동 방지).
- **`reseed`는 `useCallback`으로 identity-stable해야 한다(M2)**. 소비처(사이트 4)의 effect deps는 `[open, defMin, defMax]`인데, 매 렌더 새 클로저를 반환하면 `react-hooks/exhaustive-deps`가 `reseed`를 deps에 넣기를 요구하고 그러면 effect가 매 렌더 재발화한다. `pnpm lint`가 `--max-warnings=0`이라 이건 경고가 아니라 **실패**다. (대안: `Modal.tsx:22`–`:24`의 `onCloseRef` latest-value ref 이디엄.)
- `resetKey`는 **optional**이다. 사이트 1·3은 편집 대상이 바뀌는 표면이라 `step.id`/`row.stepId`를 넘기지만, 사이트 2·4(시나리오 기본값)는 편집 대상이 시나리오 하나뿐이라 identity가 없어 생략한다 — 그 두 곳의 재시드는 값 dep(`value?.min_ms`/`value?.max_ms`)만으로 충분하다.

### R2 — 커밋 시점 (핵심 수정)

각 `onBlur(e)`는 **`e.relatedTarget`이 짝의 다른 입력이면 즉시 `return`**한다. 커밋은 짝을 실제로 떠나는 blur(짝의 나머지 한쪽)가 담당한다.

```
if (e.relatedTarget === partnerRef.current) return;   // 짝 내부 이동 — 커밋 보류
```

- 훅이 `minRef`/`maxRef` 두 개를 소유하고 각 핸들러가 상대 ref를 본다.
- `relatedTarget === null`(비-포커서블 영역 클릭·창 blur 등)이면 **오늘과 동일하게 커밋**한다 — 보류는 짝 내부 이동에만 적용된다.
- 스킵된 blur는 아무 부수효과도 내지 않는다(드래프트 보존). 짝을 떠나는 시점에 `resolveThinkDraft`가 **최종** 쌍을 보고 판정한다.

**마크업 무변경**: 래퍼 div를 도입하지 않는다(`Input`이 `forwardRef`라 ref만 꽂으면 된다). ThinkTimeBoard의 flex 행·Inspector의 `Field` 레이아웃은 한 글자도 안 바뀐다.

### R5 — 모달 닫힘 시 커밋 flush (사이트 3·4)

**결정(M1, 사용자 2026-07-20): ESC/백드롭/✕ 어느 경로로 닫아도 마지막으로 친 값을 저장한다.**

사이트 3·4는 `Modal` 안에 있고, `Modal.tsx:34`–`:36`의 ESC 경로는 **포커스 이벤트를 전혀 발생시키지 않은 채** 언마운트한다 → blur가 안 뜨므로 커밋도 없다. R2는 이 창을 **넓힌다**(오늘은 min의 편집이 우연히 살아남는 경우가 있지만, R2 이후엔 두 칸 모두 유실). 따라서 R2와 **같은 슬라이스에서** 닫힘 flush가 필요하다 — 안 하면 이 수정이 ESC 경로를 악화시킨다.

구현은 저장소에 이미 있는 선례를 그대로 채택한다 — `EditorShell.tsx:61`–`:64`의 `closeDetail`:

```ts
const closeDetail = () => {
  (document.activeElement as HTMLElement | null)?.blur?.();
  setDetailOpen(false);
};
```

`ThinkTimeBoard`가 받은 `onClose`를 같은 방식으로 감싸 `Modal`에 넘긴다. 동기 `element.blur()`는 `relatedTarget: null`인 focusout을 일으키므로 R2의 보류 분기를 타지 않고 **최종 쌍**으로 정상 판정된다(유효하면 커밋, `min>max`면 revert — US2 유지).

**근거(왜 '폐기'가 아닌가)**: 현황판은 저장/취소 버튼이 없는 **라이브 편집** 표면이다. 행별 편집·일괄 액션·앞서 고친 기본값은 이미 전부 store에 커밋돼 ESC로 되돌릴 수 없다. 그러니 '폐기'는 *마침 포커스가 있던 한 칸만* 버리는 임의적 동작이 된다. flush가 표면을 일관되게 만들고 Inspector 상세 모달(사이트 1이 이미 이 경로로 보호된다)과도 정책이 일치한다.

**세 경로 중 R5가 실제로 일하는 건 ESC 하나뿐이다**(구현자 오해 방지): 백드롭과 ✕는 mousedown이 포커스를 입력 밖으로 옮기면서 이미 `relatedTarget: null` blur를 일으켜 **스스로 커밋한다**(R2의 보류 분기를 안 탄다). ESC만이 포커스 이벤트를 전혀 안 내므로 flush가 필요하다 — §4.5가 ESC만 테스트하는 이유도 그것이 유일하게 이빨 있는 경로이기 때문이다. 백드롭 경로에서 R5의 `blur()` 호출은 `activeElement`가 이미 `body`라 no-op이다(이중 발화 없음).

기존 `!open` 재시드(`:235`–`:245`)는 **유지**한다 — flush 후에도 포커스가 입력이 아니었던 경우(행 체크박스 클릭 후 ESC 등)의 안전망이다.

### R3 — 재시드 dep은 원시값으로 통일

훅 내부 재시드 effect의 dep은 `[resetKey, value?.min_ms, value?.max_ms]`(원시값)로 고정한다. 사이트 3·4가 이미 **의도적으로** 쓰는 형태이고(표 참조), 표에서 한 행을 커밋할 때 다른 행의 반쯤 친 값이 날아가는 think-time-dashboard 함정을 by-construction 배제하는 유일한 형태다.

사이트 1·2는 현재 객체 dep이라 이 변경으로 **동작이 미세하게 달라진다**: 값이 동일한 모델 재도출에서는 이제 재시드가 발화하지 않는다. 이는 안전한 방향이다(진행 중 드래프트를 덜 파괴).

근거: **사이트 1**의 기존 주석(`Inspector.tsx:231`–`:235`)이 이미 “객체 dep 재발화는 무해하다 — 텍스트 입력은 blur에 커밋하므로 반쯤 친 draft가 다른 필드의 커밋과 공존할 수 없다”고 적고 있다. 즉 그 재발화는 **load-bearing이 아니다**. (**사이트 2에는 주석이 없다** — 초안의 “두 사이트의 기존 주석”은 부정확했다(F3). 다만 같은 논거가 그대로 적용된다: store 커밋은 반드시 포커스 변경을 수반하고, 그 포커스 변경이 짝을 blur시켜 draft를 먼저 해소한다.) 리뷰어도 두 사이트에서 재시드가 필요한 도달 가능 경로를 구성하지 못했다.

이 변경은 숨기지 말고 spec-level 결정으로 명시한다.

### R4 — 시드 형태

훅은 `value === undefined ? "" : String(value.min_ms)`로 시드한다.

주의: 사이트 1·2의 현행 `step.think_time ? … : ""`는 **객체**를 검사하므로 `{0,0}`에서도 truthy → 데이터 손실이 **없다**(사이트 4의 `defMin === undefined`는 destructure된 *숫자*라 `=== undefined`가 필수였던 별개 사례). 즉 여기엔 잠복 버그가 없고, 훅은 두 형태 모두에 대해 올바른 단일 형태를 쓴다.

## 3. 비목표 (명시적으로 안 하는 것)

- **유효성 규칙 변경 금지**: `resolveThinkDraft`는 **0-diff**. 자동 swap·clamp·경계 완화 없음.
- **`min>max`로 쌍을 떠날 때의 무음 revert 유지**(US2, 사용자 스코프 결정 2026-07-20). 인라인 경고 문구 추가는 이번 범위 밖.
- **프레젠테이션 컴포넌트화 금지**: `<ThinkTimePairFields>` 같은 공용 컴포넌트는 만들지 않는다. 4 사이트가 라벨(`Field` vs `aria-label`)·크기(`compact`/`size="sm"`)·폭(`w-20`)·`disabled` 조건이 제각각이라 과-매개변수화가 된다. 훅은 **동작**만 수렴시키고 **표현**은 각 사이트가 소유한다.
- ko 문구 추가 없음(신규 사용자 노출 문자열 0) → ADR-0035 표면 무접촉.

## 4. 테스트 전략

### 4.1 기존 스위트 = 베이스라인 보존 신호

기존 think-time 테스트는 수정 후에도 **무수정 green**이어야 한다. 하나라도 깨지면 커밋 규칙이 의도치 않게 변했다는 신호다.

**단, 그 이유를 정확히 알고 있어야 한다(리뷰 F2가 초안의 틀린 전제를 반증했다).** 초안은 “기존 테스트는 *전부* `fireEvent` 이디엄이라 `relatedTarget`이 null”이라고 썼는데 **거짓**이다 — `docs/roadmap-status.md`의 서술을 검증 없이 물려받은 문장이었다. 실제로는 여섯 개가 짝을 가로지르는 **실제 포커스 이동**을 쓴다:

- `Inspector.test.tsx:802`–`:821`, `:823`–`:846` (`user.clear(min)` → `user.type` → `user.clear(max)` — 이 `user.clear(max)`가 min을 blur시킨다)
- `ThinkTimeBoard.test.tsx:175`–`:184`, `:186`–`:193`, `:209`–`:221`, `:223`–`:238`
- `ScenarioDefaults.test.tsx:52`–`:54`만 초안이 묘사한 이디엄에 해당한다.

**이들이 green으로 남는 진짜 이유**: 그 여섯 케이스의 중간 쌍은 항상 “정확히 한 칸만 빔”이라 오늘도 `noop`으로 떨어진다(암묵 커밋이 이미 무해). R2의 보류 분기는 결과를 바꾸지 않는다 — 커밋을 *보류*하든 `noop`으로 *무시*하든 store 쓰기가 0인 건 같다.

이 구분이 중요한 이유: §6.3이 “기존 테스트 전부 green”을 수용 기준으로 삼는데, 틀린 근거를 들고 있으면 하나가 red일 때 구현자가 엉뚱한 원인을 쫓는다.

### 4.2 회귀 가드 (신규) — 반드시 실제 포커스 이동으로

`fireEvent.blur(el)`는 `relatedTarget: null`이라 **이 결함을 재현하지 못한다**. 가드는 `userEvent`의 실제 포커스 이동(`user.click(max)` / `user.tab()`)을 써야 한다.

```
seed {200,500}
→ user.clear(min) 후 1000 입력   // clear 없이 type하면 "2001000"이 된다(C6)
→ max를 click        // 암묵 blur, relatedTarget = max
→ user.clear(max) 후 2000 입력
→ tab으로 쌍을 이탈   // 커밋 경계
→ expect 저장값 toEqual {min_ms:1000, max_ms:2000}
```

4 사이트 각각에 이 가드를 둔다(단일 원인이지만 배선은 4곳이라, 한 곳만 검증하면 나머지 배선 누락이 잠복한다).

세부 전제(C6): 사이트 1의 think 입력은 기본-접힘 disclosure 안이라 `user.click(getByRole("button",{name: ko.editor.sectionTiming}))`로 **먼저 펼쳐야** 한다(`Inspector.test.tsx:805` 패턴).

### 4.3 이빨 실증 (의무)

각 가드는 **고의 회귀 → RED → 원복 → GREEN**을 실행해 증명한다. 구체적으로 R2의 보류 분기(`if (e.relatedTarget === partnerRef.current) return;`)를 제거했을 때 RED가 되어야 한다.

이 저장소는 plan이 지시한 공허한 테스트를 4차례 적발했고(→ 메모리 `plan-mandated-vacuous-tests`), 특히 이 슬라이스는 **테스트 이디엄 자체가 결함을 가려온** 영역이다(`ui/CLAUDE.md`의 해당 항목이 “위 `fireEvent` 이디엄은 테스트를 통과시킬 뿐 이 결함을 가린다”고 명시). 따라서 이빨 실증은 선택이 아니다.

추가로, 문자열 부분일치 단언 금지 — 저장값 단언은 `toEqual({min_ms, max_ms})` 같은 **구조 전체일치**로(부분문자열 통과 클래스, `ui/CLAUDE.md`).

### 4.4 불변식 가드 (US2)

`min=1000, max=500`으로 만든 뒤 **짝 바깥으로** 직접 blur → 마지막 커밋값으로 revert됨을 단언. R2의 보류가 유효성 규칙까지 무력화하지 않았음을 고정한다.

### 4.5 모달 닫힘 flush 가드 (R5 — 사이트 3·4)

리뷰 M4가 지적한 대로 §4.4는 **중도 포기 경로를 구조적으로 덮지 못한다**(짝 바깥 blur만 본다). 그래서 별도 가드가 필요하다:

- 현황판을 열고 기본값 `{500,1000}` → min `200` → max로 포커스 이동 → max `400` → **ESC** → 저장값 `toEqual {min_ms:200, max_ms:400}`.
- 이 가드는 R5가 없으면 RED다(아무것도 커밋 안 됨 → `{500,1000}`). 즉 R5의 이빨을 직접 증명한다.
- 대칭으로 `min>max`를 남긴 채 ESC → revert(마지막 커밋값 유지)도 고정한다(US2가 닫힘 경로에서도 성립).

`Modal`의 ESC 리스너는 `document`에 등록되므로(`Modal.tsx:55`) 테스트에선 `fireEvent.keyDown(document, {key:"Escape"})`로 발화한다.

## 5. 라이브 검증

`/live-verify` 대상이다 — 이 결함은 **RTL 이디엄이 원리적으로 못 보는** 경로에서 실측됐고(브라우저 `fill()`의 실제 포커스 이동), 최초 발견도 Playwright였다.

- 진입 화면 **양쪽 모두**에서: `/scenarios/new`와 `/scenarios/{id}` (메모리 `live-verify-all-mount-paths` — 한 화면만 보면 그 화면이 우연히 정상인 버그를 놓친다).
- 4 표면 각각에서 B1 재현 절차를 그대로 실행 → `1000–2000` 저장 확인.
- **사이트 3·4는 ESC 닫힘 경로도 반드시 실행한다**(R5·§7.1). 스크립트가 “바깥으로 포커스를 옮긴다”만 하면 R5를 전혀 건드리지 않은 채 PASS가 나온다 — 리뷰가 지적한 false-PASS 지점이다.
- YAML 반영 확인은 Monaco DOM이 아니라 **저장 후 `GET /api/scenarios/{id}`의 `yaml` 필드**가 권위(`ui/CLAUDE.md` — Monaco는 read/write 양쪽 불신).
- US 앵커 표(`US | 절차 | 통과 신호`)로 기록.

## 6. 수용 기준

1. 4 사이트 전부에서 B1 재현 절차가 `1000–2000`을 저장한다(라이브 실측).
2. `resolveThinkDraft`는 **0-diff**(US2 — “저장 YAML 동일”이 아니라 “유효성 규칙 동일”. §7.1의 의도된 델타는 예외로 명시된다).
3. 기존 think-time 테스트 전부 무수정 green(4.1).
4. 신규 회귀 가드 4종 + R5 닫힘 가드가 이빨 실증(주입→RED→원복→GREEN)을 통과한다.
4b. 사이트 3·4에서 ESC로 닫아도 마지막 쌍이 저장된다(R5·§4.5).
5. 드래프트 상태기계가 훅 1곳에만 존재한다 — 4 사이트에 `useState`/재시드 `useEffect`/`resolveThinkDraft` 스위치 사본이 남지 않는다(`grep`으로 확인).
6. 게이트 3종(`pnpm lint && pnpm test && pnpm build`) green, cargo 게이트 무영향(UI-only).

## 7. 알려진 한계 / 의도적 연기

### 7.1 의도된 동작 델타 — 편집 중도 포기 경로 (리뷰 C1)

초안의 “저장 YAML은 이전과 동일” 주장은 **거짓**이었다. 반례(**낮추는** 방향이라 중간 쌍이 유효해 오늘도 커밋이 나간다):

> 기본값 `{500,1000}` → min에 `200` → max로 포커스 이동 → max에 `400` → ESC

| | 저장 결과 |
|---|---|
| 수정 전 | `{200,1000}` — min→max 이동 때 중간 쌍이 커밋되고, ESC는 그걸 되돌리지 못한다 |
| R2만 적용 | `{500,1000}` — 아무것도 커밋 안 됨 |
| **R2+R5 (채택안)** | **`{200,400}`** — 사용자가 실제로 친 쌍 |

즉 세 결과가 모두 다르며, 채택안만이 사용자 의도와 일치한다. 이 델타는 **회귀가 아니라 수정의 일부**이므로 §4.5가 이를 명시적으로 고정한다. 수용 기준 §6.2의 “0-diff”는 `resolveThinkDraft`(규칙)에 걸리는 것이지 이 경로의 결과값에 걸리는 것이 아니다.

### 7.2 나머지

- **`min>max`로 편집을 마칠 때 무음 revert**: 유지(US2·§3). 인라인 경고는 별도 UX 슬라이스 후보.
- **창/탭 전환(alt-tab) 중 짝을 떠나는 경우**: `relatedTarget`이 null이라 중간 쌍이 그대로 판정된다 → 올리는 방향이면 revert로 친 값이 사라진다. 이건 R2가 덮지 못하는 **US1의 잔여 구멍**이며(리뷰 C2 후단), ‘의도된 동작’이라기보다 수용된 한계다. 브라우저가 창 blur에서 짝 내부인지 외부인지 구분할 정보를 주지 않으므로 이번 범위 밖으로 둔다.
- **`scenarioHasThink`의 `{0,0}` 비대칭**: thinkboard-defaults에서 부하 사이징 슬라이스로 연기된 별건 — 이번 범위 밖(건드리지 않음).
- **`relatedTarget`이 null인 브라우저 경로**: 창 전환·비-포커서블 영역 클릭은 오늘과 동일하게 즉시 커밋한다. 짝 내부 이동만이 보류 대상이므로 의도된 동작이다.
