# 열린 루프 곡선(open+curve) 슬롯(max_in_flight) 사이징 힌트 설계

- **날짜**: 2026-06-15
- **상태**: 설계 — 사용자 brainstorming 합의 완료(2026-06-15), spec-plan-reviewer 검토 대기
- **출처**: roadmap §A9 의도적 연기 — "open+curve 슬롯 힌트"(열린 루프 슬롯 사이징 헬퍼 spec `2026-06-14-open-loop-slot-sizing-helper-design.md` §10 첫 항목). 그 슬라이스(완료, 2026-06-15)는 **open+fixed**(고정 `target_rps`)에서만 슬롯 힌트를 띄웠다. 이 슬라이스는 같은 헬퍼를 **open+curve**(`stages` 곡선)로 확장한다 — 단계마다 목표 RPS가 달라 "단일 슬롯 수"는 **피크 단계 목표** 기준으로만 의미 있으므로, 그 피크를 유효 목표로 삼아 권장 `max_in_flight`를 계산한다.
- **자매/선행 슬라이스**: `2026-06-14-open-loop-slot-sizing-helper-design.md`(open+fixed 슬롯 헬퍼, 직접 확장 대상), `2026-06-14-closed-loop-sizing-helper-design.md`(닫힌 VU 헬퍼). 이 spec은 open+fixed 헬퍼의 컴포넌트(`SlotSizingHelper`)·순수 함수(`sizing.ts`)·`ko` 카탈로그·`LoadModelFields` optional-prop 게이팅을 **그대로 재사용**하고, 곡선 모드용 *피크 도출* + *문구 변형* 만 가산한다.
- **연관 ADR**: ADR-0031(open-loop·`target_rps`·`max_in_flight`·`stages`·`dropped`·단일워커 v1), ADR-0032(다단계 ramp `stages` piecewise-linear), ADR-0028(A4c/A9 insights·`load_gen_saturated` 사이징 — 단, 이건 리포트가 아니라 RunDialog), ADR-0035(한국어·`ko.ts`·초보자 친화). `docs/dev/capacity-planning.md`(§3 Little's Law 수동 절차).
- **ADR 신규 불필요**: 새 아키텍처 결정 없음. 순수 UI 슬라이스 — 엔진·워커·proto·migration·controller 무변경, run 생성 페이로드 byte-identical. 기존 엔드포인트·훅만 재사용.

---

## 1. 문제와 목표

RunDialog의 **열린 루프 곡선**(`loadModel === "open" && rateMode === "curve"`) 모드는 *동시 요청 상한(`max_in_flight`)* 1개 + *단계(stages)* 행들(`{target, duration_seconds}[]`, piecewise-linear RPS 곡선)을 입력받는다. open+fixed와 마찬가지로 초보 QA는 **"이 곡선을 내려면 max_in_flight를 몇으로 잡아야 하나"**를 모른다. 너무 낮게 잡으면 도착률이 가장 높은 단계에서 슬롯이 모자라 멀쩡한 요청이 drop되고(`dropped>0`), 사후 `load_gen_saturated`가 뜬다.

곡선 모드의 특수성: `max_in_flight`는 run **전체에 단일값**인데 도착률은 단계마다 다르다. 슬롯 풀은 **도착률이 가장 높은 단계**에서 가장 많이 쓰이므로, 그 **피크 단계 목표**(`max(stage.target)`)로 사이징하면 어느 단계에서도 drop이 없다. 이건 사후 인사이트가 곡선 run의 유효 목표를 잡는 방식과 **정확히 일치**한다(§2 항목 2).

**목표**: 열린 루프 곡선 섹션에 (open+fixed와 같은) 사이징 힌트를 둔다 —
1. 폼에 **이미 입력된 stages**에서 **피크 단계 목표**(`max(stage.target)`)를 도출하고,
2. 1회 요청의 **지연(latency)** 을 (가능하면) 실측에서 끌어와,
3. **권장 max_in_flight**(`ceil(peak × latency/1000).max(1)`)를 제시하고, "적용" 시 max_in_flight 입력칸을 채운다.

문구는 **피크 기준임을 명시**한다(사용자 합의, 2026-06-15) — 사용자가 단일 "목표 RPS"를 직접 입력한 게 아니라 단계들을 입력했으므로, "최고 단계 목표 N RPS 기준"으로 드러내야 혼동이 없다.

**비목표(연기)**: §10. 요약 — open-loop misconfig 경고, 측정값 영속화, 역방향 라이브 리드아웃, 스케줄 편집기 헬퍼, 다중-스텝 슬롯-홀드 정밀화, 단계별(per-stage) 슬롯 분해, XLSX/CSV 열.

---

## 2. 핵심 통찰 (설계의 근거)

1. **이건 open+fixed 헬퍼의 곡선 대칭 — 새 컴포넌트가 아니다.** 권장 수식(`recommendSlots`), 지연 출처 3계층(prior open-loop run p50 → 수동 추정 → test-run 측정), 앵커 도출(`usePriorOpenRunAnchor`/`pickLatestOpenRun`), 게이팅(optional `onApplyMaxInFlight` + `sizingScenarioId`), 컨테이너 스타일·HelpTip 배치는 **전부 그대로**다. 곡선이 더하는 건 단 두 가지: (a) **피크 목표 도출**(stages → `max(target)`), (b) **피크 기준 문구 변형**.

2. **피크 = `max(stage.target)`는 사후 인사이트와 1:1 parity.** 사후 `load_gen_saturated`(`crates/controller/src/report.rs:616-621`)는 곡선 run의 유효 목표를 `run.profile.target_rps.or_else(|| stages.iter().map(|st| st.target).max())` 로 잡는다 — 즉 **stages-peak**. 그 유효 목표로 `insights.rs:224`가 `required = ceil(target × p50_ms/1000)`를 계산한다. 이 헬퍼의 피크 도출(`peakStageTarget`)이 `report.rs`의 `.max()`와 **같은 수식**이고, 이어지는 `recommendSlots`가 `insights.rs:224`와 **같은 산술**이므로, open+fixed 헬퍼가 가진 "사전 == 사후 수식 일치" 불변식이 곡선에서도 그대로 성립한다.
   - 단, open+fixed와 동일하게 **값 동치는 prior-run 경로 한정·예측**이다(미래 run의 실제 p50에 의존). measured/estimate 경로는 무부하/추정 입력이라 **하한**. 문구로 "최소 출발점" 명시.

3. **피크는 문자열 드래프트에서 실시간 도출.** stages는 RunDialog의 string-draft state(`{target: string; duration_seconds: string}[]`, ui/CLAUDE.md "다단계 ramp UI" 함정 — onBlur-commit 불요, submit이 최종 경계). `peakStageTarget`은 각 행 `target`을 `Number()` 파싱해 **유효 정수(1..=1,000,000)만** 후보로 최대값을 취한다(부분 입력·`""`·비정수·범위 밖·`0`은 후보 제외). 후보가 없으면 `null` → 권장 미표시 + 곡선용 폴백 문구. 사용자가 단계를 편집하면 피크가 즉시 갱신돼 권장값도 재계산된다.

4. **지연 앵커는 곡선 prior도 이미 유효.** `pickLatestOpenRun`(open+fixed 헬퍼)은 `is_open_loop` 양성 식(`target_rps != null || stages?.length`)으로 open-loop run을 고르므로 **곡선 run도 이미 포함**한다(선행 spec §5.1 line 97 명시: "open+curve prior도 앵커로 유효 — stages 런의 `summary.p50_ms`도 부하 하 요청당 p50 집계라 대표 지연"). 따라서 앵커 경로는 **무변경 재사용**.

5. **게이팅은 구조적으로 open+curve에만.** 곡선 에디터 JSX(`curveEditor`)는 `LoadModelFields`에서 closed+curve(VU 곡선)와 **공유**된다(`LoadModelFields.tsx`). 슬롯 힌트는 슬롯(max_in_flight)이 의미 있는 **open**에만 떠야 하고 closed+curve(VU 곡선)엔 무관하다. open 브랜치의 `rateMode==="curve"` 케이스에서만 헬퍼를 렌더하므로, closed+curve는 `loadModel==="closed"` 브랜치라 구조적으로 미렌더 — 추가 가드 불요. RunDialog만 `onApplyMaxInFlight`를 넘기는 기존 게이팅(§3.1)이 ScheduleForm 누수도 막는다.

---

## 3. 범위

**In (이 슬라이스)**:
- 열린 루프 **곡선**(`loadModel === "open" && rateMode === "curve"`) 모드에서 슬롯 힌트 렌더(기존 open+fixed에 더해).
- **RunDialog에서만** 노출(§3.1 — `LoadModelFields`는 `ScheduleForm`과 공유 컴포넌트).
- stages의 **피크 단계 목표** → 권장 max_in_flight 산출, "적용" 버튼으로 max_in_flight 입력칸 채움.
- 지연 출처 3계층(open+fixed와 동일): 최근 종료 open-loop run p50 → 사용자 추정 지연 → test-run 측정.
- 피크 기준임을 드러내는 문구 변형(`formula`/`needTarget`).

**Out (연기 → §10)**:
- **단계별(per-stage) 슬롯 분해** — 단계마다 다른 권장 슬롯. v1은 단일 피크 기준만(max_in_flight가 단일값이라 피크가 충분 조건).
- **open-loop misconfig 경고**, **측정값 영속화**, **역방향 라이브 리드아웃**, **스케줄 편집기 헬퍼**, **다중-스텝 슬롯-홀드 정밀화**, **XLSX/CSV 열** — open+fixed spec §10과 동일하게 연기.

**3.1 공유 컴포넌트 `LoadModelFields` 처리 (기존 게이팅 재사용)**
`LoadModelFields`는 `RunDialog.tsx`와 `ScheduleForm.tsx` 둘 다 마운트한다. open+fixed 헬퍼가 도입한 게이팅을 **그대로 재사용**한다: 헬퍼는 **`onApplyMaxInFlight && sizingScenarioId !== undefined`일 때만** 렌더한다. RunDialog는 `onApplyMaxInFlight`를 전달, ScheduleForm은 미전달 → 스케줄 편집기엔 슬롯 헬퍼 부재. **신규 prop 0개** — 곡선은 기존 `onApplyMaxInFlight`/`sizingScenarioId`/`sizingEnv`를 그대로 쓴다(open+fixed가 이미 받는 그 prop들).

---

## 4. 입력과 출처

**4.1 피크 목표 (폼의 stages에서 도출 — 읽기만)**
- open+curve의 stages는 `LoadModelFields`의 string-draft state `stages: { target: string; duration_seconds: string }[]`(`LoadModelFields.tsx:11,28`). 신규 순수 함수 `peakStageTarget(stages)`가 각 행 `target`을 `Number()` 파싱, **유효 정수(`targetRpsValid`와 동일 1..=1,000,000)만** 후보로 최대값 반환, 없으면 `null`.
  - `"0"`·`""`·`"1.5"`·`"2000000"`·`"abc"`는 후보 제외(범위/정수 가드). 모든 단계가 그렇거나 stages가 비면 `null`.
- 컴포넌트가 `peakStageTarget(stages)`를 `String(peak)`(없으면 `""`)로 만들어 기존 `SlotSizingHelper`의 `targetRps` prop(="유효 목표 문자열")에 넘긴다 — 헬퍼 내부 `Number(targetRps)`·`recommendSlots` 경로는 무변경.
- **자체 입력칸·프리필 없음** — peak는 폼 stages에서만 도출. 전송 페이로드(`max_in_flight`+`stages`)는 그대로.
- **곡선 모드에선 `targetRps`가 항상 "유효 정수 문자열" 또는 `""`** (`peakStageTarget`이 유효 후보 최대값/null만 반환) — 절대 "non-empty-but-invalid"가 아니다. 따라서 `SlotSizingHelper.tsx:150-152`의 침묵 분기(목표가 non-empty-but-invalid일 때 폼의 `targetRpsInvalid` 에러가 대신 표시하므로 헬퍼는 침묵)는 **곡선에선 도달 불가**. 곡선의 "권장 없음" 경로는 정확히 두 가지뿐: `cannotCompute`(지연 출처 없음)와 `needTargetCurve`(peak null). 부분 입력 단계의 "단계를 고치세요" 안내는 헬퍼가 아니라 폼-레벨 `stagesInvalid` 배너(`LoadModelFields.tsx:171-175`, open/closed curve 공유)가 담당한다.

**4.2 지연 = 요청당 latency — open+fixed와 동일 3계층 (무변경 재사용)**
| 우선 | 출처 | latencyMs | 신뢰도 |
|---|---|---|---|
| 1 | 최근 종료 open-loop run | `priorReport.summary.p50_ms` | 높음 |
| 2 | 사용자 추정 지연 | "예상 평균 응답시간(ms)" 입력 | 낮음(garbage-in) |
| 3 | test-run 1회 측정 | `trace.total_ms / R`(R=응답 있는 스텝 수) | 중간(무부하 하한) |

- 런타임 precedence(`prior` > `estimate` > `measured`), truncated 가드, `p50_ms>0` 앵커 가드는 전부 open+fixed 헬퍼(`SlotSizingHelper.tsx`)의 기존 로직 그대로. **곡선이라고 달라지는 것 없음** — 앵커 prior가 곡선 run이어도 `summary.p50_ms`는 동일한 요청당 p50 집계.

---

## 5. 권장 계산 (순수 함수)

`ui/src/components/sizing.ts`(슬롯 헬퍼의 `recommendSlots`/`pickLatestOpenRun`이 사는 곳)에 **피크 도출 함수 1개를 추가**한다. `recommendSlots`/`pickLatestOpenRun`/`usePriorOpenRunAnchor`는 무변경.

**5.1 피크 목표 도출** `peakStageTarget(stages: { target: string }[]): number | null`
```
입력: stages — 각 행에 문자열 target(string-draft)
후보: stages.map(s => Number(s.target)).filter(targetRpsValid)   // 정수 1..=1_000_000
반환: 후보 비면 null, 아니면 Math.max(...후보)
```
- `targetRpsValid`(sizing.ts 기존 헬퍼, `recommendVus`/`recommendSlots`가 쓰는 그것)를 재사용 → 슬롯/VU 헬퍼와 동일 범위. `peakStageTarget`은 `{ target: string }[]` 구조 타입만 받아 React/컴포넌트 의존 없음(`loadModel.ts`의 순수 분리 철학).
- 결과 == `report.rs:620`의 `stages.iter().map(|st| st.target).max()`(단, 여기선 유효성 필터 + 문자열 파싱 추가 — UI는 편집 중 부분 입력을 견뎌야 하므로). 유효 단계 집합이 같으면 두 피크는 동일.

**5.2 권장식** — 기존 `recommendSlots(targetRps, latencyMs)` 재사용(무변경). `targetRps = peak`(피크 목표). `recommendedSlots = max(1, ceil(peak × latencyMs / 1000))` = `insights.rs:224` `required`(곡선 유효 목표 = stages-peak일 때).
- **알려진 한계(v1 수용, open+fixed와 공유)**: 다중-스텝 과소추정·measured 무부하 하한·prior 부하 의존·상한(10,000) 초과 비차단 경고 — 전부 open+fixed spec §5.2와 동일. 곡선 고유 한계 = **피크가 아닌 단계는 슬롯이 남는다**(피크 기준이라 보수적 = drop 방지엔 안전, 단계별 분해는 §10).

---

## 6. 데이터 흐름

```
RunDialog (stages/setStages, maxInFlight/setMaxInFlight, loadModel, rateMode, env …)
  └─ <LoadModelFields … onApplyMaxInFlight={(n)=>setMaxInFlight(String(n))} sizingScenarioId sizingEnv>
       (open 브랜치 → rateMode==="curve" 케이스)
         {curveEditor}                                  ← 기존 곡선 에디터(stage 행·미리보기) 무변경
         peakStr = useMemo(()=>{ const p=peakStageTarget(stages); return p!=null?String(p):"" }, [stages])
         {onApplyMaxInFlight && sizingScenarioId!==undefined && (
           <SlotSizingHelper                            ← 기존 컴포넌트 재사용 (peakBased=true)
             scenarioId={sizingScenarioId}
             env={sizingEnv ?? {}}
             targetRps={peakStr}                        ← 피크 목표(문자열)
             peakBased                                  ← 곡선 문구 변형 플래그(신규 optional prop)
             onApply={onApplyMaxInFlight} /> )}
```
- 헬퍼는 자족 유닛 그대로(prior run/report/scenario yaml을 기존 훅으로 fetch). `LoadModelFields`는 stages에서 peak를 도출해 `targetRps`로만 내려준다.
- 슬롯 헬퍼는 open+fixed와 open+curve **두 arm**에 렌더되지만 동시에 뜨지 않는다(rateMode 배타). closed+curve(VU 곡선)는 다른 브랜치라 미렌더(§2 항목 5).

---

## 7. UX·동작

**7.1 위치·노출**: open 브랜치 `rateMode==="curve"` 케이스에서 `curveEditor`(stage 행·총 길이·미리보기) **바로 아래**. open+fixed가 target/duration 그리드 아래에 두는 것과 시각적으로 대칭. closed±(fixed/curve)에선 미렌더(§2 항목 5).

**7.2 재계산**: 사용자가 stage `target`을 편집하면 `peakStr`(useMemo([stages]))가 갱신 → `recommendSlots` 즉시 재계산. 자체 입력 state(추정 지연 `estMs` 외)가 없어 닫힌 헬퍼의 "비동기 1회 시드 race" 가드 불요(open+fixed와 동일).

**7.3 적용**: 권장값은 제안만. "적용" → `onApply(recommendedSlots)` → `setMaxInFlight(String(n))`. 조용한 덮어쓰기 없음.

**7.4 피크 기준 문구 변형(`ko.ts` — ADR-0035, 캐주얼 `-요`체로 기존 `ko.slotSizing`과 통일)**:
`SlotSizingHelper`에 optional `peakBased?: boolean`(기본 false). `true`일 때 **두 문구만** 곡선 변형으로 — 나머지(title/help/anchor `fromPriorRun`/measure caveat/`recommend`/`cannotCompute`/`overCapacity`)는 fixed와 **공유**:
- `formula` → **`ko.slotSizing.formulaPeak`**: *"최고 단계 목표 {targetRps} RPS × 지연 {L}ms ≈ 동시 {n}슬롯"* (피크 기준 명시).
- `needTarget`(유효 목표 없음 = peak null → `targetRps===""`) → **`ko.slotSizing.needTargetCurve`**: *"단계 목표를 먼저 입력하세요."* (fixed의 "위에서 목표 RPS를 먼저 입력하세요"는 곡선엔 부정확).
- 조사 병기 caveat은 **`formulaPeak`에만** 적용: `formulaPeak`만 `{targetRps}`·`{n}` 변수를 치환하므로 명사 뒤 조사는 `(으)로`/`(은)는` 병기형(ui/CLAUDE.md "사이징 권장" 함정 — `~500으로` 비문 회피)이고 RTL 단언 정규식도 `\(으\)로` escape. **`needTargetCurve`는 변수 치환이 없어 조사 병기 불요**(고정 문자열) — 불필요한 `(으)로`를 넣지 말 것.

**7.5 접근성·일관성**: open+fixed 헬퍼와 동일 컴포넌트라 컨테이너 스타일·라벨 연결·HelpTip 배치·`<button type="button">` 그대로.

---

## 8. 건드리는 곳 (UI-only)

**수정**:
- `ui/src/components/sizing.ts` — `peakStageTarget(stages)` 순수 함수 **추가**(기존 `targetRpsValid` 재사용). `recommendSlots`/`pickLatestOpenRun`/타입 무변경.
- `ui/src/components/SlotSizingHelper.tsx` — `Props`에 **`peakBased?: boolean` 1개 추가**(기본 false). `formula`/`needTarget` 문구만 `peakBased ? ko.slotSizing.formulaPeak/needTargetCurve : 기존`로 분기. `targetRps` prop JSDoc을 "유효 목표 문자열(fixed=폼 목표 RPS, curve=stages 피크)"로 일반화. **나머지 로직(앵커/측정/precedence/recommendSlots) 무변경.**
- `ui/src/components/LoadModelFields.tsx` — open 브랜치 `rateMode==="curve"` 케이스(현재 `curveEditor`만 렌더, `LoadModelFields.tsx:491-493`)를 `<>{curveEditor}{게이트 && <SlotSizingHelper … targetRps={peakStr} peakBased … />}</>`로. `peakStr`는 `useMemo(()=>peakStageTarget(stages)…, [stages])`로 컴포넌트 본문에서 도출. **신규 prop 0개**(기존 `onApplyMaxInFlight`/`sizingScenarioId`/`sizingEnv` 재사용).
- `ui/src/i18n/ko.ts` — `ko.slotSizing`에 `formulaPeak`·`needTargetCurve` 2개 문자열 **추가**(기존 키 무변경).

**무변경(명시)**:
- `ui/src/components/RunDialog.tsx` — 이미 `onApplyMaxInFlight={(n)=>setMaxInFlight(String(n))}`+`sizingScenarioId`+`sizingEnv`를 전달 중(open+fixed 헬퍼가 도입). 곡선은 같은 prop을 탄다 → **호출부 무변경**.
- `ui/src/components/ScheduleForm.tsx` — 무변경(`onApplyMaxInFlight` 미전달 → 슬롯 헬퍼 부재).
- 엔진·워커·proto·controller·migration·Zod 와이어 스키마·run 생성 페이로드. → 머지 diff는 **`ui/` 한정**(sizing.ts/SlotSizingHelper/LoadModelFields/ko.ts + 테스트).

---

## 9. 테스트 전략

- **순수 함수**(`sizing.test.ts`에 추가): `peakStageTarget` — 빈 배열→null, 전부 무효(`""`/`"abc"`/`"0"`/`"1.5"`/`"2000000"`)→null, 혼합(유효+무효)→유효 중 최대, 단일 유효→그 값, 정렬 무관(오름·내림차 동일 결과), 경계(`"1"`/`"1000000"` 포함·`"1000001"` 제외). **parity 락인**: 같은 유효 단계 집합의 `peakStageTarget` → `recommendSlots(peak, p50)`가 `insights.rs:224` 수식(`ceil(peak × p50/1000)`)과 동일 산술(open+fixed 헬퍼의 insight-동치 테스트와 같은 형태로).
- **컴포넌트**(`SlotSizingHelper.test.tsx`에 추가): `peakBased` 문구 변형 — (a) `peakBased` + 앵커/유효 목표 있음 → `formulaPeak`("최고 단계 목표 …") 렌더, (b) `peakBased` + 목표 빈("") → `needTargetCurve`("단계 목표를 먼저 …") 렌더. 기존 fixed 케이스(`peakBased` 미지정)는 기존 문구 유지(회귀 가드). 조사 병기 정규식 escape.
- **모드 분기**(`LoadModelFields.test.tsx` **갱신**): 현재 슬롯 헬퍼 락인은 `open+curve`를 "미렌더" it.each에 둠(`LoadModelFields.test.tsx:217-229`). 이걸 **뒤집는다**:
  - 신규: `open+curve` + `onApplyMaxInFlight` + `sizingScenarioId` → 슬롯 헬퍼 **렌더**.
  - "미렌더" it.each에서 `{loadModel:"open",rateMode:"curve"}` **제거**, `closed+fixed`·`closed+curve`만 남김(여전히 미렌더).
  - 기존 open+fixed 렌더·`onApplyMaxInFlight`/`sizingScenarioId` 반쪽 가드 케이스(`:195-214`)는 무변경(회귀 가드). VU 헬퍼 락인(`:180-193`, testid `sizing-helper` — 슬롯 testid `slot-sizing-helper`와 별개라 open+curve 렌더 추가와 무충돌) 무변경.
- **게이트**: `pnpm lint && pnpm test && pnpm build`(`tsc -b` Zod-default 누출·discriminated union). 머지 전 인자 없는 전체 `pnpm test` 1회(S-D 함정 — `RunDialog`/`LoadModelFields` 외 파일 잠복 red 차단).
- **라이브(Playwright + `/live-verify`)**: open+curve RunDialog에서 —
  - (a) 최근 open-loop run 있는 시나리오(앵커 prior는 **≥50ms 지연 responder**로 — localhost sub-ms는 `p50_ms==0`이라 앵커 null, engine CLAUDE.md) → stages 입력(피크 200) → p50 기반 권장 슬롯(`ceil(200×p50/1000)`)·**"최고 단계 목표 200 RPS"** 문구·stage target 바꿔 피크 변경 시 재계산·적용→`동시 요청 상한` 칸 반영.
  - (b) run 없는 시나리오 → test-run 측정 버튼→권장값+한계 문구.
  - (c) **수식 parity**: 권장값으로 실제 open+curve run 생성 → 부족하게(피크보다 낮게) 잡은 대조 run에서 `load_gen_saturated`의 `required`가 **같은 수식(stages-peak × p50)** 으로 나오는지 = 헬퍼 권장과 산술 일치(`report.rs:616-621` 곡선 유효 목표 경로 라이브 확인). open+fixed 헬퍼 라이브 때 검증한 "max_in_flight=2 과소→사후 recommended=11=UI 권장" parity의 곡선판.
  - 콘솔 Zod 0. React controlled input은 native setter(루트 CLAUDE.md), click과 단언은 별도 evaluate.

---

## 10. 의도적 연기 (roadmap §A9에 누적)

- **단계별(per-stage) 슬롯 분해** — max_in_flight가 단일값이라 v1은 피크 기준 하나만. 단계마다 권장 슬롯을 따로 보여주는 건 별도(현 v1은 피크로 보수적 사이징 = drop 방지 충분).
- **open-loop misconfig 경고**·**측정값 영속화**·**역방향 라이브 리드아웃**·**스케줄 편집기(`ScheduleForm`) 슬롯 헬퍼**·**다중-스텝 슬롯-홀드 정밀화**·**XLSX/CSV recommended/cause 열** — open+fixed spec §10과 동일하게 연기(상태 변화 없음).
