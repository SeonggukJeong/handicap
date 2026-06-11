/**
 * UI 한국어 메시지 카탈로그 (ADR-0035).
 * - 신규·변경 문구는 이 카탈로그 경유로 작성한다 (기존 미변경 문구의 소급 추출은 비목표).
 * - 기술 고유명사(VU, RPS, p95, cron, YAML)는 원어 유지 + 설명 병기.
 * - i18n 라이브러리 없음 — 나중에 en.ts + 컨텍스트 스위치를 더할 수 있는 구조만 유지.
 * - 용어 정의(glossary)는 전 화면 HelpTip의 단일 소스 — 화면마다 설명이 달라지면 안 된다.
 */
export const ko = {
  glossary: {
    vu: "동시 사용자(VU) — 동시에 요청을 보내는 가상 사용자 수입니다.",
    rps: "RPS — 초당 요청 수(Requests Per Second)입니다.",
    p50: "p50(중앙값) — 전체 요청의 50%가 이 시간 안에 응답했다는 뜻입니다. 낮을수록 좋습니다.",
    p95: "p95 — 전체 요청의 95%가 이 시간 안에 응답했다는 뜻입니다(꼬리 지연). 낮을수록 좋습니다.",
    p99: "p99 — 전체 요청의 99%가 이 시간 안에 응답했다는 뜻입니다(최악에 가까운 지연). 낮을수록 좋습니다.",
    rampUp: "점진 시작(ramp-up) — 부하를 0에서 목표치까지 서서히 올리는 시간입니다.",
    closedLoop:
      "사용자 수 기준(closed-loop) — 가상 사용자 N명이 각자 응답을 받은 뒤 다음 요청을 보내는 방식입니다. 일반 시나리오에 적합합니다.",
    openLoop:
      "요청 속도 기준(open-loop) — 응답 속도와 무관하게 목표 RPS로 요청을 발사하는 방식입니다. 처리량 한계 측정에 적합합니다.",
    thinkTime: "think time — 실제 사용자처럼 요청 사이에 쉬는 시간입니다.",
    maxInFlight:
      "동시 요청 상한(max in-flight) — 동시에 진행 중일 수 있는 요청 수의 상한입니다. 서버가 목표 속도를 못 따라가면 초과분은 drop으로 집계됩니다.",
    slo: "합격 기준(SLO) — 응답시간·에러율 등의 임계값입니다. 설정하면 run 종료 시 합격/불합격을 자동 판정합니다.",
    scenario: "시나리오 — 부하를 줄 API 요청 흐름의 정의입니다.",
    step: "스텝 — 부하 중 반복 실행될 HTTP 요청 1개입니다.",
    run: "실행(run) — 시나리오에 부하 설정을 적용해 한 번 돌린 기록입니다.",
  },
  runDialog: {
    title: "새 실행",
    run: "실행",
    running: "시작 중…",
    cancel: "취소",
    groupLoad: "부하 정의",
    groupTarget: "대상 설정",
    groupAdvanced: "판정·고급 (선택)",
    sectionSlo: "합격 기준(SLO)",
    sectionPacing: "페이싱 (think time)",
    sectionDiag: "진단",
    blockedReasonsIntro: "실행하려면 다음을 해결하세요:",
    bindingReasonPrefix: "데이터 바인딩: ",
  },
  loadModel: {
    closedLoop: "사용자 수 기준 (closed-loop)",
    openLoop: "요청 속도 기준 (open-loop)",
    vus: "동시 사용자(VU)",
    duration: "테스트 시간(초)",
    rampUp: "점진 시작(초)",
    targetRps: "목표 RPS",
    maxInFlight: "동시 요청 상한",
    httpTimeout: "HTTP 타임아웃(초)",
    loopCap: "루프 집계 상한",
    thinkMin: "think 최소(ms)",
    thinkMax: "think 최대(ms)",
    thinkSeed: "think 시드 (선택)",
    sizePresetsLabel: "부하 크기 프리셋",
    sizePresets: [
      { label: "가볍게", vus: 10, durationSeconds: 30, hint: "10명 · 30초" },
      { label: "보통", vus: 50, durationSeconds: 60, hint: "50명 · 1분" },
      { label: "세게", vus: 200, durationSeconds: 180, hint: "200명 · 3분" },
    ],
  },
  validation: {
    rampUp: "점진 시작은 테스트 시간 이하여야 합니다.",
    targetRps: "목표 RPS는 1 ~ 1,000,000 사이여야 합니다.",
    maxInFlight: "동시 요청 상한은 1 ~ 10,000 사이여야 합니다.",
    httpTimeout: "HTTP 타임아웃은 1 ~ 600초 사이여야 합니다.",
    loopCap: "루프 집계 상한은 0 ~ 10000 사이여야 합니다.",
    think: "페이싱(think time)은 min ≤ max ≤ 600000, 두 칸 모두 입력해야 합니다.",
  },
  nav: {
    scenarios: "시나리오",
    datasets: "데이터셋",
    environments: "환경",
    schedules: "스케줄",
  },
  breadcrumb: {
    ariaLabel: "탐색 경로",
    runs: "실행 목록",
    compare: "런 비교",
    // "새 시나리오" crumb은 ko.pages.newScenario 재사용(단일 소스) — 별도 키 만들지 말 것.
  },
  onboarding: {
    ariaLabel: "시작 가이드",
    title: "처음이신가요? 3단계로 시작해 보세요",
    dismiss: "가이드 닫기",
    done: "완료",
    step1Title: "시나리오 만들기",
    step1Desc: "테스트할 API 요청 흐름을 정의합니다.",
    // "새 시나리오 만들기"(empty.scenariosCta)와 다른 문구여야 한다 — 같은 화면(빈 홈)에서
    // 두 링크의 accessible name이 충돌하면 RTL getByRole 단독 조회가 깨지고 UX상도 중복.
    step1Cta: "시나리오 만들러 가기",
    step2Title: "실행하기",
    step2Desc: "동시 사용자 수와 시간을 정해 부하를 보냅니다.",
    step2Cta: "실행하러 가기",
    step2Blocked: "먼저 시나리오를 만들어 주세요.",
    step3Title: "결과 읽기",
    step3Desc: "응답 속도와 에러로 합격 여부를 판단합니다.",
    step3Cta: "결과 보러 가기",
    step3Blocked: "먼저 실행(run)을 만들어 주세요.",
  },
  empty: {
    scenarios: "시나리오는 부하를 줄 API 요청 흐름입니다. 첫 시나리오를 만들어 보세요.",
    scenariosCta: "새 시나리오 만들기",
    datasets:
      "데이터셋은 시나리오의 {{변수}}에 줄 단위로 주입할 CSV/XLSX 표입니다. 시나리오가 변수를 쓸 때만 필요해요.",
    datasetsCta: "위 업로드 패널에서 CSV/XLSX 파일을 올려 보세요.",
    environments:
      "환경은 ${BASE_URL} 같은 환경 변수 묶음입니다. 같은 시나리오를 dev/stage에 번갈아 쏠 때 씁니다.",
    environmentsCta: "환경 만들기",
    schedules:
      "스케줄은 시나리오를 정해진 시각(1회) 또는 주기(cron)로 자동 실행합니다. 합격 기준과 함께 쓰면 회귀 감시가 됩니다.",
    schedulesCta: "스케줄 만들기",
    runs: "아직 실행 기록이 없습니다. 부하 설정을 정해 첫 실행을 만들어 보세요.",
    runsCta: "실행하기",
  },
  pages: {
    newScenario: "새 시나리오",
    nameCol: "이름",
    versionCol: "버전",
    updatedCol: "수정",
    duplicate: "복제",
    runsLink: "실행 →",
    newEnvironment: "새 환경",
    editEnvironment: "환경 편집",
    newSchedule: "새 스케줄",
    editSchedule: "스케줄 편집",
    runsTitle: "실행 목록",
    runScenario: "실행하기",
  },
} as const;
