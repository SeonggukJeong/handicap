# 0018. VU별 자동 cookie jar (세션 인증 지원)

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

사내 REST API 중에는 JWT 토큰 외에 전통적인 세션(쿠키) 인증을 사용하는 곳이 있다. 세션 인증을 지원하려면 워커가 cookie jar를 관리해야 하고, 각 VU는 서로 다른 "사용자" 이므로 cookie jar는 VU 간 격리되어야 한다. 그렇지 않으면 한 VU의 세션이 다른 VU에 누수되어 테스트 결과가 무의미해진다.

## Decision Drivers

- 사내 시스템의 인증 방식 다양성 (JWT 토큰 + 세션 쿠키 둘 다 존재)
- VU 격리 (한 VU의 인증 상태가 다른 VU에 영향 없어야 함)
- 명시적 제어 가능성 (특정 cookie 값 디버깅·로깅 필요 시)
- reqwest의 `cookie_store` 기능 활용

## Considered Options

1. **VU별 자동 cookie jar (default ON)** — VU당 1개 jar, reqwest `cookie_store(true)`
2. **수동만 (default OFF)** — 모든 cookie를 시나리오에서 명시적 extract/use
3. **시나리오 레벨 shared cookie jar** — VU 간 cookie 공유 (틀린 모델)
4. **글로벌 cookie jar** — 모든 시나리오·VU가 공유 (틀린 모델)

## Decision

**옵션 1: VU별 자동 cookie jar 기본 ON.**
- 워커는 VU task 시작 시 새 `reqwest::cookie::Jar` 생성, 그 VU의 모든 요청에 사용
- 시나리오에서 `cookie_jar: off` 선언 시 jar 비활성 (각 요청 stateless)
- 명시적 cookie 추출은 `extract: from: cookie, name: <cookie_name>` 으로 지원

## Consequences

**Positive**
- 세션 인증이 별도 설정 없이 작동 (login 후 자동으로 Set-Cookie 저장 → 다음 요청에 자동 첨부)
- VU 격리가 자연스러움 — 1000 VU가 각자 다른 사용자처럼 동작
- JWT 토큰 방식은 기존 `extract: from: body, path: $.access_token` + 다음 요청 header 그대로 동작 — 두 방식 모두 지원
- 명시적 제어 필요 시 extract로 cookie 값 꺼내 변수로 조작 가능

**Negative / Trade-offs**
- Cookie jar당 메모리 사용 — 보통 VU당 수 KB로 1만 VU 환경에서도 무시 가능 수준이지만 모니터링
- "왜 cookie가 자동으로 첨부되지?" 라는 의문 발생 가능 — 문서·UI 인스펙터에 "cookie jar: auto" 뱃지로 표시
- 디버깅 시 어느 cookie가 어디서 왔는지 추적은 별도 로깅 필요
