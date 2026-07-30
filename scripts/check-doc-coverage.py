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

def parse_baselines(text):
    """check-doc-budget.py 소스의 `BASELINES = {` … `}` 한 블록에서 {경로: 바이트}.

    블록이 없으면 빈 dict (호출부는 양쪽 ref에 파일이 있을 때만 부른다).
    """
    i = text.find("BASELINES")
    if i < 0:
        return {}
    o = text.find("{", i)
    if o < 0:
        return {}
    c = text.find("}", o)
    if c < 0:
        return {}
    return {m[0]: int(m[1]) for m in re.findall(r'"([^"]+)":\s*(\d+)', text[o:c + 1])}

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
