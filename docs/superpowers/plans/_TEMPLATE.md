# `<기능명>` Implementation Plan

> **이 파일은 plan 템플릿이다.** 새 plan은 이 골격을 복사해 채운다. 두 가지 새 장치가 핵심:
> ① **Requirement Coverage 표** (spec §2의 모든 R이 ≥1 task에 매핑됐는지 — plan 작성 시 요구사항 누락을 *기계적으로* 드러냄, 실패모드 A),
> ② **각 task의 `충족 R` + 인라인 acceptance** (구현 subagent는 자기 task만 보므로 spec 전체를 안 들고도 닫을 수 있게 — 실패모드 B).
> 빈 `<...>`·안내 인용문(`>`)은 작성 시 지운다.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

<!-- REVIEW-GATE: PENDING — spec-plan-reviewer가 spec과 이 plan에 clean APPROVE를 내면, 이 줄을 정확히 `REVIEW-GATE: APPROVED`(또는 `<!-- REVIEW-GATE: APPROVED -->`)로 바꾼다. 그 전엔 spec-review-guard가 crates/*/src·ui/src 편집을 차단한다. APPROVE-WITH-FIXES / NEEDS-REWORK는 미통과(마커 금지). 부분문자열(APPROVED-WITH-FIXES 등)은 가드가 EOL-앵커로 거른다. -->

**Goal:** `<한 문장 — spec §1 목표>`
**Architecture:** `<접근 한 단락 — 어디를 어떻게>`
**Tech Stack:** `<언어·크레이트·파일>`
**Spec:** `docs/superpowers/specs/<...>-design.md`

---

## Requirement Coverage (R-id → Task) ⟵ 커버리지 게이트

> spec §2의 **모든 R이 ≥1 task에 매핑**돼야 한다. 빈 "담당 Task" 칸 = plan이 spec 요구사항을 흘림 = **작성 미완**(머지 금지). 이 표는 작성자의 attention에 기대지 않고 *누락을 눈에 보이게* 하는 장치다.
> 역방향도 본다: 어떤 R도 충족 안 하는 task(순수 docs/잡일 제외)는 **scope creep** 의심.

| R-id | 요구사항 (요약) | 담당 Task | seam? |
|---|---|---|---|
| R1 | `<...>` | Task 1 | |
| R2 | `<... 계약 ...>` | Task 1 (계약-먼저) | ✅ |
| R3 | `<...>` | Task 2 | |
| R4 | `<parity/불변식>` | Task 2 | |

- **`seam ✅` R이 여럿이면 계약-정의 task를 먼저** 두고, 그 task가 머지된 뒤 나머지를 진행(분할/병렬이면 자식 슬라이스 fan-out 전에 부모가 계약 freeze).
- 한 계약의 양쪽 R(예: R2 serde / R5 Zod)은 **같은 task** 또는 **함께 머지**되게 묶는다.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `<경로>` | `<...>` | `<...>` |

**무변경(명시)**: `<엔진/proto/migration/UI/Zod/CSV … 중 안 건드리는 것 — spec §5와 일치>`.
**TDD 가드 메모**: `<tdd-guard 통과 전략: 인라인 #[cfg(test)] 자동통과 / tests/*.rs 먼저 / keepalive stub(끝나면 rm) — 루트 CLAUDE.md C-1>`.
**커밋 경계 메모**: `<전체 워크스페이스 게이트 때문에 dead-code/RED 단독 커밋 불가 → 어느 step들을 하나의 green 커밋으로 fold하는지>`.

---

## Task 1: `<제목>`

**충족 R:** `R1, R2`  ⟵ 이 task가 닫는 요구사항(없으면 scope creep 의심)
**Files:**
- Modify/Create: `<경로>` — `<무엇>`

- [ ] **Step 1: `<...>`**
  `<구체 변경: 코드 블록은 실제 코드(의사코드·`...` 금지). 와이어 양쪽이면 양쪽 정확히.>`
  **Acceptance (R1):** `<spec §6의 R1 acceptance를 여기 인라인 — 구현 subagent는 이 task만 보므로, spec 전체를 안 들고도 이 줄만으로 "닫혔다"를 판정할 수 있어야 한다.>`
  **Acceptance (R2):** `<...>`

- [ ] **Step 2: 검증** — `<cargo test … <name> / pnpm lint && pnpm test && pnpm build / 라이브>`. R1·R2 acceptance 통과 확인(출력은 파이프 말고 `> /tmp/<slug>.log` 후 exit code).

- [ ] **Step 3: 커밋** — 명시 경로만 `git add`(절대 `-A` 금지), 파이프 없는 단일 커밋(파이프는 exit code 마스킹). subagent면 commit은 `run_in_background:false` + timeout 600000ms **단일 foreground** 호출(폴링 금지 — 루트 CLAUDE.md A4b). 직후 `git log -1`로 landed 확인.

---

## Task 2: `<제목>`

**충족 R:** `R3, R4`
**Files:**
- `<...>`

- [ ] **Step 1: `<...>`**
  **Acceptance (R3):** `<...>`
  **Acceptance (R4 — parity/불변식):** `<양쪽이 같은 값을 내는지 명시 단언>`

- [ ] **Step 2: 검증 / Step 3: 커밋** `<위와 동일 패턴>`

---

## 머지 / 마무리

- **라이브 검증 필요 여부**(spec §6): `<불요(단위/계약 테스트로 충분) | 필수(run-생성/응답-파싱/엔진 경로 변경 → /live-verify로 run 1회)>`.
- **워크트리 ff-merge**(루트 CLAUDE.md git 토폴로지): 실제 브랜치명 확인(`git -C <메인> branch --list 'worktree-*'`) → `git -C /Users/sgj/develop/handicap merge --ff-only worktree-<X>`(메인 클린·ff 가능 사전확인) → `ExitWorktree(remove, discard_changes:true)`.
- **잔류 정리**: Playwright 썼다면 `rm -rf .playwright-mcp` + 루트 png.

## Self-Review (작성자 체크)

- **R 커버리지**: 위 표의 **모든 R에 담당 task 있음(미매핑 0)**. `seam ✅` R은 계약-먼저 배치 ✓.
- **인라인 acceptance**: 각 task가 자기 R의 acceptance를 인라인으로 들고 있어, 구현 subagent가 spec 없이 task만으로 닫을 수 있음 ✓.
- **Placeholder scan**: 모든 코드 블록이 실제 코드(의사코드/`...`/TODO 없음) ✓.
- **Type/idiom consistency**: 와이어 양쪽(UI Zod ↔ serde) 필드명·타입·연산자 1:1 ✓.
- **커밋 경계**: 게이트(dead-code/RED 단독 불가)에 맞춰 green fold 설계됨 ✓.
