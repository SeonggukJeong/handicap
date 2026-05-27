# 0013. Scenario와 Run Config 분리

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

부하 테스트의 "무엇을(시나리오)" 과 "어떻게(부하 프로파일)" 를 한 모델에 합칠지, 분리할지. JMeter는 합쳤고, LoadRunner는 분리한다. 이 선택이 GUI 캔버스의 단순성과 시나리오 재사용성을 좌우한다.

## Decision Drivers

- 같은 여정을 여러 부하 패턴으로 실행 가능 여부
- git 친화성 (시나리오는 코드 리뷰 대상)
- GUI 캔버스의 단순성 (그릴 것이 여정만이면 단순)
- run 결과 해석 시 "무엇이 바뀌어 결과가 달라졌나" 명확성

## Considered Options

1. **분리** — Scenario YAML + RunConfig DB 레코드 (LoadRunner 스타일)
2. **통합** — 한 YAML에 둘 다 (JMeter 스타일)
3. **계층** — Scenario YAML + 환경별 override YAML (Helm values 스타일)

## Decision

**옵션 1: 분리.** Scenario는 YAML 파일(git에), RunConfig는 실행 다이얼로그 입력 → DB.

## Consequences

**Positive**
- 시나리오 파일이 작고 깔끔, git diff 의미 있음
- "100 VU vs 1000 VU 비교"가 RunConfig만 변경 (시나리오 미수정)
- 캔버스 = 여정만 그리기, 부하 프로파일은 사이드 폼 — UI 단순화

**Negative / Trade-offs**
- UI에 두 surface 필요 (Scenario 편집 화면 + Run 시작 다이얼로그)
- 처음 사용자가 "왜 두 곳이지" 혼동 가능 — 문서·UI 흐름으로 완화
- run 결과의 재현을 위해 run 레코드에 시나리오 snapshot 박아야 함 (ADR-0011의 `scenario_yaml` 컬럼)
