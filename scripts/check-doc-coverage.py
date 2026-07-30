#!/usr/bin/env python3
"""이동 검증: manifest(+merge) + 불릿 개수 비감소(R17) + baseline 조건(R18) + 토큰 차분."""
import re, subprocess, sys, pathlib, glob, ast
from collections import defaultdict

ROOT = "CLAUDE.md"
SECTIONS = ["Subagent dispatch 노하우", "알아둘 결정들"]
BUDGET = "scripts/check-doc-budget.py"

def at(ref, path):
    r = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None      # 없으면 None (R18 신규 행 판정)

def section_span(text, section):
    """'## <section>' 헤딩 줄부터 다음 '## '(또는 EOF)까지. 없으면 None.

    헤딩은 반드시 **줄 앵커**로 찾는다 — `text.find("## "+s)`는 `### <같은 제목>`의
    오프셋 1에도 매치해 섹션 경계를 훔치고, 그러면 불릿이 통째로 사라져 거짓 FAIL이 난다.
    """
    m = re.search(r"(?m)^## " + re.escape(section) + r"[ \t]*$", text)
    if m is None:
        return None
    i = m.start()
    j = text.find("\n## ", i + 1)
    return text[i:j if j > 0 else len(text)]

def bullets(text, section):
    body = section_span(text, section)
    return [] if body is None else [l for l in body.split("\n") if l.startswith("- ")]

def sections_of(text, needle):
    """needle을 포함하는 불릿이 있는 SECTIONS 원소 '전부'(다중 매치를 호출부가 알 수 있게)."""
    return [s for s in SECTIONS if any(needle in l for l in bullets(text, s))]

def tokens(t):
    s = set(re.findall(r"`([^`\n]{2,80})`", t))
    s |= set(re.findall(r"docs/[A-Za-z0-9/_.-]+\.md", t))
    s |= set(re.findall(r"ADR-\d{4}", t))
    return s

def parse_baselines(text):
    """check-doc-budget.py 소스의 `BASELINES = {...}` **대입문**에서 {경로: 바이트}.

    ast로 대입 노드를 찾아 literal_eval 한다. 문자열 탐색(`text.find("BASELINES")`)은
    ① docstring/주석이 이름을 먼저 언급하면 엉뚱한 dict를 잡고
    ② 값에 중첩 dict가 있으면 첫 '}'에서 잘리며 내부 키까지 오염된다 — 둘 다 조용한 오답이다.
    값이 int가 아닌 항목(중첩 dict 등)은 baseline이 아니므로 버린다.
    """
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "BASELINES" for t in node.targets):
            try:
                v = ast.literal_eval(node.value)
            except (ValueError, SyntaxError, TypeError):
                return {}
            if not isinstance(v, dict):
                return {}
            return {k: n for k, n in v.items()
                    if isinstance(k, str) and isinstance(n, int) and not isinstance(n, bool)}
    return {}

def corpus_paths():
    # 리터럴 경로는 전부 .exists()로 감싼다 — glob은 자체 가드가 되지만 리터럴은 아니다.
    # (비대칭으로 두면 부분 체크아웃·fixture에서 FileNotFoundError로 죽고, 그 크래시도
    #  exit 1이라 "RED 실증 완료"로 오기록된다 — 이 스크립트가 막으려는 바로 그 실패다.)
    lits = ["docs/build-log.md", "ui/CLAUDE.md", "deploy/CLAUDE.md", "desktop/CLAUDE.md"]
    return ([p for p in lits if pathlib.Path(p).exists()]
            + sorted(glob.glob("docs/dev/*.md")) + sorted(glob.glob("docs/adr/*.md"))
            + sorted(glob.glob("crates/*/CLAUDE.md")))

def rows():
    """manifest 데이터 행을 탭 분할해 반환(컬럼 수 검증은 호출부). CRLF의 '\\r'은 벗긴다."""
    p = pathlib.Path("scripts/doc-move-manifest.tsv")
    if not p.exists():
        return []
    out = []
    for l in p.read_text().split("\n"):
        l = l.rstrip("\r")          # 후행 '탭'은 벗기지 않는다 — 컬럼 수 오류로 잡혀야 한다
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
    manifest = rows()

    for cols in manifest:
        if len(cols) != 5:     # 언패킹 ValueError(traceback)를 진단으로 승격 — traceback은 RED가 아니다
            raw = "\t".join(cols)
            fails.append(f"FAIL [manifest] 컬럼 {len(cols)}개(5여야 함): {raw[:60]}")
            continue
        kind, anchor, dest, marker, gain = cols
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
            if n != 1:                                                              # ⓐ
                fails.append(f"FAIL [merge] absorbed_marker가 base에 {n}회(1이어야 함): {anchor[:50]}")
            # ⓒ 날조 방지: 진짜 병합이면 base에서 두 마커는 '서로 다른' 불릿에 있다.
            # 이미 한 불릿 안에 있던 두 조각을 뽑아 쓰면 ⓐⓑ가 자동 충족되고, 병합이 한 건도
            # 없는데 R17 바닥만 1 내려가 무관한 불릿이 조용히 사라진다.
            forged = any(anchor in l and marker in l
                         for l in base_root.split("\n") if l.startswith("- "))
            if forged:
                fails.append(f"FAIL [merge] base에서 두 마커가 같은 불릿 — "
                             f"병합 선언이 아니다: {anchor[:50]}")
            surv = [l for l in cur_root.split("\n") if l.startswith("- ") and marker in l]
            if len(surv) > 1:
                print(f"WARN [merge] surviving_anchor 포함 불릿이 {len(surv)}개 — "
                      f"문서 순서 첫 불릿으로 판정(비차단): {marker[:50]}")
            if not surv:                                                            # ⓑ
                fails.append(f"FAIL [merge] surviving_anchor 불릿 없음: {marker[:50]}")
            elif anchor not in surv[0]:
                fails.append(f"FAIL [merge] 병합 미확인 — 삭제만 했는가: {anchor[:50]}")
            elif not forged:                       # 날조면 R17 바닥을 내려주지 않는다
                secs = sections_of(cur_root, marker)
                if len(secs) > 1:
                    print(f"WARN [merge] surviving_anchor가 섹션 {secs}에 모두 매치 — "
                          f"첫 섹션으로 바닥 계산(비차단): {marker[:50]}")
                if secs: merged_floor[secs[0]] += 1
        else:
            fails.append(f"FAIL [manifest] 알 수 없는 kind: {kind}")

    for dest, need in gain_need.items():                       # ④ 누적 비교
        got = len(pathlib.Path(dest).read_text().encode()) - len((at(base, dest) or "").encode())
        if got < need:
            fails.append(f"FAIL [move] {dest} 증가 {got} B < 선언 합계 {need} B")

    for sec in SECTIONS:                                       # R17
        if section_span(base_root, sec) is None:
            # 양쪽 다 섹션이 없으면 0 vs 0으로 '조용히 통과'한다 — 유일한 백스톱이 사라지는 경로.
            fails.append(f"FAIL [R17] base root에 '## {sec}' 섹션 없음 — 검사 불능"); continue
        b, c = len(bullets(base_root, sec)), len(bullets(cur_root, sec))
        floor = b - merged_floor[sec]
        if c < floor:
            fails.append(f"FAIL [R17] '{sec}' 불릿 {b}→{c} (허용 바닥 {floor})")

    # R18: 양쪽 ref에 존재하는 baseline 행만
    base_budget, cur_budget = at(base, BUDGET), (pathlib.Path(BUDGET).read_text()
                                                 if pathlib.Path(BUDGET).exists() else None)
    if base_budget and cur_budget:
        cur_baselines = parse_baselines(cur_budget)
        for f, bb in parse_baselines(base_budget).items():
            cb = cur_baselines.get(f)
            if cb is None or cb <= bb:
                continue                                        # 삭제·유지·인하는 스코프 밖
            if not pathlib.Path(f).exists():    # 무가드 read_text는 FileNotFoundError(=크래시)
                fails.append(f"FAIL [R18] baseline 대상 파일 없음: {f} ({bb}→{cb} 인상)"); continue
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
    print(f"\n{'FAIL' if fails else 'OK'}: manifest {len(manifest)}행 · R17 {SECTIONS}")
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "17369d32"))
