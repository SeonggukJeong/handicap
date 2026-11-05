# A4 인쇄 보고서 슬라이스 1 — 측정결과 보고서 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 종료된 run의 리포트에서 `/runs/:id/print`로 가 측정결과 보고서(표준판 여러 쪽 / 요약판 1장)를 A4 세로로 미리 보고 브라우저 인쇄·PDF 저장한다.

**Architecture:** 모든 판단(오류 분류·열 접기·단계 상태·판정 상자·자동 문장·차트 묶음·쪽 배치·요약판 사다리)은 `ui/src/print/`의 **순수 함수**(jsdom 단위 테스트)로 두고, 컴포넌트는 그 결과를 그리기만 한다. 쪽 나누기는 숨은 측정 시트에 모든 블록 변형을 한 번 그려 높이를 잰 뒤(`document.fonts.ready` 후 1회) 순수 `paginate`·`chooseSummaryLevel`로 결정한다. 컨트롤러·엔진·와이어 0-diff.

**Tech Stack:** React 18 + TS + react-router v6 + React Query v5 + `yaml` 패키지(관대한 읽기) + 인라인 SVG + plain CSS(mm 단위, `.p-root` 스코프). vitest + RTL.

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-05-a4-print-report-design.md` (시안: `docs/superpowers/specs/assets/2026-11-05-a4-print-report/measure-report-v3.html` 1쪽 확정본, `measure-report-v1.html` 2쪽 참고 — v1 §5 속도 분포는 이 슬라이스에 없음)

## 사용자 스토리 (US) — spec에서 verbatim 추출, 매 brief 첨부

- **US1**: QA가 종료된 run의 결과를 팀·발주처에 넘길 때 리포트 화면에서 측정결과 보고서를 A4로 출력해 — 성공하면 설명을 덧붙이지 않아도 되는 A4 세로 문서(종이/PDF)를 얻고, 1쪽만 읽어도 종합 판정·기준 대비 지표·문제 단계가 보인다. 쪽 경계·꼬리말을 넘거나 잘리는 내용이 없고, 흑백으로 출력해도 ●▲✕와 글자로 정상/주의/문제가 구분된다. 단계가 30개를 넘거나 이름이 길어도 표가 잘리거나 겹치지 않고 다음 쪽으로 이어지며(머리줄 반복), 요약판은 문제 큰 상위 최대 8개 + 나머지 한 줄로 1장을 지킨다.
- **US2**: 운영자가 여러 단계에서 서로 다른 오류가 섞인 run의 보고서를 볼 때 — 어느 단계에서 어떤 응답 코드가 몇 건, 언제부터 났는지(예: "⑤ 신청 제출 — 503 2,880건, 4분부터")를 단계별 표와 시간 차트에서 바로 찾는다. 응답 코드 열은 그 측정에서 실제로 나온 코드만이고, 도구가 오류로 세지 않은 응답·세었는지 확정할 수 없는 응답은 오류로 센 응답과 구분돼 보인다.
- **US4(측정 절반)**: QA가 행정 부서에 돌릴 요약만 필요할 때 요약판을 골라 — 측정 보고서 1쪽 내용(종합·지표·단계 표)만 담긴 A4 1장을 얻는다.

## Global Constraints

- **UI만**: `crates/`·`desktop/`·`deploy/` 0-diff. 새 API·필드·의존성 없음(`yaml`·react-router·React Query는 기존 의존성).
- **모든 사용자 노출 문구(aria-label 포함) = `ko.ts`의 `ko.print.*`** (ADR-0035). 변수 뒤 조사는 병기형(`(이)가`·`(은)는`·`(으)로`). 문구는 spec 본문 verbatim + 아래 "카피 정본" 표.
- **테스트 단언은 리터럴 한국어 문자열**로 쓴다 — `getByText(ko.print.x(n))` 같은 자기참조 단언 금지(ui/CLAUDE.md 공허 테스트 11호).
- **보안(외부 문서)**: env 값·데이터셋 값·헤더·본문을 DOM 어디에도 출력하지 않는다. 대상 시스템 = 호스트(+포트)만, 단계 요청 줄 = 풀지 않은 원형 경로·쿼리는 `?…`. 시나리오/단계 이름·라벨은 그대로(React 이스케이프).
- **오프라인 CSP**: 외부 폰트/스크립트 금지. 글꼴 스택 `"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif`. 차트 = 인라인 SVG(Recharts 금지).
- **A4 기하**: 쪽 210×297mm, 여백 상 14 · 좌우 15 · 하 12mm, 꼬리말 8mm, 안전 여유 4mm → **본문 높이 `PAGE_BODY_MM = 259`**, **본문 폭 180mm**. `@page { size: A4; margin: 0 }`은 인쇄 화면 컴포넌트가 렌더하는 `<style>`로만(전역 CSS 파일에 두면 앱 다른 화면 인쇄까지 바뀜 — CSP `style-src 'unsafe-inline'` 허용 확인: `ui/index.html:8`). 나머지 CSS는 `ui/src/print/print.css`에서 `.p-root` 하위로만. **`.p-root`는 `RunPrintPage`의 최상위 요소**(도구 줄·상태 화면·문서 모두 그 안) — 그래야 `.p-root .p-noprint` 인쇄 숨김이 도구 줄에 닿는다. `PrintDocument`의 루트는 `.p-doc`.
- **표시 단위(§5.3)**: 시간 `fmtMs`(아래 Task 1), 건수 천 단위 쉼표, 비율 소수 1자리 %·0이 아닌데 0.1% 미만 → `"0.1% 미만"`·0 → `"0.0%"`. 기존 `floorPct`(<0.05%만 floor)는 쓰지 않는다(경계가 다름).
- **타임스탬프 단위**: `run.started_at`/`ended_at`/`created_at` = **unix ms**(근거: `ui/src/pages/ScenarioRunsPage.tsx:456` `(now - started_at)/1000`), `report.windows[].ts_second` = **unix 초**. 경과 시간의 기준 `t0 = min(floor(started_at/1000), min(ts_second))`(둘 중 있는 것), 경과는 `max(0, ts - t0)`.
- **흑백 생존**: 상태 = 기호+글자, 최대 오류 칸 = 굵은 글자 + 1.5px 실선 테두리, "안 셈" = 점선 테두리 + 글자 `안 셈`, "확인 불가" = 점선 + `?`. 인쇄 CSS `print-color-adjust: exact; -webkit-print-color-adjust: exact`. 빗금 = `#c77700` 계열 2px.
- **커밋**: task마다 독립 green 커밋(pre-commit UI 게이트 `pnpm lint && pnpm test && pnpm build`가 돈다 — 단일 FOREGROUND 호출, timeout 600000). `| tail` 금지, `--no-verify` 금지. 커밋 메시지는 `-m "<제목>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.
- **tdd-guard**: 각 task 첫 편집은 **테스트 파일**(`ui/src/print/__tests__/…`) — production 먼저 쓰면 훅이 막는다. 테스트는 반드시 `__tests__/` 안(vitest include).
- **ES2022 lib**: `findLast`·`toSorted` 등 ES2023 메서드 금지(`tsc -b`만 잡음). `.find()`로 union 좁힐 땐 타입가드 술어.

## Review Focus

1. **현재 Zod 모델이 거부하는 run 스냅샷 YAML**(ULID 아닌 id·범위 밖 status·`version: 2` 등) — 분류는 관대한 읽기로 살아남아야 하고, 손 모델 객체가 아니라 **엔진 직렬화 형태 YAML 문자열**로 테스트한다(Task 1 `lenient_reads_engine_serialized_yaml`·`survives_zod_rejection`, Task 2 `classify_uses_saved_status_shape`).
2. **요청 0건 / 시작 전 중단 run**(`started_at=null`, `windows=[]`, `steps=[]`, `count=0`, YAML 깨짐) — 판정 상자 "판정 안 함", 차트 "오류 없음", 빈 표가 사라지지 않음, SVG 속성까지 NaN/Infinity 없음(Task 5 `zero_request_run_*`, Task 6 `empty_table`, Task 8 `renders_zero_request_aborted_run`).
3. **공백 없는 긴 단계 이름·긴 URL**(HAR 임포트 한 덩어리) — 이름은 3줄 clamp + `break-all`, 요청 줄은 이름 열 폭 기반 가운데 말줄임, 숫자 열은 안 줄어듦(Task 1 `middle_ellipsis_*`, Task 8 클래스 단언 + 라이브 `.p-req` `scrollWidth<=clientWidth` 실측).
4. **YAML엔 있는데 실행 안 된 단계 / 리포트엔 있는데 YAML에 없는 단계**(분기 미진입·시나리오 수정) — 전자 "– 실행 안 됨" 행, 후자 맨 뒤 id 표시 + 4xx/5xx "확인 불가"(Task 2 `rows_order_*`).
5. **env 값이 URL 호스트·userinfo·쿼리에 들어간 시나리오, 미해결 `${HOST}` 호스트** — 렌더된 DOM 전체 텍스트에 env 값 0회, 미해결 토큰은 원형 대소문자 그대로(Task 1 `target_*`, Task 8 `never_prints_env_values`).

## 카피 정본 (spec이 문구를 정하지 않은 곳 — 이 표가 단일 소스, byte-exact)

> orchestrator: 이 절을 `.superpowers/sdd/a4-copy.md`로 1회 추출해 매 brief에 첨부한다. spec이 문구를 정한 곳(§5.1 판정 상자 부제·§6.4 경고·§7 문장·§8 나머지 줄·§9 축소 줄)은 spec verbatim.

| 키(의미) | 문구 |
|---|---|
| 지표 설명 처리량 | `1초에 처리한 요청 수. 클수록 많이 감당합니다.` (단위 `건/초`) |
| 지표 설명 평균 | `요청을 보내고 답을 받기까지 걸린 시간의 평균.` |
| 지표 설명 95% | `100번 중 95번은 이 시간 안에 답을 받았습니다.` |
| 지표 설명 오류율 | `전체 요청 중 실패한 비율. 실패 {N}건 / 전체 {M}건` |
| 목표 줄 | `목표 {t} 이하 ● 달성` · `목표 {t} 이하 ✕ 미달` · 하한은 `이상` · `목표 {t} 이하 (판정 안 함)` · `목표 {t} 이하 (평가 불가)` · `목표 없음 (참고값)` |
| 판정 상자 큰 글자 | `✕ 부적합` · `● 적합` · `판정 안 함` · `평가 불가` · `기준 미설정` (작은 제목 `종합 판정`) |
| 판정 상자 부제(중단/실패 분리) | `측정이 중단되어 판정하지 않았습니다` / `측정이 실패해 판정하지 않았습니다` (나머지는 spec §5.1 verbatim) |
| 기준 쉬운 이름 (`이름`·주격 조사) | `p50_ms`→`50% 응답시간`·이 / `p95_ms`→`95% 응답시간`·이 / `p99_ms`→`99% 응답시간`·이 / `error_rate`→`오류율`·이 / `rps`→`처리량`·이 / `4xx_rate`→`4xx 응답 비율`·이 / `5xx_rate`→`5xx 응답 비율`·이 / `4xx_count`→`4xx 응답 수`·가 / `5xx_count`→`5xx 응답 수`·가 / `min_window_rps`→`가장 낮은 1초 처리량`·이 / 미지 metric → metric 문자열 그대로·`(이)가` |
| 기준 값 표기 | ms 계열 `fmtMs` · rate 계열 `fmtPct` · `rps`/`min_window_rps` `fmtRps` = `{n}건/초`(소수 1자리, 끝 `.0`은 뗌, 천 단위 쉼표 — `200건/초`·`12.5건/초`) · count 계열 `{n}건` |
| 그 밖의 기준 표 | 제목 `그 밖의 기준` · 열 `기준`·`목표`·`측정값`·`판정` · 판정 `● 달성`·`✕ 미달`·`판정 안 함`·`평가 불가` · 단계 기준 이름 `{단계} · {기준 이름}` |
| 그 밖의 기준 생략 줄 | 남은 행이 모두 달성 `외 {N}개 기준 모두 달성` / 아니면 `외 {N}개 기준(달성 {a} · 미달 {b} · 평가 불가 {c} · 판정 안 함 {d}, 0 생략) — 부록 참조` / 요약판 미달 3행 초과 `외 미달 {N}개 — 표준판 참조` |
| 절 제목 | `1. 종합 결과` · `요약 (자동 작성)` · `2. 어디가 문제인가 — 단계별 결과` · `3. 시간에 따른 변화` · `4. 측정 조건과 해석 범위` · `5. 용어 풀이` · `부록. 그 밖의 기준 전체` · 이어짐 접미 ` (이어짐)` |
| 머리 | 작은 글씨 `성능 측정 결과 보고서` · 제목 `{이름} 부하 측정`(이름 없음 → `시나리오`) · `문서번호: ____________` · `작성일 {YYYY-MM-DD}` · 메타 라벨 `대상 시스템`·`측정 일시`·`부하 조건`·`측정 식별` |
| 꼬리말 | `{제목} · #{끝6자}` · `Handicap 부하 테스트 도구로 생성` · `{n} / {N}` |
| 단계 표 열 | `단계` · `요청 수` · `95% 응답` · 묶음 머리 `응답 코드별 건수 (이번 측정에서 나온 코드만)` · `상태` · `2xx`/소제목 `성공 계열` · `3xx`/`이동 계열` · `응답 없음`/`코드 없음` · 잔차 `그중: 응답 받은 뒤 실패`/`(어느 코드였는지는 기록되지 않음)` · 접힌 열 `기타 4xx`·`기타 5xx`·`기타 코드` |
| 칸 표기 | 0건 `–` · 안 셈 `{n}` + 줄 `안 셈` · 확인 불가 `{n}` + 줄 `?` · 잔차 접미 `(일부는 ? 칸과 같은 응답)` |
| 상태 | `✕ 오류` · `▲ 느림` · `▲ 오류 있음` · `▲ 안 센 응답` · `▲ 확인 불가` · `● 정상` · `– 실행 안 됨` · 작은 줄 `오류 {pct}` |
| 문제 단계 괄호 | 오류 → `오류`, 느림 → `느림`, 오류 있음 → `오류 있음`, 안 센 응답 → `안 센 응답`, 확인 불가 → `확인 불가` |
| 범례(전체) | `✕ 오류: 단계 오류율이 기준을 넘음` · `▲ 주의: 느림·오류 있음·검사 확인 필요` · `● 정상` · 견본 `오류로 센 응답` · `그중 가장 많은 것` · `오류로 안 센 응답(검사 없음)` · `확인 불가(?)` · `‘그중’ 열은 앞 칸들에 이미 포함된 건수입니다(더하지 마세요)` (나타난 분류만) |
| 범례(축소, 사다리 2) | `✕ 오류 · ▲ 주의 · ● 정상` |
| 열 묶음 각주 | `※ {열 이름}: {코드} {n}건 · {코드} {n}건 …` (열마다 한 줄) · 파싱 실패 각주는 spec §6.1 verbatim |
| 차트 | 범례 `처리량(건/초)` · `오류/초 — {가장 오류가 많은 단계 번호} {이름}` · `오류/초 — 그 밖의 단계` · `오류 없음` · 표시선 `{경과}: {단계 번호} 오류 시작` · 축 `0`·`30초`·`1분`·`2분 30초`(경과 표기) · aria `시간에 따른 처리량과 오류 차트` |
| 측정 조건 상자 | 제목 `측정 조건` · 라벨 `부하 모델`·`크기`·`기간`·`시작 늘림`·`단계 사이 쉼`·`요청 제한 시간`·`워커 수`·`데이터`·`환경 변수` · 값 `동시 사용자 고정`/`동시 사용자 곡선`/`초당 목표 고정`/`초당 목표 곡선` · `{n}명` / `최대 {n}명 · {k}단계` / `초당 {n}회` / `최대 초당 {n}회 · {k}단계` · `{기간}에 걸쳐 늘림` · `{min}–{max} 무작위` · `워커 {n}대` · `데이터 {n}개 연결` · `환경 변수 {n}개 사용` · 실패 `설정 정보를 읽을 수 없음` |
| 부하 조건 한 줄 | `동시 사용자 {n}명 · {기간}` / `동시 사용자 곡선 최대 {n}명 · {기간}` / `초당 {n}회 목표 · {기간}` / `초당 목표 곡선 최대 {n}회 · {기간}` (기간 = 기존 `formatDurationKo`) |
| 해석 상자 | 제목 `이 결과로 말할 수 있는 것·없는 것` · 소제목 `말할 수 있는 것` / `말할 수 없는 것` (항목 = 기존 `ko.narrative.can/cannot`, 미지 코드 = 코드 그대로) |
| 용어 풀이 | `처리량: 1초에 처리한 요청 수` · `평균 응답시간: 응답까지 걸린 시간의 평균` · `95% 응답시간: 전체 요청의 95%가 이 시간 안에 응답한 기준선` · `오류율: 도구가 오류로 센 요청의 비율` · `2xx(성공 계열)·3xx(이동 계열): 서버가 처리했다는 응답. 검사가 다른 코드를 기대하면 오류일 수 있음` · `{코드}: {풀이}`(사전 없는 코드 → `표준 HTTP 응답 코드`) · `응답 없음: 연결 거부·시간 초과·DNS 실패 등으로 응답을 받지 못함` · `응답 받은 뒤 실패: 응답은 받았지만 값 꺼내기나 본문 읽기에 실패함` · `검사 없음(안 셈): 응답 코드 검사가 없어 오류로 세지 않은 응답` · `확인 불가(?): 오류로 세었는지 기록상 확정할 수 없는 응답` · 내역 줄 `응답 없음 내역: {종류} {n} · …`(종류 이름 = 기존 `ko.report.errorKinds.labels`) |
| 서명 | `시험자` · `검토자` · `확인자` (이름·서명 빈칸) |
| 도구 줄 | `표준판` · `요약판` · `인쇄 / PDF 저장` · `돌아가기` · `인쇄가 안 되면 브라우저에서 이 주소를 여세요` · `주소 복사` · 복사됨 `복사했습니다` · 사다리 안내 `1장에 맞추려고 일부를 줄였습니다(표준판에 전체)` · 그룹 aria `보고서 종류` |
| 상태 화면 | 로딩 `보고서를 준비하는 중…` · 미종료 `측정이 끝난 뒤 출력할 수 있습니다` · 오류 `보고서를 불러오지 못했습니다: {사유}` |
| 리포트 진입 | 버튼 `보고서 인쇄` |

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `ui/src/print/format.ts` | §5.3 단위·단계 번호·날짜 | 1 |
| `ui/src/print/scenarioFacts.ts` | §6.1 관대한 YAML 읽기(단계 순서·S·E·이름) | 1 |
| `ui/src/print/redact.ts` | §5 대상 시스템, §6.5 원형 경로·가운데 말줄임 | 1 |
| `ui/src/print/stepTable.ts` | §6.1 칸 분류·잔차, §6.2 열 구성·7개 접기, §6.5 행 순서 | 2 |
| `ui/src/print/stepStatus.ts` | §6.3 상태, §8 상위 선택·나머지 줄, §6.4 경고 문장, 용어 목록 | 3 |
| `ui/src/print/verdict.ts` | §5.1 기준 펼치기·판정 상자·지표 4칸·그 밖의 기준 | 4 |
| `ui/src/print/conditions.ts` | §5 메타(측정 일시·부하 조건), §5.4 측정 조건 상자 | 4 |
| `ui/src/print/chartModel.ts` | §6.6 묶음·눈금·표시선 | 5 |
| `ui/src/print/sentences.ts` | §7.1 요약 문장, §7.2 읽는 법 | 5 |
| `ui/src/print/paginate.ts` | §9 배치·요약판 사다리 선택 | 6 |
| `ui/src/print/buildPrintDoc.ts` | 위 순수 함수 조립 → `PrintDoc` 뷰 모델, 블록 목록(`standardBlocks`/`summaryBlocks`) | 7 |
| `ui/src/print/components/*.tsx` | 블록 렌더(머리·종합·지표·기준표·단계표·차트·조건·용어·서명·꼬리말·쪽) | 8 |
| `ui/src/print/PrintDocument.tsx` | 측정 시트 → 높이 → 배치 → 쪽 렌더, `data-layout-ready` | 8 |
| `ui/src/print/print.css` | `.p-root` 스코프 화면·인쇄 CSS | 8 |
| `ui/src/pages/RunPrintPage.tsx` | 경로·데이터·상태 화면·도구 줄·`@page` `<style>` | 9 |
| `ui/src/routes.tsx` | `/runs/:id/print` 최상위(Layout 밖) | 9 |
| `ui/src/components/report/ReportView.tsx` | [보고서 인쇄] 링크 1개 | 9 |
| `ui/src/i18n/ko.ts` | `print: { … }` 네임스페이스(각 task가 자기 하위 객체 추가) | 1–9 |

`ko.print`는 Task 1이 `} as const;`(현재 `ui/src/i18n/ko.ts:2037`) 바로 앞에 `print: { … },`로 만들고, 이후 task는 그 안에 하위 객체(`fmt`·`table`·`status`·`verdict`·`kpi`·`criteria`·`conditions`·`sentence`·`chart`·`doc`·`page`)를 추가한다.

---

### Task 1: 단위 포맷 · 관대한 시나리오 읽기 · 보안 필터

**Files:**
- Create: `ui/src/print/format.ts`, `ui/src/print/scenarioFacts.ts`, `ui/src/print/redact.ts`
- Modify: `ui/src/i18n/ko.ts` (`print: { fmt: {...} }` 신설)
- Test: `ui/src/print/__tests__/format.test.ts`, `ui/src/print/__tests__/scenarioFacts.test.ts`, `ui/src/print/__tests__/redact.test.ts`

**Interfaces:**
- Consumes: `envValueToRecord(env: unknown): Record<string,string>` (`ui/src/api/runPrefill.ts:12`), `resolveForDisplay(template, env)` (`ui/src/scenario/template.ts:11`), `parse` from `"yaml"`.
- Produces:
  - `fmtMs(ms: number): string` · `fmtCount(n: number): string` · `fmtPct(fraction: number): string` · `fmtRps(n: number): string`(소수 1자리·`.0`은 떼어 시안 `200건/초` 표기 유지, `"1,234.6건/초"`) · `stepNo(index0: number): string` · `fmtDate(ms: number): string`(`YYYY-MM-DD`, 로컬) · `fmtDateTime(ms: number): string`(`YYYY-MM-DD HH:mm`, 로컬) · `fmtTime(ms: number): string`(`HH:mm`)
  - `type StepFacts = { id: string; name: string; method: string; url: string; statusCodes: number[]; fallibleExtract: boolean }`
  - `type ScenarioFacts = { ok: true; name: string | null; steps: StepFacts[] } | { ok: false }`
  - `readScenarioFacts(yamlText: string): ScenarioFacts`
  - `hostOf(urlTemplate: string, env: Record<string,string>): string` (`""` = 건너뜀) · `targetSystems(steps: StepFacts[], env: Record<string,string>): string` · `displayPath(urlTemplate: string): string` · `middleEllipsis(s: string, max: number): string` · `requestLine(method: string, urlTemplate: string): string`(줄이지 않은 `METHOD 원형경로` — 말줄임은 렌더 시 열 폭 기반, Task 8) · `requestLineBudget(nameColMm: number): number`(= `Math.max(24, Math.floor(nameColMm / 1.3))` — 6.8pt 영문 평균 글자 폭 ≈1.3mm)

- [ ] **Step 1: 실패하는 테스트 3파일 작성**

`format.test.ts` — `fmtMs` 표(입력 ms → 출력): `0→"1ms 미만"`, `7→"7ms"`, `9→"9ms"`, `10→"0.01초"`, `845→"0.85초"`, `994→"0.99초"`, `999→"1.0초"`(2자리 반올림이 1.00이면 1초 이상 분기로 승격), `1000→"1.0초"`, `2400→"2.4초"`, `59950→"60.0초"`. `fmtPct`: `0→"0.0%"`, `0.0004→"0.1% 미만"`, `0.001→"0.1%"`, `0.026→"2.6%"`. `fmtCount(2880)→"2,880"`, `fmtRps(1234.56)→"1,234.6건/초"`, `fmtRps(200)→"200건/초"`, `fmtRps(0)→"0건/초"`. `stepNo`: `0→"①"`, `19→"⑳"`, `20→"21."`. `fmtDateTime(new Date(2026,10,4,14,3).getTime())→"2026-11-04 14:03"`(로컬 생성자라 TZ 무관).

`scenarioFacts.test.ts` — 입력은 **엔진 직렬화 형태 YAML 문자열**(손 모델 객체 금지):
- `lenient_reads_engine_serialized_yaml`: http 3개(첫째 `assert: [{status: 200}]` + `extract: [{from: body, var: t, path: $.t}]`, 둘째 `assert: [{status: 200}, {status: 201}]`, 셋째 `extract: [{from: status, var: s}]`) → `statusCodes` `[200]`/`[200,201]`/`[]`, `fallibleExtract` `true`/`false`/`false`, `name`은 루트 `name`.
- `order_matches_flatten`: loop(`do`)·if(`then`/`elif[].then`/`else`)·parallel(`branches[].steps`, top-level·분기 안은 http만) 중첩 YAML(**모든 id는 Crockford ULID 26자** — `model.ts:5` `ULID_RE`) → 먼저 `expect("model" in parseScenarioDoc(y)).toBe(true)`로 Zod 통과를 단언한 뒤, id 순서 == `flattenHttpSteps(model.steps)` id 순서.
- `survives_zod_rejection`: Zod가 **실제로** 거부하는 YAML — http 스텝 `id: s1`(ULID 아님, `model.ts:115`)과 `assert: [{status: 700}]`(`model.ts:42` max 599) — 먼저 `expect("error" in parseScenarioDoc(y)).toBe(true)`(전제 단언) → `readScenarioFacts`는 `ok:true`, 해당 스텝 `statusCodes: [700]`, id `"s1"`. (모르는 키는 `normalizeForModel`이 조용히 버려 Zod가 거부하지 않으므로 전제로 쓰지 말 것.)
- `accepts_model_shape_and_ignores_garbage`: `assert: [{kind: status, code: "404"}, {status: abc}, {status: 2.5}, {status: null}, {status: ""}, {status: true}]` → `[404]`(`null`/`""`/`true`가 `Number()`로 0·1이 되는 함정 차단).
- `broken_yaml_is_not_ok`: `"steps: [\n"` → `{ ok: false }`; 빈 문자열/스칼라 루트 → `{ ok: true, name: null, steps: [] }`.

`redact.test.ts` (Review Focus 5):
- `target_resolved_host_only`: url `https://u:p@h.example:8443/x?token=${TOKEN}`, env `{TOKEN:"SECRET"}` → `hostOf` = `"h.example:8443"`.
- `target_unresolved_falls_back_to_template`: `${BASE_URL}/x?token=${TOKEN}`(env 없음) → `"${BASE_URL}"`; `http://{{h}}:8080/a` → `"{{h}}:8080"`; `http://${USER}:${PASS}@{{h}}/a` → `"{{h}}"`; `http://${HOST}/a` → `"${HOST}"`(대소문자 보존 — WHATWG `URL`은 이 셋을 **통과시키며** 호스트를 소문자화하므로 `new URL` 성공에 기대면 `${host}`가 찍힌다); `/login` → `""`.
- `target_flow_vars_in_path_still_resolve`: env `{BASE_URL:"https://api.local"}`, url `${BASE_URL}/users/{{id}}?t={{tok}}` → `"api.local"`(경로·쿼리의 흐름 변수 때문에 폴백하지 않음).
- `target_env_secret_never_returned`: env `{BASE_URL:"https://admin:pw@api.local/v1?k=S3CR3T"}`, url `${BASE_URL}/x` → `"api.local"`, 결과에 `admin`·`pw`·`S3CR3T` 미포함.
- `target_systems_dedupe_cap`: 호스트 a,a,b,c,d → `"a, b 외 2곳"`; 전부 빈 결과 → `"–"`.
- `display_path_raw`: `${BASE_URL}/users/{{id}}?q=${TOKEN}#f` → `"/users/{{id}}?…"`; `https://h/x` → `"/x"`; `https://h` → `"/"`; `/a/b` → `"/a/b"`.
- `middle_ellipsis_*`: 길이 ≤ max → 그대로; `"a".repeat(30)+"b".repeat(30)`, max 20 → 앞 `Math.floor((max-1)*0.6)`자 + `…` + 끝 나머지(총 길이 == max). `requestLine("GET", "/a?x")` = `"GET /a?…"`(줄이지 않음); `requestLineBudget(46)` = 35, `requestLineBudget(10)` = 24.

- [ ] **Step 2: RED 확인** — Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/a4-print-report/ui && pnpm test print/__tests__/` → FAIL(모듈 없음).

- [ ] **Step 3: 구현**
  - `fmtMs`: `ms <= 0 → "1ms 미만"`(음수 방어 포함), `ms < 10 → \`${Math.round(ms)}ms\``, `ms < 1000`이면 `v = Math.round(ms/10)/100`; `v >= 1`이면 1초 이상 분기로, 아니면 `v.toFixed(2)+"초"`; 1초 이상 = `(Math.round(ms/100)/10).toFixed(1)+"초"` (`Math.round` 기반 — `toFixed` 반올림 오차 회피).
  - `fmtPct`: `f === 0 → "0.0%"`, `0 < f*100 < 0.1 → "0.1% 미만"`, else `(f*100).toFixed(1)+"%"`. 천 단위는 `toLocaleString("en-US")`.
  - `stepNo`: `i < 20 → String.fromCharCode(0x2460 + i)`, else `\`${i+1}.\``.
  - `readScenarioFacts`: `parse` try/catch(throw → `{ok:false}`). 루트가 객체가 아니면 `{ok:true,name:null,steps:[]}`. 재귀 `walk(arr)`: 항목이 객체가 아니면 skip; `type==="loop"`→`do`, `"if"`→`then`, 각 `elif[].then`, `else`; `"parallel"`→각 `branches[].steps`; 그 외 `request`가 객체면 http 스텝. `id`/`name`은 `String()`(없으면 `""`), `method`/`url`은 `request.method`/`request.url`의 문자열(아니면 `""`). assert: 항목에 `status` 키 → 그 값, `kind==="status"` → `code`; 값이 **number이거나 공백 아닌 string**일 때만 `Number(v)` 후 `Number.isInteger`면 채택(`null`·`""`·boolean 배제). `fallibleExtract` = `extract` 배열에 `from ∈ {"body","header","cookie"}` 항목 존재.
  - `hostOf`: `resolved = resolveForDisplay(t, env)` → `try { host = new URL(resolved).host }` — **URL 객체에서 `host` 외 속성은 읽지 않는다**. 파싱이 성공해도 `host`에 `{` 또는 `$`가 있으면(= 호스트 자리의 미해결 토큰 — WHATWG가 `{{h}}`·`${HOST}`를 받아들이고 소문자화하므로 "파싱 실패"에 기대면 안 된다) 원형 폴백. **경로·쿼리의 `{{var}}`는 폴백 사유가 아니다**(`resolveForDisplay`는 흐름 변수를 안 풀므로 문자열 전체를 보면 가장 흔한 URL 형태가 전부 폴백된다). 폴백(파싱 실패 포함): 원형 템플릿 `t`에서 `/^[a-z][a-z0-9+.-]*:\/\//i` 매치면 그 뒤부터, 첫 `/`·`?`·`#` 앞까지 자르고 마지막 `@`까지 삭제.
  - `targetSystems`: `steps.map(s => hostOf(s.url, env))` → 빈 값 제거 → 등장 순 dedupe → `≤2`면 `", "` join, 초과면 앞 2개 + `" 외 {N}곳"`, 0개면 `"–"`(문구는 `ko.print.fmt`).
  - `displayPath`: 원형에서 `#` 이후 제거 → scheme 있으면 scheme 제거 후 첫 `/`부터(없으면 `"/"`), scheme 없고 `/`로 시작 안 하면 첫 `/`부터(없으면 `"/"`) → 첫 `?` 이후를 `?…`로.
  - `middleEllipsis(s, max)`: `head = Math.floor((max-1)*0.6)`, `tail = max-1-head`, `s.slice(0,head)+"…"+s.slice(s.length-tail)`. `requestLine` = `\`${method} ${displayPath(url)}\``(말줄임 없음).

- [ ] **Step 4: GREEN** — `pnpm test print/__tests__/` PASS. **이빨 실증**: `readScenarioFacts`의 `status` 키 분기를 잠시 지워 `lenient_reads_engine_serialized_yaml` RED 확인 → 원복 → GREEN.

- [ ] **Step 5: Commit** — `git add ui/src/print ui/src/i18n/ko.ts` → `git commit -m "feat(print): 단위 포맷·관대한 시나리오 읽기·보안 필터" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"` (FOREGROUND). `git log -1`로 착지 확인.

---

### Task 2: 단계 × 응답 코드 표 모델 (분류·잔차·열 접기·행 순서)

**Files:**
- Create: `ui/src/print/stepTable.ts`
- Modify: `ui/src/i18n/ko.ts` (`print.table`: 열 이름·소제목·코드 풀이 사전 §6.2 16종)
- Test: `ui/src/print/__tests__/stepTable.test.ts`

**Interfaces:**
- Consumes: Task 1 `ScenarioFacts`, `StepFacts`, `stepNo`, `requestLine`; `Report["steps"]` (`ui/src/api/schemas.ts` `ReportStepSchema`).
- Produces:
  - `type CellClass = "counted" | "unknown" | "uncounted" | "expected" | "plain"` (강도 순 = 이 나열 순)
  - `codeFamily(code: number): "2xx" | "3xx" | "4xx" | "5xx" | "other" | "none"` (`none` = 0, `other` = 1–99·100–199·≥600)
  - `classifyCell(code: number, facts: Pick<StepFacts,"statusCodes"|"fallibleExtract"> | null): CellClass`
  - `type Column = { key: string; kind: "class2xx" | "class3xx" | "code" | "folded" | "none" | "residual"; label: string; sub: string | null; codes: number[] }`
  - `buildColumns(codeTotals: Map<number, number>, hasResidual: boolean): Column[]`
  - `type Cell = { count: number; cls: CellClass; strongest: boolean }`
  - `type StepRow = { index: number; no: string; stepId: string; name: string; requestLine: string | null; executed: boolean; count: number; errorCount: number; p95Ms: number; perCode: Array<{ code: number; count: number; cls: CellClass }>; cells: Record<string, Cell>; residual: number; residualUncertain: boolean; factsKnown: boolean }`
  - `type FoldNote = { columnLabel: string; parts: Array<{ code: number; count: number }> }`
  - `type StepTableModel = { columns: Column[]; rows: StepRow[]; foldNotes: FoldNote[]; scenarioUnreadable: boolean }`
  - `buildStepTable(steps: Report["steps"], facts: ScenarioFacts): StepTableModel`

- [ ] **Step 1: 실패하는 테스트 작성** (`stepTable.test.ts`)
  - `classify_table_rows` — spec §6.1 표 전 행을 `it.each`로: `(0, S=[200]) → counted` · `(0, null) → counted` · `(503, S=[200]) → counted` · `(200, S=[200,201]) → counted`(복수 검사 불일치) · `(201, S=[201]) → expected` · `(404, S=[404]) → expected`(기대 비2xx) · `(503, S=[], E=false) → uncounted` · `(503, S=[], E=true) → unknown` · `(200, S=[]) → plain` · `(302, S=[]) → plain` · `(99, S=[],E=false) → uncounted` · `(101, S=[],E=true) → unknown` · `(600, S=[200]) → counted` · `(503, null) → unknown` · `(200, null) → plain`.
  - `classify_uses_saved_status_shape` — `readScenarioFacts`에 엔진 YAML(`assert: [{status: 200}]`)을 넣어 얻은 facts로 `buildStepTable` → 503 칸 `counted`(형태 오인 시 `uncounted`로 찍히는 회귀 방지). **이빨 실증 대상.**
  - `residual_is_subset_and_floored` — 단계 `count 100, error_count 30, status_counts {200:80, 503:20}`, S=[200] → 503 counted 20, residual 10; `error_count 5`인데 counted 합 20 → residual 0. `residualUncertain`은 그 행에 `unknown` 칸이 있고 residual>0일 때만 true.
  - `fold_spec_example` — spec §6.2 예 그대로: 2xx 총합>0, 코드 0>0, residual 있음(고정 3) + K = `503:2880, 404:120, 500:60, 504:40, 400:10, 401:5, 403:3, 502:2` → 열 label 순서 `["2xx","404","기타 4xx","503","기타 5xx","응답 없음","그중: 응답 받은 뒤 실패"]`, `기타 4xx.codes = [400,401,403]`, `기타 5xx.codes = [500,502,504]`, 열 7개.
  - `fold_single_code_family_keeps_name` — F에 4xx가 1개뿐이면 그 코드 이름 그대로 한 열(`"기타 4xx"` 금지).
  - `no_fold_when_within_budget` — 고정 1 + K 5개 → 접지 않음, 정렬 `2xx, 3xx, 4xx↑, 기타4xx, 5xx↑, 기타5xx, other↑, 기타 코드, 응답 없음, 잔차`.
  - `folded_cell_takes_strongest` — 접힌 칸 구성이 `uncounted`+`counted`이면 `counted`; 2xx 열에 200(counted, S=[201])+201(expected)이면 `counted`.
  - `strongest_marks_max_counted_column` — 한 행에서 counted 칸 중 count 최대 열만 `strongest:true`(동률은 열 순서 앞).
  - `fold_notes` — 접힌 열마다, 그리고 코드가 2개 이상 섞인 2xx/3xx 열마다 FoldNote 1개(코드 오름차순·run 전체 건수). *(spec 무언 결정: 2xx/3xx 묶음 칸도 접힌 칸처럼 "가장 강한 분류"를 따르므로 200(오류로 셈)+201(기대)이면 칸 전체가 빨강 — 각주가 코드별 건수를 밝혀 보완한다.)*
  - `rows_order_and_missing` (Review Focus 4) — facts 순서 A,B,C; report.steps에 A,C,Z → 행 `A(executed) B(executed:false, count 0) C Z(맨 뒤, name "Z", requestLine null, factsKnown false)`; Z의 404 칸 `unknown`, 코드 0 칸 `counted`. `no`는 전체 순서 기준(①②③④).
  - `unreadable_scenario` — facts `{ok:false}` → 모든 행 `factsKnown:false`, `scenarioUnreadable:true`.

- [ ] **Step 2: RED** — `pnpm test stepTable` FAIL.

- [ ] **Step 3: 구현**
  - `classifyCell`: `code===0 → counted`; `facts===null` → 2xx/3xx `plain`, 그 외 `unknown`; `S.length>0` → `S.some(w=>w!==code) ? counted : expected`; S 비고 2xx/3xx → `plain`; S 비고 그 외(4xx·5xx·other) → `facts.fallibleExtract ? unknown : uncounted`.
  - 행 구성: facts 순서로 행을 만들고(`report.steps`에서 id로 찾음, 없으면 `executed:false`), facts에 없는 `report.steps`를 원래 순서로 뒤에. 행의 facts = 그 id의 `StepFacts`(없으면 `null`, `factsKnown=false`). `perCode`는 `status_counts`의 키를 `Number()`(유한 정수 아닌 키는 무시), count>0만.
  - `residual = max(0, errorCount − Σ perCode.count where cls==="counted")`. `hasResidual = rows.some(r=>r.residual>0)`.
  - `codeTotals` = 모든 행 perCode 합. `buildColumns`: 고정 열 후보 = 2xx합>0 → `class2xx`, 3xx합>0 → `class3xx`, `codeTotals.get(0)>0` → `none`, `hasResidual` → `residual`. K = 4xx·5xx·other 코드(count>0). spec §6.2 접기 알고리즘 그대로(`B = max(7 − 고정 수, 3)`, 내림차순·동률 코드 오름차순, `f` 반복 최대 3회, 계열별 F 코드 1개면 개별 열). 열 `key`: `"2xx"`·`"3xx"`·`"c{code}"`·`"f4xx"|"f5xx"|"fother"`·`"none"`·`"residual"`.
  - 칸: 각 열(잔차 제외)에 대해 구성 코드의 perCode를 합산, `cls` = 구성 중 가장 강한 것(구성 0건이면 `count:0, cls:"plain"`). `none` 열 = 코드 0. 잔차 열은 `cells`에 넣지 않고 `residual` 필드로.
  - 코드 풀이 사전·열 이름은 `ko.print.table`(사전 16종 spec §6.2 verbatim).

- [ ] **Step 4: GREEN + 이빨** — `pnpm test stepTable` PASS. `classifyCell`의 `S.some(w=>w!==code)`를 `S.every(w=>w!==code)`로 바꿔 `classify_table_rows`의 `(200, S=[200,201])` 행 RED 확인 → 원복.

- [ ] **Step 5: Commit** — `feat(print): 단계 × 응답 코드 표 모델 — 분류·잔차·열 접기`.

---

### Task 3: 단계 상태 · 요약판 상위 선택 · 경고 문장 · 용어 목록

**Files:**
- Create: `ui/src/print/stepStatus.ts`
- Modify: `ui/src/i18n/ko.ts` (`print.status`, `print.callout`, `print.glossary`, `print.legend`)
- Test: `ui/src/print/__tests__/stepStatus.test.ts`

**Interfaces:**
- Consumes: Task 2 `StepRow`, `StepTableModel`, `Column`; `Criteria` (`schemas.ts`); `Report["summary"]`, `Report["error_kinds"]`; Task 1 `fmtPct`, `fmtCount`.
- Produces:
  - `type StatusTag = "error" | "slow" | "hasErrors" | "uncounted" | "unknown" | "ok" | "notRun"`
  - `type RowStatus = { tags: StatusTag[]; grade: 0 | 1 | 2 | 3; errorRate: number }` (`tags` 표시 순 = 위 나열 순, `ok`/`notRun`은 단독)
  - `stepThresholds(stepId: string, criteria: Criteria | null | undefined): { errorRate: number | null; p95Ms: number | null }`
  - `stepStatus(row: StepRow, criteria: Criteria | null | undefined): RowStatus`
  - `type RankedRow = StepRow & { status: RowStatus }`
  - `rankRows(rows: RankedRow[]): RankedRow[]` (§8 정렬 키, 동률 시나리오 순)
  - `selectTopRows(rows: RankedRow[], n: number): { shown: RankedRow[]; remainderLine: string | null }` (`shown`은 시나리오 순)
  - `callouts(rows: RankedRow[], summary: Report["summary"]): { uncounted: string | null; unknown: string | null; affectedSteps: number }`
  - `calloutOneLine(affectedSteps: number): string` (사다리 3)
  - `type GlossaryEntry = { term: string; text: string }`
  - `glossary(model: StepTableModel, rows: RankedRow[], errorKinds: Report["error_kinds"]): { entries: GlossaryEntry[]; errorKindLine: string | null }`
  - `legendItems(model: StepTableModel, rows: RankedRow[]): string[]` · `LEGEND_SHORT: string`

- [ ] **Step 1: 실패하는 테스트 작성**
  - `threshold_source_order` — step `error_rate`/`max`(target=그 단계) 있으면 그것(같은 단계에 여러 개면 **가장 작은 threshold**), 없으면 run `max_error_rate`, 둘 다 없으면 null; `p95_ms`/`max` ↔ `max_p95_ms` 동일. step `op:"min"` 기준·`p50_ms`/`p99_ms` 기준은 무시.
  - `status_priority` — 오류율 > 기준 → `["error"]`(grade 3); p95 > 느림 기준 + uncounted 칸 → `["slow","uncounted"]`(grade 2); 오류 기준 없음 + 오류율>0 → `["hasErrors"]`; 오류 기준 있고 미초과 + 오류 있음 → `["ok"]`, `errorRate` 유지(표시 `오류 0.25%`); `executed:false` → `["notRun"]`(grade 0).
  - `status_uses_profile_criteria_not_verdict` — 중단 run(verdict 없음)도 같은 기준으로 `error`.
  - `rank_and_select` — 10행(✕1·▲3·●5·–1) n=8 → `shown` 8개는 ✕·▲·● 상위(오류 수→안 셈/확인 불가 수→p95 내림차순), **시나리오 순서로** 반환; `remainderLine` = `"나머지 2개 단계: 정상 1 · 실행 안 됨 1 (전체 목록은 표준판)"`; 남은 단계 모두 정상 → `"나머지 2개 단계: 모두 정상"`; 남은 단계 0 → null. 단계 수 ≤ n → 전부·null.
  - `callout_text` — 안 셈 칸이 (B,502,600)·(C,404,30)·(D,500,5): `"확인 필요: 'B'의 502 응답 600건, 'C'의 404 응답 30건 외 1곳은 응답 코드 검사가 없어 오류율에 포함되지 않았습니다. 포함하면 오류율은 2.6% → 3.0%가 됩니다. 이 단계에 응답 코드 검사를 추가하길 권합니다."`(A = errors/count, B = (errors+635)/count — 숫자는 픽스처로 맞춘다). 단일이면 `외` 없음. 확인 불가는 spec §6.4 두 번째 문장 verbatim(같은 2개+외 규칙). `affectedSteps` = 안 셈∪확인 불가 칸이 있는 단계 수. `calloutOneLine(2)` = `"확인 필요: 응답 코드 검사가 없는 단계 2곳 — 표준판 참조"`.
  - `glossary_only_present` — 열에 503·`기타 4xx(400,401)`·none만 → 처리량·평균·95%·오류율 + `503: 서버가 바쁨` + `400: 잘못된 요청` + `401: 인증 필요` + `응답 없음` (2xx 없으면 2xx 항목 없음, 안 셈 없으면 `검사 없음` 없음). `error_kinds=[{kind:"timeout",count:3},{kind:"connect_refused",count:2}]` + none 열 → `errorKindLine = "응답 없음 내역: 요청 타임아웃 3 · 연결 거부 2"`; none 열 없으면 null.
  - `legend_only_present` — 나타난 분류만, 잔차 열 있으면 `‘그중’…` 문장 포함.

- [ ] **Step 2: RED** — `pnpm test stepStatus` FAIL.

- [ ] **Step 3: 구현** — 위 테스트가 정한 대로. 정렬 키: `grade` → `errorCount` → `Σ perCode.count where cls ∈ {uncounted, unknown}` → `p95Ms`, 모두 내림차순, 동률 `index` 오름차순. 나머지 줄 상태 묶음: grade 3 → `오류`, 2 → `주의`, 1 → `정상`, 0 → `실행 안 됨`(0인 항목 생략, 이 순서). 오류율 = `count>0 ? errorCount/count : 0`.

- [ ] **Step 4: GREEN + 이빨** — `stepThresholds`의 "가장 작은 threshold"를 "첫 번째"로 바꿔 `threshold_source_order` RED 확인(픽스처에서 큰 값을 먼저 둘 것) → 원복.

- [ ] **Step 5: Commit** — `feat(print): 단계 상태·요약판 상위 선택·경고 문장·용어 목록`.

---

### Task 4: 판정 상자 · 지표 4칸 · 그 밖의 기준 · 머리 메타 · 측정 조건

**Files:**
- Create: `ui/src/print/verdict.ts`, `ui/src/print/conditions.ts`
- Modify: `ui/src/i18n/ko.ts` (`print.verdict`, `print.kpi`, `print.criteria`, `print.conditions`)
- Test: `ui/src/print/__tests__/verdict.test.ts`, `ui/src/print/__tests__/conditions.test.ts`

**Interfaces:**
- Consumes: `Criteria`, `Verdict`, `ProfileSchema`, `Profile`, `RunStatus` (`schemas.ts`); `deriveLoadMode` (`components/loadModel.ts:174`); `profileDurationSeconds` (`api/runPrefill.ts:43`); `formatDurationKo` (`i18n/duration.ts:2`); Task 1 `fmtMs`/`fmtPct`/`fmtRps`/`fmtCount`/`fmtDateTime`/`fmtTime`.
- Produces:
  - `criteriaHasAny(c: Criteria | null | undefined): boolean`
  - `type CriterionSpec = { metric: string; op: "max" | "min"; threshold: number; target: string | null }`
  - `expandCriteria(c: Criteria | null | undefined): CriterionSpec[]` — run 필드 순서 = 서버 `evaluate_criteria` 순(`p50_ms, p95_ms, p99_ms, error_rate, 4xx_rate, 5xx_rate, 4xx_count, 5xx_count, rps, min_window_rps`) 뒤 `step_criteria` 입력 순
  - `type Matched = { spec: CriterionSpec; row: Verdict["criteria"][number] | null }`
  - `matchVerdict(specs: CriterionSpec[], verdict: Verdict | null | undefined): Matched[]`
  - `type BoxState = { kind: "fail"; evaluated: number; failed: number } | { kind: "pass"; evaluated: number } | { kind: "notJudged"; reason: "zero" | "aborted" | "failed" } | { kind: "notEvaluable" } | { kind: "noCriteria" }`
  - `verdictBox(a: { count: number; status: string; criteria: Criteria | null | undefined; verdict: Verdict | null | undefined }): BoxState`
  - `criterionName(metric: string): { name: string; subj: string }` · `criterionValue(metric: string, v: number): string`
  - `type KpiCard = { key: "rps" | "mean" | "p95" | "errorRate"; label: string; value: string; unit: string; explain: string; target: string; bad: boolean }`
  - `kpiCards(summary: Report["summary"], matched: Matched[], box: BoxState): KpiCard[]`
  - `type OtherRow = { name: string; target: string; actual: string; judgement: "pass" | "fail" | "notJudged" | "notEvaluable" }`
  - `otherCriteriaRows(matched: Matched[], box: BoxState, stepName: (id: string) => string): OtherRow[]`
  - `limitOtherRows(rows: OtherRow[], mode: "standard" | "summary3" | "summary1"): { shown: OtherRow[]; restLine: string | null; truncated: boolean }`
  - `otherCriteriaOneLine(rows: OtherRow[]): string | null` (사다리 5: `그 밖의 기준 {N}개 중 {M}개 미달 — 표준판 참조`, 미달 0개면 `null` — 요약판엔 미달이 없으면 그 밖의 기준 블록 자체가 없으므로 5단계가 높이를 늘리지 않게)
  - `measuredWindow(startedMs: number | null, endedMs: number | null, status: string): string`
  - `loadConditionLine(profile: Profile): string`
  - `conditionsBox(a: { profileRaw: unknown; workerBreakdownLen: number; envCount: number }): { ok: true; rows: Array<{ label: string; value: string }> } | { ok: false }`

- [ ] **Step 1: 실패하는 테스트 작성**

`verdict.test.ts`:
- `has_any_mirrors_server` — 빈 객체/`null` → false; `{rps_warmup_seconds: 5}` → false; `{step_criteria: []}` → false; `{max_4xx_count: 0}` → true(0도 값); `{step_criteria:[…1개]}` → true.
- `box_states` — `count 0 + passing verdict` → `notJudged/zero`; verdict 3행 중 1 실패 → `fail{3,1}`; 모두 통과 → `pass{3}`; verdict 없음+기준 있음+`aborted` → `notJudged/aborted`, `failed` → `notJudged/failed`, `completed` → `notEvaluable`; 기준 없음 → `noCriteria`.
- `match_by_key` — profile `{max_p95_ms: 3000, min_window_rps: 10, step_criteria:[{metric:"error_rate",op:"max",threshold:0.01,target:"s1"}]}`, verdict 행 `{metric:"p95_ms",direction:"max",threshold:3000,…}`·`{metric:"error_rate",direction:"max",threshold:0.01,target:"s1",…}` → `min_window_rps`는 `row:null`(서버 skip), 나머지 매칭. run-level `target` 부재(undefined)와 spec `null` 동치.
- `kpi_targets` — box `fail` + p95 행 통과 → 95% 칸 `"목표 3.0초 이하 ● 달성"`; 오류율 행 실패 → `"목표 1.0% 이하 ✕ 미달"`, `bad:true`; 평균 칸 → `"목표 없음 (참고값)"`; 처리량 기준(min_rps 200) 행 통과 → `"목표 200건/초 이상 ● 달성"`; box `notJudged` → `"목표 3.0초 이하 (판정 안 함)"`; box `notEvaluable` 또는 그 행 null → `"(평가 불가)"`; 오류율 칸 설명 `"전체 요청 중 실패한 비율. 실패 3,720건 / 전체 144,000건"`.
- `other_rows` — 카드에 매핑 안 되는 run 기준 + step 기준(상한·하한 모두) 행, 이름 `"로그인 · 95% 응답시간"`, 측정값은 verdict 행의 `actual`만(`criterionValue`), 행 없으면 `"–"` + `notEvaluable`(box notJudged면 `notJudged`).
- `limit_rows` — 8행(미달 2·평가 불가 1·달성 5) standard → 미달 2 → 평가 불가 1 → 달성 3 = 6행, `restLine = "외 2개 기준 모두 달성"`, `truncated:true`; 남은 것에 미달 섞이면 `"외 N개 기준(달성 a · 미달 b) — 부록 참조"` 형태; `summary3` → 미달 행만 최대 3 + 초과 시 `"외 미달 N개 — 표준판 참조"`; `summary1` → 미달 1행.
- `one_line` — `otherCriteriaOneLine(8행 중 미달 2)` = `"그 밖의 기준 8개 중 2개 미달 — 표준판 참조"`; 미달 0 → `null`.

`conditions.test.ts`:
- `measured_window` — 구분자는 ` ~ `(시안의 `–`는 spec이 정한 null 표기 `–`와 겹쳐 `14:00––`처럼 읽히므로 바꾼다 — 리뷰어 판단 대상): 같은 날 → `"2026-11-04 14:00 ~ 14:10"`; 다른 날 → `"2026-11-04 23:50 ~ 2026-11-05 00:10"`; 끝 null → `"2026-11-04 14:00 ~ –"`; 둘 다 null → `"– ~ –"`; `aborted` → 뒤 `" (중단됨)"`, `failed` → `" (실패)"`.
- `load_line` — closed fixed `{vus:200,duration_seconds:600}` → `"동시 사용자 200명 · 10분"`; open fixed `{target_rps:50,duration_seconds:300}` → `"초당 50회 목표 · 5분"`; closed curve vu_stages 최대 300 합 900초 → `"동시 사용자 곡선 최대 300명 · 15분"`; open curve → `"초당 목표 곡선 최대 80회 · 5분"`.
- `conditions_rows` — closed fixed + ramp 30 + think {500,1500} + timeout 30 + data_bindings 2 + envCount 3 + workerBreakdownLen 2 → 라벨 순 `부하 모델, 크기, 기간, 시작 늘림, 단계 사이 쉼, 요청 제한 시간, 워커 수, 데이터, 환경 변수`, 값 `"0.50초–1.5초 무작위"`(think는 `fmtMs`), `"워커 2대"`, `"데이터 2개 연결"`, `"환경 변수 3개 사용"`; ramp 0·think 없음·바인딩 없음·env 0·워커 1 → 해당 행 없음; open `worker_count: 4` + breakdown 0 → `"워커 4대"`; 레거시 `data_binding` 단일 → `"데이터 1개 연결"`; `profileRaw = {vus:"x"}` → `{ok:false}`. **env 값은 인자로 받지 않는다**(개수만 — 구조적 보안).

- [ ] **Step 2: RED** — `pnpm test print/__tests__/verdict print/__tests__/conditions` FAIL.

- [ ] **Step 3: 구현** — 매핑 `max_p50_ms→p50_ms`·`max_p95_ms→p95_ms`·`max_p99_ms→p99_ms`·`max_error_rate→error_rate`·`min_rps→rps`·`max_4xx_rate→4xx_rate`·`max_5xx_rate→5xx_rate`·`max_4xx_count→4xx_count`·`max_5xx_count→5xx_count`·`min_window_rps→min_window_rps`(근거: `crates/controller/src/report.rs:304-381` `push_max`/`metric:` 문자열; op는 `min_rps`·`min_window_rps`만 `min`). `matchVerdict`: 키 `(metric, target ?? null, op===direction, threshold===)`로 verdict 행을 **소비하며** 매칭(중복 spec 대비). 지표 칸↔기준: 처리량↔`rps`, 95%↔`p95_ms`, 오류율↔`error_rate`(모두 run-level `target===null`), 평균↔없음. 그 밖의 기준 = 위 3개를 제외한 run spec 전부 + step spec 전부. `conditionsBox`는 `ProfileSchema.safeParse(profileRaw)`(throw하는 `normalizeProfile` 금지). 워커 수: `workerBreakdownLen ≥ 2` → 그 수, 아니면 open(`deriveLoadMode`)이고 `worker_count > 1` → 그 수, 아니면 행 없음. 데이터: `data_bindings?.length || (data_binding ? 1 : 0)`.

- [ ] **Step 4: GREEN + 이빨** — `verdictBox`에서 `count===0` 분기를 지워 `box_states` 첫 행 RED 확인 → 원복.

- [ ] **Step 5: Commit** — `feat(print): 판정 상자·지표 4칸·그 밖의 기준·측정 조건 모델`.

---

### Task 5: 시간 차트 모델 · 자동 문장

**Files:**
- Create: `ui/src/print/chartModel.ts`, `ui/src/print/sentences.ts`
- Modify: `ui/src/i18n/ko.ts` (`print.chart`, `print.sentence`)
- Test: `ui/src/print/__tests__/chartModel.test.ts`, `ui/src/print/__tests__/sentences.test.ts`

**Interfaces:**
- Consumes: `Report["windows"]`; Task 2 `StepRow`; Task 3 `RankedRow`, `RowStatus`; Task 4 `BoxState`, `Matched`, `criterionName`, `criterionValue`; Task 1 formats; `formatDurationKo`.
- Produces:
  - `BIN_CHOICES = [1,2,5,10,15,30,60,120,300]` · `pickBinSeconds(durationSec: number): number`
  - `niceTicks(max: number, maxTicks: number): number[]` (1·2·5×10ⁿ 간격, 0 포함, 마지막 ≥ max)
  - `timeTicks(durationSec: number): number[]` (간격 30·60·120·300·600·1800·3600·7200…초 중 눈금 ≤ 8인 최소)
  - `fmtElapsed(sec: number): string` (= `formatDurationKo(sec)`, `0 → "0"`)
  - `type ChartBin = { startSec: number; seconds: number; rps: number; topErr: number; otherErr: number }`
  - `type ChartMarker = { sec: number; label: string; level: 0 | 1 }`
  - `type ChartModel = { durationSec: number; binSeconds: number; bins: ChartBin[]; topStepId: string | null; hasErrors: boolean; rpsTicks: number[]; errTicks: number[]; timeTicks: number[]; markers: ChartMarker[] }`
  - `runT0(startedMs: number | null, windows: Report["windows"]): number | null`
  - `buildChartModel(windows: Report["windows"], t0: number | null, rows: StepRow[]): ChartModel`
  - `CHART_W_MM = 180` · `CHART_H_MM = 55` · `PLOT_X0_MM` / `PLOT_X1_MM`(축 라벨 여백 — 구현이 정하되 export) · `markerX(sec: number, durationSec: number): number`
  - `type SummaryLine = { kind: "special" | "verdict" | "problemSteps" | "errorIdentity" | "hidden" | "slow" | "fallback"; text: string }`
  - `type SummaryInput = { status: string; message: string | null; startedMs: number | null; endedMs: number | null; summary: Report["summary"]; box: BoxState; matched: Matched[]; ranked: RankedRow[]; rows: StepRow[]; windows: Report["windows"]; t0: number | null; chart: ChartModel; stepName: (id: string) => string }`
  - `summaryLines(i: SummaryInput): SummaryLine[]` (최대 5줄)
  - `shortSummary(lines: SummaryLine[]): SummaryLine[]` (사다리 6: `special`·`verdict`·`problemSteps`만)
  - `chartReadingLine(chart: ChartModel): string`

- [ ] **Step 1: 실패하는 테스트 작성**

`chartModel.test.ts`:
- `bin_choice` — 120초 → 1; 121 → 2; 600 → 5; 3600 → 30; 0 → 1.
- `bins_average_and_partial_last` — 7초·bin 5 → 2개 묶음, 둘째 `seconds:2`, rps = 그 2초 count 합 / 2.
- `top_error_step_split` — 단계 A 오류 총 10·B 3 → `topStepId="A"`, 묶음마다 `topErr`=A 오류/초, `otherErr`=나머지; 오류 0 → `hasErrors:false`, `errTicks:[]`, 마커 없음.
- `ticks` — `niceTicks(237, 5)` → `[0,100,200,300]`; `niceTicks(0,5)` → `[0,1]`; `timeTicks(600)` → `[0,120,240,360,480,600]`(60초 간격이면 11개 > 8); `timeTicks(30)` → `[0,30]`.
- `markers_cap_and_stack` — 오류 단계 4개 → 오류 수 상위 3개만 마커, 라벨 `"4분: ⑤ 오류 시작"`; 두 마커 x가 가까우면 둘째 `level:1`, 셋째도 겹치면 생략(레이블 폭 추정 = 글자 수 × `1.9`mm — 상수 export).
- `zero_request_run_chart` (Review Focus 2) — `windows=[]`, `t0=null` → `bins:[]`, `durationSec:0`, `hasErrors:false`, `timeTicks:[0]`; 모델의 모든 숫자 필드(재귀 순회)가 `Number.isFinite`(`JSON.stringify`는 NaN을 `null`로 바꿔 못 잡으므로 쓰지 말 것); `markerX(0, 0)`이 유한값(= `PLOT_X0_MM`) — x 배치는 `durationSec`를 `max(durationSec, 1)`로 나눈다.

`sentences.test.ts` (각 줄은 리터럴 문자열 단언):
- `verdict_line_verbs` — 상한 미달 → `"오류율이 기준을 넘었습니다 (측정 2.6%, 기준 1.0% 이하)"`; 하한 미달(rps) → `"처리량이 기준에 못 미쳤습니다 (측정 150건/초, 기준 200건/초 이상)"`; 미달 3개 → 첫 번째 + `" 외 2개"`; 모두 통과 → `"기준 3개를 모두 지켰습니다"`; `notJudged/aborted` → `"측정이 중단되어 기준 판정은 하지 않았습니다"`(failed → `"측정이 실패해 기준 판정은 하지 않았습니다"`); `notJudged/zero` → 판정 줄 없음(특수 줄 "요청이 하나도 실행되지 않았습니다."가 대신함); `notEvaluable` → `"기준은 있었지만 평가할 데이터가 부족했습니다"`; `noCriteria` → 줄 없음.
- `problem_steps_line` — `"문제 단계: ⑤ 신청 제출(오류), ④ 첨부 업로드(느림), ② 목록(오류 있음) 외 2개"`(우선순위 = `rankRows` 순, 괄호 = 첫 tag).
- `error_identity_line` — T=⑤ 점유 87%, 최대 counted 코드 503, 코드 기준 첫 초 240 → `"오류의 87%는 '신청 제출'에서 났고, 대부분 503(서버가 바쁨)입니다. 시작 4분 뒤 처음 나타났습니다."`; 그 뒤 묶음 50% 이상에서 503>0 → `"… 시작 4분 뒤부터 계속 났습니다."`; 30초 → `"30초 뒤"`; 코드 0 → `"대부분 응답 없음(코드 없음)입니다"`; 풀이 없는 코드 418 → `"대부분 418입니다"`; T 오류가 전부 잔차, T의 첫 `error_count>0` 초 240 → `"오류의 87%는 '신청 제출'에서 났고, 응답은 받았지만 값을 꺼내거나 본문을 읽지 못했습니다. 시작 4분 뒤 처음 나타났습니다."`(spec §7.1이 이 경우의 시점을 정의하므로 시점 문장을 붙인다; "계속" 판정은 하지 않음); 점유 40% → `"오류가 여러 단계에 흩어져 있습니다(가장 많은 곳: '신청 제출' 40%)."`. 점유율 %는 정수 반올림.
- `hidden_line` — 안 셈 최다 (B,502,600) → `"'B'에서 502 응답 600건이 있었지만 응답 코드 검사가 없어 오류로 세지 않았습니다."`; 확인 불가만 → `"'B'에서 502 응답 600건이 있었지만 오류로 세었는지 확정할 수 없습니다."`.
- `slow_line` — p95 최대인 느린 단계 → `"'첨부 업로드'(은)는 느립니다 (95% 응답 4.8초, 기준 3.0초)"` + 여럿이면 `" 외 1개"`.
- `special_lines` — `count 0` + message `"connection refused"` → 첫 줄 `"요청이 하나도 실행되지 않았습니다. 사유: connection refused"`; aborted + 경과 250초 → `"측정이 도중에 중단되었습니다(4분 10초까지 측정)."`; aborted + `started null` → `"측정이 시작되기 전에 중단되었습니다."`; failed + message → `"측정이 실패로 끝났습니다. 사유: …"`.
- `fallback_line` — 정상 완료·오류 0·기준 없음 → `["오류 없이 끝났습니다. 95% 응답시간은 2.4초입니다."]`.
- `cap_five_lines` — 특수 2 + 판정·문제·정체·숨은·느림 → 5줄(뒤에서 잘림), 순서 고정.
- `short_summary` — `shortSummary`가 special·verdict·problemSteps만 남김.
- `zero_request_run_sentences` (Review Focus 2) — count 0·aborted·started null·windows [] → 어떤 줄에도 `NaN`·`Infinity`·`undefined` 부분문자열 없음.
- `reading_line` — 오류 있음·마커 1번 240초 → `"4분부터 빨간 막대(오류)가 생깁니다"`; 마커 묶음 직전 최대 3묶음 평균 rps 대비 마커 묶음부터 최대 3묶음 평균이 10% 이상 낮으면 `", 같은 시점에 처리량 선이 내려갑니다"` 덧붙임; 마커가 첫 묶음이라 직전 묶음이 없으면 덧붙이지 않음; 직전 평균이 0이면 덧붙이지 않음; 오류 없음 → `"측정 내내 오류가 없었습니다. 선은 1초에 처리한 요청 수입니다."`.

- [ ] **Step 2: RED** — FAIL.

- [ ] **Step 3: 구현** — `durationSec = windows 비면 0, 아니면 maxTs − t0 + 1`. 묶음 `i` = `floor((ts − t0)/binSeconds)`, `seconds = min(binSeconds, durationSec − startSec)`. 오류 정체의 "코드 기준 첫 초" = step_id=T 이고 `status_counts[String(c)] > 0`인 최소 `ts − t0`; "계속" = 그 초가 속한 묶음부터 마지막 묶음까지 중 T·c>0 묶음 비율 ≥ 0.5. 오류 점유율 분모 = `summary.errors`(0이면 줄 없음). 느린 단계 = tags에 `slow`. 문장 문구는 `ko.print.sentence`.

- [ ] **Step 4: GREEN + 이빨** — `summaryLines`의 5줄 상한을 지워 `cap_five_lines` RED → 원복.

- [ ] **Step 5: Commit** — `feat(print): 시간 차트 모델·자동 문장`.

---

### Task 6: 쪽 배치 · 요약판 사다리 선택

**Files:**
- Create: `ui/src/print/paginate.ts`
- Test: `ui/src/print/__tests__/paginate.test.ts`

**Interfaces:**
- Produces:
  - `PAGE_BODY_MM = 259` · `PX_PER_MM = 96 / 25.4` · `pxToMm(px: number): number`
  - `type Block = { kind: "atomic"; id: string; heightMm: number } | { kind: "table"; id: string; titleMm: number; headerMm: number; rowsMm: number[] }`
  - `type PageItem = { kind: "atomic"; id: string } | { kind: "tableSlice"; id: string; from: number; to: number; continued: boolean }` (`to` exclusive)
  - `paginate(blocks: Block[], bodyMm: number): { pages: PageItem[][]; oversized: string[] }`
  - `type LadderLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8` (0 = 축소 없음, n = spec §9 사다리 n번까지 적용)
  - `chooseSummaryLevel(blocksAt: (level: LadderLevel) => Block[], bodyMm: number): { level: LadderLevel; pages: PageItem[][]; fits: boolean }`
  - `totalHeight(blocks: Block[]): number` (atomic = heightMm, table = titleMm + headerMm + Σrows — 쪽 반복 머리줄 미포함)

- [ ] **Step 1: 실패하는 테스트 작성**
  - `atomic_flow` — [100, 100, 100] body 259 → 쪽 [[a,b],[c]].
  - `table_split_repeats_header` — 앞 블록 200 + 표(title 8, header 6, rows 10×10) → 1쪽: atomic + slice(0..4, continued false) (200+8+6+40=254 ≤ 259), 2쪽: slice(4..10, continued true).
  - `table_needs_title_header_and_one_row` — 남은 높이 < title+header+row[0]이면 표 첫 조각을 다음 쪽으로(빈 제목만 남지 않음).
  - `oversized_atomic_alone` — 300mm 블록 → 단독 쪽 + `oversized:["x"]`, 앞뒤 블록은 다른 쪽.
  - `oversized_row_alone` — 행 하나가 body − title − header 초과 → 그 행 단독 조각 + `oversized`.
  - `empty_blocks` — [] → `pages: [[]]`(빈 1쪽, 꼬리말만).
  - `empty_table` (Review Focus 2) — `rows: []` 표 → 제목+머리줄을 한 단위(`titleMm + headerMm`)로 배치, `tableSlice{from:0,to:0,continued:false}` 1개(표가 사라지지 않음), NaN 없음.
  - `ladder_first_fit` — `blocksAt(l)`가 l<3 동안 2쪽, l=3에서 1쪽 → `{level:3, fits:true}`; 8에서도 2쪽 → `{level:8, fits:false}`, pages는 level 8 배치.
  - `total_height` — `totalHeight([atomic 10, table{title 8, header 6, rows [5,5]}])` = 34 (Task 7 `summary_ladder_shrinks_each_step`이 이 헬퍼로 spec §9 "사다리 각 칸이 높이를 줄인다"를 검증한다).

- [ ] **Step 2: RED** — FAIL.

- [ ] **Step 3: 구현** — 탐욕 배치. 쪽 `used` 누적; atomic: `used + h ≤ body`면 배치, 아니면(쪽 비어있지 않을 때) 새 쪽; 빈 쪽인데 `h > body`면 배치 + oversized + 즉시 새 쪽. table: 조각 시작 시 `need = titleMm + headerMm + (rows[from] ?? 0)`(행 0개면 제목+머리줄만으로 1조각); `used + need > body`이고 쪽 비어있지 않으면 새 쪽; 남은 높이에 들어가는 행까지 담고(최소 1행) 나머지는 다음 쪽에서 `continued:true`로 반복. 마지막에 빈 trailing 쪽 제거(단 전체가 빈 경우 `[[]]`).

- [ ] **Step 4: GREEN + 이빨** — 표 조각의 "최소 1행 + 다음 쪽 이월" 조건을 `>`→`>=`로 바꿔 `table_split_repeats_header` 경계(254 vs 259는 통과, 픽스처에 정확히 259가 되는 케이스 1개 추가) RED → 원복.

- [ ] **Step 5: Commit** — `feat(print): 쪽 배치·요약판 사다리 선택(순수)`.

---

### Task 7: 보고서 뷰 모델 · 블록 목록 (순수)

**Files:**
- Create: `ui/src/print/buildPrintDoc.ts`
- Modify: `ui/src/i18n/ko.ts` (`print.doc`)
- Test: `ui/src/print/__tests__/buildPrintDoc.test.ts`

**Interfaces:**
- Consumes: Task 1–6 전부; `Report`, `Run`, `ProfileSchema` (`schemas.ts`); `envValueToRecord`; `ko.narrative.can/cannot`; `runShortLabel` (`compare/runLabel.ts:8`).
- Produces:
  - `type PrintKind = "standard" | "summary"`
  - `type PrintDoc = { title: string; shortId: string; createdDate: string; meta: { targets: string; window: string; load: string; ident: string }; box: BoxState; boxText: { big: string; sub: string }; lines: SummaryLine[]; kpis: KpiCard[]; otherRows: OtherRow[]; table: StepTableModel; ranked: RankedRow[]; legend: string[]; callouts: ReturnType<typeof callouts>; chart: ChartModel; readingLine: string; conditions: ReturnType<typeof conditionsBox>; claims: { can: string[]; cannot: string[] } | null; glossary: ReturnType<typeof glossary> }`
  - `buildPrintDoc(a: { run: Run; report: Report; fallbackScenarioName: string | null; now: number }): PrintDoc`
  - `type Heights = Map<string, number>` (측정 id → mm)
  - `standardBlocks(doc: PrintDoc, h: Heights): Block[]` · `summaryBlocks(doc: PrintDoc, h: Heights, level: LadderLevel): Block[]`
  - `summaryRows(doc: PrintDoc, level: LadderLevel): { shown: RankedRow[]; remainderLine: string | null }` (Task 8 렌더가 블록과 같은 행을 그리도록 공유)
  - `MEASURE_IDS`(아래 규약의 id 생성 헬퍼: `rowId(stepId)`, `remainderId(n)`, `appendixRowId(i)`)

**측정 id 규약**(Task 8 측정 시트 각 요소 `data-measure="<id>"`): `header` · `verdict:full` · `verdict:short` · `kpis` · `other:standard` · `other:summary3` · `other:summary1` · `other:line` · `table:title` · `table:header` · `row:<stepId>` · `table:remainder:<n>`(n=8,6,4) · `legend:full` · `legend:short` · `callouts:full` · `callouts:line` · `notes:fold` · `notes:unreadable` · `chart` · `conditions` · `glossary` · `appendix:title` · `appendix:header` · `appendix:row:<i>` · `signature`. 없는 id의 높이는 0으로 취급.

**블록 순서**: 표준 = `header, verdict:full, kpis, other:standard?, table(제목 table:title · 머리 table:header · rows 전체), legend:full, callouts:full?, notes:fold?, notes:unreadable?, chart, conditions, glossary, appendix?(other 잘렸을 때), signature`. 요약 level L = `header, (L≥6 ? verdict:short : verdict:full), kpis, (L≥5 ? other:line : L≥4 ? other:summary1 : other:summary3)?, table(rows = summaryRows(doc,L).shown + remainder 행), (L≥2 ? legend:short : legend:full), (L≥3 ? callouts:line : callouts:full)?, (L≥1 ? 없음 : notes:fold)?, notes:unreadable?`. `?` = 내용이 있을 때만 — 요약판의 그 밖의 기준은 **미달 행이 1개 이상일 때만**(미달 0이면 L=0..8 모두 블록 없음), `notes:unreadable`(시나리오 파싱 실패 각주)은 spec §9 1단계("열 묶음 각주 제거")의 대상이 아니므로 모든 L에서 유지. `summaryRows`의 N = L≥8 → 4, L≥7 → 6, 그 외 8.

- [ ] **Step 1: 실패하는 테스트 작성** (`buildPrintDoc.test.ts`)
  - `title_falls_back` — snapshot YAML `name: 민원` → `"민원 부하 측정"`; 깨진 YAML + fallback `"현재이름"` → `"현재이름 부하 측정"`; 둘 다 없음 → `"시나리오 부하 측정"`.
  - `ident_with_label` — run label `릴리즈 2.4 전` → `'#a91f3c · "릴리즈 2.4 전"'`; label `null` → `"#a91f3c"`.
  - `claims_null_when_empty` — `narrative` 부재 또는 두 목록 빈 배열 → `claims:null`; 미지 코드 → 코드 그대로.
  - `profile_unparseable` — `report.run.profile = {vus:"x"}` → `meta.load = "–"`, `conditions = {ok:false}`, 판정 상자 `noCriteria`(픽스처 `verdict: null` — verdict가 있으면 상자는 그 verdict를 따른다; throw 없음).
  - `summary_ladder_shrinks_each_step` (spec §9) — 모든 분기가 내용을 갖는 픽스처(단계 12개·열 접힘 각주·경고·그 밖의 기준 미달 4행·요약 5줄) + 합성 `Heights`(모든 id 양수, `verdict:short`<`verdict:full`, `legend:short`<`legend:full`, `callouts:line`<`callouts:full`, `other:summary1`<`other:summary3`, `other:line`<`other:summary1`)로 각 l=0..7에서 `totalHeight(summaryBlocks(doc,h,l+1)) < totalHeight(summaryBlocks(doc,h,l))`(엄격 감소) **그리고** `header`·판정·`kpis`·단계 표 블록은 모든 l에서 존재(생략 금지 불변식), 단계 표 행 수 l≤6 → 8+1, l=7 → 6+1, l=8 → 4+1(나머지 행 포함).
  - `summary_no_other_block_without_failures` — 그 밖의 기준이 모두 달성인 픽스처 → 모든 L에서 `other:*` 블록 없음.
  - `unreadable_note_survives_ladder` — 깨진 YAML 픽스처 → `notes:unreadable` 블록이 L=0..8 모두 존재, `notes:fold`는 L≥1에서 없음.
  - `standard_appendix_only_when_truncated` — other 7행 → appendix 블록 있음, 5행 → 없음.

- [ ] **Step 2: RED** — `pnpm test buildPrintDoc` FAIL.

- [ ] **Step 3: 구현** — `facts = readScenarioFacts(report.scenario_yaml)`, `env = envValueToRecord(report.run.env)`, `profile = ProfileSchema.safeParse(report.run.profile)`(실패 시 criteria `null`, 부하 조건 `"–"`), 나머지는 Task 1–5 함수 조립. `status`·`message`·`label`·`started_at`·`ended_at`은 `Run`(`GET /api/runs/:id`)에서(리포트 run엔 `message` 없음). `boxText`·제목·식별 문구는 `ko.print.doc`/`ko.print.verdict`. 단계 이름 조회 `stepName(id)` = facts 이름(빈 문자열이면 id).

- [ ] **Step 4: GREEN + 이빨** — `summaryRows`에서 L≥7의 N=6 축소를 지워(항상 8) `summary_ladder_shrinks_each_step` RED 확인 → 원복.

- [ ] **Step 5: Commit** — `feat(print): 보고서 뷰 모델·블록 목록`.

---

### Task 8: 보고서 문서 렌더 (블록 컴포넌트 · 측정 · 쪽 · CSS)

**Files:**
- Create: `ui/src/print/PrintDocument.tsx`, `ui/src/print/print.css`, `ui/src/print/components/{ReportHeader,VerdictSection,KpiGrid,OtherCriteriaTable,StepCodeTable,TableNotes,ErrorChart,ConditionsSection,GlossarySection,SignatureBlock,PageFooter}.tsx`
- Modify: `ui/src/i18n/ko.ts` (`print.chart` 렌더 문구 보강 시)
- Test: `ui/src/print/__tests__/PrintDocument.test.tsx`

**Interfaces:**
- Consumes: Task 7 `PrintDoc`, `PrintKind`, `Heights`, `standardBlocks`, `summaryBlocks`, `summaryRows`, 측정 id 헬퍼; Task 6 `paginate`, `chooseSummaryLevel`, `pxToMm`, `PAGE_BODY_MM`; Task 5 `ChartModel`, `markerX`, `CHART_*`.
- Produces: `<PrintDocument doc: PrintDoc; kind: PrintKind; onLadder?: (level: LadderLevel) => void />` — 루트 `<div className="p-doc" data-layout-ready="true|false">` (`.p-root`는 Task 9 페이지가 감싼다; 테스트는 `<div className="p-root">`로 감싸 렌더).

**측정 → 배치 → 렌더 2단계(측정 시트는 배치 후 언마운트)**:
1. `phase="measure"`: 숨은 측정 시트(`aria-hidden="true"`, `position:absolute; left:-10000px; top:0; width:180mm; visibility:hidden`)에 Task 7 측정 id 요소 전부 렌더. 각 블록은 **패딩(margin 아님)으로 위 간격**을 가진 래퍼 `div.p-block` 안 — 측정값이 간격을 포함하고 쪽에서도 같은 래퍼를 쓰므로 미리보기 = 측정.
2. `useEffect`: `await (document.fonts?.ready ?? Promise.resolve())` → `querySelectorAll("[data-measure]")` 각 `getBoundingClientRect().height` → `pxToMm` → `Heights` → 배치(`standardBlocks`→`paginate` 또는 `chooseSummaryLevel(l => summaryBlocks(doc,h,l))`) → `oversized.length>0`/`fits:false`면 `console.warn` → `setState({phase:"paged", pages, level})` **1회**(언마운트 가드). `useLayoutEffect` setState 연쇄 금지(모니터 #185 함정).
3. `phase="paged"`: 측정 시트는 **렌더하지 않는다**(인쇄 시 문서 높이에 더해져 빈 쪽을 만들고, RTL `getByText`가 시트와 쪽을 이중 매치하기 때문). 쪽 렌더 → `data-layout-ready="true"`, `onLadder?.(level)`(요약판만, 표준판은 0).

**표 기하**: 단계 표·부록 표는 `table-layout: fixed` + **`<colgroup>`으로 모든 열 폭 명시**(숫자 열 = 요청 수 15mm · 95% 응답 13mm · 코드 열 각 12mm · 잔차 16mm · 상태 20mm, 이름 열 = 180mm − 나머지 합). 요청 줄은 렌더 시 `middleEllipsis(row.requestLine, requestLineBudget(이름 열 mm))`(코드 열 7개면 이름 열 ≈ 44mm → 33자). 코드 열이 0개면(`steps: []`·깨진 YAML) "응답 코드별 건수" 묶음 머리를 **생략**하고 머리줄은 1행(`colspan=0` 금지). 첫 머리 행의 `colspan` 묶음 머리가 있어도 fixed 레이아웃이 `colgroup` 폭을 따르므로 행 높이가 다른 행과 독립 → 행별 1회 측정이 모든 쪽·사다리 단계에 유효. 머리줄(`table:header`)은 묶음 머리 행 + 열 이름 행 2행을 한 측정 단위로.

- [ ] **Step 1: 실패하는 테스트 작성** (`PrintDocument.test.tsx`, `<div className="p-root">`로 감싸 렌더; 쪽 단언은 `await waitFor(() => expect(doc).toHaveAttribute("data-layout-ready","true"))` 뒤 — 그 시점엔 측정 시트가 없어 이중 매치 없음)
  - `renders_core_sections` — 대표 픽스처(단계 5·503 오류·안 셈 502·기준 있음 fail): `"✕ 부적합"`, `"평가한 기준 3개 중 1개 미달"`, 지표 4칸 라벨, 단계 표 헤더 `"503"`과 소제목 `"서버가 바쁨"`, 안 셈 칸 텍스트 `"안 셈"`, 경고 상자 `"확인 필요:"`로 시작하는 문장, 차트 `role="img"` + aria-label `"시간에 따른 처리량과 오류 차트"`, 용어 `"503: 서버가 바쁨"`, 서명 `"시험자"`, 꼬리말 `"Handicap 부하 테스트 도구로 생성"`·`"1 / 1"`.
  - `measure_sheet_unmounted_after_layout` — layout-ready 전엔 `[data-measure]` 요소 > 0이고 `aria-hidden="true"` 컨테이너 안; 후엔 `container.querySelectorAll("[data-measure]").length === 0`.
  - `multi_page_continuation` (US1 이어짐) — `vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")`로 `data-measure`가 `row:`로 시작하면 높이 `30mm`(px 환산), 나머지 `10mm`를 반환(`finally`에서 `mockRestore`), 단계 20개 표준판 → `.p-page` ≥ 2; **마지막 `.p-page`에만** `p-page--last`; 2쪽째에 단계 표 머리줄(`"요청 수"`)이 다시 있고 제목에 `" (이어짐)"`; 꼬리말 `"1 / N"`·`"N / N"`.
  - `long_names_clamp` (Review Focus 3) — 공백 없는 120자 이름·200자 경로 단계, 코드 열 7개 픽스처: 이름 요소에 `p-name` 클래스, 요청 줄(`p-req`) 텍스트 길이 == `requestLineBudget(그 표의 이름 열 mm)`이고 `…` 포함.
  - `no_code_columns` — `steps: []` + 깨진 YAML → `"응답 코드별 건수"` 텍스트 없음, 어떤 `th`/`td`에도 `colspan="0"` 없음.
  - `never_prints_env_values` (Review Focus 5) — run env `{BASE_URL:"https://admin:pw@api.local", TOKEN:"S3CR3T"}`, url `${BASE_URL}/x?t=${TOKEN}` → `container.textContent`와 `container.innerHTML`에 `admin`·`pw@`·`S3CR3T` 0회, `textContent`에 `"api.local"` 1회 이상.
  - `renders_zero_request_aborted_run` (Review Focus 2) — count 0·steps []·windows []·started null·aborted·깨진 YAML → `"판정 안 함"`, `"요청이 실행되지 않아 판정하지 않았습니다"`, 차트 범례 `"오류 없음"`, 단계 표 머리줄 존재(빈 표가 사라지지 않음), **`container.innerHTML`**(SVG 속성 포함)에 `NaN`·`Infinity`·`undefined` 0회.
  - `summary_kind_has_no_chart` — `kind="summary"` → 차트·용어·서명 없음, 판정·지표·단계 표 있음.
  - `bw_markers` — 오류 최대 칸 `p-cell--strongest`, 안 셈 칸 `p-cell--uncounted`, 확인 불가 칸 `p-cell--unknown`(클래스 계약; 실제 테두리 판독은 라이브).
  - `colgroup_fixed` — 단계 표에 `<colgroup>`의 `<col>` 수 == 실제 열 수, 표 `style`/클래스로 `table-layout: fixed`(`p-table` 클래스 계약).

- [ ] **Step 2: RED** — `pnpm test PrintDocument` FAIL.

- [ ] **Step 3: 구현**
  - `print.css`: 시안 v3 `<style>`(`measure-report-v3.html`)을 옮기되 모든 선택자를 `.p-root` 하위로, 색 토큰은 시안 `:root` 변수 그대로 `.p-root`에. 화면: `.p-root` 회색 배경(`#8a8f99`)·`min-height:100vh`; `.p-page` `width:210mm;height:297mm;margin:12px auto;padding:14mm 15mm 12mm;position:relative;box-shadow;background:#fff;overflow:visible`; 꼬리말 `position:absolute;bottom:7mm;left:15mm;right:15mm`. `@media print`: `.p-root{background:#fff;min-height:0}`, `.p-page{margin:0;box-shadow:none;break-after:page}`, `.p-page--last{break-after:auto}`, `.p-root .p-noprint{display:none}`, `.p-root *{print-color-adjust:exact;-webkit-print-color-adjust:exact}`. `.p-table{table-layout:fixed;width:100%}`, 이름 `.p-name{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-all}`, 요청 줄 `.p-req{white-space:nowrap;overflow:hidden}`. 칸 `.p-cell--counted`(연한 빨강) `.p-cell--strongest`(진한 빨강·흰 글자·굵게·`outline:1.5px solid`) `.p-cell--uncounted`(빗금 `repeating-linear-gradient(135deg,#fff 0 3px,#f3d9a8 3px 5px)`·`outline:2px dashed #c77700`) `.p-cell--unknown`(`outline:2px dashed #c77700`). 행 `.p-row--bad`/`.p-row--warn` 배경. 잔차 열 앞 `border-left:2px solid var(--ink)`.
  - `ErrorChart`: `<svg role="img" aria-label=… width="180mm" height="55mm" viewBox="0 0 180 55">`, 단위 = mm. 막대(쌓기 top `#b42318` / other `#f6c9c4`), 선 `#3b4bc8`(polyline, bins 0개면 생략), 왼쪽 축 rps 눈금·오른쪽 축 오류 눈금(오류 없으면 생략), 시간 눈금 `fmtElapsed`(x = `markerX`), 마커 점선 + 라벨(level 1은 한 줄 아래). 글자 크기 2.3(≈6.5pt).
  - `StepCodeTable`: 열 = `단계 | 요청 수 | 95% 응답 | [코드 열들 — 묶음 머리 1행] | 상태`(시안 v3 배치), 상태 tags를 줄마다(`● 정상` 아래 작은 `오류 0.25%`), 실행 안 됨 행은 요청 수 `0`·나머지 `–`. 표 조각 렌더 = 제목(+`" (이어짐)"` when `continued`)·머리줄·`rows.slice(from,to)`. 요약판 나머지 행 = 전체 폭 `colSpan` 한 셀.

- [ ] **Step 4: GREEN + 이빨** — `never_prints_env_values`: `hostOf`를 `u.href` 반환으로 바꿔 RED → 원복. `multi_page_continuation`: `p-page--last`를 모든 쪽에 붙이도록 바꿔 RED → 원복. `measure_sheet_unmounted_after_layout`: paged 단계에서도 시트를 렌더하게 바꿔 RED → 원복.

- [ ] **Step 5: Commit** — `feat(print): 측정결과 보고서 문서 렌더·측정·쪽 나누기`.

---

### Task 9: 인쇄 화면 경로 · 도구 줄 · 리포트 진입 버튼

**Files:**
- Create: `ui/src/pages/RunPrintPage.tsx`
- Modify: `ui/src/routes.tsx:44` 뒤(Layout 밖 최상위, `/monitors/:id/display` 선례 옆) `{ path: "/runs/:id/print", element: <RunPrintPage /> }` · `ui/src/components/report/ReportView.tsx:111` `<div className="flex items-center gap-1">` 안 맨 앞에 `<Link to={\`/runs/${report.run.id}/print\`}>` 버튼(기존 링크 버튼 스타일 재사용) · `ui/src/i18n/ko.ts` (`print.page`)
- Test: `ui/src/pages/__tests__/RunPrintPage.test.tsx`, `ui/src/pages/__tests__/RunPrintPage.ladder.test.tsx`, `ui/src/components/report/__tests__/ReportView.test.tsx`(Router 래핑 + 케이스 1개)

**Interfaces:**
- Consumes: `useRun`, `useRunReport`, `useScenario` (`api/hooks.ts`); Task 7 `buildPrintDoc`, `PrintKind`; Task 8 `PrintDocument`; Task 6 `LadderLevel`.
- Produces: `export function RunPrintPage(): JSX.Element`

- [ ] **Step 1: 기존 ReportView 테스트를 Router로 감싸기 (준비 리팩터, src 변경 전후 모두 green)** — `ReportView`에 `<Link>`가 들어가면 Router 없는 렌더가 `useHref() may be used only in the context of a <Router>`로 throw한다. `ReportView.test.tsx`의 모든 `render(<ReportView … />)`(현재 `:110`·`:138`·`:166`… — `grep -n "render(" ui/src/components/report/__tests__/ReportView.test.tsx`로 전수)를 파일 상단 헬퍼 `renderReport(ui)` = `render(<MemoryRouter>{ui}</MemoryRouter>)`로 교체. 같은 파일에 `report_print_link`(`getByRole("link",{name:"보고서 인쇄"})`의 `href="/runs/<id>/print"`) 추가 — 이 케이스만 RED. `grep -rln "<ReportView" ui/src --include='*.tsx'`(zsh에선 따옴표 필수)로 다른 렌더 지점(예: `RunDetailPage.test.tsx`는 이미 `MemoryRouter`)도 확인.

- [ ] **Step 2: 실패하는 페이지 테스트 작성**

`RunPrintPage.test.tsx` — `RunDetailPage.test.tsx`의 `fetchMock`·`MemoryRouter`+`Routes` 패턴 미러, 픽스처의 서버-null 필드(`message`·`label`·`verdict`·`last_metric_ts`)는 **null로**(absent 아님 — S-D). 실제 `PrintDocument` 사용(모킹 없음):
  - `not_terminal_message` — status `running` → `"측정이 끝난 뒤 출력할 수 있습니다"` + `돌아가기` 링크 `href="/runs/R1"`, `/report` fetch 0회(`fetchMock.mock.calls`에 `/report` URL 없음).
  - `loading_and_error` — run 로딩 중 `role="status"`; `/report` 500 → `role="alert"`에 `"보고서를 불러오지 못했습니다:"`.
  - `kind_toggle_via_query` — 초기 URL `/runs/R1/print` → `표준판` `aria-pressed="true"`; `요약판` 클릭 → `aria-pressed` 전환 + 차트(`role="img"` 이름 `"시간에 따른 처리량과 오류 차트"`) 사라짐; 초기 `?kind=summary` → 요약판; `?kind=bogus` → 표준판.
  - `print_button_calls_window_print` — `vi.spyOn(window,"print").mockImplementation(()=>{})` → 클릭 시 1회.
  - `copy_button_secure_only` — `userEvent.setup()` **뒤** clipboard 모킹: ① clipboard 있음 + `isSecureContext=true`(`Object.defineProperty(window,"isSecureContext",{value:true,configurable:true})`) → `주소 복사` 클릭 시 `writeText(window.location.href)` + `"복사했습니다"` ② clipboard 있음 + `isSecureContext=false` → 버튼 없음 ③ clipboard 없음 → 버튼 없음 ④ `writeText`가 reject → 버튼이 사라짐. 모든 경우 주소 텍스트(`<code>`)는 보임. `afterEach`에서 `Reflect.deleteProperty(navigator,"clipboard")`·`isSecureContext` 원복.
  - `toolbar_inside_root_and_hidden_in_print` — 도구 줄 요소가 `.p-noprint` 클래스를 갖고 `closest(".p-root")`가 존재(인쇄 숨김 선택자 `.p-root .p-noprint`가 닿는다).
  - `page_rule_style_present` — 렌더 후 `textContent`에 `@page`·`size: A4`를 포함한 `<style>` 1개; 언마운트 후 0개.
  - `scenario_name_fallback` — 깨진 snapshot YAML + `GET /api/scenarios/S1` 이름 `"현재이름"` → 제목 `"현재이름 부하 측정"`; 시나리오 404여도 문서는 렌더(`"시나리오 부하 측정"`).

`RunPrintPage.ladder.test.tsx` (별도 파일 — `vi.mock`은 파일 전역이라 실제 `PrintDocument`가 필요한 위 테스트와 분리):
  - `ladder_notice` — `vi.mock("../../print/PrintDocument", async () => { const React = await vi.importActual<typeof import("react")>("react"); return { PrintDocument: (p: { onLadder?: (l: number) => void }) => { React.useEffect(() => p.onLadder?.(3), [p]); return null } } })`(팩토리 안에서 React를 가져오고 `p`에 타입 — 호이스팅·strict `tsc -b` 대비) → 요약판에서 `"1장에 맞추려고 일부를 줄였습니다(표준판에 전체)"` 보임, `onLadder(0)`(표준판)에선 없음.

- [ ] **Step 3: RED** — `pnpm test RunPrintPage ReportView` FAIL(새 케이스만).

- [ ] **Step 4: 구현**
  - **훅은 모두 early return 전에**(`RunDetailPage.tsx:60-62` 패턴): `run = useRun(id)`; `terminal = run.data ? TERMINAL.includes(run.data.status) : false`(`TERMINAL`은 `api/hooks.ts:172`에서 export되지 않으므로 페이지 안에 `const TERMINAL: ReadonlyArray<RunStatus> = ["completed","failed","aborted"]`); `report = useRunReport(id, terminal)`(running이면 fetch 안 함); `scenario = useScenario(run.data?.scenario_id)`(이름 폴백 전용, 실패 무시); `[now] = useState(() => Date.now())`; `[searchParams, setSearchParams] = useSearchParams()`; `[ladder, setLadder] = useState(0)`; `[copyState, …]`; `doc = useMemo(() => run.data && report.data ? buildPrintDoc({ run: run.data, report: report.data, fallbackScenarioName: scenario.data?.name ?? null, now }) : null, [...])`. 그 뒤에 로딩/에러/미종료/리포트 로딩·에러 분기.
  - `kind = searchParams.get("kind") === "summary" ? "summary" : "standard"`, 토글은 `setSearchParams({ kind }, { replace: true })`, `PrintDocument`에 `key={kind}`(측정 재시작)·`onLadder={setLadder}`. **`PrintDocument`는 시나리오 쿼리가 끝난 뒤(`!scenario.isLoading` — 성공·실패 무관)에만 렌더**한다: 제목 폴백 이름이 배치 뒤에 도착해 `doc`이 바뀌면 이미 정한 쪽 나누기가 낡기 때문(그 전엔 로딩 `role="status"`).
  - 최상위 `<div className="p-root">` 안에: `<style>{"@page { size: A4; margin: 0 } @media print { html, body { margin: 0; background: #fff } }"}</style>` · 도구 줄 `div.p-noprint`(`role="group"` aria `보고서 종류`의 두 버튼 `aria-pressed`, `인쇄 / PDF 저장`=`window.print()`, `돌아가기`=`<Link to={\`/runs/${id}\`}>`, 안내 문장 + `<code>{window.location.href}</code>`, `navigator.clipboard && window.isSecureContext && copyState !== "failed"`일 때만 `주소 복사`, 요약판이고 `ladder > 0`이면 안내 줄) · 상태 화면 또는 `<PrintDocument>`.
  - `ReportView`: `import { Link } from "react-router-dom"`, 텍스트 `ko.print.page.openPrint`.

- [ ] **Step 5: GREEN + 전체 게이트** — `pnpm test`(인자 없이 **전체** — targeted green ≠ full green), `pnpm lint`, `pnpm build`. `find ui/src -name '*.test.ts*' | grep -v __tests__` 출력 0. 이빨: `kind` 파서를 항상 `"standard"`로 바꿔 `kind_toggle_via_query` RED → 원복; `useRunReport(id, terminal)`을 `true`로 바꿔 `not_terminal_message` RED → 원복.

- [ ] **Step 6: Commit** — `feat(print): 인쇄 화면 경로·도구 줄·리포트 진입 버튼`.

---

## 라이브 검증 (orchestrator — 구현 subagent에 디스패치하지 않음, `/live-verify` 사용)

spec §11 라이브 절 그대로. 워크트리 자체 바이너리(`cargo build -p handicap-worker` + `./target/debug/controller --db /tmp/a4-print.db --ui-dir ui/dist`, 포트 충돌 시 `--rest 127.0.0.1:8099 --grpc 127.0.0.1:8098`), `just ui-build` 후 실제 run을 만든다. 픽스처 시나리오(실제 run): ① 단계 32개 · 이름 3줄 초과 1개 · 공백 없는 긴 경로 1개 ② 응답 코드 8종 이상(응답기가 단계별로 404/429/500/502/503/504/400/401 반환 → 접기 발동, 열 7개) ③ 검사 없는 5xx 단계 2개(extract 있는/없는) ④ 기준 없는 run ⑤ aborted run ⑥ 오류 0 run ⑦ env에 `BASE_URL`·`TOKEN` 값.

1. 각 run에 `/runs/:id/print` 표준판·요약판: Playwright로 `data-layout-ready="true"` 대기 → 쪽마다 `.p-page` 내 모든 블록 `getBoundingClientRect().bottom ≤ page.top + (14 + 259)mm`(px 환산), 페이지 `scrollWidth ≤ clientWidth`(가로 넘침 0), 꼬리말과 본문 rect 교차 0. 요약판 `.p-page` 정확히 1개.
2. **요청 줄 잘림**: ①+② 조합(가장 긴 경로 + 코드 열 7개 = 이름 열 최소폭)에서 **모든 `.p-req`의 `scrollWidth <= clientWidth`**(`overflow:hidden`이라 페이지 단위 검사로는 안 보인다). 실패하면 `requestLineBudget`의 글자 폭 상수(1.3mm)를 실측값으로 조정하고 build-log에 기록.
3. **PDF 쪽 수**: 같은 URL을 `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --print-to-pdf=<scratchpad>/x.pdf --no-pdf-header-footer --virtual-time-budget=10000 '<URL>'` → `pdfinfo <scratchpad>/x.pdf`의 `Pages` == 화면 `.p-page` 수(표준·요약 각 1회 이상). 불일치 시 쪽 높이 반올림이 원인일 수 있음 — `.p-page` 인쇄 높이 조정은 이 단계에서 실측으로 결정하고 build-log에 기록.
4. **배경 미출력**: 위 PDF(배경 옵션 없음)를 이미지로 열어 ●▲✕·실선/점선 테두리·`안 셈`/`?` 글자가 남는지 + Playwright 스크린샷.
5. **보안**: 렌더된 페이지 `document.body.innerText`·`innerHTML`에 env 값(`TOKEN` 값·userinfo) 0회. 특수 줄 `사유: <message>`가 run `message`를 외부 문서에 처음 싣는다 — 마무리 보안 게이트에서 `security-reviewer`에게 message 출처(컨트롤러 crash-recovery·워커 실패 사유)가 값-무포함인지 확인 의뢰.
6. **극단값 판독**(메모리 [[live-verify-extreme-values-readable]]): 긴 이름 3줄 clamp가 숫자 열을 밀지 않음(숫자 열 rect 폭 불변), 차트 표시선 라벨 겹침 없음.
7. 진입 경로 전부(메모리 [[live-verify-all-mount-paths]]): 리포트 화면의 `보고서 인쇄` 버튼 클릭 경로 + 직접 URL 경로 + `?kind=summary` 직접 URL.
8. **사용자에게 먼저 알릴 시안과의 차이**: ① 해석 상자는 시안 v1의 맞춤 문장이 아니라 기존 `narrative` 일반 문장(spec §12-10) ② 측정 일시 구분자 ` ~ `(시안 `–`) ③ 시간 표기 소수 1자리 `3.0초`(spec §5.3, 시안 `3초`) ④ 2xx 묶음 칸에 기대 코드와 불일치 코드가 섞이면 칸 전체가 "오류로 셈" 색(각주로 코드별 건수).

## 사실 근거 (claims-ledger — 디스패치 전 orchestrator 재실행)

| 주장 | 명령 |
|---|---|
| 서버 verdict metric 문자열·op | `sed -n 281,430p crates/controller/src/report.rs \| grep -n 'metric\|direction'` |
| `has_any`가 warmup 제외·step 비어있지 않을 때만 | `grep -n "fn has_any" -A 14 crates/controller/src/store/runs.rs` |
| 엔진 assert 저장형 `{status: N}`·extract `from` 태그 | `grep -n "impl Serialize for Assertion" -A 10 crates/engine/src/scenario.rs`; `grep -n 'tag = "from"' crates/engine/src/scenario.rs` |
| started_at = ms | `grep -n "started_at" ui/src/pages/ScenarioRunsPage.tsx` (`/ 1000`) |
| CSP inline style 허용 | `grep -n "style-src" ui/index.html` |
| 라우트·ReportView 앵커 줄 | `grep -n "monitors/:id/display" ui/src/routes.tsx`; `grep -n 'flex items-center gap-1' ui/src/components/report/ReportView.tsx` |
| `ko.ts` 끝 줄 | `grep -n "^} as const;" ui/src/i18n/ko.ts` |
| `envValueToRecord`·`profileDurationSeconds`·`deriveLoadMode` 위치 | `grep -n "export function envValueToRecord\|export function profileDurationSeconds" ui/src/api/runPrefill.ts`; `grep -n "export function deriveLoadMode" ui/src/components/loadModel.ts` |
| `ReportSummary.mean_ms` 존재 | `grep -n "mean_ms" ui/src/api/schemas.ts` |
| WHATWG `URL`이 `{{h}}`·`${HOST}` 호스트를 통과(소문자화) | `node -e 'for (const s of ["http://{{h}}:8080/a","http://${HOST}/a","${BASE_URL}/x"]) { try { console.log(s, new URL(s).host) } catch { console.log(s, "THROW") } }'` → `{{h}}:8080` / `${host}` / THROW |
| Zod가 거부하는 입력(ULID·status 범위) | `grep -n "ULID_RE\|max(599)" ui/src/scenario/model.ts` |
| `ReportView.test.tsx`는 Router 없이 렌더 | `grep -n "render(\|MemoryRouter" ui/src/components/report/__tests__/ReportView.test.tsx` |
| `RunDetailPage`의 terminal-gated report 훅 패턴 | `grep -n "const terminal\|useRunReport" ui/src/pages/RunDetailPage.tsx` |
