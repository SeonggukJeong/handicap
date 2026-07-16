# US 스파인 — 유저 스토리 관통 오라클 (워크플로우 프로세스 변경)

날짜: 2026-07-16 · 유형 태그: user-path (행위자: 개발자-도구) · docs-only (crates·ui 0-diff) · ADR: 0048 예정

## 0. 사용자 스토리 (US) — 이 spec 자체가 규약 첫 적용

- **US1 요구 왜곡 조기 확인**: 개발자-도구가 기능 브레인스토밍 직후, 자기가 말한 의도가 올바로 이해됐는지 **짧은 US 목록 하나만 읽고** 확인·수정한다 — spec 전체를 읽고 나서야 "이게 아닌데"를 발견하지 않는다.
- **US2 방향 이탈 리뷰 적발**: 개발자-도구가 spec-plan-reviewer 리포트에서 기술 결함뿐 아니라 **"이 R은 어떤 사용자 작업에도 안 걸린다"** 류의 방향 결함을 본다 — 완벽하게 구현 가능한 잘못된 기능이 APPROVE를 통과하지 않는다.
- **US3 구현 디테일의 사용자 근거**: 개발자-도구가 task 리뷰/diff에서 UX·동작 디테일 결정이 brief에 첨부된 US를 근거로 이뤄졌음을 본다 — 머지 후 "spec은 맞는데 동작이 기대와 다름"이 줄어든다.
- **US4 검증이 작업 재현**: user-path 슬라이스의 라이브 검증이 "엔드포인트 200"이 아니라 **US별 사용자 작업 재현 + 관찰 가능한 통과 신호**로 기록된다 (editor-dataset-testrun US1–4 패턴).

## 1. 문제와 목표

기능 추가/변경 시 방향이 사용자(QA·운영) 가치와 어긋나는 사례가 반복된다. 사용자 피드백 기준 누수 지점 3곳: ① 요구 전달이 brainstorming/spec을 거치며 왜곡, ② spec 방향이 실사용과 동떨어짐, ③ 구현 중 UX/동작 디테일 이탈. 현 파이프라인 게이트(spec-plan-reviewer·handicap-reviewer·live-verify)는 전부 기술 정합(사실·실현가능성·모순·스코프·와이어·계약)만 검사한다 — start-slice 후보 표에 '가치' 칸이 있으나 판정 기준 없는 지시어뿐, "누구의 어떤 작업을 낫게 하는가"를 게이트하는 지점이 없다 — Grok 2차 크리틱 표현으로 *"완벽하게 구현 가능한 잘못된 제품"*이 통과한다. 최근 spec 3개(dataset-preview·design-system-variants·editor-dataset-testrun)에서 US가 사용자 요청의 반복으로 명문화돼 효과를 봤지만(라이브 체크리스트 척추) — 매번 시켜야 등장했고 제도화되지 않아 생략 비용이 0이다.

- **목표**: US를 brainstorming 승인 → spec → 리뷰 → task-brief → 라이브 검증까지 관통하는 오라클로 제도화. 새 파이프라인 단계·새 훅 없이 기존 6단계 문구에만 얹는다.
- **비목표**: 별도 티켓/PRD 시스템, US 실존 기계 검사 훅(위조 US 양산 — tdd-guard 우회와 같은 병), INVEST/스토리포인트류 무거운 템플릿, plan 문서에 US 장문 복제(drift), 모든 슬라이스에 라이브 US 강제(path-gated live 철학 유지).

## 2. US 규약 (정본: `docs/dev/user-story-spine.md` 신설, ~1페이지)

- **형식**: `USn: [행위자]가 [상황]에서 [하려는 일] — 성공하면 [관찰 가능한 결과]를 본다`
- **고정 헤딩 = 추출 앵커**: 헤딩 텍스트에 `사용자 스토리 (US)` 문자열 고정(레벨 무관), spec 앞머리(요구사항 섹션 시작 전). task-brief 첨부(§3 row 5)가 이 헤딩부터 다음 동레벨-이상 헤딩까지를 기계 추출한다(US 블록이 `###`여도 다음 `##`에서 종료 — spec 나머지를 끌고 가지 않기).
- **행위자 어휘 고정**: QA / 운영자 / 도입담당(사내 도입·설치·배포를 결정·수행) / 개발자-도구(handicap 자체를 개발·운영 — 프로세스·도구 슬라이스의 행위자). 앞 둘은 ADR-0001의 1차 사용자, 뒤 둘은 이 정본이 신설 정의. "사용자로서" 같은 무명 행위자 금지.
- **개수**: user-path US 기준 2–5 권장 — 6개 이상이면 분해 신호로 검토(자동 아님; 원칙-앵커형 US 표 선례 design-system-variants의 6개는 유효).
- **품질 2규칙**: ① 솔루션 동사 금지 — "API 추가"·"필드 구현"이 문장의 골자면 리라이트, 골자는 사람의 작업("저장된 데이터 행을 UI에서 확인 못 함" ⭕). ② 성공 조건은 제3자가 동의 가능한 관찰 증거(화면·와이어·RPS·재현 숫자) — "더 편하게" 단독 불가.
- **대체 경로가 1급** (빈 US 강요 금지): 버그/실측 슬라이스 = `재현/기대/실측` 블록으로 대체(open-loop-slot-sizing 유형이 반례 아님 — 실측이 더 강한 가치 신호). 내부-only(마이그레이션·리팩터·docs) = `US: N/A — 이유 1줄`.
- **슬라이스 유형 태그**: `user-path` / `correctness-bug` / `internal-polish` / `platform` — start-slice 후보 표와 spec 헤더에 쓴다.

## 3. 파이프라인 결합 7지점 (전부 기존 파일 문구 수정)

| # | 파일 | 변경 (앵커) | 막는 누수 |
|---|---|---|---|
| 1 | `.claude/skills/start-slice/SKILL.md` §1 | 기존 "근거(가치·의존성·크기)"의 가치를 3칸으로 구조화: 누가 / 지금 막힘 / 완료 시 달라지는 관찰 + 유형 태그. 원천 = `roadmap.md` §A/§B 상세 발췌(손-큐레이트 `roadmap-status.md`의 추천 권위 불변). **못 채워도 자동 제외/강등 금지** — 미충족 표시 후 사용자에게 제시 | 솔루션형 인테이크 |
| 2 | 같은 파일 §4 "둘 다 없음 → brainstorming부터" 불릿 **안** | 그 불릿에 1줄: brainstorming 산출 첫 게이트 = **spec 착수 전 US 초안(2–5)을 사용자에게 단독 제시·승인** (플러그인 brainstorming 스킬은 편집 대상 아님 — 규칙은 이 불릿에 산다). + 같은 §4 리뷰 루프 1스텝에 "plan 리뷰 디스패치엔 동반 spec 경로 병기" 1줄(row 4의 US 대조 전제) | 요구 전달 왜곡 |
| 3 | `CLAUDE.md` 슬라이스 파이프라인 2단계(설계) | "spec → reviewer" 문구에 "spec 앞머리 US 규약(`docs/dev/user-story-spine.md`) — US 초안 사용자 승인 후 spec 착수" 한 구절 삽입 | spec 방향 이탈 |
| 4 | `.claude/agents/spec-plan-reviewer.md` Method (Output 섹션 텍스트 불변) | 기존 7항 뒤 **"Value checks (spec 리뷰만, 상한 3문항 고정)"**: ① 문제 문장이 솔루션 명세인가(막힌 사용자 작업 없이 "X 추가"만 있으면 finding) ② US(또는 재현 블록)마다 관찰 가능한 성공 조건이 있는가 ③ US·재현·비목표 어디에도 안 걸리는 R은 scope creep으로 보고. **적용 조건**: user-path·correctness-bug만 — `US: N/A` 슬라이스는 "N/A 사유가 타당한가" 1문항으로 대체(전 R을 finding으로 만들지 않기). plan 리뷰는 "US 대비 task 누락"만(spec 경로는 디스패치가 병기 — row 2). US가 R 복붙("사용자로서 R3를 원한다")이면 finding. 장문 제품 전략 토론 금지 — 문장 결함만. **Output 편입**: value finding은 기존 불릿(Feasibility/Contradictions)에 severity로 보고하라는 지시를 Method 문항에 포함(Output 섹션 텍스트 0-diff) — clean APPROVE 조건에 자연 흡수 | 리뷰어 가치 맹점 |
| 5 | `CLAUDE.md` Subagent dispatch 노하우 | 기존 "task-brief는 그 task 섹션만 자른다 — 공유 정본 별도 추출" 불릿에 이어 1줄: **추출 원천=spec**(plan 아님) — spec의 `사용자 스토리 (US)` 고정 헤딩 블록(§2 앵커)을 1회 추출해 매 task-brief에 첨부(implementer가 UX/동작 디테일 결정 시 근거) | 구현 중 디테일 이탈 |
| 6 | `.claude/skills/live-verify/SKILL.md` | 도입부(함정 요약 아래)에 1단락: user-path 슬라이스는 검증 체크리스트를 spec의 US-anchored 행(`US \| 절차 \| 통과 신호`)을 척추로 구성 — "동작함"이 아니라 "사용자 작업 재현"을 증명. 집계 리포트가 못 보는 것은 와이어/DOM 실측(editor-dataset-testrun 선례) | 동작함 ≠ 쓸 만함 |
| 7 | `.claude/skills/finish-slice/SKILL.md` §4 | build-log 한 단락 append 불릿에 "+ 라이브로 증명된 US / 못 한 US 한 줄" 추가 | 사후 학습 누락 |

추가 산출물: `docs/dev/user-story-spine.md`(§2 정본), `docs/adr/0048-user-story-spine-workflow.md`(MADR — 결정·기각 대안: 하드 게이트 훅·별도 승인 단계·티켓 시스템), CLAUDE.md ADR 인덱스 한 줄.

## 4. 형식주의 방지 (설계에 내장)

- 가치 문항 **상한 3 고정** — 늘리려면 하나를 뺀다 (spec-plan-reviewer.md에 명문화).
- 가치 finding도 기존 `receiving-code-review` 기각 문화 적용 — 라운드마다 새 미학 논쟁이 나오면 기각 근거 1줄로 밀어낸다.
- finish-slice 기록(build-log 단락)에 "라이브로 증명된 US / 못 한 US" **한 줄** — §3 row 7로 제도화(관례로만 남기면 §1 진단["생략 비용 0"]과 자기모순).
- 하드 게이트 없음 — `spec-review-guard` 등 훅 일절 불변.

## 5. 무변경 / 불변식

- 파이프라인 단계 수 6 불변(새 단계 없음), 훅 4종 불변, `crates/`·`ui/` 0-diff.
- plan 문서 구조 불변 — US는 spec에만 정본, plan은 R/task 오라클 유지 (task-brief 첨부는 디스패치 시점 추출).
- REVIEW-GATE 마커 세만틱 불변 (reviewer APPROVE의 프록시 — 가치 3문항이 APPROVE 조건에 흡수될 뿐).

## 6. 검증

- **self-application**: 이 spec 자체가 §0 US·유형 태그(파이프라인 산출물 품질을 바꾸므로 행위자 `개발자-도구`의 `user-path`)·관찰 가능한 성공 조건을 갖춘다.
- **도입 2~3 슬라이스 후 점검** — 성공: spec 상단만 읽어도 QA/운영 작업 하나가 떠오름 · user-path 슬라이스 라이브 표에 US 행 존재 · 슬라이스당 문서 증가 반 페이지 이하. 실패(조정 신호): US 전부 R 복붙 · 리뷰 라운드마다 새 미학 논쟁 · internal-polish만 연속 머지.
- 라이브 검증 해당 없음 (production diff 0 — 파이프라인 5단계 생략 근거).

## 7. 배송

spec-plan-reviewer 루프(clean APPROVE까지) → 7지점+3산출물 편집 → docs-only fast-path 커밋(master 직접, 워크트리·SDD 불필요 크기). **plan 문서 생략** — §3 표가 task 목록을 대체(구현=문구 편집)하고, diff가 `crates/*/src`·`ui/src`를 안 건드려 spec-review-guard 마커도 불요. 구현 diff는 이 spec §3 표와 1:1 대조 가능해야 한다.
