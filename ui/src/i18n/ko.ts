/**
 * UI 한국어 메시지 카탈로그 (ADR-0035).
 * - 모든 사용자 노출 문구(본문·버튼·표 헤더·placeholder·aria-label·title·배너)는 이 카탈로그 경유다 — 인라인 영어/한국어 금지. (기술 고유명사 VU/RPS/p95/YAML/URL 등은 원어 유지 + 설명 병기.)
 * - i18n 라이브러리 없음 — 나중에 en.ts + 컨텍스트 스위치를 더할 수 있는 구조만 유지.
 * - 용어 정의(glossary)는 전 화면 HelpTip의 단일 소스 — 화면마다 설명이 달라지면 안 된다.
 */
export const ko = {
  // 크로스커팅 UI 동작/상태 — 의미가 어디서나 동일한 것만(ADR-0035, spec R2).
  // 도메인 한정 라벨(Name/Method/VUs/표 헤더 등)은 여기 두지 말고 도메인 네임스페이스로.
  common: {
    loading: "불러오는 중…",
    loadingRuns: "실행 목록 불러오는 중…",
    failedToLoad: (msg: string) => `불러오기 실패: ${msg}`,
    notFound: "찾을 수 없습니다.",
    save: "저장",
    saving: "저장 중…",
    cancel: "취소",
    close: "닫기",
    delete: "삭제",
    edit: "편집",
    add: "추가",
    remove: "제거",
    moveUp: "위로",
    moveDown: "아래로",
    abort: "중단",
    aborting: "중단 중…",
    parsing: "분석 중…",
    removeItemAria: (label: string, key: string) => `${label} ${key} 제거`,
    newItemKeyAria: (label: string) => `새 ${label} 키`,
    newItemValueAria: (label: string) => `새 ${label} 값`,
  },
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
    // ── EnvironmentPicker 라벨/aria ──
    envVarsRegion: "환경 변수",
    envSelectAria: "환경 선택",
    envNewKeyAria: "새 환경 변수 키",
    envNewValueAria: "새 환경 변수 값",
    envKeyAria: (idx: number) => `환경 변수 키 ${idx}`,
    envValueAria: (idx: number) => `환경 변수 값 ${idx}`,
    envRemoveAria: (key: string) => `${key} 환경변수 제거`,
    envNoVars: "환경 변수 없음",
    envBaseNoVars: "이 환경엔 변수가 없습니다",
    envHeading: "환경 변수",
    envHeadingOverride: "이 run 한정 재정의",
    envOverrideBtn: "재정의",
    envOverriddenLabel: "재정의됨",
    envShadowsBase: (key: string) => `${key} 재정의`,
    envBaseFrom: (name: string) => `${name} 기반 (읽기 전용):`,
    loadPresetAria: "프리셋 불러오기",
    presetNameAria: "프리셋 이름",
  },
  binding: {
    sectionTitle: "데이터 바인딩",
    addDataset: "데이터셋 추가",
    removeBinding: (n: number) => `바인딩 ${n} 제거`,
    cardLabel: (n: number) => `바인딩 ${n}`,
    rowCount: (n: number) => `${n}행`,
    // 카드 접힘 시 설정 요약(데이터셋명 또는 매핑 수). 비어 있으면 "미설정".
    collapsedUnset: "미설정",
    collapsedSummary: (dataset: string, mappingCount: number) =>
      `${dataset} · 매핑 ${mappingCount}개`,
    // 교차-카드 변수명 중복 경고 (클라이언트 측 — 최종 400은 서버가 낸다, Task 5와 동일 문구).
    dupVar: (name: string) => `변수 '${name}'이 여러 데이터셋에 중복 매핑됨`,
    datasetLabel: "데이터셋",
    policyLabel: "정책",
    mappingVarNameAria: "매핑 변수명",
    sourceForAria: (v: string) => `${v || "변수"} 소스`,
    literalForAria: (v: string) => `${v || "변수"} 리터럴 값`,
    removeMappingAria: (v: string | number) => `${v} 매핑 제거`,
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
    settings: "운영 상한",
    stepTemplates: "스텝 템플릿",
    workers: "워커",
  },
  capacityGuard: {
    // bespoke createRun error (shown as a banner in non-RunDialog callers)
    shortError: (achievable: number) => `풀 용량이 부족합니다 (가용 ${achievable} VU)`,
    // RunDialog preview + confirm dialog (closed-loop)
    totalCapacity: (vus: number) => `총 용량 ${vus} VU`,
    overHint: (achievable: number) =>
      `요청 VU가 풀 용량 ${achievable} VU를 초과합니다 — 줄이거나 강행하세요`,
    // open-loop preview hint (max_in_flight > idle capacity)
    overHintOpen: (achievable: number) =>
      `동시 요청 수(슬롯)가 풀 용량 ${achievable} VU를 초과합니다 — 줄이거나 강행하세요`,
    dialogTitle: "풀 용량 부족",
    // closed-loop dialog body
    dialogBody: (achievable: number, requested: number) =>
      `요청한 ${requested} VU는 현재 풀 용량 ${achievable} VU를 초과합니다.`,
    // open-loop dialog body (slots, not VUs)
    dialogBodyOpen: (achievable: number, requested: number) =>
      `요청한 동시 요청 수 ${requested}가 현재 풀 용량 ${achievable} VU를 초과합니다.`,
    // guidance note shown in open-loop 409 dialog
    clampNoteOpen:
      "동시 슬롯만 줄입니다 — 목표 RPS는 유지되어 드롭이 늘 수 있어요(포화 시 워커를 늘리세요).",
    clamp: (achievable: number) => `${achievable} VU로 줄여 진행`,
    // open-loop reduce button label (slots, not VUs)
    clampOpen: (achievable: number) => `동시 요청 ${achievable}개로 줄여 진행`,
    force: "용량 무시하고 강행",
    cancel: "취소",
    // L5 곡선(VU curve) 변형 — 줄여 진행=곡선 비례 축소, 강행=과부하.
    dialogBodyCurve: (achievable: number, requested: number) =>
      `연결된 풀 워커 용량은 ${achievable} VU인데 설정한 곡선 최고점은 ${requested} VU입니다. ` +
      `이 부하를 어떻게 발생시킬지 선택하세요.`,
    clampNoteCurve: (achievable: number, requested: number) =>
      `[줄여서 발생] 곡선을 ${achievable}/${requested}배로 축소 → 최고점 ${achievable} VU·각 단계가 비례로 낮아집니다(설정보다 낮은 부하). ` +
      `[그대로 강행] 워커가 과부하되어 실제 발생 부하가 목표(${requested} VU)에 못 미칠 수 있습니다.`,
    clampCurve: (achievable: number) => `줄여서 발생 (최고점 ${achievable} VU로 축소)`,
    overHintCurve: (cap: number) =>
      `곡선 최고점이 풀 유휴 용량 ${cap} VU를 초과합니다 — 실행 시 줄이거나 강행을 선택하게 됩니다.`,
  },
  workers: {
    title: "연결된 워커",
    subtitle: "풀 모드 컨트롤러에 연결된 LAN 워커",
    colHostname: "호스트",
    colWorkerId: "워커 ID",
    colStatus: "상태",
    colCapacity: "용량(VU)",
    statusIdle: "유휴",
    statusBusy: "실행 중",
    countSummary: (idle: number, busy: number) => `유휴 ${idle} · 실행 중 ${busy}`,
    emptyNotPool:
      "이 컨트롤러는 풀 모드가 아닙니다. 풀 모드로 실행하면 연결된 워커가 여기 표시됩니다.",
    emptyNoWorkers: "연결된 워커가 없습니다. 각 PC에서 워커를 풀 모드로 기동하세요.",
    runbookHint: "설정 방법: 운영 런북(docs/dev/lan-workers.md) 참고",
    loadError: "워커 목록을 불러오지 못했습니다.",
    poolPreview: (idle: number) =>
      `연결된 유휴 워커 ${idle}대 — 이 run은 유휴 워커에 분산 실행됩니다(use-all).`,
    colLastSeen: "마지막 응답",
    secsAgo: (n: number) => `${n}초 전`,
    stale: "응답 없음",
    // actions
    actionsLabel: "동작",
    drain: "비우기",
    undrain: "되돌리기",
    exclude: "제외",
    editCapacity: "용량 조정",
    editLabel: "메모",
    // badges / columns
    drainedBadge: "비우는 중",
    colLabel: "메모",
    capacityManual: (n: number) => `${n} (수동)`,
    // drain confirm (reversible)
    drainConfirmTitle: "워커 비우기",
    drainConfirmBody:
      "이 워커에 새 작업 배정을 중단합니다. 진행 중인 작업은 그대로 끝까지 실행되고, 언제든 '되돌리기'로 복구할 수 있습니다.",
    // exclude confirm (destructive)
    excludeConfirmTitle: "워커 제외",
    excludeConfirmBody:
      "이 워커를 풀에서 제외하고 워커 프로그램을 종료합니다. 다시 추가하려면 해당 PC에서 워커를 직접 재실행해야 합니다.",
    excludeBusyWarn: (runId: string) =>
      `주의: 이 워커는 현재 run ${runId}을(를) 실행 중입니다. 제외하면 그 run이 실패합니다.`,
    // edit modals (apply note)
    capacityApplyNote: "변경한 용량은 새 run의 부하 배분 계산에 즉시 반영됩니다.",
    labelApplyNote: "메모는 표시용이며 부하에는 영향이 없습니다.",
    confirmProceed: "계속",
    cancel: "취소",
    apply: "적용",
    // mutation error feedback
    actionError: (msg: string) => `작업 실패: ${msg}`,
    bannerDismiss: "닫기",
    pending: "처리 중…",
    // preview note for drained workers in RunDialog
    poolPreviewDrained: (n: number) => `(비우는 중 ${n}대 제외)`,
    // ephemeral (non-stable) worker — control state not durable across controller restart
    ephemeralBadge: "일시적",
    ephemeralHint:
      "이 워커는 안정 id가 없어 컨트롤러 재시작 시 이 설정이 유지되지 않습니다. 유지하려면 워커를 '--worker-id'로 기동하세요.",
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
    stepTemplates: '저장된 스텝 템플릿이 없습니다. 에디터 헤더의 "템플릿으로 저장"으로 만드세요.',
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
    editStepTemplate: "스텝 템플릿 편집",
    runsBtn: "실행 목록",
    duplicateBtn: "복제",
    duplicatingBtn: "복제 중…",
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
    assertStatusField: "상태",
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
    problemUrlNeedsScheme: (stepName: string) =>
      `"${stepName}" 스텝의 URL은 http:// 또는 https:// 로 시작해야 합니다 — 예: https://api.example.com/path 또는 \${BASE_URL}/path`,
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
    gateInvalidChoice: (path: string, allowed: string) =>
      `${path}: 값이 올바르지 않습니다 (허용: ${allowed})`,
    gateInvalidChoiceReceived: (path: string, allowed: string, received: string) =>
      `${path}: 값이 올바르지 않습니다 (허용: ${allowed}, 입력 ${received})`,
    gateUnknownKeys: (path: string, keys: string) =>
      `${path}: 알 수 없는 항목이 있습니다 (${keys})`,
    gateEmptyValue: (path: string) => `${path}: 값이 비어 있습니다`,
    gateLoopBodyMin: (path: string) => `${path}: 루프 본문에 스텝이 최소 1개 필요합니다`,
    gateIfBranchMin: (path: string) => `${path}: if 분기에 스텝이 최소 1개 필요합니다`,
    gateElifBranchMin: (path: string) => `${path}: elif 분기에 스텝이 최소 1개 필요합니다`,
    gateParallelBranchesMin: (path: string) =>
      `${path}: parallel 노드에 분기가 최소 1개 필요합니다`,
    gateBranchStepsMin: (path: string) => `${path}: 분기에 스텝이 최소 1개 필요합니다`,
    gateRepeatMin: (path: string) => `${path}: 반복 횟수는 1 이상이어야 합니다`,
    // ── Inspector 필드 라벨 ──
    fieldName: "이름",
    fieldMethod: "메서드",
    fieldTimeout: "타임아웃 (초)",
    fieldThinkMin: "think 최솟값 (ms)",
    fieldThinkMax: "think 최댓값 (ms)",
    fieldRepeat: "반복 횟수",
    // ── Inspector 섹션 범례·라벨 ──
    requestLegend: "요청",
    headersLabel: "헤더",
    headerKeyPlaceholder: "헤더 이름",
    headerNamePlaceholder: "헤더 이름",
    cookieNamePlaceholder: "쿠키 이름",
    bodyLabel: "본문",
    bodyNone: "없음",
    bodyJson: "JSON",
    bodyForm: "폼",
    bodyRaw: "원문",
    bodyStepsLabel: "본문 스텝",
    branchesLabel: "분기",
    conditionLegend: "조건",
    // ── Inspector 빈 상태 ──
    noAssertions: "검증 없음",
    noExtracts: "추출 없음",
    noSteps: "스텝 없음",
    noExtraField: "추가 필드 없음",
    noHeaders: "헤더 없음",
    noFormFields: "필드 없음",
    // ── Inspector think time 도움말 ──
    thinkHint: "min=max면 고정 지연 (요청 후 대기)",
    // ── Inspector JSON 바디 ──
    jsonBodyAria: "JSON 본문",
    formatButton: "포맷",
    // ── Inspector 삭제 대상 title ──
    deleteStep: "스텝 삭제",
    deleteLoop: "반복 삭제",
    deleteIf: "조건 삭제",
    deleteParallel: "동시 실행 삭제",
    // ── Inspector 조건 빌더 ──
    condAll: "ALL (AND)",
    condAny: "ANY (OR)",
    condThen: "Then",
    condElse: "Else",
    addCondition: "+ 조건",
    addGroup: "+ 그룹",
    wrapInGroup: "그룹으로 묶기",
    removeCondition: "조건 제거",
    // ── Inspector 분기(elif/branch) ──
    elifLabel: (n: number) => `Elif ${n}`,
    branchLabel: (n: number) => `분기 ${n}`,
    // ── Inspector 추가/제거 동작 (보간 aria) ──
    addStep: "+ 스텝 추가",
    addBranch: "+ 분기 추가",
    addElif: "+ Elif 추가",
    addStepInBranch: "+ 스텝 추가",
    addLoopInBranch: "+ 반복 추가",
    addStepToLabel: (label: string) => `${label}에 스텝 추가`,
    addLoopToLabel: (label: string) => `${label}에 반복 추가`,
    addStepToLoopBody: "반복 본문에 스텝 추가",
    addIfToLoopBody: "반복 본문에 조건 추가",
    removeBranch: (n: number) => `분기 ${n} 제거`,
    removeAssertion: (n: number) => `검증 ${n} 제거`,
    removeExtract: (n: number) => `추출 ${n} 제거`,
    removeElif: (n: number) => `Elif ${n} 제거`,
    tabCanvas: "캔버스",
    tabYaml: "YAML",
    testRunTitle: "시나리오 미리 테스트",
    testRunResultTitle: "미리 테스트 결과",
    testRunIntro:
      "저장·부하 없이 현재 내용으로 요청을 1회 보내 동작을 확인합니다. 실제 부하 실행은 시나리오를 저장한 뒤 '실행 목록'에서 합니다.",
    testRunThinkTime: "think time 적용 (천천히 전송)",
    testRunControlsAria: "미리 실행 컨트롤",
    testRunResultAria: "미리 실행 결과",
    testRunRunning: "실행 중…",
    testRunRun: "미리 실행",
    testRunOk: "성공",
    testRunFail: "실패",
    testRunMaxRequests: "최대 요청 수",
    extractVarNameAria: "추출 변수명",
    condGroupKindAria: "그룹 조건 종류",
    condLeftAria: "조건 왼쪽 값",
    condLeftPlaceholder: "왼쪽",
    condOpAria: "조건 연산자",
    condRightAria: "조건 오른쪽 값",
    condRightPlaceholder: "오른쪽",
    branchNameAria: (n: number) => `분기 ${n} 이름`,
    extractFromAria: (n: number) => `추출 ${n} 종류`,
    removeVariableAria: (key: string) => `${key} 변수 제거`,
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
    // ── 삽입 시 파라미터화 ──
    paramTitle: "변수 조정 후 삽입",
    paramIntro:
      "이 템플릿의 변수를 대상 시나리오에 맞게 조정할 수 있습니다. 기본값은 모두 그대로 유지입니다.",
    flowSection: "흐름 변수 {{ }}",
    envSection: "환경 변수 ${ }",
    optKeep: "그대로 유지",
    optRename: "다른 이름으로",
    optLiteral: "값으로 교체",
    renamePlaceholder: "새 변수명",
    literalPlaceholder: "리터럴 값",
    renameHintLabel: "대상 시나리오의 기존 변수",
    saveFailed: (msg: string) => `저장 실패: ${msg}`,
    renameAria: (name: string) => `${name} 새 변수명`,
    literalAria: (name: string) => `${name} 리터럴 값`,
    badRename: "변수명에 공백/중괄호/콜론을 쓸 수 없습니다",
    confirmInsert: "삽입",
    back: "뒤로",
    typeLabel: {
      http: "HTTP",
      loop: "반복",
      if: "조건",
      parallel: "동시 실행",
    } as Record<string, string>,
    // ── 관리 페이지 ──
    colName: "이름",
    colSteps: "스텝 수",
    colDescription: "설명",
    colUpdated: "수정",
    colActions: "",
    editAction: "편집",
    previewLegend: "스텝 미리보기",
    save: "저장",
    saveProgress: "저장 중…",
    loadFailed: (msg: string) => `불러오기 실패: ${msg}`,
    deleteFailed: (msg: string) => `삭제 실패: ${msg}`,
  },
  report: {
    // §7.0 리포트 공통 UI 표면 (R2: 도메인 라벨은 여기)
    // ── 섹션 제목/aria-label ──
    summaryLabel: "리포트 요약",
    summaryTitle: "요약",
    statusCodesTitle: "상태 코드",
    statusDistributionLabel: "상태 코드 분포",
    latencyTitle: "지연",
    latencyHistogramLabel: "지연 분포",
    latencyDistTitle: "지연 분포",
    latencyPercentileCurveLabel: "지연 분위 곡선",
    pageLoadLatencyLabel: "페이지 로드 지연",
    pageLoadLatencyTitle: "페이지 로드 지연",
    perStepStatsLabel: "스텝별 통계",
    stepsHeading: "스텝",
    // ── 연결 비용 (transaction breakdown) ──
    connectionLabel: "연결 비용",
    connectionReuse: "연결 재사용률",
    connectionsOpened: "새로 연 연결",
    connectionUnitCount: "개",
    connectionDns: "DNS 조회",
    connectionConnect: "connect (TCP+TLS)",
    connectionPercentiles: (p50: number, p95: number) => `p50 ${p50}ms · p95 ${p95}ms`,
    connectionBeginner: (opened: number) =>
      `요청을 ${opened}개 연결로 처리했어요. 재사용률이 높을수록 연결 오버헤드가 줄어 좋습니다.`,
    connectionHelp:
      "DNS·TCP·TLS는 연결을 새로 맺을 때만 듭니다. keep-alive로 연결을 재사용하면 그 다음 요청들은 이 비용이 0이라, 요청당 평균이 아니라 연결 단위로 모아서 보여줍니다.",
    connectionReuseHelp:
      "재사용률이 낮으면(90% 미만) keep-alive가 꺼졌거나 서버가 연결을 끊는 것일 수 있어요.",
    connectionDnsHelp: "DNS 조회가 느리면 리졸버나 네임서버가 느린 것입니다.",
    // ── 스텝별 단계 분해 (wait/download) ──
    phaseWait: "대기(서버)",
    phaseDownload: "다운로드",
    phaseWaitHelp:
      "대기 = 요청을 보내고 첫 바이트가 올 때까지 = 거의 서버 처리 시간. 대기가 길면 서버가 느린 것이니 에러율·상태 코드 분포를 함께 보세요.",
    phaseCaveat: "응답(TTFB)=요청~헤더, 다운로드=본문 수신. 합 ≠ 전체(퍼센타일 비가산).",
    phaseViewWaterfall: "막대",
    phaseViewChips: "칩",
    phaseViewToggleLabel: "스텝 분해 보기 방식",
    branchDecisionsLabel: "분기 결정",
    branchDecisionsTitle: "분기 결정",
    scenarioSnapshotLabel: "시나리오 스냅샷",
    scenarioSnapshotButton: "시나리오 YAML (실행 당시 스냅샷)",
    reportTitle: "리포트",
    // ── 빈 상태 ──
    noStatusData: "상태 코드 데이터가 없습니다.",
    noLatencyData: "지연 데이터가 없습니다.",
    // ── 시계열 차트 제목 (ReportView에서 title=로 전달) ──
    timeSeriesRequests: "초당 요청 수 (RPS)",
    timeSeriesP95: "p95 응답 시간 (ms)",
    timeSeriesErrors: "초당 에러",
    // ── 시계열 aria-label (보간) ──
    timeSeriesAria: (title: string) => `시계열 — ${title}`,
    // ── 표 헤더 (run 목록 열) ──
    colStatus: "상태",
    colVus: "VU",
    vusCurvePeak: (n: number) => `최대 ${n} (곡선)`,
    vusOpenHint: "VU 해당 없음 — 열린 루프(RPS·슬롯 기반)",
    colDuration: "테스트 시간",
    colCreated: "생성 시각",
    colName: "이름",
    colSecond: "초",
    colStatusCodes: "상태 코드",
    // ── 토글 루프/분기 분해 aria ──
    toggleLoopBreakdown: (name: string) => `${name} 루프 분해 표시 전환`,
    toggleBranchBreakdown: (name: string) => `${name} 분기 분해 표시 전환`,
    // ── InsightPanel 섹션 aria ──
    insightsLabel: "인사이트",
    // ── VerdictPanel 섹션 aria + 표 헤더 ──
    verdictSectionLabel: "SLO 판정",
    verdictMetric: "지표",
    verdictThreshold: "기준",
    verdictActual: "실측값",
    verdictResult: "결과",
    // ── TestRunPanel 헤더 제목 ──
    requestHeadersTitle: "요청 헤더",
    responseHeadersTitle: "응답 헤더",
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
    activeVuViewTotal: "합계",
    activeVuViewByWorker: "워커별",
    activeVuViewToggleLabel: "VU 곡선 보기 방식",
    activeVuWorkerLabel: (n: number) => `워커 ${n}`,
    activeVuFanout: (n: number) => `${n}개 워커로 분산 실행`,
    selectRunAria: (id: string) => `실행 ${id} 선택`,
    verdictSloTitle: "SLO",
    colMaxMs: "최대 ms",
  },
  runDetail: {
    // §7.4 영영-running 갭의 UI 측 완화(갭 자체 수정은 범위 밖)
    stalledRunning:
      "워커가 시작하지 못했을 수 있습니다 — 시나리오 URL과 컨트롤러 로그를 확인하세요.",
    midRunStall: (d: string) => `⚠ ${d} 진행 없음 — 워커가 멈췄을 수 있어요`,
    elapsed: (d: string) => `경과 ${d}`,
    // ── 카드 라벨 (R2: 도메인 한정) ──
    cardVus: "VU",
    cardDuration: "테스트 시간",
    cardTotalRequests: "총 요청 수",
    cardErrors: "에러",
    cardAvgRps: "평균 RPS",
    cardCreated: "생성 시각",
    // ── 섹션 제목/aria-label ──
    profileLabel: "프로필",
    profileTitle: "프로필",
    profileVuStages: (peak: number, count: number) => `최대 ${peak} · ${count}단계`,
    stepsLabel: "스텝",
    stepsTitle: "스텝",
    envLabel: "환경 변수",
    envTitle: "환경 변수",
    metricWindowsTitle: "메트릭 윈도우",
    colName: "이름",
    colRequests: "요청 수",
    colErrors: "에러",
    // ── 빈 상태 ──
    noMetrics: "기록된 메트릭이 없습니다.",
    waitingFirstBatch: "첫 배치 대기 중…",
    noEnvSent: "전송된 환경 변수가 없습니다.",
    // ── 인라인 혼합 문구 (인라인 한국어·영어 혼합 카탈로그화) ──
    failReason: "실패 사유",
    reportLoadFailed: "리포트 로드 실패",
    reportGenerating: "리포트 생성 중…",
    // ── h2 Run 제목 ──
    heading: "실행",
  },
  runStall: {
    badge: "정지 의심",
    badgeTitleMidrun: (d: string) => `${d} 진행 없음 — 워커가 멈췄을 수 있어요`,
    badgeTitleStartup: "부하 시작 전 — 워커가 멈췄을 수 있어요",
  },
  // 비교 화면 인사이트 매트릭스(kind×run). 행 = 인사이트, 열 = run.
  insightCompare: {
    title: "인사이트 비교",
    colInsight: "인사이트",
    empty: "감지된 인사이트가 없습니다.",
    // 배지 심각도 라벨(엔진 critical/warning/info → 한국어). 색 단독 의존 회피(a11y).
    severity: { critical: "심각", warning: "경고", info: "정보" },
  },
  // 인사이트 kind → 짧은 라벨(매트릭스 행 머리). InsightPanel.message()의 산문과 별개.
  insightLabels: {
    slowest_step: "가장 느린 스텝",
    error_hotspot: "에러 핫스팟",
    no_request_step: "요청 없는 스텝",
    slo_failure: "SLO 실패",
    slo_pass: "SLO 통과",
    status_class: "상태 코드 비율",
    status_temporal: "후반 5xx 등장",
    load_gen_saturated: "부하 생성기 포화",
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
  dataset: {
    uploadAria: "데이터셋 업로드",
    chooseFileSr: "파일 선택",
    chooseFileAria: "파일 선택",
    nameLabel: "이름",
    headerLabel: "헤더",
    delimiterLabel: "구분자",
    encodingLabel: "인코딩",
    sheetLabel: "시트",
    colName: "이름",
    colColumns: "컬럼",
    colRows: "행",
    saveDataset: "데이터셋 저장",
    listAria: "데이터셋 목록",
    optionAuto: "자동",
    delimiterComma: ", (쉼표)",
    delimiterSemicolon: "; (세미콜론)",
    delimiterTab: "탭",
  },
  bulkEdit: {
    panelAria: "일괄 편집",
    textAria: "일괄 편집 텍스트",
    apply: "적용",
  },
  schedule: {
    formAria: "스케줄 폼",
    listAria: "스케줄 목록",
    eventsAria: "스케줄 이벤트",
    colName: "이름",
    colTrigger: "트리거",
    colNextRun: "다음 실행",
    colLastStatus: "최근 상태",
    colEnabled: "활성",
    toggleEnabledAria: (name: string) => `${name} 활성 전환`,
    editBtn: "편집",
    deleteBtn: "삭제",
  },
  environment: {
    formAria: "환경 폼",
    listAria: "환경 목록",
    nameLabel: "이름",
    nameAria: "환경 이름",
    variablesTitle: "변수",
    noVariables: "변수 없음",
    varKeyAria: (idx: number) => `변수 키 ${idx}`,
    varValueAria: (idx: number) => `변수 값 ${idx}`,
    removeVarAria: (key: string | number) => `${key} 변수 제거`,
    newVarKeyAria: "새 변수 키",
    newVarValueAria: "새 변수 값",
    newVarValuePlaceholder: "값 (예: https://staging.example)",
    addBtn: "추가",
    saveBtn: "저장",
    savingBtn: "저장 중…",
    cancelBtn: "취소",
    colName: "이름",
    colVariables: "변수",
  },
  compare: {
    worseAria: (text: string) => `더 나쁨: ${text}`,
    betterAria: (text: string) => `더 좋음: ${text}`,
    neutralAria: (text: string) => `동일: ${text}`,
  },
  triggerBuilder: {
    cronExpressionAria: "cron 표현식",
  },
  loadModelFields: {
    stageTargetAria: (i: number) => `스테이지 ${i} 목표`,
    stageDurationAria: (i: number) => `스테이지 ${i} 지속시간`,
    removeStageAria: (i: number) => `스테이지 ${i} 제거`,
  },
  import: {
    title: "가져오기",
    intro:
      "캡처한 HAR 파일을 올리면 요청을 시나리오 스텝으로 변환합니다. (HTTP Toolkit·브라우저 DevTools 등에서 HAR로 내보내세요.)",
    chooseFile: "HAR 파일 선택",
    parseError: "HAR을 읽지 못했습니다",
    nameLabel: "시나리오 이름",
    options: "변환 옵션",
    excludeStatic: "정적 리소스(이미지·CSS·JS 등) 제외",
    headerMode: "헤더 처리",
    headerModeAll: "전부 유지",
    headerModeStrip: "자동·휘발성 헤더 제거",
    headerModeSemantic: "의미 헤더만",
    statusAssert: "캡처된 응답 상태코드로 검증(assert) 추가",
    hosts: "호스트",
    requests: "요청",
    noRequests: "표시할 요청이 없습니다",
    preview: "변환된 시나리오 YAML",
    copy: "복사",
    toEditor: "편집기로 보내기",
  },
  opsSettings: {
    title: "운영 상한",
    mutableSection: "조정 가능한 운영 상한",
    readonlySection: "배포 설정 (읽기 전용)",
    applyNote: "여기서 바꾼 값은 다음에 시작하는 run부터 적용됩니다(진행 중인 run엔 영향 없음).",
    heartbeatMarginHint:
      "권장: stale 타임아웃을 ping 주기의 2배 이상으로 두세요. 너무 가까우면 일시적 지연에도 건강한 워커가 응답 없음으로 잘못 처리될 수 있습니다.",
    heartbeatApplyNote:
      "하트비트 ping 주기·stale 타임아웃은 진행 중인 풀에 다음 하트비트 점검부터 즉시 적용됩니다(위 '다음 run부터' 안내는 이 두 값엔 해당하지 않음).",
    save: "저장",
    reset: "기본값 복원",
    rangeHint: (min: number, max: number) => `허용 범위 ${min}~${max}`,
    defaultHint: (d: number | string) => `기본값 ${d}`,
    readonlyNote: "Helm/CLI 배포 설정으로 변경",
    runStartupStallLabel: "Run 시작 후 메트릭 미도착 경고 (advisory)",
    runMidrunStallLabel: "Run 진행 중 메트릭 침묵 경고 (advisory)",
    outOfRange: "허용 범위를 벗어났습니다",
    desc: {
      worker_capacity_vus:
        '워커 한 대가 맡는 가상 사용자(VU) 수. 컨트롤러가 "필요 워커 수 = 올림(총 VU ÷ 이 값)"으로 몇 대 띄울지 계산합니다.',
      dataset_max_rows:
        '데이터셋을 "반복마다" 바인딩할 때 워커로 보낼 수 있는 최대 행 수. 워커 메모리를 지킵니다(VU별 바인딩은 미적용).',
      max_open_loop_worker_count: "열린 루프(도착률) run에서 지정 가능한 워커 수의 최댓값.",
      max_data_bindings: "한 run에 동시에 붙일 수 있는 독립 데이터셋 바인딩 개수.",
      max_loop_breakdown_cap:
        'loop 노드 메트릭을 "회차별로" 몇 개까지 집계할지 정하는 run 설정값의 허용 상한. 초과 회차는 "상한 초과" 한 칸으로 합쳐집니다.',
      max_test_run_requests: '에디터 "시나리오 미리 테스트"가 한 번에 보낼 수 있는 최대 요청 수.',
      trace_body_cap_bytes: "테스트 실행 시 응답 본문을 최대 몇 바이트까지 보관할지(초과분 잘림).",
      scheduler_tick_seconds: "예약된 run을 얼마나 자주 점검할지(초).",
      pool_heartbeat_interval_seconds: "풀 컨트롤러가 유휴/실행 중 워커에 ping을 보내는 주기(초).",
      pool_stale_timeout_seconds:
        "이 시간(초) 동안 워커 응답(pong)이 없으면 풀에서 제외합니다. ping 주기보다 충분히 커야 합니다.",
      pool_keepalive_seconds:
        "컨트롤러 gRPC 서버측 HTTP/2 keepalive 주기(초). 배포 설정(재시작 필요).",
      run_startup_grace_seconds:
        "등록 후 첫 메트릭(부하 시작)을 기다리는 최소 시간(초). 실제 적용값은 이 값과 HTTP 타임아웃+여유·선두 무부하 구간 중 큰 값입니다. 이 안에 부하가 안 잡히면 hung으로 보고 run을 실패 처리합니다.",
      run_backstop_grace_seconds:
        "run 예상 종료 시각을 넘어 완료를 기다리는 여유 시간(초). 이 시간을 넘기면 hung으로 보고 run을 실패 처리합니다.",
    },
    effect: {
      worker_capacity_vus:
        "⬆ 올리면 워커 한 대에 VU를 더 몰아 워커 수가 줄어듭니다(자원 절약). 너무 높이면 한 대가 과부하돼 부하 생성이 부정확해집니다.\n⬇ 내리면 워커를 더 많이 띄웁니다(분산↑·정확도↑). 대신 K8s Pod·프로세스가 늘어 클러스터 자원을 더 씁니다.",
      dataset_max_rows:
        '⬆ 올리면 더 큰 데이터셋을 반복 바인딩에 쓸 수 있습니다. 대신 워커 메모리 사용량이 커져 OOM 위험이 늘어납니다.\n⬇ 내리면 메모리는 안전하지만, 행이 많은 데이터셋 run은 "행 수 초과"로 거부됩니다.',
      max_open_loop_worker_count:
        "⬆ 올리면 매우 높은 목표 RPS를 더 많은 워커로 분산할 수 있습니다. 대신 한 번에 많은 워커 Pod가 떠 클러스터를 압박합니다.\n⬇ 내리면 안전하지만, 아주 높은 목표 RPS를 워커가 못 따라가 포화(요청 누락)될 수 있습니다.",
      max_data_bindings:
        "⬆ 올리면 더 복잡한 다중 데이터셋 시나리오가 가능합니다. 대신 워커의 다중 스트림 관리 부담이 커집니다.\n⬇ 내리면 단순·가볍지만, 바인딩이 많은 run은 거부됩니다.",
      max_loop_breakdown_cap:
        "⬆ 올리면 반복이 많은 loop도 회차별로 세밀히 볼 수 있습니다. 대신 저장·리포트 행(메트릭 양)이 늘어납니다.\n⬇ 내리면 메트릭은 가벼워지지만, 회차별 분해 해상도가 줄어듭니다.",
      max_test_run_requests:
        "⬆ 올리면 더 긴 시나리오를 미리 끝까지 실행해볼 수 있습니다. 대신 미리보기가 느려지고 대상 서버에 요청이 더 갑니다.\n⬇ 내리면 빠르고 가볍지만, 긴 시나리오는 앞부분까지만 미리 실행됩니다.",
      pool_heartbeat_interval_seconds:
        "⬆ 올리면 ping이 뜸해져 네트워크 부담이 줄지만, 죽은 워커 감지가 느려집니다.\n⬇ 내리면 빨리 감지하지만 ping이 잦아집니다. stale 타임아웃을 항상 이 값의 2배 이상으로 유지하세요.",
      pool_stale_timeout_seconds:
        "⬆ 올리면 느린 워커에 관대해지지만 죽은 워커가 오래 남습니다.\n⬇ 내리면 빨리 정리하지만, ping 주기에 너무 가까우면 건강한 워커를 잘못 제외합니다(최소 2배 권장).",
      run_startup_grace_seconds:
        "⬆ 올리면 느리게 시작하는 SUT·콜드스타트에 관대해집니다. 대신 정말 멈춘(hung) run을 늦게 감지합니다.\n⬇ 내리면 빨리 감지하지만, 정상이지만 느린 시작을 잘못 실패 처리할 수 있습니다(실제 적용값은 HTTP 타임아웃+15초 이상으로 보호).",
      run_backstop_grace_seconds:
        "⬆ 올리면 종료가 늦는 run에 관대해집니다. 대신 멈춘 run이 오래 남습니다.\n⬇ 내리면 멈춘 run을 빨리 정리하지만, 정상이지만 조금 늦게 끝나는 run을 잘못 실패 처리할 수 있습니다.",
    },
  },
} as const;
