# 용량 산정 가이드 — "RPS N을 낼 수 있나? 리소스는 얼마나?"

> **이 문서의 목적**: "RPS 10,000으로 돌리고 싶은데 컴퓨팅이 받쳐줄까?", "최대 RPS는 얼마고 리소스를 얼마나 늘려야 하나?" 같은 **용량 산정** 질문에 대한 운영 가이드. Handicap은 부하 *생성기*지 용량 *플래너*가 아니라서 자동 추천 기능은 (아직) 없다 — 대신 천장을 **경험적으로 한 번의 램프 테스트로 찾는 방법**과 그때 봐야 할 신호를 정리한다.
>
> 자동 추천(포화 인사이트) 기능 후보는 `docs/roadmap.md` §A9.

---

## 0. 핵심: "용량"이 두 개다 (섞으면 안 됨)

| 무엇의 한계인가 | 포화 신호 | 어디서 보나 |
|---|---|---|
| **대상 서비스(SUT)의 한계** — 보통 진짜 알고 싶은 것 | 에러율↑, p95/p99 latency가 무릎처럼 꺾임. `summary.rps`는 target과 비슷하게 유지될 수 있음 | SLO criteria(ADR-0028) + latency 분포(B7-D) |
| **부하 생성기(Handicap 워커)의 한계** — "내 컴퓨팅이 받쳐주나" | **`dropped > 0`** **이면서** `summary.rps`가 `target_rps`보다 낮게 주저앉음 | open-loop `dropped` 카운터 + `summary.rps` |

이 둘을 구분 못 하면 "SUT가 느린 것"과 "부하기가 못 따라간 것"을 헷갈린다. 대부분의 경우 먼저 꺾이는 건 SUT 쪽이고, 그게 사실 보고 싶은 답이다.

### `dropped`의 정확한 의미

`crates/engine/src/runner.rs:1231` (open-loop 스케줄러):

> 스케줄러 틱이 발사됐는데 `max_in_flight` 슬롯이 전부 사용 중이라 요청을 못 띄운 횟수.

즉 **`dropped > 0` = "내 부하기가 그 도착률을 못 따라갔다"는 직접 증거**다. 리포트 JSON 최상위 `dropped` 필드(`report.rs:27`, `runs.dropped` 컬럼, migration 0009)로 노출되고 UI Summary에 표시된다. run-total 한 값(초별 분해 없음, final flush에서만 집계).

### `summary.rps`의 정확한 의미

`crates/controller/src/report.rs:470`:

```
summary.rps = total_count / (duration_ms / 1000)   # = 달성(achieved) RPS
```

실제로 완료된 요청 수 ÷ wall-clock 시간 = **달성 RPS**. 목표(`target_rps`)와 비교해 `achieved << target`이면 어딘가 포화다(부하기 또는 SUT).

---

## 1. 지금 당장 천장을 찾는 법 (권장 절차)

목표 RPS를 바로 때리지 말고 **multi-stage open-loop 램프**(ADR-0032)로 올린다.

```jsonc
POST /api/runs
{
  "scenario_id": "...",
  "profile": {
    "max_in_flight": 600,            // ← §3 Little's Law로 산정 (추측 금지)
    "stages": [
      {"target": 1000,  "duration": 30},
      {"target": 4000,  "duration": 30},
      {"target": 8000,  "duration": 30},
      {"target": 12000, "duration": 30}
    ]
  },
  "env": {}
}
```

리포트에서 두 가지만 본다:

1. **`dropped`가 0에서 증가하기 시작하는 지점**, 또는 **`summary.rps`가 `target`을 더 이상 따라가지 못하는 지점** → 그게 **현재 하드웨어에서 부하기의 천장**.
2. 그 전에 **에러율 / latency SLO가 먼저 꺾이면** → 천장은 부하기가 아니라 **SUT 쪽**(이게 더 흔하고, 보통 더 보고 싶은 답).

`dropped = 0` 이고 `summary.rps ≈ 10000` 으로 끝나면 → **현재 워커 하나로 10k가 된다.**

> 로컬 수동 검증 레시피는 루트 `CLAUDE.md`의 "부하 페이싱/타임아웃 기능은 RPS로 수동 검증"(python `ThreadingHTTPServer` 200-responder + controller subprocess + 격리 DB) 참조.

---

## 2. 두 부하 모델과 RPS의 관계

| 모델 | RPS가 정해지는 방식 | 수평 확장(멀티워커) |
|---|---|---|
| **open-loop** (`target_rps`/`stages`, ADR-0031) | 스케줄러가 목표 도착률로 틱 발사, 동시성 상한 = `max_in_flight` | **❌ 안 됨 (단일워커 v1)** — 아래 §4 함정 |
| **closed-loop** (`vus`, ADR-0016, tokio task per VU) | RPS = VU수 ÷ 평균 응답시간 (레이트 캡 없음, latency에 따라 떠다님) | **✅ 됨** — VU가 워커들에 분배(ADR-0027) |

- **레이트를 정확히 고정하고 싶다** → open-loop. 단 단일워커 예산 안에서.
- **한 머신으로 안 되고 수평으로 펼쳐야 한다** → closed-loop. RPS는 정확히 못 고정하지만(latency에 따라 변동) VU를 늘려 확장 가능. 예: 50ms 응답이면 `~500 VU ≈ 10k RPS`.

---

## 3. 사이징: `max_in_flight`는 추측 말고 Little's Law로

이게 첫 번째 손잡이다. **필요 동시성 = target_RPS × 평균 응답시간**:

| target | 평균 latency | 필요한 `max_in_flight` (≈) |
|---|---|---|
| 10,000 RPS | 50 ms | ~500 |
| 10,000 RPS | 200 ms | ~2,000 |

`max_in_flight`가 이보다 작으면 **SUT가 멀쩡해도** `dropped`가 뜬다(부하기가 스스로 막는 것). 슬롯풀 구현 = `runner.rs:1037` (`Vec<Arc<VuClient>>`, 슬롯=재사용 cookie jar).

closed-loop에서도 같은 식이 역방향으로 쓰인다: **필요 VU = target_RPS × 평균 응답시간**.

---

## 4. ⚠️ 함정: open-loop은 RPS가 수평 확장되지 않는다 (단일워커 v1)

레이트를 직접 제어하는 유일한 모드인 open-loop은 **멀티워커로 RPS가 분담되지 않는다.**

멀티워커 fan-out 코드(`crates/controller/src/grpc/coordinator.rs:282`)는 프로필을 **그대로 복제**해서 각 워커에 준다 — VU는 `shard_split`으로 쪼개지지만 **`target_rps`는 안 쪼개진다.** 즉 워커가 N대면 각자 full `target_rps`로 발사 → 합계 `target_rps × N`.

ADR-0031이 open-loop을 **"단일워커 v1"** 로 명시한 이유가 이것. 그래서:

- **open-loop 10k RPS는 워커 *하나*의 예산으로 봐야 한다.** §3 사이징은 단일 워커의 CPU limit·`max_in_flight`를 올리는 방향.
- 워커 수는 `worker_count = ceil(total_vus / capacityVus)`(`grpc/shard.rs:5`)로 정해지는데, open-loop은 `vus`를 실행에서 무시하면서도 이 산식엔 `vus`가 들어간다 — **큰 `vus`를 open-loop 프로필에 같이 넣으면 의도치 않게 N>1 워커가 떠 각자 full rate로 도는 사고**가 날 수 있다. open-loop은 `vus`를 비우거나 작게 둘 것. (이 정밀한 상호작용 검증은 §A9 / B2'' 멀티워커 연기 항목.)
- **수평 확장이 필요하면 open-loop이 아니라 closed-loop**(§2).

---

## 5. 워커 리소스 기본값과 "얼마나 더 늘려야 하나"

| 항목 | 기본값 | 출처 |
|---|---|---|
| 워커 CPU (request==limit, Guaranteed QoS) | **250m** (1/4 코어) | `crates/controller/src/dispatcher/k8s_spec.rs:35` |
| 워커 메모리 (request==limit) | **256Mi** | 〃 |
| `worker.capacityVus` (워커당 VU 용량 = fan-out N 레버) | **2000** | `deploy/helm/handicap/values.yaml:30`, `coordinator.rs:30` |

**1/4 코어로 실제 HTTP(특히 TLS/keep-alive) 10k RPS를 뽑는 건 비현실적이다.** 코어당 가능한 RPS는 페이로드·TLS·keep-alive·응답 크기에 크게 좌우되므로 **단정하지 말고 측정**한다:

1. 250m 워커 하나로 **1,000 RPS 베이스라인** open-loop run을 돌린다.
2. `dropped = 0` 이고 `summary.rps ≈ 1000` 이며 CPU 여유가 있나 확인(파드 메트릭/`kubectl top`).
3. 여유가 있으면 target을 2k, 4k…로 올려 §1 절차로 천장을 찾는다.
4. 천장이 목표(10k)보다 낮으면 **단일 워커의 CPU limit을 코어 단위(예 `2`~`4`)로 올린다**(open-loop이라 워커 추가로는 RPS가 안 늘기 때문 — §4).

> per-deploy 워커 cpu/mem을 Helm values로 올리는 배선은 아직 미구현(연기, roadmap §B2''). 현재는 `WorkerResources::default()`가 코드에 박혀 있고 Helm으로 노출된 건 `capacityVus`뿐. 고처리량 프로덕션 도입 시 이 배선이 선행돼야 함.

---

## 6. 요약 (체크리스트)

- [ ] **자동 추천값은 없다.** 위 §1 램프 한 번으로 `dropped`/`achieved rps`를 보면 현재 하드웨어 천장이 나온다.
- [ ] **두 용량 구분**: SUT 한계(에러율/latency) vs 부하기 한계(`dropped>0` + `rps<<target`).
- [ ] **사이징은 Little's Law**: `max_in_flight ≥ target × latency`(open-loop), `vus ≥ target × latency`(closed-loop).
- [ ] **수평 확장이 필요하면 closed-loop** — open-loop은 단일워커 v1, `target_rps` 복제 함정(§4).
- [ ] **기본 250m 워커는 10k엔 턱없이 부족** — 1k 베이스라인에서 측정·외삽 후 코어 단위로 증설.
