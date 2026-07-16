# US 스파인 — 유저 스토리 규약 (정본)

> 기능 방향이 사용자 가치에서 이탈하는 3대 누수(요구 전달 왜곡·spec 방향 이탈·구현 중 디테일 이탈)를 막기 위해, 유저 스토리(US)를 brainstorming 승인 → spec → 리뷰 → task-brief → 라이브 검증 → finish 기록까지 관통하는 오라클로 쓴다. 결정: [ADR-0048](../adr/0048-user-story-spine-workflow.md), 설계: `docs/superpowers/specs/2026-07-16-us-spine-design.md`.

## 형식

- `USn: [행위자]가 [상황]에서 [하려는 일] — 성공하면 [관찰 가능한 결과]를 본다`
- **고정 헤딩 = 추출 앵커**: 헤딩 텍스트에 `사용자 스토리 (US)` 문자열 고정(레벨 무관), spec 앞머리(요구사항 섹션 시작 전). task-brief 첨부가 이 헤딩부터 **다음 동레벨-이상 헤딩까지** 기계 추출한다(US 블록이 `###`여도 다음 `##`에서 종료 — spec 나머지를 끌고 가지 않기).

## 행위자 어휘 (고정 4종 — "사용자로서" 같은 무명 행위자 금지)

| 행위자 | 정의 |
|---|---|
| QA | 시나리오를 만들고 부하를 돌리는 1차 사용자 (ADR-0001) |
| 운영자 | 운영 관점에서 부하 결과·시스템 상태를 보는 사용자 (ADR-0001) |
| 도입담당 | 사내 도입·설치·배포를 결정·수행 (이 정본 신설 정의) |
| 개발자-도구 | handicap 자체를 개발·운영 — 프로세스·도구 슬라이스의 행위자 (이 정본 신설 정의) |

## 개수·품질

- user-path US 기준 **2–5개 권장** — 6개 이상이면 슬라이스 분해 신호로 검토(자동 아님; 원칙-앵커형 US 표 선례 design-system-variants의 6개는 유효).
- **솔루션 동사 금지**: "API 추가"·"필드 구현"이 문장의 골자면 리라이트 — 골자는 사람의 작업("저장된 데이터 행을 UI에서 확인 못 함" ⭕).
- **관찰 가능성**: 성공 조건은 제3자가 동의 가능한 증거(화면·와이어·RPS·재현 숫자) — "더 편하게" 단독 불가. US가 R-id 복붙("사용자로서 R3를 원한다")이면 리뷰 finding.

## 대체 경로 (1급 — 빈 US 강요 금지)

- **버그/실측 슬라이스**: `재현 / 기대 / 실측` 블록이 US를 대체 — 실측이 더 강한 가치 신호다(open-loop-slot-sizing 선례).
- **내부-only**(마이그레이션·리팩터·docs): `US: N/A — 이유 1줄`.

## 유형 태그 (start-slice 후보 표·spec 헤더에 사용)

`user-path` / `correctness-bug` / `internal-polish` / `platform`

## 파이프라인 결합 지점 (규칙이 사는 곳 — 상세는 각 파일)

| 시점 | 규칙 | 파일 |
|---|---|---|
| 작업 선택 | 후보 표 가치 3칸(누가/지금 막힘/완료 시 관찰)+태그 — 못 채워도 자동 제외 금지, 미충족 표시 후 사용자 제시 | `start-slice` §1 |
| brainstorming 종료 | spec 착수 전 US 초안(2–5) 사용자 단독 제시·승인 | `start-slice` §4 · CLAUDE.md 파이프라인 2단계 |
| spec | 앞머리 고정 헤딩 US 블록(또는 재현/N/A) | 이 규약 |
| spec 리뷰 | value checks 상한 3문항(user-path·correctness-bug만; N/A는 사유 타당성 1문항) | `spec-plan-reviewer` Method 8 |
| plan 리뷰 | US 대비 task 누락만 — 디스패치에 동반 spec 경로 병기 | `start-slice` §4 루프 1스텝 |
| task 디스패치 | US 블록 1회 추출 → 매 brief 첨부 | CLAUDE.md Subagent dispatch 노하우 |
| 라이브 검증 | user-path면 US-anchored 행(`US \| 절차 \| 통과 신호`) 척추 | `live-verify` |
| finish | build-log 단락에 "증명된 US / 못 한 US" 한 줄 | `finish-slice` §4 |

## 형식주의 방지

- 가치 문항 **상한 3 고정** — 늘리려면 하나를 뺀다.
- 가치 finding도 `receiving-code-review` 기각 문화 적용 — 라운드마다 새 미학 논쟁이 나오면 기각 근거 1줄로 밀어낸다.
- 사용자 원문 피드백·실측 로그가 있으면 US 재작성에 시간 쓰지 말고 **원문을 앵커로**(open-loop·rundialog-ux-fixes 선례).
- 하드 게이트 없음 — US 실존을 훅으로 기계 검사하지 않는다(위조 US 양산 — tdd-guard 우회와 같은 병).

## 성공/실패 신호 (도입 2~3 슬라이스 후 점검)

- **성공**: spec 상단만 읽어도 QA/운영 작업 하나가 떠오름 · user-path 슬라이스 라이브 표에 US 행 존재 · 슬라이스당 문서 증가 반 페이지 이하.
- **실패(조정 신호)**: US 전부 R 복붙 · 리뷰 라운드마다 새 미학 논쟁 · internal-polish만 연속 머지.
