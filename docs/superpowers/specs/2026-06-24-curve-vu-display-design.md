# 곡선 run VU 표시 개선 — VUs 카드·run 목록 열의 "0"을 의미 있는 표시로 (B9 — ADR-0037 §9 연기 항목)

- **날짜**: 2026-06-24
- **상태**: 설계 승인(사용자 2026-06-24) → plan 대기
- **출처**: roadmap §B9 "곡선 run의 VU 표시 개선" 연기 항목. **왜 지금**: closed-loop VU 곡선 run이 RunDetailPage VUs 카드·run 목록 VUs 열에서 `0`으로 떠 "부하가 0이었나?"로 오인된다(곡선 run의 부하는 `vus`가 아니라 `vu_stages`에 있다). open-loop도 같은 `0` 표시 문제(VU 개념 없음). 사용자가 다음 슬라이스로 선택(2026-06-24).
- **연관**: ADR-0037(closed-loop VU 곡선·`vu_stages`), ADR-0032(open-loop `stages`), `profileDurationSeconds`(runPrefill.ts — 곡선 `duration_seconds=0` 동형 선례), `deriveLoadMode`(loadModel.ts — 모드 역도출 단일 소스), B9 sharding 슬라이스(`vu_curve_max`=total_vus=peak 개념).
- **ADR**: 신규 불필요(ADR-0037 범위 내 additive·표시 전용·와이어 무변경). 근거: payload/proto/migration 무변경, read-only UI 표시만 바꾼다.

---

## 1. 문제와 목표

RunDetailPage VUs 카드(`RunDetailPage.tsx:220`)와 run 목록 VUs 열(`ScenarioRunsPage.tsx:302`)은 `r.profile.vus`를 그대로 렌더한다. closed-loop VU 곡선 run은 `buildLoadProfile`이 `vus: 0` + `vu_stages`를 emit하므로 두 표면이 `0`을 보여 "동시 사용자 0명으로 돌았나?"로 오인된다. open-loop run도 `vus=0`(VU 개념 없음)이라 같은 `0`을 보인다. 곡선 run의 실제 설계 부하(VU 최고점)와 open-loop의 "VU 무관" 사실이 두 표면에서 사라진다.

- **목표**: closed+curve run은 "최대 N (곡선)"(N = `vu_stages` 최고점), open-loop(고정/곡선) run은 "—"(VU 해당 없음)로 표시. closed+fixed run은 현행 숫자 그대로(byte-identical). 두 표면(VUs 카드·목록 열) + RunDetailPage raw 프로필 섹션의 같은-화면 모순 1줄까지. **UI-only**.
- **비목표(연기)**: §7 참조. open-loop의 RPS/슬롯 실값 표시·곡선 run 목록 정렬/필터·raw 섹션 `duration=0s` rawness·ReportHeadline/ActiveVuChart(이미 곡선 인지).

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST closed+curve run(=`vu_stages` 비어있지 않음)의 VUs 카드·목록 열은 "최대 N (곡선)"으로 표시하고 N = `max(vu_stages[].target)`이다. | `profileVuDisplay` 단위(curve→`{kind:"curve",peak}`) + `RunVuCell` 렌더 "최대 50 (곡선)" + 두 페이지 스모크 | |
| R2 | MUST open-loop run(`target_rps` 또는 `stages` 보유)의 VUs 카드·목록 열은 "—"로 표시하고, 마우스 `title`·스크린리더 `aria-label`로 "VU 해당 없음 — 열린 루프(RPS·슬롯 기반)"를 노출한다. | `profileVuDisplay` 단위(open±curve→`{kind:"open"}`) + `RunVuCell` 렌더(텍스트 "—"·aria-label/title) | |
| R3 | MUST closed+fixed run의 VUs 카드·목록 열 표시는 종전과 동일한 `vus` 숫자다(byte-identical). | `profileVuDisplay` 단위(fixed→`{kind:"fixed",vus}`) + 기존 RunDetailPage/ScenarioRunsPage 테스트 무수정 통과 | |
| R4 | MUST 모드 4분류(closed/open × fixed/curve)는 `deriveLoadMode`를 재사용한다 — `profileVuDisplay`가 독립적인 `vu_stages`/`target_rps` 분기를 새로 짜지 않는다(곡선 증발 drift 방지). | 코드: `profileVuDisplay`가 `deriveLoadMode(profile)` 호출 + grep로 독립 mode 분기 부재 | |
| R5 | MUST `profileVuDisplay`/`RunVuCell`은 `Pick<Profile, "vus"\|"target_rps"\|"stages"\|"vu_stages">`를 받아 `RunSchema.profile`(nested-default leak `number\|undefined`)을 `normalizeProfile` 없이 수용한다. | `pnpm build`(`tsc -b`) green·페이지가 `r.profile` 직접 전달(`profileDurationSeconds` 패턴) | |
| R6 | MUST 두 표면(RunDetailPage 카드·ScenarioRunsPage 열)은 공유 프레젠테이셔널 `RunVuCell`을 거쳐 동일 표시를 낸다(per-surface 복붙 drift 방지). | 두 페이지가 `RunVuCell` import·사용(grep) | |
| R7 | MUST RunDetailPage raw 프로필 섹션(`<li>vus = …`)이 곡선 run에서 카드("최대 N (곡선)")와 같은 화면에 `vus = 0`만 보여 모순되지 않게, curve일 때 `vu_stages = 최대 N · M단계` 줄을 추가한다(raw `vus =` 줄은 와이어값이라 유지). 이 raw 섹션은 `terminal && report.data`의 **else**에서만 렌더되므로(L240–269) 테스트는 **running 또는 report-없는** 곡선 fixture를 써야 한다(terminal+report fixture면 ReportView가 대신 떠 줄이 안 보임). | **running/report-less** 곡선 fixture 렌더에 `vu_stages` 줄 존재·non-curve엔 부재 | |
| R8 | MUST 신규 표시 텍스트(곡선 문구·open 힌트·raw 곡선 줄)는 전부 `ko.ts` 카탈로그 경유다(ADR-0035) — 인라인 한국어/영어 0. `aria-label`/`title`도 포함. | grep: `RunVuCell.tsx`·변경된 페이지에 인라인 사용자노출 문자열 0·`ko.*` 키 사용 | |
| R9 | MUST 와이어·payload 무변경 — read-only 표시만 바꾼다. proto/migration/engine/controller·`api/schemas.ts` 0-diff, run 생성 payload byte-identical. | 머지 diff `git diff --name-only` = `ui/`(+docs)만·`schemas.ts` 무변경 | |

- **`seam?`** 없음: 이 슬라이스는 **계약 경계를 건드리지 않는다**(R9). `vu_stages`/`target_rps`/`stages`는 이미 `ProfileSchema`·와이어에 존재하므로 Zod/proto/migration 변경이 없다. 순수 read-only 표시 변경.

---

## 3. 핵심 통찰 (설계 근거)

1. **`deriveLoadMode` 재사용이 R4(drift 방지)의 핵심.** loadModel.ts:148 주석이 경고하듯 모드 역도출을 여러 곳에서 따로 짜면 "vu_stages 든 프로필이 closed+fixed로 조용히 로드돼 곡선이 증발"한다. `profileVuDisplay`도 같은 4분류가 필요하므로 독립 분기를 새로 짜지 않고 `deriveLoadMode`를 호출한다 — `loadModel==="open"`→open, `closed`+`curve`→curve(peak), 그 외(closed+fixed)→fixed.
2. **헬퍼 위치 = `components/loadModel.ts`(레이어링).** `profileVuDisplay`는 의존성 `deriveLoadMode`·`Profile` 타입과 같은 파일에 둔다. `api/`는 `components/`를 import하지 않는 레이어링(grep 확인)이라, 개념상 형제인 `profileDurationSeconds`(api/runPrefill.ts) 옆에 두면 api→components 역의존이 생긴다. 소비처(pages/)는 양쪽을 import할 수 있으므로 무문제. 헬퍼 doc에 "`profileDurationSeconds`의 `Pick<>` leak-회피 패턴 미러"를 명시한다.
3. **peak = `max(vu_stages.target)`가 엔진 `vu_curve_max`(=total_vus=fan-out peak)와 같은 개념.** closed+curve run은 엔진이 ≥1개 `target>0` stage를 강제하므로 `vu_stages`는 비어있지 않고 peak ≥ 1. 설계 부하(`profile.vu_stages`)에서 도출하므로 리포트(`active_vu_series` actual)가 없어도(running 중에도) 표시 가능 — 카드/목록은 run 객체만 받고 리포트를 안 받는다.
4. **공유 `RunVuCell`이 R6(두 표면 일치).** 카드(`<Card>` 안)와 목록 열(`<td>` 안)이 같은 내부 콘텐츠(텍스트 또는 span)를 내야 한다. 프레젠테이셔널 컴포넌트 하나가 ko 사용·a11y(open의 aria-label/title)를 한 곳에 모아 per-surface 복붙 drift와 a11y 누락을 막는다.
5. **open은 "—"(R2) — VU 자리에 거짓 숫자(0)를 안 둔다.** open-loop 부하는 `target_rps`/`max_in_flight`로 정의되며 VU 자체가 없다. "0 VU"는 "부하 0"으로 오인되므로 "해당 없음"을 punctuation `—`(시각)+의미 있는 `aria-label`/`title`(SR·hover)로 표현한다. raw `—`는 punctuation이라 ko 카탈로그 불요지만, 힌트 문구는 ko 경유(R8).

---

## 4. 변경 상세

### 4.1 `ui/src/components/loadModel.ts` — 충족 R: R1, R2, R3, R4, R5
`deriveLoadMode` 바로 아래에 순수 헬퍼 추가:
```ts
export type VuDisplay =
  | { kind: "fixed"; vus: number }   // closed+fixed → 숫자 그대로
  | { kind: "curve"; peak: number }  // closed+curve → "최대 N (곡선)"
  | { kind: "open" };                // open-loop(고정/곡선) → "—"

/** 한 run의 VU 표시 방식. closed+fixed→리터럴 `vus`; closed+curve(vu_stages)→곡선
 *  최고점(max target)을 "최대 N (곡선)"으로; open-loop(target_rps/stages)는 VU 개념이
 *  없어 "—". 모드 역도출은 deriveLoadMode 단일 소스(곡선 증발 drift 방지). 읽는 필드만
 *  Pick해 RunSchema.profile(nested-default leak)을 normalizeProfile 없이 수용
 *  (profileDurationSeconds 패턴). */
export function profileVuDisplay(
  profile: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages">,
): VuDisplay {
  const { loadModel, rateMode } = deriveLoadMode(profile);
  if (loadModel === "open") return { kind: "open" };
  if (rateMode === "curve")
    return { kind: "curve", peak: Math.max(...(profile.vu_stages ?? []).map((s) => s.target)) };
  return { kind: "fixed", vus: profile.vus };
}
```
- `deriveLoadMode`의 param 타입(`target_rps?`/`stages?`/`vu_stages?`)은 `Pick<Profile,...>`로 구조적 호환(추가 필드 `vus` 무관).

### 4.2 `ui/src/components/RunVuCell.tsx` (신규) — 충족 R: R1, R2, R6, R8
프레젠테이셔널 컴포넌트:
```tsx
export function RunVuCell({
  profile,
}: {
  profile: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages">;
}) {
  const vu = profileVuDisplay(profile);
  if (vu.kind === "curve") return <>{ko.report.vusCurvePeak(vu.peak)}</>;
  if (vu.kind === "open")
    return (
      <span title={ko.report.vusOpenHint} aria-label={ko.report.vusOpenHint}>
        —
      </span>
    );
  return <>{vu.vus}</>;
}
```
- `<>...</>` fragment라 호출부 `<Card>`/`<td>`가 래퍼를 소유. open만 span(a11y).

### 4.3 `ui/src/pages/RunDetailPage.tsx` — 충족 R: R1, R2, R3, R6, R7
- L220 카드: `<Card label={ko.runDetail.cardVus}>{r.profile.vus}</Card>` → `<Card label={ko.runDetail.cardVus}><RunVuCell profile={r.profile} /></Card>`.
- L262–269 raw 프로필 섹션(`<ul>` L264–268, `vus`/`duration`/`ramp_up` 3 `<li>`): **`<ul>` 안 마지막 항목으로**(즉 `<li>ramp_up = …</li>`(L267) 바로 뒤, `</ul>`(L268) 앞) curve일 때 한 줄 추가:
```tsx
{r.profile.vu_stages && r.profile.vu_stages.length > 0 && (
  <li>vu_stages = {ko.runDetail.profileVuStages(
    Math.max(...r.profile.vu_stages.map((s) => s.target)),
    r.profile.vu_stages.length,
  )}</li>
)}
```
  (raw `vus =`·`duration =`·`ramp_up =` 줄은 와이어값이라 유지 — R7.) **주의**: 이 raw 섹션은 `{terminal && report.data ? <ReportView/> : <>…raw…</>}`(L240–269)의 else 가지라, 리포트가 로드된 terminal run에선 `<ReportView>`로 대체돼 이 줄이 안 보인다(그땐 카드가 곡선을 표시). R7 테스트는 **running 또는 report-없는** 곡선 fixture를 쓸 것.

### 4.4 `ui/src/pages/ScenarioRunsPage.tsx` — 충족 R: R1, R2, R3, R6
- L302: `<td className="py-3 pr-4">{r.profile.vus}</td>` → `<td className="py-3 pr-4"><RunVuCell profile={r.profile} /></td>`.

### 4.5 `ui/src/i18n/ko.ts` — 충족 R: R8
- `ko.report`에: `vusCurvePeak: (n: number) => `최대 ${n} (곡선)``, `vusOpenHint: "VU 해당 없음 — 열린 루프(RPS·슬롯 기반)"`.
- `ko.runDetail`에: `profileVuStages: (peak: number, count: number) => `최대 ${peak} · ${count}단계``.

---

## 5. 무변경 / 불변식 (명시)

- **proto/migration/engine/controller/워커 0-diff**(R9) — `vu_stages`/`target_rps`/`stages`는 이미 와이어·`ProfileSchema`에 존재.
- **`api/schemas.ts`·`api/runPrefill.ts` 무변경** — `ProfileSchema`(`vu_stages`/`stages`/`target_rps` 이미 `.optional()`/`.nullish()`)·`profileDurationSeconds`/`normalizeProfile` 건드리지 않음.
- **closed+fixed run byte-identical** — `RunVuCell`이 `{vus}`를 그대로 렌더(R3). run 생성 payload·기존 fixed-run 테스트 무변경.
- **ReportHeadline·ActiveVuChart 무변경** — 이미 곡선 인지(`ko.report.*Curve` 헤드라인·실제 VU 곡선 차트). 카드/목록 열만 갭이었음.
- **raw 섹션 `duration = 0s`·`ramp_up`** — 곡선 run에서 raw `0s`로 뜨는 건 pre-existing(VU 스코프 밖, §7 연기).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `loadModel.test.ts` `profileVuDisplay`: curve fixture→`{kind:"curve",peak:50}`. `RunVuCell.test.tsx`: curve→"최대 50 (곡선)". 페이지 스모크(곡선 fixture) | |
| R2 | `profileVuDisplay`: open+fixed·open+curve fixture→`{kind:"open"}`. `RunVuCell.test.tsx`: open→텍스트 "—"+`aria-label`/`title` 단언 | |
| R3 | `profileVuDisplay`: closed+fixed→`{kind:"fixed",vus:N}`. 기존 RunDetailPage/ScenarioRunsPage 테스트(fixed run "50") 무수정 통과 | |
| R4 | 코드리뷰: `profileVuDisplay`가 `deriveLoadMode` 호출. grep로 함수 내 독립 `vu_stages`/`target_rps` mode 분기 부재 | |
| R5 | `pnpm build`(`tsc -b`) green. 페이지가 `r.profile`(정규화 안 함) 직접 전달 컴파일 | |
| R6 | grep: `RunDetailPage.tsx`·`ScenarioRunsPage.tsx` 둘 다 `RunVuCell` 사용. `profile.vus` 직접 렌더 잔존 0(raw `<li>` 제외) | |
| R7 | `RunDetailPage.test.tsx`: **running/report-less** 곡선 fixture→`vu_stages = 최대 50 · 3단계` 존재; non-curve fixture→부재(raw 섹션은 `terminal && report.data` else에서만 렌더) | |
| R8 | grep: `RunVuCell.tsx`·변경 페이지·곡선 줄에 인라인 사용자노출 문자열 0. `ko.report.vusCurvePeak`/`vusOpenHint`·`ko.runDetail.profileVuStages` 정의·사용 | |
| R9 | `git diff --name-only master` = `ui/src/**`·docs만. `ui/src/api/schemas.ts` 무변경 확인 | |

- **라이브 검증**: **waived 후보.** UI-only·read-only 표시·run-생성/리포트-파싱/엔진 경로 **무변경**(R9). S-D 갭(서버 응답 `null`↔Zod)은 `ProfileSchema`를 안 건드리므로 무관. 표시 분기는 RTL fixture(closed+fixed/closed+curve/open±curve)로 결정적 커버. **단, RTL fixture가 `vu_stages`를 *absent*가 아니라 실값으로 주는지** plan에서 확인(곡선 run fixture는 `vu_stages` 실배열 필수). plan 리뷰에서 최종 판정.

---

## 7. 의도적 연기 (roadmap §B9에 누적)

- **open-loop의 RPS/슬롯 실값 표시**: "—" 대신 `target_rps`/`max_in_flight`를 VU 열에 노출하는 건 열의 의미(VU)를 흐린다 → 별도 열/툴팁 슬라이스.
- **곡선 run 목록 정렬·필터를 peak 기준으로**: 현재 정렬 키는 created_at만. peak-VU 정렬은 별도.
- **raw 프로필 섹션 `duration = 0s`/`ramp_up` rawness**: 같은 raw 섹션의 duration도 곡선 run에서 `0s`로 뜨지만 이 슬라이스는 VU 스코프 — duration은 `profileDurationSeconds`로 별도 정리 가능(카드는 이미 정상).
- **actual peak(`active_vu_series`) 병기**: "최대 50 (곡선)"은 *설계* 최고점. 실제 도달 peak는 리포트 ActiveVuChart가 담당 — 카드에 "설계 50 / 실제 48" 병기는 리포트 의존이라 별도.
- **곡선 run의 VU "단계 수" 카드화**: raw 섹션 1줄로 충분, 전용 카드는 과설계.

---

## 8. 구현 순서 (plan 입력)

> UI-only·계약 무변경이라 cargo 게이트 무관하지만 `pnpm lint && pnpm test && pnpm build` 게이트는 매 커밋. tdd-guard(ui/CLAUDE.md): src 편집 전 pending test 필요 → **테스트 파일 먼저** 편집해 RED diff 생성.

1. **ko 키 + 순수 헬퍼 + 단위 테스트** (단일 green 커밋): `loadModel.test.ts`에 `profileVuDisplay` 4모드 테스트 먼저(RED) → `ko.ts` 3키 → `loadModel.ts` `profileVuDisplay`/`VuDisplay`. (R1·R2·R3·R4·R5·R8 부분)
2. **`RunVuCell` 컴포넌트 + 테스트** (green 커밋): `RunVuCell.test.tsx`(3 kind·a11y) 먼저 → `RunVuCell.tsx`. (R1·R2·R6·R8)
3. **두 페이지 배선 + raw 줄 + 페이지 테스트** (green 커밋): 페이지 테스트(곡선 fixture "최대 N (곡선)"·open "—"·raw `vu_stages` 줄) 갱신/추가 먼저 → `RunDetailPage.tsx`(카드+raw 줄)·`ScenarioRunsPage.tsx`(열) 배선. (R1·R2·R3·R6·R7·R9)
4. 머지 전 전체 `pnpm lint && pnpm test && pnpm build` + `git diff --name-only`로 R9(ui/+docs only) 확인.
