# 스텝 막대(waterfall) 라벨 overflow 수정 (설계)

- 날짜: 2026-06-26
- 상태: 설계 (spec-plan-reviewer 대기)
- 출처: Windows 실기 검증 중 사용자 보고 — 리포트 "스텝" 섹션의 **막대(waterfall) 뷰**에서 스텝 라벨(예: HAR 임포트 시나리오의 `POST /kramycard/cache/ajax/setupList.json`)이 길어지면 오른쪽 막대 그래프 위로 삐져나와 겹친다.

## 배경 / 문제

`crates`/엔진 무관 — 순수 UI 레이아웃 버그(presentational). `ui/src/components/report/StepPhaseBreakdown.tsx`의 막대 뷰(`view==="waterfall"`) 각 행은 flex row다:

```
[라벨 div: w-40]  [막대 div: flex-1]  [ms div: w-16]
```

라벨 div(`StepPhaseBreakdown.tsx:66`)는 **고정 `w-40`(160px)인데 overflow 처리가 없다**(`truncate`/`break-words`/`min-w-0`/`overflow-hidden` 전무):

```jsx
<div className="w-40 text-sm font-medium">{m?.name ?? s.step_id}</div>
```

URL(`/kramycard/cache/ajax/setupList.json`)은 공백·하이픈이 없어 **줄바꿈 기회가 없는 한 덩어리 토큰**이라, 브라우저가 160px 안에서 못 끊고 가로로 넘쳐 오른쪽 `flex-1` 막대 영역 위로 시각적으로 겹친다(스크린샷: `POST`가 1줄, 긴 경로가 2줄째에서 막대 침범).

- **대조(같은 라벨, 안 겹침)**: "칩"(표) 뷰 `StepStatsTable.tsx`는 같은 `m.name`을 **table cell(`<td>`)** 로 렌더한다 — table 셀은 내용에 맞춰 자동 폭 조정(밀어내기)이라 *구조적으로* 겹치지 않는다(고정폭 flex item과 대조). URL 칸(`:93`)은 거기에 더해 `break-all`로 긴 URL을 셀 안에서 줄바꿈까지 한다. 막대 뷰만 라벨이 **고정폭 flex item**(`w-40`)이라 넘침 처리가 필요하다.
- `m?.name`은 step meta의 표시명(HAR 임포트는 흔히 `METHOD /path` 형태로 길다). 라벨 길이는 시나리오/임포트에 따라 가변이라 고정폭으로는 항상 넘칠 수 있다.

## 목표 / 비목표

- **목표**: 막대(waterfall) 뷰의 스텝 라벨이 아무리 길어도 막대 그래프와 **겹치지 않게** 한다. 라벨은 한 줄 **말줄임(ellipsis)** 처리하고, 잘린 전체 텍스트는 **마우스 호버 시 `title` 툴팁**으로 확인 가능하게 한다(사용자 선택안). 전체 URL이 항상 필요한 사용자는 "칩"(표) 뷰에서 본다(역할 분담).
- **비목표**: "칩"(표) 뷰 변경(이미 `break-all`로 안 겹침)·다른 리포트 표(워커 분해·분기 결정 등)·라벨 *내용*(meta.name 구성)·레이아웃 구조 변경(3-칼럼 flex 유지)·반응형 폭 조정.
- **불변식**: 막대/칩 토글·막대 비율·ms 표시·`role="img"` aria-label·`anyPhase` fallback·범례 등 **기능·구조·접근성 전부 무변경**. 라벨 div의 className(+`title` 속성)만 손댄다. 짧은 라벨은 시각적으로 동일(말줄임 미발동).

## 설계

`StepPhaseBreakdown.tsx`의 막대 뷰 라벨 div 한 곳(`:66`)만 수정:

```jsx
<div
  className="w-40 shrink-0 truncate text-sm font-medium"
  title={m?.name ?? s.step_id}
>
  {m?.name ?? s.step_id}
</div>
```

- `truncate`(= `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`): 라벨을 한 줄로 클립하고 넘치면 `…`. `w-40`이 확정 폭이라 `truncate`가 바로 동작(ui/CLAUDE.md "truncate는 조상에 확정 너비가 있어야 클립된다" 충족).
- `shrink-0`: flex가 라벨을 160px 미만으로 줄이지 못하게(막대가 라벨을 밀어붙이는 역방향 깨짐 방지). `w-40`이 폭을 고정하지만 flex `min-width:auto` 상호작용 대비 방어적(ui/CLAUDE.md flex min-width 트랩).
- `title`: 잘린 전체 텍스트를 호버 툴팁으로. 표시 텍스트와 동일 소스(`m?.name ?? s.step_id`)라 별도 카피 불필요(ko.ts 무관 — 사용자 데이터). 단일 정렬 값(들여쓰기·줄바꿈 없음).

`white-space: nowrap`으로 라벨이 한 줄이 되어 행 높이도 안정(현 다줄 wrap 대비 오히려 컴팩트). 막대(`flex-1`)는 라벨이 확정 160px를 점유하므로 그 뒤 영역만 차지 → 겹침 구조적으로 불가.

## 테스트 / 검증

- **RTL(`StepPhaseBreakdown.test.tsx`)**: 막대 뷰에서 긴 라벨 meta를 가진 스텝을 렌더해 라벨 요소가 ① `truncate` 클래스를 가지며 ② `title`이 전체 라벨과 일치함을 단언. (jsdom은 실제 픽셀 overflow를 계산 못 하므로 겹침 자체는 클래스/속성 계약으로 락인 — ui/CLAUDE.md jsdom layout 한계와 동형.) 짧은 라벨도 `title`이 붙는지(무해) + 기존 막대/ms/토글 단언 회귀 없음.
- **게이트**: `pnpm lint && pnpm test && pnpm build`(UI 최종 게이트). cargo/proto/migration 0-diff.
- **라이브 검증**: 자동 run-생성/report-파싱 회귀 측면은 **WAIVED**(production diff가 리포트 **표시-only**·run-생성/report-파싱/Zod 경로 무관·`schemas.ts` 0-diff → S-D 갭 부재). **단, 원 버그가 시각적 픽셀 겹침이고 contract 테스트(jsdom)는 픽셀을 못 보므로, 긴 URL 시나리오 리포트의 막대 뷰 Playwright 헤드리스 스크린샷 1장으로 실제 시각 수정을 확인할 것(권장)** — CSS 보장(고정폭 box + truncate)이 견고해 blocker는 아니나 cheap·결정적 시각 확인. 근거를 build-log에.

## 리스크

- 매우 낮음(CSS 3개 유틸리티 + `title` 속성, 로직·와이어·상태 0). 유일한 트레이드오프 = 막대 뷰에서 긴 라벨이 잘려 보임 — 의도된 선택(전체는 호버 `title` + 칩 표). 짧은 라벨은 영향 없음.
