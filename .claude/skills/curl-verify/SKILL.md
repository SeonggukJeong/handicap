---
name: curl-verify
description: Scaffold correct curl recipes to drive an already-running handicap controller — create scenario → create run → poll to terminal → fetch report (or a one-shot test-run). The lighter "controller is already up" counterpart to /live-verify (which stands up the full stack). Bakes in the documented curl/JSON/zsh footguns (don't parse create responses, pipe curl straight to python, payload/summary key names, ULID step ids). Has a side effect (creates a run), so user-only.
disable-model-invocation: true
model: sonnet
---

# curl-verify — 떠 있는 controller에 대한 curl 검증 레시피

> **모델: Sonnet 고정** (frontmatter `model: sonnet` — 해당 턴만 적용). 순수 curl + JSON 키 파싱이라 브라우저·vision 없이 가장 기계적 → Sonnet으로 충분(판정 품질만 살짝 양보하면 Haiku도 가능). user-only(`disable-model-invocation`)라 모델이 못 부르고 `/curl-verify` 호출 시 이 frontmatter가 그 턴을 Sonnet으로 내린다.

전체 스택 기동은 `/live-verify`. **이미 controller가 떠 있을 때**(예: `just run-controller-with-ui`, 또는 live-verify가 띄운 백엔드) 시나리오 생성→run→폴링→report를 curl로 빠르게 도는 가벼운 버전. CLAUDE.md "로컬에서 curl로 직접 구동" 절의 footgun을 레시피에 박아 매번 다시 밟지 않게 한다.

기본값: REST `http://127.0.0.1:8080`. 번들된 `parse.py`로 응답에서 키를 안전하게 뽑는다(stdin 직결 — 셸 변수 경유 금지).

## 피해야 할 함정 (이 레시피가 자동으로 피하는 것)
- **생성 응답(`POST /api/scenarios`·`/api/runs`)을 파싱하지 말 것** — 멀티라인 `scenario_yaml`이 임베드돼 셸 변수에 담았다가 `jq`/`python`에 넘기면 zsh가 `\n`을 실제 개행으로 풀어 JSON이 깨진다. **id는 `GET /api/scenarios/{id}/runs` 목록에서 재조회**하거나 `curl … | python3 parse.py`로 **직결**.
- **`echo "$json" | python3` 금지** — 위와 같은 `\n` 언이스케이프. curl을 python에 직결하거나 `printf '%s'`.
- **`curl … | python3 <<'EOF'` 금지** — heredoc이 pipe stdin을 덮어써 `json.load(sys.stdin)`가 curl이 아닌 스크립트를 읽는다. 비자명 추출은 `parse.py` 파일을 쓰고 `curl … | python3 parse.py <path>`.
- **`GET /api/runs` 목록 엔드포인트 없음** — `POST /api/runs` + `GET /api/runs/{id}`만. 목록은 `GET /api/scenarios/{id}/runs`.
- **YAML 필수 필드**: top-level `version: 1` + 각 step `id`(유효 ULID — Crockford base32, **I/L/O/U 제외**)·`type`·`name`. 누락 시 `422 missing field …` 또는 ULID 파싱 거부.
- **`GET /api/scenarios`는 `{"scenarios":[…]}` 래퍼**(bare 배열 아님). 단일 scenario/run 응답은 객체.
- **summary 키** = `count`/`errors`/`rps`/`p50_ms`/`mean_ms`/`p95_ms`/`p99_ms` (`total_requests`/`error_count` 아님).
- **localhost sub-ms면 `p50_ms==0`** — 사이징/phase 경로가 0-가드 폴백. 지연 검증이 필요하면 ≥50ms responder를 대상 url로(live-verify `responder.py`).

## 1) 시나리오 YAML 작성 → 생성
```bash
BASE=http://127.0.0.1:8080
SKILL=.claude/skills/curl-verify        # parse.py 위치

cat > /tmp/scn.yaml <<'YAML'
version: 1
name: curl-verify-smoke
steps:
  - id: 01HZ0000000000000000000000      # 유효 ULID (I/L/O/U 없음), 26자
    type: http
    name: get-root
    request:
      method: GET
      url: ${BASE_URL}/                  # env로 주입 (아래 run의 env)
YAML

# name은 YAML에서 파싱됨. jq -Rs로 본문 전체를 안전하게 {yaml:…}로 감싼다.
jq -Rs '{yaml: .}' /tmp/scn.yaml | curl -sS -X POST "$BASE/api/scenarios" \
  -H 'content-type: application/json' -d @- -o /dev/null -w 'create %{http_code}\n'
```

## 2) 시나리오 id 재조회 (생성 응답 파싱 금지)
```bash
# 가장 최근 생성분의 id (목록은 {"scenarios":[…]} 래퍼)
SID=$(curl -sS "$BASE/api/scenarios" | python3 "$SKILL/parse.py" scenarios.0.id)
echo "scenario id = $SID"
```

## 3) run 생성
페이로드 키 — `duration_seconds`만 항상 필수. 부하 모드별:
- **닫힌 루프(고정 VU)**: `"profile":{"vus":N,"duration_seconds":S}` — `vus>0` 필수(0이면 거부).
- **열린 루프(고정)**: `"profile":{"target_rps":R,"max_in_flight":M,"duration_seconds":S}` — `vus` 생략 가능.
- **열린 루프(곡선)**: `"profile":{"stages":[{"target":R,"duration_seconds":D},…],"max_in_flight":M}`.
- **닫힌 루프(VU 곡선)**: `"profile":{"vu_stages":[{"target":V,"duration_seconds":D},…]}`.
`env`로 `${ENV}` 토큰 주입(위 YAML의 `${BASE_URL}`).
```bash
RID=$(curl -sS -X POST "$BASE/api/runs" -H 'content-type: application/json' -d @- <<JSON | python3 "$SKILL/parse.py" id
{"scenario_id":"$SID","profile":{"vus":2,"duration_seconds":3},"env":{"BASE_URL":"http://127.0.0.1:8080"}}
JSON
)
echo "run id = $RID"
```
> 주의: 위 heredoc은 `-d @-`의 stdin **전용**이고 python은 `|` 다음의 별개 stdin(curl 출력)을 읽으므로 충돌 없음. run **생성 응답**은 `scenario_yaml`을 임베드하지 않아 `id`만 뽑는 건 안전하다(시나리오 생성 응답과 다름).

## 4) 종료까지 폴링
```bash
for i in $(seq 1 30); do
  ST=$(curl -sS "$BASE/api/runs/$RID" | python3 "$SKILL/parse.py" status)
  echo "[$i] status=$ST"
  case "$ST" in completed|failed|cancelled) break;; esac
  sleep 1
done
```
> "영영 running + 0 req"면 코드/네트워크보다 **controller 로그의 worker exit**를 먼저 본다(엔진/시나리오 모델 변경 후엔 `cargo build -p handicap-worker` 누락이 흔한 원인). status=0 + 비정상 높은 RPS = HTTP 도달 전 fail-fast(connection refused/URL parse).

## 5) 리포트 확인
```bash
curl -sS "$BASE/api/runs/$RID/report" | python3 "$SKILL/parse.py" summary
# 개별 키: … parse.py summary.count / summary.rps / summary.p50_ms / summary.mean_ms / summary.p95_ms / summary.p99_ms
```

## (대안) 단발 test-run — 저장 없이 trace
미저장 ephemeral. trace의 요청/응답 본문 뷰어 검증용.
```bash
jq -Rs '{scenario_yaml: ., env: {BASE_URL:"http://127.0.0.1:8080"}, max_requests: 1}' /tmp/scn.yaml \
  | curl -sS -X POST "$BASE/api/test-runs" -H 'content-type: application/json' -d @- \
  | python3 "$SKILL/parse.py" steps.0.response.body
```

## 정리
시나리오/run은 controller DB에 남는다 — 격리 DB(`--db /tmp/x.db`)로 띄웠으면 그 파일만 지우면 된다. 공용 `./handicap.db`였다면 테스트 데이터가 목록에 남으니 격리 DB 사용 권장.
