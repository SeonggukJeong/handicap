# 0035 — UI 문구: 한국어 통일 + 메시지 카탈로그(ko.ts) 경유

- Status: accepted
- Date: 2026-06-11

## Context and Problem Statement

UI 문구가 한영 혼용("New run" 제목 + "부하 모델" 레이블 + 영/한 섞인 검증 메시지)이고, 1차 사용자(사내 QA)는 부하테스트 전문 용어(VU, p95, open-loop)를 설명 없이 마주친다. 2026-06-11 UX 재설계 brainstorming에서 사용자가 언어 정책("한국어 먼저 + i18n 준비")을 직접 선택했고, ADR 기록 여부는 spec 리뷰 단계에서 위임받아 U1a에서 채택한다.

## Considered Options

1. 한국어 통일 + 신규 문구만 카탈로그 경유 (채택)
2. i18n 라이브러리 전면 도입 + 언어 토글 즉시 제공
3. 영어 통일

## Decision Outcome

옵션 1 채택:

- **신규·변경 UI 문구는 한국어로 작성.** 기술 고유명사(VU, RPS, p50/p95/p99, cron, YAML 등)는 원어 유지 + 첫 등장 지점에 설명(HelpTip ⓘ).
- **신규·변경 문구는 `ui/src/i18n/ko.ts` typed 상수 카탈로그 경유.** 용어 정의는 `ko.glossary`가 전 화면의 단일 소스.
- **i18n 라이브러리·언어 토글·기존 문구 소급 추출은 비목표**(YAGNI). 카탈로그 구조만으로 나중에 `en.ts` + 컨텍스트 스위치를 점진 도입 가능. 반쪽 토글(새 문구만 전환)은 한영이 뒤섞여 더 나쁘므로, 토글 도입 시점에 소급 추출을 함께 한다.

옵션 2 기각: 전 컴포넌트 문자열 추출이라는 큰 기계적 작업 + 이후 모든 슬라이스 2개 언어 유지보수를 지금 지불할 가치가 없음(사내 단일 테넌트, 1차 사용자가 한국어 화자). 옵션 3 기각: 1차 사용자(QA)의 진입 장벽이 목표와 정면 충돌.

## Consequences

- 이후 모든 UI 슬라이스는 새 사용자-노출 문구를 `ko.ts`에 추가하고 import해서 쓴다(인라인 한국어 리터럴 지양 — 용어 설명은 반드시 glossary 참조).
- 출처: UX 재설계 spec `docs/superpowers/specs/2026-06-11-ux-beginner-friendly-redesign-design.md` §1.3·§2.
