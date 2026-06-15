# XLSX Insights 시트 — 사이징 권장 3열 추가 (A9 정밀화 스코프 A)

- **날짜**: 2026-06-15
- **상태**: 설계 승인(사용자 2026-06-15) → plan 대기
- **출처**: roadmap §A9 "포화 인사이트 정밀화"의 의도적 연기 항목 "XLSX recommended/cause 열". A9 사이징 권장(`2026-06-14-capacity-sizing-recommendation`) + worker_count 추천(ADR-0038)이 `load_gen_saturated` 인사이트에 사이징 3필드(`recommended`/`cause`/`recommended_workers`)를 채워 화면(`InsightPanel`)엔 노출하지만, **단일-run XLSX export의 Insights 시트엔 빠져 있다**(두 선행 슬라이스가 의도적으로 연기). export 사용자에게도 "그래서 뭘 설정하나"가 닿게 하는 완성도 보강.
- **연관**: A9 사이징 권장 spec `2026-06-14-capacity-sizing-recommendation-design.md`(§5 "XLSX Insights 시트는 recommended/cause 열 미추가로 유지 — §8 연기"), A4c spec `2026-06-03-a4c-actionable-report-summary-design.md`(단일-run XLSX Insights 시트를 처음 추가), ADR-0028(A4c insights 패턴), ADR-0030(리포트 export CSV/XLSX), ADR-0038(`recommended_workers`).
- **ADR 신규 불필요**: A4c가 "인사이트 export = 기존 export 파이프라인 내 additive, ADR 불요" 선례. 새 결정 없음. `Insight` 구조체·UI Zod도 무변경(필드가 이미 존재).

---

## 1. 문제와 목표

`load_gen_saturated` 인사이트는 open-loop 포화 run(`dropped > 0`)에서 사이징 처방을 계산한다:
- `cause`: `"slots"`(max_in_flight를 올려라) | `"capacity"`(워커 CPU/대상 서버 한계, 올려도 무익)
- `recommended`: slot-bound일 때 권장 `max_in_flight`(Little's Law `ceil(target × p50)`)
- `recommended_workers`: capacity-bound일 때 권장 `worker_count`(`ceil(target × wc / peak)`)

화면(`InsightPanel`)은 이 세 필드로 "다음 행동" 줄을 렌더한다. 하지만 리포트를 XLSX로 내려받으면 `Insights` 시트엔 `kind`~`window_seconds` 9열만 있고 **사이징 처방이 사라진다** — export로 리포트를 보관·공유하는 사용자(운영 회귀 추적 등)는 화면을 다시 열어야만 권장값을 본다.

**목표**: 단일-run XLSX `Insights` 시트에 `recommended`·`cause`·`recommended_workers` **3열을 추가**해, 화면에 뜨는 사이징 처방이 export에도 1:1로 실리게 한다.

**비목표(연기)**: §6 참조. 요약: mean 지연 프록시 전면 업그레이드(C), per-window dropped 핀포인트, 원인 자동 귀속, CSV/비교 export 인사이트.

---

## 2. 핵심 통찰 (설계의 근거)

1. **순수 가산·읽기경로·backend-only.** 추가할 데이터는 이미 `ReportJson.insights[].{recommended,cause,recommended_workers}`에 존재한다(두 선행 슬라이스가 계산·직렬화 완료). 이 슬라이스는 **그 필드를 XLSX 셀로 *쓰기*만** 한다 — 새 계산·새 데이터 흐름 0. `crates/controller/src/export.rs` 한 파일.

2. **`Insight` 구조체·UI Zod 무변경.** `Insight`에 세 필드가 이미 있고(`insights.rs`: `recommended`=29, `cause`=32, `recommended_workers`=36), `InsightSchema`도 셋 다 `.optional()`로 이미 보유(`ui/src/api/schemas.ts:362-365`). 와이어 shape 변화 없음 → UI·proto·migration 전부 무변경.

3. **단일-run XLSX에만.** A4c가 정한 경계 그대로: 인사이트는 **단일-run** `report_to_xlsx`의 `Insights` 시트에만 존재한다. 비교(multi-run) XLSX(`comparison_to_xlsx`)엔 Insights 시트 자체가 없고, CSV export(`report_to_csv`/`comparison_to_csv`)에도 인사이트가 없다. 이 슬라이스는 그 경계를 **확장하지 않는다**(CSV/비교 인사이트는 §6 연기) — `report_to_xlsx`의 Insights 블록만 손댄다.

4. **헤더는 필드명 그대로(시트 컨벤션 유지).** 기존 Insights 시트 헤더는 전부 `Insight` 필드명(`kind`/`severity`/`step_id`/`metric`/`value`/`pct`/`count`/`status_class`/`window_seconds`). 새 3열도 동일 컨벤션으로 `recommended`/`cause`/`recommended_workers` — 필드↔열 매핑이 자명하고, "human-friendly 헤더"(예: "권장 max_in_flight")는 시트 전체 일괄 작업이라 범위 밖.

5. **conditional 쓰기(`if let Some`)로 비-포화 인사이트는 빈 셀.** 세 필드는 `Option`이고 `load_gen_saturated`(그것도 cause 분기에 따라)만 일부를 채운다. 기존 시트의 다른 optional 열(`step_id`/`value`/…)과 동일하게 `if let Some(v) = …`로 present일 때만 셀을 쓴다 → 비-포화 인사이트 행은 새 3열이 빈 셀(calamine read 시 해당 셀 없음).

---

## 3. 변경 상세

**파일: `crates/controller/src/export.rs` (단일 파일)**

### 3.1 헤더 (현 `:322-337`)
헤더 배열에 3개 append (현재 9개 → 12개). 열 인덱스는 `Insight` 구조체 필드 선언 순서(`recommended` → `cause` → `recommended_workers`)를 따라 col 9/10/11:

```
"kind"(0) … "window_seconds"(8),
"recommended"(9), "cause"(10), "recommended_workers"(11)
```

### 3.2 행 writer (현 `:338-363`)
각 인사이트 행 loop 끝에 conditional 3줄 추가(기존 `if let Some` 패턴):

```rust
if let Some(v) = ins.recommended {
    ws.write_number(r, 9, v).expect("w");
}
if let Some(v) = &ins.cause {
    ws.write_string(r, 10, v).expect("w");
}
if let Some(v) = ins.recommended_workers {
    ws.write_number(r, 11, v).expect("w");
}
```
- `recommended`·`recommended_workers`: `f64` → `write_number`.
- `cause`: `String` → `write_string`(`&ins.cause`로 차용).

### 3.3 테스트 (현 `xlsx_has_insights_sheet` `:494`)
기존 테스트는 `slowest_step` 인사이트(사이징 필드 모두 None) 1개만 본다. **세 새 열을 한 행에서 모두 검증**하기 위해 `load_gen_saturated` 인사이트 행 1개를 `r.insights` 벡터에 추가하되 **세 필드를 모두 Some으로 설정**: `recommended: Some(106.0)`, `cause: Some("slots".into())`, `recommended_workers: Some(6.0)`. (실제 인사이트에선 `recommended`(slots)와 `recommended_workers`(capacity)가 상호배타지만, 그 배타성은 `insights.rs`의 불변식이지 export writer의 관심사가 아니다 — export는 present 필드를 그대로 쓰므로, 한 픽스처 행에 셋 다 채워 세 열 writer를 모두 운동시키는 게 가장 단순한 계약 테스트다.) 단언:
- 새 헤더 3개 셀: `(0,9)`=="recommended", `(0,10)`=="cause", `(0,11)`=="recommended_workers".
- 그 인사이트 행: `recommended`(Float 106.0), `cause`(String "slots"), `recommended_workers`(Float 6.0).
- 기존 `slowest_step` 행: 새 3열 셀은 없음(present 안 함 → calamine `get_value`가 `None`/`Empty`) — 빈-셀 conditional-write 불변식 확인.
- 기존 단언(kind/value 등) 유지.

행 순서: 이 테스트는 `ReportJson.insights`를 **직접 구성**(`r.insights = vec![…]`, `derive_insights`의 `order_rank` 정렬 미경유)하므로 행은 벡터에 넣은 순서대로 쓰인다 — 단언 행 인덱스를 벡터 순서로 맞추면 됨.

---

## 4. 무변경 / 불변식 (명시)

- **엔진·워커·proto·migration·골든 fixture 무변경.**
- **`Insight` 구조체·`derive_insights`·`report.rs` 무변경** — 데이터는 이미 흐름. export.rs만.
- **UI·Zod·ko.ts 무변경** — `InsightSchema`에 3필드 이미 존재, 화면은 이미 렌더.
- **CSV export·비교(multi-run) XLSX 무변경** — 단일-run XLSX Insights 시트만 손댐.
- **p50 parity 불변** — create-time `recommendSlots`(`ui/src/components/sizing.ts:56`) ↔ post-run `insights.rs` `required`(`:230`) 둘 다 p50 유지. 이 슬라이스는 사이징 *수식*을 안 건드린다(필드 export만).
- **기존 `Insights` 시트의 9열·다른 시트(Summary/Steps/Windows/Status/Branches)·헤더 무변경** — append-only.

---

## 5. 테스트 / 검증

- **단위(계약)**: `xlsx_has_insights_sheet` 확장(§3.3) = calamine 라운드트립으로 새 3열 헤더·셀을 직접 읽어 단언. 이게 이 슬라이스의 **계약 테스트**(직렬화 정확성).
- **게이트**: cargo workspace(`build`/`clippy -D warnings`/`nextest`/doctest) — pre-commit이 강제. UI 무변경이라 UI 게이트 불요(단, pre-commit이 `ui/` non-`.md` staged만 UI 게이트 실행하므로 자동 skip).
- **라이브 검증 불요(계약 테스트로 충분)**: 이 변경은 run-생성·report-파싱·엔진 경로를 **건드리지 않는다**(S-D 갭 = UI run-생성 응답 파싱과 무관). XLSX 직렬화는 calamine 라운드트립이 결정론적 계약이라 라이브 불필요. *선택적* 스팟체크: 포화 run 1개의 `report.xlsx`를 내려받아 Insights 시트 J/K/L 열에 권장값이 보이는지 눈으로 확인(머지 차단 아님).

---

## 6. 의도적 연기 (roadmap §A9/§B에 누적)

- **C. p50→mean 지연 프록시 전면 일관 업그레이드** (사용자 2026-06-15, "쓸만한 아이디어"로 후속 기록): post-run `insights.rs` `required` + create-time `sizing.ts` `recommendSlots`를 둘 다 mean으로 교체해 체계적 under-sizing(우편향 분포 `p50<mean`)을 교정 + **create-time↔post-run parity 보존**. 필요 작업 = `ReportSummary.mean_ms` 노출(`overall.mean()`) + UI Zod summary + `ui/src/components/sizing.ts` `recommendSlots` 프록시 교체 + `usePriorOpenRunAnchor` 앵커(`summary.p50_ms`→`mean_ms`) + 테스트/live-verify. backend+UI 크로스커팅이라 별도 슬라이스. (단독으로 post-run만 mean으로 바꾸면 parity가 체계적으로 깨져 비추천 — 전면 업그레이드로만.)
- **per-window dropped 핀포인트**: 초별 `dropped` 분해(drain/guard/proto/migration 비용)로 ramp/curve에서 "어느 stage/초에서 꺾였나". v1은 run-total `dropped` + peak로 충분.
- **원인 자동 귀속(부하기 vs SUT)**: 에러/지연 신호로 인사이트가 자동 분기 표기. spec이 의도적으로 사용자 위임(다음 행동 줄)으로 남긴 항목 — 오도 위험, 휴리스틱 신중 설계 필요.
- **CSV·비교(multi-run) export 인사이트**: 현재 인사이트는 단일-run XLSX에만. CSV/비교에 인사이트 컬럼을 들일지는 별도.
- **human-friendly XLSX 헤더**: 현 헤더는 필드명. "권장 max_in_flight" 같은 한국어/설명 헤더는 시트 전체 일괄 작업(소급).

---

## 7. 구현 순서 (plan 입력)

순수 backend·단일 파일이라 **하나의 green 커밋**으로 fold(Rust 게이트가 전체 워크스페이스를 돌려 dead-code/RED 단독 커밋 불가 — 헬퍼/로직/테스트를 한 커밋에):

1. `export.rs`: §3.3 테스트 먼저 확장(RED: 새 헤더/셀 단언이 아직 안 써져 실패) → §3.1 헤더 3개 + §3.2 행 writer 3줄 추가(GREEN).
2. cargo 게이트(`cargo build -p handicap-worker` 워밍 후 `cargo nextest run -p handicap-controller` 또는 워크스페이스) green 확인.
3. 커밋(파이프 없이) + `git log -1` landed 확인.
4. docs: roadmap §A9 완료 한 줄 + §6 연기 항목 누적, build-log 한 단락.
