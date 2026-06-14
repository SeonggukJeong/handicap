---
name: curate-memory
description: Audit and compact the file-based auto-memory index (MEMORY.md) when it grows past its size limit. Trims over-long index entries to one line, archives completed-slice entries into MEMORY-archive.md (which is NOT loaded each session), and keeps only user preferences, active work, and pointers in MEMORY.md grouped by domain. Use when the harness warns "MEMORY.md is NN KB (limit ...)" or MEMORY.md exceeds ~24 KB.
---

# curate-memory — 자동메모리 인덱스 압축·도메인 정리

이 repo의 자동메모리는 `/Users/sgj/.claude/projects/-Users-sgj-develop-handicap/memory/`에 있다. **핵심 계약**(이걸 알아야 안전하게 줄인다):

- **`MEMORY.md`만 매 세션 통째로 로드된다** — 그래서 한도(≈24.4 KB)가 있고, 길어지면 매 프롬프트 비용이 된다.
- **토픽 파일(frontmatter 있는 `*.md`)은 `description` 필드로 *on-demand 회상*된다** — MEMORY.md 인덱스에 한 줄이 없어도 관련성 있으면 system-reminder로 surfaced. **즉 완료 슬라이스 한 줄을 인덱스에서 빼도 정보는 안 잃는다**(토픽 파일이 그대로 회상됨).
- **`MEMORY-archive.md`는 frontmatter가 없어서 "메모리"로 취급되지 않는다** → 회상 대상도, 로드 대상도 아니다. 완료 이력을 모아두는 순수 참조 파일로 안전.

## 절차

### 1) 진단
```bash
MEM=/Users/sgj/.claude/projects/-Users-sgj-develop-handicap/memory
wc -c "$MEM/MEMORY.md"                 # 한도 24986 bytes(24.4KB) 대비
grep -c '^- \[' "$MEM/MEMORY.md"       # 인덱스 엔트리 수
# 200자 넘는(=너무 긴) 인덱스 줄 찾기
awk 'length>240 && /^- \[/ {print NR": "length" chars"}' "$MEM/MEMORY.md"
```

### 2) 분류 — 각 인덱스 엔트리를 셋 중 하나로
- **KEEP (MEMORY.md에 남김)**: `type: user`/`feedback`(항상 적용되는 선호·교정), 진행 중(🎯/🔄) 활성 작업, 매 세션 필요한 진입 포인터. 보통 소수.
- **ARCHIVE (MEMORY-archive.md로 이동)**: `✅ …완료`/"구현+머지 완료" 슬라이스 이력. **대부분 여기.** 상세는 토픽 파일이 들고 회상도 됨.
- **DROP (인덱스 줄만 삭제)**: docs/roadmap.md·CLAUDE.md로 superseded된 과거 메모(토픽 파일은 남기되 "superseded" 표기).

> 토픽 파일(`*.md`)은 **절대 삭제하지 말 것** — 회상 소스다. 줄이는 건 *인덱스(MEMORY.md)* 뿐.

### 3) MEMORY-archive.md 작성 (없으면 생성)
- frontmatter **없이** 시작(메모리로 취급 안 되게).
- **도메인별 `## 섹션`**으로 그룹(이 repo: A9/용량·closed-loop 곡선 / 영역 B SLO·리포트 / 영역 A 프리셋·멀티워커 / Parallel(A2) / 영역 D 페이싱 / 영역 C test-run / 영역 U UX / 에디터·작성 / 환경·스케줄러 / 프로세스·인프라).
- 각 줄 = 한 줄 `- [제목](topic.md) — 1줄 hook + master SHA범위. → [[topic-slug]]`. **상세 금지**(토픽 파일이 들고 있음). 기존 장문 엔트리는 핵심만 남기고 압축.
- 새 슬라이스 완료 시엔 여기 해당 섹션에 한 줄만 추가(MEMORY.md엔 안 쌓음).

### 4) MEMORY.md 재작성 (최소)
- 맨 위 한 문단: "이 파일만 로드됨 / 완료 이력은 archive / 토픽은 description으로 회상되니 안전 / 비대해지면 /curate-memory".
- `## 사용자 선호·피드백`(KEEP한 feedback/user 엔트리, 한 줄씩).
- `## 진입 포인터`(roadmap·build-log·CLAUDE.md·adr·archive 링크).
- `## 활성 작업`(진행 중이면; 없으면 "(없음 — …까지 머지, 다음은 roadmap)").

### 5) 검증
```bash
wc -c "$MEM/MEMORY.md"                  # 한도 한참 아래여야
# 토픽 파일이 전부 어딘가(MEMORY.md 또는 archive)에 링크돼 있는지 — 고아 0 확인
links=$(grep -oE '\]\([a-z0-9-]+\.md\)' "$MEM/MEMORY.md" "$MEM/MEMORY-archive.md" | sed -E 's/.*\(([a-z0-9-]+\.md)\)/\1/' | sort -u | grep -v MEMORY)
for f in "$MEM"/*.md; do b=$(basename "$f"); case "$b" in MEMORY.md|MEMORY-archive.md) continue;; esac; echo "$links" | grep -qx "$b" || echo "MISSING LINK: $b"; done
```

메모리 파일은 repo 밖(`~/.claude/...`)이라 **git 커밋 대상이 아니다** — 직접 Write로 끝. (이 스킬 정의 파일 자체는 `.claude/skills/`라 repo에 커밋됨.)
