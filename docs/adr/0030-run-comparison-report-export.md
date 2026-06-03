# 0030. Run 비교 + 리포트 Export (CSV/XLSX)

- 상태: 채택
- 날짜: 2026-06-03

## 맥락

ADR-0017이 MVP 리포트 스코프에서 "run간 비교·CSV/Excel export"를 후속으로 미뤘다.
A4a(run-level SLO verdict) 직후, 사내 QA가 ① 같은 시나리오의 종료된 run들을 나란히
비교(baseline 대비 Δ)하고 ② 단일 run 리포트와 비교 결과를 Excel로 가공·공유할 수
있어야 했다.

## 결정

**하이브리드 아키텍처** — 비교는 클라이언트, export는 컨트롤러.

- **비교(A, 클라)**: 선택 run들의 기존 `GET /api/runs/{id}/report`를 N개 fetch해
  브라우저에서 순수 변환(`compareReports`). 백엔드 비교 엔드포인트·새 와이어 타입 0.
  같은 시나리오 내 terminal run만, **화면 2–5개(상한 5 고정)** — 5 초과는 export로.
- **export(B, 서버)**: 컨트롤러가 기존 `build_report` 결과를 직렬화. `csv` 재사용 +
  `rust_xlsxwriter`를 **dev-dep → 정식 dep로 이동**. 4 라우트:
  `GET /runs/{id}/report.csv|.xlsx`(단일, terminal-gated) +
  `GET /scenarios/{sid}/runs/compare.csv|.xlsx?run_ids=a,b&baseline=a`(비교,
  시나리오-하위라 `/runs/{id}` 충돌 회피 + same-scenario 강제, 안전 상한 50).
  **CSV = 표면당 1표**(헤드라인), **XLSX = 멀티시트**(전체).
- **델타 공식은 한 곳(spec §4.3)에 정의**해 Rust(export)·TS(화면)가 동일 적용하고,
  **공유 골든 fixture**(`testdata/compare_golden.json`)를 양쪽 테스트가 읽어
  같은 입력에 같은 pct·polarity를 내는지 교차 검증(이중 구현 드리프트 방지).

거절: ① 서버 비교 엔드포인트(기존 `/report` N-fetch로 충분, 새 와이어 0),
② `<a download href>`(오프라인 Safe-Browsing transient 실패 + 4xx 미노출 — fetch→blob로
에러 배너 + `Content-Disposition` 사용), ③ 화면 N 상한 사용자 설정화(이번엔 5 고정).

## 범위

v1 = 같은-시나리오·terminal-only 비교 + 단일/비교 CSV·XLSX export. 비교 = 요약 지표
+ 스텝별 p95 + status 분포 + verdict(PASS/FAIL 텍스트). 델타 polarity:
lower_is_better{p50/p95/p99/error_rate} / higher_is_better{rps} / 중립{count}.

연기(roadmap §B): per-second 차트 오버레이, N 상한 설정화, 크로스-시나리오 비교,
레이턴시 히스토그램(D, 다음 슬라이스), 트랜잭션 시간 분해(C, 엔진 계측), A4c 요약,
**verdict 행의 baseline-상대 polarity**(현재는 PASS/FAIL 텍스트만 — §4.3의
candidate-FAIL&base-PASS→bad 규칙은 미구현), 비교 export Δ 셀 조건부 서식.

## 결과

엔진·워커·proto·SQLite 마이그레이션 **무변경**(`build_report`·`Report` 스키마 그대로
재사용). export 없으면 byte-identical. `report()` 핸들러의 4-fetch+build 블록을
`build_report_for_run(db, run_id)` 헬퍼로 추출해 단일·비교 export·기존 핸들러가 공유.
`downloadFile`(fetch→blob, 4xx→`ApiError` 배너)는 `DownloadJsonButton`(JSON 전용)과
구분되는 byte-blob 공용 헬퍼.
