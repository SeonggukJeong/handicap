#!/usr/bin/env python3
"""이동 검증: manifest(move·merge·relocate·refix) + 불릿 개수 비감소(R17 — 섹션은 base 소스의
`## ` 헤딩에서 동적 도출) + baseline 조건(R18) + 토큰 차분.

사용: check-doc-coverage.py <base> [source] [manifest]
  manifest를 생략하거나 빈 문자열이면 활성 `scripts/doc-move-manifest.tsv`(Justfile 빈 MANIFEST 통과).
  이름 규약: 점 접미(`doc-move-manifest.compare.tsv`) = 활성 보조 manifest, 대시 slug = 이력.

kind별 컬럼(TAB 구분):
  move·merge  : 5컬럼 고정 `kind anchor dest_file marker gain`
  relocate    : 5+2k(k≥0) `relocate anchor dest_file - 0 [old new]*` — 단일 줄 `- ` 불릿 통째 이동
  refix       : 5+2k(k≥1) `refix anchor file - 0 (old new)+` — 남는 줄(어느 문서든)의 참조 치환
"""
import re, subprocess, sys, pathlib, glob, ast
from collections import defaultdict

ROOT = "CLAUDE.md"
BUDGET = "scripts/check-doc-budget.py"
DEFAULT_MANIFEST = "scripts/doc-move-manifest.tsv"

# --- "검사 불능 = FAIL" 하한 (check-doc-budget.py의 BASELINES_MIN·L1_MIN_REFS와 자매 규약) ---
MANIFEST_MIN = 1        # 활성 manifest 최소 행 수. rename 후 새 파일 생성을 잊으면 0행이 된다.

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

def sections_of(text, needle, secs):
    """needle을 포함하는 불릿이 있는 secs 원소 '전부'(다중 매치를 호출부가 알 수 있게)."""
    return [s for s in secs if any(needle in l for l in bullets(text, s))]

def tokens(t):
    # backtick run을 구분자로 스팬을 길이 무관하게 짝 소비(1자·80자 초과가 짝을 밀어
    # 산문을 토큰으로 오인시키던 결함 제거), 토큰 '채택'만 2–80자로 유지.
    # 잔존 한계(줄 안 backtick 홀수·run-길이 불일치)는 root-doc-maintenance.md §재분배 절차 4단계(토큰 차분 함정).
    s = {m[1] for m in re.findall(r"(`+)([^`\n]*?)\1", t) if 2 <= len(m[1]) <= 80}
    s |= set(re.findall(r"docs/[A-Za-z0-9/_.-]+\.md", t))
    s |= set(re.findall(r"ADR-\d{4}", t))
    return s

def parse_baselines(text):
    """check-doc-budget.py 소스의 `BASELINES = {...}` **대입문**에서 {경로: 바이트}.

    ast로 대입 노드를 찾아 literal_eval 한다. 문자열 탐색(`text.find("BASELINES")`)은
    ① docstring/주석이 이름을 먼저 언급하면 엉뚱한 dict를 잡고
    ② 값에 중첩 dict가 있으면 첫 '}'에서 잘리며 내부 키까지 오염된다 — 둘 다 조용한 오답이다.
    값이 int가 아닌 항목(중첩 dict 등)은 baseline이 아니므로 버린다.

    `BASELINES = {...}`(Assign)과 `BASELINES: dict[str, int] = {...}`(AnnAssign)을 **둘 다** 받는다.
    읽지 못하면 `{}`인데 그건 R18을 무음으로 통과시키므로, 호출부가 빈 dict를 FAIL로 승격한다.
    """
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return {}
    for node in ast.walk(tree):
        value = None
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "BASELINES" for t in node.targets):
            value = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) \
                and node.target.id == "BASELINES":
            value = node.value              # 값 없는 선언(`BASELINES: dict`)이면 None
        if value is None:
            continue
        try:
            v = ast.literal_eval(value)     # dict(...)·컴프리헨션 등 비-리터럴은 ValueError
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
            + sorted(glob.glob("crates/*/CLAUDE.md"))
            # recursive=True 필수 — 없으면 `**`가 한 단계만 매치해 components/* 하위 문서를 놓친다.
            + sorted(glob.glob("ui/src/**/CLAUDE.md", recursive=True)))

def rows(path=DEFAULT_MANIFEST):
    """manifest 데이터 행을 탭 분할해 반환(컬럼 수 검증은 호출부). CRLF의 '\\r'은 벗긴다."""
    p = pathlib.Path(path)
    if not p.exists():
        return []
    out = []
    for l in p.read_text().split("\n"):
        l = l.rstrip("\r")          # 후행 '탭'은 벗기지 않는다 — 컬럼 수 오류로 잡혀야 한다
        if l.strip() and not l.startswith("#"):
            out.append(l.split("\t"))
    return out

def column_rule(kind, n):
    """kind별 컬럼 규칙을 어기면 기대 형식 문자열, 지키면 None(알 수 없는 kind는 호출부 몫)."""
    if kind in ("move", "merge"):
        return None if n == 5 else "5"
    if kind == "relocate":
        return None if n >= 5 and (n - 5) % 2 == 0 else "5+2k"
    if kind == "refix":
        return None if n >= 7 and (n - 5) % 2 == 0 else "5+2k, k≥1"
    return None

def apply_subs(line, pairs, tag, fails):
    """치환 (old, new)를 순서대로 적용. 각 old는 '적용 시점의 줄'에 정확히 1회여야 한다 —
    아니면 FAIL을 기록하고 None(호출부는 목적지 대조를 건너뛴다: 같은 원인의 중복 FAIL 방지)."""
    for old, new in pairs:
        n = line.count(old)          # 빈 old는 len+1회로 잡혀 FAIL — 의도된 동작
        if n != 1:
            fails.append(f"FAIL [{tag}] 치환 old {n}회(1이어야 함): {old[:50]}")
            return None
        line = line.replace(old, new, 1)
    return line

def section_of(text, line, secs):
    """line(불릿 원문)이 속한 base 섹션 — 없으면 None(첫 `## ` 앞 머리말)."""
    for s in secs:
        if line in bullets(text, s):
            return s
    return None

def main(base, src=ROOT, manifest_path=""):
    fails = []
    base_src = at(base, src)
    if base_src is None:
        print(f"FAIL [setup] {base}:{src} 를 읽을 수 없다"); return 1
    cur_src = pathlib.Path(src).read_text()
    # R17 섹션 동적 도출 — base 소스의 `## ` 헤딩 전부(오늘 실측: 펜스 안 `## ` 줄은
    # root·ui 양쪽 0건이라 raw regex로 충분 — section_span과 동일 raw-text 규약).
    secs_dyn = re.findall(r"(?m)^## (.+?)[ \t]*$", base_src)
    if not secs_dyn:
        fails.append(f"FAIL [R17] {base}:{src}에 '## ' 헤딩 0개 — 검사 불능")

    gain_need, merged_floor = defaultdict(int), defaultdict(int)
    relocated_floor = defaultdict(int)     # relocate ④ — base 섹션별 R17 바닥 인하량
    base_lines, cur_lines = base_src.split("\n"), cur_src.split("\n")
    manifest = rows(manifest_path or DEFAULT_MANIFEST)
    if len(manifest) < MANIFEST_MIN:
        fails.append("FAIL [manifest] 활성 manifest 0행 — 검사 불능"
                     "(rename 후 새 파일을 만들었나?)")

    for cols in manifest:
        # 컬럼 규칙 위반을 진단으로 승격 — 언패킹 ValueError(traceback)는 RED가 아니다
        rule = column_rule(cols[0], len(cols))
        if rule is not None:
            raw = "\t".join(cols)
            fails.append(f"FAIL [manifest] 컬럼 {len(cols)}개({cols[0]}: {rule}): {raw[:60]}")
            continue
        if cols[0] in ("relocate", "refix"):
            kind, anchor, target = cols[0], cols[1], cols[2]
            pairs = list(zip(cols[5::2], cols[6::2]))
        else:
            if len(cols) != 5:   # 알 수 없는 kind도 언패킹 전에 거른다
                fails.append(f"FAIL [manifest] 알 수 없는 kind: {cols[0]}"); continue
            kind, anchor, dest, marker, gain = cols
        if kind == "relocate":
            # ① anchor를 포함한 base 소스의 `- ` 줄이 정확히 1개 + 다음 줄이 들여쓴 연속 줄이 아니다
            hits = [i for i, l in enumerate(base_lines) if l.startswith("- ") and anchor in l]
            if len(hits) != 1:
                fails.append(f"FAIL [relocate] base 불릿 {len(hits)}개(1이어야 함): {anchor[:50]}")
                continue
            i = hits[0]
            bl = base_lines[i]
            nxt = base_lines[i + 1] if i + 1 < len(base_lines) else ""
            if nxt[:1] in (" ", "\t") and nxt.strip():
                fails.append(f"FAIL [relocate] 연속 줄 가진 불릿 — relocate는 단일 줄만: {anchor[:50]}")
                continue
            # ② 선언된 치환을 순서대로 적용한 결과가 현재 dest_file의 한 줄과 byte-identical
            moved = apply_subs(bl, pairs, "relocate", fails)
            if moved is not None:
                dp = pathlib.Path(target)
                if not dp.exists() or moved not in dp.read_text().split("\n"):
                    why = "" if dp.exists() else " (dest_file 없음)"
                    fails.append(f"FAIL [relocate] 목적지에 치환 적용 줄 없음{why}: "
                                 f"{target} ← {anchor[:50]}")
            # ③ 현재 소스에 base 줄이 없다
            if bl in cur_lines:
                fails.append(f"FAIL [relocate] 소스에 원 줄 잔존: {anchor[:50]}")
            # ④ base 섹션 R17 바닥 1 인하
            sec = section_of(base_src, bl, secs_dyn)
            if sec is not None:
                relocated_floor[sec] += 1
        elif kind == "refix":
            # base:<file>의 anchor 포함 줄 정확히 1개 → 치환 결과가 현재 <file>에 있고 원 줄은 없다.
            # R17 영향 없음(R17은 검사 대상 소스의 불릿 수만 본다).
            btext = at(base, target)
            hits = [l for l in (btext.split("\n") if btext is not None else []) if anchor in l]
            if len(hits) != 1:
                fails.append(f"FAIL [refix] base 줄 {len(hits)}개(1이어야 함): {target} ← {anchor[:50]}")
                continue
            fp = pathlib.Path(target)
            cur_f = fp.read_text().split("\n") if fp.exists() else []
            fixed = apply_subs(hits[0], pairs, "refix", fails)
            if fixed is not None and fixed not in cur_f:
                fails.append(f"FAIL [refix] 치환 결과 줄 없음: {target} ← {anchor[:50]}")
            if hits[0] in cur_f:
                fails.append(f"FAIL [refix] 원 줄 잔존: {target} ← {anchor[:50]}")
        elif kind == "move":
            if anchor not in base_src:
                fails.append(f"FAIL [move] base 소스에 anchor 없음: {anchor[:50]}")
            if anchor in cur_src:
                fails.append(f"FAIL [move] 소스에 anchor 잔존(미제거): {anchor[:50]}")
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
            n = base_src.count(anchor)
            if n != 1:                                                              # ⓐ
                fails.append(f"FAIL [merge] absorbed_marker가 base에 {n}회(1이어야 함): {anchor[:50]}")
            # ⓒ 날조 방지: 진짜 병합이면 base에서 두 마커는 '서로 다른' 불릿에 있다.
            # 이미 한 불릿 안에 있던 두 조각을 뽑아 쓰면 ⓐⓑ가 자동 충족되고, 병합이 한 건도
            # 없는데 R17 바닥만 1 내려가 무관한 불릿이 조용히 사라진다.
            forged = any(anchor in l and marker in l
                         for l in base_src.split("\n") if l.startswith("- "))
            if forged:
                fails.append(f"FAIL [merge] base에서 두 마커가 같은 불릿 — "
                             f"병합 선언이 아니다: {anchor[:50]}")
            surv = [l for l in cur_src.split("\n") if l.startswith("- ") and marker in l]
            if len(surv) > 1:
                print(f"WARN [merge] surviving_anchor 포함 불릿이 {len(surv)}개 — "
                      f"문서 순서 첫 불릿으로 판정(비차단): {marker[:50]}")
            if not surv:                                                            # ⓑ
                fails.append(f"FAIL [merge] surviving_anchor 불릿 없음: {marker[:50]}")
            elif anchor not in surv[0]:
                fails.append(f"FAIL [merge] 병합 미확인 — 삭제만 했는가: {anchor[:50]}")
            elif not forged:                       # 날조면 R17 바닥을 내려주지 않는다
                secs = sections_of(cur_src, marker, secs_dyn)
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

    for sec in secs_dyn:                                       # R17
        b = len(bullets(base_src, sec))
        floor = b - merged_floor[sec] - relocated_floor[sec]
        if section_span(cur_src, sec) is None:
            # relocate가 바닥을 0으로 '만든' 섹션만 면제(헤딩 삭제 허용). 원래 불릿 0인 섹션
            # (바닥이 처음부터 0)의 실종은 relocate 이전과 같이 FAIL — 기존 동작 불변.
            if relocated_floor[sec] > 0 and floor <= 0:
                continue
            fails.append(f"FAIL [R17] '## {sec}' 섹션이 작업트리에서 실종(rename 비목표)"); continue
        c = len(bullets(cur_src, sec))
        if c < floor:
            fails.append(f"FAIL [R17] '{sec}' 불릿 {b}→{c} (허용 바닥 {floor})")

    # R18: 양쪽 ref에 존재하는 baseline 행만
    base_budget, cur_budget = at(base, BUDGET), (pathlib.Path(BUDGET).read_text()
                                                 if pathlib.Path(BUDGET).exists() else None)
    if base_budget is not None and cur_budget is not None:
        # 파일이 '아예 없을' 때(= Task 8 이전 상태)는 위 조건에서 걸러져 통째 skip — 그건 정상이다.
        # 여기부터는 파일이 양쪽에 있는데 못 읽은 경우: 빈 dict면 아래 루프가 0회 돌고
        # 아무 출력 없이 통과한다(= 고장났는데 조용히 GREEN). 그래서 FAIL로 승격한다.
        # AnnAssign·구문오류·비-리터럴(dict(...)·컴프리헨션) 전부 이 가드가 덮는다.
        base_baselines, cur_baselines = parse_baselines(base_budget), parse_baselines(cur_budget)
        if not base_baselines:
            fails.append(f"FAIL [R18] budget 소스에서 BASELINES를 읽지 못했다: {base}:{BUDGET}")
        if not cur_baselines:
            fails.append(f"FAIL [R18] budget 소스에서 BASELINES를 읽지 못했다: {BUDGET} (작업트리)")
        for f, bb in base_baselines.items():
            cb = cur_baselines.get(f)
            if cb is None or cb <= bb:
                continue                                        # 삭제·유지·인하는 스코프 밖
            if not pathlib.Path(f).exists():    # 무가드 read_text는 FileNotFoundError(=크래시)
                fails.append(f"FAIL [R18] baseline 대상 파일 없음: {f} ({bb}→{cb} 인상)"); continue
            if len(pathlib.Path(f).read_text().encode()) >= len((at(base, f) or "").encode()):
                fails.append(f"FAIL [R18] {f} baseline {bb}→{cb} 인상인데 파일이 줄지 않았다")

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

    for f in fails: print(f)
    print(f"\n{'FAIL' if fails else 'OK'}: manifest {len(manifest)}행 · R17 섹션 {len(secs_dyn)}개")
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "17369d32",
                  sys.argv[2] if len(sys.argv) > 2 else ROOT,
                  sys.argv[3] if len(sys.argv) > 3 else ""))
