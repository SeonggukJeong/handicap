# LAN 분산 워커 운영 런북 (ADR-0041, L1–L4)

LAN 내 여러 PC를 **상시 워커 풀**로 묶어 부하를 분산하는 운영 절차다.  
L1은 "풀 모드(pool mode)" — 워커를 미리 켜 두고, run 발사 시 컨트롤러가 유휴 워커 전원을 자동 배정(use-all)한다.

> 단일-PC 로컬 실행(subprocess 모드·Tauri 셸)과 다른 점은 **`--worker-mode pool`** 과 **바인드 오버라이드** 뿐이다.

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
- `--worker-id`는 생략하면 자동 ULID. 로그에서 워커를 구별하려면 명시 지정 가능.
- `--capacity-vus`는 closed-loop run 배정 시 존중된다(§4 참조). 기본값 1000.

워커는 각 run이 끝나면 자동으로 컨트롤러에 재연결(reconnect-per-run)된다. 워커 프로세스를 종료하지 않아도 되며, 연속 run 사이 중단 시간은 sub-second이다.

---

## 3. 풀 배정 동작 (use-all)

run을 생성하면 컨트롤러가 **연결된 유휴 워커 전원**을 자동 배정한다. 배정 수 N은 부하 상한으로 제한된다:

| 부하 모드 | 워커 배정 수 N |
|-----------|--------------|
| closed-loop (`vus`) | `min(유휴_워커_수, vus)` |
| open-loop (`target_rps` / `max_in_flight`) | `min(유휴_워커_수, max_in_flight)`·`min(유휴_워커_수, peak_stage_rps)` 중 작은 값 |
| VU 곡선 (`vu_stages`) | 곡선 peak까지 단일 워커 |

closed-loop에서 **`vus`는 총 VU 수이자 워커 배정 상한을 겸한다.** 유휴 워커가 3대여도 `vus: 2`면 워커 2대만 쓴다.

---

## 4. 과부하 가드 (L3+L4)

### capacity-aware 배정 (closed-loop)

L3부터 **closed-loop(`vus`) run**에서 컨트롤러가 각 워커의 `--capacity-vus` 선언을 존중해 VU를 배정한다. 배정 알고리즘은 **water-fill** 방식:

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

### 용량 부족 시 동작

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
- **고정 레이트(`target_rps`):** 슬롯 비율에 비례해 레이트를 분할한다(proportional_split_min1). 각 워커가 **최소 1 RPS**를 받는다 — 엔진이 0-레이트 워커를 ≥1 RPS로 클램프하는 동작을 방지하기 위함이다(클램프 시 목표 RPS 초과 발사).
- **곡선(`stages`):** 각 stage의 `target`도 슬롯 비율에 비례 분할한다(proportional_split). 곡선은 0-레이트 stage를 실제 폴링하므로 min1 처리가 불필요하다.

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

### 현재 한계 (L4 기준)

| 한계 | 내용 |
|------|------|
| **closed-loop VU 곡선(`vu_stages`) 풀 가드 미적용** | `vu_stages` run은 여전히 N=1 legacy 경로(워커 배정 1대)이며 under-cap 배정 갭이 존속한다. 별도 슬라이스 예정. |
| **dataset `unique` 비례 분할 미적용** | water-fill 결과 워커마다 VU/슬롯이 달라도 데이터셋 행은 균등 분할한다. disjointness(각 행 ≤1회 소비)는 보장되며 uniqueness 정확성 위험은 없다. 소비 속도만 불균등해져 빠른 워커에서 stop-on-exhaust가 더 일찍 발생할 수 있다. 비례 분할은 후속 예정. |
| **풀 open-loop은 `worker_count` 노브 무시** | use-all-by-demand(`N = min(유휴, worker_cap)`) 방식이다. `worker_count` 명시는 비-풀 fan-out(ADR-0038) 전용으로, 풀 모드에서는 무시된다. |

### dataset `unique` 정책과 불균등 분할 (R11/R12)

water-fill 결과 워커마다 배정 VU가 다를 수 있다. 데이터셋 `unique` 정책을 쓸 때 알아둘 점:

- **disjointness는 보존된다.** 각 데이터셋 행은 전체 워커를 통틀어 최대 1회만 소비된다 — 각 워커는 `dataset_slice`가 만드는 disjoint 슬라이스(행을 워커 수로 균등 분할, VU 분할과 독립)를 받으므로 uniqueness 정확성 위험은 없다.
- **소비 속도가 불균등해진다.** VU를 더 많이 받은 워커가 자기 슬라이스를 더 빨리 소진하므로, 그 워커에서 stop-on-exhaust가 더 일찍 발생할 수 있다.
- **비례 분할(capacity 비율로 행 수 조정)은 후속 예정이다.** L3에서는 행 수를 균등하게 나눈다.

---

## 5. 빈 풀 동작

유휴 워커가 0이면 run이 **즉시 실패**한다:

```
400 연결된 LAN 워커가 없습니다 — 워커를 1대 이상 띄우세요
```

run 생성 전에 워커가 컨트롤러에 연결·등록됐는지 확인한다(컨트롤러 로그에 `worker registered` 라인).

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

- `/api/pool/workers` 대시보드 엔드포인트는 인증 없이 접근 가능하다. LAN 상의 누구나 워커 hostname·worker_id·실행 중 run_id 같은 인프라 메타데이터를 조회할 수 있다(시크릿·토큰은 노출되지 않음). 전면 인증 및 mTLS는 L3 후속 예정이다.

---

## 7. 풀 상태 보기 (L2 — `/workers` 대시보드)

### 대시보드 접속

웹 UI 상단 네비게이션의 **'워커'** 항목을 클릭하거나 `/workers`로 직접 이동한다.

**표시 정보**

| 열 | 내용 |
|----|------|
| 호스트 | 워커 PC의 hostname |
| 워커 ID | 자동 발급 ULID (또는 `--worker-id`로 지정한 값) |
| 상태 | `유휴` / `실행 중` — 실행 중이면 해당 run으로 이동하는 링크 표시 |
| 용량(VU) | `--capacity-vus` 선언값 (closed-loop 배정에 반영됨 — §4 참조) |

페이지 상단에 **유휴 / 실행 중 워커 수**가 요약 표시된다. 풀 모드일 때 ~3초 간격으로 자동 갱신된다.

**풀 모드가 아닌 컨트롤러**(`--worker-mode pool` 없이 기동)에서는 대시보드에 빈-상태 안내가 표시된다.

### RunDialog 프리뷰

풀 모드에서 **run 생성 다이얼로그**를 열면 "연결된 유휴 워커 N대" 안내가 표시된다(읽기 전용). 실제 사용 워커 수는 컨트롤러가 run 발사 시 결정한다(`min(유휴_워커_수, 부하_상한)` — §3 참조).

---

## 7a. ⚠ 대시보드 라이브니스 한계

대시보드의 "연결됨" 표시는 **gRPC 스트림이 현재 열려 있음** 기준이다. 하트비트가 없다.

| 종료 유형 | 대시보드 반영 |
|-----------|-------------|
| 워커 프로세스 정상 종료 (`Ctrl-C` / `SIGTERM`) | 스트림이 즉시 닫혀 목록에서 즉시 사라짐 |
| `kill -9` (SIGKILL) | OS가 TCP 연결을 정리하므로 빠르게 사라짐 |
| **네트워크 비정상 단절·PC 절전(half-open TCP)** | 전송 타임아웃(수십 초~수분) 전까지 **유령 워커**로 남을 수 있음 |

유령 워커가 남은 상태에서 run을 발사하면 해당 워커가 배정은 됐으나 실제 통신이 되지 않아 run이 실패 또는 지연될 수 있다.

**완화 방법 (L1+L2 현재)**

- 워커 재기동 후 대시보드에서 호스트명이 새로 등록됐는지 확인한다.
- 유령 워커가 의심되면 해당 워커 PC를 재기동한 뒤 다시 접속시킨다.
- 불확실하면 run을 한 번 발사해 실패 여부로 연결 상태를 확인한다.

> 하트비트 / last-seen 기반 staleness 판정 및 자동 제거는 **L3 후속**에서 추가될 예정이다.

---

## 8. L1–L4 한도 요약

| 항목 | 현재 동작 |
|------|---------|
| 워커 재연결 | run 완료 후 자동 reconnect-per-run (sub-second) |
| 과부하 가드 (closed-loop) | capacity-aware 배정 (water-fill, `--capacity-vus` 존중, 초과 시 409 또는 `?force=true` 강행) |
| 과부하 가드 (open-loop fixed/curve) | capacity-aware 배정 (L4 — 슬롯=capacity_split·레이트 비례·N 레이트-상한·409/강행 동일) |
| 과부하 가드 (VU 곡선 `vu_stages`) | 미적용 — N=1 legacy 경로 (별도 슬라이스 예정) |
| 채널 보안 | 평문 gRPC + 공유 토큰(접근 통제 only) |
| 단일 PC 한도 | 기존 subprocess 모드와 동일 |
| 멀티 컨트롤러 | 미지원 (워커는 컨트롤러 1개에만 연결) |
| 라이브니스 | gRPC 스트림 기반 (하트비트 없음 — 유령 워커 가능, L3 후속) |

---

## 9. 빠른 로컬 검증 (pool 모드 동일 PC)

LAN이 없는 환경에서 pool 모드를 확인하려면 같은 PC에서 loopback으로 실행할 수 있다:

```bash
# 1. 바이너리 빌드
cargo build -p handicap-worker --bin worker
cargo build -p handicap-controller --bin controller

# 2. pool 컨트롤러 (격리 DB)
./target/debug/controller \
  --db /tmp/lan-l1-test.db \
  --ui-dir ui/dist \
  --worker-mode pool \
  --grpc 127.0.0.1:8091 \
  --rest 127.0.0.1:8090 \
  --worker-token SECRET &

# 3. 풀 워커 2개 (--run-id 없이)
./target/debug/worker --controller http://127.0.0.1:8091 --token SECRET &
./target/debug/worker --controller http://127.0.0.1:8091 --token SECRET &

# 4. 브라우저로 http://localhost:8090 접속, run 생성 → 워커 2개 사용 확인
```

완료 후 정리:

```bash
kill %1 %2 %3   # 컨트롤러 + 워커 2개
rm /tmp/lan-l1-test.db
```
