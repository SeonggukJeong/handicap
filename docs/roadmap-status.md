# 다음 작업 현황판 (roadmap-status)

> **"다음 뭐 하지?"의 단일 진입점.** 테마별 *어디까지 왔나(frontier)* + *추천 다음 작업*을 한눈에. 과거 `roadmap.md` 최상단의 next-up shortlist를 이 파일이 **대체·흡수**한다(중복 금지 — shortlist는 더 이상 roadmap.md에 없다). `/start-slice`는 이 표를 1순위로 읽고, `/finish-slice`는 끝낸 작업의 frontier를 전진시키고 추천 다음을 갱신해 항상 최신으로 유지한다(**세션마다 재합성 금지** — 손-큐레이트, 사용자 요청 2026-06-25).
>
> **상세는 여기 없다**(drift 차단): 각 테마의 후보 메뉴·착수 메모·설계 질문은 `roadmap.md §A`, 슬라이스별 의도적 연기 항목은 `roadmap.md §B`, 완료 슬라이스 이력은 `roadmap-archive.md`, 구현 결과·함정 출처는 `docs/build-log.md`. 이 표는 *어디를 펼지*만 가리킨다.

## 테마별 현황 (frontier → 추천 다음)

활성(추천 작업 있음) 3종을 위에, 성숙·완결 테마를 아래에 둔다. 성숙 테마도 자연스러운 다음 한 수를 적되 `(성숙)`으로 표시 — 당장 우선순위는 활성 3종.

| 테마 | 어디까지 (frontier) | 추천 다음 작업 | 상세 위치 |
|---|---|---|---|
| **보안·거버넌스** | 미착수 | **A10 RBAC / 기관 도입 보안 하드닝** — 코드 전에 brainstorming→ADR 선행(인증 위임[B] vs 인앱 계정[A]). 공공기관 도입 게이트라 후순위 아닌 **도입 전제**. §B1 민감값 마스킹+감사 로그 한 트랙 | roadmap.md §A10 |
| **데스크톱 배포** | 단일 self-contained exe(ADR-0039)·Tauri in-process 백엔드(ADR-0042)·NSIS 설치본 | **R4d Windows Job belt-and-suspenders**(트리거: Windows hung-워커 고아 *실측* 시만) + **코드서명**(SmartScreen 마찰)·인스톨러 메타·트레이/자동업데이트 묶음. macOS 개발기 검증 불가 | roadmap.md §A·ADR-0042·[[windows-desktop-distribution]] |
| **UX·디자인 시스템** | 토큰 토대(ADR-0043)+프리미티브 6종·4폼+결과·표시 화면군(알림→Callout·EditModal→Input) 확산·RunDialog 간단/상세 재구성 | **§B12 에디터/Inspector 화면군 토큰 이주** + 결과·표시 화면 깊은 Section/카드 토큰화 — 점진·byte-identical·토대 이미 존재(brainstorming 가벼움). 에디터 구조 재설계로 `FlowOutline`/에디터 툴바가 raw Tailwind라 토큰 이주 대상 확대 | roadmap.md §B12 |
| **에디터 구조 재설계 (B13)** | 슬라이스 1(세로 아웃라인 `FlowOutline`·그룹내 dnd-kit 드래그·디테일 1fr·변수 접기·YAML 양방향 모달·React Flow 제거, ADR-0044) + **레이아웃 후속 슬라이스 A**(변수 패널 세로 스택+사용 힌트·아웃라인 http leaf 이름/URL 한 줄 truncate·YAML 모달 Monaco 높이) + **드래그 후속 슬라이스 B**(#3 컨테이너 위 드래그 취소·#4 하위 미추종 = DragOverlay 서브트리 프리뷰+그룹스코프 충돌+소스 숨김; +도그푸딩 Problem 1 헤더기반 드롭[`nearestByHeader`]·Problem 2 형제 자식 추종[노드=wrapper]) + **YAML file-I/O 후속**(편집 모달에 파일 가져오기/내보내기·`downloadJson`→`downloadText`/`downloadYaml` 일반화[JSON byte-identical]·lenient import=기존 `loadFromString` 재사용·a11y Label-in-Name) 완료 | 슬라이스 2(하단 흐름 가로 칩 다이어그램+test-run 결과 색) **또는** 슬라이스 3(경계 넘는 re-parent dnd·또는 flat-tree Approach B 전면재작성) **또는** tier C(변수 rename/bulk·미정의 경고·**사용 힌트→스텝 네비게이션**[brainstorming 필요]) | roadmap.md §B13 |
| **부하모델·페이싱 (영역 D)** | S-A 타임아웃·S-B think·S-C open-loop·S-D stages·closed-loop VU 곡선 + 곡선 멀티워커 샤딩 — **영역 D 완결** | (성숙) §B9 QoL — graceful grace 상한·fresh-spawn 모드·VU 배율 노브 | roadmap.md §D·§B9·ADR-0031/0032/0037 |
| **리포트 깊이 (A4)** | SLO criteria(A4a)·run 비교+CSV/XLSX(A4b)·인사이트(A4c)·latency 분포(B7-D)·TTFB+다운로드(B7-C)·비교 뷰 깊이/polish | (성숙) B7 심화 — XLSX Δ 셀 조건부 서식(작은 백엔드)·트랜잭션 분해 DNS/TCP/TLS(큰 엔진 슬라이스) | roadmap.md §A4·§B7·ADR-0017/0028/0030 |
| **분산 워커** | fan-out(A3·ADR-0027)·open-loop fan-out(ADR-0038)·LAN pool L1~L7(ADR-0041)·풀 견고성/제어상태 영속화 | (성숙) capacity-aware 풀 (L2 — 워커 용량 광고·존중; 현재 capacity 무시) | roadmap.md §A3·§B2''·ADR-0041 |
| **용량·사이징 인사이트 (A9)** | 포화 인사이트 v1·Little's Law 사이징·create-time VU/슬롯/worker_count 헬퍼·open-loop misconfig 경고 — 거울상 전부 | (성숙) per-window dropped 정밀 핀포인트·achieved-vs-target 부족분 arm | roadmap.md §A9·ADR-0028 |
| **제어흐름 노드** | loop(7)·conditional(A1·ADR-0023)·parallel(A2·ADR-0033) + 그룹/페이지·per-branch 레이턴시 | (성숙) per-branch phase(TTFB/다운로드) 3차원·중첩 parallel(저우선) | roadmap.md §A1/§A2·ADR-0020/0023/0033 |
| **운영·스케줄러** | Run 스케줄러(A7·ADR-0034)·운영 상한 관리자 v1·설정 환경 그룹핑(B11) | (성숙) 알림 레이어(이메일/슬랙/웹훅, 이음새=`schedule_events`)·스케줄러 config 런타임 가변 | roadmap.md §A7·§B11·ADR-0034 |
| **템플릿·캐스트** | JSON 바디 캐스트 ADR-0029 v1 + env/시스템 토큰·`:json`(객체/배열/숫자/불리언/문자열/null·변수기반 null) 확장 완료 (json-cast-extend) | (성숙) form/쿼리/raw 바디 캐스트(와이어 전부 문자열=검증-only 가치·저우선)·nullable 규칙(`:json?` empty/unbound→null)·**env-secret WARN-로그 노출 마스킹은 §B1 트랙** | roadmap.md §B1·ADR-0029 |

**소규모 후속**(위 테마에 안 묶이는 자잘한 것 — 출처 §B*): G2 k8s register-전 reaper(현 60s watchdog 폴백) · RunDialog 크기 칩 상대배수 사이징(Option C — 고정 10/50/200 대신 기준 측정치 대비 0.5×/1×/2×, rundialog-ux-fixes §6 백로그) · per-worker p95/p99 분해 · best-effort/degraded 모드 토글(§B2''). → 착수 슬라이스 plan 작성 시 `roadmap.md §B`에서 흡수.

## 갱신 규칙 (finish-slice가 손본다)

- 끝낸 작업: 해당 테마 행의 **frontier에 한 마디 추가** + **추천 다음을 새 frontier 기준으로 교체**(다 끝났으면 `(성숙)` + 다음 자연수 한 수).
- 새 활성 후보 등장: 성숙 테마의 추천 다음을 활성으로 끌어올리거나, 새 테마 행 추가.
- 이 파일엔 *현황·포인터*만 — 구현 상세·완료 로그·연기 항목 카탈로그는 절대 쌓지 말 것(각각 build-log·roadmap-archive·roadmap.md §B). 비대 신호 = 한 행이 두 줄을 넘으면 상세를 roadmap.md로 밀고 포인터만 남긴다.
