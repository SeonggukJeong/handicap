#!/usr/bin/env python3
"""문서 예산 게이트: root 절대 예산 · 상태줄 · L1 링크/앵커 · 도메인 성장 래칫 · 불릿 상한.

비대칭 설계(근거 → docs/dev/root-doc-maintenance.md):
  - **성장은 경고**(WARN, exit 0) — 도메인 파일은 커져도 매 프롬프트 비용이 아니다.
  - **거짓 보고는 오류**(FAIL, exit 1) — root 예산 초과·상태줄 붕괴·죽은 참조·
    검사 불능(섹션/baseline 대상 실종)은 문서가 사실이 아니게 되는 경로다.

단위는 전부 KiB(1024 B). 줄 바이트 = len(line.encode()) + 1(개행 포함).
"""
import re, sys, pathlib

ROOT = "CLAUDE.md"

# 도메인 CLAUDE.md 성장 래칫의 기준선(Task 4–7 완료 시점 실측 `wc -c`).
# 인상은 "파일을 실제로 압축했을 때만" 허용되고, check-doc-coverage.py 의 R18 이
# 기계로 강제한다(인상인데 파일이 안 줄었으면 FAIL). 형식 제약: 모듈 최상위 대입문 +
# flat dict 리터럴 — R18 의 parse_baselines() 가 ast 로 이 노드를 읽는다.
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
BULLET_SECTION = "Subagent dispatch 노하우"
BULLET_MAX = 250        # 불릿 하나 상한(FAIL) — US2 "규칙만 말한다"의 기계적 대리 지표
SECTION_MAX = 6144      # 6 KiB — 섹션 총합(WARN: 총량 방어는 root 절대 예산이 이미 한다)

# L1 사전 선언 예외. None = 존재 검사 제외, str = 그 경로로 해석해 존재 검사.
L1_EXCEPTIONS = {
    "MEMORY.md": None,                                  # 레포 밖(사용자 자동메모리 디렉토리)
    "2026-05-27-handicap-mvp1-design.md":               # 맨 파일명으로 인용되는 MVP1 spec
        "docs/superpowers/specs/2026-05-27-handicap-mvp1-design.md",
}


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
    """root 안의 .md 참조를 (원문, 앵커) 목록으로. backtick 인용 경로 + markdown 링크 양쪽.

    root의 진짜 markdown 링크는 몇 개 안 되고 대부분은 backtick 경로로 인용된다 —
    한쪽만 보면 이 검사는 사실상 아무것도 안 한다.
    """
    refs = []
    for m in re.finditer(r"`([^`\n]+?\.md)`", text):                    # `docs/foo.md`
        refs.append((m.group(1), None))
    for m in re.finditer(r"\[[^\]]*\]\(([^)\s]+)\)", text):             # [t](docs/foo.md#a)
        path, _, anc = m.group(1).partition("#")
        if path == "" or path.endswith(".md"):
            refs.append((path, anc or None))
    return refs


def check_l1(text, fails):
    """R9: 참조된 .md가 실존하고 내부 #앵커가 실제 헤딩과 매치하는가."""
    cache, seen, n_file, n_anchor = {ROOT: text}, set(), 0, 0
    for raw, anc in md_refs(text):
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

    # ③ L1 — 참조 실존 + 앵커 매치
    n_file, n_anchor = check_l1(text, fails)

    # ④ 불릿 상한 (US2) — 섹션이 사라지면 검사 불능이므로 FAIL
    body = section_span(text, BULLET_SECTION)
    if body is None:
        fails.append(f"FAIL [불릿] '## {BULLET_SECTION}' 섹션 없음 — 검사 불능(섹션명 불변 규약)")
    else:
        lines = body.split("\n")
        total = sum(line_bytes(l) for l in lines)
        bl = [l for l in lines if l.startswith("- ")]
        table.append((f"§{BULLET_SECTION}", total, SECTION_MAX, f"{total / SECTION_MAX * 100:.1f}%"))
        for l in bl:
            n = line_bytes(l)
            if n > BULLET_MAX:
                fails.append(f"FAIL [불릿] {n} B > {BULLET_MAX} B: {l[:60]}…")
        if total > SECTION_MAX:
            warns.append(f"WARN [불릿] 섹션 총합 {total:,} B > {SECTION_MAX:,} B "
                         f"(불릿 {len(bl)}개) — 서사는 docs/dev/subagent-dispatch.md 로")

    # ⑤ 도메인 성장 래칫 — 성장은 WARN, 대상 실종은 FAIL(거짓 보고)
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

    w = max(len(f) for f, *_ in table)
    print(f"\n{'파일'.ljust(w)}  {'현재':>12}  {'기준':>12}  사용률/성장")
    for f, cur, base, note in table:
        print(f"{f.ljust(w)}  {cur:>10,} B  {base:>10,} B  {note}")

    print(f"\n{'FAIL' if fails else 'OK'}: root {size:,}/{ROOT_MAX:,} B · "
          f"L1 참조 {n_file}건(앵커 {n_anchor}) · 래칫 {len(BASELINES)}개 · "
          f"FAIL {len(fails)} / WARN {len(warns)}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
