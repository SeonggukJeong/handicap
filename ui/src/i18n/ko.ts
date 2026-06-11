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
} as const;
