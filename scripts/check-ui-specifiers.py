#!/usr/bin/env python3
"""ui/src 소스 이동 검증 도구 (V1 compare · V2 identity · V3 testset).

snapshot <out.json>                  : 상대 지정자 -> 해석 대상 스냅샷
compare <base.json> <move.tsv>       : V1 (이동 사상 후 현재 snapshot과 비교)
identity <base-ref> <move.tsv>       : V2 (지정자 스팬만 마스킹 후 byte 비교)
testset <base.json> <now.json>       : V3 (vitest json 다중집합 비교)
"""
import json
import os
import re
import subprocess
import sys
from collections import Counter

PATTERNS = [
    re.compile(r"""from\s+(['"])(\.{1,2}/[^'"]+)\1"""),
    re.compile(r"""import\(\s*(['"])(\.{1,2}/[^'"]+)\1"""),
    re.compile(r"""vi\.(?:mock|importActual|doMock)\(\s*(['"])(\.{1,2}/[^'"]+)\1"""),
]
ROOT = "ui/src"


def read_table(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    for line in lines[1:]:
        if line:
            parts = line.split("\t")
            rows.append((parts[0], parts[1]))
    return rows


def spans(text):
    out = {}
    for pat in PATTERNS:
        for m in pat.finditer(text):
            out[m.span(2)] = m.group(2)
    return sorted(out.items())


def resolve(file, spec):
    base = os.path.normpath(os.path.join(os.path.dirname(file), spec))
    for cand in (base, base + ".ts", base + ".tsx", base + "/index.ts", base + "/index.tsx"):
        if os.path.isfile(cand):
            return cand
    return None


def ui_files():
    for d, _, fs in os.walk(ROOT):
        for f in sorted(fs):
            if f.endswith((".ts", ".tsx")):
                yield os.path.join(d, f)


def snapshot():
    snap = {}
    for p in sorted(ui_files()):
        with open(p, encoding="utf-8") as f:
            lines = f.read().split("\n")
        for i, line in enumerate(lines, 1):
            for k, (_, spec) in enumerate(spans(line)):
                snap[f"{p}:{i}:{k}"] = {"spec": spec, "target": resolve(p, spec)}
    return snap


def split_key(key):
    f, ln, k = key.rsplit(":", 2)
    return f, ln, k


def cmd_snapshot(out):
    snap = snapshot()
    with open(out, "w", encoding="utf-8") as f:
        json.dump(snap, f, indent=1, sort_keys=True, ensure_ascii=False)
    print(f"snapshot: 지정자 {len(snap)}개 -> {out}")


def cmd_compare(base_json, table):
    mv = dict(read_table(table))
    with open(base_json, encoding="utf-8") as f:
        base = json.load(f)
    now = snapshot()
    fails = 0
    mapped = {}
    for key, v in base.items():
        f, ln, k = split_key(key)
        nkey = f"{mv.get(f, f)}:{ln}:{k}"
        t = v["target"]
        mapped[nkey] = (key, mv.get(t, t) if t else t)
    for key, v in now.items():
        if v["target"] is None:
            print(f"FAIL [V1] 미해석: {key} {v['spec']}")
            fails += 1
    for nkey, (okey, t1) in mapped.items():
        if nkey not in now:
            print(f"FAIL [V1] 키 누락: {nkey}")
            fails += 1
            continue
        t2 = now[nkey]["target"]
        if t2 is not None and t1 != t2:
            print(f"FAIL [V1] 대상 불일치: {nkey} base={t1} now={t2}")
            fails += 1
    for key in now:
        if key not in mapped:
            print(f"FAIL [V1] 키 추가: {key}")
            fails += 1
    if fails:
        print(f"FAIL: {fails}건")
        sys.exit(1)
    print(f"OK: 지정자 {len(now)}개")


def mask(text):
    out = text
    for (s, e), _ in reversed(spans(text)):
        out = out[:s] + "§SPEC§" + out[e:]
    return out


def git_show(ref, path):
    r = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True)
    if r.returncode != 0:
        return None
    return r.stdout.decode("utf-8")


def cmd_identity(ref, table):
    rows = read_table(table)
    moved = {p for r in rows for p in r}
    fails = 0

    def check(old, new):
        nonlocal fails
        a = git_show(ref, old)
        try:
            with open(new, encoding="utf-8") as f:
                b = f.read()
        except OSError:
            b = None
        if a is None or b is None or mask(a) != mask(b):
            print(f"FAIL [V2] 내용 변경: {new}")
            fails += 1

    for old, new in rows:
        check(old, new)
    r = subprocess.run(["git", "diff", "--name-only", ref, "--", ROOT], capture_output=True, text=True, check=True)
    others = [p for p in r.stdout.split("\n") if p and p not in moved]
    for p in others:
        check(p, p)
    if fails:
        print(f"FAIL: {fails}건")
        sys.exit(1)
    print(f"OK: 이동 {len(rows)} · 소비처 {len(others)}")


def testmulti(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    c = Counter()
    for tr in d["testResults"]:
        b = os.path.basename(tr["name"])
        for a in tr["assertionResults"]:
            c[(b, a["fullName"], a["status"])] += 1
    return c, len(d["testResults"])


def cmd_testset(base, now):
    cb, _ = testmulti(base)
    cn, fn = testmulti(now)
    fails = 0
    for k, n in (cb - cn).items():
        print(f"FAIL [V3] 사라짐: {k} x{n}")
        fails += 1
    for k, n in (cn - cb).items():
        print(f"FAIL [V3] 생김: {k} x{n}")
        fails += 1
    if fails:
        print(f"FAIL: {fails}건")
        sys.exit(1)
    print(f"OK: 파일 {fn} · 테스트 {sum(cn.values())}")


def main():
    a = sys.argv[1:]
    if len(a) == 2 and a[0] == "snapshot":
        cmd_snapshot(a[1])
    elif len(a) == 3 and a[0] == "compare":
        cmd_compare(a[1], a[2])
    elif len(a) == 3 and a[0] == "identity":
        cmd_identity(a[1], a[2])
    elif len(a) == 3 and a[0] == "testset":
        cmd_testset(a[1], a[2])
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
