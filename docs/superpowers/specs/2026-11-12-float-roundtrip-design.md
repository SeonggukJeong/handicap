# 소수 정확히 읽기 (`serde_json` `float_roundtrip`) — 설계

- 날짜: 2026-11-12 · 유형: **correctness-bug** · 출처: roadmap §B53 (3)(착수 메모 ①–⑤)
- 상태: spec

## 사용자 스토리 (US)

**재현 / 기대 / 실측**
- **재현**: 운영실 모니터 GUI에서 응답 `{"v":972.0979928970337}`의 값을 `+ 추가` → `= 972.0979928970337` 조건 → 저장.
- **기대**: 그 칸이 통과(`≠`면 실패).
- **실측**(2026-11-12 라이브, §B53 (3)): 점검마다 실패, 칸에 받은 값 `972.0979928970336`. `≠`는 늘 통과. 자릿수·지수 크기로 가를 수 없다(`1.5e-300`·`4.5e250`·`972.0979928970337`은 다르게, `1e300`·`2.5e-300`은 정확히).

**US** (사용자 승인 2026-11-12. 리뷰 1라운드에서 US1의 관찰 조건을 "같은 글자" → "같은 수"로 정밀화 — 서버 표기 규칙상 `4.5e250`은 고친 뒤에도 `4.5e+250`으로 보인다)
- **US1**: 운영자가 GUI에서 응답 소수 값으로 `=`·`∈` 조건(그리고 같은 값 경계의 `≥`)을 만들면 — 성공하면 그 칸이 통과로 보이고, 칸에 보이는 받은 값(표시 항목, 또는 `≠` 조건의 실패 사유)이 응답 본문과 **같은 수**다(`972.0979928970337` → 그대로, `4.5e250` → `4.5e+250`).
- **US2**: 운영자가 같은 값을 GUI와 TUI에서 각각 조건으로 추가하면 — 성공하면 두 보드 파일의 조건 `value` 글자가 같다. (예외: 마지막 자리가 정확히 반반인 수 — §B53 (1) 둘째 항목, TUI 표기 규칙 문제라 범위 밖.)
- **US3**: QA가 응답 소수를 추출해 다음 요청 본문(`{{price:num}}` 캐스트 포함)이나 조건에 쓰면 — 성공하면 응답 본문과 같은 숫자가 쓰인다(에디터 test-run trace의 추출 값·보낸 본문에서 확인).

**제약 — 속도(사용자 원문 "사람이 느낄 수 없어야지")**: 워커 CPU가 한계인 최악 조건(소수로 꽉 찬 본문을 매 응답마다 추출)에서도 달성 RPS가 켜기 전 run들의 편차 범위 안(§5). 기준을 벗어나면 출하하지 않고 수치와 함께 사용자에게 보고.

## 1. 원인

워크스페이스의 `serde_json`(1.0.150)은 기본 기능만 켠다(`alloc`·`std`·`raw_value`). `float_roundtrip` 없이 `serde_json`은 소수를 빠른 근사로 읽어 일부 값을 1 ULP 다르게 읽는다(관측된 세 값은 모두 실제보다 작게). Rust `str::parse::<f64>`·JS `JSON.parse`는 정확히 읽는다. 그래서:

| 경로 | 지금 동작 | 근거 |
|---|---|---|
| 모니터 판정 `=`·`≠`·`∈` | 받은 값은 `serde_json`으로(틀릴 수 있음), 비교값은 `str::parse`로(정확) 읽어 `==` | `crates/controller/src/monitor/check.rs` `n.as_f64()`(:374)·`op_passes`(:423)·`OneOf`(:450) |
| 모니터 판정 `>`·`<`·`≥`·`≤` | 틀린 값을 `stringify`한 글자를 다시 `parse_finite` — 같은 오차가 전파 | `check.rs` `op_passes` Gt/Lt 갈래(:438) · `text: stringify(&v)`(:372) |
| 모니터 표시 값·실패 사유 | 틀린 값의 글자를 보여 준다 | `check.rs` `display_values`·`eval_conditions` |
| 엔진 추출 | 본문을 `serde_json::from_slice` → `stringify` — 틀린 값의 글자가 변수로 | `crates/engine/src/extract.rs:47`·`:214` |
| `{{x:num}}`·`{{x:json}}` 캐스트 | 렌더된 글자를 `serde_json::from_str::<Value>`로 다시 읽어 직렬화 — 보내는 본문의 숫자가 바뀔 수 있음 | `crates/engine/src/cast.rs` `coerce_num`(:52)·`coerce_json` |
| TUI 값 고르기 | TUI가 같은 빌드의 `serde_json`으로 본문을 직접 읽어(`pick.rs`) 그 값의 글자를 조건에 넣음 — 같은 프로세스의 서버와 같은 값이라 통과하지만 GUI 글자와 다름 | `crates/tui/src/pick.rs` · `crates/tui/tests/pick_test.rs` `MISREAD`(:1059) |
| 그 밖(전부 더 정확해질 뿐, 옛 값에 기대는 테스트 없음 — §4) | JSONPath 필터 숫자 리터럴(`serde_json_path` → `Number::from_str`, 비교 양쪽이 함께 바뀜) · REST 요청 본문 axum `Json`(`target_rps`·SLO 임계값 등 `f64`) · 저장된 JSON 재읽기(리포트·profile·보드 파일) · TUI `api.rs` `.json()` · 기능 합치기로 간접 의존(kube·tauri) | `grep -rln 'serde_json::from_\|\.json()' crates/*/src` |

`genvars.rs:155`의 `as_f64()`는 `serde_yaml` 숫자라 무관. `cast.rs` 행은 코드에서 유도 — §3 회귀 테스트가 RED로 실증한다.

**서버의 숫자 표기 규칙은 이 슬라이스가 바꾸지 않는다**: `stringify`는 `serde_json` 숫자 출력(십진 지수 −5..=15만 고정 소수, 그 밖은 부호 붙은 지수 — `4.5e+250`, `1E5` → `100000.0`)을 쓴다. 값이 정확해질 뿐 글자 꼴은 그대로다(글자 세 벌 통합은 §B53 (2) — 비목표).

## 2. 바꾸는 것

1. 루트 `Cargo.toml`의 `serde_json = "1"`(현재 :40) → `serde_json = { version = "1", features = ["float_roundtrip"] }`. `crates/*`는 전부 `serde_json.workspace = true`라 함께 켜진다. `float_roundtrip = []`은 의존을 끌어오지 않으므로 `Cargo.lock`·`desktop/src-tauri/Cargo.lock` 모두 내용 변화 없음(다르면 STOP — 새 의존이 끼어든 것).
2. **데스크톱**(`desktop/src-tauri/Cargo.toml:30`, 별도 빈 `[workspace]`): `handicap-controller`를 경로 의존(:33)하고 그 crate의 `serde_json`은 handicap 루트 workspace 정의를 따르므로, 기능 합치기로 데스크톱 빌드에서도 켜진다. 데스크톱 자신은 `serde_json`으로 직렬화만 한다(`desktop/src-tauri/src/lib.rs` `to_string` — 읽기 없음). 그래도 데스크톱 줄을 같은 형태로 맞춘다(제 판단 — 동작 무영향, 누가 컨트롤러 의존을 끊어도 같은 규칙이 남게). 확인: `cargo tree --manifest-path desktop/src-tauri/Cargo.toml -e features -i serde_json`에 `float_roundtrip`.
3. **TUI 정리**: `pick_test.rs`의 `MISREAD` 표 삭제 — 그 값들은 `EXACT` 쪽으로 옮긴다. 기대 글자 = GUI `String(JSON.parse(x))` 글자: `1.5e-300` → `1.5e-300`, `9.720979928970337e2` → `972.0979928970337`, `4.5e250` → `4.5e+250`. `EXACT` 문서 주석의 "마지막 행만 뜻대로 다르다"가 참으로 남게 `12345678901234567890` 행을 계속 마지막에 둔다. `float_roundtrip`이 꺼졌음을 전제한 다른 테스트·주석도 정리. `pick.rs` 코드는 바꾸지 않는다.
4. **문서 정리**:
   - `crates/tui/CLAUDE.md`의 `float_roundtrip` 함정 줄을 "켜져 있다 — 끄면 판정·추출·캐스트가 1 ULP 어긋난다(회귀 테스트가 지킨다)"로 뒤집어 남긴다. 같은 함정을 엔진·컨트롤러 쪽에서도 볼 수 있게 `crates/engine/CLAUDE.md`·`crates/controller/CLAUDE.md`에 한 줄씩 포인터.
   - `2026-11-11-tui-2b-polish-design.md`는 역사 문서라 지우지 않고, "다르게 읽는 글자"를 말하는 **모든 곳**(`grep -n 'float_roundtrip\|972\.0979928970336\|한 끝자리\|MISREAD\|다르게 읽\|§2\.1-4' docs/superpowers/specs/2026-11-11-tui-2b-polish-design.md` — 현재 :24·:59·:64·:111·:122·:140·:154·:160·:161; grep 결과가 지배하며 이 줄번호는 참고)에 "2026-11-12 float-roundtrip으로 해소" 표시.
   - roadmap §B53 (1) 첫 판단·(3)을 해소 표시.
   - 릴리즈 노트용 한 줄: **LAN 풀 워커(ADR-0041)는 버전 확인이 없다** — 새 컨트롤러에 옛 풀 워커가 붙으면 그 워커의 부하 run은 옛 읽기를 계속한다(추출 값 1 ULP). 풀 워커도 같은 버전으로 올릴 것.

## 3. 회귀 테스트

각 **테스트 함수**가 기능 켜기 전 RED여야 한다(구현 중 실증 — 켜기 전 작성 → RED 확인 → 켬 → GREEN).

- **모니터 판정**(`check.rs` 단위 — 기존 헬퍼가 본문을 `serde_json`으로 읽으므로 진짜 경로): 값 묶음 `972.0979928970337`·`1.5e-300`·`4.5e250` 각각에 대해 `=` 통과 · `∈`(그 값이 든 후보 목록) 통과 · `≠` 실패 · `≥` 같은 값 통과. **RED 담당 = `=`·`∈`·`≠`·`≥`**. `≤`는 함께 단언하되 RED가 아니다(틀린 값이 실제보다 작아 지금도 통과) — 테스트 안 주석으로 밝힌다. `≠` 실패 사유 글자 = 본문과 같은 수의 서버 표기(`972.0979928970337`·`1.5e-300`·`4.5e+250` — 구현 중 실측 확정).
- **엔진 추출**(`extract.rs` 단위): `$.v` 추출 결과 글자가 같은 값 묶음에서 본문과 같은 수(위 표기).
- **캐스트**(`cast.rs` 단위): `coerce_num(x)`를 직렬화한 값이 `x.parse::<f64>()`와 같다(같은 값 묶음).
- **성질 테스트**(엔진 단위, 결정적): 고정 시드 의사난수 `f64` N개(예 20,000 — 2b spec 리뷰가 무작위 글자 20,000개 중 5,638개 오독을 관측)를 `serde_json`으로 출력 → `serde_json::from_str::<f64>`가 `str::parse::<f64>`와 같다. 손으로 고른 세 값이 놓치는 같은 류를 지킨다. 새 의존 없이(간단한 xorshift).
- **TUI**: `pick_test` 기존 단언이 표 이동 뒤 그대로 통과.
- 공허 방지: 위 테스트 본문은 기능 플래그를 모른다. 켜기 전 RED가 곧 이빨 실증이다.

**커밋 원자성**: 새 테스트·`MISREAD` 표 이동·기능 플래그는 한 커밋이어야 한다(어느 하나만 있으면 pre-commit 게이트가 RED). RED 실증은 커밋 전 작업 트리에서.

## 4. 그 밖의 테스트 영향

리뷰 1라운드 확인: 옛 읽기 값을 박은 곳은 `MISREAD` 표와 `crates/tui/CLAUDE.md:38`뿐(`grep -rnE '[0-9]\.[0-9]{10,}|[0-9]e[-+]?[0-9]{2,}' crates --include='*.rs'` → `runner.rs` 허용오차 리터럴만. export 골든 `testdata/compare_golden.json`의 긴 소수는 `< 1e-9` 허용오차 비교 — `export.rs:691`). 그래도 켠 뒤 전체 게이트에서 깨지는 테스트는 **값을 맞추지 말고** "정확해진 결과인가"를 판정해 기록 — 정확해진 것이면 기대값 수정 + 근거, 아니면 STOP.

## 5. 속도 확인

`serde_json` 문서는 `float_roundtrip`을 소수 파싱 약 2배 비용이라 밝힌다(정수·문자열은 무관). 부하 run의 지연(p50 등)은 본문을 받기 **전**에 재기를 멈추므로(`executor.rs` `latency = started.elapsed()` → 그 뒤 `resp.bytes()`·`evaluate_extracts`) 파싱 비용이 안 보인다. 파싱 비용이 사용자에게 보이는 유일한 길은 **워커 CPU가 한계일 때의 달성 RPS**다.

- **(a) 파싱 측정(크기 기록)**: 스크래치패드의 버리는 crate(커밋 안 함) — 같은 본문(소수 위주 약 20KB 배열)을 `serde_json::from_slice::<Value>`로 반복 파싱, `--release`, 기능 끈 빌드·켠 빌드(`features = ["serde_json/float_roundtrip"]`) 각각 1회당 시간. 기록: 1회당 차이 × (b)의 RPS = 워커 CPU 중 파싱 증가분 비율의 상한.
- **(b) run 비교(판정)**:
  - 바이너리: 같은 커밋에서 **release** 워커 두 개 — 기능 끔(`worker-off`)·켬(`worker-on`). 컨트롤러는 하나, `--worker-bin`으로 바꿔 띄운다(기본값은 `target/debug/worker`라 명시 필수 — 다른 워크트리·디버그 바이너리 혼입 금지).
  - 응답기: 로컬, 지연 0, 약 20KB 소수 배열 JSON(라이브 검증 응답기 재사용 가능). 시나리오: GET 1스텝 + 본문 `$.v[0]` 추출(본문 전체를 파싱하게).
  - 포화: closed-loop VU를 늘려 `worker-off`의 RPS가 더 안 오를 때(정체)의 VU로 고정. 정체 지점에서 워커 CPU가 한계인지 확인(워커 프로세스 CPU ≈ 코어 한계, 응답기가 아님). 응답기가 먼저 한계면 측정이 무의미 — 응답기를 바꾸거나 그 사실을 기록하고 STOP.
  - 순서: A/B/A/B/A/B 교차 각 30초, 같은 설정.
  - **통과**: `worker-on` 3회 평균 RPS ≥ `worker-off` 3회 최솟값. 기록: 각 run RPS·p50, 워커 CPU, (a) 수치. 실패 시 STOP → 사용자에게 수치 보고(최악 조건임을 함께 — 실사용 본문은 소수가 이보다 드물다).

## 6. 비목표

- TUI `number_text` 반반 반올림(§B53 (1) 둘째) · 숫자 글자 세 벌 통합(§B53 (2)) · 2^53 넘는 정수 표기 — 각각 별도.
- `arbitrary_precision` 기능(숫자를 글자 그대로 보존) — 판정 의미가 바뀌는 다른 결정이다.
- UI 코드 변경 없음(JS는 이미 정확히 읽는다). 풀 워커 버전 확인 추가(§2-4의 노트로만).

## 7. 라이브 검증

라이브 전 `cargo build -p handicap-worker`(옛 워커 바이너리 함정).

- **US1**: 응답기 `{"v":972.0979928970337,"w":1.5e-300,"x":4.5e250}` → 모니터 GUI 보드에 칸 하나, 값마다 `=` 조건 + `$.v`·`$.w`·`$.x` 표시 항목 → 저장 → 다음 점검에서 칸 통과, 표시 값 `972.0979928970337`·`1.5e-300`·`4.5e+250`. 같은 칸에 `≠ 972.0979928970337` 조건 하나를 더하면 실패, 사유 글자 `972.0979928970337`.
- **US2**: 같은 응답기로 TUI(tmux) `a` → 세 값 `조건으로 추가` → 보드 파일 조건 `value` 글자가 GUI가 저장한 조건(`GET /api/monitor-boards/{id}`)과 같다.
- **US3**: 에디터 test-run — 응답에서 `$.v` 추출 → 다음 요청 본문 `{"p": {{v:num}}}` → trace의 추출 값·보낸 본문이 `972.0979928970337`(로깅 echo 응답기로 와이어 확인). test-run은 컨트롤러 안에서 돌고 부하 run의 워커 경로는 `extract.rs` 단위 테스트가 지킨다 — 워커 경로는 §5 (b) run의 추출이 함께 지나간다.
- **속도**: §5 (b).

## 8. 보안

새 sink·새 입력 경로 없음(같은 값을 더 정확히 읽을 뿐). 요청 실행·캐스트 경로를 건드리므로 finish-slice §0 grep 결과를 따른다.

## 9. 사실 주장 명령 (claims-ledger)

- 기능 꺼짐: `cargo tree -e features -i serde_json --workspace | grep -E 'serde_json feature'` → `alloc`·`default`·`raw_value`·`std`만.
- 버전: `grep -n -A1 'name = "serde_json"' Cargo.lock desktop/src-tauri/Cargo.lock` → 1.0.150.
- 루트 줄: `grep -n '^serde_json = ' Cargo.toml` → :40. 데스크톱: `grep -n 'serde_json\|handicap-controller' desktop/src-tauri/Cargo.toml` → :30·:33.
- workspace 상속 전수: `grep -rn 'serde_json' crates/*/Cargo.toml | grep -v 'workspace = true'` → 0줄.
- 소비처: `grep -rln 'as_f64()' crates/*/src`·`grep -rln 'serde_json::from_\|\.json()' crates/*/src`.
- 줄번호: `grep -n 'n.as_f64()\|fn op_passes\|ConditionOp::OneOf =>\|text: stringify' crates/controller/src/monitor/check.rs`·`grep -n 'from_slice\|fn stringify' crates/engine/src/extract.rs`·`grep -n 'fn coerce_num' crates/engine/src/cast.rs`·`grep -n 'const MISREAD\|const EXACT' crates/tui/tests/pick_test.rs`·`grep -n 'let latency = started.elapsed\|resp.bytes()\|evaluate_extracts(' crates/engine/src/executor.rs`.
- 옛 값 박힘 전수: `grep -rnE '[0-9]\.[0-9]{10,}|[0-9]e[-+]?[0-9]{2,}' crates --include='*.rs'`.
