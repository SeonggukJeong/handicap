# Slice 7 — UI 수동 점검 (Loop 노드)

Slice 4·5의 점검 환경(`docs/dev/ui-slice-4-manual-check.md`)을 그대로 사용 —
**로컬 dev (subprocess)**: wiremock + `cargo run --bin controller` +
`cargo run --bin worker` + `cd ui && pnpm dev`. K8s 띄우지 않음(로컬 dev에서는
worker가 호스트 프로세스라 wiremock을 `localhost`로 바로 친다 — Slice 6 kind
점검의 cluster-DNS 두-주소 함정이 여기엔 없다).

각 체크박스를 진행하며 확인한다. 하나라도 실패하면 슬라이스를 미완으로 보고
merge 전에 follow-up을 만든다.

## 사전 — 로컬 dev 기동 (입력할 명령어)

세 개의 터미널. `--worker-mode`는 기본값 `subprocess`라 **controller가 worker를
직접 spawn**한다 — `cargo run --bin worker`를 따로 띄우지 않는다(그래서 사전에
worker 바이너리 빌드가 필요). `just run-controller` / `just ui-dev`로도 동일.

```bash
# T0 — wiremock 기반 가짜 API (별도 터미널). 9090 = 호스트 포트.
docker run --rm -p 9090:8080 \
  -e WIREMOCK_OPTIONS="--global-response-templating" \
  wiremock/wiremock:3.7.0

# 사전 — worker 바이너리 빌드 (controller의 --worker-bin 기본값이 target/debug/worker).
#         안 하면 controller가 run 시작 시 worker를 spawn하지 못한다.
cargo build -p handicap-worker

# T1 — controller (REST 8080 + gRPC 8081; UI는 vite가 띄움). = just run-controller
#      handicap-controller 패키지엔 controller + e2e_kind_driver 두 바이너리가
#      있어 --bin controller 가 필수(없으면 "could not determine which binary").
RUST_LOG=info,handicap_controller=debug,handicap_engine=debug \
cargo run -p handicap-controller --bin controller -- \
  --db ./handicap.db \
  --rest 127.0.0.1:8080 \
  --grpc 127.0.0.1:8081 \
  --worker-bin target/debug/worker

# T2 — UI dev 서버 (HMR + /api는 127.0.0.1:8080 controller로 proxy). = just ui-dev
cd ui && pnpm dev
```

`http://localhost:5173` 접속. 새 기능이 안 보이면 다른 워크트리/마스터의 vite
(포트 5173)나 controller(8080)가 선점했는지부터 확인(`lsof -i :5173`,
`lsof -i :8080` → `ps -o cwd= -p <PID>`) — CLAUDE.md Slice 5 함정.

> 정적 SPA까지 controller가 서빙해야 하면 `just run-controller-with-ui`
> (ui/dist 빌드 후 `--ui-dir ui/dist`). 점검은 vite dev 권장(HMR).

## 사전 — wiremock stub 등록

`${loop_index}`가 0..repeat로 렌더되는 것을 **눈으로** 확인하려면 루프 본문이
때리는 경로를 인덱스별로 따로 stub 한다. wiremock admin API(`/__admin/mappings`)로
등록. (Slice 4 매뉴얼의 stub 등록 절차와 동일 클래스 — 빠뜨리면 매칭 안 되는
요청이 404로 떨어지고 status가 비정상으로 찍힌다.)

로컬 dev wiremock은 `localhost:9090`에 띄운다고 가정(Slice 4·5와 동일). 인덱스
0·1·2 + 합산 검증용 `/tick`을 등록:

```bash
for i in 0 1 2; do
  curl -sX POST "http://localhost:9090/__admin/mappings" \
    -H 'Content-Type: application/json' \
    -d "{\"request\":{\"method\":\"GET\",\"url\":\"/item/$i\"},\"response\":{\"status\":200}}" >/dev/null
done
curl -sX POST "http://localhost:9090/__admin/mappings" \
  -H 'Content-Type: application/json' \
  -d '{"request":{"method":"GET","url":"/tick"},"response":{"status":200}}' >/dev/null
# 등록 확인 (health 단독으로 끝내지 말고 mappings를 실제로 read):
curl -s "http://localhost:9090/__admin/mappings" | python3 -m json.tool | grep -E '/item/|/tick'
```

## §1 — 캔버스에서 루프 만들기

1. `/scenarios/new` → 캔버스 탭.
2. **"+ Add loop"** 클릭 → 점선 테두리의 루프 컨테이너 노드가 생기고, 그 안에
   http 자식 스텝 하나("Step 1")가 들어있는지 확인. 헤더에 `× 1` repeat 배지.
3. 루프 컨테이너를 선택(클릭) → Inspector가 **Loop** 패널로 바뀜.
4. Inspector **Repeat** 필드에 `3` 입력 후 blur(Tab/다른 곳 클릭) → 배지가
   `× 3`으로 갱신. (onBlur commit — 키 입력마다 반영되지 않음. 1 미만/비정수면
   직전 값으로 되돌아감.)
5. 루프가 선택된 상태에서 좌하단 버튼이 **"+ Add step in loop"**로 바뀌었는지
   확인 → 클릭하면 자식이 루프 본문에 추가되어 컨테이너 높이가 늘어남.
6. 빈 공간(pane) 클릭으로 선택 해제 → 버튼이 다시 **"+ Add step"**로. 이 상태로
   클릭하면 **top-level** 스텝이 추가됨(루프 밖). (루프 *자식*을 선택한 상태에서
   "+ Add step"는 top-level 추가로 떨어진다 — 자식 선택은 부모 루프를 타겟하지
   않음. 의도된 동작.)
7. 자식 스텝의 URL을 wiremock 인덱스 경로로: 자식 클릭 → Inspector(http) → URL을
   `${BASE_URL}/item/${loop_index}` 로. method GET, assert `status: 200`.
8. 시나리오 이름을 주고 **Save**.

## §2 — YAML 라운드트립 (양방향 sync)

1. YAML 탭으로 전환.
2. 확인: 최상위 스텝이 `type: loop`, `repeat: 3`, 그 아래 `do:` 배열에 자식이
   `type: http`로 들어있고 URL이 `${BASE_URL}/item/${loop_index}`.
3. YAML에서 `do:` 안 임의 키 옆에 `# 코멘트`를 직접 적고, 다른 키 하나를 수정 →
   캔버스 탭으로 갔다 돌아와도 그 코멘트가 보존되는지 확인. (targeted `setIn`이
   sibling 코멘트를 보존. 단 스텝을 통째로 add/remove하면 그 안 코멘트는 사라짐 —
   알려진 한계.)
4. YAML에서 직접 `repeat: 5`로 바꾸고 캔버스로 전환 → 배지가 `× 5`인지.
5. (음성 확인) `do:` 안에 또 `type: loop`를 손으로 넣어보면 → 캔버스 전환 시
   Zod 검증 실패로 inline 에러(중첩 루프는 단일 레벨 제약상 거부). `repeat: 0`도
   거부.

## §3 — Inspector 점검

1. 루프 선택 → Loop 패널에 Name·Repeat 필드와 **Body steps** 목록(자식들이
   `name` + `method url`로 나열). 자식 항목 클릭 시 그 자식이 선택되어 http
   Inspector로 전환되는지.
2. 루프 본문 자식을 선택 → http Inspector에서 method/URL/headers/body/assert/
   extract 편집이 모두 동작. **move up/down 버튼이 루프 본문 안에서만** 클램프
   되는지(자식이 2개 이상일 때 첫/마지막에서 비활성). top-level 스텝의 move와
   섞이지 않음.
3. 루프 Delete 버튼 → 루프와 그 본문 전체가 사라짐.

## §4 — 실행 + 리포트

1. **Run** 다이얼로그: `vus=1`, `duration=5`, `ramp_up=0`,
   `env: BASE_URL=http://localhost:9090`. **Loop breakdown cap**은 기본값
   `256` 그대로 둔다(§4-1에서 0·2로 바꿔가며 확인). 10001 이상을 넣으면 입력
   아래 `0 ~ 10000 사이여야 합니다.` 에러가 뜨고 Run 버튼이 비활성(서버도
   400으로 거부 — client/server 이중 가드).
2. 종료(`completed`) 후 Report 뷰 전환.
3. **Per-step stats 테이블**: 루프 본문 안의 http 스텝이 **이름**으로 라벨됨
   (raw ULID 아님 — `flattenHttpSteps`가 `do:`를 재귀 평탄화). 그 스텝의 요청수
   `count`가 `repeat`(3)의 배수에 가깝고 errors=0. (run window가 마지막 루프를
   mid-body로 자르면 정확한 배수가 아닐 수 있음 — 정상.)
4. `${loop_index}` 렌더 확인: wiremock 요청 저널에서 `/item/0`·`/item/1`·
   `/item/2`가 각각 맞은 횟수를 본다:
   ```bash
   curl -s "http://localhost:9090/__admin/requests" \
     | python3 -c "import json,sys,collections; \
   reqs=[r['request']['url'] for r in json.load(sys.stdin)['requests']]; \
   print(collections.Counter(u for u in reqs if u.startswith('/item/')))"
   ```
   세 경로가 (거의) 같은 횟수로 찍혀야 함 — `${loop_index}`가 0·1·2로 렌더된
   증거. 전부 `/item/${loop_index}` 그대로거나 한 경로만 찍히면 회귀.
5. **Download JSON** → `steps[]`에 내부 스텝 id가 들어있고 `summary.count`가
   `count(per-step) × distinct path`만큼 잡히는지 가볍게 확인.

## §4-1 — Loop breakdown drill-down (Slice 7-1)

루프 본문 스텝의 `loop_index`별 요청수/에러수를 **접이식 drill-down**으로
확인한다. 메인 Steps 표는 §4 그대로(접힌 상태) — 새 칸이 추가되거나 레이아웃이
바뀌지 않아야 한다. 자세한 설계 → ADR-0021.

### cap=256 (기본, overflow 없음)

1. §4의 run(`Loop breakdown cap=256`, `repeat: 3`)이 `completed`된 Report 화면.
2. Per-step stats 표에서 **루프 본문 http 스텝 행**의 이름 왼쪽에 caret(`▸`)
   토글 버튼이 보이는지 확인. top-level(루프 밖) 스텝·http-only 시나리오에는
   caret이 **없어야** 한다(`loop_breakdown`이 비어있으므로).
3. caret 클릭 → 행 아래로 내부 표가 펼쳐짐(`▾`). 컬럼: `loop_index │ requests
   │ errors`. `loop_index` 0·1·2 세 행이 각각 `requests > 0`, `errors = 0`.
4. 세 버킷 requests 합 == 메인 행의 `count`(스텝 총 요청수)와 같아야 함.
   (run window가 마지막 루프를 mid-body로 잘라도 두 수치는 같은 "완료된
   요청"만 세므로 일치 — overflow가 없을 때 정확히 등호.)
5. **`그 외 (상한 초과)` 행은 없어야 함** (repeat 3 < cap 256이라 overflow 버킷
   미발생).
6. caret 다시 클릭 → 접힘. 다른 스텝 caret과 독립적으로 토글되는지(여러 스텝이
   루프면) 확인.

### cap=2 (overflow 버킷 확인)

1. 같은 시나리오를 **Loop breakdown cap=2**로 다시 Run → `completed` 후 Report.
2. drill-down을 펼치면: `loop_index` 0·1 두 행 + 맨 아래 **`그 외 (상한 초과)`**
   행 1개. index 2(>= cap 2)가 overflow 버킷으로 접혔다는 증거.
3. overflow 행의 requests > 0, errors = 0. 0·1·overflow 합 == 스텝 `count`.

### cap=0 (끄기)

1. 같은 시나리오를 **Loop breakdown cap=0**으로 Run → `completed` 후 Report.
2. 루프 본문 스텝 행에 **caret이 아예 없음**(집계 자체를 안 함 →
   `loop_breakdown` 빈 배열 → 토글 미표시). 메인 표는 §4와 동일하게 동작.

### JSON 다운로드 교차 확인

1. Report의 **Download JSON** → `steps[]` 각 항목에 `loop_breakdown` 배열이 있고
   (cap>0 run) 버킷의 `loop_index`(숫자, overflow는 `null`)·`count`·
   `error_count`가 화면 drill-down과 일치하는지. cap=0 run은 `loop_breakdown`이
   `[]`.
2. wiremock 저널(§4.4의 `/__admin/requests` 카운트)과 cap=256 drill-down의
   index별 requests가 (거의) 맞아떨어지는지 — `${loop_index}` 렌더와 집계가 같은
   진실을 가리키는지 최종 교차 검증.

## §5 — 게이트

- `cd ui && pnpm lint && pnpm test && pnpm build` 통과 (특히 `pnpm build`의
  `tsc -b` — discriminated union narrowing이 최종 게이트).
- `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings &&
  cargo test --workspace` 통과.
- 처리량 회귀 점검(선택, Docker 필요): `just bench-throughput` (flat) 대비
  `SCENARIO_KIND=loop just bench-throughput` 가 ~5% 이내·p95/p99 동일.
  breakdown ON/OFF A/B: `SCENARIO_KIND=loop LOOP_CAP=0 just bench-throughput`
  대비 `SCENARIO_KIND=loop LOOP_CAP=256 just bench-throughput` 가 run-to-run
  변동(±~5%) 내(post-impl baseline: cap0 ~19,086 RPS / cap256 ~21,254 RPS, p95
  18→16ms — 회귀 없음).
- CLAUDE.md "Slice 7 결과:"·"Slice 7-1 결과:" 단락 + "Slice 7에서/7-1에서 배운
  함정들" 섹션, ADR-0020·ADR-0021 존재.

## 알려진 한계 (Slice 7 범위, ADR-0020 참고)

- **단일 레벨만**: 루프 본문은 http 스텝만(중첩 루프 불가, UI Zod가 거부).
  엔진 타입(`do_: Vec<Step>`)은 중첩을 허용하지만 authoring gate가 막는다 —
  중첩 루프는 후속 슬라이스.
- **`repeat`는 정수 리터럴**: `repeat: ${COUNT}` 같은 템플릿 repeat 미지원(후속).
- **data-driven 루프**(데이터셋 foreach) 미지원 — 향후.
- **conditional / parallel 노드**는 각각 Slice 8 / Slice 9 (같은 컨테이너 패턴).
- `${loop_index}`는 스칼라라 (중첩이 생기면) 안쪽이 바깥 인덱스를 가린다 —
  단일 레벨에선 무관, 중첩 슬라이스에서 scoped map으로 교체 예정.
