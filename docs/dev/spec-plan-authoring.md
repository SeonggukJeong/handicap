# spec/plan 작성 규율·슬라이스 파이프라인 원문 (사고 서사 포함)

> root `CLAUDE.md`에서 **원문 그대로** 옮겨 온 것(2026-10-24 claude-md-optimize — root는 매 프롬프트 로드라 규칙 한 줄만 남기고 서사·레시피·사례는 여기로). root에 남은 규칙 줄과 충돌하면 root가 우선한다. spec/plan을 쓰거나 리뷰 루프를 돌 때(`/start-slice` 2단계) 읽어라. 메모리 `spec-plan-authoring-selfcheck`·`stop-gate-fresh-context-impl`과 같은 내용의 레포 정본.

## 파이프라인 머리말 (단계 생략 금지의 근거)

worktree 슬라이스의 고정 순서. **어느 단계도 "작아서/dogfood라서" 생략 금지** (2026-06-15 사고: `spec-plan-reviewer` 루프를 임의 건너뛰고 구현 직행 → reviewer가 뒤늦게 CRITICAL 1000× 단위 버그 적발. coverage≠correctness라 템플릿·체크리스트가 리뷰를 *대체 못 함*; 그래서 `spec-review-guard`가 reviewer 통과를 기계적으로 강제). 시작·마무리는 `/start-slice`·`/finish-slice` 스킬이 체크리스트, 아래가 전체 골격:

## 2단계 설계 — US 초안·리뷰 루프·STOP-gate

2. **설계** brainstorming 종료 시 **US 초안(2–5개, 규약 `docs/dev/user-story-spine.md`)을 사용자에게 단독 제시·승인 후 spec 착수** — spec 앞머리에 `사용자 스토리 (US)` 고정 헤딩 블록 필수(버그는 재현/기대/실측, 내부-only는 `US: N/A — 이유` 대체 가; ADR-0048). spec → `spec-plan-reviewer` **clean `APPROVE`까지 반복**(`APPROVE-WITH-FIXES`/`NEEDS-REWORK`=미통과; finding은 `receiving-code-review`로 비판 평가 후 반영/기각). 이어 plan도 같은 루프. **clean APPROVE 후에만** plan에 `REVIEW-GATE: APPROVED` 마커 → 없으면 `spec-review-guard`가 `crates/*/src`·`ui/src` 편집 deny(미통과 상태 마킹 = 위조). **STOP-gate**: 이 세션에서 spec/plan을 새로 썼으면 커밋 후 `/clear`→fresh 컨텍스트로 3단계 진입. **사용자가 '바로 구현'을 요청해도 같은 세션 구현을 *권장/옵션으로 먼저 제시하지 말 것* — `/clear`→fresh가 기본 권장, 명시 고집 시에만 따른다**(2026-06-20 L2: 플랜 승인 후 '같은 세션 계속(추천)' 제시→채택→구현+라이브검증+finish로 컨텍스트 62% 소모, 사용자 교정. plan이 진실의 원천이라 fresh 구현이 품질·컨텍스트 양면 유리). [[stop-gate-fresh-context-impl]]

## spec/plan 사실 주장 규율 5항

**spec/plan 사실 주장 규율** (store-proto-mapping 2026-08-02 — 리뷰 8라운드가 내 사실오류 10건을 잡았고, 뿌리는 셋뿐이었다): ① **부재·유일성 주장**("유일한"·"어느 것도"·"0건")은 **경계 없는 전수 명령으로만** — `grep -A N`·`sed -n 'a,bp'`·단일 파일 spot-check는 조용히 잘라 거짓 전칭을 만든다(`grep -A 30`이 54행의 optional dep을 잘라 "두 크레이트는 서로 의존 안 함"을 낳았다). ② 사실 주장마다 **그것을 만든 명령**을 남기고 디스패치 전 일괄 재실행(claims-ledger) — 지금 이 규칙은 brief에만 걸려 있는데 사실오류는 spec/plan에서 쏟아진다. ③ **게이트/검증 명령은 두 상태에서** — baseline(실패 신호가 나야 함) + *변경-후 예상 상태*(통과해야 함). baseline만 돌리면 "내가 같은 문서에서 의무화한 코드와 충돌해 통과 불가한 DoD"를 못 본다. ④ 리뷰 fix를 반영하면 **같은 패턴을 문서 전체 sweep** — 한 곳의 공허 함정을 고치고 다른 곳에 그대로 재발시킨다(R7 좁히고 R8에 재발). ⑤ **한 절이 두 번 틀렸으면 "이 절이 무엇을 지탱하나"를 먼저 물어라**(삭제는 판정이 아니라 그 질문의 한 답일 뿐 — 하중이 있는데 지우면 회피다): 답이 "아무것도"면 장식이었으니 삭제(§1.1은 3라운드를 먹었지만 설계 하중 0이었고, 등급 자체가 겨냥 집합을 못 줄인다는 걸 3회차에야 알았다). **하중이 있으면 반복 오류는 거기가 어렵고 중요하다는 신호** — 정밀도를 더 짜내지 말고 **검증 방식**(spot-check→전수 명령)이나 **서술 층위**(취약한 필드별 표 → 참인 한 문장)를 바꿔라.

## 규칙 자체의 점검

**이 5항(및 새로 도입한 모든 프로세스 규칙)은 그 자체가 점검 대상이다** — 쓰다가 마찰이 보이면 조용히 우회하거나 참고 따르지 말고 **사용자에게 문제를 알리고 해결안을 제시**한다(사용자 지시 2026-08-03). 실패 신호: 규칙이 결함은 못 잡고 시간만 먹는다 · **충족용 형식만 만든다**(사후에 명령을 지어내 claims-ledger를 채우기 = 공허 테스트의 프로세스판) · 매 슬라이스 예외 처리한다 · sweep이 계속 빈손. 신호가 보이면 **즉시 보고**(슬라이스 끝까지 참지 말 것), 없으면 2~3 슬라이스 후 점검. 규칙을 늘리는 쪽보다 **덜어내는 쪽**을 기본 처방으로. → [[spec-plan-authoring-selfcheck]]

## 4단계 최종 리뷰 — 보안 표면 게이트

4. **최종 리뷰** `handicap-reviewer` APPROVE(크로스커팅·repo 함정·와이어 1:1). **+ 보안 표면 게이트(path-gated)**: diff가 요청실행·템플릿/캐스트·env/데이터셋 바인딩·업로드파싱·trace/body 뷰어를 건드리면 `security-reviewer`도 APPROVE 필수(blanket 아님 — `finish-slice` §0의 grep이 트리거; 매치 없으면 N/A 스킵). `security-reviewer`는 "쓸지 기억"이 아니라 diff가 결정. **plan/spec이 "N/A 예상"이라 적어놨어도 grep이 지배한다**(think-time-defaults: plan은 "think time은 페이싱뿐이라 무매치 예상"이라 썼으나 diff가 `crates/engine/src/trace.rs`를 건드려 매치 → security-reviewer 필수. 예측을 신뢰해 스킵하지 말고 `finish-slice §0`의 grep을 직접 돌릴 것).

## 재개 판정

**재개(컨텍스트 리셋 후 어느 지점이든)**: `git log --oneline master..<branch>` + plan `- [ ]` 대조로 **현재 단계 판정 후 그 다음부터**. 판정 신호 = ① plan에 `REVIEW-GATE: APPROVED` 유무(2단계 통과?) ② task 커밋 수 vs plan task 수(3단계 진척) ③ build-log/roadmap 완료 단락 유무(6단계?). TodoWrite/subagent report 불신 — **커밋·마커·직접 실행한 테스트만 신뢰**(위 "git 커밋이 진실의 원천"의 슬라이스-레벨 확장).
