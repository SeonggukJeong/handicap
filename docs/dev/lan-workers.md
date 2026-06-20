# LAN 분산 워커 운영 런북 (ADR-0041, L1)

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
- `--capacity-vus`는 L1에서 서버 사이드 배정에 반영되지 않는다(아래 경고 참조).

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

## 4. ⚠ 과부하 미가드 경고 (L1 한계)

L1은 각 워커 PC의 `--capacity-vus`를 배정 시 **무시**한다. 컨트롤러는 `vus`를 유휴 워커 수로 단순 분할하므로, 워커당 배정 VU가 그 PC의 처리 능력을 초과할 수 있다.

예: 워커 2대, `vus: 100` → 각 워커가 VU 50개를 받는다. PC 능력이 VU 20개 한도라도 50개가 배정된다.

**L2에서 `capacity-vus` 기반 배정 가드를 추가할 예정.** L1에서는 `vus`를 PC 수에 맞게 수동으로 계산해 설정할 것.

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

---

## 7. L1 한도 요약

| 항목 | L1 동작 |
|------|---------|
| 워커 재연결 | run 완료 후 자동 reconnect-per-run (sub-second) |
| 과부하 가드 | 없음 — `capacity-vus` 무시, VU를 단순 분할 |
| 채널 보안 | 평문 gRPC + 공유 토큰(접근 통제 only) |
| 단일 PC 한도 | 기존 subprocess 모드와 동일 |
| 멀티 컨트롤러 | 미지원 (워커는 컨트롤러 1개에만 연결) |

---

## 8. 빠른 로컬 검증 (pool 모드 동일 PC)

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
