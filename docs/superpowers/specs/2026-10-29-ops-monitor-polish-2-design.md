# 운영실 모니터 개선 2차 (ops-monitor-polish-2) — 설계

> 유형: `user-path` · 결정 원천: `docs/superpowers/specs/2026-10-28-ops-monitor-polish-mockups/00-decisions.md` §⑥·§⑦·§문구(D6.1–D6.4, D7.1–D7.10, DW.1–DW.2). **여기와 결정 원천이 다르면 결정 원천이 이긴다.** ⑥ 배치 정본 = 목업 `03-editor-collapse-nav.html`. 글자 크기·간격 정본은 기존 설정 화면(Tailwind) 관례.
> 선행: ①a(`2026-10-21-ops-monitor-board-design.md`)·①b(`2026-10-22-ops-monitor-1b-design.md`)·1차(`2026-10-28-ops-monitor-polish-design.md`).
> **상태: 구현·머지 완료 (2026-10-29, 코드 `35c461a6`..`9158d29d`)** — 라이브 US1~US6+극단값 PROVEN(`docs/build-log.md`). §3.2-2 빈 비밀번호 규칙은 구현에서 뒤집힘(`u:@h` → `••••:@h`, 최종 보안 리뷰) — 판단·연기·보안 잔여 위험 → roadmap §B40.

## 사용자 스토리 (US)

- **US1 (⑥ 접기·목록)**: QA가 칸 9개짜리 기존 보드의 설정 화면을 연다 — 성공하면 모든 칸이 한 줄 요약(`칸 N · 이름 · 시나리오 · 주기 · 조건 수 · 표시 수`)으로 접혀 1280×800 화면에서 첫 칸을 화면 맨 위로 스크롤하면 9번째 칸까지 한 화면에 보이고(접힌 칸 높이 ≤ 48px), 오른쪽 칸 목록은 스크롤 없이 9개가 다 보이며, 오른쪽 화면에 고정된 칸 목록에서 "7"을 누르면 그 칸으로 이동하며 펼쳐지고, `모두 펼치기`/`모두 접기`가 동작한다.
- **US2 (⑥ 오류 찾기)**: QA가 오류가 있는 칸을 둔 채 저장을 누른다 — 성공하면 오류 칸이 자동으로 펼쳐지고 칸 머리 줄엔 `⚠ 사유`, 오른쪽 목록엔 `⚠`(D6.2·목업)가 보여 어디를 고칠지 바로 안다(시나리오 미선택은 해당 칸 전부, 서버 검사 오류는 첫 오류 칸 하나). 새로 추가한 칸은 펼친 채로 나오고, 태블릿 폭 이하에서는 오른쪽 목록 없이 접기만 된다.
- **US3 (⑦ 실패 당시 응답 보기)**: 운영자가 실패 막대를 뒤늦게 발견한다 — 성공하면 그 막대를 눌러(창 모드·전체화면 모두) 그 점검 1회의 판정·사유·응답 시간과 스텝별 요청(메서드·URL·헤더·본문)·응답(상태·헤더·본문, JSON 트리, 감싼 JSON 풀기)을 보고, 가는 막대도 마우스를 올리면 강조되며 시각이 보이고, 기록 창이 떠 있어도 뒤 벽은 계속 갱신된다.
- **US4 (⑦ 공용 화면 안전)**: 운영실 공용 화면에서 기록 창을 열어도 `Authorization`·`Cookie` 등 인증 값과 URL 속 비밀번호는 `••••`로 가려져 있고, 요청 본문은 가려진 채 `보기`를 눌러야만 보이며, 점검 1회 기록이 상한을 넘으면 넘친 본문에 "잘림" 표시가 붙고, 기록이 없는 막대(보관 구간에서 밀려남·통째 시간 초과)는 "기록 없음"으로 안내된다.
- **US5 (⑦ 상한 설정)**: QA가 큰 응답을 끝까지 봐야 하는 보드에서 설정 화면의 "점검 기록 상한"을 128에서 512(KB)로 올린다 — 성공하면 옆에 이 보드의 최악 메모리(칸 9개·막대 300개면 `이 보드 최대 약 1,350 MB (본문 기준)`)가 바로 보이고, 저장 후 다음 점검부터 512KB까지 잘리지 않고 기록된다.
- **US6 (문구)**: QA가 미리 실행 결과에서 값을 누른다 — 성공하면 선택지가 `조건으로 추가` / `화면에 추가`로 보이고, 설정 화면 어디에도 "벽"이라는 말이 남지 않는다.

## 1. 배경·목표·비목표

1차(ops-monitor-polish, 2026-10-29)가 판정·벽 화면 묶음(①③⑤②④)을 냈다. 2차는 설정 화면·기록 묶음(⑥⑦) + 사용자가 이번에 추가한 문구 변경(DW)이다. ⑥+DW와 ⑦은 서로 독립인 두 덩어리라 plan에서 **따로 green인 task 묶음**으로 순서를 잡고(⑥/DW 먼저), 라이브 검증도 덩어리별로 행을 나눈다.

**목표**: ⑥ 설정 화면 칸 접기·한 줄 요약·오른쪽 고정 칸 목록·모두 펼치기/접기·오류 칸 자동 펼침 / ⑦ 점검 1회 기록(요청·응답)을 컨트롤러 메모리에 막대 구간만큼 보관 + 막대 클릭 기록 창 + 보드 단위 기록 상한 설정 + 비밀 가리기(서버 보관 전 인증 값, 화면 요청 본문 기본 가림) / DW "벽" → "화면".

**비목표**(하지 않는다):
- 기록의 DB 영속·재시작 후 복원(D7.4 — 메모리만).
- 통째 시간 초과 점검의 "보낸 요청" 보관(엔진 변경 필요 — D7.9). 엔진(`crates/engine`) **무변경**.
- 키보드로 막대를 고르는 탐색(§7 판단 3).
- C 방식 띠(`StripCard`)에 막대 클릭 추가 — 띠엔 막대가 없다. 막대가 그려지는 `LatencyBars`(`MonitorPanel`만 렌더)에만.
- `BodyBlock`·`TestRunPanel`·`PreviewResult`·`HeaderTable` 동작 변경(§5.4 — `JsonValueTree`의 버튼 생략 옵션 하나만 추가).
- 응답 본문·비인증 헤더(`x-api-key` 등) 속 비밀 가리기(§6 잔여 위험 — 수용·기록).
- 칸 접힘 상태 저장(새로고침·재방문 시 D6.4 규칙으로 다시 계산).
- 여러 보드 합산 메모리 상한(§6·§7 판단 4).
- ② 보드 설정 내보내기/가져오기(별도 슬라이스 — 새 필드 `record_limit_kb`가 실릴 뿐).

## 2. 설정·와이어 (`crates/controller/src/monitor/config.rs` ↔ `ui/src/api/monitors.ts` 1:1)

### 2.1 `BoardConfig.record_limit_kb` (D7.7·D7.8)

- `pub record_limit_kb: u32` — 점검 1회 기록의 **본문 합계** 상한(KB, 1KB = 1024바이트). `Default` = **128**. `BoardConfig`는 이미 컨테이너 `#[serde(default)]`(`config.rs:216`)라 키 없는 옛 행은 128로 읽힌다.
- 검증(`validate_and_normalize`, 보드 단위): `16..=1024` 밖이면 `Err("점검 기록 상한은 16~1024KB여야 합니다")`.
- 저장 경로 = 기존 보드 저장(`PUT /api/monitor-boards/{id}` → `reconcile`, 점검 재시작). 전용 경로 없음.
- UI `BoardConfigSchema`에 `record_limit_kb: z.number()`(required — 서버가 항상 emit). 새 보드 기본 config(`MonitorEditPage` 초기값)에 `record_limit_kb: 128`.

### 2.2 칸 오류 메시지 접두 (US2)

- `validate_and_normalize`가 칸별 `validate_panel` 오류를 **`칸 {n}: {원 메시지}`**(n = 1부터, 칸 배열 순서 = 화면 "칸 N")로 감싼다. 검사는 첫 오류에서 멈추므로(`config.rs` 칸 루프 `?`) 한 번 저장에 서버 오류 칸은 **하나**다. 보드 단위 오류(보드 이름·칸 수·칸 id 중복·기록 상한)는 접두 없음.
- `preview_check`는 `validate_panel`을 직접 부르므로 **접두 없음**(현행 유지).
- UI는 저장/시작 실패(`ApiError` status 400) 메시지를 정규식 `^칸 (\d+): (.+)$`로 읽어 그 칸에 오류를 단다(§4.3). 맞지 않으면 기존처럼 하단 Callout만.
- 기존 Rust 테스트 중 `validate_and_normalize`를 거친 칸 오류 문자열을 **정확히** 단언하는 것은 접두를 반영해 고친다(`crates/controller/tests/monitor_boards_api_test.rs:172`는 `contains("칸")`이라 영향 없음 — 구현 중 `grep -n "validate_and_normalize" crates/controller/src/monitor/config.rs`로 단언 전수 확인).

### 2.3 DW — 서버 오류 문구 "벽" → "화면"

`config.rs`의 표시 항목 검증 오류 6종 `"벽 표시 항목…"`(`config.rs:375-400`) → `"화면 표시 항목…"`(같은 파일 테스트 기대 문자열도). 설정 화면 저장 오류로 사용자에게 보인다.

### 2.4 기록 조회 API (D7.2·D7.4)

`GET /api/monitor-boards/{id}/panels/{panel_id}/records/{at_ms}`

- `at_ms` = `CheckResult.at_ms`(그 칸의 점검 시작 epoch ms — 한 칸의 점검은 겹치지 않으므로(`panel_loop` 순차) 칸 안에서 유일).
- 200 본문 `CheckRecord`:
  ```
  {
    "at_ms": i64,
    "limit_kb": u32,                 // 이 기록을 만들 때 적용된 상한
    "result": CheckResult,           // 전체(reason·detail·display 포함 — /status의 최신-외 생략과 무관)
    "trace": ScenarioTrace | null,   // §3.2로 가공된 사본
    "clipped": [ { "step": u32, "side": "request" | "response" } ]
  }
  ```
  - `clipped[].step` = **`trace.steps` 배열 인덱스**(시나리오 스텝 순번 아님 — 루프 반복은 같은 `step_id`가 여러 행). `side`는 Rust enum `ClipSide { Request, Response }` + `#[serde(rename_all = "lowercase")]`.
  - 모든 필드 항상 emit(`null`/`[]` 포함 — UI Zod는 `trace`에 `.nullable()`, 배열 required, `.optional()`/`.default()` 금지 — `ui/CLAUDE.md` 함정).
- 404(`ApiError::NotFound`): 보드 없음 / 보드 꺼짐 / 칸 없음 / 그 `at_ms` 기록 없음 — 구분하지 않는다(UI 문구 하나).
- **없는 보드 id로 감독자 슬롯을 만들지 않는다**: 조회는 `existing_slot`만 쓴다(`monitor_boards.rs` 모듈 문서의 "미지의 id로 슬롯 생성 = 메모리 무한 증가" 함정).
- **직렬화**: 워크스페이스 serde에 `rc` feature가 없어 `Json(Arc<CheckRecord>)`는 컴파일되지 않는다. 핸들러는 `&*rec`를 `serde_json::to_vec`로 직렬화해 `application/json` 응답으로 낸다(수 MB 기록을 복제하지 않기 위해 — feature 추가 대신).
- 라우트 등록은 `crates/controller/src/app.rs`의 기존 `/monitor-boards/{id}/status` 옆.

## 3. 컨트롤러 — 기록 만들기·보관 (`crates/controller/src/monitor/`)

### 3.1 보관 (`supervisor.rs`)

- `PanelBuf`에 `records: VecDeque<Arc<CheckRecord>>` 추가. 결과 버퍼(`results`, 최대 300)와 **별도**로 두어 `snapshot()`(매 1초 `/status`가 부름)이 기록을 복제하지 않게 한다.
- `spawn_panel`이 보드의 `record_limit_kb`를 인자로 받고, 점검 클로저가 `run_check`의 `(trace, result)`로 §3.2 순수 함수를 불러 `(CheckResult, Arc<CheckRecord>)`를 낸다. `panel_loop`는 그 쌍과 칸의 `bar_count`(새 인자)를 `RunningGuard::finish`에 넘긴다(기존 `panel_loop` 단위 테스트 호출부는 새 시그니처에 맞춰 고침). 취소로 drop된 점검은 결과도 기록도 남기지 않는다(현행 의미 유지).
- `finish`: 결과와 기록을 **같은 락 구간**에서 넣고, 기록은 `while records.len() > bar_count { pop_front }`(**`while`** — `bar_count`가 300→10으로 줄면 한 번에 줄어야 함; 현 `results`의 `if`는 길이 1씩 늘어 충분하지만 기록은 아님). 버린 `Arc`들은 지역 `Vec`에 모아 **락을 푼 뒤** drop(수백 MB 해제가 `snapshot()`이 같이 잡는 락 안에서 일어나지 않게).
- 결과가 있는 모든 점검(정상 포함)에 기록이 생긴다 — 어느 막대든 누를 수 있으므로.
- `reconcile`이 칸 id 버퍼를 유지하므로 기록도 유지된다. 상한이 줄어든 경우 이미 보관된 기록은 옛 상한 그대로 남는다(수용 — 막대 구간이 지나면 사라짐). 보드 끄기·삭제·`stop_all` → 버퍼째 폐기(현행).
- 조회: `MonitorSupervisor::record(&self, board_id, panel_id, at_ms) -> Option<Arc<CheckRecord>>` — `existing_slot` → `view` 락 → 칸 버퍼 락 → `records`를 뒤에서부터 `at_ms` 일치 검색 → `Arc` 복제 후 락 해제.

### 3.2 기록 가공 — 순수 함수 (새 파일 `monitor/record.rs`)

`pub fn build_record(result: &CheckResult, trace: Option<ScenarioTrace>, limit_kb: u32) -> CheckRecord`

1. **인증 값 가리기(D7.6, 서버에서 — 보관 전)** — 각 스텝 `request.headers`·`response.headers`에서 이름이 인증 헤더 4종(`set-cookie`·`cookie`·`authorization`·`proxy-authorization`, 대소문자 무시 — `config.rs`의 `AUTH_HEADERS`를 `pub(crate)`로 열어 재사용)인 값과 `response.set_cookies` 항목을 진단 정보는 남기고 비밀만 가린다:
   - 원칙: **비어 있지 않은 비밀 부분만** `••••`로 바꾼다. 비밀 부분이 비었으면 그대로 둔다(가릴 것이 없음 — "토큰이 비어서 401"을 진단할 수 있게; 엔진은 빈/미바인딩 `{{token}}`을 `"Bearer "`로 낸다 — `executor.rs:441-446`).
   - `authorization`·`proxy-authorization`: 값에 공백이 있으면 첫 공백까지(스킴)는 남기고 나머지가 비어 있지 않으면 가림 — `Bearer abc` → `Bearer ••••`, `Bearer ` → `Bearer `(그대로). 공백이 없으면 값 전체가 비밀 — `abc` → `••••`, `""` → `""`. 나머지가 공백뿐이면(`Bearer   `) 빈 것으로 보고 그대로.
   - `cookie`: `;`로 나눈 각 쌍에서 `=` 앞 이름은 남기고 값이 비어 있지 않으면 가림 — `a=1; b=2` → `a=••••; b=••••`, `a=; b=2` → `a=; b=••••`. `=`가 없는 쌍은 통째로 비밀 — `abc123` → `••••`(빈 쌍은 그대로).
   - `set-cookie`(헤더와 `set_cookies` 둘 다): 첫 `=` 앞 이름만 남기고, 첫 `;` 전까지의 값이 비어 있지 않으면 나머지 통째로 `••••` — `sid=x; Path=/` → `sid=••••`, `sid=; Max-Age=0`(로그아웃 쿠키) → `sid=`. 첫 `;` 전에 `=`가 없으면 통째로 `••••`(빈 값은 그대로).
2. **URL 사용자정보 가리기**: `request.url`의 사용자정보(`scheme://` 뒤 첫 `/`·`?`·`#` 전의 마지막 `@` 앞)를 **원문 문자열에서 그 구간만** 바꾼다(`Url`로 다시 직렬화하지 않음 — 한글 경로·쿼리 퍼센트 인코딩·끝 `/` 추가 같은 정규화 방지; 새 crate 없음). `user:pass@` → `user:••••@`(~~비밀번호가 비면 그대로~~ → **구현: 비밀번호가 비면 사용자명이 자격 증명이므로 `••••:@`** — roadmap §B40 R1), 비밀번호 없는 `token@` → `••••@`(사용자명 자리에 토큰을 넣는 경우), 사용자정보 없는 URL은 바이트 동일.
3. **흐름 변수 비우기**: `trace.final_vars`와 각 스텝 `extracted`를 비운다(추출 토큰이 메모리에 남지 않게 — 기록 창은 둘을 보여 주지 않는다).
4. **본문 상한(D7.7)**: 예산 = `limit_kb × 1024` 바이트. 스텝 순서대로, 스텝마다 요청 본문(`Some`일 때) → 응답 본문 순으로 남은 예산만큼 남긴다. 본문이 남은 예산보다 길면 **UTF-8 문자 경계**에서 자르고(`is_char_boundary` 뒤로 걷기 — `str::floor_char_boundary`는 MSRV `rust-version = "1.85"`보다 새 API라 `clippy::incompatible_msrv`로 게이트 실패) `clipped`에 `{step, side}`를 넣는다. 예산이 0이 된 뒤의 본문은 빈 문자열이 되고 역시 `clipped`에 들어간다(원래 빈 본문·`None`은 넣지 않음). 헤더·URL은 예산에 넣지 않는다(§7 판단 4).
5. 엔진이 이미 1MiB에서 자른 응답(`body_truncated = true`)은 플래그를 그대로 둔다 — UI가 두 종류의 잘림을 구분해 보인다.
6. `trace`가 `None`(설정 오류로 요청 전 멈춤, 또는 바깥 `timeout`이 trace를 통째로 취소 — `check.rs:615-663`)이면 `trace: None`, `clipped: []`.
7. `CheckRecord { at_ms: result.at_ms, limit_kb, result: result.clone(), trace, clipped }` — `Serialize`(§2.4 와이어와 1:1).

요청 본문은 서버에서 가리지 않는다 — 보관하되 **화면에서 기본으로 가린다**(§5.3, D7.10).

## 4. 설정 화면 (`MonitorEditPage.tsx`·`PanelEditor.tsx`)

### 4.1 칸 카드 머리 = 접기 토글 + 한 줄 요약 (D6.1, 목업 03)

- `PanelEditor`의 머리 줄(지금 `칸 N` 제목 + `칸 삭제`)이 접기 토글이 된다. 토글은 `<button aria-expanded>`(접힘 `▸` / 펼침 `▾`), 접근 가능한 이름에 `칸 N`과 칸 제목을 포함.
- 머리 줄 내용(목업대로 접힘·펼침 **둘 다** 같은 요약): `▸|▾ 칸 N  {제목}  {시나리오 이름} · {주기}초 · 조건 {n} · 표시 {n}`. 제목이 비면 `(제목 없음)`, 시나리오 미선택이거나 목록에 없으면 `시나리오 —`. 한 줄 고정·말줄임(`min-w-0 truncate`). 펼침이면 오른쪽에 `칸 삭제`(기존 조건 `canRemove`).
- 머리 줄 구조: 토글 `<button>`(▸|▾ + 요약 텍스트, `flex-1 min-w-0`)과 `칸 삭제` 버튼은 **형제**(버튼 안 버튼 금지).
- 크기: 접힌 칸은 `px-4 py-2` 한 줄(높이 ≤ 48px — 16 + text-sm 줄 20 + 테두리 2 = 38px; 머리 줄의 아래 여백 `mb-3`(`PanelEditor.tsx:152`)과 `p-4`는 **펼쳤을 때만**), 칸 카드 사이 간격 `gap-2`(지금 `gap-4`) — US1 산수: 9 × 48 + 8 × 8 = 496px < 1280×800 본문 높이(≈ 800 − 앱 머리 61). 펼친 칸은 지금처럼 `p-4`.
- **펼친 칸**은 accent 테두리(목업 칸 2), **오류 칸**(§4.3)은 빨간 테두리 + 요약 대신 `⚠ {사유}`(목업 칸 3). 오류가 우선.
- 접힌 칸의 편집 내용은 **언마운트하지 않고 HTML `hidden` 속성으로 숨긴다** — 미리 실행 결과·조건 편집 중 상태가 접었다 펴도 남는다. (RTL `getByRole`은 `hidden` 안 요소를 찾지 못한다 — §9 테스트 이행.)
- 카드 루트에 `id="panel-{panel.id}"`(목록 이동 대상).

### 4.2 펼침 상태 (D6.3·D6.4)

- BoardForm이 펼친 칸 id 집합을 가진다. 초기값: 기존 보드 = **빈 집합(전부 접힘)**, 새 보드(`/monitors/new`) = 기본 칸 1개 **펼침**.
- `+ 칸 추가`로 생긴 칸 = 펼침. 칸 삭제 = 집합에서 제거.
- `+ 칸 추가` 옆(같은 줄, 목업대로)에 `모두 펼치기` / `모두 접기` 두 버튼.
- **재마운트 넘기기**: 새 보드의 첫 저장·시작 실패는 `navigate('/monitors/{id}', {replace})`로 `BoardForm key`가 `"new"`→id로 바뀌어 **재마운트**된다(`MonitorEditPage.tsx:42·56·128·162`). 펼침 집합을 잃지 않도록 이 두 `navigate`의 `state`에 `expanded: string[]`(칸 id)를 함께 싣고, BoardForm 초기값은 `location.state.expanded`가 있으면 그것을 쓴다(기존 `startError` 전달과 같은 방식). 읽은 뒤에는 `navigate(pathname, { replace: true, state: null })`로 state를 비워 새로고침이 D6.4 규칙(전부 접힘)으로 돌아가게 한다(`startError`도 함께 비워짐 — 새로고침에 옛 오류가 다시 뜨지 않음). 시작 실패의 칸 오류는 재마운트 후 `startError`를 §4.3 정규식으로 다시 읽어 복원한다. 칸 편집기 내부 상태(미리 실행 결과)는 이 재마운트에서 사라진다 — 현행과 같음(수용).
- 기존 보드의 저장(`adopt`)은 재마운트가 없어 펼침 상태가 그대로 남는다.

### 4.3 칸 오류 (D6.1·D6.4 "저장 시 오류 칸 자동 펼침")

- BoardForm에 칸 id → 사유 맵. 채우는 곳 두 군데:
  1. 기존 클라 검사 `valid()`(시나리오 미선택): 해당 칸 **전부**에 `ko.monitor.scenarioRequired`.
  2. 저장/시작 실패가 `ApiError` 400이고 메시지가 `^칸 (\d+): (.+)$`이면 그 번호의 칸 하나에 캡처한 사유.
- 오류가 생긴 칸은 **자동으로 펼친다**. 저장/시작을 다시 누르면 맵을 비우고 새로 채운다. 칸을 편집(`onChange`)하면 그 칸의 오류만 지운다.
- 하단 오류 Callout(기존)은 그대로 원 메시지(접두 포함)를 보인다. 시나리오 select 아래 필드 오류(기존 `scenarioError`)도 그대로.

### 4.4 오른쪽 칸 목록 (D6.2·D6.4)

- `lg`(1024px) 이상에서만 보이는 오른쪽 열(`hidden lg:block`). 열 안의 목록 상자가 `sticky top-4 self-start`(flex/grid 안에서 늘어나 sticky가 무력해지지 않게)로 스크롤해도 화면에 붙어 있다. 그보다 좁으면 목록 없이 4.1–4.3만.
- 머리 `칸 목록`, 항목 = `{N} {제목 또는 (제목 없음)}`(한 줄 말줄임) + 오류 칸 `⚠`. **펼친 칸 항목은 강조**(목업 `2 더비온 2.0` — 배경 + 왼쪽 막대). 항목은 버튼: 누르면 그 칸을 펼치고 `scrollIntoView({ block: "start" })` 후 그 칸 토글 버튼에 포커스.
- 맨 아래 `저장 · 모니터 시작 ↓` — 누르면 저장/시작 버튼 줄로 스크롤.
- 페이지 레이아웃: 왼쪽 본문 열(보드 설정 박스·칸 카드·버튼 줄) + 오른쪽 목록 열. 앱 `main`이 `max-w-6xl`(`Layout.tsx:50`, ≈1104px 내용 폭)이라 본문 열은 그만큼 좁아진다 — 칸 편집 그리드 `sm:grid-cols-2`·조건 줄이 넘치지 않는지 라이브 실측(폭 1024·1280).

### 4.5 기록 상한 필드 (D7.8)

- 보드 설정 박스에 다섯째 필드 `점검 기록 상한 (KB)` — 숫자 입력 `min 16 max 1024`.
- 필드 아래 힌트 `이 보드 최대 약 {X} MB (본문 기준)` — X = `Σ(칸별 bar_count) × record_limit_kb ÷ 1024`. X < 10이면 소수 첫째 자리(`0.2`), 이상이면 반올림 정수 + 천 단위 쉼표(`1,350`). 입력이 범위 밖이면 힌트 대신 필드 오류 `16~1024 사이로 입력하세요`(저장은 서버 검증이 최종).

### 4.6 DW 문구

`ko.monitor`의 "벽" 8건 → "화면"(§8 표). 테스트는 `ko.*` 키로 참조하므로 문자열 리터럴 수정 불필요(구현 후 `grep -rn "벽" ui/src`로 값 0건 확인 — 주석은 무관).

## 5. 벽 화면 — 막대 클릭 기록 창 (`LatencyBars.tsx`·`MonitorPanel.tsx`·`MonitorDisplayPage.tsx`·새 `CheckRecordDialog.tsx`)

### 5.1 막대 클릭 영역 (D7.2)

- `LatencyBars`에 선택 prop `onSelect?: (r: CheckResult) => void`.
- 있으면 막대 영역 위에 **별도 오버레이 층**을 하나 더 둔다: 막대 층과 같은 `barSlots()` 인덱스·같은 flex·같은 칸 패딩으로 `barCount`개의 **칸 전체 높이 투명 열**(지금 정상 막대 div는 그 자체가 높이 `%`인 막대라 높이를 바꿀 수 없음 — `LatencyBars.tsx:167·222-232`). 결과가 있는 열만 클릭 가능(`cursor: pointer`, 클릭 → `onSelect(r)`), 빈 열(`null` 슬롯)은 반응 없음. 오버레이는 기준선 라벨 열·축 줄을 덮지 않는다.
- 마우스를 올린 열: 오버레이 열 자체에 강조(반투명 흰 채움 + 테두리 — 정상·실패·설정 오류 위 모두 보이게) + 막대 영역 위쪽에 그 점검 시각 `HH:MM:SS` 라벨(pointer-events 없음, 축 글자 크기). 떼면 사라짐. **막대 층 DOM·스타일은 무변경** — 강조가 없을 때 그림은 지금과 픽셀 동일, 기존 `data-testid="bar-slot"` 단언 무영향.
- `onSelect`가 없으면 오버레이 자체가 없다(현행 그대로).

### 5.2 열기·전체화면 (D7.2)

- `MonitorPanel`이 `LatencyBars`에 `onSelect`를 넘기고, `MonitorDisplayPage`가 `{panel, result}`를 받아 기록 창을 연다. 창 모드·전체화면 모두.
- 전체화면의 "마우스 버튼 누르면 전체화면 종료" 규칙(`MonitorDisplayPage.tsx:168-190`, 한 번만 등록되는 `mousedown` 리스너)에 예외 2개: ① 누른 대상이 막대 오버레이 열 안(`closest('[data-bar-hit]')`) ② 기록 창이 열려 있는 동안의 모든 누름(창 안·뒷 배경). ②는 리스너가 한 번 등록되므로 **ref**로 읽는다. 그 외는 현행대로 종료.
- **ESC**: 창 모드에서는 기록 창을 닫는다(`Modal`). 전체화면에서는 브라우저가 ESC를 전체화면 종료에 먼저 쓰고 페이지에 키 이벤트를 넘기지 않을 수 있다 — 그러면 첫 ESC = 전체화면 종료(창은 열린 채), 둘째 ESC = 창 닫기. 브라우저 고정 동작이라 수용하고 실제 동작은 라이브에서 실측·기록한다. 창은 `×` 버튼·뒷 배경 클릭으로도 닫힌다.
- `F` 키 전체화면 토글은 창이 열려 있어도 그대로 동작(무해).
- 기록 창이 떠 있어도 `/status` 폴링·벽 갱신은 계속(창은 반투명 배경 위 — 기존 `Modal`).

### 5.3 기록 창 내용 (D7.3·D7.6·D7.9·D7.10)

- `Modal` 하나(제목 `{칸 제목} · {YYYY-MM-DD HH:MM:SS}`). 데이터 = React Query `["monitor-record", boardId, panelId, at_ms]`, `staleTime: Infinity`, `retry: false`(기록은 바뀌지 않음).
- **머리**: 판정(기존 `stateOk`/`stateFail`/`stateConfigError` 라벨) · 응답 시간 — **누른 막대의 `CheckResult`로 즉시** 표시. 사유·detail은 기록이 도착하면 기록의 `result`로(최신 외 막대는 `/status`에 사유가 없으므로).
- **본문**:
  - 로딩 → 기존 `ko.monitor.loading` / 404 → `recordMissing` / 기타 오류 → `recordLoadError(msg)`.
  - `trace === null` → verdict가 `config_error`면 `recordNoTraceConfig`, 아니면 `recordNoTraceTimeout`.
  - `trace.error`가 있으면(설정 단계 실패 — 스텝이 비어 있음) `recordTraceError(error)` 한 줄.
  - `trace.truncated` → 목록 위에 `recordTraceCut`.
  - 스텝 목록(`trace.steps` 순서): HTTP 스텝 = **접힌 한 줄**(`스텝 이름 · METHOD URL · 상태 · ms`, 오류가 있으면 빨간 오류 문구) — 누르면 펼쳐 요청 헤더·요청 본문·응답 헤더·응답 본문. **기본 전부 접힘**(대량 데이터 자동 노출 금지 — 사용자 선호), 단 스텝이 1개뿐이면 펼침. `if` 스텝 = `조건 분기 → {branchText(branch)}`(기존 `ui/src/scenario/chipResults.ts` `branchText` 재사용). 루프 안 스텝은 `#{loop_index}` 칩.
  - 스텝 이름: `useScenarios()`의 칸 시나리오 YAML을 `parseScenarioDoc`+`flattenHttpSteps`로 이름 맵(설정 화면 `PanelEditor`와 같은 방법). 못 찾으면 `step_id`.
  - 헤더 = 기존 `HeaderTable`(읽기 전용, 버튼 없음). 가린 값은 서버가 준 그대로 + 헤더 표 아래 `recordMaskedHint` 한 줄(값에 `••••`가 하나라도 있을 때만).
  - **요청 본문 = 기본 가림(D7.10)**: 본문이 있으면 내용 대신 `recordReqBodyHidden` 안내 + `보기` 버튼. 누르면 그 스텝의 요청 본문이 보이고 버튼은 `가리기`로. 드러냄 상태는 창 안 스텝별 로컬 상태 — **창을 닫으면 다시 가려진다**. 가림 상태에서도 잘림 표시(아래)는 보인다.
  - 본문 블록 = 새 **인라인** 블록(`BodyBlock` 아님 — 그 "전체 보기"가 `Modal` 안의 `Modal`이 되어 ESC가 두 창을 함께 닫는 함정). 최대 높이 + 내부 스크롤.
    - `parseBodyJson`(③ 풀기 공용)으로 JSON이고 **본문 길이 ≤ 64KB**면 기본 = 읽기 전용 `JsonValueTree` + `트리`/`원문` 토글. 64KB 초과면 `<pre>` 원문만(트리 토글 없음 + `recordTreeTooLarge` 안내 — `JsonValueTree`는 모든 노드를 즉시 그려 1MiB JSON이면 벽 PC가 멈춘다). JSON 아님 → `<pre>`. 상한에서 잘린 본문은 JSON 중간에서 끊겨 파싱되지 않으므로 항상 `<pre>`. 64KB는 **UTF-8 바이트**(`new TextEncoder().encode(body).length`) 기준 — 서버 상한과 같은 단위.
    - 풀었으면 `previewUnwrapped` 안내.
    - 잘림: `clipped`에 있으면 `recordClipped(limit_kb)`, 엔진 잘림(`body_truncated`)이면 `recordEngineTruncated`.
- 창을 열어 둔 채 막대 구간이 지나 기록이 버려져도 이미 받은 내용은 그대로 보인다(캐시).

### 5.4 공용 컴포넌트 변경 — 최소

- `JsonValueTree`(`ui/src/components/response/JsonValueTree.tsx`): `actionLabel`·`renderConfirm`을 **선택**으로 — 없으면 잎에 버튼을 그리지 않는다. 기존 호출자(설정 화면 미리 실행·에디터 test-run)는 둘 다 넘기므로 무영향.
- `BodyBlock`·`TestRunPanel`·`PreviewResult`·`HeaderTable` 무변경.

## 6. 보안

- **새 sink**: 지금까지 점검 trace는 판정 후 버려졌다. 이제 요청·응답(본문 포함)이 **막대 구간 동안 컨트롤러 메모리에 남고, 인증 없는 REST로 조회되며, 운영실 공용 화면에서 클릭 한 번으로 열린다** — 메모리 `security-gate-judgment-override`의 "ephemeral → retained" 경우. `finish-slice` §0 grep 결과와 무관하게 `security-reviewer` APPROVE 필수.
- **막는 것**:
  - 서버 보관 전: 인증 헤더 4종(요청·응답)·`set_cookies` 값, URL 사용자정보 비밀번호 → `••••`(스킴·쿠키 이름은 남김 — §3.2) · `final_vars`·`extracted` 폐기 · 본문 상한.
  - 화면: 요청 본문 기본 가림 + `보기`(D7.10, 사용자 결정) — 지나가는 사람이 막대를 눌러도 로그인 비밀번호가 바로 뜨지 않는다.
- **잔여 위험(수용 — roadmap §B 기록, 사용자 확인 2026-10-29 D7.10)**:
  - 요청 본문은 서버에 원문으로 보관되고 API로 조회된다(`보기`는 화면 가림이지 접근 통제가 아니다 — 이 도구엔 인증이 없다). 같은 API가 이미 `preview-check`로 전체 trace를 내보내므로 API 경로의 노출 종류는 새롭지 않고 보관 기간이 늘었다.
  - 응답 본문 속 토큰·개인정보, 사용자정보 외 URL 경로 속 비밀, 비인증 헤더(`x-api-key` 등), URL 쿼리 문자열 속 비밀은 기록 창에 그대로 보인다(응답 본문은 D7.1의 진단 목적 그 자체).
  - 헤더·URL은 예산 밖이라 메모리 상한이 본문 기준이고, 보드가 여럿이면 합산 상한이 없다(보드 하나 1024KB·칸 9·막대 300 ≈ 2.7GB). 대상은 운영자가 고른 사내 API라 수용.
  - 해소 경로(후속 후보): 칸 설정 "본문 기록 안 함" 스위치 · 키 이름 기반 본문 마스킹 · 합산 메모리 상한.

## 7. `[Claude]` 판단 목록 (사용자 승인분은 결정 원천 D7.7–D7.10·DW에 기록)

1. 상한 = 보드 단위 숫자 하나, 16–1024KB, 기본 128, 본문 합계 기준(D7.8 승인).
2. 건당 64KB 폐기·전체 상한으로 통합(D7.7 승인).
3. 막대 선택은 마우스 전용. 키보드 탐색(칸당 최대 300개 막대에 탭 정지)은 범위 밖 — 기록 창 자체는 키보드로 닫기·스크롤·스텝 펼치기·`보기` 가능.
4. 헤더·URL은 상한 계산에서 빠진다 — 힌트에 `(본문 기준)` 명시.
5. 인증 값 가리기는 기록 창이 아니라 **서버 보관 전**에(D7.6 강화), 응답 쪽 인증 헤더·`set_cookies`·URL 사용자정보까지 확장, 스킴·쿠키 이름·빈 값은 남겨 진단 가능하게.
6. 칸 오류 위치 전달 = 서버 오류 메시지 접두 `칸 N: ` + UI 정규식(구조화 오류 필드 신설 기각 — `ApiError::BadRequest(String)` 와이어를 바꾸지 않는 최소 변경).
7. 접힌 칸은 언마운트하지 않고 `hidden`(미리 실행 결과 보존). 새 보드 첫 저장의 재마운트는 펼침 집합만 `location.state`로 넘긴다.
8. 기록 창 스텝은 기본 접힘(1개면 펼침), 본문은 인라인 블록(중첩 모달 회피), JSON 트리는 64KB 이하만.
9. 오른쪽 목록 표시 기준 = Tailwind `lg`(1024px), 펼친 칸 강조.
10. 전체화면에서 막대·기록 창 클릭은 전체화면을 끝내지 않음. 전체화면 ESC는 브라우저 동작에 맡김.
11. 요청 본문 `보기`는 칸 설정 스위치 없이 창 안 버튼만(D7.10 — 사용자 "보기를 원하면 버튼을 눌러서", "기본적으로 마스킹").

## 8. 문구 (`ui/src/i18n/ko.ts` `monitor` — byte-exact)

**DW 변경 8건** (키 유지, 값만):

| 키 | 지금 | 바뀜 |
|---|---|---|
| `condVolatileHint` | `매번 바뀌는 값이면 '='은 매 점검 실패하고 그 값이 벽에 표시됩니다` | `매번 바뀌는 값이면 '='은 매 점검 실패하고 그 값이 화면에 표시됩니다` |
| `condChooseDisplay` | `벽에 표시` | `화면에 추가` |
| `displayTitle` | `벽에 표시` | `화면에 표시` |
| `displayEmpty` | `미리 실행 결과에서 값을 눌러 벽에 표시할 값을 고릅니다` | `미리 실행 결과에서 값을 눌러 화면에 표시할 값을 고릅니다` |
| `displayMax` | `벽 표시는 최대 2개까지` | `화면 표시는 최대 2개까지` |
| `displayDup` | `이미 벽에 표시 중` | `이미 화면에 표시 중` |
| `displayAuthHeader` | `인증 헤더는 벽에 표시할 수 없음` | `인증 헤더는 화면에 표시할 수 없음` |
| `previewBodyClickHint` | `응답 본문 — 값을 누르면 조건이나 벽 표시를 추가합니다` | `응답 본문 — 값을 누르면 조건이나 화면 표시를 추가합니다` |

**신규**(키 이름은 구현 재량 — 아래 "키" 열은 이 문서 안에서 부르는 이름일 뿐, 값은 이대로):

| 키 | 값 |
|---|---|
| expandAll / collapseAll | `모두 펼치기` / `모두 접기` |
| noTitle | `(제목 없음)` |
| noScenario | `시나리오 —` |
| 요약 조각 | `{n}초` · `조건 {n}` · `표시 {n}` (구분자 ` · `) |
| navTitle | `칸 목록` |
| navJumpActions | `저장 · 모니터 시작 ↓` |
| recordLimit | `점검 기록 상한 (KB)` |
| recordLimitHint | `이 보드 최대 약 {X} MB (본문 기준)` |
| recordLimitRange | `16~1024 사이로 입력하세요` |
| recordMissing | `이 점검의 기록이 없습니다 — 기록은 막대 구간만큼만 보관되어 이미 지워졌습니다` |
| recordLoadError | `기록을 불러오지 못했습니다: {msg}` |
| recordNoTraceConfig | `요청을 보내기 전에 멈췄습니다(설정 오류) — 요청·응답 기록 없음` |
| recordNoTraceTimeout | `응답이 오기 전에 시간 초과 — 요청·응답 기록 없음` |
| recordTraceError | `점검 준비 중 오류: {error}` |
| recordTraceCut | `점검이 중간에 끊겨 그 전 스텝까지만 기록됐습니다` |
| 섹션 제목 | `요청 헤더` · `요청 본문` · `응답 헤더` · `응답 본문` |
| recordIfRow | `조건 분기 → {branch}` |
| recordMaskedHint | `인증 값은 ••••로 가렸습니다` |
| recordReqBodyHidden | `요청 본문은 가려져 있습니다` |
| 요청 본문 버튼 | `보기` / `가리기` |
| recordClipped | `기록 상한 {kb}KB에서 잘림` |
| recordEngineTruncated | `1 MiB에서 잘림 — 실제 응답은 더 큼` |
| recordTreeTooLarge | `64KB를 넘는 본문은 원문으로 표시합니다` |
| 본문 보기 토글 | `트리` / `원문` |

서버 문구: `점검 기록 상한은 16~1024KB여야 합니다`, 접두 `칸 {n}: `, 표시 항목 오류 6종 `벽 표시 항목` → `화면 표시 항목`.

## 9. 테스트·검증

- **Rust 단위**:
  - `record.rs`: 상한 경계(정확히 예산 = 안 잘림, +1바이트 = 잘림), 한글(3바이트) 중간 경계 → 문자 경계로, 요청→응답·스텝 순서 소비, 예산 소진 뒤 빈 문자열 + `clipped`, 원래 빈/`None` 본문은 `clipped` 제외, 가리기 표(`Bearer x`→`Bearer ••••`·`Bearer `→`Bearer `·`x`→`••••`·`a=1; b=2`→`a=••••; b=••••`·`a=; b=2`→`a=; b=••••`·`sid=x; Path=/`→`sid=••••`·`sid=; Max-Age=0`→`sid=`·`abc123`(cookie, `=` 없음)→`••••`·`Bearer   `→그대로·빈 값 유지·대소문자 무시·요청/응답 양쪽·비인증 헤더 원문), URL `https://u:p@h/x`→`https://u:••••@h/x`·`https://tok@h`→`https://••••@h`·`https://u:@h`→그대로·`https://h/경로?q=한글`(사용자정보 없음) 바이트 동일, `final_vars`·`extracted` 비움, `body_truncated` 보존, `trace None` 통과, `clipped` 직렬화 `{"step":0,"side":"request"}`.
  - `config.rs`: `record_limit_kb` 기본 128(키 없는 옛 JSON 포함), 15·16·1024·1025 경계, 칸 오류 접두 `칸 2: …`(둘째 칸 오류), 보드 단위 오류 접두 없음, 표시 항목 오류 문구 "화면".
  - `supervisor.rs`: 기록이 `bar_count`개로 잘림(오래된 것부터, `bar_count` 축소 시 한 번에), `at_ms` 조회 hit/miss, 없는 보드 id 조회가 슬롯을 만들지 않음(`boards` 맵 크기 불변), 보드 끄기 후 조회 `None`, `snapshot()` 결과 무변경.
- **통합**(`crates/controller/tests/monitor_boards_api_test.rs`): wiremock 대상 보드 시작 → `/status`에서 `at_ms` → 기록 200(요청 `Authorization: Bearer s3cret` → `Bearer ••••`, 응답 본문 일치, `clipped` `[]`) / 없는 `at_ms`·꺼진 보드·없는 칸·없는 보드 404 / 저장 400 메시지 접두 `칸 1: `.
- **UI 기존 테스트 이행**(명시 — 리뷰 적발):
  - `pages/__tests__/MonitorEditPage.test.tsx`: 기존 보드(`/monitors/B1`)를 렌더하는 케이스는 칸이 접혀 `hidden` 안 요소를 `getByRole`이 못 찾는다 → 로드 후 `모두 펼치기`를 누르는 공용 헬퍼로 이행(케이스별 의미 불변). jsdom은 CSS가 없어 `hidden lg:block` 목록이 **항상 렌더**되므로 칸 제목이 토글 요약·목록 버튼·제목 입력에 중복으로 나타난다 → 제목 텍스트 질의는 `within(칸 카드)`/`within(목록)`으로 범위를 좁힌다.
  - `record_limit_kb` required로 보드 fixture가 있는 5개 파일 갱신: `api/__tests__/monitors.test.ts`·`pages/__tests__/MonitorEditPage.test.tsx`·`MonitorListPage.test.tsx`·`MonitorDisplayPage.test.tsx`·`MonitorDisplayPage.fullscreen.test.tsx`.
- **UI 신규**(vitest/RTL): 요약 문자열·`(제목 없음)`·`시나리오 —`, 기존 보드 전부 접힘·새 보드 펼침·칸 추가 펼침, 모두 펼치기/접기, 접었다 펴도 미리 실행 결과 유지, 목록 클릭 → 펼침 + `scrollIntoView` + 포커스, 펼친 칸 목록 강조, 400 `칸 3: …` → 칸 3 펼침·요약/목록 `⚠`, 시나리오 미선택 칸 여럿 모두 `⚠`, 편집 시 그 칸 오류만 해제, 새 보드 첫 저장 후 펼침 유지(재마운트), 기록 상한 힌트(`0.2`·`1,350`)·범위 오류, `LatencyBars` 오버레이 클릭·빈 열 무반응·`onSelect` 없으면 오버레이 없음·hover 시각 라벨, 기록 창 상태(로딩 머리 즉시·404·trace null 2종·`trace.error`·끊김·가림 안내·요청 본문 기본 가림 → `보기` → 표시 → 창 닫고 다시 열면 가림·상한 잘림·엔진 잘림·풀기 안내·64KB 초과 원문·스텝 기본 접힘/1개 펼침·`branchText`), 전체화면 mousedown 예외 2종, `JsonValueTree` 버튼 없는 모드.
- **회귀 가드 이빨 실증**(고의 회귀 → RED → 원복 → GREEN): 기록 `bar_count` 자르기(`while`→`if`), 슬롯 미생성, 서버 가리기, 오류 접두 파싱, 전체화면 예외, 요청 본문 기본 가림.
- **라이브(필수 — 새 API·점검 경로·벽 화면)** `/live-verify`, ⑥/DW와 ⑦ 행을 나눠서:
  - US1–US6 척추 행.
  - 극단값(메모리 `live-verify-extreme-values-readable`): 칸 9개·40자 제목·긴 시나리오 이름의 접힌 요약/목록 말줄임, 막대 300개 칸의 가장 가는 막대 hover·클릭, 50스텝 시나리오 기록 창, 상한 16KB·1024KB, 1MiB 응답(원문 표시·멈춤 없음), 감싼 JSON 응답 트리.
  - 마운트되는 **모든 화면**(메모리 `live-verify-all-mount-paths`): 설정 화면 신규·기존 보드 × 폭 768·1024·1280, 벽 창 모드·전체화면 × 화면 방식 A·B(테두리)·C(실패 큰 칸).
  - 전체화면 ESC 실제 동작 실측·기록(§5.2).
- **보안**: §6 — `security-reviewer` 필수.

## 10. ADR-0053 보완 절 (구현 슬라이스에서 추가)

`## 보완 — ops-monitor-polish-2 (2026-10-29)`: 점검 결과 링버퍼 옆에 **점검 기록(요청·응답) 메모리 보관**을 둔다 — 칸별 막대 구간(`bar_count`)만큼, 보드 단위 본문 합계 상한(`record_limit_kb`, 기본 128KB, 16–1024), 인증 헤더·쿠키·URL 비밀번호는 보관 전 가림(스킴·이름 유지), 흐름 변수 폐기, 요청 본문은 화면에서 기본 가림 + `보기`, 재시작 시 소멸. "결과 DB 영속 비목표"는 그대로다.
