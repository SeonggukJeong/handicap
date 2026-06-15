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
    workerCount:
      "open-loop 부하를 여러 워커에 나눠 더 높은 목표 RPS를 냅니다. 한 워커가 목표를 못 내면 늘리세요 — 리포트가 권장값을 알려줍니다.",
    slo: "합격 기준(SLO) — 응답시간·에러율 등의 임계값입니다. 설정하면 run 종료 시 합격/불합격을 자동 판정합니다.",
    vuCurve:
      "VU 곡선 — 동시 사용자 수를 시간에 따라 단계별로 늘렸다 줄이는 부하 방식입니다. 점심 피크, 이벤트 오픈처럼 사용자 수가 변하는 상황을 재현합니다.",
    rampDown:
      "줄이는 방식 — 곡선이 내려갈 때 초과분 사용자를 정리하는 방법입니다. '요청을 마친 뒤'는 안전하지만 약간 늦게 줄고, '즉시'는 곡선에 충실하지만 진행 중이던 요청 1개는 마저 끝납니다.",
    scenario: "시나리오 — 부하를 줄 API 요청 흐름의 정의입니다.",
    step: "스텝 — 부하 중 반복 실행될 HTTP 요청 1개입니다.",
    run: "실행(run) — 시나리오에 부하 설정을 적용해 한 번 돌린 기록입니다.",
    varFlow: "{{변수}} — 흐름 변수. 시나리오 변수·값 추출·데이터셋 바인딩이 채웁니다.",
    varEnv: "${ENV} — 환경 변수. 실행 시 선택한 환경에서 주입됩니다.",
    varSys: "${vu_id} 등 — 시스템 변수. 엔진이 자동으로 채웁니다(가상 사용자 번호 등).",
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
    workerCount: "부하 생성기 워커 수 (수평 확장)",
    workerCountHint: (n: number) => `${n}개 설정됨`,
    httpTimeout: "HTTP 타임아웃(초)",
    loopCap: "루프 집계 상한",
    thinkMin: "think 최소(ms)",
    thinkMax: "think 최대(ms)",
    thinkSeed: "think 시드 (선택)",
    curveTargetVu: "목표 VU",
    curveTargetRps: "목표 RPS",
    curveHintVu: "각 단계가 끝날 때의 목표 동시 사용자 수 (이전 값에서 선형 변화)",
    curveHintRps: "각 단계가 끝날 때의 목표 초당 요청 수 (이전 값에서 선형 변화)",
    curvePreviewAriaVu: "VU 곡선 미리보기 (x: 누적 초, y: VU)",
    curvePreviewAriaRps: "레이트 곡선 미리보기 (x: 누적 초, y: RPS)",
    rampDownLabel: "줄이는 방식",
    rampDownGraceful: "요청을 마친 뒤 줄이기 (권장) — 안전하지만 곡선보다 약간 늦게 줄어듭니다",
    rampDownImmediate: "즉시 줄이기 — 곡선에 충실하지만 진행 중이던 요청 1개는 마저 끝납니다",
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
    workerCount: "워커 수는 1~64 사이 정수여야 합니다.",
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
    scenarios: "시나리오는 부하를 줄 API 요청 흐름입니다. 템플릿에서 시작해 보세요.",
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
  editor: {
    // ── 스텝 설정 패널(구 Inspector) ──
    inspectorAria: "스텝 설정",
    inspectorEmpty: "캔버스에서 스텝을 선택하면 여기서 설정합니다.",
    yamlTabNoInspector: "스텝 설정은 캔버스 탭에서 사용할 수 있습니다.",
    httpPanelTitle: "HTTP 스텝",
    loopPanelTitle: "반복(loop)",
    ifPanelTitle: "조건(if)",
    parallelPanelTitle: "동시 실행(parallel)",
    assertionsLegend: "응답 검증",
    extractsLegend: "값 추출",
    extractsHint: "응답에서 값을 꺼내 다음 스텝에서 {{이름}}으로 사용합니다.",
    // ── URL 필수 표시 (§5.2) ──
    urlLabel: "URL *",
    urlPlaceholder: "https://api.example.com/login 또는 ${BASE_URL}/login",
    urlEmptyWarning: "URL을 입력하세요 — 비어 있으면 요청이 실패합니다.",
    urlMissingBadge: "URL이 비어 있습니다",
    // ── 캔버스 (§5.1) ──
    canvasEmpty: "HTTP 스텝을 추가해 시작하세요. 스텝은 부하 중 반복 실행될 HTTP 요청 1개입니다.",
    addHttpStep: "+ HTTP 스텝",
    addHttpStepInLoop: "+ 반복 안에 HTTP 스텝",
    addLoop: "+ 반복(loop)",
    addIf: "+ 조건(if)",
    addParallel: "+ 동시 실행(parallel)",
    containerCaption: "반복·조건·동시 실행은 HTTP 스텝을 묶는 컨테이너입니다.",
    panelHint: "오른쪽 '스텝 설정' 패널에서 스텝을 설정하세요.",
    // ── 변수 표기 치트시트 (§5.3) ──
    varCheatSheetLabel: "변수 표기 도움말",
    varCheatSheetContext: "변수 표기",
    // ── Variables 패널 (치트시트 부착 표면 동반 정리) ──
    variablesTitle: "변수",
    variablesEmpty: "변수 없음",
    variablesAdd: "추가",
    // ── 새 시나리오 페이지 chrome ──
    create: "만들기",
    creating: "생성 중…",
    cancel: "취소",
    discardConfirm: "저장하지 않은 변경을 버릴까요?",
    // ── 시나리오 문제 요약 배너 (§5.4, U4) ──
    problemsBannerAria: "시나리오 문제 요약",
    problemsBannerTitle: (n: number) => `시나리오 문제 ${n}건`,
    problemEmptyUrl: (stepName: string) =>
      `"${stepName}" 스텝의 URL이 비어 있습니다 — 실행하면 요청이 실패합니다.`,
    problemHostlessUrl: (stepName: string) =>
      `"${stepName}" 스텝의 URL에 호스트가 없습니다 — 전체 URL 또는 \${BASE_URL} 같은 환경 변수로 시작하세요.`,
    problemGateIntro: "YAML이 유효하지 않아 캔버스가 마지막 정상 상태로 표시될 수 있습니다.",
    problemGateAction: "YAML 탭에서 확인",
    gateRequired: (path: string) => `${path}: 필수 항목이 없습니다`,
    gateNameRequired: (path: string) => `${path}: 이름이 비어 있습니다`,
    gateInvalidLiteral: (path: string, expected: string) =>
      `${path}: 값이 올바르지 않습니다 (기대값 ${expected})`,
    gateInvalidType: (path: string, expected: string, received: string) =>
      `${path}: 타입이 올바르지 않습니다 (기대 ${expected}, 입력 ${received})`,
    gateDuplicateBranch: (path: string, name: string) =>
      `${path}: 분기 이름 "${name}"이 중복됩니다`,
    // ── test-run 승격 (§5.5, U4) ──
    testRunNow: "미리 1회 실행",
    testRunNowHelpLabel: "미리 1회 실행 설명",
    testRunNowHelp: "저장 없이 현재 내용으로 실제 요청 1회를 보내 확인합니다.",
  },
  templates: {
    galleryAria: "시나리오 템플릿 선택",
    galleryTitle: "어떤 시나리오로 시작할까요?",
    galleryHint: "선택 후 캔버스·YAML에서 자유롭게 고칠 수 있습니다.",
    blankName: "빈 시나리오",
    blankDesc: "아무것도 없는 상태에서 직접 만듭니다.",
    getName: "단순 GET",
    getDesc: "URL 하나에 GET을 보내는 1스텝 헬스체크 — 가장 단순한 부하 테스트.",
    loginName: "로그인 흐름",
    loginDesc: "로그인(POST) → 토큰 값 추출 → 인증 GET. 값 추출과 {{변수}} 사용법 예시.",
    dataName: "데이터 기반",
    dataDesc:
      "CSV 데이터셋의 행을 {{변수}}로 주입하는 폼 전송 — 실행 시 데이터 바인딩과 함께 씁니다.",
  },
  stepTemplates: {
    // ── 진입점 (에디터 헤더, 두 페이지) ──
    saveButton: "템플릿으로 저장",
    insertButton: "템플릿 삽입",
    gateTooltip: "시나리오 문제를 해결해야 템플릿 기능을 쓸 수 있습니다.",
    // ── 저장 다이얼로그 ──
    saveTitle: "스텝 템플릿으로 저장",
    nameLabel: "이름",
    namePlaceholder: "템플릿 이름",
    descriptionLabel: "설명 (선택)",
    stepsLegend: "담을 스텝",
    unnamedStep: (n: number) => `스텝 ${n}`,
    saveAction: "저장",
    saving: "저장 중…",
    overwriteConfirm: (name: string) => `"${name}" 이름의 템플릿이 이미 있습니다. 덮어쓸까요?`,
    overwriteAction: "덮어쓰기",
    cancel: "취소",
    // ── 삽입 모달 ──
    insertTitle: "스텝 템플릿 삽입",
    empty: '저장된 템플릿이 없습니다. 에디터 헤더의 "템플릿으로 저장"으로 만드세요.',
    insertAction: "삽입",
    deleteAction: "삭제",
    deleteConfirm: (name: string) => `템플릿 "${name}"을(를) 삭제할까요?`,
    incompatible: "이 템플릿은 에디터 규칙과 호환되지 않습니다",
    stepCount: (n: number) => `스텝 ${n}개`,
    typeLabel: {
      http: "HTTP",
      loop: "반복",
      if: "조건",
      parallel: "동시 실행",
    } as Record<string, string>,
  },
  report: {
    // §7.1 쉬운 요약 — 매개변수 문구는 함수 상수(spec §2.1). 숫자는 호출부에서
    // en-US toLocaleString으로 고정(천단위 콤마 결정성 — InsightPanel 전례).
    headlineClosed: (p: {
      duration: string;
      vus: number;
      count: string;
      p95: string;
      errPct: string;
    }) =>
      `${p.duration} 동안 동시 사용자 ${p.vus}명이 ${p.count}회 요청 — 95%가 ${p.p95} 안에 응답, 에러 ${p.errPct}`,
    headlineOpenFixed: (p: {
      duration: string;
      targetRps: number;
      count: string;
      p95: string;
      errPct: string;
    }) =>
      `${p.duration} 동안 목표 ${p.targetRps} RPS로 ${p.count}회 요청 — 95%가 ${p.p95} 안에 응답, 에러 ${p.errPct}`,
    headlineOpenCurve: (p: { duration: string; count: string; p95: string; errPct: string }) =>
      `${p.duration} 동안 단계별 RPS 곡선으로 ${p.count}회 요청 — 95%가 ${p.p95} 안에 응답, 에러 ${p.errPct}`,
    headlineClosedCurve: (p: { duration: string; count: string; p95: string; errPct: string }) =>
      `${p.duration} 동안 단계별 VU 곡선으로 ${p.count}회 요청 — 95%가 ${p.p95} 안에 응답, 에러 ${p.errPct}`,
    headlineNoRequests: "요청이 기록되지 않았습니다 — 시나리오 URL과 워커 상태를 확인하세요.",
    headlineAria: "쉬운 요약",
    verdictPass: "합격",
    verdictFail: "불합격",
    sloHint: "합격 기준(SLO)을 설정하면 다음 실행부터 합격/불합격을 자동 판정합니다.",
    failReasonTitle: "미달 기준",
    // §7.2 결과 표면 라벨 (Summary 카드 + 표 헤더 3종)
    cardTotalRequests: "총 요청",
    cardErrors: "에러",
    cardAvgRps: "평균 RPS",
    cardDuration: "테스트 시간",
    cardTargetRps: "목표 RPS",
    cardDropped: "드롭",
    colStep: "스텝",
    colMethod: "메서드",
    colRequests: "요청 수",
    colErrors: "에러",
    colCount: "횟수",
    colParallelNode: "동시 실행 노드 / 분기",
    colIfNode: "조건(if) 노드",
    colDecisions: "분기 결정 수",
    colBranch: "분기",
    colDecisionsInner: "결정 수",
    activeVuTitle: "활성 VU (시간별)",
    activeVuDesired: "목표",
    activeVuActual: "실제",
  },
  runDetail: {
    // §7.4 영영-running 갭의 UI 측 완화(갭 자체 수정은 범위 밖)
    stalledRunning:
      "워커가 시작하지 못했을 수 있습니다 — 시나리오 URL과 컨트롤러 로그를 확인하세요.",
    elapsed: (d: string) => `경과 ${d}`,
  },
  // §7.3 인사이트 kind → "다음 행동" 한 줄 (slo_pass는 의도적 부재 — 행동 없음).
  insightActions: {
    slowest_step: "이 API가 병목입니다 — 스텝 표를 내보내 개발팀과 공유하세요.",
    error_hotspot: "이 스텝의 응답 검증 조건과 서버 로그를 확인하세요.",
    no_request_step: "이 스텝에 요청이 없었습니다 — 조건 분기·시나리오 구조를 확인하세요.",
    status_class: "4xx면 요청 형식(인증·파라미터), 5xx면 서버 측 문제부터 확인하세요.",
    status_temporal: "테스트 후반 5xx 증가 — 서버 자원 고갈 의심. 더 긴 soak 테스트를 고려하세요.",
    slo_failure: "미달 기준 행을 확인하고 임계값과 서버 성능 중 무엇을 조정할지 정하세요.",
    load_gen_saturated:
      "에러·지연(latency)이 함께 높으면 대상 서버의 한계, 아니면 테스트 도구(워커 CPU·동시 실행 수 max_in_flight)를 늘려 다시 실행하세요.",
  },
  // 사이징 권장(load_gen_saturated cause 분기). 조사 병기((으)로 등, ADR-0035).
  saturation: {
    slots: (rec: string) =>
      `동시 실행 수(max_in_flight)가 목표에 비해 작아요 — 최소 ~${rec}(으)로 올려 다시 실행하세요. ` +
      `(에러·지연이 함께 높으면 대상 서버가 한계라 슬롯만 늘려선 처리량이 안 늘 수 있어요.)`,
    loadgen:
      `동시 실행 수(max_in_flight)는 충분했어요 — 부하 생성기(워커)가 한계로 보여요. ` +
      `worker_count를 늘리면 더 높은 RPS를 낼 수 있어요. ` +
      `(단 에러·지연이 함께 높아지면 대상 서버 한계일 수 있어요.)`,
    loadgenWithWorkers: (m: number) =>
      `동시 실행 수(max_in_flight)는 충분했어요 — 부하 생성기(워커)가 한계로 보여요. ` +
      `worker_count를 ~${m}개로 올려 다시 실행하세요. ` +
      `(단 에러·지연이 함께 높아지면 대상 서버 한계라 워커를 늘려도 무익할 수 있어요.)`,
    sut:
      `동시 실행 수(max_in_flight)는 충분했어요 — 대상 서버(SUT)가 한계로 보여요(에러·지연 상승). ` +
      `워커·슬롯을 늘려도 지속 RPS는 안 올라요. 서버 용량·설정을 점검하세요.`,
  },
  // 열린 루프 생성 시점 슬롯 사이징 헬퍼. 조사 병기((으)로 등) — 변수 뒤 조사 고정 금지(ADR-0035).
  slotSizing: {
    title: "동시 요청 수(슬롯) 도우미",
    helpLabel: "슬롯 사이징 도우미 설명",
    help: "목표 RPS를 내려면 동시 요청 상한(max_in_flight)을 몇으로 잡아야 하는지 추정해 드려요. 너무 낮으면 요청이 버려져요(drop). 권장값은 최소 출발점이에요.",
    estMs: "예상 평균 응답시간(ms)",
    measureBtn: "test-run으로 측정",
    measuring: "측정 중…",
    measureCaveat:
      "방금 측정은 부하 없는 1회 실행이라 실제보다 빨라요. 부하가 걸리면 더 느려져 슬롯이 더 필요할 수 있어, 이 권장값은 최소 출발점이에요.",
    truncated: "시나리오가 길어 측정이 잘렸어요 — 예상 응답시간을 직접 입력하세요.",
    measureError: "측정에 실패했어요. 환경 변수(${BASE_URL} 등)와 시나리오를 확인하세요.",
    fromPriorRun: (mean: number) => `지난 실행 평균 응답시간(${mean}ms) 기준 추정이에요.`,
    measured: (req: number, ms: number) => `측정됨: 요청 ${req}개 · 평균 ${ms}ms`,
    recommend: (n: number) => `max_in_flight를 최소 ~${n}(으)로 설정하세요`,
    formula: (targetRps: number, latencyMs: number, n: number) =>
      `목표 ${targetRps} RPS × 지연 ${latencyMs}ms ≈ 동시 ${n}슬롯`,
    apply: "적용",
    needTarget: "위에서 목표 RPS를 먼저 입력하세요.",
    cannotCompute: "응답시간 정보가 없어요 — 예상 응답시간을 입력하거나 test-run으로 측정하세요.",
    overCapacity:
      "권장값이 단일 워커 슬롯 상한(10,000)을 넘어요 — 목표 RPS를 낮추거나 워커를 늘려야 합니다.",
    formulaPeak: (targetRps: number, latencyMs: number, n: number) =>
      `최고 단계 목표 ${targetRps} RPS × 지연 ${latencyMs}ms ≈ 동시 ${n}슬롯`,
    needTargetCurve: "단계 목표를 먼저 입력하세요.",
  },
  // 열린 루프 create-time worker_count 사이징(ADR-0038). 조사 병기((으)로 등) — 변수 뒤 조사 고정 금지(ADR-0035).
  workerSizing: {
    title: "워커 수 도우미",
    helpLabel: "워커 수 사이징 설명",
    help: "워커 한 대가 낼 수 있는 최대 RPS는 요청 지연·페이로드·대상 서버에 따라 달라 고정값이 없어요. 그래서 한 번 돌려 워커가 한계에 부딪힐 때(드롭 발생) 비로소 정확히 알 수 있어요.",
    strongBasis: (wc: number, peak: number, dropped: number) =>
      `지난 run이 워커 ${wc}대로 최대 ${peak} RPS에서 요청이 밀렸어요(드롭 ${dropped}) → 워커당 ~${Math.round(
        peak / wc,
      )} RPS가 한계예요.`,
    weakBasis: (wc: number, peak: number) =>
      `지난 run은 워커 ${wc}대로 ${peak} RPS를 드롭 없이 냈어요 — 한계까진 안 밀어서 워커당 진짜 천장은 아직 몰라요.`,
    recommend: (n: number) => `목표엔 워커 ~${n}대가 필요해요.`,
    recommendPeak: (n: number) => `최고 단계 목표엔 워커 ~${n}대가 필요해요.`,
    weakRecommend: (n: number) =>
      `보수적으로 ~${n}대를 제안해요 (여유가 있었다면 더 적어도 됩니다).`,
    weakHint: "정확히 줄이려면 더 높은 목표로 한 번 돌려 드롭이 날 때까지 포화시켜 보세요.",
    noBasis:
      "참고할 종료된 열린 루프 run이 없어요. 1대로 시작하고, 리포트에 드롭(밀린 요청)이 보이면 그 권장값만큼 늘리세요.",
    apply: "적용",
    overCap: (n: number) =>
      `권장 ${n}대가 상한(64)을 넘어요 — 64대로도 목표에 못 미칠 수 있어요. 목표를 낮추거나 워커당 부하(payload·지연)를 점검하세요.`,
    needMaxInFlight: (n: number, cur: number) =>
      `worker_count는 max_in_flight 이하여야 해요 — max_in_flight도 최소 ${n}(으)로 함께 올리세요 (현재 ${cur}).`,
  },
  // 닫힌 루프 생성 시점 VU 사이징 헬퍼. 조사 병기((으)로 등) — 변수 뒤 조사 고정 금지(ADR-0035).
  sizing: {
    title: "VU 사이징 도우미",
    helpLabel: "VU 사이징 도우미 설명",
    help: "목표 RPS를 입력하면 필요한 동시 사용자(VU) 수를 추정해 드려요. 권장값은 최소 출발점이에요.",
    targetRps: "목표 RPS",
    estMs: "1회 반복 예상 지연(ms)",
    measureBtn: "test-run으로 측정",
    measuring: "측정 중…",
    measureCaveat:
      "방금 측정은 부하 없는 1회 실행이라 실제보다 빨라요. 부하가 걸리면 더 느려질 수 있어, 이 권장값은 최소 출발점이에요.",
    truncated: "시나리오가 길어 측정이 잘렸어요 — 1회 반복 지연을 직접 입력하세요.",
    measureError: "측정에 실패했어요. 환경 변수(${BASE_URL} 등)와 시나리오를 확인하세요.",
    fromPriorRun: (vus: number, rps: number) =>
      `지난 실행(VU ${vus}개 → ${rps} RPS) 기준 추정이에요. 목표를 바꾸면 권장 VU가 함께 바뀌어요.`,
    measured: (req: number, ms: number) => `측정됨: 1회 반복에 요청 ${req}개 · ${ms}ms`,
    recommend: (n: number) => `권장 VU: 최소 ~${n}개부터`,
    apply: "적용",
    cannotCompute: "처리량 정보가 없어요 — 1회 반복 지연을 입력하거나 test-run으로 측정하세요.",
    overCapacity: "이 값은 워커 용량(기본 2,000)을 넘을 수 있어요.",
  },
} as const;
