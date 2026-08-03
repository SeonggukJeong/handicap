# ui/CLAUDE.md 큐레이션 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ui/CLAUDE.md 119,111 B를 규칙 잔류·이력 이관으로 ≤ 98,304 B(96 KiB)로 압축하고, 그 이동을 기계 검증하도록 doc-coverage를 소스-파일 파라미터화하며, doc-budget에 문서화 절대-임계값 WARN을 추가한다.

**Architecture:** spec = `docs/superpowers/specs/2026-08-03-ui-claude-md-curation-design.md` (c63cb1e3, clean APPROVE). 정본 절차 = `docs/dev/root-doc-maintenance.md` §재분배 절차(순서 고정: manifest → 목적지 기입 → 축약 → 검증). 게이트 파라미터화(T1)를 절차 앞에 둔다 — T4 검증이 ui 스코프로 돌 수 있어야 하므로.

**Tech Stack:** Python 3(stdlib only — 기존 스크립트 관행), git, just. production 코드 0-diff(docs + scripts만).

## Global Constraints (모든 task에 암묵 포함)

- **base = `f870cfd9`** (worktree 분기점 = master). ui/CLAUDE.md 줄번호 인용은 전부 이 커밋 기준(`git show f870cfd9:ui/CLAUDE.md`) — spec 커밋들은 ui/CLAUDE.md를 건드리지 않았으므로 작업트리와 동일하다(T3 시작 전까지).
- **압축 대상 = ui/CLAUDE.md 4개 섹션만**: `오프라인(CSP) · 테스트 인프라`(44불릿)·`빌드·타입 게이트`(36)·`폼·입력 UX / 진단 표시 (RunDialog, RunDetail)`(30)·`다단계 ramp UI (RunDialog stages 편집·미리보기, S-D)`(10). 그 밖 편집의 **유일 예외 = 유지 규칙 노트(`ui/CLAUDE.md:9` blockquote)에 포인터 1줄 추가**. 섹션 rename 금지.
- **삭제 금지·이동만**(no-forget): 함정의 현행 진술·현행 처방·load-bearing 디테일·출처 태그는 잔류. 발견 경위·superseded 중간 상태·동형사례 2번째 이후 상세만 이관. **이번 슬라이스 merge 행 0** — 불릿 개수는 8개 섹션 전부 base와 동일해야 한다(R17 floor == base count).
- **크기 목표**: `wc -c ui/CLAUDE.md` ≤ **98,304 B**. §2 기준을 지키고도 미달이면 **STOP — 실측을 들고 사용자에게 재협상 보고**(무리한 삭제로 채우지 않는다).
- 게이트 판정은 파이프 금지 — `<명령>; echo exit=$?`로 종료코드 명시 캡처. WARN 계열 RED 판정은 종료코드가 아니라 **지정 문구 grep**(WARN은 exit 0).
- tracked 파일명은 **`Justfile`**(대문자 — macOS 대소문자 무구분이라 소문자로도 열리지만 `git add justfile`은 0건 스테이징).
- tdd-guard·spec-review-guard: 이 plan의 편집 대상은 docs/·scripts/·Justfile뿐이라 두 훅 모두 비발동(`crates/*/src`·`ui/src` 0-diff). 커밋은 전부 pre-commit fast-path.
- manifest TSV 규약: 탭 5컬럼 `kind·source_anchor·dest_file·required_marker·min_dest_gain_bytes`. **anchor/marker 안에 탭·`|` 문자 금지** — `|`는 required_marker의 다중-marker 구분자다(`check-doc-coverage.py`의 `marker.split("|")`).

---

### Task 1: 게이트 스크립트 2종 — coverage 소스 파라미터화 + budget ABS_WARN (+이빨 실증)

**Files:**
- Modify: `scripts/check-doc-coverage.py`
- Modify: `scripts/check-doc-budget.py`
- (Justfile은 이 task에서 건드리지 않는다 — 기본값 flip은 Task 4. T1~T3 동안 bare `just doc-coverage`가 진실한 green으로 남게 하기 위함)

**Interfaces:**
- Consumes: 없음 (첫 task)
- Produces: ① CLI 계약 `python3 scripts/check-doc-coverage.py <base> [source_file]`(source_file 기본 `"CLAUDE.md"`) ② `check-doc-budget.py` 모듈 상수 `ABS_WARN: dict[str,int]`·`ABS_WARN_MIN = 2`와 출력 문구 `WARN [절대]`/`FAIL [절대]`, 표 행 라벨 `<파일> (절대)`

- [ ] **Step 1: coverage 파라미터화 — 소스 파일 인자**

`scripts/check-doc-coverage.py`에서 아래 4곳을 수정한다(현행 코드는 인용 그대로 실재 — 사전 `grep -n`으로 위치 확인 후 편집):

① `SECTIONS = ["Subagent dispatch 노하우", "알아둘 결정들"]` 상수 삭제 → base 소스에서 동적 도출로 대체(아래 ③). 모듈 docstring의 R17 설명에 "섹션은 base 소스의 `## ` 헤딩에서 동적 도출" 한 줄 반영.

② `sections_of(text, needle)` → 섹션 목록을 인자로:
```python
def sections_of(text, needle, secs):
    """needle을 포함하는 불릿이 있는 secs 원소 '전부'(다중 매치를 호출부가 알 수 있게)."""
    return [s for s in secs if any(needle in l for l in bullets(text, s))]
```
(호출부는 1곳 — merge 처리의 `secs = sections_of(cur_root, marker)` → `sections_of(cur_root, marker, secs_dyn)`.)

③ `def main(base):` → `def main(base, src=ROOT):`. 본문에서:
```python
    base_root = at(base, src)
    if base_root is None:
        print(f"FAIL [setup] {base}:{src} 를 읽을 수 없다"); return 1
    cur_root = pathlib.Path(src).read_text()
    # R17 섹션 동적 도출 — base 소스의 `## ` 헤딩 전부(오늘 실측: 펜스 안 `## ` 줄은
    # root·ui 양쪽 0건이라 raw regex로 충분 — section_span과 동일 raw-text 규약).
    secs_dyn = re.findall(r"(?m)^## (.+?)[ \t]*$", base_root)
    if not secs_dyn:
        fails.append(f"FAIL [R17] {base}:{src}에 '## ' 헤딩 0개 — 검사 불능")
```
(`fails = []` 초기화 이후로 순서 조정. 기존 `base_root`/`cur_root` 변수명은 유지해 이하 diff 최소화.)

④ R17 루프 `for sec in SECTIONS:` → `for sec in secs_dyn:` + **섹션 실종 명시 FAIL**(spec §4.1 — base 불릿 0개 섹션은 floor 0이라 실종이 조용히 통과하는 구멍을 막는다):
```python
    for sec in secs_dyn:                                       # R17
        if section_span(cur_root, sec) is None:
            fails.append(f"FAIL [R17] '## {sec}' 섹션이 작업트리에서 실종(rename 비목표)"); continue
        b, c = len(bullets(base_root, sec)), len(bullets(cur_root, sec))
        floor = b - merged_floor[sec]
        if c < floor:
            fails.append(f"FAIL [R17] '{sec}' 불릿 {b}→{c} (허용 바닥 {floor})")
```
기존 루프의 "base root에 섹션 없음" 분기는 동적 도출로 원리상 불가능해지므로 제거. 마지막 요약 print의 `R17 {SECTIONS}` → `R17 섹션 {len(secs_dyn)}개`. `__main__`:
```python
if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "17369d32",
                  sys.argv[2] if len(sys.argv) > 2 else ROOT))
```

- [ ] **Step 2: 하위호환 이빨 — 파라미터화 후에도 현행 root 검사가 byte-동일하게 green**

```bash
python3 scripts/check-doc-coverage.py 17369d32; echo exit=$?
python3 scripts/check-doc-coverage.py 17369d32 CLAUDE.md; echo exit=$?
```
Expected: 두 실행 모두 `OK: manifest 14행 · R17 섹션 14개` + `exit=0`. (**사전 실측 baseline**: 파라미터화 *전* bare `just doc-coverage`가 `OK: manifest 14행 · R17 ['Subagent dispatch 노하우', '알아둘 결정들']`로 green이었다 — R17이 2→14섹션으로 **확대**된 것 외에 판정 불변이어야 한다. FAIL이 하나라도 늘면 동적 도출이 root의 다른 섹션에서 뭔가 깨뜨린 것이니 STOP.)

- [ ] **Step 3: 신규 경로 RED — 소스 전환이 실제로 검사 대상을 바꾼다**

```bash
python3 scripts/check-doc-coverage.py f870cfd9 ui/CLAUDE.md; echo exit=$?
```
Expected: `exit=1` + `FAIL [move] base root에 anchor 없음` **14건**(활성 manifest는 아직 redistribute의 root 행 — 그 anchor들은 base *ui* 파일에 없다). R17은 ui 8섹션 기준 green, 토큰 차분 green. 이 RED가 "인자가 무시되던" 종전 동작(스크립트가 argv[2]를 아예 안 읽던 것)이 실제로 바뀌었음을 증명한다.

- [ ] **Step 4: budget ABS_WARN 추가**

`scripts/check-doc-budget.py`의 `BASELINES_MIN`/`L1_MIN_REFS` 선언 근처에 상수 추가(R18의 `parse_baselines`는 `BASELINES` 이름만 ast로 읽으므로 새 dict와 무충돌):
```python
# 문서화 절대-임계값(파일 상단 유지 규칙 노트에 숫자가 있는 파일만 — ui/CLAUDE.md:9 "~120KB",
# crates/engine/CLAUDE.md:7 "~60KB". controller 등 문서화 값 없는 파일은 의도적 제외:
# 래칫이 커버하고, 절대값 결정은 그 도메인 큐레이션 슬라이스의 몫).
ABS_WARN = {"ui/CLAUDE.md": 122880, "crates/engine/CLAUDE.md": 61440}
ABS_WARN_MIN = 2        # 하한 — dict 비우기로 검사를 증발시키는 경로 차단(BASELINES_MIN 동형)
```
`main()`의 ⑤ 래칫 블록 **뒤**에 블록 ⑥ 추가:
```python
    # ⑥ 절대-임계값 — 문서화 상한 대비 상시 근접도 표시 + 초과 시 WARN(재비대 최종 백스톱)
    if len(ABS_WARN) < ABS_WARN_MIN:
        fails.append(f"FAIL [절대] ABS_WARN {len(ABS_WARN)}개 < 하한 {ABS_WARN_MIN}개 — "
                     f"검사 불능(문서화 임계값을 실제로 없앴을 때만 내릴 것)")
    for f, cap in ABS_WARN.items():
        p = pathlib.Path(f)
        if not p.exists():
            fails.append(f"FAIL [절대] 대상 파일 없음: {f} (임계값 {cap:,} B)")
            continue
        cur = nbytes(p.read_text())
        table.append((f"{f} (절대)", cur, cap, f"{cur / cap * 100:.1f}%"))
        if cur > cap:
            warns.append(f"WARN [절대] {f} {cur:,} B > 문서화 임계값 {cap:,} B — "
                         f"유지 규칙 노트 기준 재분배 검토(도메인 큐레이션 슬라이스)")
```
마지막 요약 print에 `· 절대 {len(ABS_WARN)}개` 추가(`래칫 {len(BASELINES)}개` 뒤).

- [ ] **Step 5: ABS_WARN 이빨 실증 (주입 → RED → 원복 → GREEN)**

```bash
# RED ①: ui 임계값을 현재 크기 미만으로 임시 하향(122880 → 100000)
python3 scripts/check-doc-budget.py > /tmp/ui-claude-md-curation-budget.log; echo exit=$?
grep -c 'WARN \[절대\] ui/CLAUDE.md' /tmp/ui-claude-md-curation-budget.log
```
Expected: `exit=0`(WARN은 비차단 — **문구 grep이 판정**), grep 카운트 `1`. 원복 후 같은 grep이 `0`, 표에 `(절대)` 행 2개 존재(`grep -c '(절대)'` → 2).
```bash
# RED ②: ABS_WARN = {} 로 임시 교체
python3 scripts/check-doc-budget.py; echo exit=$?
```
Expected: `FAIL [절대] ABS_WARN 0개 < 하한 2개` 출력 + `exit=1`. 원복 후 `just doc-budget; echo exit=$?` → `exit=0`, FAIL 0. (로그 파일은 워크트리-스코프 이름 `/tmp/ui-claude-md-curation-*.log`만 사용 — stale-log 함정.)

- [ ] **Step 6: Commit**

```bash
git add scripts/check-doc-coverage.py scripts/check-doc-budget.py
git diff --cached --name-only
git commit -m "feat(gates): doc-coverage 소스-파일 파라미터화 + doc-budget 절대-임계값 WARN"
git log -1 --oneline
```

### Task 2: manifest 교체 + 목적지(narratives) 기입 — 정본 절차 1·2단계

**Files:**
- Rename: `scripts/doc-move-manifest.tsv` → `scripts/doc-move-manifest-claude-md-redistribute.tsv` (`git mv` — 삭제 금지, 이력 보존)
- Create: `scripts/doc-move-manifest.tsv` (이번 슬라이스 ui 행만)
- Create: `docs/dev/ui-gotcha-narratives.md`

**Interfaces:**
- Consumes: Task 1의 CLI `check-doc-coverage.py <base> [source_file]`
- Produces: ① 활성 manifest의 ui `move` 행들(Task 3이 행 단위로 축약을 수행) ② `docs/dev/ui-gotcha-narratives.md`(4개 미러 `##` 섹션 + 행별 `###`)

- [ ] **Step 1: manifest rename (정본 §재분배 절차 1-①)**

```bash
git mv scripts/doc-move-manifest.tsv scripts/doc-move-manifest-claude-md-redistribute.tsv
ls scripts/doc-move-manifest*.tsv
```
Expected: 이름 바뀐 파일 1개만 존재(활성 경로 부재 상태 — Step 2가 곧 채운다).

- [ ] **Step 2: 이관 대상 선정 + 새 활성 manifest 작성**

선정 절차(전부 `git show f870cfd9:ui/CLAUDE.md` 기준 줄번호):
1. **의무 시드 10불릿**: XL 8개 = line **31·76·79·99·102·103·149·159** + superseded 정정 잔여 2개 = line **39·101**(149는 XL과 중복 — 스펙 §1 "버킷은 겹친다").
2. 4개 대상 섹션의 나머지 불릿을 크기 내림차순으로 훑으며 §2 기준(발견 경위·superseded 중간 상태·동형사례 꼬리)에 해당하는 서사 조각이 있는 불릿만 행 추가. **서사 꼬리가 없는 불릿은 행을 만들지 않는다**(모든 불릿에 행 의무 없음).
3. 각 행에 대해 `제거 예정 서사 바이트`를 실측(불릿 원문에서 잔류 규칙부를 뺀 나머지의 `wc -c`)하고, **Σ(제거 예정 바이트) ≥ 22,000 B가 될 때까지** 2를 계속한다(목표 −20,807 B + 재작성 오버헤드 버퍼). 도달 불가 판단이 서면 STOP — 재협상 밸브.

행 작성 규칙(각 행마다 **사전 grep 확인 후** 기입):
- `kind` = `move` (merge 행 금지 — Global Constraints)
- `source_anchor` = 이관될 서사 조각 안의 고유 부분문자열. 사전 확인: `python3 -c "d=open('ui/CLAUDE.md').read(); print(d.count('<anchor>'))"` → **정확히 1** + 잔류 예정 규칙부 텍스트에 미포함(축약 후 0회가 되도록).
- `dest_file` = `docs/dev/ui-gotcha-narratives.md`
- `required_marker` = 목적지에 쓸 서사의 고유 문구(같은 count 방식으로 dest 내 유일 확인. 신규 파일이라 base 목적지 부재 → gain>0 행의 marker-신규성 검사 자동 충족)
- `min_dest_gain_bytes` = ⌈제거 예정 서사 바이트 × 0.6⌉ (보수적 하한 — 목적지 재편집 여지)
- anchor·marker에 탭·`|` 금지(Global Constraints), 각 60자 이내 권장(FAIL 메시지가 [:50] 잘라 보여주므로 앞 50자가 식별력 있게)

- [ ] **Step 3: `docs/dev/ui-gotcha-narratives.md` 기입 (정본 절차 2단계 — 원본은 아직 그대로)**

파일 골격:
```markdown
# ui/CLAUDE.md 함정 서사 아카이브 (on-demand)

> `ui/CLAUDE.md`의 함정 불릿에서 이관된 **발견 경위·정정 이력·실측 전문**. 규칙 자체는
> ui/CLAUDE.md에 남아 있다(그쪽이 정본) — 이 파일은 "왜 그 규칙이 생겼나"가 필요할 때만
> 읽는다. 유래: ui-claude-md-curation 슬라이스(2026-08-03, spec
> `docs/superpowers/specs/2026-08-03-ui-claude-md-curation-design.md`).

## 오프라인(CSP) · 테스트 인프라
### <이관 항목 제목 = 원 불릿의 굵은 머리 요지>
<서사 원문 — 원 불릿에서 이관 조각을 그대로, 문맥 접속어만 최소 조정>
…
## 빌드·타입 게이트
…
## 폼·입력 UX / 진단 표시 (RunDialog, RunDetail)
…
## 다단계 ramp UI (RunDialog stages 편집·미리보기, S-D)
…
```
manifest 모든 행의 서사를 해당 미러 섹션 `###`로 기입. required_marker 문구가 본문에 실재해야 한다.

- [ ] **Step 4: 중간 게이트 — 기대-부분-RED 시그니처 확인 (정본 절차 3단계 직전 상태)**

```bash
python3 scripts/check-doc-coverage.py f870cfd9 ui/CLAUDE.md > /tmp/ui-claude-md-curation-cov.log; echo exit=$?
grep -c '^FAIL \[move\] root에 anchor 잔존' /tmp/ui-claude-md-curation-cov.log
grep '^FAIL \[' /tmp/ui-claude-md-curation-cov.log | grep -cv '잔존'
```
Expected: `exit=1` · 잔존 FAIL 카운트 == **manifest 행 수**(아직 축약 전이니 전 행) · 셋째 명령(finding 라인 `FAIL [` 중 잔존 아닌 것) **0**(marker·gain·R17·토큰 전부 green이어야 — 하나라도 있으면 manifest/목적지가 불완전한 것. 주의: 요약 줄은 `FAIL:` 형식이라 `FAIL [` 패턴에 안 잡히고, `grep -cv`가 0을 찍으며 exit 1을 내는 것은 정상 — 판정은 카운트 값이지 종료코드가 아니다). 이 시그니처가 "manifest 형식이 옳고 목적지가 완전하다"를 축약 *전에* 기계 확정한다.

- [ ] **Step 5: Commit**

```bash
git add scripts/doc-move-manifest.tsv scripts/doc-move-manifest-claude-md-redistribute.tsv docs/dev/ui-gotcha-narratives.md
git diff --cached --name-status
git commit -m "docs(curation): ui manifest 작성 + narratives 목적지 기입 (정본 절차 1·2 — 원본 불변, 중복 상태)"
git log -1 --oneline
```

### Task 3: ui/CLAUDE.md 축약 — 정본 절차 3단계

**Files:**
- Modify: `ui/CLAUDE.md` (4개 대상 섹션 + line 9 유지 규칙 노트 1줄만)

**Interfaces:**
- Consumes: Task 2의 활성 manifest(행 단위 작업 목록), `docs/dev/ui-gotcha-narratives.md`(이관 완료 확인용)
- Produces: 압축된 ui/CLAUDE.md ≤ 98,304 B (Task 4가 BASELINES 하향값으로 실측 사용)

- [ ] **Step 1: 행 단위 축약**

manifest 각 행에 대해: 해당 불릿에서 `source_anchor`를 포함한 서사 조각을 제거하고, §2 "남는다" 목록(현행 진술·현행 처방·load-bearing 디테일·출처 태그)만 남게 재서술한다. superseded 3곳(line 39·101·149)은 **현행-진실 단일 서술**로(중간 상태 서술은 이미 narratives에 있다). 불릿 삭제·병합·순서 변경 금지. 새 규칙 문구 발명 금지 — 잔류부는 원문 어휘를 최대 보존(토큰 차분이 3차 방어선으로 어휘 소실을 감시한다).

- [ ] **Step 2: 포인터 배선**

① 4개 대상 섹션 각각의 `## ` 헤딩 직후에 1줄 blockquote:
```markdown
> 이 섹션 함정들의 발견 경위·정정 이력·실측 전문 → `docs/dev/ui-gotcha-narratives.md` §<섹션명> (키워드: <이 섹션에서 이관된 토픽들을 쉼표 나열>)
```
키워드는 grep 발견성이 목적이므로 이관 항목의 식별 어휘(컴포넌트명·함정명)를 나열한다(정본 §이관 기준 말미 요건). ② 유지 규칙 노트(`ui/CLAUDE.md:9` blockquote — line 7 하위 도메인 목록 아님)에 1줄 추가: `이관된 서사·이력은 docs/dev/ui-gotcha-narratives.md(on-demand).`

- [ ] **Step 3: 검증 — coverage 전체 green + 크기 + 범위 밖 불변**

```bash
python3 scripts/check-doc-coverage.py f870cfd9 ui/CLAUDE.md; echo exit=$?
wc -c ui/CLAUDE.md
```
Expected: `OK` + `exit=0`(잔존 FAIL 소멸 = 축약 완료·marker/R17/토큰 green 유지) · `wc -c` ≤ **98,304**. 미달이면 STOP — 재협상 밸브(무리한 삭제 금지).

범위 밖 불변 확인(4개 비대상 섹션 + line 9 외 preamble이 base와 byte-동일):
```bash
python3 - <<'EOF'
import subprocess, re
base = subprocess.run(["git","show","f870cfd9:ui/CLAUDE.md"],capture_output=True,text=True).stdout
cur = open("ui/CLAUDE.md").read()
def span(t, sec):
    m = re.search(r"(?m)^## " + re.escape(sec) + r"[ \t]*$", t); i = m.start()
    j = t.find("\n## ", i+1); return t[i:j if j>0 else len(t)]
for sec in ["API client / React Query / fetch",
            "변수 스코프 판정 (`scanVars.ts`, `VariablesPanel`)",
            "데이터 바인딩 패널 (8c, `DataBindingPanel`)",
            "워커 대시보드 (`WorkerDashboardPage`, `api/pool.ts`)"]:
    print(sec[:20], "IDENTICAL" if span(base,sec)==span(cur,sec) else "CHANGED!")
b9, c9 = base.split("\n"), cur.split("\n")
diff_pre = [i+1 for i in range(10) if b9[i] != c9[i]]
print("preamble(1-10) 변경 줄:", diff_pre, "(기대: [9]뿐)")
EOF
```
Expected: 4섹션 전부 `IDENTICAL`, preamble 변경 줄 `[9]`뿐.

- [ ] **Step 4: Commit**

```bash
git add ui/CLAUDE.md
git commit -m "docs(curation): ui/CLAUDE.md 서사 이관·축약 — 규칙 잔류, 불릿 수 불변 (정본 절차 3)"
git log -1 --oneline
```

### Task 4: Justfile 기본값 flip + BASELINES 하향 + 이빨 4종 + 최종 게이트 — 정본 절차 4·5단계

**Files:**
- Modify: `Justfile` (doc-coverage 레시피 기본값)
- Modify: `scripts/check-doc-budget.py` (`BASELINES["ui/CLAUDE.md"]` 1행)

**Interfaces:**
- Consumes: Task 1~3 전부(파라미터화 CLI·활성 ui manifest·압축된 ui/CLAUDE.md 실측 크기)
- Produces: 슬라이스 최종 상태 — bare `just doc-coverage`·`just doc-budget` 둘 다 진실한 green

- [ ] **Step 1: Justfile 기본값 flip**

현행 레시피(`Justfile:121-122` — `doc-coverage BASE="17369d32":` / `python3 scripts/check-doc-coverage.py {{BASE}}`)를:
```make
doc-coverage BASE="f870cfd9" FILE="ui/CLAUDE.md":
    python3 scripts/check-doc-coverage.py {{BASE}} {{FILE}}
```
(활성 manifest의 base·소스를 인코딩 — redistribute 선례 동형. 옛 root 검사는 `just doc-coverage 17369d32 CLAUDE.md`로 여전히 호출 가능하나 활성 manifest가 ui 스코프인 동안은 무의미 — "행은 자기 base에서만 참".)

- [ ] **Step 2: BASELINES 하향 (인상 아님 — R18 스코프 밖)**

Task 3 완료 시점의 `wc -c ui/CLAUDE.md` 실측값으로 `BASELINES["ui/CLAUDE.md"] = 116129` → `<실측값>` 교체. 다른 파일 baseline 불변.

- [ ] **Step 3: 이빨 4종 (각각 주입 → RED 확인 → 원복 → GREEN — spec §5 지식-가드 행)**

```bash
# ① R17: 잔류 불릿 1개 임시 삭제(대상 섹션 아무 곳) → FAIL [R17] '<섹션>' 불릿 N→N-1
just doc-coverage; echo exit=$?          # 기대: exit=1 + FAIL [R17] 문구
# 원복 후 재실행 → exit=0

# ② marker: narratives에서 required_marker 문구 1개 임시 훼손(철자 1자 변경)
just doc-coverage; echo exit=$?          # 기대: exit=1 + FAIL [move] <dest>에 marker 없음
# 원복 → exit=0

# ③ 토큰: 사전 grep으로 ⓐ ui/CLAUDE.md 내 정확 1회 ⓑ corpus 전 경로·allowlist 0건인
#    backtick 토큰을 고른다(둘 다 확인 명령 실행 후 선정 — 아니면 공허-이빨, spec §5):
python3 - <<'EOF'
import re, pathlib, glob
tok = "<후보 토큰>"     # 예: 잔류 규칙의 좁은 식별자. 아래 두 조건 만족할 때까지 교체
ui = pathlib.Path("ui/CLAUDE.md").read_text()
print("ui 내 backtick 출현:", len(re.findall(r"`" + re.escape(tok) + r"`", ui)))
paths = [p for p in ["docs/build-log.md","deploy/CLAUDE.md","desktop/CLAUDE.md"] if pathlib.Path(p).exists()] \
        + sorted(glob.glob("docs/dev/*.md")) + sorted(glob.glob("docs/adr/*.md")) + sorted(glob.glob("crates/*/CLAUDE.md"))
corpus = "".join(pathlib.Path(p).read_text() for p in paths)
allow = pathlib.Path("scripts/doc-coverage-allowlist.txt").read_text()
print("corpus(ui 제외) 출현:", corpus.count(tok), "allowlist:", tok in allow)
EOF
# ⓐ==1, corpus==0, allowlist False인 토큰의 backtick 출현부를 임시 삭제
just doc-coverage; echo exit=$?          # 기대: exit=1 + FAIL [토큰] 소실
# 원복 → exit=0

# ④ R18(이번에 최초 무장): BASELINES["crates/engine/CLAUDE.md"]를 +1 임시 인상
#    (engine 파일은 이 슬라이스 무변경 = base 대비 안 줄었으므로 결정적 RED.
#     ui로 하면 파일이 실제로 줄어 R18이 정당하게 통과하니 이빨이 안 된다)
just doc-coverage; echo exit=$?          # 기대: exit=1 + FAIL [R18] ... 인상인데 파일이 줄지 않았다
# 원복 → exit=0
```

- [ ] **Step 4: 최종 게이트 2종 + ABS 상시 표 확인 (정본 절차 4·5)**

```bash
just doc-coverage; echo exit=$?
just doc-budget > /tmp/ui-claude-md-curation-budget-final.log; echo exit=$?
grep -c '(절대)' /tmp/ui-claude-md-curation-budget-final.log
grep -c 'WARN' /tmp/ui-claude-md-curation-budget-final.log
```
Expected: coverage `exit=0` · budget `exit=0` · `(절대)` 행 **2** · WARN **0**(ui 래칫은 하향된 baseline 대비 `+0 B` 부근, 절대 96 KiB/120 KiB ≈ 80%).

- [ ] **Step 5: 육안 대조 준비 (spec §5 "지식 보존")**

manifest에서 무작위 3행을 뽑아(`sort -R | head -3` 등) 각 행의 ① 잔류 불릿 전문 ② 이관 서사 전문을 task 리포트에 나란히 기록 — "잔류 규칙만으로 같은 함정을 회피할 수 있는가"를 orchestrator/사용자가 판정한다(기계 게이트와 독립).

- [ ] **Step 6: Commit**

```bash
git add Justfile scripts/check-doc-budget.py
git diff --cached --name-only
git commit -m "feat(gates): doc-coverage 기본값을 ui manifest base로 flip + ui BASELINES 하향 고정"
git log -1 --oneline
```

---

## 마무리(구현 orchestrator 참고 — task 아님)

- per-task 2단계 리뷰(spec-compliance → code-quality). 모델 라우팅: path-gate(engine/동시성/proto/…) 무매치 → code-quality는 기본 Sonnet. 리뷰 BASE = implementer 디스패치 직전 커밋.
- 최종 whole-branch 리뷰 = `handicap-reviewer`. 보안 게이트는 `finish-slice` §0 grep이 결정(예상 N/A — docs/scripts만이나 **grep이 지배**).
- 라이브 검증 생략(production diff 0) + 근거 build-log 기록. `/finish-slice`에서 상태줄 교체(래칫 1,229 B — 여유 1 B 주의)·build-log 단락·roadmap-status 갱신.
- task-brief에 spec의 `사용자 스토리 (US)` 블록 1회 추출 첨부(ADR-0048).
