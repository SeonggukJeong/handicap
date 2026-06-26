# LAN 분산 워커 운영 런북 (ADR-0041, L1–L7)

LAN 내 여러 PC를 **상시 워커 풀**로 묶어 부하를 분산하는 운영 절차다.
풀 모드(pool mode)에서는 워커를 미리 켜 두고, run 발사 시 컨트롤러가 유휴 워커 전원을 자동 배정(use-all)한다.

> 단일-PC 로컬 실행(subprocess 모드·Tauri 셸)과 다른 점은 **`--worker-mode pool`** 과 **바인드 오버라이드** 뿐이다.

**구현 단계 요약** (자세한 동작은 각 절):

| 단계 | 내용 |
|------|------|
| L1 | 풀 모드 — 유휴 워커 풀에 run push 배정(use-all) + 공유 토큰 인증 |
| L2 | 읽기전용 `/workers` 대시보드 + RunDialog 풀 프리뷰 |
| L3 | closed-loop 과부하 가드 (capacity-aware water-fill, 용량 부족 시 409) |
| L4 | open-loop(고정 `target_rps`/곡선 `stages`) 과부하 가드 |
| L5 | closed-loop VU 곡선(`vu_stages`) 과부하 가드 + 워커별 active-VU 머지 |
| L6 | 능동 하트비트 / last-seen / 유령 워커 자동 정리 |
| L7 | 대시보드 워커 제어 (비우기·제외·용량 조정·메모) + 제어 상태 영속화 |

---

## 준비 사항

- **컨트롤러 PC**: `controller` 바이너리 + `ui/dist`(웹 UI). 방화벽 인바운드 허용 필요.
- **각 워커 PC**: `worker` 바이너리만. UI·DB·사이드카 불필요.
- 컨트롤러 → 워커 방향 연결이 없다(워커가 컨트롤러에 접속). 워커 방화벽 인바운드 허용 불필요.

---

## 1. 컨트롤러 기동 (LAN용)

```bash
./controller \
  --worker-mode pool \
  --grpc 0.0.0.0:8081 \
  --rest 0.0.0.0:8080 \
  --worker-token <공유_비밀_키> \
  --ui-dir ui/dist \
  --db /var/data/handicap.db
```

### ⚠ 127.0.0.1 기본값 — 반드시 오버라이드

| 플래그 | 기본값 | LAN 필수 값 |
|--------|--------|------------|
| `--rest` | `127.0.0.1:8080` | `0.0.0.0:8080` (또는 특정 IP) |
| `--grpc` | `127.0.0.1:8081` | `0.0.0.0:8081` (또는 특정 IP) |

**두 포트 모두 기본이 `127.0.0.1`이다.** `--rest`만 열면 브라우저는 닿지만 워커가 gRPC 채널을 못 열고, `--grpc`만 열면 워커는 연결되지만 UI 접근이 안 된다. **둘 다 오버라이드 필수.**

특정 인터페이스만 열려면 `0.0.0.0` 대신 해당 IP(예: `192.168.1.10:8081`)를 쓴다.

### 하트비트·라이브니스 플래그 (L6, 선택)

풀 워커 하트비트 임계값은 기본값으로 충분하지만, 네트워크 사정에 맞춰 시작값을 줄 수 있다. **이 값들은 재배포 없이 `/settings`에서 런타임으로 바꿀 수 있다(§9 참조)** — 아래 플래그는 *시작 시드*다.

| 플래그 | 기본값 | 범위 | 의미 |
|--------|--------|------|------|
| `--pool-heartbeat-interval-seconds` | `10` | 1–3600 | 컨트롤러가 풀 워커에 Ping을 보내는 주기 |
| `--pool-stale-timeout-seconds` | `30` | 2–86400 | 이 시간만큼 응답이 없으면 워커를 stale로 보고 제거. **반드시 ping 주기보다 커야 한다** |
| `--pool-keepalive-seconds` | `20` | — | gRPC HTTP/2 keepalive 주기(전송 계층, half-open TCP 감지). 런타임 가변 아님(읽기전용) |

> `stale_timeout ≤ heartbeat_interval`이면 정상 워커가 매 sweep마다 잘못 제거(flapping)되므로 시작 시 자동으로 클램프되고 경고 로그가 남는다.

### Windows 방화벽

컨트롤러 PC에서 두 포트 인바운드를 허용한다(관리자 권한 PowerShell):

```powershell
New-NetFirewallRule -DisplayName "Handicap REST" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
New-NetFirewallRule -DisplayName "Handicap gRPC" -Direction Inbound -Protocol TCP -LocalPort 8081 -Action Allow
```

---

## 2. 워커 기동 (각 PC)

```bash
./worker \
  --controller http://<컨트롤러_IP>:8081 \
  --token <공유_비밀_키>
```

- `--run-id` **생략** = 풀 모드. (`--run-id`를 주면 단일 run에 고정되는 레거시 모드.)
- `--worker-id`는 생략하면 자동 ULID. 로그에서 워커를 구별하거나 **제어 상태를 컨트롤러 재시작 너머로 유지하려면 명시 지정**한다(§8 영속화 참조).
- `--capacity-vus`는 closed-loop·open-loop run 배정 시 존중된다(§4 참조). 기본값 1000.

워커는 각 run이 끝나면 자동으로 컨트롤러에 재연결(reconnect-per-run)된다. 워커 프로세스를 종료하지 않아도 되며, 연속 run 사이 중단 시간은 sub-second이다.

---

## 3. 풀 배정 동작 (use-all)

run을 생성하면 컨트롤러가 **연결된 유휴 워커 전원**을 자동 배정한다. 배정 수 N은 부하 상한으로 제한된다:

| 부하 모드 | 워커 배정 수 N |
|-----------|--------------|
| closed-loop (`vus`) | `min(유휴_워커_수, vus)` |
| open-loop (`target_rps` / `max_in_flight`) | `min(유휴_워커_수, min(max_in_flight, peak_stage_rps))` |
| VU 곡선 (`vu_stages`) | `min(유휴_워커_수, 곡선 peak)` — capacity-aware fan-out (L5) |

closed-loop에서 **`vus`는 총 VU 수이자 워커 배정 상한을 겸한다.** 유휴 워커가 3대여도 `vus: 2`면 워커 2대만 쓴다. VU 곡선도 마찬가지로 **곡선 최고점(`max(vu_stages.target)`)** 이 총 부하이자 배정 상한이다.

배정된 워커들에 부하를 어떻게 나누는지(균등 분할 vs 용량 비례)는 §4 과부하 가드를 따른다.

---

## 4. 과부하 가드 (L3–L5)

L3부터 컨트롤러가 각 워커의 `--capacity-vus` 선언을 존중해 부하를 배정한다. **closed-loop(L3)·open-loop(L4)·VU 곡선(L5)** 세 부하 모드 모두 capacity-aware다.

### capacity-aware 배정 (closed-loop, L3)

closed-loop(`vus`) run에서 배정 알고리즘은 **water-fill** 방식:

1. 유휴 워커 전원에 VU를 균등 분할한다.
2. 분할값이 해당 워커의 `--capacity-vus`를 초과하면 상한(`capacity_vus`)으로 클램프하고, 남는 VU를 여유가 있는 워커에게 재배분한다.
3. 모든 워커의 슬랙이 소진될 때까지 반복한다.

결과적으로 **총 배정 VU ≤ 유휴 워커 총 용량**이 보장된다. 어느 워커도 자신이 선언한 한도를 초과하지 않는다. 여유가 충분해 모든 워커가 상한에 걸리지 않으면 기존 균등 분할(L1)과 동일하다(byte-identical).

워커 기동 시 용량 선언:

```bash
./worker \
  --controller http://<컨트롤러_IP>:8081 \
  --token <공유_비밀_키> \
  --capacity-vus 50     # 이 워커가 처리할 수 있는 최대 VU 수 (기본: 1000)
```

> 용량은 워커별 `--capacity-vus` 선언값을 기본으로 하되, **운영자가 대시보드에서 워커별로 즉석 조정(capacity override)** 할 수 있다(§7 용량 조정). 조정값이 있으면 배정 계산은 조정값을 쓴다.

### 용량 부족 시 동작 (closed-loop)

요청한 `vus`가 유휴 워커 전체 용량 합계를 초과하면 **run을 생성하지 않고** 아래 두 가지 선택지를 제시한다.

**RunDialog 프리뷰:** 풀 모드 run 생성 다이얼로그에 "총 가용 용량 N VU" 안내가 표시되며, 요청 `vus`가 초과하면 추가 경고 힌트가 함께 표시된다. 실제 배정 결정은 컨트롤러가 run 발사 시 내린다.

**`POST /api/runs` 응답 — 용량 초과 시 409:**

```bash
# 용량 초과 예 (워커 2대 각 capacity-vus=5, 총 10 VU)
curl -s -X POST http://localhost:8080/api/runs \
  -H "Content-Type: application/json" \
  -d '{"scenario_id":"…","profile":{"vus":20,"duration_seconds":60},"env":{}}' | jq
# → HTTP 409
# {
#   "achievable_vus": 10,
#   "requested_vus": 20
# }
```

- `achievable_vus`: water-fill 결과로 실제 배정 가능한 최대 VU 수
- `requested_vus`: 요청한 VU 수
- run 행은 **생성되지 않는다** (DB insert 전에 사전 검사).
- 유휴 워커가 0이면 409가 아니라 **400**("연결된 LAN 워커가 없습니다") — §5 참조.

**"줄여 진행":** `vus`를 `achievable_vus`로 낮춰 재전송한다.

```bash
curl -s -X POST http://localhost:8080/api/runs \
  -H "Content-Type: application/json" \
  -d '{"scenario_id":"…","profile":{"vus":10,"duration_seconds":60},"env":{}}' | jq
# → 201 Created (run 생성 성공)
```

**"강행(과부하)":** `?force=true`를 붙이면 용량 검사를 건너뛰고 기존 균등 분할(L1 방식)로 run을 생성한다. 워커가 처리 능력을 초과하는 VU를 받을 수 있다.

```bash
curl -s -X POST "http://localhost:8080/api/runs?force=true" \
  -H "Content-Type: application/json" \
  -d '{"scenario_id":"…","profile":{"vus":20,"duration_seconds":60},"env":{}}' | jq
# → 201 Created (과부하 허용, capacity 무시)
```

> `?force=true`는 공유 토큰 인증을 우회하지 않는다. 토큰 검사는 gRPC 워커 등록 시 수행되며 REST API 쿼리 파라미터와 무관하다.

### capacity-aware 배정 — open-loop (L4)

L4부터 **open-loop(`target_rps` / `max_in_flight`) run**에도 용량 검사가 적용된다.

**슬롯 분할 (`max_in_flight`):**
closed-loop의 VU 분할과 동일하게 `capacity_split`(water-fill)으로 각 워커에 in-flight 슬롯을 분배한다. 어느 워커도 `--capacity-vus`를 초과하지 않는다.

**레이트 분할 (`target_rps` / `stages`):**
- **고정 레이트(`target_rps`):** 슬롯 비율에 비례해 레이트를 분할한다. 각 워커가 **최소 1 RPS**를 받는다 — 엔진이 0-레이트 워커를 ≥1 RPS로 클램프하는 동작을 방지하기 위함이다(클램프 시 목표 RPS 초과 발사).
- **곡선(`stages`):** 각 stage의 `target`도 슬롯 비율에 비례 분할한다. 곡선은 0-레이트 stage를 실제 폴링하므로 min1 처리가 불필요하다.

**워커 배정 수 N 상한:**
`N = min(유휴_워커_수, min(max_in_flight, peak_stage_rps))`
N을 레이트 피크로 제한해 "워커 수 > 분당 레이트" 상황의 과도 발사를 방지하고, per-worker rate ≥ N이 보장된다(min1 전제 조건 충족).

**용량 부족 시 409 동작:**
요청한 `max_in_flight`이 유휴 워커 총 용량 합계를 초과하면 closed-loop과 동일하게 409를 반환한다. `achievable_vus`는 달성 가능한 최대 `max_in_flight` 값이다.

```bash
# open-loop 용량 초과 예 (워커 2대 각 capacity-vus=5, max_in_flight=20)
curl -s -X POST http://localhost:8080/api/runs \
  -H "Content-Type: application/json" \
  -d '{"scenario_id":"…","profile":{"target_rps":100,"max_in_flight":20,"duration_seconds":60},"env":{}}' | jq
# → HTTP 409
# {
#   "achievable_vus": 10,
#   "requested_vus": 20
# }
```

- **"줄여 진행":** `max_in_flight`을 `achievable_vus`로 낮춰 재전송한다(target_rps·stages는 그대로 유지, 슬롯이 줄어 dropped 카운터가 늘 수 있음).
- **"강행(과부하)":** `?force=true`로 용량 검사를 건너뛰고 기존 균등 분할(L1 방식)로 run을 생성한다.

### capacity-aware 배정 — closed-loop VU 곡선 (L5)

L5부터 **closed-loop VU 곡선(`vu_stages`) run**도 용량 검사·fan-out 대상이다(L4 이전엔 단일 워커 legacy 경로였다).

- **워커 배정:** 곡선 최고점(`max(vu_stages.target)`)을 부하 demand로 삼아 다른 모드와 같은 water-fill로 워커를 배정한다. 최고점이 유휴 워커 총 용량을 넘으면 closed-loop과 동일하게 **409**.
- **곡선 비례 스케일:** 각 워커는 자기 용량 비율만큼 **축소된 `vu_stages` 곡선**을 받는다(각 stage의 `target`을 비례 분할). 워커들의 곡선을 합치면 원래 곡선이 된다.
- **워커별 active-VU 분해:** 리포트의 active-VU 시계열은 워커별로 기록·머지되어, 워커가 2대 이상이면 "어느 워커가 목표 VU에 미달했는지"를 워커별로 볼 수 있다.
- **"줄여 진행" / "강행":** closed-loop과 동일. 줄여 진행 시 곡선이 `achievable` 비율로 축소되고, 강행(`?force=true`)은 균등 분할 fan-out으로 발사한다.

### 현재 한계 (L5 기준)

| 한계 | 내용 |
|------|------|
| **dataset `unique` 비례 분할 미적용** | water-fill 결과 워커마다 VU/슬롯이 달라도 데이터셋 행은 균등 분할한다. disjointness(각 행 ≤1회 소비)는 보장되며 uniqueness 정확성 위험은 없다. 소비 속도만 불균등해져 빠른 워커에서 stop-on-exhaust가 더 일찍 발생할 수 있다. 비례 분할은 후속 예정. |
| **풀 open-loop은 `worker_count` 노브 무시** | use-all-by-demand(`N = min(유휴, 부하상한)`) 방식이다. `worker_count` 명시는 비-풀 fan-out(ADR-0038) 전용으로, 풀 모드에서는 무시된다. |

### dataset `unique` 정책과 불균등 분할

water-fill 결과 워커마다 배정 VU가 다를 수 있다. 데이터셋 `unique` 정책을 쓸 때 알아둘 점:

- **disjointness는 보존된다.** 각 데이터셋 행은 전체 워커를 통틀어 최대 1회만 소비된다 — 각 워커는 disjoint 슬라이스(행을 워커 수로 균등 분할, VU 분할과 독립)를 받으므로 uniqueness 정확성 위험은 없다.
- **소비 속도가 불균등해진다.** VU를 더 많이 받은 워커가 자기 슬라이스를 더 빨리 소진하므로, 그 워커에서 stop-on-exhaust가 더 일찍 발생할 수 있다.
- **비례 분할(capacity 비율로 행 수 조정)은 후속 예정이다.** 현재는 행 수를 균등하게 나눈다.

> **빈 슬라이스 가드:** `unique` 행 수가 배정 워커 수보다 적으면(`rows < N`) run이 거부된다(400) — 빈 슬라이스를 받은 워커가 언바운드로 폭주하는 것을 막는다.

---

## 5. 빈 풀 동작

유휴 워커가 0이면 run이 **즉시 실패**한다:

```
400 연결된 LAN 워커가 없습니다 — 워커를 1대 이상 띄우세요
```

run 생성 전에 워커가 컨트롤러에 연결·등록됐는지 확인한다(컨트롤러 로그에 `worker registered` 라인, 또는 `/workers` 대시보드).

---

## 6. 토큰 인증

`--worker-token`을 설정하면 워커가 `--token`으로 일치하는 값을 제시해야 풀에 진입할 수 있다.

| 시나리오 | 결과 |
|---------|------|
| 컨트롤러 `--worker-token` 없음 | 토큰 검사 없음(누구나 연결) |
| 컨트롤러 `--worker-token <key>` + 워커 `--token <key>` 일치 | 풀 진입 성공 |
| 컨트롤러 `--worker-token <key>` + 워커 토큰 불일치/생략 | 연결 거부, 풀 미진입 |

### ⚠ 보안 한계

토큰은 **평문 gRPC 채널**로 전송된다. 이 인증은 **접근 통제용** 이고, 기밀성(도청 방지)은 제공하지 않는다. 신뢰할 수 없는 네트워크(인터넷 경유·VLAN 외부)에서는 mTLS가 필요하다(후속 예정). LAN 내부 전용 운영을 권장한다.

- `/api/pool/workers` 대시보드 엔드포인트는 인증 없이 접근 가능하다. LAN 상의 누구나 워커 hostname·worker_id·실행 중 run_id 같은 인프라 메타데이터를 조회할 수 있다(시크릿·토큰은 노출되지 않음). 전면 인증 및 mTLS는 후속 예정이다.

---

## 7. 풀 상태 보기 + 제어 (`/workers` 대시보드, L2 + L7)

### 대시보드 접속

웹 UI 상단 네비게이션의 **'워커'** 항목을 클릭하거나 `/workers`로 직접 이동한다.

**표시 정보**

| 열 | 내용 |
|----|------|
| 호스트 | 워커 PC의 hostname |
| 워커 ID | 자동 발급 ULID (또는 `--worker-id`로 지정한 값) |
| 상태 | `유휴` / `실행 중` — 실행 중이면 해당 run으로 이동하는 링크 표시 |
| 용량(VU) | `--capacity-vus` 선언값. 운영자가 조정했으면 `N (수동)`으로 표시 (§7 용량 조정) |
| 마지막 응답 | 워커가 마지막으로 응답한 시점(`N초 전`). 일정 시간 무응답이면 **`응답 없음`** 배지 (L6 — §8 참조) |
| 메모 | 운영자 메모(`--worker-id` 안정 식별자 워커에 한해 컨트롤러 재시작 후 유지) |

페이지 상단에 **유휴 / 실행 중 워커 수**가 요약 표시된다. 풀 모드일 때 ~3초 간격으로 자동 갱신된다.

**풀 모드가 아닌 컨트롤러**(`--worker-mode pool` 없이 기동)에서는 대시보드에 빈-상태 안내가 표시된다.

### RunDialog 프리뷰

풀 모드에서 **run 생성 다이얼로그**를 열면 "연결된 유휴 워커 N대" 안내가 표시된다(읽기 전용). 실제 사용 워커 수는 컨트롤러가 run 발사 시 결정한다(`min(유휴_워커_수, 부하_상한)` — §3 참조). **비우는 중인 워커는 프리뷰·배정에서 제외**된다("비우는 중 K대 제외" 안내).

### 워커 제어 액션 (L7)

각 워커 행에서 운영자가 다음을 제어할 수 있다. 제어 동작은 **다음 run의 부하 배분 계산에 즉시 반영**된다(§4 가드와 RunDialog 프리뷰가 같은 규칙을 본다).

**비우기 / 되돌리기 (drain / undrain) — 가역**

```bash
# 비우기: 이 워커에 새 작업 배정 중단 (진행 중 run은 끝까지 실행)
curl -X PATCH http://localhost:8080/api/pool/workers/<worker_id> \
  -H "Content-Type: application/json" -d '{"drained": true}'

# 되돌리기: 풀 멤버십 복구
curl -X PATCH http://localhost:8080/api/pool/workers/<worker_id> \
  -H "Content-Type: application/json" -d '{"drained": false}'
```

- 비운 워커는 새 run 배정·용량 계산에서 제외되지만 목록에는 **`비우는 중`** 배지로 남는다.
- 정비 창(maintenance window) 전에 먼저 비우고, 진행 중 작업이 끝난 뒤 워커를 손보는 용도.

**용량 조정 (capacity override)**

```bash
# 용량을 500 VU로 즉석 조정 (선언값 --capacity-vus 무시)
curl -X PATCH http://localhost:8080/api/pool/workers/<worker_id> \
  -H "Content-Type: application/json" -d '{"capacity_override": 500}'

# 조정 해제 (선언값으로 복귀) — null 명시
curl -X PATCH http://localhost:8080/api/pool/workers/<worker_id> \
  -H "Content-Type: application/json" -d '{"capacity_override": null}'
```

- 약한 PC·네트워크 병목 워커의 슬롯 비중을 줄일 때. 범위는 1–1,000,000.
- 배정 계산(water-fill·RunDialog 프리뷰)이 조정값을 본다. 목록엔 `N (수동)`으로 표시된다.

**메모 (label)**

```bash
curl -X PATCH http://localhost:8080/api/pool/workers/<worker_id> \
  -H "Content-Type: application/json" -d '{"label": "사무실-PC (느림)"}'
```

- 표시 전용 메모(부하에 영향 없음). 최대 200자.

> **PATCH 필드 의미:** 본문에 키가 **없으면** 기존 값 유지, **있으면** 변경. `capacity_override: null`은 *조정 해제*(선언값 사용)이고, 키 자체를 빼면 *변경 없음*이다.

**제외 (exclude) — 파괴적·비가역**

```bash
curl -X POST http://localhost:8080/api/pool/workers/<worker_id>/exclude \
  -H "Content-Type: application/json" -d '{"reason": "반복 행으로 수동 제외"}'
```

- 워커를 풀에서 **즉시 제거하고 워커 프로그램을 종료**시킨다(재접속 안 함). 다시 추가하려면 해당 PC에서 워커를 직접 재실행해야 한다.
- 유휴 워커는 깨끗이 제거된다. **실행 중 워커를 제외하면 그 run이 실패**한다(대시보드가 사전 경고).
- 오작동 워커(정비가 아니라 격리가 필요한 경우)에 쓴다. `reason`은 선택(최대 500자).

---

## 8. 하트비트 / 유령 워커 정리 (L6) + 제어 상태 영속화 (L7)

### 하트비트 기반 유령 워커 자동 제거 (L6)

대시보드의 "연결됨"은 gRPC 스트림이 열려 있다는 뜻이지만, 네트워크 비정상 단절·PC 절전(half-open TCP)에서는 스트림이 죽은 줄 모르고 **유령 워커**로 남을 수 있다. L6은 이를 능동 하트비트로 정리한다:

- 컨트롤러가 `--pool-heartbeat-interval-seconds`(기본 10초) 주기로 풀 워커 전원(유휴·실행 중 모두)에 **Ping**을 보내고, 워커가 **Pong**으로 응답한다. 어떤 인바운드 메시지든 `마지막 응답` 시각을 갱신한다.
- `--pool-stale-timeout-seconds`(기본 30초)를 넘겨 무응답인 워커는 **자동 제거**된다:
  - **유휴 워커**: 풀에서 조용히 제거.
  - **실행 중 워커**: 해당 run을 **즉시 실패** 처리(fail-fast)하고 제거.
- 별도로 gRPC HTTP/2 keepalive(`--pool-keepalive-seconds`, 기본 20초)가 죽은 *연결* 자체를 감지해 teardown → 워커가 재접속·재등록한다.

**대시보드 반영**

| 종료 유형 | 대시보드 반영 |
|-----------|-------------|
| 워커 프로세스 정상 종료 (`Ctrl-C` / `SIGTERM`) | 스트림이 즉시 닫혀 목록에서 즉시 사라짐 |
| `kill -9` (SIGKILL) | OS가 TCP 연결을 정리하므로 빠르게 사라짐 |
| 네트워크 비정상 단절·PC 절전(half-open TCP) | `마지막 응답`이 점점 길어지다 `응답 없음` 배지 → stale 타임아웃 초과 시 자동 제거 |

`마지막 응답` 열이 ping 주기보다 길어지고 stale 타임아웃 안일 때 **`응답 없음`** 배지가 뜬다. 이 상태가 지속되면 다음 sweep에서 워커가 목록에서 사라진다.

> 임계값(ping 주기·stale 타임아웃)은 재배포 없이 `/settings`에서 런타임으로 조정할 수 있다 — §9.

### 제어 상태 영속화 (L7)

§7의 워커 제어 상태(비우기·용량 조정·메모)를 **컨트롤러 재시작 후에도 유지**하려면 워커를 **안정 식별자(`--worker-id`)** 로 기동해야 한다.

```bash
# 안정 식별자 부여 — 제어 상태가 컨트롤러 재시작·재접속 후에도 유지됨
./worker --controller http://<컨트롤러_IP>:8081 --token <키> --worker-id office-pc-1
```

| 워커 기동 | 제어 상태 영속 |
|-----------|---------------|
| `--worker-id <안정값>` (운영자 지정) | ✅ 컨트롤러 DB에 저장. 재시작/재접속 시 비우기·용량·메모 복원 |
| `--worker-id` 생략 (자동 랜덤 ULID) | ❌ **일시적** — 재접속·재시작 시 제어 상태 소실 |

- 자동 ULID 워커는 매 재접속마다 식별자가 바뀌어 영속 키가 될 수 없다. 대시보드에 **`일시적`** 인디케이터가 표시되며, "유지하려면 `--worker-id`로 기동" 힌트가 함께 나온다.
- 정비·운영 통제가 필요한 상시 워커는 호스트별로 고정된 `--worker-id`를 부여하는 것을 권장한다.

---

## 9. 런타임 임계값 조정 (`/settings`)

L6 하트비트 임계값과 run 라이브니스 grace는 **재배포·재시작 없이** `/settings` 페이지(또는 REST)에서 런타임으로 바꿀 수 있다. 리퍼가 매 sweep마다 현재 값을 다시 읽으므로 변경이 즉시 반영된다(run grace는 *이후 발사되는 run*부터 적용).

| 키 | 라벨 | 범위 | 기본 | 가변 |
|----|------|------|------|------|
| `pool_heartbeat_interval_seconds` | 풀 하트비트 ping 주기 | 1–3600 | 10 | ✅ |
| `pool_stale_timeout_seconds` | 풀 워커 stale 타임아웃 | 2–86400 | 30 | ✅ |
| `run_startup_grace_seconds` | Run 시작 grace (startup 라이브니스) | 10–3600 | 90 | ✅ |
| `run_backstop_grace_seconds` | Run 백스톱 grace (예상 종료 초과) | 10–3600 | 120 | ✅ |
| `pool_keepalive_seconds` | 풀 gRPC keepalive (서버측) | — | 20 | ❌ 읽기전용 |

```bash
# stale 타임아웃을 45초로 (네트워크 정비 중 임시 완화)
curl -X PUT http://localhost:8080/api/settings/pool_stale_timeout_seconds \
  -H "Content-Type: application/json" -d '{"value": 45}'

# 시작 시드(또는 코드 기본값)로 되돌리기
curl -X DELETE http://localhost:8080/api/settings/pool_stale_timeout_seconds
```

> **불변식:** `pool_stale_timeout_seconds`는 항상 `pool_heartbeat_interval_seconds`보다 커야 한다. 이를 깨는 PUT/DELETE는 400으로 거부된다(정상 워커 flapping 방지).

`run_startup_grace` / `run_backstop_grace`는 풀과 직접 관련은 없지만, 등록 후 진행이 멈춘(hung) 워커를 자동 실패시키는 라이브니스 임계값이라 같은 화면에서 조정한다.

---

## 10. L1–L7 한도 요약

| 항목 | 현재 동작 |
|------|---------|
| 워커 재연결 | run 완료 후 자동 reconnect-per-run (sub-second) |
| 과부하 가드 (closed-loop) | capacity-aware 배정 (water-fill, `--capacity-vus`/조정값 존중, 초과 시 409 또는 `?force=true` 강행) |
| 과부하 가드 (open-loop fixed/curve) | capacity-aware 배정 (L4 — 슬롯=capacity_split·레이트 비례·N 레이트-상한·409/강행 동일) |
| 과부하 가드 (VU 곡선 `vu_stages`) | capacity-aware 배정 (L5 — 곡선 비례 스케일·워커별 active-VU 머지·409/강행 동일) |
| 라이브니스 | 능동 하트비트(Ping/Pong) + last-seen + stale 자동 제거 (L6, 임계값 `/settings` 런타임 가변) |
| 워커 제어 | 대시보드 비우기·제외·용량 조정·메모 (L7) |
| 제어 상태 영속 | `--worker-id` 안정 식별자 워커만 컨트롤러 재시작 후 유지 (L7) |
| 채널 보안 | 평문 gRPC + 공유 토큰(접근 통제 only) — mTLS 후속 |
| 단일 PC 한도 | 기존 subprocess 모드와 동일 |
| 멀티 컨트롤러 | 미지원 (워커는 컨트롤러 1개에만 연결) |

---

## 11. 빠른 로컬 검증 (pool 모드 동일 PC)

LAN이 없는 환경에서 pool 모드를 확인하려면 같은 PC에서 loopback으로 실행할 수 있다:

```bash
# 1. 바이너리 빌드
cargo build -p handicap-worker --bin worker
cargo build -p handicap-controller --bin controller

# 2. pool 컨트롤러 (격리 DB, 짧은 하트비트로 L6 관찰)
./target/debug/controller \
  --db /tmp/lan-test.db \
  --ui-dir ui/dist \
  --worker-mode pool \
  --grpc 127.0.0.1:8091 \
  --rest 127.0.0.1:8090 \
  --worker-token SECRET \
  --pool-heartbeat-interval-seconds 2 \
  --pool-stale-timeout-seconds 6 &

# 3. 풀 워커 2개 (--run-id 없이, 안정 식별자 부여로 L7 영속 확인 가능)
./target/debug/worker --controller http://127.0.0.1:8091 --token SECRET --worker-id w1 &
./target/debug/worker --controller http://127.0.0.1:8091 --token SECRET --worker-id w2 &

# 4. 브라우저로 http://localhost:8090 접속
#    - /workers 에서 워커 2개·마지막 응답·제어 버튼 확인
#    - run 생성 → 워커 2개 사용 확인
#    - 워커 1개를 kill -9 → stale 타임아웃 후 목록에서 사라지는지 확인
```

완료 후 정리:

```bash
kill %1 %2 %3   # 컨트롤러 + 워커 2개
rm /tmp/lan-test.db
```
