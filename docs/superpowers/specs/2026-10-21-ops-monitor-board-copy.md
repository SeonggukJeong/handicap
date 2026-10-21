# ops-monitor-board 공유 정본 — 화면 문구 (byte-exact)

> plan Task 8–10이 공유. `ui/src/i18n/ko.ts`에 `nav.monitors` + 최상위 `monitor` 네임스페이스로 **그대로** 넣는다(Task 8이 전체를 한 번에 추가, Task 9–10은 키만 사용). 문구를 바꾸려면 이 파일을 먼저 고친다. 서버 사유 문구(§서버)는 Rust 상수로 Task 2가 소유하고 UI는 받은 문자열을 그대로 표시한다.

## nav
- `nav.monitors`: `모니터`

## monitor (UI)
| 키 | 문구 |
|---|---|
| `listTitle` | `모니터` |
| `newBoard` | `새 모니터` |
| `openDisplay` | `화면 열기` |
| `panelCount(n)` | `` `칸 ${n}개` `` |
| `enabledOn` | `점검 중` |
| `enabledOff` | `꺼짐` |
| `boardName` | `이름` |
| `fontScale` | `글자 크기` |
| `fontScaleOptions` | `{ small: "작게", medium: "보통", large: "크게", xlarge: "아주 크게" }` |
| `blink` | `깜빡임` |
| `blinkOptions` | `{ off: "끄기", fail: "실패만", slow_and_fail: "느림+실패" }` |
| `panels` | `칸` |
| `addPanel` | `+ 칸 추가` |
| `removePanel` | `칸 삭제` |
| `panelTitle` | `제목` |
| `scenario` | `시나리오` |
| `scenarioRequired` | `시나리오를 선택하세요` |
| `environment` | `환경` |
| `environmentNone` | `환경 없음` |
| `interval` | `점검 주기(초)` |
| `thresholds` | `응답속도 기준선` |
| `thresholdMs` | `ms 이상` |
| `addThreshold` | `+ 기준선 추가` |
| `removeThreshold` | `삭제` |
| `advanced` | `고급` |
| `advancedSet(n)` | `` `${n}개 설정됨` `` |
| `timeout` | `제한 시간(초)` |
| `latencySource` | `표시할 응답 시간` |
| `latencyTotal` | `시나리오 전체` |
| `barCount` | `막대 개수` |
| `graphMax` | `그래프 최대 높이(ms)` |
| `preview` | `미리 실행` |
| `previewRunning` | `실행 중…` |
| `save` | `저장` |
| `start` | `모니터 시작` |
| `stop` | `점검 정지` |
| `toolbarFullscreen` | `전체화면` |
| `toolbarSettings` | `설정으로` |
| `stopError(msg)` | `` `점검을 멈추지 못했습니다: ${msg}` `` |
| `lastCheck(hms)` | `` `마지막 점검 ${hms}` `` |
| `everyN(n)` | `` `${n}초 주기` `` |
| `serverDown` | `서버 응답 없음` |
| `stateOk` | `✔ 정상` |
| `stateSlow` | `▲ 느림` |
| `stateFail` | `✖ 실패` |
| `stateConfigError` | `⚠ 설정 오류` |
| `stateStale` | `– 확인 불가` |
| `stateStaleOff` | `– 확인 불가 · 점검 꺼짐` |
| `statePending` | `… 확인 중` |
| `consecutive(n, hms)` | `` `${n}회 연속 · ${hms}부터` `` |
| `axisAgo(label)` | `` `${label} 전` `` |
| `axisNow` | `지금` |
| `axisUnit` | `(ms)` |
| `noValue` | `—` |
| `lastCheckNone` | `마지막 점검 —` |
| `notFound` | `모니터를 찾을 수 없음` |
| `emptyList` | `아직 만든 모니터가 없습니다. ‘새 모니터’로 운영실 화면을 만들어 보세요.` |
| `colName` | `이름` |
| `colPanels` | `칸` |
| `colState` | `상태` |
| `deleteBoard` | `모니터 삭제` |
| `deleteConfirm(name)` | `` `‘${name}’ 모니터를 삭제할까요? 점검도 함께 멈춥니다.` `` |
| `deleteConfirmOk` | `삭제` |
| `cancel` | `취소` |
| `loading` | `불러오는 중…` |
| `loadError(msg)` | `` `불러오지 못했습니다: ${msg}` `` |
| `saved` | `저장했습니다` |
| `previewVerdict` | `판정` |
| `previewStep` | `스텝` |
| `previewStatus` | `상태` |
| `previewLatency` | `응답 시간` |
| `previewError` | `오류` |
| `previewBody` | `응답 본문` |
| `previewNoTrace` | `시나리오를 실행하지 못했습니다(시간 초과 또는 설정 오류).` |

## 서버 사유 (Rust `monitor::check` 상수 — 와이어 `reason`)
- `시나리오를 찾을 수 없음` · `환경을 찾을 수 없음` · `시나리오 오류` · `응답 시간 기준 스텝 없음` · `변수 미설정`(실패한 스텝에 치환되지 않은 `${ENV}`/`{{var}}`가 있을 때 — `config_error`, 최종 리뷰 반영 2026-10-22)
- `` 시간 초과({n}초) `` · `요청 수 상한(50) 초과` · `시나리오 실행 오류`
- `` HTTP {status} `` · `요청 구성 오류` · `응답 본문 읽기 실패` · `값 추출 실패` · `요청 실패`
- 스텝 접미: `` {사유} · {스텝 이름} `` (시나리오 http 스텝이 2개 이상일 때만)
