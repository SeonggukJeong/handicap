# root CLAUDE.md 유지보수 — 이관 기준 · splice 함정 · ADR 상태 규약

> root `CLAUDE.md`는 **매 프롬프트에 통째로 로드**되므로 커지면 매 세션 토큰을 먹는다. 규칙 자체(무엇을 어디에 쓰나)는 root의 `## 슬라이스/기능을 완료하면`·`## 새 함정을 배우면`·`## 새로운 아키텍처 결정이 생기면`에 한 줄씩 있고, **이 파일은 그 규칙을 실제로 실행할 때 필요한 판단 기준과 사고 서사**를 들고 있다. 재분배(root에서 무언가를 덜어내는 작업)를 시작할 때 먼저 읽어라.

## 이관 기준 — 무엇을 root 밖으로 빼도 되나 (3분류)

root에서 무언가를 빼는 건 **auto-load → manual-load 다운그레이드**다. 내용이 사라지진 않지만 "그 파일을 읽을 이유가 생기는 순간"이 없으면 아무도 안 읽는다. 그래서 판단 기준은 내용의 중요도가 아니라 **재발견 트리거의 유무**다(2026-06-28 기록 시스템 최적화에서 확립, 사용자 조건 verbatim: "새 세션에서 기록되있는 내용을 잊고 똑같은 실수를 할 위험이 없다면 이대로 진행" — 모든 이동이 이 no-forget 불변식을 통과해야 한다).

1. **완료 기록**(함정이 아닌 이력·결과 요약) → **안전**. `docs/build-log.md`·`docs/roadmap-archive.md`·`MEMORY-archive.md`가 이 부류다. 완료 기록은 build-log/MEMORY/도메인 CLAUDE.md에 사실상 삼중 중복이고 코드·git에서 재발견되므로 망각 위험이 0에 가깝다.
2. **명확한 활동 트리거가 있는 함정** → **안전**. 그 함정을 밟을 상황에 반드시 거치는 진입점이 있어서, 진입점이 파일을 로드해 준다. 선례: Playwright MCP 도구 함정 → `docs/dev/live-verify-playwright.md`(트리거 = `/live-verify` 스킬), 커밋 게이트 이력 → `docs/dev/commit-gates-and-git-workflow.md`, subagent dispatch 서사 → `docs/dev/subagent-dispatch.md`.
3. **편집-트리거 함정**(특정 코드를 편집하다 밟는데, 그 편집에 스킬·훅 같은 진입점이 없는 것) → **인라인 유지**. 옮기면 그 디렉토리에서 작업하는 새 세션이 포인터를 안 읽고 같은 함정을 밟는다.

**선례 — Move D 거절**(2026-06-28, 사용자 승인): 당시 78 KB이던 `crates/controller/CLAUDE.md`에서 LAN풀·스케줄러·export·운영상한·bundle 섹션을 `docs/`로 빼자는 안을 **거절**했다. 이유는 크기가 아니라 분류다 — 전부 3번(편집-트리거)이라 `/live-verify` 같은 명확한 트리거가 없고, 분리하면 `crates/controller/`를 건드리는 세션이 함정을 밟을 실재 위험이 생긴다. 임계값 노트만 파일 상단에 박고 분리는 보류했다. **재제안하지 말 것** — 크로스커팅 함정(axum·store·proto·dispatch)은 인라인 유지가 정답이고, 도메인 CLAUDE.md는 애초에 그 디렉토리를 건드릴 때만 로드되므로 root와 예산 성격이 다르다.

**이동 시 원본에 토픽-나열 포인터를 반드시 남긴다**(삭제가 아니라 이동 + 포인터 잔류). 포인터는 링크만이 아니라 **옮긴 토픽들의 키워드를 나열**해야 한다 — 원본에서 grep으로 발견될 가능성이 유일한 안전망이기 때문이다.

## ADR 상태 갱신 규약 — 결정이 나중에 바뀌었을 때

ADR 본문은 **결정 시점의 기록**이다. 나중에 사실이 달라졌다고 본문 문장을 다시 쓰면 "그때 무엇을 왜 결정했나"라는 ADR의 유일한 가치가 사라진다. 따라서 갱신은 **덧붙이기만** 한다.

- **문서 전체의 상태가 바뀐 경우**(채택→구현 완료, 다른 ADR로 대체) → **헤더 Status 줄만** 교체하고 본문은 손대지 않는다.
  - 선례 `docs/adr/0040-tauri-desktop-wrapper.md:3` — `- 상태: 접근 1 채택 (2026-06-19) → 접근 2로 대체 ([ADR-0042](0042-tauri-in-process-controller.md), 2026-06-26)`. 본문에는 주석이 한 줄도 없다.
  - 선례 `docs/adr/0027-multi-worker-fanout.md:3` — `* Status: Accepted (A3a+A3b+A3c 머지 — 완결)`. 역시 본문 주석 0.
- **문서의 일부(절·항목) 단위로 바뀐 경우**(연기했던 항목 하나가 해소됨 등) → **헤더에 요약 한 마디 + 해당 문장에 괄호 인라인 주석**. 헤더만 고치면 본문을 읽는 사람이 낡은 문장을 사실로 읽고, 본문만 고치면 헤더 한 줄만 보는 사람이 못 본다.
  - 선례 `docs/adr/0044-editor-outline-not-canvas.md`(갱신 커밋 `2cff75a6`) — 헤더 상태 줄 뒤에 "· 연기 항목 절 단위 해소 — 컨테이너 경계 넘는 드래그/re-parent(§결과 3번째 항목)는 2026-07-02 `editor-reparent-dnd`로 해소(`docs/build-log.md:207`)"를 붙이고, 본문 2곳(`## 결정`의 그룹내 드래그 항목, `## 결과`의 트레이드오프 항목)의 원문은 **그대로 둔 채** 괄호 안에 "→ 2026-07-02 `editor-reparent-dnd`로 해소, `docs/build-log.md:207`"만 덧붙였다.
- **본문 문장 재작성 금지.** 주석에는 해소 날짜 + 슬라이스 slug + 근거 포인터(`docs/build-log.md:<줄>` 등)를 적어 추적 가능하게 한다.
- root의 `## 알아둘 결정들` 인덱스는 **번호 + 제목 + 핵심 한 마디** 한 줄뿐이다 — ADR 파일이 낡으면 인덱스를 압축할 수 없다(압축이 유일하게 정확한 기록을 지우게 된다). **ADR 파일을 먼저 최신화한 뒤 인덱스를 손볼 것.**

## 상태줄·roadmap splice 함정 (Python 스플라이스)

root 상태줄(line 7)과 `docs/roadmap.md` 불릿은 둘 다 단일 초장문 라인이라 일반 편집 도구로 못 고친다. 아래 4건은 root에서 **원문 그대로** 옮겨 온 실제 사고 기록이다 — 규칙 요약이 아니라 실패 모드와 그 증상이다. (두 번째 항목 끝의 "위 규칙 참조"는 root `CLAUDE.md`에 남아 있는 `- root **상태 줄은 한 줄로 *교체*(append 금지)**` 불릿을 가리킨다 — 이관 전 문맥이라 원문을 그대로 뒀다.)

- **상태줄(line 7) 교체·`docs/roadmap.md` 불릿 삽입은 Python 스플라이스로** (run-list-filter-sort 2026-06-25): 둘 다 단일 초장문 라인이라 **Read 툴이 `limit`을 줘도 "exceeds max tokens"로 거부**하고 Edit 정확매치도 2KB+ old_string 재현이 깨지기 쉽다 → 작은 unique start/end 마커로 `s.index()` 찾아 splice하는 `.py`(`assert count==1`)로 교체/삽입. 상태줄 한 줄 자체는 `Read offset=7 limit=1`로는 읽힌다.
  - **splice 정합성은 bracket-balance가 아니라 imbalance-vs-HEAD로 검증** (XLSX Δ 2026-06-26): 상태줄·roadmap 불릿은 한국어 `[...]` 다용으로 **이미 불균형**일 수 있어 `count('[')==count(']')`는 무의미 — `git show HEAD:<파일>`의 해당 라인 imbalance와 *같은지* 비교(naive balance 검사는 false-positive). (line 7을 `·feature[detail]`로 append하던 close-앵커 `])까지 구현·머지 완료.` 규칙은 2026-06-28 카탈로그 압축으로 폐지 — 카탈로그는 더 이상 append 대상 아님, 위 규칙 참조.)
  - **splice 앵커의 구분자 char-identity 함정** (json-cast-extend 2026-06-29, line-7 splice 2회 substring-not-found): 상태줄은 `·`(U+00B7 MIDDLE DOT)·`—`(U+2014)·`→`(U+2192)를 쓰는데 ① `.py` heredoc에 *타이핑한* 리터럴이 다른 코드포인트(`•` U+2022 등)일 수 있고 ② **Read 툴 렌더가 raw 바이트와 다를 수 있다**(이번에 Read가 `상세·함정 출처`를 `상세`로 누락 렌더) → `s.index()`가 0매치로 터진다. 앵커는 `python repr`/`xxd`로 **실 바이트 확인** 후 구분자를 `·`/`—`/`→`로 **명시**(또는 파일에서 추출). `assert count==1`은 0매치를 못 거르니(예외로 떨어짐) 앵커 정확도가 선결.
  - **end_anchor가 old-span 꼬리 내용을 포함하면 `assert count==1`이 통과해도 결과가 깨진다** (scenario-clone-error-fixes 2026-07-09): 새 문장 뒤에 `new_sentence + " " + end_anchor`로 이어붙이는 패턴에서, `end_anchor`를 "구 문장의 마지막 조각 + 뒤따르는 boilerplate 포인터"로 잡으면(예: `"...실측). 완료 슬라이스..."`) 그 마지막 조각(`"...실측)."`)이 **새 문장에도 그대로 이식**된다 — replace 자체는 `count==1`로 성공하고 예외도 안 나서 겉보기엔 정상 완료다. old_span 재구성이 바이트 단위로 원본과 일치하는지가 아니라, **new_span에 old 전용 내용이 안 섞였는지**를 별도로 확인해야 한다: end_anchor는 순수 boilerplate(다음 문장·포인터)만으로 최소화해서 잡고, splice 직후 `Read offset=<line> limit=1`(또는 python으로 해당 줄 전체 print)로 **새 문장 전체를 육안 재독**하는 걸 완료 조건에 넣는다.
