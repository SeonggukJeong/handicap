---
name: perf-ab
description: Use when a handicap change touches the worker's per-request path (engine executor/template/extract/metrics, reqwest or build flags, parser changes) and you need to know whether it made the worker slower or faster than a base ref — "성능 비교", "워커 CPU A/B", "요청당 CPU", "master 대비 느려졌나", perf regression check before merge. Invoke via /perf-ab [base-ref]. Not for latency of the system under test and not for UI changes.
---

# perf-ab — 기준 ref 대 작업 트리 워커 CPU 비교

부하 run의 지연(p50 등)은 본문을 받기 *전*에 재므로 파싱·추출·집계 비용이 안 보인다. 그래서 **워커가 CPU 한계인 포화 상태에서 요청당 워커 CPU(user+sys ÷ 요청 수)** 를 기준 ref와 작업 트리 사이에서 잰다. 준비·측정·판독을 `perf_ab.py` 하나가 한다 — 매번 도구를 새로 만들지 말 것.

## 실행 (변경이 있는 체크아웃/워크트리 root에서, 단독 명령으로)

```bash
python3 .claude/skills/perf-ab/perf_ab.py --base-ref master
```

- 첫 실행은 release 빌드 두 벌(기준 + 작업 트리)이라 수 분 — `run_in_background`로 돌리고 그동안 다른 `cargo` 금지(`target/` 락). 기준 빌드는 `/tmp/perf-ab-<디렉토리명>/`에 남아 같은 ref면 다시 안 만든다.
- 작업 트리 쪽은 **커밋 안 된 변경까지 포함**해 빌드한다(출력 첫머리에 `+ uncommitted changes` 표시).
- 옵션: `--rounds 6`(측정 횟수) `--warmup 1` `--vus 50` `--seconds 20` `--scenario <yaml>`(주소 자리에 `{RESPONDER}`) `--port-shift N` `--skip-build`. 전체는 스크립트 머리 주석.
- 기본 시나리오는 GET 한 스텝·think 없음. **바꾼 경로가 그 스텝에 안 걸리면 차이가 안 보인다** — 추출·템플릿·본문 파싱을 고쳤으면 그걸 쓰는 시나리오를 `--scenario`로 준다. 스텝 id에 `I`·`L`·`O`·`U` 금지.

## 스크립트가 하는 일

1. `git archive`로 기준 ref의 `Cargo.*`·`rust-toolchain.toml`·`crates`만 꺼내 별도 `CARGO_TARGET_DIR`(절대경로)에서 worker·controller release 빌드. 작업 트리는 그 자리 `target/release`.
2. 쪽마다 **자기 컨트롤러**(와이어가 달라졌을 수 있다)를 관례 밖 포트(18099/18098, 18199/18198)에 띄우고 `--worker-bin`에 `exec /usr/bin/time -l <워커> "$@"` 감싸개를 준다. 포트가 이미 쓰이면 죽이지 않고 멈춘다 → `--port-shift`.
3. 지연 0 응답기(`live-verify/responder.py`, keep-alive) 하나에 두 쪽을 **교차**(base·head·head·base…)로 돌리고, run마다 컨트롤러 로그의 `time` 줄에서 user+sys를 읽는다(여러 워커로 나뉜 run은 합산).
4. run마다 `completed`·오류 0·상태 코드가 200뿐인지 확인 — 아니면 그 run을 빼고 종료 코드 1.
5. 쪽별 평균·최소·최대·흔들림 폭, 차이 %, **두 쪽 범위가 겹치는지** 출력.

## 판독

| 출력 | 뜻 |
|---|---|
| `ranges OVERLAP` | 차이가 run 사이 흔들림 안 — **「변화 없음(측정 한계 ±N%)」로 보고**, 차이 %를 결과처럼 쓰지 않는다 |
| `ranges DO NOT overlap` | 흔들림보다 큰 차이 — 차이 %와 양쪽 범위를 함께 보고 |
| `WARNING: machine is busy` / load가 전후로 크게 다름 | 숫자를 믿지 말 것 — 다른 빌드·VM이 끝난 뒤 `--skip-build`로 다시 |
| `!! status codes …` · `errors=` | 진짜 200이 아닌 요청이 섞였다 — fail-fast는 CPU가 싸서 거짓 「빨라짐」을 만든다. 원인부터 |
| `rps` 차이만 크고 `cpu/req`는 같음 | 워커가 아니라 응답기·기계 쪽 사정(기본값에선 응답기가 RPS 상한) |

기록할 때는 기준·작업 SHA, VU·길이·횟수, 양쪽 평균과 범위, 겹침 여부를 build-log에 한 줄로.

## 함정

- 흔들림 폭이 몇 %씩 나오면 `--rounds`·`--seconds`를 늘린다. 기준과 작업이 같은 커밋이면 A/A(흔들림 바닥 확인용)라고 스스로 알린다 — 작은 차이를 주장하기 전에 한 번 돌려 볼 값.
- 번들 응답기는 asyncio 단일 스레드로 지연 0에서 초당 약 10만 건까지 받는다. 기본값(VU 50)이면 RPS가 그 한계에 붙는다(실측 초당 10.6만 건, 워커 CPU 약 2.7코어) — **그래서 `rps`는 두 쪽을 가르는 값이 아니고 `cpu/req`만 본다.** 요청당 CPU는 응답기가 한계여도 유효하다.
- 빌드 직후에는 load 평균이 빌드 여파로 높게 찍힌다(안내 줄이 그렇게 말한다) — 그때는 흔들림 폭으로 판단하고, `--skip-build`인데 `WARNING`이면 진짜 바쁜 것.
- 메인 체크아웃의 `target/debug`·`target/release`는 다른 브랜치 것일 수 있다 — `--skip-build`는 직전 실행 뒤 소스를 안 바꿨을 때만.
- macOS 전용(`/usr/bin/time -l` 줄 형식). 끝나면 띄운 프로세스는 스크립트가 내린다. 디스크를 비우려면 `rm -rf /tmp/perf-ab-<디렉토리명>`(기준 빌드 수 GB).
- 빌드 플래그만 다른 두 벌 비교처럼 「ref 대 작업 트리」가 아닌 경우의 손 절차 → `docs/dev/live-verify-backend.md` §워커 CPU 비용 A/B.
