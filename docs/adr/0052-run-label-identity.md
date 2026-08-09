# 0052. run 라벨·식별성 — 단일 TEXT 컬럼 + 표시 폴백 체인 + 스케줄 자동 라벨

- **상태**: Accepted
- **날짜**: 2026-08-09

## Context

run을 사람이 구분할 안정 수단이 생성 시각 하나뿐이었다. 목록엔 run id 텍스트조차 없고(체크박스 aria-label에만), 비교 매트릭스/오버레이는 `#끝6자`+세션-한정 위치 색뿐, 상세는 비교와 다른 축약(앞8자)을 썼으며, 스케줄 발사 run은 수동 run과 전 표면 무구분이었다. 사용자 확인(2026-08-09): pain은 네 지점 전부(비교 화면·대상 선택·시간 경과 후·상세), 구분 정보는 설정 차이(자동 도출)+의도/맥락(수동) 둘 다 필요.

## Decision

**`runs.label` 단일 nullable TEXT 컬럼(migration 0021, Rust-guarded ALTER) + 표시 폴백 체인 `runDisplayLabel = label ?? #끝6자` 단일 소스 + 스케줄 이름 자동 라벨.**

- **관통 경로 3개**: REST create(`CreateRunRequest.label`, `#[serde(default)]`) · 스케줄러(발사 시 `schedule_label(name)` = trim+`chars().take(200)` 클램프 — 자동 경로라 400 불가) · 사후 편집 `PUT /api/runs/{id}/label`(terminal 여부 무관). 정규화는 공유 `normalize_label`(trim→빈=None, **문자 수** 200 초과=400).
- **와이어 2종 분기**: `RunResponse.label`=plain Option→null→Zod `.nullish()` / `ReportRun.label`=`skip_serializing_if`→absent→`.optional()` — 무라벨 run 리포트 JSON 키셋 불변(byte-identical·골든 fixture 무변경).
- **표면**: 목록 라벨 열(plain th·인라인 편집·무라벨은 muted `#끝6자`) · 상세(라벨 행 편집+`profileSummary` 설정 요약 줄+축약 앞8자→끝6자 통일) · 비교 헤더(1줄 라벨, 2줄 시각·설정 요약 — additive `sublines` prop, 버튼 밖 형제로 accname 비오염) · 오버레이 범례 · XLSX Runs 시트 label 열(2번째) · 목록 검색 축 `q`(라벨∨full id 부분일치, `#`-strip, 세 지점 trim 공유 정의).

**기각**: run-레벨 장문 메모(시나리오 `notes`가 장문 담당) · `schedule_id`/preset 구조 링크 컬럼(라벨 문자열이 출처를 나름 — 사용자 결정, 접근 C 기각) · 라벨 유니크 강제 · 편집 이력/감사(단순 UPDATE).

## Consequences

**Positive**: 전 표면에서 run을 사람 언어로 식별(US1~US6 라이브 PROVEN) · 스케줄/프리셋 발사 run 자동 식별 · 비교에서 본 `#끝6자` 토큰이 검색·상세와 일치.

**Negative / Trade-offs**: 라벨은 자유 텍스트라 유니크가 아니고 출처 구조 필터("이 스케줄이 발사한 run만") 불가 — 수요 확인 후 `schedule_id` 재검토(roadmap §B29) · 200자 클램프는 스케줄 이름 정보를 자를 수 있음(문자 수 기준이라 char-boundary panic은 없음) · CSV엔 라벨 열 없음(XLSX만 — §B29 연기).
