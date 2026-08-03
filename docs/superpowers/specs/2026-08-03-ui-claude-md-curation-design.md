# ui/CLAUDE.md 큐레이션 — 서사 압축·이관 + 도메인 절대-임계값 WARN (설계)

- 유형: internal-polish · 날짜: 2026-08-03
- 선례: claude-md-redistribute(`docs/superpowers/specs/2026-07-30-claude-md-redistribute-design.md`, 머지 `74b4cd9d`) — 같은 "규칙 잔류·서사 이관" 패턴의 root판. 절차 정본: `docs/dev/root-doc-maintenance.md`.
- 결정 한 줄: ui/CLAUDE.md(119,111 B)를 **규칙은 auto-load에 남기고 이력 꼬리만 이관**해 ≤ 96 KiB로 압축하고, 이동 검증(`check-doc-coverage.py`)을 **소스-파일 파라미터화**로 일반화하며, 예산 게이트(`check-doc-budget.py`)에 **문서화된 절대-임계값 WARN**을 추가한다. 추가 중첩 분할은 하지 않는다(§8 기각 근거).

## 사용자 스토리 (US)

- **US1**: 개발자-도구가 `ui/` 파일을 건드리는 세션을 시작할 때, ui/CLAUDE.md **119,111 B**가 통째로 로드되는데 그중 상당량이 이미 해결·회귀가드 완료된 사건의 postmortem 서사다(3대 섹션이 91 KB: 테스트 인프라 39 + 빌드 게이트 28 + 폼 UX 24) — 성공하면 살아있는 규칙·함정은 한 줄씩 auto-load에 그대로 남은 채 파일이 **≤ 96 KiB(98,304 B, −17.5%)**로 줄어 있다(목표치는 spec §1의 불릿별 실측 후 더 조일 수 있음 — redistribute 선례 −25.1%).
- **US2**: 개발자-도구가 다음 세션에서 이관된 사건의 전말(예: flake 사가의 CI-재현 조건·MutationObserver 실측)이 필요할 때, 지금은 그것이 ui/CLAUDE.md 안에만 있다 — 성공하면 **이관 서사 전건이 on-demand 정본 파일에 실재**하고(redistribute US2의 "거기 실재" 검증 동형 — 이동만·삭제 금지), ui/CLAUDE.md에 남은 규칙 줄의 포인터를 따라가면 도달된다.
- **US3**: 개발자-도구가 `/finish-slice`에서 `just doc-budget`을 돌릴 때, ui/CLAUDE.md가 자체 문서화 임계값 **~120 KB에 사실상 도달(119.1 KB)**했는데도 게이트는 OK만 출력한다(성장 래칫은 baseline+10 KiB=126 KB에야 WARN — 문서화 임계값과 어긋남) — 성공하면 **도메인 파일별 절대-임계값 WARN**이 표·판정에 나타나고(임계값은 각 파일 유지 규칙 노트의 문서화 값을 인코딩), 압축 후 **BASELINES 하향**으로 이득이 고정돼 재비대 시 래칫이 다시 문다.

> US1의 "postmortem 서사" 표현은 초안 승인 후 실측(§1)에서 정밀화됐다: 소재의 실제 형태는 "죽은 서사 덩어리"가 아니라 **살아있는 규칙 불릿에 엉킨 이력 꼬리**(발견 경위·정정-위에-정정·선례 서사)다. US1의 성공 조건(≤ 96 KiB · 규칙 잔류)은 그대로다.

## 1. 측정 — claims ledger (전부 워크트리 base `f870cfd9`에서 실측)

| 주장 | 명령 | 결과 |
|---|---|---|
| 전체 크기 | `wc -c ui/CLAUDE.md` | 119,111 B |
| 섹션 구조: `##` 8개, `###` 0개 | `grep -c '^## ' ui/CLAUDE.md` · `grep -c '^### ' ui/CLAUDE.md` | 8 · 0 |
| 불릿 145개 | `grep -c '^- ' ui/CLAUDE.md` | 145 |
| 섹션별 불릿 합계 | `awk '/^## /{sec=substr($0,4)} /^- /{n[sec]++; b[sec]+=length($0)+1} END{for(s in n) print s, n[s], b[s]}' ui/CLAUDE.md` | 아래 표 |
| 1,500 B 초과 XL 불릿 8개(합 18,314 B) | `awk '/^- /{sz=length($0)+1; if(sz>1500) print sz, NR}' ui/CLAUDE.md` | line 31·76·79·99·102·103·149·159 |
| superseded/정정 마커 | `grep -n '이제 틀림\|SUPERSEDED\|해체됨\|뒤집힘\|해소됨\|대체됐' ui/CLAUDE.md` + 건수는 패턴별 python 전수 카운트(BSD `grep -o` 멀티바이트 오답 회피) | **4건/3줄** (39=이제 틀림·뒤집힘, 101=해체됨, 149=해소됨) |
| 기존 하위 분할(2026-07-07) 실존 | `find ui -name CLAUDE.md \| xargs wc -c` | `components/scenario` 47,205 · `compare` 11,596 · `components/ui` 11,168 · `components/report` 9,753 B |

압축 대상 4개 섹션(그 외 4개 섹션은 이번 슬라이스에서 **불변**):

| 섹션 | 불릿 | 합계 B | 최대 불릿 B |
|---|---|---|---|
| 오프라인(CSP) · 테스트 인프라 | 44 | 36,463 | 3,388 |
| 빌드·타입 게이트 | 36 | 28,021 | 2,311 |
| 폼·입력 UX / 진단 표시 | 30 | 23,825 | 1,919 |
| 다단계 ramp UI | 10 | 12,036 | 4,038 |
| **계** | **120** | **100,345** | — |

목표 산술: −20,807 B 필요 = 대상 섹션의 ~20.7%. 조달 경로 = XL 8개 수술(~−9 KB) + superseded 정정 누적 3곳 현행-진실화(~−2 KB) + 나머지 불릿 이력 꼬리 절제(평균 ~−90 B × ~110개 ≈ −10 KB). **단 세 버킷은 겹친다**(line 149는 XL이자 superseded, 39·101은 2·3버킷 이중 소속) — additive 합산 금지, slack ~0.2 KB뿐이므로 **plan의 불릿별 manifest가 버킷 합산이 아니라 불릿별 실측 절감으로 이 산술을 행 단위로 증명해야 하며, 기준(§2)을 지키고도 96 KiB에 못 미치면 그 시점 실측을 들고 사용자에게 목표 재협상을 보고한다(무리한 삭제로 채우지 않는다).**

## 2. 불릿 수술 기준 — 무엇이 남고 무엇이 이관되나 (no-forget 불변식)

`docs/dev/root-doc-maintenance.md` §이관 기준 3분류를 불릿 *내부*에 적용한다. 이 슬라이스에서 옮기는 것은 전부 분류 ①(완료 기록·이력)이고, 분류 ③(편집-트리거 함정의 현행 규칙)은 **한 글자도 파일 밖으로 나가지 않는다**.

**남는다 (auto-load 잔류, 불릿당 1줄 유지):**
- 함정의 현행 진술(무엇이 어떻게 깨지나) + 현행 처방(어떻게 피하나/고치나)
- load-bearing 기술 디테일(예: `useThinkTimePair`의 `!== null`이 load-bearing이라는 사실, lockstep 대상 파일:줄)
- 출처 태그 `(Slice N / 기능명)` — 기존 규약 유지

**이관된다 (`docs/dev/ui-gotcha-narratives.md`로):**
- 발견 경위 서사("~에서 관측", "리뷰가 적발", 라운드 전개, 실측 로그 전문)
- superseded 중간 상태("당시엔 X였는데 Y로 뒤집힘"의 X쪽 전개 — 잔류 불릿은 **현행 진실만** 서술)
- 동형 사례 나열의 2번째 이후 상세(패턴 확립 후 "N번째 검증" 꼬리 — 잔류는 "패턴 + 적용 사이트 목록"으로 압축)

**금지:**
- 불릿(규칙) 자체 삭제 — 병합은 manifest `merge` 행으로만(R17 바닥 회계)
- 대상 4개 섹션 밖 편집(오탈자 포함 — diff 리뷰 표면 최소화). **유일 예외 = §3의 상단 유지 규칙 노트 1줄 추가**(섹션 도입부 포인터는 대상 섹션 *안*이라 예외 불요)
- 문서화 임계값·유지 규칙 노트의 의미 변경(위 예외의 포인터 1줄 추가만 허용)

## 3. 목적지·포인터 규약

- 목적지 = **새 파일 `docs/dev/ui-gotcha-narratives.md`** 단일. ui/CLAUDE.md의 4개 섹션명을 미러링한 `##` 아래 이관 항목별 `###`. `docs/dev/*.md`는 coverage 토큰-차분 corpus에 이미 포함된다(`check-doc-coverage.py::corpus_paths`).
- 포인터는 **대상 섹션당 1줄**(불릿별 아님): 섹션 도입부에 `> 이 섹션 함정들의 발견 경위·정정 이력·실측 전문 → docs/dev/ui-gotcha-narratives.md §<섹션> (키워드: …)` — 정본 규약대로 **옮긴 토픽 키워드를 나열**해 grep 발견성을 보존한다.
- ui/CLAUDE.md 상단에 목적지 파일 포인터 1줄 추가 — 삽입 지점은 **유지 규칙 노트 blockquote(`ui/CLAUDE.md:9`) 단일**("별도 docs로 빼고 포인터만" 규약이 사는 곳). line 7의 하위 도메인 문서 목록 blockquote가 아니다.

## 4. 게이트 변경 (scripts 2개)

### 4.1 `check-doc-coverage.py` — 소스-파일 파라미터화 (root 하드코딩 해제)

현행은 `ROOT = "CLAUDE.md"` 고정 + R17 섹션 리스트가 root 전용이라 ui 이관을 검증할 수 없다. 변경:

- CLI: `check-doc-coverage.py <base> [source_file]` (기본 `CLAUDE.md` — **기존 호출 하위호환**). `Justfile`(tracked 이름 대문자 — macOS 대소문자 함정): 기본값을 **`doc-coverage BASE="f870cfd9" FILE="ui/CLAUDE.md"`로 갱신** — 활성 manifest(ui 행)의 base를 인코딩해 bare `just doc-coverage`가 참인 green 검사로 남는다(redistribute 선례: 현 기본 `17369d32` = 그 슬라이스의 base. 기본값을 안 바꾸면 활성 manifest 전 행이 옛 base에서 보장 FAIL — 정본 "행은 자기 base에서만 참").
- manifest `move`/`merge`의 anchor·marker 검사와 토큰-차분의 기준을 `source_file`로 치환. manifest 형식(5컬럼)·rename 절차는 불변 — **한 manifest = 한 소스 파일**(이번 활성 manifest는 ui 행만).
- R17(불릿 비감소): 섹션 리스트를 고정 상수 대신 **base `source_file`의 `## ` 헤딩에서 동적 도출**. base에 있던 섹션이 작업트리에서 사라지면 FAIL(섹션 rename은 이 슬라이스 비목표). root로 돌릴 때도 동적 도출이 기존 2섹션을 포함하므로 보호 약화 없음 — 오히려 root 전 섹션으로 확대.
- R18(baseline 인상 차단)은 소스 무관 그대로. **이번 슬라이스 base(`f870cfd9`)에는 `check-doc-budget.py`가 존재하므로 R18이 이 레포 역사상 처음 무장된다**(정본 §baseline 재설정 규칙의 "다음 재분배 슬라이스" = 바로 이번).

### 4.2 `check-doc-budget.py` — 절대-임계값 WARN + BASELINES 하향

- `ABS_WARN = {"ui/CLAUDE.md": 122880, "crates/engine/CLAUDE.md": 61440}` 신설 — **파일 상단 유지 규칙 노트에 숫자가 문서화된 파일만** 인코딩한다(ui "~120KB"=`ui/CLAUDE.md:9`, engine "~60KB"=`crates/engine/CLAUDE.md:7`). controller·worker-core·deploy·desktop은 문서화 값이 없어 **의도적으로 제외**(래칫이 커버; controller 절대값 결정은 controller 큐레이션 슬라이스로 연기 — §7). 초과 시 WARN(성장 래칫과 동일 비차단 축 — "성장은 경고" 비대칭 설계 유지), 표에 `현재/임계값` 행 상시 출력. `BASELINES_MIN` 동형의 하한(`ABS_WARN_MIN = 2`)으로 dict 비우기 무력화를 막는다.
- `BASELINES["ui/CLAUDE.md"]`를 압축 후 실측값으로 **하향**(이득 고정 — 재비대 시 래칫이 새 기준에서 문다). 인하는 R18 스코프 밖(인상만 차단)이므로 충돌 없음. 다른 파일 baseline 불변.
- **US3 서사와 기제의 관계를 명확히 해 둔다**: US3의 고통("119.1 KB인데 OK만")을 직접 해소하는 것은 **압축 + BASELINES 하향**이다 — ABS_WARN 자체는 현재 크기(119,111 B = 122,880 B의 96.9%)에서 발화하지 않는 **재비대 최종 백스톱**이고, US3의 관찰 조건("근접도가 보인다")은 표의 상시 행(현재/임계값·사용률)이 채운다. 재비대의 조기 신호는 하향된 baseline의 래칫(+10 KiB ≈ 106 KiB 부근)이 절대 임계값(120 KiB)보다 **먼저** 문다.

## 5. 검증 계획 — 게이트 두 상태 + 이빨 실증

| 검증 | baseline(변경 전 — 실패/부재 신호) | 변경 후(통과 신호) |
|---|---|---|
| coverage 파라미터화 | `python3 scripts/check-doc-coverage.py f870cfd9 ui/CLAUDE.md` → 현행 스크립트는 인자 무시·root 검사(ui 미검증임을 확인) | 동일 명령이 ui manifest 행 전부에 ①~⑤ + R17(ui 8섹션) + 토큰-차분 green |
| coverage 하위호환 | — | **green 실행으로 증명할 수 없다**(활성 manifest가 ui 스코프인데 root 실행은 "행은 자기 base에서만 참" 규약상 무의미 — 정본 §재분배 절차 1). 대신 ① 인자 생략 시 `source_file` 기본값이 `CLAUDE.md`임을 코드로 확인 ② root 스코프 기능 자체는 파라미터화 diff가 R17 동적 도출 외 root 경로를 안 바꿈을 diff 리뷰로 확인(다음 root 재분배가 자기 manifest·자기 base로 무변경 사용) |
| ABS_WARN 이빨 | 작업트리에서 임계값을 현재 크기 미만으로 임시 하향 → **지정 WARN 문구를 grep으로 확인**(RED — WARN은 exit 0이므로 종료코드로 판정 금지, 정본 §게이트를 고칠 때) → 원복(GREEN) | `just doc-budget` green + 표에 ABS 행 2개 상시 표시 |
| ABS_WARN 하한 이빨 | `ABS_WARN` dict를 임시로 비움 → `FAIL [절대]`(하한 미달) 확인(FAIL은 exit 1 — 종료코드 판정 가) → 원복 | 상동 |
| **지식-가드 이빨(회귀 방지, 사용자 지시 2026-08-03)** | 축약 완료 상태에서 ① ui 잔류 불릿 1개 임시 삭제 → `just doc-coverage` `FAIL [R17]` 확인 ② 목적지 marker 1개 임시 훼손 → `FAIL [move] marker 없음` 확인 ③ 잔류 규칙의 backtick 토큰 1개 임시 삭제 → `FAIL [토큰] 소실` 확인 — **토큰 선정 조건**: 삭제 전 사전 grep으로 ⓐ ui/CLAUDE.md 내 유일(2회 이상이면 set-diff에 안 잡혀 항상 GREEN) ⓑ corpus 전 경로(`corpus_paths()` — 이 슬라이스가 신설하는 narratives 파일 **포함**)·allowlist 0건임을 확인한 토큰만 사용(아니면 공허-이빨) → 각각 원복 | 3종 모두 원복 후 `just doc-coverage` green — 지식-회귀 방어선 자체의 이빨이 실증됨 |
| 크기 목표 | `wc -c ui/CLAUDE.md` = 119,111 B | ≤ 98,304 B |
| 지식 보존 | — | manifest 전 행 marker 실재 + R17 바닥 + 토큰-차분 0소실 + **이관 불릿 무작위 3개 육안 대조**(규칙 잔류분만으로 함정 회피 가능한지 사람 판정) |
| 상태줄·root | root CLAUDE.md는 이 슬라이스에서 **불변**(상태줄 교체는 finish-slice 단계) | `just doc-budget` root 축 green 유지 |

라이브 검증(`/live-verify`): **생략** — production diff 0(docs + scripts). 근거를 build-log에 기록(파이프라인 5단계 규정 준수).

## 6. 파이프라인 메모

- 구현은 `superpowers:subagent-driven-development`, task 분할 초안: T1 게이트 2종(4.1+4.2 ABS_WARN — 이빨 실증 포함) → T2 manifest 작성+목적지 기입(정본 §재분배 절차 1·2) → T3 ui/CLAUDE.md 축약(§절차 3) → T4 검증 일괄(§절차 4·5) + BASELINES 하향. 순서는 정본 고정 순서(이관이 압축보다 먼저)를 따른다.
- 커밋은 전부 docs/scripts 경로라 pre-commit fast-path(cargo·UI 게이트 무관). tdd-guard: `.rs`/`ui/src` 무편집이라 비발동. `spec-review-guard`: plan `REVIEW-GATE: APPROVED` 후 진행(어차피 src 무편집이지만 절차 준수).
- **manifest rename 절차 주의**(정본 §재분배 절차 1): 현 활성 `scripts/doc-move-manifest.tsv`(redistribute의 14행)를 `scripts/doc-move-manifest-claude-md-redistribute.tsv`로 rename 후 ui 행만 새로 작성. base는 이번 슬라이스 base(`f870cfd9`).

## 7. 비목표 (이번 슬라이스에서 하지 않는 것)

- controller/engine 등 다른 도메인 CLAUDE.md 큐레이션(controller는 래칫 +4,137 B로 아직 여유 — WARN 시 후속 슬라이스, Move D 기각 경계 그때 정밀화)
- root CLAUDE.md 재분배(WARN선까지 781 B — 자체 게이트·정본 절차가 커버)
- ui/CLAUDE.md 추가 중첩 분할·`ui/src/components/` 소스 재배치(§8)
- 대상 4개 섹션 밖 ui/CLAUDE.md 편집(§2의 유일 예외 = 상단 노트 포인터 1줄), 섹션 rename, 유지 규칙 노트의 의미 변경

## 8. 검토 기각 — "더 세분화"를 하지 않는 이유 (2026-08-03 사용자 검토 요청·A안 승인)

중첩 분할은 2026-07-07에 이미 실행됐고(4개 하위 도메인, 당시 143 KB→분리), 남은 119 KB의 3대 섹션은 ① 테스트 인프라 — 테스트 파일이 `ui/src` 전역 `__tests__` 19곳에 흩어져 어느 단일 디렉토리도 트리거를 포착 못 함, ② 빌드·타입 게이트 — 전 TS 파일 크로스커팅, ③ 폼 UX — 해당 소스가 `ui/src/components/`에 flat(전용 하위 디렉토리 없음, `ui/CLAUDE.md:7`에 문서화)이라 소스 이동이 선행돼야 함. 즉 세분화가 닿는 소재가 아니다. 소스 재배치를 전제한 분할(C안)은 24 KB를 위해 209파일 디렉토리를 흔드는 비용이라 기각.
