# root CLAUDE.md 재분배 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 매 프롬프트 로드되는 root `CLAUDE.md`를 54,720 B → 41,106 B로 줄이되 지식은 하나도 잃지 않고, 재비대를 기계로 잡는 게이트를 남긴다.

**Architecture:** 이동 4건(상태줄 카탈로그·subagent 서사·splice 함정·ADR 인덱스)을 각 목적지로 옮기고, 그 이동을 **manifest로 선언 → 스크립트로 검증**한다. 재발 방지는 root 절대 예산 + 도메인 성장 래칫 두 축이며, `/finish-slice`가 매번 실행한다.

**Tech Stack:** Python 3(스크립트 2종) · `just`(레시피) · git plumbing(`git show <ref>:<path>`) · Markdown

**설계 정본:** `docs/superpowers/specs/2026-07-30-claude-md-redistribute-design.md` (5라운드 리뷰 후 clean APPROVE). 이 계획의 R-id·§ 참조는 전부 그 문서를 가리킨다.

**plan 리뷰 이력:** 1차 `APPROVE-WITH-FIXES` — must-fix 6건(fixture 크래시로 이빨 실증 3건 전부 도달 불가 · R13 무주공산 · build-log 증거 기록 없음 · `min_dest_gain_bytes` 공유 목적지에서 무력 · `warns`가 blocking인데 라벨은 WARN + allowlist 채우는 지시 없음 · `section_of` 미명세 + L1 RED 실증 없음) + nice 7건 전건 반영. **Task 3을 이관/압축으로 분할**(리뷰의 선택 제안 채택 — R3 "삭제 전 이관"이 중간 상태에서 문자 그대로 성립한다).

## Global Constraints

모든 task의 요구사항에 암묵적으로 포함된다. 값은 spec에서 verbatim 복사.

- **단위**: 문서·구현의 `KB`는 전부 **KiB(1024 B)**. 42 KB = 43,008 B · 50 KB = 51,200 B · 1.2 KB = 1,229 B · 10 KB = 10,240 B · 6 KB = 6,144 B.
- **base 커밋**: `17369d32`. 모든 "base 대비" 비교의 기준. 스크립트 인자로 넘긴다.
- **바이트 측정 규약**: 줄 바이트 = `len(line.encode("utf-8")) + 1`(개행 포함). 섹션 바이트 = 그 줄들의 합. **이 규약을 벗어나면 섹션 합계가 13 B 흔들린다**(spec §7 US2).
- **불릿 판정 규약**: 불릿 = `- `로 시작하는 줄. `알아둘 결정들`도 `- **`가 아니라 **`- `로 센다**(오늘은 둘 다 49로 같지만, 향후 비-bold 불릿이 생기면 갈린다).
- **최종 크기**: root `CLAUDE.md` ≤ **43,008 B**(합격선), 목표 착지 ~41,106 B.
- **불릿 상한**: `## Subagent dispatch 노하우` 섹션의 **모든** 불릿 ≤ **250 B**, 섹션 총합 ≤ **6,144 B**.
- **ADR 인덱스 상한**: `## 알아둘 결정들`의 축약 대상 13줄은 **줄당 ≤ 170 B**.
- **상태줄**: `**상태:` 로 시작하는 **단일 라인** 유지(`.claude/skills/finish-slice/SKILL.md:47`의 `grep -n '^\*\*상태:' CLAUDE.md`가 여기 의존) · ≤ **1,229 B** · 3부 구조(현재 단계 / `최신 = <slug> (<날짜>, 머지 <sha>)` / 포인터 꼬리).
- **root 예산**: 51,200 B 초과 시 `exit 1`, ≥90%(46,080 B) WARN.
- **도메인 래칫**: `현재 − baseline > 10,240 B` → WARN(`exit 0`). 절대 상한 없음.
- **섹션명 불변**: `로컬 dev 실행 함정`·`Subagent dispatch 노하우`·`알아둘 결정들`·`로컬에서 curl로 직접 구동` 및 문구 `coverage≠correctness`는 외부 소비자 6곳이 참조한다(spec §1.6 표) — **바꾸지 말 것**.
- **spec 대비 의도적 이탈 1건**: spec §3.2는 `.sh`를 지정하지만 이 계획은 **`.py`로 구현**한다. 근거: ① spec §3.2가 실제로 요구한 규약은 "레포 스크립트 + `just` 레시피 + 로컬 실행 가능"이지 bash 자체가 아니다 ② 검사 내용이 UTF-8 바이트 산술·집합 연산·유니코드 정규식이라 파이썬이 자연스럽다 ③ 이 레포는 root 상태줄 splice 등 문서 조작에 이미 python3에 의존한다. **`just` 레시피 이름은 spec대로 `doc-coverage`·`doc-budget` 유지**.
- **spec 대비 의도적 이탈 2건째 (additive)**: spec §3.2·§7 US1은 `move` 행 **4검사**를 말하지만 이 계획은 **⑤(`required_marker` 신규성)를 더한다** — `min_gain>0` 행의 marker가 `at(base, dest_file)`에 이미 있으면 아무것도 안 옮기고 ③④를 통과할 수 있다. spec §9가 명시한 클래스("새 예외를 만들 때마다 그 선언 자체는 무엇이 검증하나")를 `required_marker`에 자기적용한 것이고, `absorbed_marker` 유일성 규칙의 대칭이다. **spec §7 US1의 "4검사"는 이 항목으로 읽는다**(강화 방향이라 수용 기준을 낮추지 않는다).
- **이 슬라이스에는 자동 게이트가 없다**(spec §1.7, 리뷰가 훅 정규식으로 재확인): `tdd-guard.sh:26-30`은 `/crates/.+/src/.+\.rs$`·`/ui/src/.+\.(ts|tsx|js|jsx)$`에만, `spec-review-guard.sh`도 같은 두 패턴에만 걸리고 그 외엔 `exit 0`. 이 계획의 task별 첫 편집 대상(`docs/adr/*.md`·`scripts/*.py`·`docs/dev/*.md`·`CLAUDE.md`)은 **어디에도 매치하지 않는다** — 차단 지점 없음. 따라서 각 task의 "테스트"는 **스크립트를 통과/실패 양방향으로 실제 실행**하는 것이며(`scripts/check-release-versions.sh` 선례), 그 출력이 acceptance다.
- **RED은 의도한 FAIL 줄이어야 한다**: 크래시(traceback)도 `exit 1`을 낸다. **종료코드만 보고 "RED 실증 완료"라고 기록하지 말 것** — 지정된 `FAIL [...]` 문구가 출력에 있어야 한다.
- **`Justfile` 들여쓰기는 스페이스 4칸**(탭 아님, 기존 파일과 동일).
- **커밋 규칙**: `git commit`에 파이프 금지(exit code 마스킹, git-guard가 deny) · `--no-verify` 금지 · `git add` 후 `git diff --cached --name-only`로 스테이징 확인.

## 공유 정본 (매 brief에 첨부)

`task-brief`는 해당 task 섹션만 잘라내므로, 아래 두 블록은 **별도로 추출해 매 brief에 byte-exact로 동봉**한다:

1. spec의 `## 사용자 스토리 (US)` 블록 전체(US 스파인, ADR-0048)
2. 이 문서의 `## Global Constraints` 절 전체

## File Structure

| 파일 | 책임 | 생성/수정 |
|---|---|---|
| `CLAUDE.md` | 매 프롬프트 로드되는 전역 규칙·상태·인덱스 | 수정(4개 영역) |
| `docs/adr/0039-windows-desktop-distribution.md` | 단일 exe 배포 결정 + **현재 구현 상태** | 수정(헤더) |
| `docs/adr/0044-editor-outline-not-canvas.md` | 에디터 아웃라인 결정 + **절 단위 해소 표시** | 수정(헤더 + 본문 2줄) |
| `docs/dev/subagent-dispatch.md` | subagent 디스패치 **사고 서사 정본** | 수정(서사 9건 수용) |
| `docs/dev/root-doc-maintenance.md` | **신설** — splice 기법·이관 기준·예산 근거·재분배 절차·ADR 상태 규약 | 생성 |
| `docs/build-log.md` | 슬라이스별 구현 이력 + **이 슬라이스의 RED/GREEN·프로브 증거** | 수정 |
| `scripts/doc-move-manifest.tsv` | 이동 선언(R16) — R3의 기계적 표현 | 생성 |
| `scripts/doc-coverage-allowlist.txt` | 토큰 차분의 의도적 삭제 예외(R10) | 생성 |
| `scripts/check-doc-coverage.py` | 이동 검증: manifest + 개수 비감소 + baseline 조건 + 토큰 차분 | 생성 |
| `scripts/check-doc-budget.py` | 상시 게이트: root 절대 예산 + 상태줄 + L1 링크/앵커 + 도메인 래칫 | 생성 |
| `Justfile` | `doc-coverage`·`doc-budget` 레시피 | 수정 |
| `.claude/skills/finish-slice/SKILL.md` | 마무리 체크리스트에 예산 확인 스텝 | 수정(§4) |

---

### Task 1: ADR 신선도 해소 (R14) — 이동 #4의 선행 조건

**Files:**
- Modify: `docs/adr/0039-windows-desktop-distribution.md:3`
- Modify: `docs/adr/0044-editor-outline-not-canvas.md` (헤더 Status + 본문 `:19`, `:29`)
- Modify: `CLAUDE.md` (ADR-0047 인덱스 줄의 `store` → `worker`)

**Interfaces:**
- Consumes: 없음(첫 task)
- Produces: Task 7이 ADR 인덱스 13줄을 축약해도 포인터가 *틀린 답*을 반환하지 않는 상태.

**왜 이게 먼저인가:** root 인덱스가 최신 사실을 갖고 ADR 파일이 낡았다. 순서를 뒤집으면 축약이 유일한 정확한 기록을 지운다(spec §1.6).

- [ ] **Step 1: 현재 모순을 실행으로 확인 (RED 상태 기록)**

```bash
sed -n '3p' docs/adr/0039-windows-desktop-distribution.md
grep -c "bundle\|byte-identical\|0040" docs/adr/0039-windows-desktop-distribution.md
grep -n "re-parent" docs/adr/0044-editor-outline-not-canvas.md
grep -c "editor-reparent-dnd" docs/adr/0044-editor-outline-not-canvas.md
grep -n "0047" CLAUDE.md | grep -c "store"
```

Expected: 0039 Status = `accepted (방향 확정 — 구현은 roadmap 후보, 미착수)` · grep `0` · 0044 `:19`,`:29`에 "연기" · `editor-reparent-dnd` `0` · root 0047에 `store` `1`

- [ ] **Step 2: 0039 Status를 3요소 페이로드로 교체**

페이로드 3요소 = 구현 상태 + 머지 sha + build-log 포인터.

```markdown
- Status: accepted · **옵션 A(단일 self-contained exe) 구현·머지 완료** — cargo `bundle` feature off이면 byte-identical, 서명/인스톨러는 후속. 상세 → `docs/build-log.md`의 single-exe 단락. 옵션 B(Tauri 래퍼)는 [ADR-0040](0040-tauri-desktop-wrapper.md) → [ADR-0042](0042-tauri-in-process-controller.md)로 이어짐.
```

머지 sha는 `grep -n "single-exe\|단일 self-contained" docs/build-log.md`로 찾아 실제 값을 넣는다. **추측 금지** — 못 찾으면 그 사실을 리포트에 적고 sha 없이 포인터만 남긴다.

- [ ] **Step 3: 0044 헤더 Status 갱신 + 본문 2줄에 인라인 주석**

헤더(`- Status:` 줄)에 절 단위 해소를 명시하고, 본문 문장은 **다시 쓰지 말고 괄호 주석만** 덧붙인다(ADR 본문 = 결정 시점 기록, spec §3.4 ⑤).

`:19` 끝의 `(슬라이스 3 연기)`를 아래로:

```markdown
(슬라이스 3 연기 — → 2026-07-02 `editor-reparent-dnd`로 해소, `docs/build-log.md:207`)
```

`:29`의 `**컨테이너 경계 넘는 드래그/re-parent(슬라이스 3)**` 뒤에 같은 형식의 주석을 단다.

- [ ] **Step 4: root의 ADR-0047 줄 오기 정정**

`proto/store/migration 0-diff` → `proto·worker·migration 0-diff` (`docs/adr/0047-…md:25`가 정본).

- [ ] **Step 5: 해소 검증 (GREEN)**

```bash
grep -c "구현·머지 완료" docs/adr/0039-windows-desktop-distribution.md    # 1
grep -c "editor-reparent-dnd" docs/adr/0044-editor-outline-not-canvas.md  # 3 (헤더+본문2)
sed -n '19p;29p' docs/adr/0044-editor-outline-not-canvas.md | grep -c "해소"   # 2 ← 배치 확인
grep -n "0047" CLAUDE.md | grep -c "worker"                              # 1
grep -n "0047" CLAUDE.md | grep -c "store"                               # 0
```

3번째 명령이 **배치**를 검증한다 — 단순 `grep -c "해소"`는 파일 어디에 있어도 통과하므로 이빨이 없다.

- [ ] **Step 6: 커밋**

```bash
git add docs/adr/0039-windows-desktop-distribution.md docs/adr/0044-editor-outline-not-canvas.md CLAUDE.md
git diff --cached --name-only
git commit -m "docs(adr): 0039·0044 신선도 해소 + root 0047 오기 정정 (R14)"
```

---

### Task 2: 이동 검증 스크립트 + manifest 스키마 (R6·R16·R17·R18)

**Files:**
- Create: `scripts/check-doc-coverage.py`, `scripts/doc-move-manifest.tsv`, `scripts/doc-coverage-allowlist.txt`
- Modify: `Justfile`
- Test: 합성 fixture(`/tmp/doc-cov-fixture/`)로 3 시나리오 양방향 실행

**Interfaces:**
- Consumes: 없음
- Produces:
  - `python3 scripts/check-doc-coverage.py <base-ref>` — 위반 시 `exit 1`, 통과 시 `exit 0`
  - manifest TSV 스키마(아래) — Task 4–7이 행을 추가한다
  - `just doc-coverage` (기본 base-ref `17369d32`)

**manifest 스키마** (`scripts/doc-move-manifest.tsv`, 탭 구분, `#`으로 시작하는 줄은 주석):

```
# kind	source_anchor	dest_file	required_marker	min_dest_gain_bytes
```

- `kind` = `move` | `merge`
- **`move` 행 검사 ①–④**: ① `source_anchor`가 base root에 존재 ② 현재 root에 부재 ③ `required_marker`(`|` 구분 다항)가 **`dest_file` 안에** 전부 존재 ④ **`dest_file`별로 그 파일을 목적지로 둔 행들의 `min_dest_gain_bytes` 합계**와 그 파일의 실제 바이트 증가를 **1회 비교**
- **`move` 행 검사 ⑤(marker 신규성)**: `min_dest_gain_bytes > 0`인 행은 `required_marker`가 **`at(base, dest_file)`에 없어야** 한다. 있으면 `FAIL [move] marker가 base 목적지에 이미 존재 — 이 이동을 증명하지 못한다`. 이게 없으면 "우연히 목적지에 이미 있던 문구"를 marker로 골라 아무것도 안 옮기고 ③을 통과할 수 있다(`absorbed_marker` 유일성 규칙의 대칭). **`min_gain=0` 행(Task 6)은 제외** — 목적지에 내용이 선재하는 것이 그 행의 전제이고, 대신 표본 다항 marker에 의존한다.
- **`merge` 행**은 컬럼 의미가 다르다: `source_anchor`=`absorbed_marker`, `dest_file`=`-`, `required_marker`=`surviving_anchor`, `min_dest_gain_bytes`=`0`. 검사 ⓐ `absorbed_marker`가 base root에 **정확히 1회** ⓑ 현재 root에서 `surviving_anchor`를 포함하는 불릿이 `absorbed_marker`도 포함

**④를 누적으로 하는 이유:** Task 4가 추가하는 9행이 전부 `docs/dev/subagent-dispatch.md`를 목적지로 둔다(Task 3은 정본에 기입만 하고 manifest 행은 만들지 않는다). 행별 비교면 *하나만* 크게 옮겨도 나머지 8행이 같은 총증가분을 보고 통과한다 — 검사 ④가 아무 일도 안 하면서 커버된 듯한 착시를 준다(리뷰 지적). 누적 비교는 "선언한 합만큼은 실제로 늘었다"를 보증한다. 그래도 **행 단위 실체는 ③이 담당**한다는 점을 manifest 주석에 적어 둔다.

- [ ] **Step 1: fixture를 실제 구조와 같게 만든다**

**fixture는 root의 구조를 흉내내야 한다** — `## ` 섹션 2개 + 그 아래 불릿, 그리고 스크립트가 읽는 두 파일. (초안 fixture는 `## ` 헤딩이 없어 `bullets()`가 `ValueError`로 죽었고, 그 크래시도 `exit 1`이라 세 시나리오가 전부 "통과한 것처럼" 보였다.)

```bash
rm -rf /tmp/doc-cov-fixture && mkdir -p /tmp/doc-cov-fixture/{docs/dev,scripts}
cd /tmp/doc-cov-fixture && git init -q
cat > CLAUDE.md <<'EOF'
# T

## Subagent dispatch 노하우

- RULE_A 서사 조각 alpha
- RULE_B 서사 조각 beta
- RULE_C 서사 조각 gamma

## 알아둘 결정들

- D1 결정 하나
- D2 결정 둘
EOF
printf '# dest\n' > docs/dev/d.md
printf '# kind\tsource_anchor\tdest_file\trequired_marker\tmin_dest_gain_bytes\n' > scripts/doc-move-manifest.tsv
printf '# token\t# 근거\n' > scripts/doc-coverage-allowlist.txt
git add -A && git commit -qm base && git rev-parse --short HEAD    # = $FIX_BASE
```

**호출 규약**: 스크립트의 모든 읽기는 **CWD 상대**다. fixture 실행은 `cd /tmp/doc-cov-fixture && python3 <레포절대경로>/scripts/check-doc-coverage.py $FIX_BASE` 형태로 한다.

fixture 불릿에는 backtick·`docs/*.md`·`ADR-dddd`가 **하나도 없다** — 의도적이다. `tokens()`가 공집합이라 시나리오 ②가 토큰 차분이 아니라 **R17에만** 걸린다(검사 격리).

- [ ] **Step 2: 스크립트 작성**

```python
#!/usr/bin/env python3
"""이동 검증: manifest(+merge) + 불릿 개수 비감소(R17) + baseline 조건(R18) + 토큰 차분."""
import re, subprocess, sys, pathlib, glob
from collections import defaultdict

ROOT = "CLAUDE.md"
SECTIONS = ["Subagent dispatch 노하우", "알아둘 결정들"]
BUDGET = "scripts/check-doc-budget.py"

def at(ref, path):
    r = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None      # 없으면 None (R18 신규 행 판정)

def section_span(text, section):
    """'## <section>' 헤딩부터 다음 '## '(또는 EOF)까지. 없으면 None."""
    key = "## " + section
    i = text.find(key)
    if i < 0:
        return None
    j = text.find("\n## ", i + 1)
    return text[i:j if j > 0 else len(text)]

def bullets(text, section):
    body = section_span(text, section)
    return [] if body is None else [l for l in body.split("\n") if l.startswith("- ")]

def section_of(text, needle):
    """needle을 포함하는 불릿이 속한 SECTIONS 원소. 못 찾으면 None."""
    for s in SECTIONS:
        if any(needle in l for l in bullets(text, s)):
            return s
    return None

def tokens(t):
    s = set(re.findall(r"`([^`\n]{2,80})`", t))
    s |= set(re.findall(r"docs/[A-Za-z0-9/_.-]+\.md", t))
    s |= set(re.findall(r"ADR-\d{4}", t))
    return s

def corpus_paths():
    # 리터럴 경로는 전부 .exists()로 감싼다 — glob은 자체 가드가 되지만 리터럴은 아니다.
    # (비대칭으로 두면 부분 체크아웃·fixture에서 FileNotFoundError로 죽고, 그 크래시도
    #  exit 1이라 "RED 실증 완료"로 오기록된다 — 이 스크립트가 막으려는 바로 그 실패다.)
    lits = ["docs/build-log.md", "ui/CLAUDE.md", "deploy/CLAUDE.md", "desktop/CLAUDE.md"]
    return ([p for p in lits if pathlib.Path(p).exists()]
            + sorted(glob.glob("docs/dev/*.md")) + sorted(glob.glob("docs/adr/*.md"))
            + sorted(glob.glob("crates/*/CLAUDE.md")))

def rows():
    p = pathlib.Path("scripts/doc-move-manifest.tsv")
    if not p.exists():
        return []
    out = []
    for l in p.read_text().split("\n"):
        if l.strip() and not l.startswith("#"):
            out.append(l.split("\t"))
    return out

def main(base):
    fails = []
    base_root = at(base, ROOT)
    if base_root is None:
        print(f"FAIL [setup] {base}:{ROOT} 를 읽을 수 없다"); return 1
    cur_root = pathlib.Path(ROOT).read_text()

    gain_need, merged_floor = defaultdict(int), defaultdict(int)

    for kind, anchor, dest, marker, gain in rows():
        if kind == "move":
            if anchor not in base_root:
                fails.append(f"FAIL [move] base root에 anchor 없음: {anchor[:50]}")
            if anchor in cur_root:
                fails.append(f"FAIL [move] root에 anchor 잔존(미제거): {anchor[:50]}")
            dp = pathlib.Path(dest)
            if not dp.exists():
                fails.append(f"FAIL [move] dest_file 없음: {dest}"); continue
            dtext = dp.read_text()
            base_dest = at(base, dest) or ""
            for m in marker.split("|"):
                if m not in dtext:
                    fails.append(f"FAIL [move] {dest}에 marker 없음: {m[:50]}")
                elif int(gain) > 0 and m in base_dest:      # ⑤ marker 신규성
                    fails.append(f"FAIL [move] marker가 base 목적지에 이미 존재 — "
                                 f"이 이동을 증명하지 못한다: {m[:50]}")
            gain_need[dest] += int(gain)
        elif kind == "merge":
            n = base_root.count(anchor)
            if n != 1:
                fails.append(f"FAIL [merge] absorbed_marker가 base에 {n}회(1이어야 함): {anchor[:50]}")
            surv = [l for l in cur_root.split("\n") if l.startswith("- ") and marker in l]
            if not surv:
                fails.append(f"FAIL [merge] surviving_anchor 불릿 없음: {marker[:50]}")
            elif anchor not in surv[0]:
                fails.append(f"FAIL [merge] 병합 미확인 — 삭제만 했는가: {anchor[:50]}")
            else:
                sec = section_of(cur_root, marker)
                if sec: merged_floor[sec] += 1
        else:
            fails.append(f"FAIL [manifest] 알 수 없는 kind: {kind}")

    for dest, need in gain_need.items():                       # ④ 누적 비교
        got = len(pathlib.Path(dest).read_text().encode()) - len((at(base, dest) or "").encode())
        if got < need:
            fails.append(f"FAIL [move] {dest} 증가 {got} B < 선언 합계 {need} B")

    for sec in SECTIONS:                                       # R17
        b, c = len(bullets(base_root, sec)), len(bullets(cur_root, sec))
        floor = b - merged_floor[sec]
        if c < floor:
            fails.append(f"FAIL [R17] '{sec}' 불릿 {b}→{c} (허용 바닥 {floor})")

    # R18: 양쪽 ref에 존재하는 baseline 행만
    base_budget, cur_budget = at(base, BUDGET), (pathlib.Path(BUDGET).read_text()
                                                 if pathlib.Path(BUDGET).exists() else None)
    if base_budget and cur_budget:
        for f, bb in parse_baselines(base_budget).items():
            cb = parse_baselines(cur_budget).get(f)
            if cb is None or cb <= bb:
                continue                                        # 삭제·유지·인하는 스코프 밖
            if len(pathlib.Path(f).read_text().encode()) >= len((at(base, f) or "").encode()):
                fails.append(f"FAIL [R18] {f} baseline {bb}→{cb} 인상인데 파일이 줄지 않았다")

    # 토큰 차분 (3차 방어선) — 위반이면 blocking
    allow = {l.split("\t")[0] for l in pathlib.Path("scripts/doc-coverage-allowlist.txt")
             .read_text().split("\n") if l.strip() and not l.startswith("#")}
    corpus = "".join(pathlib.Path(p).read_text() for p in corpus_paths())
    for t in sorted(tokens(base_root) - tokens(cur_root)):
        if t not in corpus and t not in allow:
            fails.append(f"FAIL [토큰] 소실(목적지 어디에도 없음): {t[:60]}")

    for f in fails: print(f)
    print(f"\n{'FAIL' if fails else 'OK'}: manifest {len(rows())}행 · R17 {SECTIONS}")
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "17369d32"))
```

`parse_baselines(text)` = `check-doc-budget.py` 소스에서 baseline dict를 뽑는 함수. Task 8이 그 파일을 만들 때 **`BASELINES = {` … `}` 한 블록**으로 두기로 하고, 여기서는 그 블록을 `re.findall(r'"([^"]+)":\s*(\d+)', block)`로 파싱한다. 양쪽 ref 중 한쪽에라도 파일이 없으면(=도입 커밋) 검사를 통째로 건너뛴다.

**모든 진단은 `FAIL [...]` 접두로 통일한다** — 초안은 토큰 소실을 `WARN`으로 찍으면서 `exit 1`을 냈다(라벨과 동작 불일치).

**이 스켈레톤은 orchestrator가 fixture에서 실제로 돌려봤다**(2026-07-30). 확인한 것과 그 명령: fixture baseline → `OK`/`exit=0` · 시나리오 ① RED → 예측한 정확히 2줄, R17 미발화 · ① GREEN → `OK`/`exit=0` · **검사 ⑤** → 목적지를 200 B 늘려 ④를 통과시키고 ③도 통과하는 상태에서 `FAIL [move] marker가 base 목적지에 이미 존재`가 발화. 구현자는 이 결과를 **신뢰하지 말고 Step 3–5에서 다시 돌려라** — 여기 적힌 것은 "이 코드가 그 시점에 그렇게 동작했다"이지 "네 트리에서도 그렇다"가 아니다.

- [ ] **Step 3: 시나리오 ① — 목적지 기입 없이 압축하면 RED**

**불릿을 지우지 말고 제자리 압축한다** — 실제 Task 4가 하는 일이 압축(불릿 27개 유지)이고, 삭제하면 R17이 영구히 걸려 **GREEN에 도달할 수 없다**(리뷰가 실행으로 확인).

```
- RULE_A 서사 조각 alpha   →   - RULE_A 규칙만
manifest: move<TAB>RULE_A 서사 조각 alpha<TAB>docs/dev/d.md<TAB>alpha 서사<TAB>100
```

Expected(RED): 정확히 두 줄 — **`FAIL [move] docs/dev/d.md에 marker 없음: alpha 서사`** 과 **`FAIL [move] docs/dev/d.md 증가 0 B < 선언 합계 100 B`** · `exit=1`. R17은 걸리지 않는다(개수 3 유지 = 검사 격리). *traceback이면 실패다 — 스크립트를 고치고 다시.*

그 다음 `docs/dev/d.md`에 `alpha 서사`를 포함한 본문(≥100 B)을 써 넣고 재실행 → **`OK: manifest 1행 …`** + `exit=0`.

- [ ] **Step 4: 시나리오 ② — manifest 행째로 없어도 RED**

fixture를 base 상태로 되돌리고 `RULE_B` 불릿만 지운다. **manifest 행은 만들지 않는다.**

Expected: **`FAIL [R17] 'Subagent dispatch 노하우' 불릿 3→2 (허용 바닥 3)`** + `exit=1`. 이 시나리오가 통과해버리면 R17이 동작하지 않는 것이다.

- [ ] **Step 5: 시나리오 ③ — merge 선언 후 삭제만 하면 RED**

fixture를 base로 되돌리고 `RULE_C` 불릿을 지운 뒤 `merge	RULE_C 서사 조각 gamma	-	RULE_A	0` 을 넣고 실행.

Expected(RED): **`FAIL [merge] 병합 미확인 — 삭제만 했는가: RULE_C 서사 조각 gamma`** + **`FAIL [R17] … 불릿 3→2 (허용 바닥 3)`** + `exit=1`.

**R17이 함께 뜨는 것이 정상이다** — 선언만 하고 수행하지 않은 merge는 바닥을 낮춰주면 안 되고, `merged_floor`는 병합이 *확인된* `else` 분기에서만 증가하므로 그렇게 동작한다. 이 줄을 예상 못 하면 멀쩡한 스크립트를 디버깅하게 된다.

그 다음 `RULE_A` 불릿 끝에 `RULE_C 서사 조각 gamma`를 실제로 흡수시키고 재실행 → `OK` + `exit=0`(바닥이 2로 내려간다).

- [ ] **Step 6: 시나리오 ④ — root에서 안 지웠으면 RED (검사 ②)**

시나리오 ①–③은 ③④⑤·R17·merge를 덮지만 검사 ②(`source_anchor`가 현재 root에 부재)는 아직 미실증이다. fixture를 base로 되돌리고 **root는 그대로 둔 채** `docs/dev/d.md`에 본문을 쓰고 `move` 행을 선언한다.

Expected: **`FAIL [move] root에 anchor 잔존(미제거): RULE_A 서사 조각 alpha`** + `exit=1`(단일 FAIL). "옮겼다고 선언했는데 root에서 안 지움" = 중복이 남는 실패를 겨눈다.

- [ ] **Step 7: 레포에 초기 파일 + Justfile 레시피**

manifest는 주석 헤더만, allowlist는 형식 주석만 두고 시작한다(행은 Task 4–7이 추가).

```makefile
doc-coverage BASE="17369d32":
    python3 scripts/check-doc-coverage.py {{BASE}}
```

- [ ] **Step 8: 실제 트리에서 확인**

```bash
just doc-coverage; echo "exit=$?"
```

Expected: manifest 0행이므로 move/merge는 공집합, R17은 `27`/`49` 그대로, 토큰 소실 0 → `OK` + `exit=0`.

- [ ] **Step 9: 커밋**

```bash
git add scripts/check-doc-coverage.py scripts/doc-move-manifest.tsv scripts/doc-coverage-allowlist.txt Justfile
git diff --cached --name-only
git commit -m "feat(docs): 이동 검증 스크립트 + manifest 스키마 (R6·R16·R17·R18)"
```

---

### Task 3: 서사 9건을 정본으로 이관 (R3 — root 무변경)

**Files:**
- Modify: `docs/dev/subagent-dispatch.md`

**Interfaces:**
- Consumes: 없음(Task 2와 독립)
- Produces: 정본에 서사 9건이 실재하는 상태. Task 4가 root를 압축할 수 있는 전제.

**이 task는 root를 건드리지 않는다.** 끝나면 서사가 **양쪽에 다 존재**한다 — R3("삭제 전 이관")가 문자 그대로 성립하는 중간 상태이고, 여기서 절단돼도 잃는 것이 없다.

**대상 불릿 9건** (base 기준 줄번호 / 바이트):

| 줄 | B | 주제 |
|---|---:|---|
| L121 | 877 | plan이 지정한 테스트도 공허할 수 있다 |
| L122 | 765 | plan의 *사실 주장*도 검증 대상 |
| L123 | 1,060 | plan은 훅에 대해서도 실행 가능해야 |
| L124 | 382 | 줄번호는 `grep -n`으로만 확정 |
| L134 | 688 | 두 단계 review + 모델 라우팅 |
| L136 | 453 | 리뷰-수정 루프 |
| L138 | 481 | finding을 뒤 task로 접기 |
| L139 | 1,265 | 리뷰 finding의 사실 주장도 가설 |
| L146 | 1,090 | orchestrator의 "내가 검증했다"도 가설 |

- [ ] **Step 1: 이관 전 상태 확인 (RED)**

```bash
for t in think-time-dashboard thinkboard-defaults Object.is "충돌 표" tdd-guard.sh:92 "sed -n" mb-2 getBoundingClientRect is-ancestor; do
  printf "%-24s %s\n" "$t" "$(grep -c -- "$t" docs/dev/subagent-dispatch.md)"
done
```

Expected: **전부 `0`**.

- [ ] **Step 2: 서사를 정본에 원문 그대로 옮긴다**

`docs/dev/subagent-dispatch.md`의 기존 절 구조(`## brief/plan 작성` 등)에 맞춰 배치한다. **요약하지 말 것** — 정본은 서사를 담는 곳이고, root가 규칙만 갖게 되면 여기가 유일한 근거다.

- [ ] **Step 3: 이관 확인 (GREEN)**

Step 1의 명령을 재실행. Expected: **9개 전부 ≥1**. 추가로 `wc -c docs/dev/subagent-dispatch.md`가 base(16,239 B) 대비 **+5,000 B 이상**이어야 한다(서사 9건 합 7,061 B의 70%).

**이 acceptance의 한계 — 리뷰가 반드시 볼 것**: 토큰 존재 + 바이트 증가는 *원문 이관*과 *토큰만 남긴 요약*을 구별하지 못한다(spec §3.5가 인정하고 리뷰에 위임한 바로 그 한계). 따라서 이 task의 code-quality 리뷰는 **base의 불릿 9건과 정본에 들어간 텍스트를 줄 단위로 대조**하는 것을 명시적 acceptance로 삼는다 — 요약됐으면 finding이다.

- [ ] **Step 4: 커밋**

```bash
git add docs/dev/subagent-dispatch.md
git diff --cached --name-only
git commit -m "docs(dev): subagent dispatch 서사 9건을 정본에 기입 (R3 — root는 다음 task에서)"
```

---

### Task 4: root Subagent 섹션 압축 (US2)

**Files:**
- Modify: `CLAUDE.md` (`## Subagent dispatch 노하우`)
- Modify: `scripts/doc-move-manifest.tsv`, 필요 시 `scripts/doc-coverage-allowlist.txt`

**Interfaces:**
- Consumes: Task 2(`just doc-coverage`), Task 3(정본 기입 완료)
- Produces: 섹션 10,980 B → ≤6,144 B, 불릿 27개 유지

- [ ] **Step 1: 압축 전 크기 확인**

```bash
python3 -c "
t=open('CLAUDE.md').read(); i=t.index('## Subagent dispatch 노하우'); j=t.find('\n## ',i+1); s=t[i:j]
bl=[l for l in s.split('\n') if l.startswith('- ')]
print('불릿',len(bl),'· 섹션',sum(len(l.encode())+1 for l in s.split('\n')),'B · 250B초과',len([l for l in bl if len(l.encode())+1>250]))"
```

Expected: `불릿 27 · 섹션 10980 B · 250B초과 13`

- [ ] **Step 2: 각 불릿을 ≤250 B로 압축**

**규칙 자체는 지우지 않는다** — 근거·수치·사례만 정본으로 보내고, 끝에 정본 포인터를 남긴다. 섹션 머리말의 기존 포인터 문장을 손봐 쓰고 **새 줄을 늘리지 않는다**(여유 144 B).

- [ ] **Step 3: 크기·개수 확인**

Step 1의 명령 재실행. Expected: `불릿 27` · `섹션 ≤6144` · `250B초과 0`.

- [ ] **Step 4: manifest 행 추가**

9건 각각에 `move` 행. `source_anchor`는 삭제된 서사에서 딴 조각(현재 root에 없어야 함), `required_marker`는 정본에 들어간 조각, `min_dest_gain_bytes`는 그 서사 크기의 70%.

**`min_dest_gain_bytes`는 `dest_file`별 누적 하한이다** — 9행 합계가 `docs/dev/subagent-dispatch.md`의 실제 증가분과 1회 비교된다. 개별 값이 다소 후해도 무해하고(④가 그만큼 약한 집합 주장이 될 뿐), 행 단위 실체는 ③이 담당한다.

**`required_marker` 고르는 법 (검사 ⑤ 때문에 중요)**: **base 정본에 없는** 충분히 긴 조각을 골라야 한다 — ⑤가 "base 목적지에 이미 존재"를 거부한다. 넣기 전에 확인:

```bash
git show 17369d32:docs/dev/subagent-dispatch.md | grep -c '<marker 후보>'   # 0 이어야 함
```

**L136은 특히 주의**: 자연스러운 후보인 `유한 valve`가 base 정본 `:17`에 이미 있고, **그 줄이 같은 주제("리뷰-수정 루프")를 이미 다룬다**(orchestrator가 9건 전수 스캔 — 충돌은 이 1건뿐). 즉 L136 자료의 일부는 이미 정본에 있으므로, marker는 **이번에 새로 들어간 문장**에서 따라. 짧은 일반 문구는 우연히 이미 있을 수 있다.

- [ ] **Step 5: 검증 — 토큰 소실이 뜨면 allowlist에 근거를 적는다**

```bash
just doc-coverage; echo "exit=$?"
```

`FAIL [토큰] 소실`이 뜨면 **그 토큰이 정말 어디에도 없는지 먼저 확인**하고, 의도적 삭제가 맞으면 `scripts/doc-coverage-allowlist.txt`에 `<토큰><TAB># 근거` 한 줄을 추가한다. **검사를 약화시키지 말 것** — allowlist 항목은 리뷰 대상이다. 최종 Expected: `OK` + `exit=0`.

- [ ] **Step 6: 커밋**

```bash
git add CLAUDE.md scripts/doc-move-manifest.tsv scripts/doc-coverage-allowlist.txt
git diff --cached --name-only
git commit -m "docs: root Subagent 섹션을 규칙 한 줄로 압축 (US2)"
```

---

### Task 5: 이동 #3 — splice 함정 → `root-doc-maintenance.md` 신설 (US4 1/2)

**Files:**
- Create: `docs/dev/root-doc-maintenance.md`
- Modify: `CLAUDE.md` (`## 슬라이스/기능을 완료하면`), `scripts/doc-move-manifest.tsv`

**Interfaces:**
- Consumes: Task 2
- Produces: `docs/dev/root-doc-maintenance.md` — Task 8이 예산 근거를, Task 9가 절차를 덧붙인다. 섹션 4,163 B → ~1,536 B.

- [ ] **Step 1: 신설 문서에 splice 함정 4건 이관 (root보다 먼저)**

root의 4개 중첩 불릿(482·579·715·1,000 B)을 **원문 그대로** 옮긴다: Python 스플라이스 필요성 / imbalance-vs-HEAD 검증 / 앵커 구분자 char-identity / `end_anchor` 꼬리 오염.

- [ ] **Step 2: 이관 기준 3분류 + ADR 상태 갱신 규약 (신규 집필)**

이건 이관이 아니라 **새로 쓰는 것**이다 — 지금 이 기준은 레포 밖 메모리 파일에만 있다.

이관 기준: ① 완료 기록 → 안전 ② 명확한 활동 트리거가 있는 함정 → 안전(예: Playwright→`/live-verify`) ③ 편집-트리거 함정 → **인라인 유지**(Move D 거절 선례).

ADR 상태 갱신 규약: 문서 전체 상태 변화 → 헤더 Status만(선례 `0040`·`0027`) / 절 단위 변화 → 헤더 + 그 문장 인라인 주석(`0044`형) / **본문 문장 재작성 금지**(결정 시점 기록).

- [ ] **Step 3: root 섹션 압축 + 포인터**

4개 중첩 불릿을 지우고 한 줄 포인터로 대체한다. 나머지 규칙 불릿(구현 결과는 build-log로 / 상태줄 한 줄 교체 / ADR 한 줄 / 재비대 신호)은 **유지**한다.

- [ ] **Step 4: 검증**

```bash
python3 -c "
t=open('CLAUDE.md').read(); i=t.index('## 슬라이스/기능을 완료하면'); j=t.find('\n## ',i+1)
print('섹션', sum(len(l.encode())+1 for l in t[i:j if j>0 else len(t)].split('\n')), 'B')"
grep -c "imbalance\|char-identity\|end_anchor" docs/dev/root-doc-maintenance.md
just doc-coverage; echo "exit=$?"
```

Expected: 섹션 ~1,536 B · grep ≥3 · `OK` + `exit=0`. (토큰 소실 시 Task 4 Step 5와 동일 절차.)

- [ ] **Step 5: 커밋**

```bash
git add CLAUDE.md docs/dev/root-doc-maintenance.md scripts/doc-move-manifest.tsv scripts/doc-coverage-allowlist.txt
git diff --cached --name-only
git commit -m "docs: splice 함정 + 이관 기준 + ADR 상태 규약을 root-doc-maintenance로 (US4)"
```

---

### Task 6: 이동 #1 — 상태줄 3부 구조 (R4)

**Files:**
- Modify: `CLAUDE.md` line 7, `scripts/doc-move-manifest.tsv`

**Interfaces:**
- Consumes: Task 2
- Produces: 상태줄 5,028 B → ~980 B, `**상태:` 시작 형식 유지

- [ ] **Step 1: 카탈로그 내용이 build-log에 있는지 먼저 확인**

카탈로그에서 기능명 표본 6개를 뽑아 `grep -c`로 `docs/build-log.md` 존재를 확인한다. **하나라도 없으면 그 항목을 build-log에 먼저 append**한 뒤 진행한다(R3).

- [ ] **Step 2: line 7을 Python 스플라이스로 교체**

Edit 툴의 정확매치는 2 KB+ `old_string`을 재현하기 어려워 깨지기 쉽다(줄 자체는 `Read offset=7 limit=1`로 읽힌다). 그래서 `s.index()` 기반 스플라이스를 쓴다. 앵커의 구분자(`·` U+00B7 · `—` U+2014 · `→` U+2192)는 **파일에서 추출해** 쓴다 — 타이핑한 리터럴이 다른 코드포인트일 수 있다. `assert count == 1`.

새 구조 3부: 현재 단계 한 마디(머리 332 B 유지) + `최신 = release-hygiene (2026-07-30, 머지 6c80592) — 상세는 docs/build-log.md` + 포인터 꼬리(557 B 유지).

- [ ] **Step 3: 교체 결과를 육안 재독**

```bash
python3 -c "print(open('CLAUDE.md').read().split('\n')[6])"
sed -n '7p' CLAUDE.md | wc -c        # ≤ 1230
grep -c '^\*\*상태:' CLAUDE.md        # 정확히 1
```

**새 문장 전체를 읽어** old 전용 내용이 섞이지 않았는지 본다(`end_anchor` 꼬리 오염 함정 — 이 함정은 `assert count==1`을 통과하면서도 결과를 오염시킨다).

- [ ] **Step 4: manifest 행 + 검증**

`move` 행 하나. `required_marker`는 **표본 다항**(카탈로그 항목 5–8개 + release-hygiene 조각을 `|`로), `dest_file` = `docs/build-log.md`, `min_dest_gain_bytes` = `0`(이미 존재 — 이 행은 ③ marker 검사가 유일한 실질 방어선이다).

```bash
just doc-coverage; echo "exit=$?"
```

**이 task는 토큰 FAIL이 뜨는 것이 정상이다** — 리뷰가 실측한 결과 이동 4건 중 **카탈로그·최신 문단만** 코퍼스에 없는 토큰을 남긴다(ADR 인덱스 축약은 0건). 예상 4건:

| 토큰 | 근거(allowlist에 적을 것) |
|---|---|
| `gh release edit v0.6.0 --notes-file …` | build-log에 `notes-file` 2회 — 실체 보존 |
| `--is-ancestor c v0.6.0` | build-log에 `is-ancestor` 2회 + 메모리 토픽 파일 |
| `preflight → build×2 → publish` | build-log에 `preflight` 4회 |
| `[workspace.package] version="0.7.0"` | 정본이 `Cargo.toml`이고 코퍼스는 의도적으로 문서만 본다 |

각 토큰을 `scripts/doc-coverage-allowlist.txt`에 `<토큰><TAB># 근거`로 추가한다. **다른 토큰이 뜨면 그건 예상 밖이므로 먼저 실체를 확인**하고, 검사를 약화시키지 말 것. 최종 Expected: `OK` + `exit=0`.

- [ ] **Step 5: 커밋**

```bash
git add CLAUDE.md scripts/doc-move-manifest.tsv scripts/doc-coverage-allowlist.txt
git diff --cached --name-only
git commit -m "docs: 상태줄을 3부 구조로 압축, 카탈로그는 build-log 단일 소스 (R4)"
```

---

### Task 7: 이동 #4 — ADR 인덱스 13줄 축약 (R13 분기 포함)

**Files:**
- Modify: `CLAUDE.md` (`## 알아둘 결정들`), `scripts/doc-move-manifest.tsv`

**Interfaces:**
- Consumes: Task 1(신선도 해소 — **필수 선행**), Task 2
- Produces: 섹션 8,362 B → ~6,239 B, 불릿 49개 유지, **root ≤ 43,008 B 달성**

- [ ] **Step 1: 대상 13줄 확인**

```bash
python3 -c "
t=open('CLAUDE.md').read(); i=t.index('## 알아둘 결정들'); j=t.find('\n## ',i+1)
for l in t[i:j].split('\n'):
    if l.startswith('- ') and len(l.encode())+1>170: print(len(l.encode())+1, l[:40])"
```

- [ ] **Step 2: 각 줄을 ≤170 B로 축약**

형식 = `- **NNNN** 제목: 핵심 한 마디`. 구현 상태·수치·부속 결정은 ADR 파일이 갖는다(Task 1이 그 조건을 만들었다). **번호와 제목은 지우지 않는다** — 그게 "이 결정이 존재한다"는 유일한 in-context 신호다.

**0047 줄 주의**: Task 1 Step 4가 고친 `proto·worker·migration 0-diff` 구절은 축약 과정에서 **사라질 수 있고 그래도 된다**(ADR 파일이 정본). spec §7의 "0047 오기 정정"은 Task 1에서 이미 충족됐다.

- [ ] **Step 3: 검증**

```bash
python3 -c "
t=open('CLAUDE.md').read(); i=t.index('## 알아둘 결정들'); j=t.find('\n## ',i+1); s=t[i:j]
bl=[l for l in s.split('\n') if l.startswith('- ')]
print('불릿',len(bl),'· 섹션',sum(len(l.encode())+1 for l in s.split('\n')),'B · 170B초과',len([l for l in bl if len(l.encode())+1>170]))"
wc -c CLAUDE.md
just doc-coverage; echo "exit=$?"
```

Expected: 불릿 `49` · 섹션 ~`6239` B · 170 B 초과 `0` · **`wc -c` ≤ 43,008** · `OK` + `exit=0`.

- [ ] **Step 4: (R13) `wc -c`가 43,008을 넘으면 — 예비 레버 분기**

넘지 않으면 이 스텝은 건너뛴다. 넘으면 **순서대로**:

1. **레버 1 적용**: `## 검증 자동화`의 "매 커밋 일상 규칙 ①–⑤"를 축약(~1 KB). 상세는 이미 `docs/dev/commit-gates-and-git-workflow.md`에 있다. 적용 후 `wc -c` 재측정.
2. 그래도 초과면 **중단하고 orchestrator에 보고한다**. spec §5의 레버 2는 "사용자에게 판단 요청"이고 레버 3(로컬 dev 함정 서사 이동)은 **편집-트리거 함정 범주라 사용자 확인 없이 넘지 않는다**(Move D 거절 선례). implementer가 임의로 진행하지 말 것.
3. 레버를 썼으면 **어느 것을 왜 썼는지 리포트에 적는다** — Task 9가 build-log에 옮긴다.

- [ ] **Step 5: 커밋**

```bash
git add CLAUDE.md scripts/doc-move-manifest.tsv scripts/doc-coverage-allowlist.txt
git diff --cached --name-only
git commit -m "docs: ADR 인덱스 13줄을 규칙대로 한 줄로 (상세는 ADR 파일)"
```

---

### Task 8: 예산 게이트 + finish-slice wiring (R5·R8·R9)

**Files:**
- Create: `scripts/check-doc-budget.py`
- Modify: `Justfile`, `.claude/skills/finish-slice/SKILL.md`(§4), `docs/dev/root-doc-maintenance.md`

**Interfaces:**
- Consumes: Task 4–7 완료 후의 root 크기
- Produces: `just doc-budget` — root 초과 시 `exit 1`, 도메인 성장 시 WARN(`exit 0`). **`BASELINES = { … }` 블록**을 노출한다(Task 2의 `parse_baselines`가 이 형식을 읽는다)

- [ ] **Step 1: 스크립트 작성**

- **root 절대 예산**: `CLAUDE.md` ≤ 51,200 B(초과 `exit 1`), ≥46,080 B WARN
- **상태줄**: `^\*\*상태:` 매치가 정확히 1건이 아니면 FAIL, 그 줄 ≤ 1,229 B
- **L1**(R9): root의 backtick·markdown-link 양쪽 `.md` 참조 실존 + 내부 `#앵커`가 실제 헤딩과 매치. **사전 선언 예외 2건**: `MEMORY.md`(레포 밖), `2026-05-27-handicap-mvp1-design.md`(맨 파일명 — `docs/superpowers/specs/` 아래에서 해석)
- **도메인 래칫**: `BASELINES` dict(파일→바이트, Task 4–7 이후 실측값) 대비 `+10,240 B` 초과 시 WARN
- 출력: `파일 / 현재 / 기준 / 사용률 또는 성장` 표

```python
BASELINES = {                 # Task 4–7 완료 시점 실측값. 인상은 R18이 기계로 막는다.
    "ui/CLAUDE.md": 116129,
    "crates/controller/CLAUDE.md": 82481,
    "crates/engine/CLAUDE.md": 37057,
    "crates/worker-core/CLAUDE.md": 11388,
    "deploy/CLAUDE.md": 8594,
    "desktop/CLAUDE.md": 8101,
}
```

- [ ] **Step 2: 통과 실행 (GREEN)**

```bash
just doc-budget; echo "exit=$?"
```

Expected: 표 출력 · **WARN 0건** · `exit=0`. WARN이 뜨면 baseline이 잘못된 것이다(성장 0이어야 함).

- [ ] **Step 3: 이빨 실증 3건 — 각각 RED → 원복 GREEN**

```bash
cp CLAUDE.md /tmp/claude-md-backup
# ① root 예산
python3 -c "open('CLAUDE.md','a').write('x'*12000)"
just doc-budget; echo "exit=$?"        # FAIL(root 초과) + exit=1
cp /tmp/claude-md-backup CLAUDE.md && just doc-budget; echo "exit=$?"   # exit=0
# ② 상태줄 — line 7에 2000 B를 덧붙였다가 원복
# ③ L1 — root의 docs 포인터 하나를 존재하지 않는 경로로 바꿨다가 원복
```

**③(L1)을 반드시 포함한다** — root의 진짜 markdown 링크는 3개뿐이라, backtick 경로까지 검사하지 않으면 L1은 거의 아무것도 안 하는 검사가 된다. RED이 나야 그 검사가 실재함이 증명된다. 세 건 다 **지정된 FAIL 문구**를 확인할 것(크래시도 exit 1이다).

- [ ] **Step 4: Justfile + finish-slice 스텝**

```makefile
doc-budget:
    python3 scripts/check-doc-budget.py
```

`.claude/skills/finish-slice/SKILL.md` §4에 한 줄 추가:

```markdown
- **문서 예산 확인**: `just doc-budget` — root 초과면 재분배를 먼저(`docs/dev/root-doc-maintenance.md` 절차), WARN이면 다음 슬라이스에 예고
```

- [ ] **Step 5: 예산 근거를 root-doc-maintenance에 기록**

예산표 + 10 KiB 도출 규칙(실측 750~1,483 B/커밋 → 7–14 커밋 ≈ 한 분기) + **baseline 재설정 규칙**("파일을 실제 압축했을 때만, 인상은 커밋 diff로 드러나고 R18이 기계로 강제") + 비대칭(성장=경고 / 거짓 보고=오류) + `MEMORY.md` 제외 사유.

- [ ] **Step 6: 커밋**

```bash
git add scripts/check-doc-budget.py Justfile .claude/skills/finish-slice/SKILL.md docs/dev/root-doc-maintenance.md
git diff --cached --name-only
git commit -m "feat(docs): root 예산 + 도메인 성장 래칫 게이트, finish-slice 배선 (R5·R8·R9)"
```

---

### Task 9: 재분배 절차 + L4 회상 프로브 + 증거 기록 (R11·R12·R15·US4 2/2)

**Files:**
- Modify: `docs/dev/root-doc-maintenance.md`, `docs/build-log.md`

**Interfaces:**
- Consumes: Task 1–8 전부
- Produces: 수용 기준 전항 충족 + **증거의 영속화**. 이후는 `/finish-slice`.

- [ ] **Step 1: 재분배 절차 작성**

manifest 작성 → 목적지 기입 → root 축약 → `just doc-coverage <base>` → `just doc-budget` 순서와, 각 단계에서 무엇이 RED를 내는지.

- [ ] **Step 2: 프로브 5문항 (양성 대조 포함)**

제거된 지식 4문항 + **레포에 없는 사실 1문항**:
1. 커밋 게이트 출력을 `| tail`로 돌리면 무슨 일이 생기나?
2. 특정 커밋이 이번 릴리즈 구간 소속인지 어떻게 검사하나?(`--is-ancestor`의 함정)
3. root 상태줄을 교체할 때 `end_anchor`를 어떻게 잡아야 하나?
4. **(US4 결속)** root CLAUDE.md가 다시 커졌을 때 무엇을 어디로 옮겨야 하나? → `root-doc-maintenance.md`의 3분류에 도달해야 한다
5. **(양성 대조)** 레포에 존재하지 않는 사실 1건 → "모름"이 나와야 프로브가 유효

- [ ] **Step 3: fresh subagent로 실행**

컨텍스트 없는 subagent(`Explore` 타입)에게 문항을 주고 **repo만 보고** 근거 경로와 함께 답하게 한다. 대조 문항이 통과해버리면 프로브 설계가 잘못된 것이므로 고쳐 다시 돌린다.

- [ ] **Step 4: 수용 기준 전항 확인**

```bash
wc -c CLAUDE.md                      # ≤ 43008
just doc-budget; echo "exit=$?"      # WARN 0건, exit=0
just doc-coverage; echo "exit=$?"    # OK, exit=0
for t in think-time-dashboard thinkboard-defaults Object.is "충돌 표" tdd-guard.sh:92 "sed -n" mb-2 getBoundingClientRect is-ancestor; do
  printf "%-24s %s\n" "$t" "$(grep -c -- "$t" docs/dev/subagent-dispatch.md)"; done   # 전부 ≥1
```

- [ ] **Step 5: 증거를 build-log에 append (R11·R12·R15)**

`docs/build-log.md`에 이 슬라이스 단락을 append한다. **반드시 포함**: ① Task 2의 시나리오 ①②③ RED 문구와 원복 GREEN ② Task 8의 이빨 실증 3건(root·상태줄·L1) ③ L4 프로브 5문항 결과와 양성 대조가 실제로 "모름"을 냈다는 사실 ④ R13 레버를 썼다면 어느 것을 왜 ⑤ 크기 before/after. 이게 없으면 게이트에 이빨이 있다는 증거가 세션과 함께 사라진다. (`/finish-slice` §4는 이 단락이 이미 있으면 중복 append하지 않는다.)

- [ ] **Step 6: 커밋**

```bash
git add docs/dev/root-doc-maintenance.md docs/build-log.md
git diff --cached --name-only
git commit -m "docs: 재분배 절차 + L4 프로브 결과 + 게이트 이빨 증거 (R11·R12·R15)"
```

---

## Self-Review

**1. Spec coverage** (R-id를 plan 본문에 grep해 실제 수행 스텝을 확인) — R1 Task 7 Step 3·Task 9 Step 4 · R2 Task 3–7 · R3 **Task 3 전체(root 무변경 이관)**·Task 5 Step 1·Task 6 Step 1 · R4 Task 6 · R5 Task 8 · R6 Task 2 Step 2 · R7 Task 5+8+9 · R8 Task 8 Step 4 · R9 Task 8 Step 1+3③ · R10 Task 2 Step 7 생성 + **채우는 지시는 Task 4 Step 5(정본)·Task 5 Step 4(참조)·Task 6 Step 4(예상 4건 표 포함)** — Task 7은 실측상 소실 토큰이 0건이라 지시가 없는 것이 맞다(초안 Self-Review는 Task 6·7에 지시가 있다고 적었으나 거짓이었다. 리뷰 지적) · R11 **Task 2 Step 3–6 + Task 8 Step 3 + Task 9 Step 5(기록)** · R12 Task 9 Step 2–3 · **R13 Task 7 Step 4(명시 분기)** · R14 Task 1 · R15 **Task 2·8의 양방향 실행 + Task 9 Step 5 기록** · R16 Task 2 스키마 · R17 Task 2 Step 2(구현)·Step 4(실증) · R18 Task 2 Step 2(구현, `parse_baselines`)·Task 8 Step 1(`BASELINES` 형식 제공). **갭 없음.**

**2. Placeholder scan** — `parse_baselines`만 본문 정의 없이 남았으나, 파싱 대상 형식(`BASELINES = {…}`)을 Task 8 Step 1이 verbatim 제공하고 정규식까지 적었다. `section_of`·`corpus_paths`·`section_span`은 Step 2에 완전 구현돼 있다. Task 1 Step 2의 머지 sha는 "찾는 명령 + 못 찾을 때의 행동"까지 지정했다.

**3. Type consistency** — manifest 컬럼명(`kind`/`source_anchor`/`dest_file`/`required_marker`/`min_dest_gain_bytes`)이 Task 2 스키마와 Task 4·5·6·7 사용처에서 동일. `merge` 행의 컬럼 재해석은 Task 2에 1회만 정의. `just` 레시피명(`doc-coverage`·`doc-budget`)이 Task 2·8 정의와 Task 3–9 호출부에서 동일. 불릿 판정은 전 스텝이 `- `로 통일(Global Constraints).

## 실행 순서 근거

절단이 나도 US1과 그 증거가 남는 순서다(spec §8): 신선도(1) → 검증 도구+이빨 실증(2) → **이관(3, root 무변경 — 여기서 끊겨도 손실 0)** → 압축(4) → splice 이동(5) → 상태줄(6) → ADR 인덱스(7, 여기서 42 KiB 달성) → 상시 게이트(8) → 절차·프로브·증거(9).

<!-- REVIEW-GATE: APPROVED -->
