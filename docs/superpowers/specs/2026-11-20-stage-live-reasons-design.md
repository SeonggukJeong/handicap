# 계단 진행 패널 — 실패 이유 표시 (설계)

- 날짜: 2026-11-20 · 유형: user-path · roadmap §A16 후속, §B70 (0) 첫 줄 사용자 결정 + §B70 (2) 첫 줄(판정 직후 경계 초) + §B70 (3)(400px 표 넘침)
- **상태: 구현·최종 리뷰·라이브 검증 완료(2026-11-20, 코드 `4f4171e3`..`02752e87`) — 판단·연기 roadmap §B71** · plan `docs/superpowers/plans/2026-11-20-stage-live-reasons.md`
- 슬러그: `stage-live-reasons` · 선행: stage-live-panel(`3668110b`..`eb225566`, ADR-0059, spec `2026-11-18-stage-auto-stop-design.md` §8)
- 범위 결정(사용자 2026-11-20): 실패 이유 + 같은 화면의 작은 문제 두 개(경계 초·400px 넘침)를 이번에 함께. 와이어 모양 = 접근 A(서버는 숫자, 문구는 화면).

## 사용자 스토리 (US)

(사용자 승인 2026-11-20. spec 리뷰 뒤 정밀화: US1 「똑같다」 = 이유 조각 글자가 같고 구분자만 다름, US3 「✗가 붙은」→「판정된」, US4 최악 입력을 실제로 날 수 있는 조합으로 — 슬롯 부족 의심은 달성·dropped 사유뿐일 때만 붙는다)

- **US1**: 운영자가 계단 run을 서버 대시보드 옆에 띄워 놓고 보다가 어느 계단이 「튄 계단」·「포화」로 판정되는 걸 본다. 성공하면 요약 줄에 「2 튄 계단(오류 4.6%)」·「3 포화(p99 3.9×)」처럼 이유가 같이 보이고, 이유 조각 하나하나의 글자는 run이 끝난 뒤 리포트 「사유」 칸과 똑같다(「p99 5 ms 이상」·「슬롯 부족 의심」 포함 — 조각 사이 구분자만 실행 중 `, `, 리포트 ` · `).
- **US2**: QA가 실행 중 칩 하나에 마우스를 올리거나 스크린리더로 칩을 읽는다. 성공하면 그 계단의 상태와 이유가 함께 나온다(요약 줄엔 안 붙는 「포화 이후」 계단의 이유도 여기서). 이유가 없는 칩(정상·측정 중·예정·판정 중단·일부 실행·실행 안 함·즉시 정지·측정 안 됨)은 지금과 같다.
- **US3**: 운영자가 계단이 판정되는 순간 머리 줄을 본다. 성공하면 방금 판정된 계단을 「측정 중」으로 보여 주는 약 2초가 없고 다음 계단 「상승 중」으로 바로 넘어간다. 마지막 계단까지 판정되면 「측정 중」 머리 줄이 사라진다.
- **US4**: 운영자가 좁은 화면(폭 400px)에서 실행 중 run 상세를 연다. 성공하면 페이지 가로 넘침이 없고 메트릭 표는 자기 상자 안에서만 가로 스크롤된다. 한 계단에 이유가 가장 많이 붙어도(달성·dropped·오류·p99 N.N× 네 개, 큰 숫자 — 또는 달성·dropped·슬롯 부족 의심) 요약 줄이 잘리거나 겹치지 않는다.

## 1. 왜

stage-live-panel 라이브 검증에서 오류율 4.6%로 실패한 계단이 「튄 계단」으로만 보여 「지연은 그대로인데 튄 계단?」이 어색했다. 「튄」은 판정이 한 번 튀었다 돌아왔다는 뜻이고 이유와 무관하다(a의 bench 규칙). 패널은 칩에 숫자를 싣지 않아(stage-live-panel plan 세부화 10) 왜 실패했는지를 run이 끝나 리포트를 열기 전까지 알 수 없다. 운영 저트래픽 시간대 시험에서 지켜보는 사람은 지금 실패가 오류 때문인지 지연 때문인지에 따라 대상 시스템의 다른 대시보드를 본다.

같은 화면의 두 문제: ① 계단 판정 직후 약 2초 동안 머리 줄이 이미 판정된 계단을 「측정 중」이라 한다(이유를 붙이면 「2/4 측정 중 · … 2 튄 계단(오류 4.6%)」로 모순이 더 눈에 띈다). ② 폭 400px에서 run 상세의 표가 페이지를 가로로 넘친다.

## 2. 목표 / 비목표 / 반목표

**목표**
- 실행 중 요약(`auto_stop_live`)에 계단별 실패 이유를 싣고, 요약 줄과 칩 툴팁·스크린리더 라벨에 리포트와 같은 글자로 보인다.
- 판정 직후 머리 줄이 다음 계단으로 바로 넘어간다. 전부 판정되면 「측정 중」 머리 줄을 숨긴다.
- run 상세의 두 표(스텝 표·메트릭 윈도우 표)가 400px에서 페이지를 넘치지 않는다.

**비목표**
- 「튄 계단」 등 상태 용어 변경(사용자 결정 — 바꾸지 않는다).
- 칩 안에 숫자 표시(칩은 기호만 — stage-live-panel 결정 유지).
- 리포트·CSV·XLSX·인쇄의 사유 글자 변경(공통 함수로 리팩터해도 출력 바이트 동일).
- §B70 (2)의 나머지 연기 항목(`live_of` 호출 카운터·`stopped_at_ms` 키·`debug_assert`·칩 대비 목록 도출).

**반목표 (돌아가도 실패)**
- 실행 중 이유 조각 글자가 끝난 뒤 리포트 사유 칸 조각과 다르다(같은 계단, 같은 데이터에서 — 구분자 차이는 의도).
- 계단 아닌 run의 `RunResponse`가 바이트 하나라도 달라진다.
- 폴링 경로 비용이 눈에 띄게 늘어난다. 지금 요약은 `LiveKey`(판정 수·현재 구간·즉시 정지 마지막 초·연속 수·보류·보류 초)가 바뀔 때 다시 만들고 — 즉시 정지 칸이 켜져 있으면 거의 매초 — `GET` 폴링마다 `LiveState`를 통째 복사한다(`coordinator.rs` `live_of`). 추가 비용 = 다시 만들 때·폴링마다 계단 수(≤50)만큼의 작은 벡터(이유 ≤4개) 복사. §7 성능 행으로 기준선 대비 기록한다(working-rules §10).

## 3. 지금 구조 (확인한 사실)

- 서버 `crates/controller/src/stair.rs` `judge()`가 `Judgement { states, reasons: Vec<Vec<Reason>>, slot_limited: Vec<bool>, … }`를 낸다. `Reason { kind: achieved|dropped|errors|p99_cap|p99_relative, value }`. 판정 계단(spike·saturated·unconfirmed)과 `after` 계단에 사유가 들어간다(`after`는 고정 기준 계단 대비 — 비어 있을 수 있음).
- 감시 `crates/controller/src/stair_monitor.rs` `judge_steps()`가 계단 하나 완결마다 `self.acc.numbers(..)` → `judge` → `self.judgement = Some(j)`, `self.judged = i + 1`. `nums`(계단별 `StepNumbers`, `p99_us` 포함)는 지역 변수로 버려진다.
- 실행 중 요약 순수 함수 `crates/controller/src/stair_live.rs` `build_live(&LiveInputs) -> LiveState`. `LiveInputs`엔 `judgement`·`judged`·`current: Option<(u32, BandKind)>` 등. `LiveState`는 `current_step·phase·step_states·last_ok_step·next_fail_stops·emergency_now·suspended_seconds·frozen·stop`. 요약은 `live_if_changed()`가 `LiveKey`(판정 수·현재 구간 등 정수 키)가 바뀔 때만 다시 만든다 — 판정 결과는 `judged`가 바뀔 때만 바뀌므로 이유를 실어도 키는 그대로 충분하다.
- 현재 구간 `StairMonitor::current()` = 가장 높은 수위 초의 `band_of`. 계단 i 측정 마지막 초가 모든 워커에서 완결되면 그 자리에서 판정되지만, 수위는 다음 초(계단 i+1 상승 첫 초)가 올 때까지 계단 i에 머문다 → `current_step < judged`인 1–2초가 생긴다(§B70 (2)).
- UI 와이어 `ui/src/api/schemas.ts` `StairLiveSchema`는 `.strict()` — 서버 필드 추가와 같은 변경에서 스키마도 같이 늘려야 한다(안 하면 실행 중 run 상세 파싱 실패).
- 리포트 사유 글자: UI `ui/src/components/report/stair/stairFormat.ts` `reasonTexts(stair, step)`(리포트 표·인쇄가 씀) ↔ 서버 `crates/controller/src/export.rs` `stair_reason_texts`(CSV·XLSX). 둘은 골든 패리티 테스트(`stairExportParity.test.ts` ↔ `report.rs` 골든)로 묶여 있다. `p99_relative`는 기준 계단(앞쪽 가장 가까운 `ok` 계단 — `refStep`/`stair_ref_step`)의 p99가 1 ms 미만이면 「p99 5 ms 이상」, 아니면 「p99 N.N×」. 상태가 `emergency_stopped`·`skipped`·`partial`인 행은 사유 대신 고정 문구.
- 패널 `ui/src/components/run/StairLivePanel.tsx` + 순수 함수 `stairLive.ts`(`liveHeadText`·`liveSummaryText`·`liveStateLabel`…). 요약은 연속 같은 상태를 묶는다(「1–4 정상 · 5 튄 계단」). 칩 `aria-label`=`title`=`chipLabel(n, 상태 라벨)`.
- run 상세 `ui/src/pages/RunDetailPage.tsx`의 스텝 표(409행 근처)·메트릭 윈도우 표(451행 근처) 둘 다 `<table className="min-w-full text-sm">`이고 가로 스크롤 상자가 없다.

## 4. 접근 (사용자 선택 = A)

| 접근 | 내용 | 득실 |
|---|---|---|
| **A (채택)** | 서버는 계단별 이유 숫자(`judge` 결과 그대로)·슬롯 부족 의심·기준 계단 p99 1 ms 미만 여부만 싣고, 화면이 리포트와 같은 함수로 글자를 만든다 | 실행 중·리포트 글자가 한 함수에서 나옴, `ko.ts` 경유(ADR-0035) 유지. 와이어 칸 하나 + 화면 함수 리팩터 하나 |
| B | 서버가 `stair_reason_texts`로 글자를 만들어 보냄 | 화면 코드 최소. 화면 글자가 `ko.ts` 밖에서 나오고 서버 쪽 화면 문구 출처가 하나 더 생김 |
| (기각) | 화면 계산 | 실행 중 화면엔 계단별 p99가 없어 「p99 5 ms 이상」 판정 불가 |

## 5. 설계

### 5.1 와이어 — `LiveState.step_reasons`

`LiveState`에 필드 하나 추가(`step_states`와 같은 길이 = `cfg.targets.len()`):

```
step_reasons: [ { reasons: [ {kind, value} ], slot_limited: bool, ref_fast: bool } ]
```

- `reasons`·`slot_limited` = `Judgement.reasons[i]`·`Judgement.slot_limited[i]`(그대로 복사, 값 가공 없음).
- `ref_fast` = 계단 i 앞쪽에서 가장 가까운 `ok` 판정 계단의 p99 < 1000 µs(리포트 `refStep` 규칙과 같은 정의). 기준 계단이 없으면 `false`.
- **채우는 계단**: `i < judged`인 모든 계단(판정 결과 복사 — `not_measured` 판정 행은 원래 이유가 비어 있다). 정지 기록이 덮어쓰는 행은 항상 `i ≥ judged`다(두 정지 모두 `judged_through = judged − 1`, 정지 뒤 판정 없음). `i ≥ judged`(측정 중·예정·판정 중단·정지 뒤 `partial`·`skipped`·`emergency_stopped`·`not_measured`)는 빈 값(`reasons: []`, `false`, `false`).
- `Reason` 직렬화는 리포트와 같은 타입(`crate::stair::Reason`) — 새 타입 없음. UI 스키마 = `z.array(z.object({ reasons: z.array(StairReasonSchema), slot_limited: z.boolean(), ref_fast: z.boolean() }).strict())`(nullish 아님 — 서버가 모든 키를 항상 보냄). `StairLive` 타입에 필수 필드가 생기므로 기존 UI 테스트 fixture(`stairLive.test.ts`·`StairLivePanel.test.tsx`·`RunDetailPage.test.tsx` 등)도 같이 늘린다.
- 계단 아닌 run은 `auto_stop_live` 키 자체가 없으므로 바이트 동일(기존 `skip_serializing_if` 그대로).

### 5.2 서버 — 기준 계단 p99 보관

- `judge_steps()`가 `judge`에 넣은 `nums`에서 계단별 `p99_us`만 `StairMonitor`에 보관한다(판정할 때만 덮어씀 — 정수 벡터, 계단 최대 50).
- `LiveInputs`가 그 p99 목록을 받고, `build_live`가 판정 상태에서 기준 계단을 찾아 `ref_fast`를 계산한다(순수 함수 안 — 테스트는 입력만 바꿔서).
- `LiveKey`는 바꾸지 않는다(p99 목록·판정은 `judged`와 함께만 바뀜).

### 5.3 서버 — 판정 직후 현재 구간 (§B70 (2))

`build_live` 안에서만 보정한다(감시의 `current()`·`band_of`·정지 규칙은 무변경):
- `current = Some((c, p))`이고 `c < judged`이면 → `judged < n`이면 `(judged, ramp)`로 올려 표시, `judged == n`이면 `current_step`·`phase`를 `null`로. 현재 구간은 많아야 한 계단 늦고(계단 완결 = 모든 워커 수위가 그 계단 측정 마지막 초 도달, `current`는 가장 높은 수위) 상승은 1초 이상이라 `(judged, ramp)`가 맞다.
- **동결·정지와 겹칠 때도 같은 보정**(내 판단): 동결은 판정만 멈추고 워커가 여럿이면 남은 부하기가 계속 돌므로 「계단 j+1 상승 중」 + 「판정 중단」 줄이 사실이다(워커 하나가 계단 경계에서 조기 종료한 드문 경우엔 run이 곧 끝날 때까지 잠깐 이 줄이 남는다 — 수용). 정지 기록이 있으면 머리 줄 자체가 숨는다(`liveHeadText`). 기대값: 동결 + `c < judged < n` → `(judged, ramp)`; 정지 기록 + `c < judged` → 같은 보정값(화면엔 안 보임); `c ≥ judged` → 무변경.
- 칩 규칙(`i <= current → measuring`)도 보정된 값으로 — 그래서 판정 직후 다음 계단 칩이 바로 「측정 중」이 된다(지금도 상승 구간 계단 칩은 「측정 중」이라 같은 규칙).
- `next_fail_stops`·`last_ok_step`·`stop` 계산은 무변경.

### 5.4 화면 — 글자

- `stairFormat.ts`의 사유 조립 부분을 `reasonPartTexts(reasons, slotLimited, refFast): string[]`로 떼어 낸다. `reasonTexts(stair, step)`는 고정 문구 상태(`emergency_stopped`·`skipped`·`partial`) 처리 뒤 `const ref = refStep(stair.steps, step.index); reasonPartTexts(step.reasons, step.slot_limited, ref != null && ref.p99_us < 1000)`를 부른다 — 리포트·인쇄·골든 패리티 출력 바이트 동일.
- 실행 중 이유 글자 = `reasonPartTexts(step_reasons[i]...)`을 `, `로 이어 괄호에 넣는다. (내 판단: 요약 줄이 그룹 사이를 ` · `로 나누므로 괄호 안은 `, `로 — 조각 글자 자체는 리포트와 같다.)
- **요약 줄**(`liveSummaryText`): 판정 실패 상태(`spike`·`saturated`·`unconfirmed`)이고 이유가 있는 계단은 묶지 않고 계단마다 한 그룹 — 「3 포화(오류 4.6%) · 4 포화(p99 3.9×)」(포화는 연속 두 계단일 수 있고 이유가 다를 수 있음). `ok`·`after`·`not_measured`는 지금처럼 묶고 이유를 안 붙인다(내 판단: 「포화 이후」 이유를 요약에 붙이면 50계단에서 줄이 감당 안 됨 — 툴팁으로).
- 잠정 실패(`unconfirmed`, 정지·동결 전) 라벨은 지금 「실패(다음 계단 확인 중)」 → 이유가 있으면 「실패(오류 4.6%, 다음 계단 확인 중)」(괄호 이중 방지, `ko.ts` 새 함수).
- **칩 라벨**(`title`=`aria-label`): 이유가 있는 모든 계단(`after` 포함) → 「3계단 포화(오류 4.6%, p99 3.9×)」. 이유 없는 칩은 지금과 같은 글자.
- 모든 새 글자는 `ko.ts` 경유.
- 실행 중 `partial` 칩에 리포트의 「일부 실행 — …」 행 문구를 붙이지 않는다(비목표 — 정지 줄이 이미 말함).

### 5.5 화면 — 머리 줄

`liveHeadText`: `current_step == null`이고 `judgedCount(live) > 0`이면 머리 줄 없음(§5.3의 전부 판정 — 계단 완결은 모든 워커 등록 뒤라 「등록 전 null」과 겹치지 않는다). `current_step == null`이고 판정 0이면 지금처럼 「첫 데이터 대기 중」(테스트로 고정).

### 5.6 화면 — 400px

`RunDetailPage.tsx`의 두 표를 각각 `overflow-x-auto` 상자로 감싼다(스텝 표도 같은 류라 함께 — 형제 경로 sweep). 패널은 이미 넘침 0(칩 줄바꿈)이고 요약 `<p>`는 `break-words`.

## 6. 불변식·테스트

1. **실행 중 = 리포트, 판정 도중에도**: 감시를 계단 하나씩 판정시키며 `judged`가 오를 때마다 요약을 찍고, 매 스냅숏에서 `i < judged`인 `step_reasons[i]`(`reasons`·`slot_limited`·`ref_fast`)가 같은 데이터의 최종 리포트 행(`steps[i].reasons`·`slot_limited`·`stair_ref_step` p99 < 1000)과 같다. fixture에 오류 사유·p99 배수 사유·1 ms 미만 기준 계단·`unconfirmed → spike`로 바뀌는 계단·`after` 사유를 넣는다(기존 `gen_run`은 dropped 실패만 만들어 부족 — 새 생성기나 손 fixture). 되돌려 확인: `ref_fast`를 잘못된 계단(예: 바로 앞 계단)에서 계산하면 RED — 이를 위해 fixture에 **`p99_relative` 사유를 가진 행(포화 k+1 또는 `after`) 중 바로 앞 계단이 `ok`가 아니고 p99 ≥ 1 ms이며, 진짜 기준 계단은 p99 < 1 ms인 행**을 반드시 넣는다(그 행에서 RED가 나야 이빨이 있다). UI 쪽: 같은 입력에서 실행 중 이유 조각 = `reasonTexts` 조각.
2. 리포트·인쇄·CSV·XLSX 사유 출력 무변경 — 기존 골든 패리티 테스트 무수정 통과.
3. 계단 아닌 run `RunResponse` 바이트 동일(기존 테스트 유지).
4. §5.3 경계: `current < judged`(중간 계단·마지막 계단), `current == judged`(보정 없음), 정지·동결과 겹칠 때. 되돌려 확인: 보정을 지우면 경계 테스트 RED.
5. 요약: 연속 포화 두 계단이 이유별로 갈라짐 · 이유 없는 `after`는 묶임 · 잠정 실패 괄호 한 겹 · 최다 조합 둘(달성·dropped·오류·p99 N.N× / 달성·dropped·슬롯 부족 의심).
6. Zod: `StairLiveSchema` strict에 `step_reasons` — 라이브 run 1회로 실행 중 상세 파싱 확인(S-D).
7. 엔진·워커·proto·migration diff 0.

## 7. 검증 (라이브 — US 척추)

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 응답기 + `status: 200` 단언(§B70 (4) ①)으로 계단 run — 오류로 실패하는 run과 지연으로 실패하는 run(한 run에 둘을 고르게 만들기 어려우면 두 run) | 요약 줄에 「N 튄 계단(오류 x%)」 또는 「M 포화(오류 x%)」, 지연 run엔 「(p99 y×)」 또는 「(p99 5 ms 이상)」 · 끝난 뒤 리포트 사유 칸과 조각 글자 같음(구분자만 다름) |
| US2 | 실패·포화 이후 칩에 hover / 접근성 트리 | `title`·`aria-label`에 상태+이유, 정상·측정 중·예정 칩 글자 불변 |
| US3 | 판정 순간을 페이지 안 `MutationObserver` 기록기로(§B70 (4) ②) | 판정된 계단을 「측정 중」으로 보인 기록 0 · 다음 계단 「상승 중」 · 전부 판정 뒤 머리 줄 없음 |
| US4 | 400px 뷰포트, 최다 조합 두 가지에 큰 숫자(dropped 1,000,000,000·p99 12345.6×)를 넣은 응답(Playwright 응답 가로채기 fixture) + 실제 라이브 run 화면 | 문서 폭 ≤ 화면 폭(rect), 표 상자만 스크롤, 요약 줄 겹침·잘림 0 |
| 성능 | 50계단 전부 이유 4개인 `LiveState`의 `build_live`+복제 시간과 `GET /api/runs/{id}` 응답 바이트를 master 대비(release 빌드 측정 테스트 또는 라이브) | 무시 가능 판정 근거 숫자가 build-log에 남음 |

추가: 콘솔 오류 0 · 계단 아닌 running run 상세 정상.

## 8. 빌더에게 남긴 것

- `ref_fast` 계산을 `build_live` 안에서 할지 감시가 미리 계산해 넘길지(어느 쪽이든 순수 함수 테스트 가능하면 됨).
- 화면 리팩터의 함수 이름·위치(`stairFormat.ts` 안 유지 권장).
- 툴팁 글자 길이가 매우 긴 경우의 처리는 브라우저 기본(`title`)에 맡긴다.
