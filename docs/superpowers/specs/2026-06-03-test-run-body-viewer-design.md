# Test Run 본문 뷰어 — 작은 인라인 미리보기 + 전체 보기 모달

> 상태: 설계 (brainstorming 2026-06-03). 출처 = 사용자 요청("Test Run 후 HTTP Response가 길면 생략되는데, 보여주는 크기를 더 줄이고 팝업으로 전체를 볼 수 있게").
> 연관: ADR-0026(시나리오 에디터 test-run), 영역 C(`TestRunPanel`). 로드맵 §C / §D 와 무관한 순수 UI QoL + 엔진 상수 1개.

## 1. 문제

시나리오 에디터 test-run 결과(`TestRunPanel`)에서 HTTP 스텝 행을 펼치면 **응답 본문 전체(현재 백엔드 캡 16 KiB)** 가 `<pre>`에 통째로 인라인 렌더된다. 16 KiB를 넘으면 뒤가 잘리고 `… (truncated)`만 붙어, 사용자는 (a) 인라인이 너무 길어 패널이 폭주하고, (b) 잘린 뒤를 볼 방법이 없다. 요청 본문도 같은 방식으로 인라인 통째 렌더라 같은 통증.

## 2. 목표 / 비목표

**목표**
- 인라인은 본문을 **앞 N자(기본 500자)** 만 미리보기로 보여 패널을 작게 유지.
- **전체 보기 모달**(팝업)에서 본문 전체를 본다. 모달에 복사 / JSON 예쁘게 포맷 / 줄바꿈 토글.
- **응답 본문**과 **요청 본문** 둘 다 동일 처리.
- 응답 본문이 백엔드 캡을 넘으면 모달에 "잘림" 안내.

**비목표 (의도적 연기)**
- 캡·미리보기 길이의 **런타임 설정 UI** — 이번엔 상수 고정, 향후 옵션 메뉴로(§7).
- 요청 본문 백엔드 절단 — 요청 본문은 *우리가 보낸 것*(authored/렌더된 값, 크기 우리가 앎)이라 절단하지 않는다(§4.3).
- 부하 실행(run) 리포트의 본문 표시 — test-run trace 전용. 부하 경로엔 per-request 본문이 없다.

## 3. 결정 (사용자 확정 2026-06-03)

| 질문 | 결정 |
|---|---|
| 모달 "전체"의 범위 | **백엔드 캡 상향** — `MAX_TRACE_BODY_BYTES` 16 KiB → **1 MiB**. 1 MiB 이하 응답은 모달에서 끝까지. |
| 인라인 미리보기 | **앞 N자** — `INLINE_PREVIEW_CHARS = 500`. |
| 모달 부가 기능 | **복사 + JSON 포맷 토글 + 줄바꿈 토글** 3종 전부. |
| 요청 본문 | **같이 처리**(동일 미리보기 + 모달). |
| 1 MiB / 500자 설정화 | 이번엔 상수, **향후 옵션 메뉴**로 노출 — 로드맵에 연기 항목 추가(§7). |

## 4. 설계

### 4.1 백엔드 (엔진) — 응답 캡 상향만

`crates/engine/src/executor.rs`:
- `const MAX_TRACE_BODY_BYTES: usize = 16 * 1024;` → `1024 * 1024` (1 MiB).
- doc 주석 갱신: "display cap, 향후 옵션 메뉴로 설정화 예정(roadmap §B)".
- 그 외 절단 로직(`body_truncated = full_len > cap`, `from_utf8_lossy(&bytes[..min(cap)])`, 멀티바이트 경계 U+FFFD 허용) **무변경**.

**와이어 무변경**: `TracedResponse.body`/`body_truncated`는 그대로 → proto·controller·Zod 스키마·마이그레이션 손대지 않음. 캡 이하 응답은 캡 변경 전과 byte-identical(절단 안 일어남).

trade-off: test-run은 1 VU 단일패스라 본문 1 MiB가 trace JSON에 실려도 무해. 스텝이 많고 전부 대용량이면 trace JSON이 수 MiB가 될 수 있으나 수동 test-run 빈도상 수용.

### 4.2 UI — 재사용 가능한 모달 프리미티브 (신규)

이 코드베이스 **최초의 진짜 모달**이다(현재 `role="dialog"`/`createPortal`/`navigator.clipboard` 사용처 0, `RunDialog`는 인라인 패널). 응답·요청 양쪽이 쓰고 향후 다른 곳도 쓸 수 있게 작은 접근성 프리미티브로 뺀다.

`ui/src/components/Modal.tsx` — `<Modal open onClose title>{children}</Modal>`:
- `createPortal(…, document.body)`.
- 백드롭 `fixed inset-0 z-50 bg-black/40` — 클릭 시 `onClose`.
- 패널 `role="dialog" aria-modal="true" aria-label={title}`, 백드롭 클릭과 분리(stopPropagation).
- **Escape 닫기**(keydown 리스너) + **포커스 트랩**(Tab 순환) + **열 때 패널 포커스 / 닫을 때 트리거로 포커스 복원**.
- CSP `default-src 'self'`와 무관(같은 document, 외부 리소스 없음).

### 4.3 UI — 공유 `BodyBlock` (요청·응답 공용)

`TestRunPanel.tsx` 내부(또는 인접 파일)에 `BodyBlock({ body, truncated, label })`:
- `body`가 비어있으면(`""`/`undefined`) `null` 렌더.
- `body.length <= INLINE_PREVIEW_CHARS && !truncated` → 지금처럼 인라인 `<pre>` 통째(짧으면 버튼 불필요).
- 그 외 → 인라인엔 **앞 `INLINE_PREVIEW_CHARS`자 + `…`** 미리보기 + **`전체 보기`** 버튼. 버튼이 `open` state 토글 → `<Modal title={label}>` 렌더:
  - 툴바: `복사` / `포맷`(유효 JSON일 때만 활성, 원본⇄들여쓰기 2-space) / `줄바꿈`(wrap⇄가로 스크롤) / `닫기`.
  - 본문: 스크롤 가능한 `<pre>`(`max-h` + overflow). wrap 기본 = `whitespace-pre-wrap break-all`, off = `whitespace-pre overflow-x-auto`.
  - `truncated`면 상단 배너 "1 MiB에서 잘림 — 실제 응답은 더 큼".
- **복사**: `navigator.clipboard.writeText(현재 표시 텍스트)`(보이는 그대로 — 원본/포맷 토글 반영).
- **포맷**: `JSON.parse(body)` 시도 → 성공 시만 토글 노출/활성, `JSON.stringify(parsed, null, 2)`. 실패(비-JSON)면 토글 숨김/비활성.

`INLINE_PREVIEW_CHARS = 500` 상수(파일 상단, 향후 설정화 대상 §7).

### 4.4 `HttpRow` 배선

`HttpRow`(`TestRunPanel.tsx`)의 펼침 영역에서:
- 요청 본문 `{req.body && <pre>…</pre>}` → `<BodyBlock body={req.body ?? ""} label="요청 본문" />` (요청은 `truncated` 없음/false).
- 응답 본문 `<pre>{resp.body}{truncated?…}</pre>` → `<BodyBlock body={resp.body} truncated={resp.body_truncated} label="응답 본문" />`.

헤더 표·Set-Cookie·추출·unbound 등 나머지 행 정보는 무변경.

## 5. 영향 범위 (파일별)

| 파일 | 변경 |
|---|---|
| `crates/engine/src/executor.rs` | `MAX_TRACE_BODY_BYTES` 16 KiB→1 MiB + doc 주석 + 엔진 테스트 |
| `ui/src/components/Modal.tsx` | **신규** 접근성 모달 프리미티브 |
| `ui/src/components/scenario/TestRunPanel.tsx` | `BodyBlock` + `INLINE_PREVIEW_CHARS` + `HttpRow` 배선 |
| `ui/src/components/scenario/__tests__/TestRunPanel.test.tsx` | 미리보기/모달/토글/복사/배너 테스트 |
| `ui/src/components/__tests__/Modal.test.tsx` | **신규** Escape/백드롭/포커스 복원 테스트 |
| `docs/roadmap.md` | §7 연기 항목(설정화) 추가 |

proto·controller·worker·Zod 스키마·DB 마이그레이션 **무변경**.

## 6. 테스트

**엔진**
- 본문 > 1 MiB → `body_truncated == true` && `body.len() == MAX_TRACE_BODY_BYTES`.
- 본문 ≤ 1 MiB(예: 16 KiB+1) → `body_truncated == false` && 전체 보존.
- 기존 작은-본문 `!body_truncated` 단위테스트는 무영향.

**UI (RTL, jsdom)**
- 긴 응답 → 500자 미리보기 + `전체 보기` 버튼 / 짧은 응답 → 인라인 통째(버튼 없음).
- 긴 요청 본문도 동일.
- 버튼 클릭 → 모달 + 전체 본문 표시.
- JSON 포맷 토글 → 들여쓰기 출력 / 비-JSON이면 토글 없음.
- 줄바꿈 토글 → `<pre>` 클래스 전환.
- 복사 → `navigator.clipboard.writeText` 호출(모킹).
- Escape / 백드롭 클릭 → 닫힘, 트리거로 포커스 복원.
- `body_truncated` → 모달 절단 배너.

게이트: 엔진 `cargo test` + UI `pnpm lint && pnpm test && pnpm build`(`tsc -b`).

## 7. 연기 항목 (로드맵 §B로)

- **test-run 본문 표시 설정화**: `MAX_TRACE_BODY_BYTES`(1 MiB)·`INLINE_PREVIEW_CHARS`(500)를 옵션/설정 메뉴로 노출. 현재는 상수. §B2''의 "운영 상한 관리자 화면"(op-config 상한 모음)과 묶을 수 있음. → 로드맵에 추가.
- **요청 본문 백엔드 절단**: 현재 무절단. data-driven 대용량 주입으로 요청 본문이 커지면 trace JSON 비대 가능 → 필요 시 동일 캡(+`TracedRequest.body_truncated` 와이어 필드) 후속.
