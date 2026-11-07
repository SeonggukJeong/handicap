#!/usr/bin/env python3
"""D7 미선언 참조 탐지 — ① § 해석(작업트리 ui 문서 전체) + ② 판정 커버리지.

사용: check-doc-refs.py <base> <adjudication.tsv>

① § 해석 — 작업트리 `ui/CLAUDE.md` + `ui/src/**/CLAUDE.md`의 모든 `§`에 대해:
   - 참조 범위: `§` 바로 뒤가 `"`면 닫는 `"`까지(따옴표 제거), 아니면 첫 `(`·`)`·`,` 또는
     줄 끝까지를 trim.
   - 범위가 숫자 또는 `[A-Z]\\d`로 시작하면(spec·roadmap 번호) 기계 대조에서 제외.
   - 대상 헤딩(`##` 이상, h1 제외): `§` 앞에 `.md` 경로가 있으면(사이 backtick·공백 허용) 그
     파일의 헤딩, 아니면 ui 문서 전부의 헤딩.
   - 일치: (a) 헤딩 짧은 제목(첫 ` (`·` /` 앞)이 범위의 접두사(조사 꼬리 허용) 또는
     (b) 범위가 헤딩 전체의 접두사. 실패 = `FAIL [D7] § 해석 실패: <file>:<line> <범위>`.
② 판정 커버리지 — 두 manifest(활성 = 소스 `ui/CLAUDE.md`, `.compare` = `ui/src/compare/CLAUDE.md`)의
   relocate·refix 대상 줄의 **base 텍스트**에서 PATTERN 매치마다 adjudication TSV에
   (file, anchor, match) 행이 있어야 한다. 없으면 `FAIL [D7] 미판정: <file>:<line> <match>`.
   대상 줄에 쓰이지 않은 adjudication 행은 FAIL도 아니고 `판정` 수에도 넣지 않는다.
   manifest 파일이 없으면 0행.
   범위 축소: 잔류 줄이 옮겨진 내용을 가리키는 경우는 ②의 기계 대상이 아니다(final TSV `# (c)`
   STAY lines 판정 + refix.tsv로 처리 — 리뷰 대상).
TSV는 전부 `split('\\t')`(csv 모듈 금지 — `"`로 시작하는 anchor·match를 벗긴다).
"""
import glob
import pathlib
import re
import subprocess
import sys

MANIFESTS = [
    ("scripts/doc-move-manifest.tsv", "ui/CLAUDE.md"),
    ("scripts/doc-move-manifest.compare.tsv", "ui/src/compare/CLAUDE.md"),
]
PATTERN = re.compile(r'(?<![\w가-힣])(위 |아래 |이 섹션|위쪽|아래쪽)|§[^\s,)·(]+|"[^"]+" 섹션')
# `##` 이상만 — h1(문서 제목, 예 `# UI (`ui/`) 함정`)은 짧은 제목이 `UI`처럼 퇴화해
# "UI"로 시작하는 모든 범위를 (a)로 공허하게 해석시키므로 대조 대상에서 뺀다.
HEADING = re.compile(r"(?m)^#{2,6}[ \t]+(.+?)[ \t]*$")
MD_BEFORE = re.compile(r"([A-Za-z0-9_./-]+\.md)[`\s]*$")
EXCLUDED = re.compile(r"\d|[A-Z]\d")


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


def ref_range(rest):
    """`§` 뒤 문자열 → 참조 범위."""
    if rest.startswith('"'):
        j = rest.find('"', 1)
        return rest[1:j] if j > 0 else rest[1:]
    return re.match(r"[^(),]*", rest).group(0).strip()


def short_title(h):
    cut = [k for k in (h.find(" ("), h.find(" /")) if k >= 0]
    return h[:min(cut)] if cut else h


def matches(rng, headings):
    if not rng:
        return False
    return any(rng.startswith(short_title(h)) or h.startswith(rng) for h in headings)


def headings_of(text):
    return HEADING.findall(text)


def main(argv):
    if len(argv) < 3:
        print("사용: check-doc-refs.py <base> <adjudication.tsv>")
        return 2
    base, adj_path = argv[1], argv[2]
    fails = []

    # --- ① § 해석 -----------------------------------------------------------------------
    docs = (["ui/CLAUDE.md"] if pathlib.Path("ui/CLAUDE.md").exists() else []) \
        + sorted(glob.glob("ui/src/**/CLAUDE.md", recursive=True))
    texts = {d: pathlib.Path(d).read_text() for d in docs}
    ui_headings = [h for d in docs for h in headings_of(texts[d])]
    n_resolved = n_excluded = 0
    for d in docs:
        for ln, line in enumerate(texts[d].split("\n"), 1):
            for m in re.finditer("§", line):
                rng = ref_range(line[m.end():])
                if EXCLUDED.match(rng):
                    n_excluded += 1
                    continue
                md = MD_BEFORE.search(line[:m.start()])
                if md:
                    cands = [pathlib.Path(md.group(1)), pathlib.Path(d).parent / md.group(1)]
                    found = next((p for p in cands if p.is_file()), None)
                    if found is None:
                        fails.append(f"FAIL [D7] § 해석 실패: {d}:{ln} {rng} "
                                     f"(대상 파일 없음: {md.group(1)})")
                        continue
                    heads = headings_of(found.read_text())
                else:
                    heads = ui_headings
                if matches(rng, heads):
                    n_resolved += 1
                else:
                    fails.append(f"FAIL [D7] § 해석 실패: {d}:{ln} {rng}")

    # --- ② 판정 커버리지 ------------------------------------------------------------------
    adj = set()
    ap = pathlib.Path(adj_path)
    if not ap.exists():
        fails.append(f"FAIL [D7] adjudication 파일 없음: {adj_path}")
    else:
        for l in ap.read_text().split("\n"):
            l = l.rstrip("\r")
            if not l.strip() or l.startswith("#"):
                continue
            c = l.split("\t")
            if c[0] == "file" or len(c) < 3:     # 헤더 · 불완전 행
                continue
            adj.add((c[0], c[1], c[2]))

    used, n_matches, n_rows = set(), 0, 0
    for mpath, src in MANIFESTS:
        for cols in read_rows(mpath):
            kind = cols[0]
            if kind not in ("relocate", "refix") or len(cols) < 3:
                continue
            n_rows += 1
            anchor = cols[1]
            f = src if kind == "relocate" else cols[2]
            t = at(base, f)
            lines = t.split("\n") if t is not None else []
            # 위치 특정(정확히 1줄)은 coverage 게이트 몫 — 여기선 매치를 놓치지 않도록 해당 줄 전부
            hits = [(i, l) for i, l in enumerate(lines, 1)
                    if anchor in l and (kind == "refix" or l.startswith("- "))]
            for i, l in hits:
                for mm in PATTERN.finditer(l):
                    n_matches += 1
                    key = (f, anchor, mm.group(0))
                    if key in adj:
                        used.add(key)
                    else:
                        fails.append(f"FAIL [D7] 미판정: {f}:{i} {mm.group(0)}")

    for f in fails:
        print(f)
    # 접두 `OK: § 해석 <N> · 판정 <J>`(숫자 뒤 단위 없음)는 plan Task 4 기대 문구 — 바꾸지 말 것
    print(f"\n{'FAIL' if fails else 'OK'}: § 해석 {n_resolved} · 판정 {len(used)} · "
          f"번호 제외 {n_excluded}건 · 대상 행 {n_rows}개 · 패턴 적중 {n_matches}건 · "
          f"미사용 판정 {len(adj) - len(used)}행")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
