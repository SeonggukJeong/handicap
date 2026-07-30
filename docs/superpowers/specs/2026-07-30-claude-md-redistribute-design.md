# root CLAUDE.md 재분배 — 설계

- 날짜: 2026-07-30 · 유형 태그: `internal-polish` · 브랜치: `worktree-claude-md-redistribute`
- base 커밋: `17369d32` (master) — 이 문서의 모든 측정치는 이 커밋 기준
- **단위 규약**: 이 문서와 구현의 `KB`는 전부 **KiB(1024 B)**. 42 KB = 43,008 B, 50 KB = 51,200 B. (리뷰 C1 — 10진/2진 혼용이 1,008 B 오차를 만들어 헤드룸 계산을 흔들었다.)
- 선행 결정: 자동메모리 `doc-system-load-optimization.md`(2026-06-28 — 분리 기준·재비대 임계값·Move D 거절). 이 슬라이스는 그 규약의 **2차 적용**이자, 규약을 레포 안으로 들여오는 작업이다.
- 리뷰 이력: `spec-plan-reviewer` 1차 `APPROVE-WITH-FIXES` → must-fix 7건·nice-to-have 6건 전건 반영(기각 0). 반영 내역은 각 절에 `(리뷰 …)`로 표기.

## 사용자 스토리 (US)

- **US1**: 개발자-도구가 새 세션을 시작할 때, 매 프롬프트에 통째로 실리는 root CLAUDE.md가 54.7 KB까지 불어 컨텍스트 예산을 잠식한다 — 성공하면 규칙·현재 상태·인덱스가 그대로인 채 root가 **43,008 B(42 KiB) 이하**이고, 덜어낸 내용은 root에 남은 포인터를 따라가면 전부 도달된다.
- **US2**: 개발자-도구가 subagent를 디스패치하려고 root의 "규칙 요약" 섹션을 훑을 때, 규칙 하나하나가 4–6줄 분량 서사에 묻혀 있어 규칙만 빠르게 확인할 수 없다 — 성공하면 root에서는 **불릿 하나가 250 B 이하**로 규칙만 말하고, 그 근거·사고 서사는 `docs/dev/subagent-dispatch.md`에서 읽힌다(**지금 그 정본 파일에 없는 서사 6건이 거기 실재**하는 것이 성공 조건).
- **US3**: 개발자-도구가 `/finish-slice`로 슬라이스를 마무리할 때, "상태줄은 한 줄로 교체"를 지켰는지 아무도 재지 않아 매번 문단이 쌓인다(line 7이 5,028 B가 된 경위) — 성공하면 마무리 단계에서 **예산 대비 사용률이 표로 출력**되고, 초과 시 실패(exit≠0)로 멈춘다.
- **US4**: 개발자-도구가 다음 재분배를 할 때(추세상 반드시 온다), 무엇을 어디로 옮겨도 되는지 판단할 기준이 레포 안에 없고(기준은 레포 밖 메모리 파일에만 존재) 옮긴 게 정말 남았는지 확인할 수단도 없다 — 성공하면 **이관 기준 문서와 재사용 가능한 이동 검증이 레포에** 있어, 메모리 회상 없이 시작한 세션도 같은 절차를 반복할 수 있다.

## 1. 배경 — 측정 (전부 재현 명령 포함)

### 1.1 크기와 추세

```bash
wc -c CLAUDE.md                       # 54719
git log --format='%h %s' -15 -- CLAUDE.md | while read h _; do git show $h:CLAUDE.md | wc -c; done
```

확립된 재비대 임계값 50 KiB를 **이미 초과**했다. 슬라이스별 크기(최근 9건, 오래된 순): 49,047(scenario-notes) → 49,116 → 49,574 → 49,612 → 49,803 → 49,833 → 50,399 → 52,519 → 54,719(release-hygiene). **최근 8 슬라이스 평균 +709 B, 최근 2 슬라이스 평균 +2,160 B** — 가속 중이다. (리뷰 F2 — 초안의 "슬라이스당 1.4 KB"는 커밋 인덱스 기반이라 재현 불가였다.)

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

합계 54,720 = 위 스크립트가 마지막 줄에도 개행 1 B를 더한 값(`wc -c`의 54,719와 1 B 차이).

`sed -n '7p' CLAUDE.md | wc -c` → 5029 (본문 5,028 B + 개행). 이 단일 라인이 preamble의 86%다.

### 1.3 재비대의 메커니즘 — 규칙은 있었고 지켜지지 않았다

root에는 이미 세 규칙이 문서화돼 있다: 상태줄은 "한 줄 교체(append 금지)", ADR 인덱스는 "한 줄만(번호+제목+핵심 한 마디)", Subagent dispatch 섹션은 "여기엔 **규칙 요약만** — 서사는 `docs/dev/subagent-dispatch.md`". 셋 다 위반 상태다:

- 상태줄: 5,028 B(머리 332 + 카탈로그 1,762 + `최신 =` 문단 2,377 + 포인터 꼬리 557)
- ADR 인덱스: 13줄이 180 B 초과(최대 510 B — 0044). 13줄 합 4,333 B
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

**외부 소비자 — root의 구조·섹션명·문구에 기계적으로 의존하는 지점** (`grep -rn "CLAUDE\.md" .claude/ scripts/ Justfile .githooks/`; 리뷰 F4가 초안의 누락 5건을 적발):

| 지점 | 의존 형태 | 이번 이동의 영향 |
|---|---|---|
| `.claude/skills/finish-slice/SKILL.md:47` | `grep -n '^\*\*상태:' CLAUDE.md` — **형식 의존** | R4가 형식 유지로 보호 |
| `.claude/skills/curl-verify/SKILL.md:12` | "'로컬에서 curl로 직접 구동' 절" — 섹션명 | 이동 집합 밖이라 무영향. **단 §5 레버 2가 발동하면 이 참조를 갱신해야 함**(그 절 = L106) |
| `.claude/skills/start-slice/SKILL.md:38` | "Subagent dispatch 노하우" — 섹션명 | 섹션명 유지하므로 무영향 |
| `.claude/skills/new-migration/SKILL.md:95` | "'알아둘 결정들' 규칙" — 섹션명 | 섹션명 유지하므로 무영향 |
| `.claude/hooks/controller-bin-guard.sh:6` | "'로컬 dev 실행 함정'" — 섹션명 | 이동 집합 밖 |
| `.claude/skills/mutation-audit/SKILL.md:8` | "coverage≠correctness" — 문구 인용 | 해당 문구 유지 |

**포인터**: root가 참조하는 `docs/**.md` 10건 전부 실존(기준선 10/10 OK).

**ADR 목적지**: 축약 대상 13개 ADR 파일 전부 실존(2,990–17,831 B).

**ADR 목적지의 신선도 결함 (리뷰 F5 — must-fix)**: 파일 실존은 *내용 포함*을 뜻하지 않는다. 13줄 전수 대조에서 두 줄이 ADR 파일과 **모순**한다:

| root 인덱스 | ADR 파일 | 확인 |
|---|---|---|
| 0039 "**옵션 A(단일 exe) 구현·머지**(cargo `bundle` feature off=byte-identical)" | `Status: accepted (… 구현은 roadmap 후보, **미착수**)`, `bundle`/`byte-identical`/`0040` 모두 0건 | `docs/adr/0039-…md:3` |
| 0044 "경계 넘기/re-parent=**슬라이스3 완료**" | "그룹 경계 넘는 re-parent는 no-op(**슬라이스 3 연기**)" | `docs/adr/0044-…md:19,29` |

즉 **root 인덱스가 최신 사실을 갖고 ADR 파일이 낡았다.** 이대로 축약하면 포인터가 *없는 답*이 아니라 **틀린 답**을 돌려준다 — 사용자 no-forget 조건의 직접 위반이다. 해소는 R14. (부수: root 0047 줄은 "proto/**store**/migration 0-diff"인데 `docs/adr/0047-…md:25`는 "proto·**worker**·migration 0-diff" — root 쪽 오기, 같이 고친다.)

### 1.7 이 슬라이스 diff에 대한 게이트 부재 (리뷰 누락결정 6)

이 슬라이스가 만지는 경로(`scripts/*.sh`·`Justfile`·`docs/`·`.claude/skills/`)는 **어떤 자동 게이트에도 걸리지 않는다**: `.githooks/pre-commit`의 `CARGO_PATHS` 밖, `tdd-guard` 밖, `spec-review-guard`(대상 = `crates/*/src`·`ui/src`) 밖. 레포에 셸 테스트 하네스도 없다. → 대체 수단은 **로컬 양방향 실행**(`scripts/check-release-versions.sh` 선례: CI-only 로직을 로컬에서 통과/실패 양쪽으로 돌려 증명) + L3·L4다. R15에 못박는다.

## 2. 요구사항

| ID | 요구사항 |
|---|---|
| R1 | root CLAUDE.md ≤ **43,008 B**(42 KiB). 목표 착지 ~41,106 B(§3.1 산술). 규칙·현재 상태·인덱스의 *내용*은 유지 |
| R2 | 이동 집합 4건(§3.1)을 각 목적지로 이관 |
| R3 | **삭제 전 이관**: root에서 지우는 서사는 목적지 파일에 먼저 실재해야 한다 |
| R4 | 상태줄은 `**상태:` 시작 단일 라인 유지(외부 grep 호환) + 3부 구조 + ≤ 1.2 KiB |
| R5 | `scripts/check-doc-budget.sh` + `just doc-budget`: 파일별 예산 표 + 상태줄 검사 + L1 검사. 초과 exit 1, **≥90%** WARN(exit 0). **도입 시점에 WARN 0건이어야 한다**(§3.3) |
| R6 | `scripts/check-doc-coverage.sh <base-ref>` + `just doc-coverage`: **manifest 기반 목적지-지향 검증**(§3.2) + 보조 토큰 차분. 위반 시 exit 1 |
| R7 | `docs/dev/root-doc-maintenance.md` 신설: splice 함정 4건 + 예산표와 근거 + 이관 판단 기준 + 재분배 절차 + **ADR 상태 갱신 규칙**(R14의 재발 방지) |
| R8 | `.claude/skills/finish-slice/SKILL.md` §4에 `just doc-budget` 스텝 추가 |
| R9 | L1: root의 **backtick·markdown-link 양쪽** `.md` 참조 실존 + root 내부 `#앵커` 매치 + `^\*\*상태:` 정확히 1건. 예외 2건 사전 선언: `MEMORY.md`(레포 밖), `2026-05-27-handicap-mvp1-design.md`(맨 파일명 — `docs/superpowers/specs/` 아래에서 해석) |
| R10 | L2 보조 토큰 검사의 의도적 삭제 예외는 `scripts/doc-coverage-allowlist.txt`에 `토큰 <TAB> # 근거` 한 줄씩 |
| R11 | **두 스크립트 모두** 이빨을 고의 회귀→RED→원복→GREEN으로 실증. coverage 쪽 필수 시나리오: **L122 불릿을 목적지 기입 없이 삭제 → 반드시 RED** |
| R12 | L4: fresh subagent 회상 프로브 ≥4문항 + **양성 대조 1건**(레포에 없는 사실 → "모름"이 나와야 프로브가 유효) |
| R13 | R1 미달 시 예비 레버(§5)를 순서대로. 레버 사용 시 어느 것을 왜 썼는지 build-log에 기록 |
| R14 | **ADR 신선도 해소**: 0039·0044 ADR 파일에 구현 결과를 반영하는 한 줄(Status 또는 "후속 상태")을 추가하고, root 0047 줄의 `store`→`worker` 오기를 정정. 그 후에만 §3.1 #4를 수행 |
| R15 | 자동 게이트가 없으므로(§1.7) 두 스크립트를 **로컬에서 통과/실패 양방향 실행**해 증명하고 결과를 build-log에 기록 |
| R16 | 이동 집합의 각 항목은 `scripts/doc-move-manifest.tsv`에 1행으로 선언된다 — 이 파일이 R3의 기계적 표현이자 리뷰 대상이다 |

## 3. 설계

### 3.1 이동 집합

| # | 대상 | 현재 | 후(목표) | 목적지 | 안전 근거 |
|---|---|---:|---:|---|---|
| 1 | line 7의 `후속 다수(…)` 카탈로그(1,762 B) + `최신 = release-hygiene(…)` 문단(2,377 B) | 5,028 B | **~1,000 B** | `docs/build-log.md` | 완료 기록. 슬라이스별 `## <기능>` 단락이 이미 있다(release-hygiene = L486). 유지분은 머리 332 + 꼬리 557 + 새 `최신 =` 한 줄 ≈ 980 B (리뷰 FR5) |
| 2 | Subagent dispatch 섹션: 대형 서사 5건(877·765·1,060·1,265·1,090 B) + 중형 4건(688·481·453·**382** B). **US2가 세는 "서사 6건" = 대형 5 + 382 B 1건** | 10,980 B | **≤6,144 B** (불릿 상한 250 B) | `docs/dev/subagent-dispatch.md` | 선언된 정본. **단 §1.4대로 현재 부재 → 먼저 기입**. 4건은 `MEMORY.md`+토픽 파일도 보유 |
| 3 | "슬라이스/기능을 완료하면"의 splice 함정 4건(482·579·715·1,000 B) | 4,163 B | ~1,536 B | `docs/dev/root-doc-maintenance.md`(신설) | 트리거 명확(`/finish-slice`에서만 쓰는 기법) — Playwright→`/live-verify` 선례와 동일 클래스 |
| 4 | ADR 인덱스 과대 13줄(합 4,333 B) → **줄당 ≤170 B** | 8,362 B | **~6,239 B** | `docs/adr/*.md`(기존, **R14 선행 필수**) | 13파일 실존 + R14로 신선도 해소 후에만 안전 |
| | **합계** | **54,720 B** | **~41,106 B** (40.1 KiB) | | 헤드룸 **1,902 B** (43,008 기준) |

산술: 미이동분 26,187 B(= 54,720 − 28,533) + 이동 후 14,919 B(= 1,000 + 6,144 + 1,536 + 6,239) = **41,106 B**. #4는 13줄 4,333 B → 13×170 = 2,210 B(절감 2,123 B)에서 나온다.

**손대지 않는 것**: 로컬 dev 실행 함정(11,239 B), 검증 자동화(4,422 B), 슬라이스 파이프라인(3,853 B), 도메인별 함정 인덱스, 개발 환경 세팅, 디렉토리, 코딩 컨벤션.

**압축의 성격**: #1·#4는 *완료 기록의 축약*(목적지에 이미 존재 — #4는 R14 이후), #2·#3은 *이관*(목적지에 기입 후 root 축약).

**줄당 상한을 명시하는 이유** (리뷰 FR3): §1.3의 "과대 = 180 B 초과"를 그대로 목표로 삼으면 13줄이 각 180 B가 되어 6,369 B에 착지, 목표를 269 B 초과한다. 상한은 **170 B**로 못박는다.

### 3.2 도구 2개

기존 `scripts/check-release-versions.sh` 컨벤션(레포 스크립트 + `just` 레시피 + 로컬 실행 가능)을 따른다.

**`scripts/check-doc-budget.sh`** — `just doc-budget`
- 파일별 `현재 / 예산 / 사용률` 표 출력 · root 상태줄 크기 검사 · L1 검사(R9)
- 종료 코드: 초과 1건이라도 있으면 `exit 1`; 없고 ≥90%면 WARN 배너 + `exit 0`; 그 외 `exit 0`

**`scripts/check-doc-coverage.sh <base-ref>`** — `just doc-coverage`

초안의 "코퍼스 전체에서 토큰을 찾는다"는 설계는 **폐기**한다. 리뷰 FR1을 직접 재현한 결과, §3.1 이동 집합의 **9개 불릿 중 4개(L122 765 B·L134·L136·L138)는 목적지에 아무것도 안 쓰고 삭제해도 GREEN**이고, 최대 이동분인 카탈로그 1,762 B는 추출 토큰이 4개(`ADR-0039`·`ADR-0042`·`ADR-0043`·`docs/build-log.md`)뿐이라 **100% 불가시**였다. 원인은 코퍼스가 1.4 MB이고 그중 `build-log.md` 단독으로 base 토큰의 57.4%를 이미 포함하는 것(마스킹), 그리고 한국어 산문에는 추출 가능한 토큰이 없다는 것이다.

→ **1차 방어선 = manifest 기반 목적지-지향 검증** (`scripts/doc-move-manifest.tsv`, R16):

```
# source_anchor <TAB> dest_file <TAB> required_marker <TAB> min_dest_gain_bytes
```

행마다 4개를 검사한다:
1. `source_anchor`가 **base root에 존재**(manifest가 base에 대해 정직한가)
2. `source_anchor`가 **현재 root에 부재**(정말 제거됐는가)
3. `required_marker`가 **`dest_file`에 존재**(정말 도착했는가) — 코퍼스 전체가 아니라 *선언된 목적지 한 파일*에서만 찾는다
4. `dest_file`의 base 대비 바이트 증가 ≥ `min_dest_gain_bytes`(한 줄 스텁이 아니라 실체가 왔는가)

`min_dest_gain_bytes = 0`은 "목적지에 이미 있음"(#1 카탈로그, #4 ADR)을 뜻하고, 이때 검사 3이 유일한 방어선이 된다.

→ **2차 방어선 = 보조 토큰 차분**(초안 설계 유지, 격하): base root에서 사라진 토큰 중 코퍼스 어디에도 없는 것을 보고. manifest가 빠뜨린 것을 줍는 그물이지 주 방어선이 아니다. 추출 규칙을 스크립트에 고정한다 — inline-code span `` `[^`\n]{2,80}` `` · `docs/[A-Za-z0-9/_.-]+\.md` · `ADR-\d{4}`. (리뷰 F3: 초안의 "수치+단위"는 단위 목록이 정의되지 않아 반증 불가능했고, 그래서 "416개"가 재현되지 않았다 — 세 규칙만 쓰면 434개.) 예외는 `scripts/doc-coverage-allowlist.txt`(R10).

**이 스크립트도 이빨을 증명해야 한다**(R11): L122를 목적지 기입 없이 지운 트리에서 RED가 나오지 않으면 스크립트가 틀린 것이다.

### 3.3 예산값

| 파일 | 현재 B | 예산 | 사용률 | 근거 |
|---|---:|---:|---:|---|
| `CLAUDE.md` | 54,719 → ~41.0 K | 50 KiB | 82% | 확립된 임계값 |
| `ui/CLAUDE.md` | 116,129 | 130 KiB | 87% | 2026-06-28의 120 KiB는 현재치의 94.5% — 갱신 |
| `crates/controller/CLAUDE.md` | 82,481 | 90 KiB | 90%→OK | 기록값 "현 78 KB·최대"는 **이미 초과 상태** |
| `crates/engine/CLAUDE.md` | 37,057 | 60 KiB | 60% | 확립된 임계값 |
| `crates/worker-core/CLAUDE.md` | 11,388 | 20 KiB | 56% | 신설 |
| `deploy/CLAUDE.md` | 8,594 | 20 KiB | 42% | 신설 |
| `desktop/CLAUDE.md` | 8,101 | 20 KiB | 40% | 신설 |
| root 상태줄(단일 라인) | 5,028 → ~980 | 1.2 KiB | 80% | 구조 분리의 강제점 |

**도입 시점 WARN 0건이 요구사항이다**(R5). 초안은 ui 94.5%·controller 89.5%가 85% 밴드에 걸려 **첫 실행부터 영구 WARN**이었고, §4가 도메인 파일 압축을 비목표로 두므로 아무도 해소할 수 없는 노이즈가 됐을 것이다(리뷰 FR2). 해소: WARN 밴드 90% + ui·controller 예산 갱신. **갱신의 정당성**: controller의 기록 임계값 78 KB는 현재 82,481 B로 이미 초과됐다 — 2026-06-28 값들이 게이트로 작동한 적이 없다는 증거이고, 그래서 이 슬라이스가 필요하다. 갱신값은 "현재치를 넘되 성장 여지는 좁게"로 잡는다.

`MEMORY.md`는 레포 밖(`~/.claude/projects/…`)이라 예산·L1 양쪽에서 제외 — 자체 `/curate-memory` 스킬과 24 KB 한도를 이미 갖고 있다. 이 사실을 `root-doc-maintenance.md`에 명시한다.

R1의 합격선(42 KiB)과 root 예산(50 KiB)이 다른 것은 의도적이다: 42는 *이번 슬라이스의 수용 기준*, 50은 *상시 게이트*다.

### 3.4 구조 분리

**상태줄 3부 구조** (`**상태:` 시작 유지 — R4):
1. 현재 단계 한 마디(MVP1 + post-MVP1 영역 요약)
2. `최신 = <slug> (<날짜>, 머지 <sha>) — 상세는 docs/build-log.md`
3. 포인터 꼬리(build-log / roadmap-status / roadmap / ADR / specs / plans)

기능 카탈로그는 build-log가 단일 소스이므로 root에서 제거한다. 1.2 KiB 예산이 이 구조를 기계적으로 강제한다.

**`docs/dev/root-doc-maintenance.md` 신설** — 다섯 가지:
1. splice 함정 4건(Python 스플라이스 필요성 / imbalance-vs-HEAD 검증 / 앵커 구분자 char-identity / end_anchor 꼬리 오염)
2. 예산표와 근거(§3.3) + 두 스크립트 사용법 + manifest 작성법
3. **이관 판단 기준**: ① 완료 기록 → 안전 ② 명확한 활동 트리거가 있는 함정 → 안전 ③ 편집-트리거 함정 → 인라인 유지(Move D 거절 선례)
4. 재분배 절차(manifest → 이관 → 축약 → `just doc-coverage` → `just doc-budget`)
5. **ADR 상태 갱신 규칙**(R14 재발 방지): 결정이 구현되면 **ADR 파일의 Status를 갱신**한다. 구현 상태를 root 인덱스 줄에 덧붙이지 않는다 — 그렇게 쌓인 것이 §1.6의 0039·0044 모순이다

3번이 이 파일의 두 번째 목적이다 — 지금 이 기준은 레포 밖 메모리 파일에만 있어서, 그 메모리를 회상하지 못한 세션은 기준 없이 재분배한다.

### 3.5 회귀 테스트 4층

| 층 | 겨누는 실패 | 수단 | 수명 |
|---|---|---|---|
| L1 | 포인터·앵커 파손(옮겼는데 못 찾음) | `check-doc-budget.sh` 내장(R9) | 영구 |
| L2 | 지식 소실(옮겼다고 적었지만 실은 안 옮김) | `check-doc-coverage.sh`: manifest 목적지-지향(1차) + 토큰 차분(2차) | 영구 |
| L3 | 게이트 자체가 공허(항상 통과) | **두 스크립트 모두** 고의 회귀→RED→원복→GREEN (R11) | 1회, build-log 기록 |
| L4 | 불변식 미검증(파일은 맞지만 소비자가 못 찾음) | fresh subagent 회상 프로브 + 양성 대조 (R12) | 1회, build-log 기록 |

**L4 프로토콜**: 컨텍스트 없는 fresh subagent(`Explore` 타입 충분)에게 제거된 지식을 묻고, repo만 보고 근거 경로와 함께 답하는지 본다. 프로브 ≥4문항 + **양성 대조 1문항**(레포에 존재하지 않는 사실 — "모름"이 나와야 프로브가 유효함이 증명된다). 대조가 통과해버리면 프로브 설계가 잘못된 것이므로 프로브를 고쳐 다시 돌린다. **프로브 1문항은 US4를 겨눈다**(리뷰 C6): "root CLAUDE.md가 다시 커졌을 때 무엇을 어디로 옮겨야 하나?" → `docs/dev/root-doc-maintenance.md`의 3분류에 도달해야 한다.

**L2가 못 보는 것**: 토큰은 남기고 *의미*를 버리는 압축(요약하다 뉘앙스 소실)은 manifest도 토큰 검사도 잡지 못한다. 이 한계는 최종 리뷰(base 대비 규칙 줄 단위 대조)에 위임한다.

## 4. 비목표

- `MEMORY.md` 재구성 — 별도 스킬·한도 보유. 예산·L1 검사 대상도 아님
- 도메인 CLAUDE.md(ui 116 KB 등) **내용** 압축 — 예산 등록만 한다
- 로컬 dev 실행 함정·검증 자동화 섹션 이동 — 편집/실행 트리거 함정이라 Move D 거절 선례와 같은 클래스(§5 예비 레버로만, 그것도 사용자 확인 후)
- **ADR 파일 전면 수정** — 단 R14가 요구하는 **0039·0044의 상태 한 줄 갱신은 범위 안**이다(리뷰 C2: 초안의 "ADR 파일 수정 금지"는 no-forget 불변식과 정면 충돌했다)
- pre-commit 훅 편입 — 함정 한 줄 추가가 커밋을 막는 마찰을 피한다(사용자 선택)
- 새 임계값 정책 발명 — 기존 값을 채택하되, 이미 초과된 값(controller)만 근거를 밝히고 갱신한다

## 5. 예비 레버 (R13 — R1 미달 시 순서대로)

1. **검증 자동화 §"매 커밋 일상 규칙" ①–⑤ 축약**(~1 KB): 상세는 이미 `docs/dev/commit-gates-and-git-workflow.md`에 있다
2. **사용자에게 판단 요청** — 아래 레버 3은 선행 결정이 보호하는 범주를 건드리므로 자동 발동하지 않는다 (리뷰 C3)
3. **로컬 dev 실행 함정의 최장 불릿 3건 서사 이동**(L106 2,543 B·L102 1,630 B·L108 1,591 B = 5,764 B → 서사만 옮기면 ~5 KB 확보. 초안의 "~1.5 KB"는 과소평가였다 — 리뷰 FR4). 규칙 한 줄은 반드시 root 유지. **L106을 건드리면 `.claude/skills/curl-verify/SKILL.md:12`의 섹션명 참조를 함께 갱신**해야 한다

레버 3이 레버 2(사용자 확인) 뒤에 오는 것은 의도적이다: 편집-트리거 함정 이동은 Move D 거절의 대상 범주이므로 자동 판단으로 넘지 않는다.

## 6. 위험과 완화

| 위험 | 완화 |
|---|---|
| 헤드룸 1,902 B — 압축이 예상보다 덜 됨 | §5 예비 레버(레버 3만으로 ~5 KB 확보 가능) |
| 서사 이관 누락(삭제만 하고 기입 안 함) — **가장 가능성 높은 실패** | R3 + R16 manifest 목적지-지향 검증 + R11의 L122 RED 시나리오 |
| 포인터가 *틀린 답*을 돌려줌(ADR 신선도) | R14 선행 + `root-doc-maintenance.md` §5 규칙으로 재발 차단 |
| 상태줄 형식 변경으로 finish-slice grep 파손 | R4 + L1(`^\*\*상태:` 정확히 1건) |
| 섹션명 변경으로 스킬 5곳 참조 파손 | §1.6 표의 섹션명을 전부 유지. 레버 3 발동 시 curl-verify 갱신 |
| 예산 스크립트가 항상 통과하는 공허한 게이트 | R11 이빨 실증(양 스크립트) |
| 예산 게이트가 day-1 WARN으로 노이즈화 | R5의 "도입 시점 WARN 0건" 요구 + §3.3 갱신 |
| L4 프로브가 공허(전부 통과) | 양성 대조 1문항 |
| 압축 과정에서 규칙의 *의미*가 바뀜 | L2의 명시적 한계 — 최종 리뷰가 base 대비 줄 단위 대조 |
| 이 diff에 자동 게이트가 없음 | §1.7 + R15 로컬 양방향 실행 |

## 7. 수용 기준

| US | 검증 |
|---|---|
| US1 | `wc -c CLAUDE.md` ≤ **43,008** · L1 전 항목 통과 · L2 manifest 4검사 + 토큰 차분 통과 |
| US2 | root Subagent dispatch 섹션의 **모든 불릿 ≤ 250 B**(기계 검사 — 초안의 "각 규칙이 1줄"은 오늘 이미 참이라 공허했다, 리뷰 C4) · 섹션 총합 ≤ 6.0 KiB · §1.4의 9개 토큰이 `docs/dev/subagent-dispatch.md`에서 grep 히트(현재 전부 0) |
| US3 | `just doc-budget` 표 출력 + **WARN 0건** + L3 RED/GREEN 실증 · `finish-slice` §4에 스텝 존재 |
| US4 | `docs/dev/root-doc-maintenance.md`에 이관 기준 3분류 + ADR 상태 갱신 규칙 존재 · `just doc-coverage <base>` 재실행 가능 · **L4 프로브 중 US4 문항이 그 문서에 도달** |
| 전체 | L4 프로브 ≥4문항 정답 도달 + 양성 대조 "모름" · R14 완료(0039·0044·0047) |

## 8. 태스크 순서 (plan에 대한 제약)

리뷰 권고를 채택한다 — **재분배 먼저, 도구 나중**. 단 `check-doc-coverage.sh`와 manifest는 이동을 *검증*하므로 이동보다 앞선다. 절단이 나도 US1(42 KiB)과 그 증거가 남는 순서다:

1. R14(ADR 신선도) → 2. manifest + coverage 스크립트(+L122 RED 실증) → 3. 이동 #2·#3(이관 먼저, 축약 나중) → 4. 이동 #1·#4 → 5. budget 스크립트 + `just` + `finish-slice` wiring → 6. `root-doc-maintenance.md` 완성 → 7. L3·L4 증명

## 9. 열린 질문

없음. 사용자 확정 4건(범위=압축+재비대 방지 / 강제력=기계적 측정+구조 분리, pre-commit 차단 기각 / 목표 ~42–45 KB / US1 합격선 42 KiB) + 리뷰 1차 must-fix 7건·nice-to-have 6건 전건 반영(기각 0).
