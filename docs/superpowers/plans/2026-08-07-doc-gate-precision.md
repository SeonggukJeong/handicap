# doc-gate-precision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `check-doc-coverage.py` 토큰 차분 게이트의 유령 토큰(짝-밀림)·소스 자기-은폐를 원인 제거하고, 아티팩트 allowlist 5행을 삭제하며, 게이트 안내 문서 3곳을 현행화한다 (spec: `docs/superpowers/specs/2026-08-07-doc-gate-precision-design.md`, clean APPROVE `188dd25c`).

**Architecture:** 스크립트 1개(`scripts/check-doc-coverage.py`)의 4개 국소 수정(토크나이저·corpus 필터·진단 2분화·개명) + allowlist 정리 + 문서 3곳. production 0-diff — `crates/`·`ui/src`·proto·deploy 무접촉.

**Tech Stack:** Python 3 (stdlib만) · just · git. 상설 테스트 없음 — 검증은 수동 RED/GREEN 이빨 실증(spec §4 V1~V6, 레포 규약).

## Global Constraints

- **production 0-diff**: `crates/`·`ui/`·`proto/`·`deploy/`·`desktop/` 아래 파일을 한 글자도 건드리지 않는다. 건드리게 되면 STOP — plan이 틀린 것.
- **이력 기록 수정 금지**: `docs/build-log.md`·`docs/superpowers/plans/2026-07-30-claude-md-redistribute.md`·`docs/superpowers/plans/2026-08-03-ui-claude-md-curation.md`는 읽기만. sweep에서 매치가 나와도 그대로 둔다(당시 사실).
- **allowlist 유지 행(12–15행) byte-exact 보존**: 파일 전체 재포맷·trailing-whitespace 트리밍 금지. 편집은 아래 지정된 python 수술로만(헤더 교체 + 행 삭제).
- **게이트 판정에 파이프 금지**: 항상 `just doc-coverage > /tmp/doc-gate-precision-<step>.log; echo exit=$?` 형태(리다이렉트는 허용, `| tail`·`| head` 금지 — 종료코드 마스킹). 로그 파일명은 반드시 `doc-gate-precision-` 접두(다른 워크트리 stale 로그 오독 방지).
- **`git checkout`/`git stash`로 원복 금지**(git-guard가 ask로 막는다): 이빨 실증의 임시 변형·원복은 아래 지정된 `/tmp/doc-gate-precision-*.bak` cp 백업 방식으로.
- **워크트리 루트에 `.md` 리포트 쓰기·`git add` 금지** — 작업 리포트는 `.superpowers/sdd/`.
- 커밋 전 `git diff --cached --name-only`로 staged 확인(빈-staged/오타-케이스 방지), 커밋 후 `git log -1`로 landed 확인.

## 디스패치 전 사전 준비 (orchestrator가 직접 — subagent에 위임 금지)

- [ ] spec §5 Claims ledger C1~C12를 **일괄 재실행**해 전 수치 일치 확인 (C1 gate OK · C2 FAIL 후보 0 · C3 0/4펜스/0 · C4 437 · C5 88/125/137 · C6 4행 미등장 · C7 +42/−65·+28/−48·+8/−17·+5/−8 · C9 15발생/13행 · C10 :29 인용 · C11 61 · C12 28). 불일치 시 STOP — spec/plan 갱신 먼저.
- [ ] Task 2의 sweep 자기-매치 핀(§Task 2 Step 5)을 디스패치 직전 재실측해 어긋나면 그 스텝의 "작성 시점 실측" 숫자만 갱신(스펙 S1 규칙 — 자기참조 숫자는 실측이 정본).

---

### Task 1: check-doc-coverage.py 정밀화 + allowlist 정리 + 이빨 V1~V4

**Files:**
- Modify: `scripts/check-doc-coverage.py` (`tokens()` :38-42 · `base_root`/`cur_root` 15발생 · `[move]` 문구 :126,:128 · 토큰 차분 블록 :205-211)
- Modify: `scripts/doc-coverage-allowlist.txt` (헤더 1–7행 교체 · 16–20행 삭제 · 12–15행 byte-exact 유지)

**Interfaces:**
- Produces (Task 2가 byte-exact로 인용): FAIL 문구 3종 — `base 소스에 anchor 없음` · `소스에 anchor 잔존(미제거)` · `소스에 산문으로 잔존 — 목적지 미확인`. 변수명 `base_src`/`cur_src`.

**이빨 순서가 곧 정확성이다**: Step 1–3(baseline arm)은 반드시 **코드 수정 전**에 실행 — 수정 후에는 결함이 사라져 baseline을 다시 찍을 수 없다.

- [ ] **Step 1: V3 baseline — 현행 토크나이저의 짝-밀림 실증**

```bash
python3 - <<'EOF'
import importlib.util
s = importlib.util.spec_from_file_location("cov", "scripts/check-doc-coverage.py")
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
print(sorted(m.tokens("A `×` B `real_token` C")))
EOF
```

Expected: `[' B ']` — 1글자 스팬 `×`를 건너뛰어 짝이 밀리고, 산문 `' B '`가 토큰이 되며 `real_token`은 **소실**된다(현행 결함 실증. `real_token`이 출력에 없음을 확인).

- [ ] **Step 2: V1 baseline — allowlist 5행이 유령 FAIL을 억제 중임을 실증**

```bash
cp scripts/doc-coverage-allowlist.txt /tmp/doc-gate-precision-allowlist.bak
python3 - <<'EOF'
import pathlib
p = pathlib.Path("scripts/doc-coverage-allowlist.txt")
lines = p.read_text().split("\n")
assert lines[15].startswith(")가 행과 함께"), f"16행이 예상과 다름: {lines[15][:30]}"
del lines[15:20]          # 16–20행(아티팩트 5행) 임시 삭제
p.write_text("\n".join(lines))
EOF
just doc-coverage > /tmp/doc-gate-precision-v1base.log; echo exit=$?
grep -c "FAIL \[토큰\]" /tmp/doc-gate-precision-v1base.log
cp /tmp/doc-gate-precision-allowlist.bak scripts/doc-coverage-allowlist.txt
just doc-coverage > /tmp/doc-gate-precision-v1restore.log; echo exit=$?
```

Expected: 첫 gate `exit=1` + `FAIL [토큰]` **5건** → 원복 후 `exit=0`.

- [ ] **Step 3: V2 baseline — 소스 자기-은폐 실증 (`${rec}` 토큰, base·cur 스팬 각 1회 실측 고정)**

```bash
cp ui/CLAUDE.md /tmp/doc-gate-precision-uiclaude.bak
python3 - <<'EOF'
import pathlib
p = pathlib.Path("ui/CLAUDE.md"); t = p.read_text()
assert t.count("`${rec}`") == 1, "스팬 1회 전제 깨짐 — STOP"
p.write_text(t.replace("`${rec}`", "${rec}", 1))   # backtick만 해제, 산문은 잔존
EOF
just doc-coverage > /tmp/doc-gate-precision-v2base.log; echo exit=$?
python3 - <<'EOF'
import re, subprocess, pathlib, glob
base = subprocess.run(["git","show","f870cfd9:ui/CLAUDE.md"],capture_output=True,text=True).stdout
cur = pathlib.Path("ui/CLAUDE.md").read_text()
tok = "${rec}"
diff = set(re.findall(r"`([^`\n]{2,80})`", base)) - set(re.findall(r"`([^`\n]{2,80})`", cur))
lits = ["docs/build-log.md","ui/CLAUDE.md","deploy/CLAUDE.md","desktop/CLAUDE.md"]
paths = [p for p in lits if pathlib.Path(p).exists()]+sorted(glob.glob("docs/dev/*.md"))+sorted(glob.glob("docs/adr/*.md"))+sorted(glob.glob("crates/*/CLAUDE.md"))
hits = [p for p in paths if tok in pathlib.Path(p).read_text()]
print("diff에 등장:", tok in diff, "| corpus 매치 파일:", hits)
EOF
cp /tmp/doc-gate-precision-uiclaude.bak ui/CLAUDE.md
just doc-coverage > /tmp/doc-gate-precision-v2restore.log; echo exit=$?
```

Expected: gate `exit=0`(**은폐 — 이것이 결함**) + 증거 출력 `diff에 등장: True | corpus 매치 파일: ['ui/CLAUDE.md']`(소실 토큰의 유일 corpus 매치가 소스 자신) → 원복 후 `exit=0`.

- [ ] **Step 4: 스크립트 수정 ①/④ — 변수 개명 (15발생, 먼저 해야 이후 블록의 새 이름이 성립)**

```bash
sed -i '' -e 's/base_root/base_src/g' -e 's/cur_root/cur_src/g' scripts/check-doc-coverage.py
grep -c "base_root\|cur_root" scripts/check-doc-coverage.py; echo "old=$?"   # grep 무매치 exit 1 = 정상
grep -o "base_src\|cur_src" scripts/check-doc-coverage.py | wc -l
```

Expected: 첫 grep 카운트 `0`(exit 1) · 두 번째 **15**(발생 단위 검산 — 13은 행 수라 부족, spec C9).

- [ ] **Step 5: 스크립트 수정 ②/④ — `tokens()` 짝-보존 (Edit로 old→new 정확 교체)**

old:
```python
def tokens(t):
    s = set(re.findall(r"`([^`\n]{2,80})`", t))
    s |= set(re.findall(r"docs/[A-Za-z0-9/_.-]+\.md", t))
    s |= set(re.findall(r"ADR-\d{4}", t))
    return s
```

new:
```python
def tokens(t):
    # backtick run을 구분자로 스팬을 길이 무관하게 짝 소비(1자·80자 초과가 짝을 밀어
    # 산문을 토큰으로 오인시키던 결함 제거), 토큰 '채택'만 2–80자로 유지.
    # 잔존 한계(줄 안 backtick 홀수·run-길이 불일치)는 root-doc-maintenance.md §게이트.
    s = {m[1] for m in re.findall(r"(`+)([^`\n]*?)\1", t) if 2 <= len(m[1]) <= 80}
    s |= set(re.findall(r"docs/[A-Za-z0-9/_.-]+\.md", t))
    s |= set(re.findall(r"ADR-\d{4}", t))
    return s
```

- [ ] **Step 6: 스크립트 수정 ③/④ — `[move]` 문구 소스-중립화 (Step 4 이후라 변수는 이미 `cur_src`)**

old:
```python
            if anchor not in base_src:
                fails.append(f"FAIL [move] base root에 anchor 없음: {anchor[:50]}")
            if anchor in cur_src:
                fails.append(f"FAIL [move] root에 anchor 잔존(미제거): {anchor[:50]}")
```

new:
```python
            if anchor not in base_src:
                fails.append(f"FAIL [move] base 소스에 anchor 없음: {anchor[:50]}")
            if anchor in cur_src:
                fails.append(f"FAIL [move] 소스에 anchor 잔존(미제거): {anchor[:50]}")
```

- [ ] **Step 7: 스크립트 수정 ④/④ — corpus 소스 제외 + 토큰 진단 2분화 (반드시 중첩 분기 — 독립 검사면 정당 이관 식별자 28건 거짓 FAIL, spec C12)**

old:
```python
    # 토큰 차분 (3차 방어선) — 위반이면 blocking
    allow = {l.split("\t")[0] for l in pathlib.Path("scripts/doc-coverage-allowlist.txt")
             .read_text().split("\n") if l.strip() and not l.startswith("#")}
    corpus = "".join(pathlib.Path(p).read_text() for p in corpus_paths())
    for t in sorted(tokens(base_src) - tokens(cur_src)):
        if t not in corpus and t not in allow:
            fails.append(f"FAIL [토큰] 소실(목적지 어디에도 없음): {t[:60]}")
```

new:
```python
    # 토큰 차분 (3차 방어선) — 위반이면 blocking. corpus는 '목적지'만 — 검사 대상 소스
    # 자신은 제외한다(소스에 남은 우연 substring이 목적지 소실을 가리는 자기-은폐 차단).
    allow = {l.split("\t")[0] for l in pathlib.Path("scripts/doc-coverage-allowlist.txt")
             .read_text().split("\n") if l.strip() and not l.startswith("#")}
    corpus = "".join(pathlib.Path(p).read_text() for p in corpus_paths()
                     if pathlib.Path(p).resolve() != pathlib.Path(src).resolve())
    for t in sorted(tokens(base_src) - tokens(cur_src)):
        if t in corpus or t in allow:      # allowlist는 두 분기 공통 억제
            continue
        msg = ("소스에 산문으로 잔존 — 목적지 미확인" if t in cur_src
               else "소실(목적지 어디에도 없음)")
        fails.append(f"FAIL [토큰] {msg}: {t[:60]}")
```

- [ ] **Step 8: V4 — 수정 직후 게이트 green (allowlist 5행은 아직 존재 — 이제 inert라 무해)**

```bash
just doc-coverage > /tmp/doc-gate-precision-v4.log; echo exit=$?
```

Expected: `OK: manifest 61행 · R17 섹션 8개` + `exit=0`.

- [ ] **Step 9: allowlist 수술 — 헤더 1–7행 교체 + 16–20행 삭제 (12–15행 무접촉)**

```bash
python3 - <<'EOF'
import pathlib
p = pathlib.Path("scripts/doc-coverage-allowlist.txt")
lines = p.read_text().split("\n")
assert lines[15].startswith(")가 행과 함께"), f"16행이 예상과 다름: {lines[15][:30]}"
header = [
 "# check-doc-coverage.py 토큰 차분(3차 방어선)의 예외 목록.",
 "# base:<소스>에는 있었는데 corpus(소스 제외 — 도메인 CLAUDE.md·docs/dev·docs/adr·build-log)에",
 "# 없는 토큰은 FAIL이다. 문구 2종: 소스에도 raw로 없으면 '소실(목적지 어디에도 없음)',",
 "# 소스에 산문으로 남았지만 목적지 증명이 없으면 '소스에 산문으로 잔존 — 목적지 미확인'.",
 "# allowlist는 두 분기 공통 억제 — 의도적으로 corpus 증명 없이 남긴 토큰만 '근거와 함께' 적는다.",
 "# 토큰 = `backtick` 인용(2–80자) · docs/**.md 경로 · ADR-dddd.",
 "# 주의: 토큰 필드는 탭 앞까지 byte-exact다(후행 공백 포함 — backtick 스팬은 공백으로 끝날 수",
 "# 있다). trailing-whitespace 트리머로 이 파일의 기존 행을 재저장/트림하지 말 것",
 "# (공백이 사라지면 토큰이 더 이상 일치하지 않아 그 예외가 조용히 무효화된다).",
]
new = header + lines[7:15] + lines[20:]   # 8행(빈 주석)~15행(실식별자 4행) 유지, 16–20 삭제
p.write_text("\n".join(new))
EOF
git diff --stat scripts/doc-coverage-allowlist.txt
```

Expected: diff가 헤더 블록과 아티팩트 5행 삭제만 — **12–15행(실식별자 4행: `gh release edit…`·`--is-ancestor…`·`preflight →…`·`[workspace.package]…`)은 diff에 등장하지 않아야 한다**(byte-exact 보존 증명).

- [ ] **Step 10: V1 after-arm — 아티팩트 행 없이 green**

```bash
just doc-coverage > /tmp/doc-gate-precision-v1after.log; echo exit=$?
grep -c "FAIL" /tmp/doc-gate-precision-v1after.log; echo "grep=$?"
```

Expected: `exit=0` · FAIL 0건(grep 카운트 0, exit 1).

- [ ] **Step 11: V2 after-arm — 자기-은폐 제거 실증 (신규 문구 RED → 원복 GREEN)**

```bash
python3 - <<'EOF'
import pathlib
p = pathlib.Path("ui/CLAUDE.md"); t = p.read_text()
assert t.count("`${rec}`") == 1
p.write_text(t.replace("`${rec}`", "${rec}", 1))
EOF
just doc-coverage > /tmp/doc-gate-precision-v2after.log; echo exit=$?
grep -n "FAIL \[토큰\]" /tmp/doc-gate-precision-v2after.log
cp /tmp/doc-gate-precision-uiclaude.bak ui/CLAUDE.md
just doc-coverage > /tmp/doc-gate-precision-v2final.log; echo exit=$?
```

Expected: `exit=1` + 정확히 1건 `FAIL [토큰] 소스에 산문으로 잔존 — 목적지 미확인: ${rec}`(baseline arm의 OK와 쌍 — 은폐가 제거됐다) → 원복 후 `exit=0`.

- [ ] **Step 12: V3 after-arm — 짝-보존 확인**

Step 1의 python 블록을 그대로 재실행.

Expected: `['real_token']` — 산문 조각 소멸 + 실토큰 정상 포획(baseline `[' B ']`와 쌍).

- [ ] **Step 13: Commit**

```bash
git add scripts/check-doc-coverage.py scripts/doc-coverage-allowlist.txt
git diff --cached --name-only
git commit -m "feat(gates): doc-coverage 토큰 차분 정밀화 — 짝-보존 토크나이저·corpus 소스 제외·진단 2분화·아티팩트 allowlist 5행 삭제"
git log -1 --oneline
```

Expected: staged 2파일, 커밋 landed. (`ui/CLAUDE.md`가 staged에 있으면 STOP — 원복 누락.)

---

### Task 2: 게이트 안내 문서 3곳 현행화 + sweep + V5·V6

**Files:**
- Modify: `docs/dev/root-doc-maintenance.md:21,22,29,30` (편집 5건)
- Modify: `Justfile:120` (주석 1줄)
- Modify: `docs/dev/ui-gotcha-narratives.md:232` (경계 절 추가)

**Interfaces:**
- Consumes (Task 1 산출 문구를 byte-exact 인용): `base 소스에 anchor 없음` · `소스에 anchor 잔존(미제거)` · `소스에 산문으로 잔존 — 목적지 미확인`.

- [ ] **Step 1: root-doc-maintenance.md 편집 5건 (각각 Edit로 old→new 정확 교체 — 아래 old는 해당 줄의 교체 대상 조각)**

e1 (:21, 줄번호 인용 제거 — `rows()` 함수명이 이미 검사명 역할):

old: `` `check-doc-coverage.py:87`의 `rows()`는 ``
new: `` `check-doc-coverage.py`의 `rows()`는 ``

e2 (:22, 줄번호 2곳 → 검사명 인용 + `base:CLAUDE.md` 일반화):

old: `` `source_anchor ∈ base:CLAUDE.md`(`check-doc-coverage.py:114`)와 `required_marker ∉ base:<dest_file>`(`:126`)를 주장하는데 ``
new: `` `source_anchor ∈ base:<소스>`(coverage 스크립트의 `base 소스에 anchor` 검사)와 `required_marker ∉ base:<dest_file>`(같은 스크립트의 `marker 신규성` 검사)를 주장하는데 ``

e3 (:29, verbatim FAIL 문구 인용 갱신 — 현행 처방 줄):

old: `검사 ② \`FAIL [move] root에 anchor 잔존(미제거): <source_anchor>\`.`
new: `검사 ② \`FAIL [move] 소스에 anchor 잔존(미제거): <source_anchor>\`.`

e4 (:30, 토큰 FAIL 문구 2종 등재):

old: `**3차 방어선인 토큰 소실 grep**(\`FAIL [토큰] 소실(목적지 어디에도 없음): <토큰>\`, corpus/allowlist로 해소)`
new: `**3차 방어선인 토큰 소실 grep**(문구 2종 — 목적지·소스 어디에도 raw로 없으면 \`FAIL [토큰] 소실(목적지 어디에도 없음): <토큰>\`, 소스에 산문으로 남았지만 목적지 증명이 없으면 \`FAIL [토큰] 소스에 산문으로 잔존 — 목적지 미확인: <토큰>\`; 둘 다 corpus(소스 제외)/allowlist로 해소)`

e5 (:30, 함정 ② 해소 갱신 — 전칭 금지, 잔존 원인 명시):

old: `② 2자 미만·80자 초과 인라인코드는 \`tokens()\`의 backtick 짝을 밀어 **두 코드 스팬 사이 산문**을 토큰으로 오인시킨다 — 이런 아티팩트는 근거를 달아 allowlist로(식별자 소실 탐지력은 유지됨. 실개수 10건 중 5건은 corpus 소스-자기포함에 가려짐 — 게이트 개선 후속은 roadmap-status 문서 테마).`
new: `② ~~2자 미만·80자 초과 인라인코드의 backtick 짝-밀림~~ — **해소됨**(doc-gate-precision: \`tokens()\`가 backtick run 구분자로 스팬을 길이 무관 짝 소비 + corpus 소스-자기포함 은폐 제거). 잔존 아티팩트 원인 = 줄 안 backtick 홀수·run-길이 불일치(내부 backtick 포함 이중 스팬) — 현행 소스 0건이며, 만나면 근거를 달아 allowlist로(식별자 소실 탐지력은 유지됨).`

참고: 같은 :30의 함정 ①(후행 공백 byte-exact)은 **무편집** — spec §2.3-1의 "① 근거 일반화"는 allowlist **헤더**의 짝-밀림 서사를 가리키며 그것은 Task 1 Step 9가 처리한다. :30의 ① 문장 자체엔 짝-밀림 서사가 없어 이미 일반적이다.

- [ ] **Step 2: Justfile 주석 (Edit로 교체)**

old: `# root CLAUDE.md 재분배 이동 검증(R6·R16·R17·R18): manifest 선언 대비 실제 이동·불릿 비감소·토큰 차분.`
new: `# 문서 이동 검증(R6·R16·R17·R18) — 소스 파라미터화 <base> [source]: manifest 선언 대비 실제 이동·불릿 비감소·토큰 차분(corpus는 소스 제외).`

- [ ] **Step 3: narratives :232 경계 절 (Edit로 교체 — 추가만, 기존 토큰 삭제 금지)**

old: `**판정 로직(warn 게이트·curve 분기·total 식) byte-identical 유지**(반환 *모양*만 변경=R10)`
new: `**판정 로직(warn 게이트·curve 분기·total 식) byte-identical 유지**(반환 *모양*만 변경=R10 — **그 리팩터 task의 no-behavior-change 제약이었다. 현행 상시 제약 아님**: 이후 판정 로직을 바꾸는 슬라이스는 이 제약에 묶이지 않는다)`

- [ ] **Step 4: V6 — 문서 편집 후 게이트 green (narratives는 차분 토큰 153건 중 73건의 유일 매치 파일 — 편집이 게이트를 깰 수 있다)**

```bash
just doc-coverage > /tmp/doc-gate-precision-v6.log; echo exit=$?
```

Expected: `exit=0`.

- [ ] **Step 5: sweep 3종 (spec §2.4 — 경계 없는 전수 + 판정 가능한 기대치)**

```bash
grep -rn "base root에 anchor\|root에 anchor 잔존" docs/ scripts/ Justfile CLAUDE.md ui/CLAUDE.md .claude/ .githooks/ .github/
grep -rn "check-doc-coverage.py:[0-9]" docs/ CLAUDE.md .claude/
grep -n "root" scripts/doc-coverage-allowlist.txt scripts/check-doc-coverage.py Justfile docs/dev/root-doc-maintenance.md
```

**판정 기준(파티션 불변식 — 이것이 PASS 조건):**
- sweep 1·2: 매치가 **전부 `docs/superpowers/`(specs·plans) 아래**여야 한다. `scripts/`·`Justfile`·`docs/dev/`·`CLAUDE.md`·`ui/CLAUDE.md`·`.claude/`·`.githooks/`·`.github/` 매치 **0건**.
- sweep 3(개념 grep, 소문자 "root"): `scripts/doc-coverage-allowlist.txt` **0건** · `scripts/check-doc-coverage.py`는 **:107 주석 1건만**(R17 실측 서사 — 정당) · `Justfile`은 **doc-budget 주석(:124) 1건만**(root 예산 — 정당) · `root-doc-maintenance.md`는 파일 주제(root 재분배 절차) 서술만 — **"검사 대상 소스"를 root로 지칭하는 문장 0건**(e1~e5 반영 후 육안 1패스).
- 참고(작성 시점 실측, 자기참조라 디스패치 직전 재실측이 정본 — spec S1 규칙): sweep 1 `docs/superpowers/` 내 매치 = 이력 plan 2파일 6건(`2026-07-30-…:267,269,374`·`2026-08-03-…:47,104,220`) + spec 4곳 + 이 plan 자신 **4행**(Task 1 Step 6 old 블록 2행 · Task 2 Step 1 e3 old 1행 · 이 Step의 sweep 1 명령줄 1행). sweep 2 = spec 1곳 + 이 plan 자신 **2행**(e1·e2 old).

- [ ] **Step 6: V5 — US3 오라클 3항**

```bash
grep -n "def rows" scripts/check-doc-coverage.py
grep -n "base 소스에 anchor" scripts/check-doc-coverage.py
grep -n "marker 신규성" scripts/check-doc-coverage.py
grep -n "현행 상시 제약 아님" docs/dev/ui-gotcha-narratives.md
```

Expected: 앞 3개 각 **정확히 1건**(검사명 인용이 grep 1회로 코드 도달 — 문서 인용 문구가 이 문자열을 byte-exact 포함하는지 e1·e2와 대조) · 마지막 1건(`:232` — V5ⓒ). ⓐ는 Step 5 판정 기준 충족으로 갈음.

- [ ] **Step 7: Commit**

```bash
git add docs/dev/root-doc-maintenance.md Justfile docs/dev/ui-gotcha-narratives.md
git diff --cached --name-only
git commit -m "docs(gates): 게이트 안내 현행화 — 검사명 인용·[move]/토큰 문구 등재·함정 ② 해소 반영·R10 당시-제약 경계"
git log -1 --oneline
```

Expected: staged 3파일, 커밋 landed.

---

## 검증 요약 (spec §4 대응표)

| spec | plan 위치 | 쌍(RED/GREEN) |
|---|---|---|
| V1 (US1) | T1 Step 2(baseline FAIL 5) ↔ Step 10(after OK) | ✓ |
| V2 (US2) | T1 Step 3(baseline OK+은폐 증거) ↔ Step 11(after FAIL 1 신규 문구) | ✓ |
| V3 (③ 단위) | T1 Step 1(`[' B ']`) ↔ Step 12(`['real_token']`) | ✓ |
| V4 | T1 Step 8 | green |
| V5 (US3) | T2 Step 5·6 | 오라클 |
| V6 | T2 Step 4 | green |
