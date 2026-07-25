# 시나리오 신뢰도 preflight — ko 카피 정본 (byte-exact)

> **이 파일이 문구의 단일 소스다.** plan의 task 섹션은 `task-brief`가 잘라서 전달하므로, task 밖 공유 정본인 이 표를 **매 brief에 함께** 첨부한다. 값은 **byte-exact**로 옮길 것 — 임의로 다듬지 말 것(테스트 단언이 이 문자열에 걸린다).
>
> **왜 `docs/dev/`에 있나**: `.claude/hooks/spec-review-guard.sh:71`이 `^docs/superpowers/plans/.+\.md$`에 매칭되는 **모든** 브랜치 파일에 `REVIEW-GATE: APPROVED` 마커를 요구하고, 하나라도 없으면 슬라이스 전체의 `ui/src` 편집을 막는다(`:80-85` "one unreviewed plan blocks the slice"). 이 파일은 plan이 아니라 카피 표이므로 마커를 다는 게 의미상 틀리다 → 가드 글롭 밖인 `docs/dev/`에 둔다.

## 충돌 대조 결과 (orchestrator가 직접 실행, 2026-07-25)

`ui/src/i18n/ko.ts` 전체와 **양방향 부분문자열** 대조를 돌려 2건을 잡고 대체했다:

| 최초 후보 | 충돌 대상 | 대체 |
|---|---|---|
| `주의` | `해석 주의`(`ko.ts:1041` — 1차 validity `suspect`) · `시험 해석 주의`(`:990` `headlineSloPassSuspect`) · `주의:`(`:329`) · `주의점`(`:421-422`) | **`보완 필요`** |
| `해당 없음` | `VU 해당 없음 — 열린 루프(도착률·슬롯 기반)`(`:944`) | **`해당 항목 없음`** |

`주의` 충돌은 spec §8이 명시적으로 금지한 것이다 — 신뢰도 등급 어휘가 1차 **결과 해석** 어휘(`해석 가능`/`제한적 해석`/`해석 주의`)와 겹치면 ADR-0049가 분리하려는 두 축이 사용자에게 같은 것으로 보이고, `toHaveTextContent("주의")` 단언이 두 표면 모두에 걸려 테스트가 공허해진다.

**대체 후 재검증**: `양호`·`보완 필요`·`취약`·`해당 항목 없음`·`미확인`·`신뢰도`·`에디터에서 보기`·`변수 패널에서 보기` 전부 기존 `ko.ts`에 **0매치**.

**구현 후 의무**: 이 표에 없는 문구를 새로 추가했다면 그 값으로 `grep -c` 대조를 다시 돌릴 것.

---

## `ko.trust` 네임스페이스 (신규 — 1차 `ko.validity`는 손대지 않는다)

```ts
  trust: {
    // ── 칩 (EditorShell) ──
    chipLabel: "신뢰도",
    /** 등급 미반영 D 접미 (spec D19) — 색·등급을 바꾸지 않는다. */
    chipUnverifiedSuffix: "(미확인)",
    /** yamlError 판정 보류 (spec §7.4) */
    chipPending: "—",
    chipAriaGood:
      "시나리오 신뢰도: 양호 — 시험이 실패를 감지할 수 있다는 뜻이며, 대상 시스템 성능 평가가 아닙니다. 열기",
    chipAria: (level: string, failed: number) =>
      `시나리오 신뢰도: ${level}, 고칠 곳 ${failed}개 — 열기`,
    chipAriaPending: "시나리오 신뢰도: 판정 보류 — 열기",

    // ── 등급 어휘 ──
    level: {
      good: "양호",
      caution: "보완 필요",
      weak: "취약",
    },

    // ── 모달 (TrustBoard) ──
    boardTitle: "시나리오 신뢰도",
    /** 상시 부제 — boardGoodNote와 부분문자열이 겹치지 않아야 한다(spec §8). */
    boardSubtitle: "이 점검은 시나리오가 실패를 감지할 수 있는 시험인지를 봅니다.",
    /** good일 때만 (US5) */
    boardGoodNote:
      "대상 시스템의 성능이 좋다는 뜻은 아닙니다 — 그건 실행 후 리포트에서 확인하세요.",
    boardCount: (passed: number, applicable: number) =>
      `점검 ${applicable}개 중 ${passed}개 통과`,
    boardPassedFold: (n: number) => `통과한 점검 ${n}개`,
    /** report === null (spec §7.4 보류) */
    boardGateBlocked: "YAML 오류를 먼저 해결하세요",
    naLabel: "해당 항목 없음",

    // ── 점검 A: 응답 검증 ──
    checkAFailTitle: "응답 검증이 없는 스텝이 있습니다",
    checkAFailWhy: "4xx·5xx가 와도 실패로 잡히지 않습니다",
    checkAPass: "모든 스텝에 응답 검증이 있습니다",

    // ── 점검 B: 미정의 변수 ──
    checkBFailTitle: "만들지 않는 변수를 참조합니다",
    /** 엔진 strict(UnknownVar → all VUs failed) — "조용히 통과" 서사 금지(spec F1) */
    checkBFailWhy: "이대로 부하를 걸면 시작하자마자 모든 VU가 실패합니다",
    checkBPass: "참조하는 변수를 모두 만듭니다",

    // ── 점검 C: 끊긴 추출 체인 ──
    checkCFailTitle: (n: number) => `추출한 변수 ${n}개를 아무도 쓰지 않습니다`,
    checkCFailWhy: "인증 토큰이 끊겼을 수 있습니다",
    checkCPass: "추출한 변수를 모두 사용합니다",
    /** B·C의 위임 링크 — 스텝 칩 대신(spec D14) */
    varsPanelLink: "변수 패널에서 보기",

    // ── D: 시험 실행 (등급 미반영) ──
    testRunNever: "아직 시험 실행으로 확인하지 않았습니다",
    testRunStale: "시험 실행 이후 시나리오가 바뀌었습니다",
    testRunVerified: "현재 내용으로 시험 실행해 확인했습니다",
    testRunScope: "이 브라우저 기준입니다",

    // ── RunDialog 한 줄 ──
    runDialogLine: (level: string, failed: number) =>
      `시나리오 신뢰도: ${level} (${failed}건)`,
    /** B fail 전용 분기 — 등급 단어 대신 결과를 말한다(spec §7.3) */
    runDialogBFail: "이대로 실행하면 시작하자마자 모든 VU가 실패합니다",
    runDialogLink: "에디터에서 보기",
  },
```

## 비겹침 불변식 (테스트가 여기 걸린다)

- `boardSubtitle` ⊄ `boardGoodNote`, `boardGoodNote` ⊄ `boardSubtitle` — 겹치면 "양호 전용 문구가 `good`에만 렌더된다"는 단언이 두 분기 모두에서 통과해 **공허**해진다(`thinkboard-defaults` 4번째 공허 패턴).
- `level.good`/`level.caution`/`level.weak` 셋 중 어느 것도 서로의 부분문자열이 아니다.
- `checkAPass`/`checkBPass`/`checkCPass` 셋 다 서로 다른 어두로 시작한다 — 접힌 통과 목록에서 위치 의존 `getAllBy...[0]` 없이 개별 지목이 가능해야 한다.
