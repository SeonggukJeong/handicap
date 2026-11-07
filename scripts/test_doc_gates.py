#!/usr/bin/env python3
"""문서 이동 게이트 자체 테스트 — check-doc-coverage.py(relocate·refix·보조 manifest·corpus)
+ check-bullet-conservation.py(D3·D4) + check-doc-refs.py(D7).

각 케이스는 `tempfile.TemporaryDirectory()` 안에 진짜 git 저장소를 만들고(base fixture 커밋),
작업트리를 변형한 뒤 대상 스크립트를 **절대경로 · cwd=<tmp>**로 실행해 FAIL 접두 포함/불포함과
종료코드를 단언한다. base ref는 `HEAD`(변형은 커밋하지 않는다).

실행: `python3 scripts/test_doc_gates.py` (또는 `just doc-gates-selftest`) → `OK: 케이스 15/15`.
Python 3 표준 라이브러리만 쓴다. TSV는 `split('\\t')` 규약(csv 모듈 금지)을 따르도록 fixture도 탭으로 쓴다.
"""
import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
COVERAGE = HERE / "check-doc-coverage.py"
CONSERVE = HERE / "check-bullet-conservation.py"
REFS = HERE / "check-doc-refs.py"

T = "\t"

# --- base fixture ---------------------------------------------------------------------------
# 줄 번호(1-based)를 케이스가 단언에 쓴다: a1=5, a2=6(연속 줄 7), b1=11, b2=12, r1=16, 마지막 줄=20.
BASE_UI = "\n".join([
    "# UI 함정",                                   # 1
    "",                                            # 2
    "## 빌드 게이트",                               # 3
    "",                                            # 4
    "- a1 `tokA` 첫 불릿",                          # 5
    "- a2 `tokB` 연속 줄 있는 불릿",                 # 6
    "  - a2 하위 `tokC`",                           # 7
    "",                                            # 8
    "## 폼·입력 UX (RunDialog)",                    # 9
    "",                                            # 10
    "- b1 `tokD` 위 a1 참조",                       # 11
    "- b2 `tokE` 폼 불릿 둘 §B7",                   # 12
    "",                                            # 13
    "## 다단계 ramp UI (stages)",                   # 14
    "",                                            # 15
    "- r1 `tokH` 램프 불릿",                        # 16
    "",                                            # 17
    "## 메모 (불릿 없음)",                          # 18 — 불릿 0 섹션: 바닥 0이지만 relocate 무관
    "",                                            # 19
    "본문 문단만 있는 섹션",                         # 20
]) + "\n"

BASE_COMPARE = "\n".join([
    "# compare 함정",                               # 1
    "",                                            # 2
    "## 비교",                                      # 3
    "",                                            # 4
    "- c1 `tokF` 비교 불릿",                        # 5
    "- c2 `tokG` 비교 둘",                          # 6
]) + "\n"

A1 = "- a1 `tokA` 첫 불릿"
A2 = "- a2 `tokB` 연속 줄 있는 불릿"
A2SUB = "  - a2 하위 `tokC`"
B1 = "- b1 `tokD` 위 a1 참조"
B1_SUB = "- b1 `tokD` `ui/CLAUDE.md` a1 참조"      # 치환(위 a1 참조 ⟶ `ui/CLAUDE.md` a1 참조) 적용본
B2 = "- b2 `tokE` 폼 불릿 둘 §B7"
C1 = "- c1 `tokF` 비교 불릿"
C2 = "- c2 `tokG` 비교 둘"
RUN = "ui/src/components/run/CLAUDE.md"

ROW_A1 = T.join(["relocate", "a1 `tokA`", RUN, "-", "0"])
ROW_B1 = T.join(["relocate", "b1 `tokD`", RUN, "-", "0", "위 a1 참조", "`ui/CLAUDE.md` a1 참조"])
ROW_B2 = T.join(["relocate", "b2 `tokE`", RUN, "-", "0"])


def git(tmp, *args):
    subprocess.run(["git", *args], cwd=tmp, check=True, capture_output=True, text=True)


def write(tmp, rel, text):
    p = pathlib.Path(tmp) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def read(tmp, rel):
    return (pathlib.Path(tmp) / rel).read_text()


def make_repo(tmp):
    write(tmp, "ui/CLAUDE.md", BASE_UI)
    write(tmp, "ui/src/compare/CLAUDE.md", BASE_COMPARE)
    write(tmp, "scripts/doc-coverage-allowlist.txt", "")
    git(tmp, "init", "-q")
    git(tmp, "add", "-A")
    git(tmp, "-c", "user.name=t", "-c", "user.email=t", "-c", "commit.gpgsign=false",
        "commit", "-q", "-m", "base")


def manifest(tmp, *rows, path="scripts/doc-move-manifest.tsv"):
    write(tmp, path, "# fixture manifest\n" + "".join(r + "\n" for r in rows))


def drop_lines(tmp, rel, *lines):
    keep = [l for l in read(tmp, rel).split("\n") if l not in lines]
    write(tmp, rel, "\n".join(keep))


def run(tmp, script, *args):
    r = subprocess.run([sys.executable, str(script), *args], cwd=tmp,
                       capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def case1_tree(tmp):
    """정상 relocate: a1(치환 0) + b1(치환 1) → run/CLAUDE.md."""
    drop_lines(tmp, "ui/CLAUDE.md", A1, B1)
    write(tmp, RUN, "# run 함정\n\n" + A1 + "\n" + B1_SUB + "\n")
    manifest(tmp, ROW_A1, ROW_B1)


class Check:
    def __init__(self):
        self.errs = []

    def has(self, out, phrase):
        if phrase not in out:
            self.errs.append(f"기대 문구 없음: {phrase!r}")

    def lacks(self, out, phrase):
        if phrase in out:
            self.errs.append(f"금지 문구 있음: {phrase!r}")

    def exit(self, code, want):
        if code != want:
            self.errs.append(f"exit {code} (기대 {want})")

    def true(self, cond, msg):
        if not cond:
            self.errs.append(msg)


def cov(tmp, *extra):
    return run(tmp, COVERAGE, "HEAD", "ui/CLAUDE.md", *extra)


# --- cases ----------------------------------------------------------------------------------

def c01(tmp, k):
    case1_tree(tmp)
    code, out = cov(tmp)
    k.exit(code, 0)
    k.lacks(out, "FAIL")
    return out


def c02(tmp, k):
    case1_tree(tmp)
    write(tmp, RUN, read(tmp, RUN).replace(A1, A1 + "x"))       # 목적지 1 B 변조
    code, out = cov(tmp)
    k.exit(code, 1)
    k.has(out, "FAIL [relocate] 목적지에 치환 적용 줄 없음")
    return out


def c03(tmp, k):
    case1_tree(tmp)
    write(tmp, "ui/CLAUDE.md", read(tmp, "ui/CLAUDE.md").replace(A2, A1 + "\n" + A2))  # 소스 부활
    code, out = cov(tmp)
    k.exit(code, 1)
    k.has(out, "FAIL [relocate] 소스에 원 줄 잔존")
    return out


def c04(tmp, k):
    case1_tree(tmp)
    manifest(tmp, ROW_B1)                                         # a1 relocate 행 삭제
    code, out = cov(tmp)
    k.exit(code, 1)
    k.has(out, "FAIL [R17]")
    return out


def c05(tmp, k):
    case1_tree(tmp)
    manifest(tmp, ROW_A1, T.join(["relocate", "b1 `tokD`", RUN, "-", "0"]))  # 치환 미선언
    code, out = cov(tmp)
    k.exit(code, 1)
    k.has(out, "FAIL [relocate] 목적지에 치환 적용 줄 없음")
    return out


def c06(tmp, k):
    case1_tree(tmp)
    spec = importlib.util.spec_from_file_location("check_doc_coverage", COVERAGE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    old = os.getcwd()
    os.chdir(tmp)
    try:
        paths = mod.corpus_paths()
    finally:
        os.chdir(old)
    k.true(RUN in paths, f"corpus_paths()에 {RUN} 없음: {paths}")
    return repr(paths)


def c07(tmp, k):
    drop_lines(tmp, "ui/CLAUDE.md", A2, A2SUB)
    write(tmp, RUN, "# run 함정\n\n" + A2 + "\n" + A2SUB + "\n")
    manifest(tmp, T.join(["relocate", "a2 `tokB`", RUN, "-", "0"]))
    code, out = cov(tmp)
    k.exit(code, 1)
    k.has(out, "FAIL [relocate] 연속 줄 가진 불릿")
    return out


def c08(tmp, k):
    case1_tree(tmp)
    manifest(tmp, ROW_A1, T.join(["relocate", "b1 `tokD`", RUN, "-", "0", "위 a1 참조"]))
    code, out = cov(tmp)
    k.exit(code, 1)
    k.has(out, "FAIL [manifest] 컬럼 6개(relocate:")
    return out


def c09(tmp, k):
    case1_tree(tmp)
    manifest(tmp, ROW_A1, T.join(["relocate", "b1 `tokD`", RUN, "-", "0",
                                   "없는 문자열", "`ui/CLAUDE.md` a1 참조"]))
    code, out = cov(tmp)
    k.exit(code, 1)
    k.has(out, "FAIL [relocate] 치환 old 0회")
    return out


def c10(tmp, k):
    # 섹션 통째 relocate + 헤딩 삭제 → R17 실종 면제
    drop_lines(tmp, "ui/CLAUDE.md", B1, B2, "## 폼·입력 UX (RunDialog)")
    write(tmp, RUN, "# run 함정\n\n" + B1_SUB + "\n" + B2 + "\n")
    manifest(tmp, ROW_B1, ROW_B2)
    code, out = cov(tmp)
    k.exit(code, 0)
    k.lacks(out, "[R17]")
    # 면제는 relocate가 바닥을 0으로 '만든' 섹션만 — 원래 불릿 0인 섹션 삭제는 기존대로 실종 FAIL
    drop_lines(tmp, "ui/CLAUDE.md", "## 메모 (불릿 없음)")
    code2, out2 = cov(tmp)
    k.exit(code2, 1)
    k.has(out2, "FAIL [R17] '## 메모 (불릿 없음)' 섹션이 작업트리에서 실종")
    k.lacks(out2, "폼·입력 UX (RunDialog)' 섹션")
    return out + "\n---\n" + out2


def c11(tmp, k):
    row = T.join(["refix", "c2 `tokG`", "ui/src/compare/CLAUDE.md", "-", "0", "비교 둘", "비교 둘(고침)"])
    fixed = "- c2 `tokG` 비교 둘(고침)"
    manifest(tmp, row)
    cmp = "ui/src/compare/CLAUDE.md"
    write(tmp, cmp, read(tmp, cmp).replace(C2, fixed))
    code1, out1 = cov(tmp)
    k.exit(code1, 0)
    k.lacks(out1, "FAIL")
    write(tmp, cmp, read(tmp, cmp).replace(fixed, fixed + "\n" + C2))     # 원 줄 잔존
    code2, out2 = cov(tmp)
    k.exit(code2, 1)
    k.has(out2, "FAIL [refix] 원 줄 잔존")
    return out1 + "\n---\n" + out2


def c12(tmp, k):
    cmp = "ui/src/compare/CLAUDE.md"
    drop_lines(tmp, cmp, C1)
    write(tmp, RUN, "# run 함정\n\n" + C1 + "\n")
    manifest(tmp, T.join(["relocate", "c1 `tokF`", RUN, "-", "0"]),
             path="scripts/doc-move-manifest.compare.tsv")
    # 활성 manifest에는 깨진 행 — 3번째 인자를 무시하면 이 행 때문에 FAIL한다
    manifest(tmp, T.join(["relocate", "없는 앵커", RUN, "-", "0"]))
    code, out = run(tmp, COVERAGE, "HEAD", cmp, "scripts/doc-move-manifest.compare.tsv")
    k.exit(code, 0)
    k.lacks(out, "FAIL")
    k.has(out, "manifest 1행")
    # 빈 문자열 3번째 인자 = 활성 manifest(Justfile 빈 MANIFEST 통과)
    code2, out2 = run(tmp, COVERAGE, "HEAD", cmp, "")
    k.exit(code2, 1)
    k.has(out2, "FAIL [relocate] base 불릿 0개(1이어야 함)")
    return out + "\n---\n" + out2


def c13(tmp, k):
    outs = []
    case1_tree(tmp)
    code, out = run(tmp, CONSERVE, "HEAD")                         # 정상 → OK
    k.exit(code, 0)
    k.lacks(out, "FAIL")
    outs.append(out)
    # 미귀속: 목적지에서 a1 줄 삭제
    write(tmp, RUN, read(tmp, RUN).replace(A1 + "\n", ""))
    code, out = run(tmp, CONSERVE, "HEAD")
    k.exit(code, 1)
    k.has(out, "FAIL [D3] 미귀속: ui/CLAUDE.md:5")
    outs.append(out)
    # 중복 귀속: 목적지 복원 + 소스에도 a1 잔존
    write(tmp, RUN, "# run 함정\n\n" + A1 + "\n" + B1_SUB + "\n")
    write(tmp, "ui/CLAUDE.md", read(tmp, "ui/CLAUDE.md").replace(A2, A1 + "\n" + A2))
    code, out = run(tmp, CONSERVE, "HEAD")
    k.exit(code, 1)
    k.has(out, "FAIL [D3] 중복 귀속(2회): ui/CLAUDE.md:5")
    outs.append(out)
    # 한 줄에 치환 행 2개: 두 manifest를 통틀어 b1 줄을 지목
    drop_lines(tmp, "ui/CLAUDE.md", A1)
    manifest(tmp, T.join(["refix", "b1 `tokD`", "ui/CLAUDE.md", "-", "0", "위", "아래"]),
             path="scripts/doc-move-manifest.compare.tsv")
    code, out = run(tmp, CONSERVE, "HEAD")
    k.exit(code, 1)
    k.has(out, "FAIL [D3] 한 줄에 치환 행 2개")
    outs.append(out)
    return "\n---\n".join(outs)


def c14(tmp, k):
    case1_tree(tmp)
    hdr = T.join(["src_file", "line", "kind", "bytes", "anchor", "dest_file",
                  "mistake_sites", "substitutions", "reason"])
    good = [
        hdr,
        "# 주석 행",
        T.join(["ui/CLAUDE.md", "5", "bullet", "1", "a1", RUN,
                "ui/src/components/run/RunDialog.tsx,ui/src/components/run/__tests__/x.test.tsx", "-", "r"]),
        T.join(["ui/CLAUDE.md", "6", "bullet", "1", "a2", "STAY", "ui/src/pages/Y.tsx", "-", "r"]),
        T.join(["ui/src/compare/CLAUDE.md", "5", "bullet", "1", "c1", "ui/CLAUDE.md",
                "ui/src/api/client.ts", "-", "r"]),
    ]
    write(tmp, "map.tsv", "\n".join(good) + "\n")
    code1, out1 = run(tmp, CONSERVE, "HEAD", "--map", "map.tsv")
    k.exit(code1, 0)
    k.lacks(out1, "FAIL")
    bad = good + [T.join(["ui/CLAUDE.md", "11", "bullet", "1", "b1", RUN,
                          "ui/src/components/run/RunDialog.tsx,ui/src/pages/X.tsx", "-", "r"])]
    write(tmp, "map.tsv", "\n".join(bad) + "\n")
    code2, out2 = run(tmp, CONSERVE, "HEAD", "--map", "map.tsv")
    k.exit(code2, 1)
    k.has(out2, "FAIL [D4] mistake_site가 목적지 밖: ui/CLAUDE.md:11 ui/src/pages/X.tsx")
    k.lacks(out2, "RunDialog.tsx")
    return out1 + "\n---\n" + out2


def c15(tmp, k):
    extra = [
        "- z1 약어 참조(위 §폼 UX) 끝",                      # 21 → 해석 실패
        "- z2 따옴표 참조 §\"폼·입력 UX\"의 노트",            # 22 → 일치
        "- z3 b-only §\"폼·입력\" 노트",                     # 23 → 일치(b)
        "- z4 조사 꼬리 §다단계 ramp UI의 `Pick<P,…>` 패턴",  # 24 → 일치(a)
        "- z5 파일 지정 `x.md` §헤딩 하나의 내용",            # 25 → x.md 대조 일치
        "- z6 파일 지정 오대조 `x.md` §빌드 게이트 항목",      # 26 → x.md엔 없음 → 실패
        "- z7 번호 제외 §4.1 · §B12 참조",                   # 27 → 제외
    ]
    write(tmp, "ui/CLAUDE.md", read(tmp, "ui/CLAUDE.md") + "\n".join(extra) + "\n")
    write(tmp, "x.md", "# X 문서\n\n## 헤딩 하나 (설명)\n\n본문\n")
    manifest(tmp, ROW_B1, ROW_B2)
    adj = [
        "# 판정 fixture",
        T.join(["file", "anchor", "match", "verdict", "reason"]),
        T.join(["ui/CLAUDE.md", "b2 `tokE`", "§B7", "true", "roadmap 번호"]),
        T.join(["ui/CLAUDE.md", "미사용 앵커", "위 ", "subst", "미사용 행 — FAIL 아님"]),
    ]
    write(tmp, "adj.tsv", "\n".join(adj) + "\n")
    code, out = run(tmp, REFS, "HEAD", "adj.tsv")
    k.exit(code, 1)
    fails = [l for l in out.split("\n") if l.startswith("FAIL [D7] § 해석 실패")]
    want = ["FAIL [D7] § 해석 실패: ui/CLAUDE.md:21 폼 UX",
            "FAIL [D7] § 해석 실패: ui/CLAUDE.md:26 빌드 게이트 항목"]
    k.true(fails == want, f"§ 해석 실패 줄 {fails} (기대 {want})")
    miss = [l for l in out.split("\n") if l.startswith("FAIL [D7] 미판정")]
    k.true(len(miss) == 1 and miss[0].startswith("FAIL [D7] 미판정: ui/CLAUDE.md:11 위"),
           f"미판정 줄 {miss} (기대 ui/CLAUDE.md:11 위 1건)")
    return out


CASES = [c01, c02, c03, c04, c05, c06, c07, c08, c09, c10, c11, c12, c13, c14, c15]


def main():
    passed = 0
    for i, fn in enumerate(CASES, 1):
        k = Check()
        with tempfile.TemporaryDirectory() as tmp:
            make_repo(tmp)
            try:
                out = fn(tmp, k)
            except Exception as e:  # 크래시도 판정 대상 — RED로 집계
                k.errs.append(f"예외: {type(e).__name__}: {e}")
                out = ""
        if k.errs:
            print(f"FAIL 케이스 {i} ({fn.__name__}): " + " · ".join(k.errs))
            for l in (out or "").strip().split("\n")[:12]:
                print(f"    | {l}")
        else:
            passed += 1
            print(f"PASS 케이스 {i} ({fn.__name__})")
    total = len(CASES)
    print(f"\n{'OK' if passed == total else 'FAIL'}: 케이스 {passed}/{total}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
