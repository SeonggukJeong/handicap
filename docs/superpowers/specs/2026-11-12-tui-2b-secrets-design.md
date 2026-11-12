# 2b 후속 묶음 A — 비밀처럼 보이는 이름·잘린 본문 버튼·보드 글자 칸 거절 (tui-2b-secrets)

- 상태: **구현 완료** (코드 `0f8b874a`..`e901cc91`, 라이브 US1–US5 PROVEN) · 판단·연기·릴리즈 노트 → roadmap §B55 · §2.3 빈 값 규칙은 최종 보안 리뷰로 `키 있음`으로 정정됨
- 날짜: 2026-11-12 · 유형: `correctness-bug` + 보안 low/info · 출처: roadmap §B52 (2) 1–3번째 항목 · §B53 (2) "§B52 (2)의 남은 것"
- 범위: TUI(`crates/tui`) + GUI(`ui/src`) + 컨트롤러 검증(`crates/controller/src/monitor/config.rs`·`board_file.rs`) + 엔진 테스트 1개. 와이어·마이그레이션·엔진 실행 경로 무변경.

## 사용자 스토리 (US)

사용자 승인 2026-11-12(start-slice 브레인스토밍 — "그냥 시작" 후 US 초안 단독 제시·승인, 범위 질문 3개 답 포함).

- **US1**: 운영자가 응답 값 목록(TUI 요청·응답 `a` / 칸 설정 11·12 `a` / GUI 미리 실행 결과)에서 `session_id`(32자)처럼 **이름이 비밀 같은 문자열 값**을 골라 `조건으로 추가` — 성공하면 규칙 `값 있음`·비교값 빈 칸·"이름이 비밀 값처럼 보여 비교값을 채우지 않았습니다" 안내 한 줄을 보고, 그대로 저장해도 보드 파일·판정 상세에 그 값이 없다. 같은 응답에서 GUI와 TUI로 만든 조건은 필드 단위로 같다.
- **US2**: 운영자가 이름 때문에 `값 있음`이 된 칸(예: `author: "Kim"`)을 정말 값으로 비교하고 싶을 때 규칙을 `=`로 바꾸고 값을 직접 입력 — 성공하면 막힘 없이 저장되고 다음 점검에서 그 비교로 판정된다.
- **US3 (재현/기대)**: 운영자가 GUI에서 1 MiB를 넘어 잘린 본문을 미리 실행 — 재현: `+ 본문 전체 포함 조건` 버튼이 나오고 그 조건은 서버가 늘 실패시킨다. 기대: 잘린 본문에는 버튼이 없다(TUI와 같음).
- **US4**: 운영자가 보드 이름·칸 제목·조건 비교값·헤더 이름·본문 경로·표시 값 경로 중 어디에든 제어 문자·bidi 제어·U+2028/2029가 든 보드를 저장하거나 그런 보드 파일을 가져오기 — 성공하면 서버가 어느 칸의 무엇인지 적힌 오류로 거절하고 아무것도 들어가지 않는다. GUI 컨트롤러 DB에 이미 있는 보드는 계속 돌고 다음 저장 때 같은 오류를 본다. TUI는 시작 때마다 보드 파일을 가져오므로 그런 파일로는 시작하지 않고 같은 오류(어느 칸·무엇)를 보여 준다(사용자 결정 2026-11-12 — 릴리즈 노트 한 줄).
- **US5 (범위 질문 답)**: 운영자가 이름이 비밀 같은 값을 `화면에 추가`하려 할 때 — 막히지 않지만 고르기 전에 "이름이 비밀 값처럼 보입니다 — 화면에 늘 보입니다" 안내를 본다.

## 1. 왜

- §B52 (2) 보안 리뷰 low: 서버가 가리는 것은 인증 헤더 4종(`set-cookie`·`cookie`·`authorization`·`proxy-authorization`)뿐이다. 40자 이하 문자열은 `=` + 받은 값으로 미리 채워진다(GUI `defaultCondition` `VOLATILE_LEN = 40`, TUI `pick::default_condition` 같은 규칙). 본문의 세션 id, `x-api-key` 응답 헤더 같은 값이 `Enter` 한 번으로 보드 파일(내보내 공유된다)과 판정 상세에 남는다.
  - **이전 결정을 대체한다**: roadmap §B52 (0) 끝의 사용자 결정(2026-11-11 "40자 이하 비밀 채움은 그대로 둔다 — 불편하면 사용자가 수정을 요청")에 대해, 사용자가 2026-11-12 `/start-slice`에서 이 묶음을 골랐다. 이것을 그 수정 요청으로 본다.
- §B52 (2) 선재 GUI 갭: `PreviewResult.tsx`의 `!treeBody` 갈래는 본문이 잘린 경우(`body_truncated`)에도 `+ 본문 전체 포함 조건` 버튼을 띄운다. 엔진이 1 MiB에서 자른 본문에서 서버는 `본문 전체` 조건을 늘 실패시킨다. TUI는 이 줄을 내지 않는다.
- §B52 (2) 보안 info: `validate_conditions`는 비교값의 길이만 검사한다. TUI 입력줄은 그런 글자를 받지 않는다(`input.rs`).
  - §B52가 "GUI 입력 길도 걸러진다"고 적은 것은 틀렸다. GUI는 미리 채움(§2.3)과 `<input>` 붙여넣기 모두 거르지 않는다. 그래서 GUI는 이 슬라이스 뒤 서버 400에 기댄다(§7).
  - 사용자 결정에 따라 보드의 **모든 자유 글자 칸**으로 넓힌다(§4).

## 2. 이름 규칙 (US1·US2·US5 — 공용)

### 2.1 판정 대상 이름
- 헤더 줄: 헤더 이름.
- 본문 줄: 경로의 **마지막 키 조각**. 마지막 조각이 배열 첨자면(`$.tokens[0]`) 그 앞의 가장 가까운 키 조각을 쓴다. 키 조각이 하나도 없으면(`$[0]`, 루트 `$`) 판정하지 않는다(비밀 아님).
- 응답 코드 줄·`본문 전체` 줄: 판정하지 않는다.
- **이름이 어디서 오나**: 경로 글자(`$['a\'b']`, §4.3 뒤에는 `\u202e`)를 거꾸로 풀지 않는다. 키 조각을 만드는 시점의 원래 글자를 쓴다.
  - TUI: `pick.rs` `Walker::push`가 `Seg` 목록을 가진 시점에 판정에 쓸 키를 줄(`ValueRow` 또는 `RowKind::Body`)에 함께 담는다. 그 필드는 응답 데이터이므로 derive `Debug` 금지다(손 Debug로 길이만 — `crates/tui/CLAUDE.md` "값 Debug 가림"). 판정 결과(bool)만 담을지, 키 글자를 담을지는 구현자가 정한다.
  - GUI: `JsonValueTree`의 `JsonLeaf.segments`(`lastKey`가 이미 배열 첨자를 건너뛴다)를 쓴다. `lastKey`의 `"value"` 폴백은 비밀 낱말에 안 맞아 결과가 같지만, 판정은 `segments`로 해서 폴백에 기대지 않는다. `ConditionClick` body 갈래에 무엇을 더 넘길지는 구현자가 정한다.

### 2.2 맞음 판정
- 이름을 ASCII 소문자로 바꾼 뒤 아래 낱말 중 하나를 **부분문자열**로 포함하면 "비밀처럼 보임"이다.
- 낱말(orchestrator 결정 — roadmap 해소안 7개 + `pwd`·`cookie`): `token` `secret` `pass` `pwd` `session` `key` `csrf` `auth` `cookie`.
- 오판정은 받아들인다. `author`, `keyword`, `passenger`, `monkey` 같은 이름도 걸린다. 비용은 `=`로 바꾸고 직접 입력하는 키 몇 번이다(US2). 반대로 놓쳤을 때의 비용은 비밀이 공유 파일에 남는 것이라 넓게 잡는다.
- 인증 헤더 4종도 `auth`·`cookie`로 모두 맞는다. TUI는 그보다 앞선 인증 헤더 갈래가 먼저 잡는다(§2.3-1). GUI는 지금 미리 실행 응답의 `set-cookie`를 `= <쿠키 원문>`으로 채운다(미리 실행 trace는 가리지 않는다 — 기록만 가린다). 이 슬라이스 뒤에는 `값 있음` + 비밀 안내가 된다. 의도된 변화다.
- 정본 상수는 TUI(`pick.rs`)와 GUI(`ui/src/monitor/conditions.ts`)에 하나씩 두고, 같은 판정표 테스트로 묶는다.
  - 표의 최소 행: `session_id`·`X-Api-Key`·`csrfToken`·`password`·`author`·`Set-Cookie`(맞음)와 `name`·`id`·`count`·`status`(아님).
  - 두 언어 테스트의 표 행은 같은 이름과 같은 판정이어야 한다(서로 "Keep in sync" 주석).

### 2.3 조건 미리 채움 (US1)
기존 문자열 갈래 순서를 다음처럼 바꾼다(TUI `default_condition` / GUI `defaultCondition`).

1. (TUI만) 인증 헤더 → `값 있음` + `가려진 값이라 …` (기존 그대로)
2. **새로 추가: 이름이 비밀처럼 보임 → `값 있음`(빈 문자열이면 `키 있음`) + 새 안내 "이름이 비밀 값처럼 보여 비교값을 채우지 않았습니다"**
3. 40자 초과 **또는 §4.1 금지 글자가 하나라도 있음** → `값 있음` + `매번 바뀌는 값이면 …` (TUI는 기존 그대로다 — `input_accepts`가 §4.1과 같은 집합. **GUI는 새로 금지 글자 검사를 더한다** — 안 하면 GUI가 `=` + 금지 글자를 채우고 §4.2가 저장을 400으로 막는다.)
4. 나머지 → `=` + 값 (기존 그대로)

- 빈 문자열이면 `키 있음`(exists) + 같은 비밀 안내로 채운다(최종 보안 리뷰 S1 — `=` 비교가 실패하면 판정 사유에 받은 값이 실리므로 `= ""`는 나중에 채워질 비밀을 사유로 흘린다. `값 있음`이면 다음 점검이 바로 실패한다).
- 숫자·참거짓·null 값은 이름과 무관하게 기존 그대로다(`= 숫자 글자`, `값 있음`(null)). 비밀은 거의 항상 문자열이다. 숫자 PIN 같은 것은 비목표다(§7).
- GUI `defaultCondition`의 반환은 지금 `volatileHint: boolean`이다. 안내가 두 종류가 되므로 종류를 담는 형태로 바꾼다.
  - 형태와 이름은 구현자가 정한다.
  - 호출처는 `PreviewResult.tsx` 한 곳이다. 안내는 `ConditionRow.tsx`의 prop으로 받아 그린다.
  - 테스트 `ui/src/monitor/__tests__/conditions.test.ts`의 `volatileHint` 단언 3곳도 같이 바꾼다.
- 안내 문구(TUI `text.rs` / GUI `ko.ts` 같은 글자): `이름이 비밀 값처럼 보여 비교값을 채우지 않았습니다`.
- 판정표 테스트(§2.2)와 별개로, 같은 입력(이름, 값)에 대해 두 언어의 미리 채움 결과(`op`·`value`·안내 종류)가 같다는 대조표를 둔다. 행에는 비밀 이름·빈 문자열·41자·탭이 든 짧은 값·U+200F가 든 짧은 값·보통 값을 넣는다.

### 2.4 화면에 추가 안내 (US5)
- 값 목록에서 `조건으로 추가`/`화면에 추가`를 고르는 창에서, 고른 줄의 이름이 비밀처럼 보이면 `화면에 추가` 옆이나 아래에 **막지 않는** 안내 한 줄을 낸다: `이름이 비밀 값처럼 보입니다 — 화면에 늘 보입니다`.
  - TUI는 `app.rs`가 `OverlayView::Choice`를 만들고 `view/settings.rs`가 그린다.
  - GUI는 `PreviewResult`의 선택 줄이다.
- 값 종류와 무관하게 이름만으로 판정한다. 화면 표시 값은 매 점검의 실제 값을 늘 보여 준다.
- 막는 이유(가득 참·중복·인증 헤더 — TUI `display_block` / GUI `reason`)가 있으면 그 이유만 낸다(막혔으니 안내는 의미 없다).
- TUI 칸 설정 12번 `a`(값 목록까지 가는 길)도 같은 선택 창을 쓰므로 같이 적용된다.
- 렌더:
  - 막는 이유와 시각적으로 구분해야 한다(비활성 스타일 금지).
  - TUI 선택 창이 낮아 줄을 빼야 할 때 이 안내는 **선택 창 머리 줄보다 오래 남는다**. 보안 안내이기 때문이다. 지금 `settings.rs`는 높이가 모자라면 머리 줄부터 뺀다.
  - 정확한 우선순위표와 위치는 구현자가 정하되, 폭·높이 스윕 테스트로 "보이는 만큼 보이고 패닉 없음"을 보인다(`crates/tui/CLAUDE.md` 칸 폭 스윕 규칙).

## 3. 잘린 본문 버튼 (US3)
- `PreviewResult.tsx`의 `belowHeading`의 `본문 전체 포함 조건` 버튼 조건에 `!resp.body_truncated`를 더한다.
- 잘렸을 때 대신 낼 안내는 없다. 본문 영역은 이미 잘림을 표시한다(`truncated={resp.body_truncated}`).
- TUI 쪽 변경은 없다. 이미 그 줄을 내지 않는다(`pick.rs:413` `body_truncated` 갈래).

## 4. 보드 글자 칸 거절 (US4)

### 4.1 금지 글자 (정본 술어)
TUI 입력줄 `input.rs:44`가 받지 않는 집합과 같다: `char::is_control()`(C0·DEL·C1, 탭·줄바꿈 포함) · U+2028 · U+2029 · bidi 제어(U+061C·U+200E·U+200F·U+202A–202E·U+2066–2069 = TUI `inspect::is_bidi_control`).
- ZWJ(U+200D)·ZWNJ·그 밖의 서식 문자는 거절하지 **않는다**. 이모지 연결 등 정당한 쓰임이 있고, 화면 표시는 `check.rs` `normalize_chars`가 이미 공백으로 바꾼다.
- 컨트롤러에 술어 하나를 `pub`으로 둔다(이름은 구현자가 정한다). TUI는 컨트롤러 크레이트에 의존한다(`pick.rs`가 `handicap_controller::monitor::config::MAX_CONDITIONS`를 쓴다).
  - TUI `input.rs`가 그 술어를 쓰게 할지, 동기화 테스트로 묶을지는 구현자가 고른다.
  - 어느 쪽이든 "TUI 입력줄이 받는 글자는 서버가 거절하지 않는다, 그 역도"를 테스트로 보인다.
  - GUI 쪽 같은 집합(§2.3-3 검사용)은 `conditions.ts`에 두고 같은 경계 행(탭·DEL·U+0085·U+200F·U+2028·U+202E·U+2066 거절 / U+200D·보통 글자 통과)으로 테스트한다.

### 4.2 적용 칸
`validate_and_normalize`(보드 생성 `POST`·수정 `PUT`·가져오기 `board_file.rs`가 모두 지난다 — `grep -rn validate_and_normalize crates/controller/src`)와 그 안의 `validate_panel` 경로에서 아래를 검사한다.

| 칸 | 위치 | 오류 접두 |
|---|---|---|
| 보드 이름 | `validate_and_normalize` `check_name("보드 이름", …)` 경로 | 없음 |
| 칸 제목 | `validate_panel` `check_name("칸 제목", …)` | `칸 N:` (기존 호출자가 붙임) |
| 조건 비교값 `value` | `validate_conditions` | `칸 N:` |
| 조건 `path` (헤더 이름·본문 경로) | `validate_conditions` | `칸 N:` |
| 표시 값 `path` (헤더 이름·본문 경로) | `validate_display_items` | `칸 N:` |
| 칸 `scenario_id`·`environment_id`·스텝 없는 칸의 `latency_source` `step_id`, 묶음 `scenario_id`·`environment_id` | `validate_panel` / `validate_groups` | 칸은 `칸 N:`, 묶음은 구현자가 정함 |

- 마지막 행: POST/PUT에서 이 칸들은 빈 값 검사만 받거나(`scenario_id`) 아무 검사도 받지 않는다(`environment_id`·`latency_source` `step_id`). 첫 리뷰 지적 M5 — 앞선 spec 초안의 "ULID 검사로 막혀 있다"는 틀렸다.
  - 가져오기는 번들 ID 대조(`board_file.rs`)로 간접적으로 막힌다.
  - 형식(ULID) 검사로 넓히지는 않고 같은 금지 글자 검사만 더한다. 형식 검사는 기존 보드를 깨뜨릴 위험의 크기가 다르다.
- ULID 검사를 받는 `id`·조건/표시 값 `step_id`, hex 검사를 받는 `color`, 열거형은 대상이 아니다.
- 오류 문구는 칸 이름과 원인을 담는다. 예: `비교값에 쓸 수 없는 글자(제어·방향 제어·줄 구분 문자)가 있습니다`. 정확한 글자는 구현자가 정하되 칸별로 구분돼야 한다.
- **검사 시점 = 서버 정규화가 끝난 뒤, 저장될 값에 대해서**:
  - 기존 trim(헤더 이름·제목·이름), 값이 필요 없는 규칙의 `value` 비우기(`config.rs` `!c.op.needs_value()`), `status`·`body_text`의 `path` 비우기 다음에 검사한다.
  - 그래야 서버가 어차피 버릴 옛 값(GUI가 숨겨 사용자가 못 고치는 값) 때문에 거절하지 않는다.
  - 참고: `str::trim`은 앞뒤 White_Space(탭·LF·CR·VT·FF·U+0085·U+2028/2029)만 지운다. 앞뒤의 U+0001·DEL·bidi 제어와 가운데 탭은 trim 뒤에도 남아 걸린다. 테스트도 이 경계를 쓴다.
- **오류 문구가 거절한 글자를 되풀이하지 않는다**: 가져오기 오류 접두는 보드 이름을 그대로 넣는다(`board_file.rs` `보드 '{name}'` 꼴). 보드 이름 자체가 거절 사유일 때 GUI가 그 bidi 글자를 그대로 그려 오류 문구를 뒤섞는다.
  - 접두에 넣는 이름은 금지 글자를 치환한 글자로 쓴다(`check.rs`의 정규화와 같은 방식, 또는 `\u{FFFD}`).
  - 어떤 치환을 쓸지는 구현자가 정한다. 오류 문구 안에 금지 글자가 0개임을 테스트로 보인다.
- `validate_panel`은 미리 실행 엔드포인트도 쓴다(`api/monitor_boards.rs` preview). 그래서 미리 실행 요청도 같은 글자에서 거절된다. 의도된 결과다.
- **이미 있는 보드**:
  - GUI 컨트롤러: 시작 시 재검증하지 않는다(현 구조 — `judge`는 실행 시 재검사 안 함, `crates/controller/CLAUDE.md`). 계속 돌고 다음 저장 때 거절된다. 마이그레이션도 정리도 없다.
  - TUI: 시작마다 보드 파일을 임시 DB로 가져온다(`session.rs` `Stage::Import`). 그래서 그런 글자가 든 옛 파일로는 **시작하지 않는다**. 사용자 결정(2026-11-12): 받아들이고 안내한다.
    - TUI 시작 오류가 서버의 칸·원인 문구를 그대로 보여 주는지 확인한다(이미 `e.message`를 넘긴다 — 라이브로 확인).
    - 다음 릴리즈 노트에 "제어·방향 제어 글자가 든 보드 파일은 가져오기·TUI 시작에서 거절된다 — 오류가 가리키는 칸을 고칠 것" 한 줄을 넣는다(roadmap §B 블록에 적어 릴리즈 때 옮긴다).

### 4.3 본문 경로 생성기의 이스케이프 확장 (§4.2의 부수)
응답 키에 bidi·U+2028/2029·DEL·C1이 날것으로 들어 있으면 지금 경로 생성기가 그 글자를 경로에 그대로 넣는다. TUI `pick::segments_to_path`와 GUI `ui/src/scenario/jsonPath.ts` `escapeBracketKey`는 `< 0x20`만 `\uXXXX`로 바꾼다. 그 경로로 만든 조건·표시 값은 §4.2에 따라 저장이 거절된다.
- 두 생성기의 `\uXXXX`(소문자 hex 4자리, 기존 형식) 이스케이프 대상을 **§4.1 금지 집합 전체**로 넓힌다.
  - 두 생성기는 지금처럼 글자까지 같아야 한다(`pick.rs` 주석 "GUI `segmentsToPath`와 글자까지 같다").
  - TUI `path_len`(`MAX_PATH_BYTES` 계산)도 같은 길이를 내야 한다. 지금 `< 0x20 => 6` 갈래가 있다.
- **구현 중 실측 확정(STOP 조건)**: 엔진 `serde_json_path`가 `$['a\u202eb']`(이스케이프 글자)를 키 `"a\u{202E}b"`로 읽는지 엔진 단위 테스트로 확인한다. 같은 경로가 `jsonpath_is_valid`·`jsonpath_is_simple`을 통과하는지도 본다.
  - 선례: `crates/engine/src/extract.rs` 테스트의 `$['a\u0009b']`.
  - 안 읽으면 STOP한다. 이 절을 빼고 §4.2 표에서 본문 경로를 빼는 것으로 spec을 정정한 뒤 사용자에게 알린다.
- GUI `segmentsToPath`는 시나리오 에디터(추출 경로)도 쓴다. 그런 키에 대해 만들어지는 시나리오 YAML 글자가 바뀌지만 고르는 값은 같다(위 실측이 보증). 의도된 부수 효과로 받아들인다.
  - 시나리오 쪽 기존 테스트(`ui/src/scenario/__tests__/` 등)가 현재 이스케이프를 못박고 있으면 그 행을 새 규칙으로 고친다.

## 5. 변경 지도 (구현자 참고 — 확정 아님)
- `crates/controller/src/monitor/config.rs`: 금지 글자 술어 + §4.2 칸 검사 + 테스트. `board_file.rs`: 오류 접두 이름 치환.
- `crates/engine/src/extract.rs`: §4.3 실측 테스트(테스트만).
- `crates/tui/src/pick.rs`: 이름 규칙 + 판정용 키 운반 + `Hint` 새 종류 + `default_condition` 순서 + 화면에 추가 안내 판정 + `segments_to_path`·`path_len` 이스케이프.
- `crates/tui/src/text.rs`: 문구 2개. `crates/tui/src/app.rs`(선택 창 만들기)·`view/settings.rs`(`OverlayView::Choice` 그리기): 안내 줄. `crates/tui/src/input.rs`: §4.1 술어 정리(선택).
- `ui/src/monitor/conditions.ts`: 이름 규칙 + 금지 글자 집합 + `defaultCondition` 반환 형태. `ui/src/components/monitor/PreviewResult.tsx`: §3 + §2.4 안내 + 판정용 키 전달. `ui/src/components/monitor/ConditionRow.tsx`: 안내 종류. `ui/src/scenario/jsonPath.ts`: §4.3. `ui/src/i18n/ko.ts`: 문구 2개.

## 6. 검증
- **단위**:
  - §2.2 판정표(두 언어 같은 행).
  - §2.3 순서와 두 언어 미리 채움 대조표: 인증 헤더 > 비밀 이름 > 길이·금지 글자, 빈 문자열 예외, 숫자·참거짓 무영향.
  - §2.4 막는 이유 우선 + TUI 선택 창 폭·높이 스윕(안내가 머리 줄보다 오래 남음).
  - §3 잘린 본문에 버튼 없음(RTL).
  - §4.2: 칸마다 거절. 정규화 뒤 검사(값이 필요 없는 규칙의 옛 `value`에 금지 글자 → 통과). 금지 집합 경계(ZWJ 통과·탭/DEL/C1/bidi 거절·trim 경계). 가져오기 경로 거절 시 0건 추가. 오류 문구에 금지 글자 0개.
  - §4.3: 두 생성기 같은 글자 + `path_len` 일치 + 엔진 실측.
- **회귀 가드 이빨**: 새 갈래마다 고의 회귀 → RED → 원복 → GREEN(`plan-mandated-vacuous-tests`).
- **라이브 (필수 — GUI 미리 실행·TUI 저장·가져오기 경로를 건드린다)**:
  - 응답기 하나: 본문 `{"session_id":"<32자>","author":"Kim","name":"web-1","items":[{"api_key":"k1"}],"<U+202E>x":1}` + 헤더 `X-Api-Key: <20자>`.
  - US1:
    - TUI(tmux): `a` → 줄마다 `조건으로 추가` → 저장한 보드 파일.
    - GUI(Playwright): 미리 실행 → 같은 줄 `+ 추가` → `조건으로 추가` → 저장 → `GET /api/monitor-boards/{id}`.
    - 두 조건 목록을 `step_id`·`source`·`path`·`op`·`value`·`ignore_case`·`trim`까지 대조한다(2b·2b-polish의 클릭 경로 대조 선례). `<U+202E>x` 줄의 경로가 두 쪽 모두 `\u202e` 이스케이프이고 저장이 통과하는지 포함한다.
    - 판정 상세·보드 파일에서 32자 값을 `grep`해 0건.
  - US2: TUI·GUI 각각 `author` 칸을 `=` + `Kim`으로 바꿔 저장 → 다음 점검 통과.
  - US3: 1 MiB를 넘는 본문을 주는 응답기로 GUI 미리 실행 → 버튼 부재를 DOM에서 단언하고 스크린샷 1장.
  - US4:
    - curl `PUT`으로 §4.2 칸마다 금지 글자 → 400과 칸 이름이 든 문구.
    - 그런 글자가 든 번들 가져오기 → 거절, 보드·시나리오 수 그대로, 보드 이름이 사유일 때 오류 문구에 그 글자 없음.
    - GUI와 TUI에서 저장 거절 문구가 보이는지 1회씩. TUI는 편집 중인 칸이 아닌 다른 칸(`칸 5:` 꼴)이 사유일 때도 본다.
    - 그런 보드 파일로 TUI를 시작하면 칸·원인이 든 시작 오류가 뜨는지 본다.
  - US5: TUI 선택 창·GUI 선택 줄에서 `session_id` 줄의 안내를 보고, `name` 줄에는 없음을 확인한다. 극단값: 선택 창 최소 폭·높이에서 안내 줄 겹침·패닉 없음.
- **보안 리뷰**: finish-slice §0 grep 결과와 무관하게 돌린다. 비밀이 sink(보드 파일·판정 상세)로 가는 경로를 다루는 슬라이스다(working-rules §3).

## 7. 비목표
- 이름이 아니라 **값 모양**으로 비밀을 짐작하기(JWT·hex 32자 등). 별도 판단이 필요하고 오판정 비용이 다르다.
- 숫자·참거짓 값의 비밀 처리(숫자 PIN·OTP).
- GUI 칸 설정 화면에서 손으로 조건·표시 값을 입력하는 길에 안내 넣기. 직접 입력한 값은 사용자가 이미 알고 있다.
- GUI `conditionError`에 금지 글자 클라 검사 넣기(orchestrator 결정). 붙여넣은 금지 글자는 서버 400 문구로 알린다. 미리 채움은 §2.3-3이 금지 글자를 피한다.
- 기존에 저장된 조건·판정 기록에서 비밀 값을 지우기.
- 번들의 시나리오·환경 글자 칸(이름·YAML) 거절. 보드 설정만 대상이다.
- §4.2 ID 칸의 ULID 형식 검사.
- §B52 (2)·§B53 (2)의 나머지(`fit_head` 1칸·높이 6줄 이하 선택 창 머리·`wrap_width` 공용화·숫자 글자 세 벌 등). 묶음 B·C로 남긴다.

## 8. 알려진 한계 (수용)
- 이름 규칙은 휴리스틱이라 비밀을 놓칠 수 있다.
  - `sid`처럼 낱말 밖의 이름은 못 잡는다.
  - **마지막 키만 보므로 `{"session":{"id":"…"}}` → `$.session.id`도 못 잡는다**. 경로 전체 키로 넓히면 `$.auth.user.name` 같은 오판정이 크게 는다. 그래서 마지막 키만 본다(orchestrator 결정).
  - 안내는 "보고 고친 뒤 저장" 책임을 줄일 뿐 없애지 않는다.
- §4.3 이전에 날것 금지 글자 경로로 저장된 조건은 TUI `marks`(같은 경로 글자 비교)에서 새 이스케이프 경로와 짝이 맞지 않는다. 그런 보드는 저장·가져오기에서 거절되므로(§4.2) 짝이 맞지 않는 상태로 오래 남지 않는다.
- 금지 글자가 든 옛 보드 파일로는 업그레이드한 TUI가 시작하지 않는다(§4.2 — 사용자 결정, 릴리즈 노트).

## 9. 사실 확인 원장 (claims-ledger — 디스패치 전 재실행)
- `grep -n 'VOLATILE_LEN' ui/src/monitor/conditions.ts crates/tui/src/pick.rs` → 두 곳 모두 40.
- `grep -rn 'volatileHint' ui/src` → `conditions.ts`(정의)·`PreviewResult.tsx:140`(유일 호출)·`ConditionRow.tsx`(prop)·`conditions.test.ts` 3곳.
- `grep -n '!treeBody' ui/src/components/monitor/PreviewResult.tsx` → `belowHeading` 갈래 1곳.
- `grep -rn 'validate_and_normalize' crates/controller/src | grep -v 'monitor/config.rs'` → `board_file.rs`(가져오기)·`api/monitor_boards.rs` 2곳(생성·수정).
- `grep -n 'validate_panel' crates/controller/src/api/monitor_boards.rs` → 미리 실행 경로.
- `grep -n 'fn check_name' -A6 crates/controller/src/monitor/config.rs` → 길이만 검사.
- `grep -n 'scenario_id\|environment_id' crates/controller/src/monitor/config.rs` → POST/PUT 검증은 `scenario_id` 빈 값만.
- `grep -n 'fn is_bidi_control' -A5 crates/tui/src/inspect.rs` 와 `grep -n 'is_control' crates/tui/src/input.rs` → §4.1 집합.
- `grep -n "0x20" crates/tui/src/pick.rs ui/src/scenario/jsonPath.ts` → 두 생성기 + `path_len` 모두 `< 0x20`만.
- `grep -n 'pub fn display_block' -A15 crates/tui/src/pick.rs` → 가득 참·중복·인증 헤더 3가지 이유.
- `grep -n 'OverlayView::Choice' crates/tui/src/app.rs crates/tui/src/view/settings.rs` → 선택 창 만들기·그리기.
- `grep -n 'Stage::Import' crates/tui/src/session.rs` → 시작마다 가져오기.
- `grep -n 'fn lastKey' -A7 ui/src/components/response/JsonValueTree.tsx` → 배열 첨자 건너뜀 + `"value"` 폴백.
- 이 spec 자체에 §4.1 금지 글자 0개(줄바꿈 제외): `python3 -I -c "import sys;s=open(sys.argv[1],encoding='utf-8').read();print([hex(ord(c)) for c in s if (ord(c)<0x20 and c!='\n') or 0x7f<=ord(c)<=0x9f or ord(c) in (0x61c,0x200e,0x200f,0x2028,0x2029) or 0x202a<=ord(c)<=0x202e or 0x2066<=ord(c)<=0x2069])" <spec>` → `[]`. 엔진 실측 테스트 리터럴은 Rust `"$['a\\u202eb']"`(이스케이프 글자 6자) → 키 `"a\u{202E}b"`.
