# root CLAUDE.md 재분배 — 설계

- 날짜: 2026-07-30 · 유형 태그: `internal-polish` · 브랜치: `worktree-claude-md-redistribute`
- base 커밋: `17369d32` (master) — 이 문서의 모든 측정치는 이 커밋 기준
- 선행 결정: 자동메모리 `doc-system-load-optimization.md`(2026-06-28 기록 시스템 최적화 — 분리 기준·재비대 임계값·Move D 거절). 이 슬라이스는 그 규약의 **2차 적용**이자, 규약을 레포 안으로 들여오는 작업이다.

## 사용자 스토리 (US)

- **US1**: 개발자-도구가 새 세션을 시작할 때, 매 프롬프트에 통째로 실리는 root CLAUDE.md가 54.7 KB까지 불어 컨텍스트 예산을 잠식한다 — 성공하면 규칙·현재 상태·인덱스가 그대로인 채 root가 **42 KB 이하**(`wc -c CLAUDE.md`)이고, 덜어낸 내용은 root에 남은 포인터를 따라가면 전부 도달된다.
- **US2**: 개발자-도구가 subagent를 디스패치하려고 root의 "규칙 요약" 섹션을 훑을 때, 규칙 하나하나가 4–6줄 서사에 묻혀 있어 규칙만 빠르게 확인할 수 없다 — 성공하면 root에서는 **규칙이 한 줄로** 보이고, 그 근거·사고 서사는 `docs/dev/subagent-dispatch.md`에서 읽힌다(**지금 그 정본 파일에 없는 서사 6건이 거기 실재**하는 것이 성공 조건).
- **US3**: 개발자-도구가 `/finish-slice`로 슬라이스를 마무리할 때, "상태줄은 한 줄로 교체"를 지켰는지 아무도 재지 않아 매번 문단이 쌓인다(line 7이 5,028 B가 된 경위) — 성공하면 마무리 단계에서 **예산 대비 사용률이 표로 출력**되고, 초과 시 실패(exit≠0)로 멈춘다.
- **US4**: 개발자-도구가 다음 재분배를 할 때(추세상 반드시 온다), 무엇을 어디로 옮겨도 되는지 판단할 기준이 레포 안에 없고(기준은 레포 밖 메모리 파일에만 존재) 옮긴 게 정말 남았는지 확인할 수단도 없다 — 성공하면 **이관 기준 문서와 재사용 가능한 차분 검사가 레포에** 있어, 메모리 회상 없이도 같은 절차를 반복할 수 있다.

## 1. 배경 — 측정 (전부 재현 명령 포함)

### 1.1 크기와 추세

```bash
wc -c CLAUDE.md                       # 54719
for r in HEAD HEAD~20 HEAD~50 HEAD~100; do git show $r:CLAUDE.md | wc -c; done
#   54719 / 52519 / 49833 / 49116   (2026-07-30 / 07-30 / 07-29 / 07-25)
```

확립된 재비대 임계값 50 KB를 **이미 초과**했고, 최근 추세는 슬라이스당 약 1.4 KB다.

### 1.2 섹션별 크기

```bash
python3 - <<'PY'
lines=open('CLAUDE.md').read().split('\n'); secs=[]; cur=('(preamble)',0,[])
for i,l in enumerate(lines,1):
    if l.startswith('## '): secs.append(cur); cur=(l.strip(),i,[])
    cur[2].append(l)
secs.append(cur)
for name,start,body in secs: print(sum(len(x.encode())+1 for x in body), f"L{start}", name)
PY
```

| 섹션 | B |
|---|---:|
| (preamble — 대부분이 line 7 상태줄) | 5,819 |
| 로컬 dev 실행 함정 (크로스커팅) | 11,239 |
| Subagent dispatch 노하우 | 10,980 |
| 알아둘 결정들 | 8,362 |
| 검증 자동화 (Git + Claude hooks) | 4,422 |
| 슬라이스/기능을 완료하면 (root 재비대 방지) | 4,163 |
| 슬라이스 파이프라인 | 3,853 |
| 도메인별 함정 인덱스 | 1,650 |
| 개발 환경 세팅 / 디렉토리 / 일하는 모드 / 아키텍처 / 코딩 컨벤션 / ADR 규칙 / 함정 규칙 | 합 4,232 |

(합계 54,720 = 위 스크립트가 마지막 줄에도 개행 1 B를 더한 값. `wc -c`의 54,719와 1 B 차이는 파일 끝 개행 처리 차이다.)

`sed -n '7p' CLAUDE.md | wc -c` → 5029 (= 본문 5,028 B + 개행). 이 단일 라인이 preamble의 86%다.

### 1.3 재비대의 메커니즘 — 규칙은 있었고 지켜지지 않았다

root에는 이미 세 규칙이 문서화돼 있다: 상태줄은 "한 줄 교체(append 금지)", ADR 인덱스는 "한 줄만(번호+제목+핵심 한 마디)", Subagent dispatch 섹션은 "여기엔 **규칙 요약만** — 서사는 `docs/dev/subagent-dispatch.md`". 셋 다 위반 상태다:

- 상태줄: 5,028 B(카탈로그 1,762 B + `최신 =` 문단 2,377 B + 포인터 꼬리 557 B + 머리 332 B)
- ADR 인덱스: 13줄이 180 B 초과(최대 510 B — 0044)
- Subagent 섹션: 단일 불릿 5건이 각 765–1,265 B

**근본 원인은 규칙의 부재가 아니라 측정의 부재다.** 매 슬라이스 `/finish-slice`가 "한 줄 교체"를 지시하지만 아무도 결과를 재지 않으므로, 뉘앙스를 보존하려는 편집이 항상 이긴다.

### 1.4 정본 드리프트 (US2의 근거)

`docs/dev/subagent-dispatch.md`는 스스로 "사고 서사·전체 디테일 (정본)"이라 선언하지만, 2026-07-16 추출 이후의 교훈은 root에만 append됐다:

```bash
for t in think-time-dashboard thinkboard-defaults Object.is "충돌 표" tdd-guard.sh:92 "sed -n" mb-2 getBoundingClientRect is-ancestor; do
  printf "%-24s root=%s dispatch=%s\n" "$t" "$(grep -c -- "$t" CLAUDE.md)" "$(grep -c -- "$t" docs/dev/subagent-dispatch.md)"
done
# 전부 dispatch=0
```

즉 **root에서 이 서사들을 지우면 정본에도 없다** — 삭제 전 이관이 필수다.

### 1.5 auto-load 이중 지불

root의 최근 서사 4건은 매 세션 로드되는 `MEMORY.md`(20,153 B)에도 한 줄 + 전용 토픽 파일로 존재한다: `orchestrator-verification-is-hypothesis`(3,136 B) · `review-findings-are-hypotheses`(4,995 B) · `plan-mandated-vacuous-tests`(16,009 B) · `stop-gate-fresh-context-impl`(1,663 B). root가 서사를 버려도 지식이 소실되지 않는 두 번째 근거다.

### 1.6 회귀 표면 (기준선)

- **외부 소비자 앵커**: `.claude/skills/finish-slice/SKILL.md:47`이 `grep -n '^\*\*상태:' CLAUDE.md`로 상태줄을 찾는다. 상태줄 형식을 바꾸면 다음 슬라이스의 마무리가 조용히 빗나간다.
- **포인터**: root가 참조하는 `docs/**.md` 10건은 현재 전부 실존(기준선 10/10 OK).
- **ADR 목적지**: 축약 대상 13개 ADR 파일 전부 실존(2,990–17,831 B) — `ls docs/adr/00{27,38,39,40,41,42,43,44,45,46,47,48,49}-*`.

## 2. 요구사항

| ID | 요구사항 |
|---|---|
| R1 | base 대비 root CLAUDE.md ≤ **42 KB**(목표 ~40.5 KB). 규칙·현재 상태·인덱스의 *내용*은 유지 |
| R2 | 이동 집합 4건(§3.1)을 각 목적지로 이관 |
| R3 | **삭제 전 이관**: root에서 지우는 서사는 목적지 파일에 먼저 실재해야 한다 |
| R4 | 상태줄은 `**상태:` 시작 단일 라인 유지(외부 grep 호환) + 3부 구조 + ≤ 1.2 KB |
| R5 | `scripts/check-doc-budget.sh` + `just doc-budget`: 파일별 예산 표 + 상태줄 검사 + L1 검사. 초과 exit 1, ≥85% WARN(exit 0) |
| R6 | `scripts/check-doc-coverage.sh <base-ref>` + `just doc-coverage`: L2 토큰 차분. 소실 토큰 있으면 exit 1 |
| R7 | `docs/dev/root-doc-maintenance.md` 신설: splice 함정 4건 + 예산표와 근거 + 이관 판단 기준 + 재분배 절차 |
| R8 | `.claude/skills/finish-slice/SKILL.md` §4에 `just doc-budget` 스텝 추가 |
| R9 | L1: root·도메인 CLAUDE.md의 상대 `.md` 링크 실존 + root 내부 `#앵커` 매치 + `^\*\*상태:` 정확히 1건 |
| R10 | L2: 소실 토큰 0. 의도적 삭제는 스크립트 옆 allowlist에 근거 1줄과 함께 명시 |
| R11 | L3: 예산 게이트의 이빨을 **고의 회귀→RED→원복→GREEN**으로 실증하고 결과를 build-log에 기록 |
| R12 | L4: fresh subagent 회상 프로브 + **양성 대조 1건**(레포에 없는 사실 → "모름"이 나와야 프로브가 유효) |
| R13 | R1 미달 시 예비 레버(§5)를 순서대로 적용. 레버를 쓰면 어느 것을 왜 썼는지 build-log에 기록 |

## 3. 설계

### 3.1 이동 집합

| # | 대상 | 현재 | 후(목표) | 목적지 | 안전 근거 |
|---|---|---:|---:|---|---|
| 1 | line 7의 `후속 다수(…)` 카탈로그 + `최신 = release-hygiene(…)` 문단 | 5,028 B | ~900 B | `docs/build-log.md` | 완료 기록. build-log에 슬라이스별 `## <기능>` 단락이 이미 있다(release-hygiene = L486) |
| 2 | Subagent dispatch 섹션의 대형 서사 5건(877·765·1,060·1,265·1,090 B) + 중형 4건(688·481·453·383 B — 이 중 383 B 불릿도 서사를 담고 있어, US2가 세는 "서사 6건"은 대형 5건 + 383 B 1건이다) | 10,980 B | ~5.7 KB | `docs/dev/subagent-dispatch.md` | 선언된 정본. **단 §1.4대로 현재 부재 → 먼저 기입**. 4건은 `MEMORY.md`+토픽 파일도 보유 |
| 3 | "슬라이스/기능을 완료하면"의 splice 함정 4건(482·579·715·1,000 B) | 4,163 B | ~1.5 KB | `docs/dev/root-doc-maintenance.md`(신설) | 트리거 명확(`/finish-slice`에서만 쓰는 기법) — Playwright→`/live-verify` 선례와 동일 클래스 |
| 4 | ADR 인덱스 과대 13줄(0027·0038·0039–0049) → 번호+제목+핵심 한 마디 | 8,362 B | ~6.1 KB | `docs/adr/*.md`(기존) | 파일 13개 실존 확인(§1.6). "인덱스엔 한 줄만"은 root가 이미 문서화한 규칙 |
| | **합계** | **54.7 KB** | **~40.5 KB** | | |

**손대지 않는 것**: 로컬 dev 실행 함정(11,239 B), 검증 자동화(4,422 B), 슬라이스 파이프라인(3,853 B), 도메인별 함정 인덱스, 개발 환경 세팅, 디렉토리, 코딩 컨벤션. 이유는 §4.

**압축의 성격**: #1·#4는 *완료 기록의 축약*(목적지에 이미 존재), #2·#3은 *이관*(목적지에 기입 후 root 축약). #2·#3은 R3의 대상이다.

### 3.2 도구 2개

기존 `scripts/check-release-versions.sh` 컨벤션(레포 스크립트 + `just` 레시피 + 로컬 실행 가능)을 따른다.

**`scripts/check-doc-budget.sh`** — `just doc-budget`

- 파일별 `현재 / 예산 / 사용률` 표 출력
- root 상태줄(`^\*\*상태:` 매치 라인) 크기 검사
- L1 검사(R9) 동반
- 종료 코드: 초과 1건이라도 있으면 `exit 1`; 없고 ≥85%면 WARN 배너 + `exit 0`; 그 외 `exit 0`

**`scripts/check-doc-coverage.sh <base-ref>`** — `just doc-coverage`

- `git show <base-ref>:CLAUDE.md`에서 인용 토큰 추출: inline-code span(`` `…` ``), `docs/**.md` 경로, `ADR-\d{4}`, 수치+단위
- **현재 root에서 사라진 토큰만** 목적지 코퍼스(`docs/build-log.md`, `docs/dev/*.md`, `docs/adr/*.md`, 도메인 `CLAUDE.md`)에서 검색
- 어디에도 없으면 소실로 보고 `exit 1`. allowlist에 있는 토큰은 제외
- 프로토타입 실측: base root의 고유 토큰 416개, 추출·대조 동작 확인

### 3.3 예산값 — 기존 정책 채택

새 임계값을 발명하지 않고 확립된 값을 쓴다(루트 50 / ui 120 / engine 60 / controller "현 최대"). 전부 현재치보다 크므로 도입 즉시 green이다 — 도입하자마자 빨간 게이트는 무시당한다.

| 파일 | 현재 B | 예산 |
|---|---:|---:|
| `CLAUDE.md` | 54,719 → ~40.5 K | 50 KB |
| `ui/CLAUDE.md` | 116,129 | 120 KB |
| `crates/controller/CLAUDE.md` | 82,481 | 90 KB |
| `crates/engine/CLAUDE.md` | 37,057 | 60 KB |
| `crates/worker-core/CLAUDE.md` | 11,388 | 20 KB |
| `deploy/CLAUDE.md` | 8,594 | 20 KB |
| `desktop/CLAUDE.md` | 8,101 | 20 KB |
| root 상태줄(단일 라인) | 5,028 → ~900 | 1.2 KB |

`MEMORY.md`는 레포 밖(`~/.claude/projects/…`)이라 검사 대상 제외 — 자체 `/curate-memory` 스킬과 24 KB 한도를 이미 갖고 있다. 이 사실을 `root-doc-maintenance.md`에 명시한다.

R1의 합격선(42 KB)과 예산(50 KB)이 다른 것은 의도적이다: 42는 *이번 슬라이스의 수용 기준*, 50은 *상시 게이트*다.

### 3.4 구조 분리

**상태줄 3부 구조** (`**상태:` 시작 유지 — R4):

1. 현재 단계 한 마디(MVP1 + post-MVP1 영역 요약)
2. `최신 = <slug> (<날짜>, 머지 <sha>) — 상세는 docs/build-log.md`
3. 포인터 꼬리(build-log / roadmap-status / roadmap / ADR / specs / plans)

기능 카탈로그는 build-log가 단일 소스이므로 root에서 제거한다. 1.2 KB 예산이 이 구조를 기계적으로 강제한다.

**`docs/dev/root-doc-maintenance.md` 신설** — 네 가지를 담는다:

1. splice 함정 4건(이동분: Python 스플라이스 필요성 / imbalance-vs-HEAD 검증 / 앵커 구분자 char-identity / end_anchor 꼬리 오염)
2. 예산표와 그 근거(§3.3) + 두 스크립트 사용법
3. **이관 판단 기준**: ① 완료 기록 → 안전 ② 명확한 활동 트리거가 있는 함정 → 안전 ③ 편집-트리거 함정 → 인라인 유지(Move D 거절 선례)
4. 재분배 절차(L2 차분 검사 사용법 포함)

3번이 이 파일의 두 번째 목적이다 — 지금 이 기준은 레포 밖 메모리 파일에만 있어서, 그 메모리를 회상하지 못한 세션은 기준 없이 재분배한다.

### 3.5 회귀 테스트 4층

| 층 | 겨누는 실패 | 수단 | 수명 |
|---|---|---|---|
| L1 | 포인터·앵커 파손(옮겼는데 못 찾음) | `check-doc-budget.sh` 내장 | 영구 |
| L2 | 지식 소실(옮겼다고 적었지만 실은 안 옮김) | `check-doc-coverage.sh <base>` | 영구 |
| L3 | 게이트 자체가 공허(항상 통과) | 고의 회귀→RED→원복→GREEN | 1회, build-log 기록 |
| L4 | 불변식 미검증(파일은 맞지만 소비자가 못 찾음) | fresh subagent 회상 프로브 + 양성 대조 | 1회, build-log 기록 |

**L4 프로토콜**: 컨텍스트 없는 fresh subagent(`Explore` 타입 충분)에게 제거된 지식을 묻고, repo만 보고 근거 경로와 함께 답하는지 본다. 프로브 최소 4문항 + **양성 대조 1문항**(레포에 존재하지 않는 사실 — "모름"이 나와야 프로브가 유효함이 증명된다). 대조가 통과해버리면 프로브 설계가 잘못된 것이므로 프로브를 고쳐 다시 돌린다.

## 4. 비목표

- `MEMORY.md` 재구성 — 별도 스킬·한도 보유. 예산 검사 대상도 아님
- 도메인 CLAUDE.md(ui 116 KB 등) 압축 — 예산에 등록만 하고 내용은 손대지 않는다
- 로컬 dev 실행 함정·검증 자동화 섹션 이동 — 편집/실행 트리거 함정이라 Move D 거절 선례와 같은 클래스(§5 예비 레버로만)
- pre-commit 훅 편입 — 함정 한 줄 추가가 커밋을 막는 마찰을 피한다(사용자 선택)
- ADR 파일 자체 수정 — 인덱스 줄만 줄인다
- 새 임계값 정책 발명 — 기존 값을 채택한다

## 5. 예비 레버 (R13 — R1 미달 시 순서대로)

계획 착지(~40.5 KB)와 합격선(42 KB)의 여유는 1.5 KB뿐이므로, §3.1이 예상보다 덜 줄면 아래를 순서대로 적용한다.

1. **검증 자동화 §"매 커밋 일상 규칙" ①–⑤ 축약**(4,422 B 중 ~1 KB): 상세는 이미 `docs/dev/commit-gates-and-git-workflow.md`에 있다
2. **로컬 dev 실행 함정의 최장 불릿 3건 서사만 이동**(~1.5 KB): 규칙 한 줄은 남기고 서사를 `docs/dev/`로 — 편집-트리거 함정이므로 **규칙 줄은 반드시 root 유지**
3. 그래도 미달이면 사용자에게 판단을 요청한다(§3.1 #4 확대 등)

## 6. 위험과 완화

| 위험 | 완화 |
|---|---|
| 헤드룸 1.5 KB — 압축이 예상보다 덜 됨 | §5 예비 레버 |
| 서사 이관 누락(삭제만 하고 기입 안 함) — **가장 가능성 높은 실패** | R3 + L2 차분 검사. §1.4가 현재 부재를 이미 증명 |
| 상태줄 형식 변경으로 finish-slice grep 파손 | R4(형식 유지) + L1(`^\*\*상태:` 정확히 1건) |
| ADR 한 줄 축약으로 결정의 발견성 저하 | 번호+제목+핵심 한 마디 유지(존재 신호 보존). 목적지 13파일 실존 확인 |
| 예산 스크립트가 항상 통과하는 공허한 게이트 | L3 이빨 실증 |
| L4 프로브가 공허(전부 통과) | 양성 대조 1문항 |
| 압축 과정에서 규칙의 *의미*가 바뀜(요약하다 뉘앙스 소실) | 최종 리뷰가 base 대비 규칙 줄 단위 대조. L2는 토큰만 보고 의미는 못 본다 — **이 한계를 명시**하고 리뷰에 위임 |

## 7. 수용 기준

| US | 검증 |
|---|---|
| US1 | `wc -c CLAUDE.md` ≤ 43,008(42 KB) · L1 포인터/앵커 전 항목 통과 · L2 소실 토큰 0 |
| US2 | root의 Subagent dispatch 섹션에서 각 규칙이 1줄 · §1.4의 9개 토큰이 `docs/dev/subagent-dispatch.md`에서 grep 히트(현재 전부 0) |
| US3 | `just doc-budget`이 표 출력 + L3 RED/GREEN 실증 · `finish-slice` §4에 스텝 존재 |
| US4 | `docs/dev/root-doc-maintenance.md`에 이관 기준 3분류 존재 · `just doc-coverage <base>`가 재실행 가능 |
| 전체 | L4 프로브 4문항 정답 도달 + 양성 대조 "모름" |

## 8. 열린 질문

없음. (범위·강제력·목표 크기·US 합격선 전부 사용자 확정: 압축+재비대 방지 / 기계적 측정+구조 분리 / ~42–45 KB 목표 / US1 합격선 42 KB.)
