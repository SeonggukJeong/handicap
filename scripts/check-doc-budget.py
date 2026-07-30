#!/usr/bin/env python3
"""문서 예산 게이트: root 절대 예산 · 상태줄 · L1 링크/앵커 · 도메인 성장 래칫 · 불릿 상한.

비대칭 설계(근거 → docs/dev/root-doc-maintenance.md):
  - **성장은 경고**(WARN, exit 0) — 도메인 파일은 커져도 매 프롬프트 비용이 아니다.
  - **거짓 보고는 오류**(FAIL, exit 1) — root 예산 초과·상태줄 붕괴·죽은 참조, 그리고
    **검사 불능**(섹션·baseline 대상 실종, 검사 대상이 0으로 줄어듦)은 문서가 사실이
    아니게 되는 경로다. 검사 대상이 비면 루프가 0회 돌고 **조용히 GREEN**이 되므로,
    게이트를 무력화하는 가장 싼 방법이 곧 "대상을 없애기"다 — 하한 4종으로 막는다.

단위는 전부 KiB(1024 B). 줄 바이트 = len(line.encode()) + 1(개행 포함).
"""
import re, sys, pathlib, unicodedata

ROOT = "CLAUDE.md"

# 도메인 CLAUDE.md 성장 래칫의 기준선(Task 4–7 완료 시점 실측 `wc -c`).
# 인상은 "파일을 실제로 압축했을 때만" 허용되고, check-doc-coverage.py 의 R18 이
# 기계로 강제한다(인상인데 파일이 안 줄었으면 FAIL). 형식 제약: 모듈 최상위 대입문 +
# flat dict 리터럴 — R18 의 parse_baselines() 가 ast 로 이 노드를 읽는다.
# 단 R18 은 base ref 에 이 파일이 있을 때만 무장된다(→ root-doc-maintenance.md).
BASELINES = {
    "ui/CLAUDE.md": 116129,
    "crates/controller/CLAUDE.md": 82481,
    "crates/engine/CLAUDE.md": 37057,
    "crates/worker-core/CLAUDE.md": 11388,
    "deploy/CLAUDE.md": 8594,
    "desktop/CLAUDE.md": 8101,
}

ROOT_MAX = 51200        # 50 KiB — 초과 시 FAIL
ROOT_WARN = 46080       # 45 KiB(90%) — 이상이면 WARN
STATUS_MAX = 1229       # 1.2 KiB — 상태줄 단일 라인 상한
RATCHET = 10240         # 10 KiB — baseline 대비 이만큼 넘게 자라면 WARN
# 섹션별 캡: {섹션명: (불릿 하나 상한 FAIL, 섹션 총합 WARN 또는 None)}.
# 단일 문자열로 두면 캡이 한 섹션에만 걸린다 — root 에서 줄이 늘 붙는 곳은 두 군데다.
#   `Subagent dispatch 노하우` 250 B — US2 "규칙만 말한다"의 기계적 대리 지표(서사가 섞이면
#     반드시 넘는다. 실제로 251 B 가 새어나갔고 사람이 수동 재측정해서야 잡혔다).
#   `알아둘 결정들`(ADR 인덱스) 170 B — root 규칙이 "번호 + 제목 + 핵심 한 마디" 한 줄이고,
#     T7 축약 결과의 실측 최대가 정확히 170 B(= 현 상태 동결). 새 ADR 이 붙을 때마다 자라는
#     곳이라 캡이 없으면 재비대의 가장 유력한 경로가 된다.
# 섹션 총합 WARN 을 ADR 인덱스에 두지 않는 이유: 현재 5,992 B 라 6 KiB 캡이면 다음 ADR
#   한 줄(~150 B)에 바로 WARN 이 뜨는데, 인덱스 줄은 이미 "한 줄" 규칙의 하한이라
#   "줄여라"라는 유효한 처방이 없다 — 총량 방어는 root 절대 예산이 이미 하고 있다.
BULLET_SECTIONS = {
    "Subagent dispatch 노하우": (250, 6144),
    "알아둘 결정들": (170, None),
}

# --- "검사 불능 = FAIL" 하한 ------------------------------------------------
# 래칫 WARN 을 없애는 가장 싼 방법은 dict 를 비우는 것이고, 250 B 검사를 없애는 가장 싼
# 방법은 불릿 마커를 바꾸는 것이다 — 둘 다 R18 이 잡는 "baseline 인상"보다 싸다.
BASELINES_MIN = 6       # 도메인 CLAUDE.md 개수. 파일을 실제로 지웠을 때만 내린다.
L1_MIN_REFS = 21        # L1 이 검사해야 할 최소 참조 수. 포인터가 진짜 사라졌을 때만 내린다.

# L1 사전 선언 예외. None = 존재 검사 제외, str = 그 경로로 해석해 존재 검사.
L1_EXCEPTIONS = {
    "MEMORY.md": None,                                  # 레포 밖(사용자 자동메모리 디렉토리)
    "2026-05-27-handicap-mvp1-design.md":               # 맨 파일명으로 인용되는 MVP1 spec
        "docs/superpowers/specs/2026-05-27-handicap-mvp1-design.md",
}

# root 가 .md 를 가리키는 4가지 표기. 하나라도 빼면 그만큼 조용히 안 보인다.
RE_BACKTICK = re.compile(r"`([^`\n]+?\.md)(?:[:#][\w.-]*)?`")     # `docs/x.md` `docs/x.md:207`
RE_LINK = re.compile(r"""\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+["'(][^)]*)?\s*\)""")
RE_LINKDEF = re.compile(r"""(?m)^\s{0,3}\[[^\]]+\]:\s*<?([^>\s]+)>?""")   # [rd]: docs/x.md
RE_PLAIN = re.compile(r"(?<![`(])(?:docs|crates|ui|deploy|desktop|scripts)"
                      r"/[\w./-]+\.md\b")                          # **docs/x.md**(굵게)


def nbytes(s):
    return len(s.encode("utf-8"))


def line_bytes(l):
    return nbytes(l) + 1            # 개행 포함 — 섹션 합계 규약(spec §7 US2)


def strip_fences(text):
    """펜스 코드블록을 제거한다. `# 주석`을 헤딩으로 오인하면 없는 앵커가 통과한다."""
    out, fence = [], None
    for l in text.split("\n"):
        m = re.match(r"^\s*(```+|~~~+)", l)
        if fence is None and m:
            fence = m.group(1)[:3]
            continue
        if fence is not None:
            if m and m.group(1).startswith(fence):
                fence = None
            continue
        out.append(l)
    return "\n".join(out)


def slug(title):
    """GitHub 스타일 앵커 슬러그(한글 보존 — `\\w`는 유니코드)."""
    s = title.strip().lower()
    s = re.sub(r"[^\w\s-]", "", s)
    return re.sub(r"\s+", "-", s)


def anchors_of(text):
    return {slug(m.group(1)) for m in
            re.finditer(r"(?m)^#{1,6}\s+(.+?)[ \t]*$", strip_fences(text))}


def section_span(text, section):
    """'## <section>' 헤딩 줄부터 다음 '## '(또는 EOF)까지. 없으면 None.

    헤딩은 줄 앵커로 찾는다 — find("## "+s)는 '### <같은 제목>'의 오프셋 1에도 매치한다.
    """
    m = re.search(r"(?m)^## " + re.escape(section) + r"[ \t]*$", text)
    if m is None:
        return None
    i = m.start()
    j = text.find("\n## ", i + 1)
    return text[i:j if j > 0 else len(text)]


def md_refs(text):
    """root 안의 .md 참조를 (경로, 앵커) 목록으로 — backtick·링크·링크정의·평문 **4표기 전부**.

    한쪽만 보면 이 검사는 사실상 아무것도 안 한다: root 의 진짜 markdown 링크는 파일 참조
    4개뿐이고 대부분은 backtick 으로 인용된다. 그리고 **평문 굵게 포인터**
    (`→ **docs/dev/live-verify-playwright.md**(／live-verify 시 로드)`)는 backtick 도 링크도
    아니다 — 하필 이전 재분배가 만든 포인터라 R9 가 존재하는 이유 그 자체다.

    `.md:207`·`.md#anchor` 꼬리는 흡수한다(경로만 검사). `docs/x.md:207` 표기는 이미
    `docs/dev/root-doc-maintenance.md` 에서 관용적으로 쓰이고 곧 root 로 올라온다.
    """
    refs = []
    for m in RE_BACKTICK.finditer(text):
        refs.append((m.group(1), None))
    for rx in (RE_LINK, RE_LINKDEF):
        for m in rx.finditer(text):
            path, _, anc = m.group(1).partition("#")
            if path == "" or path.endswith(".md"):
                refs.append((path, anc or None))
    for m in RE_PLAIN.finditer(text):
        refs.append((m.group(0), None))
    return refs


def check_l1(text, fails):
    """R9: 참조된 .md가 실존하고 내부 #앵커가 실제 헤딩과 매치하는가."""
    cache, seen, n_file, n_anchor = {ROOT: text}, set(), 0, 0
    for raw, anc in md_refs(strip_fences(text)):
        if (raw, anc) in seen:
            continue
        seen.add((raw, anc))
        if any(c in raw for c in "*?<>"):        # glob/플레이스홀더는 경로가 아니다
            continue
        target = raw or ROOT
        if raw in L1_EXCEPTIONS:
            target = L1_EXCEPTIONS[raw]
            if target is None:                   # 선언된 예외 — 존재 검사 제외
                if anc:
                    fails.append(f"FAIL [L1] 예외 파일에 앵커 참조는 검증 불가: {raw}#{anc}")
                continue
        n_file += 1
        p = pathlib.Path(target)
        if not p.exists():
            fails.append(f"FAIL [L1] 참조 대상 없음: {raw}"
                         + (f" (→ {target})" if target != raw else ""))
            continue
        if anc:
            n_anchor += 1
            if target not in cache:
                cache[target] = p.read_text()
            if slug(anc) not in anchors_of(cache[target]):
                fails.append(f"FAIL [L1] 앵커에 맞는 헤딩 없음: {raw}#{anc}")
    return n_file, n_anchor


def main():
    fails, warns, table = [], [], []
    rp = pathlib.Path(ROOT)
    if not rp.exists():
        print(f"FAIL [setup] {ROOT} 가 없다(레포 루트에서 실행할 것)")
        return 1
    text = rp.read_text()

    # ① root 절대 예산
    size = nbytes(text)
    table.append((ROOT, size, ROOT_MAX, f"{size / ROOT_MAX * 100:.1f}%"))
    if size > ROOT_MAX:
        fails.append(f"FAIL [root] {ROOT} {size:,} B > 예산 {ROOT_MAX:,} B "
                     f"({size - ROOT_MAX:,} B 초과) — 재분배 절차: docs/dev/root-doc-maintenance.md")
    elif size >= ROOT_WARN:
        warns.append(f"WARN [root] {ROOT} {size:,} B ≥ 경고선 {ROOT_WARN:,} B "
                     f"(예산의 {size / ROOT_MAX * 100:.0f}%) — 다음 슬라이스에 재분배 예고")

    # ② 상태줄 — finish-slice SKILL.md 의 `grep -n '^\*\*상태:'` 가 여기 의존한다
    status = [l for l in text.split("\n") if l.startswith("**상태:")]
    if len(status) != 1:
        fails.append(f"FAIL [상태줄] '^**상태:' 매치 {len(status)}건 — 정확히 1건이어야 한다"
                     f"(finish-slice §4의 한 줄 교체 규칙)")
    else:
        sb = line_bytes(status[0])
        table.append(("CLAUDE.md:상태줄", sb, STATUS_MAX, f"{sb / STATUS_MAX * 100:.1f}%"))
        if sb > STATUS_MAX:
            fails.append(f"FAIL [상태줄] {sb:,} B > 상한 {STATUS_MAX:,} B — "
                         f"append 말고 한 줄로 교체할 것(상세는 docs/build-log.md)")

    # ③ L1 — 참조 실존 + 앵커 매치 (+ 검사량 하한: 검사가 줄면 그것도 검사 불능이다)
    n_file, n_anchor = check_l1(text, fails)
    if n_file < L1_MIN_REFS:
        fails.append(f"FAIL [L1] 검사한 참조 {n_file}건 < 하한 {L1_MIN_REFS}건 — "
                     f"포인터가 사라졌거나 표기가 바뀌어 검사에서 빠졌다"
                     f"(진짜로 없앤 거라면 L1_MIN_REFS를 같이 내릴 것)")

    # ④ 불릿 상한 (US2) — 섹션·불릿이 사라지면 검사 불능이므로 FAIL (캡 대상 섹션 전부)
    for sec, (bullet_max, section_max) in BULLET_SECTIONS.items():
        body = section_span(text, sec)
        if body is None:
            fails.append(f"FAIL [불릿] '## {sec}' 섹션 없음 — 검사 불능(섹션명 불변 규약)")
            continue
        lines = body.split("\n")
        total = sum(line_bytes(l) for l in lines)
        bl = [l for l in lines if l.startswith("- ")]
        if not bl:
            # 마커를 '- '에서 '* '로 바꾸면 불릿 상한 검사가 통째로 증발한다(0회 루프 → GREEN).
            fails.append(f"FAIL [불릿] '## {sec}'에 '- ' 불릿 0개 — "
                         f"검사 불능(마커가 바뀌었나? 규약은 '- ')")
        else:
            mx = max(line_bytes(l) for l in bl)
            table.append((f"§{sec}:최대 불릿", mx, bullet_max, f"{mx / bullet_max * 100:.1f}%"))
        for l in bl:
            n = line_bytes(l)
            if n > bullet_max:
                fails.append(f"FAIL [불릿] '{sec}' {n} B > {bullet_max} B: {l[:60]}…")
        if section_max is not None:
            table.append((f"§{sec}", total, section_max, f"{total / section_max * 100:.1f}%"))
            if total > section_max:
                warns.append(f"WARN [불릿] '{sec}' 섹션 총합 {total:,} B > {section_max:,} B "
                             f"(불릿 {len(bl)}개) — 서사는 이미 정본에 있다: "
                             f"새 규칙을 넣기 전에 **기존 불릿을 먼저 줄일 것**")

    # ⑤ 도메인 성장 래칫 — 성장은 WARN, 대상 실종·목록 축소는 FAIL(거짓 보고)
    if len(BASELINES) < BASELINES_MIN:
        fails.append(f"FAIL [래칫] BASELINES {len(BASELINES)}개 < 하한 {BASELINES_MIN}개 — "
                     f"검사 불능(도메인 파일을 실제로 지웠을 때만 하한을 내릴 것)")
    for f, base in BASELINES.items():
        p = pathlib.Path(f)
        if not p.exists():
            fails.append(f"FAIL [래칫] baseline 대상 파일 없음: {f} (기준 {base:,} B)")
            continue
        cur = nbytes(p.read_text())
        table.append((f, cur, base, f"{cur - base:+,} B"))
        if cur - base > RATCHET:
            warns.append(f"WARN [래칫] {f} {cur - base:+,} B (기준 {base:,} → {cur:,}) "
                         f"> {RATCHET:,} B — 도메인 파일 재분배 검토")

    for m in fails:
        print(m)
    for m in warns:
        print(m)

    # 표 정렬은 글자 수가 아니라 **표시 폭**으로 — 한글/CJK는 터미널에서 2칸을 먹는다.
    def dwidth(s):
        return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)

    def pad(s, w):
        return s + " " * max(0, w - dwidth(s))

    w = max(dwidth(f) for f, *_ in table)
    print(f"\n{pad('파일', w)}  {'현재':>10}    {'기준':>10}    사용률/성장")
    for f, cur, base, note in table:
        print(f"{pad(f, w)}  {cur:>10,} B  {base:>10,} B  {note}")

    print(f"\n{'FAIL' if fails else 'OK'}: root {size:,}/{ROOT_MAX:,} B · "
          f"L1 참조 {n_file}건(앵커 {n_anchor}) · 래칫 {len(BASELINES)}개 · "
          f"FAIL {len(fails)} / WARN {len(warns)}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
