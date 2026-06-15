# spec/plan 템플릿 dogfood — 마찰점 기록

> `_TEMPLATE.md`(spec/plan, R-id 척추) 를 실제 슬라이스(mean 지연 프록시, 2026-06-15)에 굴리며 만난 문제를 모은다. **나중에 템플릿을 개선할 때 입력.** (사용자 지시 2026-06-15: "문제가 있다고 판단했던 부분은 기록해뒀다가 개선하자".)

## 발견 (mean 프록시 dogfood)

### F1 — 템플릿이 "컴파일러-driven ripple 사이트"를 묻지 않는다 (실제 누락 발생)
`ReportSummary`에 비-optional 필드(`mean_ms`)를 추가하면 **모든 struct-literal 사이트**가 컴파일 에러: `report.rs:590`(프로덕션)·`report.rs:999`·`insights.rs:318`(테스트 헬퍼)·`export.rs:414`(픽스처) = 4곳. 이 repo의 재발 함정(prost exhaustive, `AppState` ~31곳, controller CLAUDE.md "A2-2"). **내 dogfood plan은 `report.rs` 2곳만 적어 blast radius를 과소명세**했다.
- **개선안**: plan 템플릿 `File Structure`에 "**Ripple 사이트(컴파일러-driven)**" 항목을 명시 프롬프트로 추가하거나, spec §4 변경상세에 "blast radius" 한 줄. (R-id 표는 이걸 *못* 잡는다 — R1은 있었고, 빠진 건 *변경 사이트 열거*이지 *요구사항*이 아니다.)

### F2 — 커버리지 ≠ 정확성 (가장 중요한 메타 발견)
R-id 커버리지 표는 "모든 *요구사항*이 task에 매핑됐나"만 보장한다. **task가 *옳은 코드 사이트*를 건드리는지, 설계가 실현 가능한지는 보장하지 않는다.** 실제로 dogfood에서 두 요구사항이 커버리지는 통과했으나 사실이 틀렸다:
- **G2(R4 범위 오류)**: "SlotSizingHelper·WorkerSizingHelper 앵커 p50→mean"이라 적었으나, latency 앵커는 `SlotSizingHelper.tsx:22` *하나뿐*. WorkerSizingHelper는 `peakThroughput`(count 기반)이라 latency 무관 — mean과 무관.
- **G3(R3 위치 오류)**: `schemas.ts:225`라 적었으나 그건 `WindowSummary`. 실제 `ReportSummary`는 `:327`.
- **결론**: **템플릿(R-id 척추)은 `spec-plan-reviewer`/코드 검증을 대체하지 않는다.** 완전성(A)은 척추가, 정확성/실현성은 reviewer가 — 둘 다 필요. 정직하게 명문화할 한계.
- **개선안**: spec §2 acceptance 칸에 "**실재하는·검증된** 테스트명/사이트만"이라는 규칙을 강화하거나, start-slice 루프에서 "dogfood로 쓴 spec/plan도 reviewer 필수"를 못박는다(이번엔 dogfood라 reviewer를 건너뛰어 G2/G3가 새어 구현 직전 코드검증에서 잡혔다).

### F3 — "no placeholder" 규칙 vs 정당한 impl-time grep (마이너)
plan 템플릿 Self-Review가 "의사코드/`...`/TODO 없음"을 요구하나, 실제 plan은 일부 정확 라인을 구현 시점 grep으로 미루는 게 정당하다(파일·심볼·변환은 고정, 라인만 확정). dogfood가 "구현 시 grep"이라 표기했는데 이게 placeholder인지 모호.
- **개선안**: "**로직 placeholder(금지)** vs **사이트 확정 보류(허용 — 단 파일+심볼+변환이 고정일 때)**"를 구분해 명시.

### F4 — `seam ✅` 가 실패 *심각도*를 과소표현
R1(serde 방출)+R3(Zod 수용)을 "함께 머지"라 적었으나, `ReportSummarySchema`가 `.strict()`면 R1만 머지 시 **모든 리포트 파싱이 깨진다**(strict가 미지 키 거부) — "tidiness"가 아니라 hard break. seam 플래그가 "왜 함께여야 하는지"의 강도를 안 담는다.
- **개선안**: seam 칸에 실패모드 한 마디(예: "strict→hard break") 또는 spec §3에 그 결합의 파급을 적게.

## 잠정 결론 (개선 방향, 미확정)
- 척추(R-id)는 **완전성**엔 값을 냈다(parity R5·seam R1/R3가 1급으로 떠오름 = 실패모드 B/드리프트 방어). 
- 하지만 **정확성**은 못 막는다 → reviewer/코드검증과 *병행*해야 의미. 템플릿 문서에 "이건 reviewer를 대체 안 함"을 박는 게 가장 정직.
- ripple-site 프롬프트(F1)는 이 repo에 특히 값있을 듯(재발 함정).

## F5 — reviewer 루프를 스킵해도 아무것도 안 막았다 → 훅으로 강제 (이 세션에서 실행)
dogfood로 spec/plan을 쓰고 **`spec-plan-reviewer`를 안 돌린 채 구현(Task 1)에 들어갔다**(F2가 예언). 사용자 지적으로 뒤늦게 reviewer를 돌리니 **CRITICAL 2건**: ① mean()이 µs라 `/1_000` 필요(spec은 `.round()`만 → 1000× 오류·R5 parity 붕괴), ② blast radius가 4가 아니라 **golden fixture(런타임 ripple)+UI 픽스처 ~6**. 둘 다 reviewer 루프였으면 코드 전에 잡혔을 것.
- **조치**: `.claude/hooks/spec-review-guard.sh`(PreToolUse Write|Edit) 추가 — 브랜치-로컬 plan이 `REVIEW-GATE: APPROVED` 마커를 갖기 전엔 `crates/*/src`·`ui/src` 편집 deny. settings.json 배선, start-slice §4에 마커 스텝, plan 템플릿에 PENDING placeholder.
- **엣지(사용자 지적)**: 마커는 **EOL-앵커 정확매치**라 `APPROVE-WITH-FIXES`/`APPROVED-WITH-FIXES`/`APPROVED WITH FIXES`/`NOT APPROVED`/산문 언급이 **부분문자열로 통과 못 함**. 모든 브랜치 plan이 승인돼야(승인 plan 1개가 미승인 plan을 면죄 못 함). spec만 있고 plan 없으면 block.
- **한계(F2와 일관)**: 훅은 verdict 진위를 못 본다 — 마커는 orchestrator 프록시. 잊은-스킵은 0, 작정한 우회는 *가시적 위조*로 격하(tdd-guard·`--no-verify`와 같은 천장).
- **템플릿 개선 입력**: 가드가 "reviewer 루프 강제"를 *프로세스 레벨*에서 메우므로, 템플릿 자체는 "이건 reviewer를 대체 안 함"(F2)을 명시 + 가드 마커 스텝을 plan 템플릿에 내장(완료).
