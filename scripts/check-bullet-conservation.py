#!/usr/bin/env python3
"""D3 독립 불릿 보존 검사(1:1) + D4 실수 지점 기계 검사(선택 `--map`).

사용: check-bullet-conservation.py <base> [--map <bullet-map-final.tsv>]

D3 — coverage 게이트(check-doc-coverage.py)의 버그에 기대지 않으려고 따로 둔 검사다.
  - base 문서 집합 = `ui/CLAUDE.md` + `git ls-tree -r --name-only <base> ui/src`의 `*/CLAUDE.md`.
    현재 집합 = `ui/CLAUDE.md` + `glob('ui/src/**/CLAUDE.md', recursive=True)`.
    (`ui/**` glob 금지 — node_modules·dist 유입.)
  - 대상 줄 = `- `·`  - `로 시작하는 줄. 사전조건: base에서 서로 유일.
  - 각 줄에 그 줄을 지목한 relocate/refix 치환(두 manifest 통틀어 (file, 줄)로 키, 없으면 항등)을
    적용한 결과가 현재 집합 전체에서 정확히 1회 나타나야 한다.
  - manifest↔소스: 활성 `scripts/doc-move-manifest.tsv` = 소스 `ui/CLAUDE.md`,
    `scripts/doc-move-manifest.compare.tsv` = `ui/src/compare/CLAUDE.md`. refix는 자기 `<file>`.
    한 base 줄을 지목하는 relocate·refix 행은 두 manifest 통틀어 최대 1개.
  - manifest 파일이 없으면 0행(이력화 rename 직후 ~ 새 manifest 작성 전 상태).
D4 — final TSV의 이동 행(dest_file ∉ {STAY, DELETE-IF-EMPTY})마다 `mistake_sites`(쉼표 구분)
  각 경로가 `dirname(dest_file)` 하위(`ui/CLAUDE.md`면 `ui/`)여야 한다.
TSV는 전부 `split('\\t')` — csv 모듈은 `"`로 시작하는 필드를 벗겨 anchor를 망가뜨린다.
"""
import glob
import os
import pathlib
import subprocess
import sys
from collections import Counter, defaultdict

MANIFESTS = [
    ("scripts/doc-move-manifest.tsv", "ui/CLAUDE.md"),
    ("scripts/doc-move-manifest.compare.tsv", "ui/src/compare/CLAUDE.md"),
]
NON_MOVE = ("STAY", "DELETE-IF-EMPTY")


def at(ref, path):
    r = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def read_rows(path):
    p = pathlib.Path(path)
    if not p.exists():
        return []
    out = []
    for l in p.read_text().split("\n"):
        l = l.rstrip("\r")
        if l.strip() and not l.startswith("#"):
            out.append(l.split("\t"))
    return out


def is_bullet(l):
    return l.startswith("- ") or l.startswith("  - ")


def main(argv):
    if len(argv) < 2:
        print("사용: check-bullet-conservation.py <base> [--map <final.tsv>]")
        return 2
    base = argv[1]
    map_path = None
    if "--map" in argv:
        k = argv.index("--map")
        if k + 1 >= len(argv):
            print("사용: --map <final.tsv>")
            return 2
        map_path = argv[k + 1]

    fails = []

    # --- base 문서 집합 -------------------------------------------------------------------
    r = subprocess.run(["git", "ls-tree", "-r", "--name-only", base, "ui/src"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"FAIL [setup] git ls-tree {base} ui/src 실패: {r.stderr.strip()}")
        return 1
    base_docs = ["ui/CLAUDE.md"] + sorted(p for p in r.stdout.split("\n") if p.endswith("/CLAUDE.md"))
    base_text = {}
    for d in base_docs:
        t = at(base, d)
        if t is None:
            print(f"FAIL [setup] {base}:{d} 를 읽을 수 없다")
            return 1
        base_text[d] = t.split("\n")

    # 사전조건: base 대상 줄 유일
    seen = defaultdict(list)
    for d in base_docs:
        for i, l in enumerate(base_text[d], 1):
            if is_bullet(l):
                seen[l].append(f"{d}:{i}")
    dups = {l: locs for l, locs in seen.items() if len(locs) > 1}
    for l, locs in dups.items():
        fails.append(f"FAIL [D3] base 불릿 중복(사전조건): {' · '.join(locs)} {l[:50]}")

    # --- manifest 치환 키 ((file, 1-based 줄) → [(manifest, kind, pairs)]) ------------------
    keyed = defaultdict(list)
    n_rows = 0
    for mpath, src in MANIFESTS:
        for cols in read_rows(mpath):
            kind = cols[0]
            if kind not in ("relocate", "refix") or len(cols) < 5:
                continue
            n_rows += 1
            anchor = cols[1]
            pairs = list(zip(cols[5::2], cols[6::2]))
            if kind == "relocate":
                f = src
                lines = base_text.get(f)
                if lines is None:
                    t = at(base, f)
                    lines = t.split("\n") if t is not None else []
                hits = [i for i, l in enumerate(lines, 1) if l.startswith("- ") and anchor in l]
            else:
                f = cols[2]
                lines = base_text.get(f)
                if lines is None:
                    t = at(base, f)
                    lines = t.split("\n") if t is not None else []
                hits = [i for i, l in enumerate(lines, 1) if anchor in l]
            if len(hits) != 1:
                # 위치 특정 불가는 coverage 게이트의 FAIL 몫 — 여기선 치환을 적용하지 않는다
                # (치환이 있는 행이면 그 불릿은 아래에서 미귀속으로 드러난다).
                print(f"WARN [D3] {mpath} {kind} 행 위치 특정 불가({len(hits)}줄): {f} ← {anchor[:50]}")
                continue
            keyed[(f, hits[0])].append((mpath, kind, pairs))

    multi = {key for key, v in keyed.items() if len(v) > 1}
    for (f, i) in sorted(multi):
        fails.append(f"FAIL [D3] 한 줄에 치환 행 2개 이상({len(keyed[(f, i)])}개): {f}:{i}")

    # --- 현재 문서 집합에서 정확히 1회 -----------------------------------------------------
    cur_docs = (["ui/CLAUDE.md"] if pathlib.Path("ui/CLAUDE.md").exists() else []) \
        + sorted(glob.glob("ui/src/**/CLAUDE.md", recursive=True))
    cur_count = Counter()
    for d in cur_docs:
        cur_count.update(pathlib.Path(d).read_text().split("\n"))

    n_bullets = sum(len(v) for v in seen.values())
    if not dups:                 # 중복이 있으면 '정확히 1회'가 정의되지 않는다 — 사전조건 FAIL로 끝
        for d in base_docs:
            for i, l in enumerate(base_text[d], 1):
                if not is_bullet(l):
                    continue
                if (d, i) in multi:
                    continue
                want = l
                for _m, _k, pairs in keyed.get((d, i), []):
                    for old, new in pairs:
                        want = want.replace(old, new, 1)
                n = cur_count[want]
                if n == 0:
                    fails.append(f"FAIL [D3] 미귀속: {d}:{i} {l[:50]}")
                elif n > 1:
                    fails.append(f"FAIL [D3] 중복 귀속({n}회): {d}:{i} {l[:50]}")

    # --- D4 -----------------------------------------------------------------------------
    n_moves = 0
    if map_path is not None:
        mp = pathlib.Path(map_path)
        if not mp.exists():
            fails.append(f"FAIL [D4] map 파일 없음: {map_path}")
        else:
            for ln, l in enumerate(mp.read_text().split("\n"), 1):
                l = l.rstrip("\r")
                if not l.strip() or l.startswith("#"):
                    continue
                c = l.split("\t")
                if c[0] == "src_file":          # 헤더
                    continue
                if len(c) < 7:
                    fails.append(f"FAIL [D4] map 행 컬럼 {len(c)}개(7 이상이어야 함): {map_path}:{ln}")
                    continue
                src, sline, dest, sites = c[0], c[1], c[5], c[6]
                if dest in NON_MOVE:
                    continue
                n_moves += 1
                site_list = [s.strip() for s in sites.split(",") if s.strip() and s.strip() != "-"]
                if not site_list:
                    fails.append(f"FAIL [D4] 이동 행에 mistake_sites 없음: {src}:{sline}")
                    continue
                prefix = os.path.dirname(dest) + "/"
                for s in site_list:
                    if not s.startswith(prefix):
                        fails.append(f"FAIL [D4] mistake_site가 목적지 밖: {src}:{sline} {s}")

    for f in fails:
        print(f)
    d4 = f" · D4 이동 행 {n_moves}개" if map_path is not None else ""
    print(f"\n{'FAIL' if fails else 'OK'}: base 불릿 {n_bullets}줄(문서 {len(base_docs)}개 → 현재 "
          f"{len(cur_docs)}개) · 치환 행 {n_rows}개{d4}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
