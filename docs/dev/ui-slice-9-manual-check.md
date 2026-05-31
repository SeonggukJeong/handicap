# Slice 9 — Conditional(`if`) 노드 수동 점검 매뉴얼

머지 직전(또는 회귀 점검 시) 실행. **`just` 기반 실행 명령부터 차근차근.** 자동 검증은
이미 충분하다(엔진 `tests/if_node.rs` unit/integration, controller `report.rs` 단위 +
`e2e_test.rs::if_branch_report_e2e_smoke`, UI RTL `BranchStatsTable.test.tsx`/`ReportView.test.tsx`)
— 이 매뉴얼은 사람이 실제 UI로 if 노드를 **만들고**, 조건이 **의도대로 분기**하며,
**분기 결정 카운터(9d)** 가 리포트에 맞게 뜨는지 직접 확인하기 위한 것이다.

Slice 9가 다루는 범위 (= 점검 대상):

| 하위 슬라이스 | 내용 | 이 매뉴얼 섹션 |
|---|---|---|
| **9a** | 엔진: `type: if` + 재귀 조건 트리 + 10개 연산자 + lenient 평가 + 인터프리터 | §6 (실행·분기 라우팅), §6-1 (연산자 의미) |
| **9b** | UI authoring: 캔버스 if 컨테이너 + 인스펙터 조건 빌더 + YAML 양방향 sync | §4 (캔버스), §4-1 (조건 빌더), §5 (YAML) |
| **9c** | 상호 1레벨 중첩: if-in-loop / loop-in-if (if-in-if·loop-in-loop 거부) | §5-1 (중첩) |
| **9d** | 분기별 결정 카운터 breakdown(counts-only, `error_count`·cap 없음) | §7 (Branch decisions 표) |

각 체크박스를 진행하며 확인한다. 하나라도 실패하면 슬라이스를 미완으로 보고 follow-up을 만든다.

---

## 0. 사전 도구 (최초 1회)

`CLAUDE.md`의 "개발 환경 세팅"과 동일. 이미 돼 있으면 건너뛴다.

```bash
# Rust toolchain (edition 2024 + MSRV 1.85)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
  --default-toolchain stable --component rustfmt --component clippy
. "$HOME/.cargo/env"

# protoc(tonic-build 빌드 타임) + just(태스크 러너)
brew install protobuf just

# Node + pnpm (UI). pnpm이 없으면:
corepack enable && corepack prepare pnpm@latest --activate

# Docker — wiremock 타깃 컨테이너용 (Docker Desktop 실행 상태)
docker --version && docker ps >/dev/null && echo "docker OK"

# 확인
cargo --version && rustc --version && protoc --version && just --version && node --version
```

---

## 1. 빌드 (`just`) — 체크아웃 루트에서

```bash
# 워크스페이스 전체 빌드. cargo build --workspace 라서 controller·worker·engine 모두 빌드되고
# 그 결과 target/debug/worker 도 같이 만들어진다(= controller가 subprocess로 spawn하는 그 바이너리).
just build

# UI 의존성 + 정적 빌드 (controller가 --ui-dir 로 서빙할 dist)
just ui-install
just ui-build
```

> ⚠️ **워커 바이너리 함정**: controller는 `--worker-bin` 경로(`target/debug/worker`)의 바이너리를
> subprocess로 spawn한다. `just run-controller*`는 내부적으로 `cargo run -p handicap-controller`라
> **controller만** 다시 빌드하고 `target/debug/worker`는 안 건드린다. Slice 9는 엔진에
> `type: if` 스텝을 추가했으므로(9a), **옛 워커 바이너리면 새 스텝 타입을 못 읽어** run 시작 직후
> exit 1 한다 + controller 로그에 `unknown variant 'if'`. **`just build`를 반드시 먼저** 돌려 워커를
> 새로 빌드해 둘 것. (증상: run이 영영 `running` + 요청수 0 → controller 로그에서 worker exit 먼저 확인.)

---

## 2. 타깃(wiremock) 띄우고 stub 등록 (별도 터미널 T0)

if 노드의 각 분기가 때리는 엔드포인트를 stub 한다. **어떤 분기가 실행됐는지를 wiremock 요청
저널로 직접 확인**하기 위함(then→`/ok`, elif→`/retry`, else→`/report`).

```bash
# T0 — wiremock 컨테이너 (호스트 9090 → 컨테이너 8080)
docker run --rm --name handicap-wm-9 -p 9090:8080 wiremock/wiremock:3.7.0 \
  --global-response-templating

# (다른 터미널에서) 분기 타깃 3종 stub 등록 — 전부 200. urlPath라 query는 무시하고 매칭.
for p in ok retry report; do
  curl -s -X POST http://localhost:9090/__admin/mappings \
    -H 'Content-Type: application/json' \
    -d "{\"request\":{\"method\":\"GET\",\"urlPath\":\"/$p\"},
         \"response\":{\"status\":200,\"jsonBody\":{\"ok\":true}}}" >/dev/null
done

# 등록 확인 (health 단독 금지 — 방금 넣은 mappings를 실제로 read)
curl -s http://localhost:9090/__admin/mappings | python3 -m json.tool | grep -E '/ok|/retry|/report'

# 점검 시작 전 요청 로그 초기화(분기 검증을 깨끗하게)
curl -s -X DELETE http://localhost:9090/__admin/requests
```

함정(Slice 6 학습): 공유 포트의 health check는 신뢰 못 한다. 위처럼 `__admin/mappings`로 검증할 것.

---

## 3. controller + UI 실행 (`just`, 별도 터미널 T1)

점검엔 단일 origin이 가장 단순하다 — controller가 정적 UI까지 한 프로세스로 서빙(`--ui-dir`).

```bash
# (선택) 깨끗한 DB로 시작하고 싶으면 — just 레시피는 ./handicap.db 를 쓴다
rm -f ./handicap.db

# T1 — controller(REST 8080 + gRPC 8081 + 정적 UI). ui/dist 없으면 자동 빌드.
just run-controller-with-ui

# 준비 확인 (다른 터미널)
curl -sf -o /dev/null -w "REST %{http_code}\n" http://127.0.0.1:8080/api/scenarios   # 200
curl -s  -o /dev/null -w "UI   %{http_code}\n" http://127.0.0.1:8080/                  # 200
```

브라우저로 **http://localhost:8080** 접속.

- 다른 워크트리/세션의 controller·vite가 8080/8081/5173/9090을 선점했는지 먼저 확인:
  `lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(8080|8081|5173|9090)'` → stray 프로세스 정리.
- **대안(HMR이 필요하면 — 캔버스/조건 빌더를 반복 편집할 때 편하다)**: controller는
  `just run-controller`(UI 없이)로, UI는 별도 터미널 T2에서 `just ui-dev`(5173, `/api`→8080 프록시).
  그 경우 접속 주소는 **http://localhost:5173**.

---

## 4. 캔버스에서 if 노드 만들기 (9b)

1. 상단에서 **New scenario** → 캔버스 탭.
- [ ] 툴바의 **"+ Add if"** 클릭 → 점선 테두리의 if 컨테이너 노드가 생긴다.
- [ ] 컨테이너 헤더에 `if` + **조건 요약**(처음엔 시드된 leaf, 예: `1 eq 1`)이 보인다.
- [ ] 본문에 **THEN** 밴드 + 그 안에 http 자식 한 개("Step 1")가 시드돼 있다.
- [ ] (elif/else는 아직 비어 있어 ELIF/ELSE 밴드는 분기에 스텝을 넣기 전엔 안 보이거나 빈 상태.)

> 조건 요약 포맷: leaf는 `{left} {op} {right}`(unary op `exists`/`empty`는 `{left} {op}`),
> 그룹은 `all`→`" AND "`, `any`→`" OR "`로 자식을 이어 붙인 재귀 요약.

---

## 4-1. 인스펙터 — 재귀 조건 빌더 (9b)

if 컨테이너를 클릭 선택 → 인스펙터가 **If** 패널로 바뀐다.

### 조건(cond) 편집
- [ ] **연산자 드롭다운**에 정확히 10개: `eq` / `ne` / `contains` / `matches` / `lt` / `gt` /
      `lte` / `gte` / `exists` / `empty`.
- [ ] leaf 행: `left` 입력 / `op` 드롭다운 / `right` 입력 / `×`(삭제). 입력 commit은 **onBlur**
      (`ExtractEditor` 표준 패턴 — 키마다 반영 X, 포커스 빠질 때 커밋).
- [ ] op를 **`exists` 또는 `empty`** 로 바꾸면 → `right` 칸이 **사라진다**. 다른 op로 되돌리면
      `right` 칸이 다시 나타난다(빈 값으로).
- [ ] op를 **`matches`** 로 두고 `right`에 잘못된 정규식(예: `[`)을 넣으면 →  **`⚠ invalid regex`**
      경고. 유효한 정규식(예: `^2..$`)이면 사라진다.
- [ ] 그룹 만들기: leaf 하나만 있을 때 **"Wrap in group"** → 그 leaf를 `all` 그룹으로 감싼다.
      그룹 헤더의 **ALL/ANY 토글**은 옵션이 `ALL (AND)` / `ANY (OR)`.
- [ ] 그룹 안에서 **"+ condition"**(leaf 행 추가) / **"+ group"**(하위 그룹 추가).
- [ ] **빈 그룹은 만들 수 없다**: "+ group"은 leaf 하나를 시드하고, 자식이 1개뿐인 그룹은
      그 자식의 `×` 제거 버튼이 숨겨진다(엔진 `All([])`이 vacuous-true라 빈 그룹은 의미상 금지 — spec §3.2).

### 분기(then/elif/else) 편집
- [ ] THEN 밴드에 **"+ Add step"** → http 자식이 THEN에 추가된다.
- [ ] **"+ Add elif"** → 새 elif 분기가 자체 조건(`cond`) + THEN 영역으로 추가된다. elif별 삭제 가능.
- [ ] else 영역에도 **"+ Add step"** 으로 catch-all 분기 스텝을 추가할 수 있다.
- [ ] 각 분기의 http 자식을 클릭 → http 인스펙터로 전환(method/URL/headers/body/assert/extract 편집).

### 데모 시나리오로 채우기
점검의 §6/§7에서 쓸 if 노드를 다음처럼 만든다(캔버스로 만들어도 되고, §5의 YAML 붙여넣기가 빠르다):

- 조건: `left: {{code}}`, `op: eq`, `right: 200`
- THEN: GET `${BASE_URL}/ok`
- ELIF(조건 `{{code}} eq 404`): GET `${BASE_URL}/retry`
- ELSE: GET `${BASE_URL}/report`

시나리오 이름을 주고 **Save**.

---

## 5. YAML 라운드트립 (양방향 sync, 9b)

가장 빠른 길 — **New scenario → YAML(코드) 탭**에 아래를 붙여넣고 Create. (`${BASE_URL}`=env,
`{{code}}`=흐름 변수. 여기선 top-level `variables.code` 기본값으로 결정적으로 분기를 제어한다 —
이러면 extract/데이터셋 없이 한 줄만 바꿔 분기를 바꿀 수 있다. step id는 유효한 ULID여야 함 — `I/L/O/U` 금지.)

```yaml
version: 1
name: if-demo
variables:
  code: "200"
steps:
  - id: "01HX0000000000000000000010"
    name: branch-on-code
    type: if
    cond: { left: "{{code}}", op: eq, right: "200" }
    then:
      - id: "01HX0000000000000000000011"
        name: ok
        type: http
        request: { method: GET, url: "${BASE_URL}/ok" }
    elif:
      - cond: { left: "{{code}}", op: eq, right: "404" }
        then:
          - id: "01HX0000000000000000000012"
            name: retry
            type: http
            request: { method: GET, url: "${BASE_URL}/retry" }
    else:
      - id: "01HX0000000000000000000013"
        name: report
        type: http
        request: { method: GET, url: "${BASE_URL}/report" }
```

- [ ] **캔버스 ↔ YAML 전환**: YAML 탭에서 위 구조가 보이고, 캔버스 탭으로 가면 THEN/ELIF 1/ELSE
      밴드가 그려진다. 다시 YAML로 와도 동일.
- [ ] **코멘트 보존**: YAML의 `then:` 안 임의 키 옆에 `# 코멘트`를 적고 다른 키 하나를 수정 →
      캔버스 갔다 돌아와도 코멘트가 보존(targeted `setIn`). 단 스텝을 통째 add/remove하면 그 안
      코멘트는 사라짐 — 알려진 한계(loop과 동일).
- [ ] **조건 트리 round-trip**: YAML에서 `cond:`를 그룹으로 손수 바꿔본다 —
      ```yaml
      cond:
        all:
          - { left: "{{code}}", op: eq, right: "200" }
          - any:
              - { left: "{{flag}}", op: exists }
              - { left: "{{n}}", op: gte, right: "3" }
      ```
      캔버스로 전환 → 헤더 요약이 `... AND (... OR ...)` 꼴로 뜨고, 인스펙터 빌더에 ALL/ANY 그룹이
      중첩 표시. 다시 YAML로 → 같은 구조(수동 serde ↔ Zod `z.union` 1:1 매치). `exists`는 `right`가
      생략된 채 직렬화돼야 한다(`cleanCond`).

---

## 5-1. 상호 1레벨 중첩 (9c)

엔진은 자유 재귀를 허용하지만 **authoring 게이트(UI Zod + 캔버스 버튼)** 가 상호 1레벨로 한정한다:
허용 = **if-in-loop**, **loop-in-if**. 거부 = **if-in-if**, **loop-in-loop**, 더 깊은 중첩.

### loop-in-if (if 분기 안에 loop) — 허용
- [ ] 위 `if-demo`에서 **최상위** if 컨테이너의 한 분기(THEN)를 보면, 분기에 **"+ Add loop"**
      버튼이 있다(최상위 if라서 `loopAllowed`). 클릭 → 분기 안에 loop 컨테이너(시드 http 자식 포함)가 들어간다.
- [ ] 그 **내부 loop** 를 선택하면 본문 추가 버튼은 **"+ Add step"만**(내부 loop는 http-only —
      `NestedLoopStepModel`). 즉 loop-in-if의 loop 안에 또 if를 넣는 "+ Add if"는 **없다**(더 깊은 중첩 금지).

### if-in-loop (loop 본문 안에 if) — 허용
- [ ] **최상위** loop 노드("+ Add loop"로 생성)를 만들고 그 본문을 보면 **"+ Add if"** 버튼이 있다.
      클릭 → loop 본문에 if 컨테이너가 들어간다.
- [ ] 그 **내부 if** 의 분기는 http-only(`NestedIfStepModel`) — 분기 추가 버튼은 **"+ Add step"만**,
      "+ Add loop"는 **없다**.

### 거부 케이스
- [ ] **if-in-if**: 최상위 if 분기 안에 들어간(혹은 nested) if를 만들 버튼이 없다. YAML로 손수
      `then: [ - type: if ... ]`를 넣고 캔버스로 전환하면 **Zod 검증 실패 → inline 에러**.
- [ ] **loop-in-loop**: 내부 loop 본문에 또 loop를 넣는 경로가 없다(기존 단일 레벨 유지). YAML로
      손수 중첩하면 동일하게 거부.

---

## 6. 실행 + 분기 라우팅 검증 (9a)

if 노드는 run 다이얼로그에 **새 설정을 추가하지 않는다**(loop의 `loop_breakdown_cap` 같은 cap 없음 —
분기 메트릭은 무조건 on). 일반 run으로 충분하다.

시나리오 목록에서 `if-demo` 행의 **runs →** → **Run scenario**.

- [ ] **Env** 섹션: key `BASE_URL`, value `http://localhost:9090` 입력 → **Add**
      (좌측 두 칸 동시 입력. 이름 칸에 URL 통째로 넣지 말 것 — status 0 폭주 함정).
- [ ] **VUs 2 / Duration 5s / Ramp-up 0s**. **Run** → run 상세로 전환 → `running` → 5초 후 `completed`.

### THEN 경로 (code=200)
- [ ] `variables.code: "200"`(기본) 상태로 위 run을 돌린다. 종료 후 wiremock 저널 확인:
  ```bash
  curl -s http://localhost:9090/__admin/requests | python3 -c '
  import json,sys,collections
  d=json.load(sys.stdin)
  c=collections.Counter(r["request"]["url"].split("?")[0] for r in d.get("requests",[]))
  print({k:c[k] for k in ("/ok","/retry","/report")})'
  ```
  → **`/ok` 만 count > 0**, `/retry`·`/report`는 0. (`{{code}} eq 200` → then 분기만 실행된 증거.)

### ELIF 경로 (code=404)
- [ ] 시나리오 YAML 탭에서 `variables.code`를 **`"404"`** 로 바꿔 Save → 저널 초기화
      (`curl -s -X DELETE http://localhost:9090/__admin/requests`) → 다시 Run.
- [ ] 저널: **`/retry` 만 count > 0**. (top 조건 false → 첫 elif 조건 `eq 404` true → elif_0만 실행.)

### ELSE 경로 (code=500)
- [ ] `variables.code`를 **`"500"`** 로 바꿔 Save → 저널 초기화 → Run.
- [ ] 저널: **`/report` 만 count > 0**. (모든 조건 false → else 실행.)

> 한 번의 run에서 then/elif/else를 **동시에** 보려면(VU별로 다른 분기): 8c 데이터 바인딩으로
> `{{code}}`를 `200/404/500` 값이 든 데이터셋 컬럼에 `per_vu`로 매핑하고 VUs 3+로 Run. 위 단순
> 경로(variables 한 줄 수정×3회)면 핵심 라우팅 검증엔 충분하다.

---

## 6-1. 조건 평가 의미 점검 (9a, lenient)

조건 평가는 **lenient** — 미바인딩 변수·파싱 실패는 `false`로 떨어지고 **run을 죽이지 않는다**.

- [ ] **미바인딩 → false**: 조건을 `{ left: "{{missing}}", op: eq, right: "x" }`(어디에도 정의 안 된
      변수)로 바꿔 Run → run은 정상 `completed`(에러로 죽지 않음), 분기는 else/none로 떨어진다.
      `/ok`은 안 맞고 `/report`(else)가 맞는다.
- [ ] **숫자 비교는 f64 파싱**: `{ left: "{{n}}", op: gt, right: "3" }` + `variables.n: "10"` → true
      (사전순 비교였다면 `"10" > "3"`이 false였을 것). `variables.n: "2"` → false.
- [ ] **`matches` 정규식**: `{ left: "{{code}}", op: matches, right: "^2..$" }` + `code: "200"` → true.
      잘못된 정규식을 런타임에 만나도(만들기 어렵지만) 엔진은 그 비교만 lenient false 처리 + 1회 로그
      (run은 계속).

---

## 7. 분기 결정 카운터 — "Branch decisions" 표 (9d)

§6의 각 run이 `completed`된 **Report 뷰**에서 확인. 9d는 if 노드별 **분기 결정 카운트** 전용
breakdown이다 (counts-only — loop breakdown과 달리 **cap/overflow sentinel 없고**, **`error_count` 없으며**,
`ReportStep`이 아니라 **최상위 `if_breakdown` 배열** + **별도 테이블**로 렌더).

- [ ] Report 뷰 하단(Per-step `StepStatsTable` **뒤**)에 **"Branch decisions"** 섹션이 보인다.
      컬럼은 **`If node` | `Decisions`**.
- [ ] if 노드 행에 표시명(`branch-on-code`) + 회색 `(if)` 태그 + 왼쪽 caret(`▸`). `Decisions`는
      그 if의 전체 결정 합.
- [ ] caret 클릭 → 펼침(`▾`). 내부 표 컬럼 **`branch` | `decisions`**.
  - **THEN run(code=200)**: `branch` = **`then`**, `decisions` > 0. 다른 분기 행 없음.
  - **ELIF run(code=404)**: `branch` = **`elif_0`**(0-based, underscore), `decisions` > 0.
  - **ELSE run(code=500)**: `branch` = **`else`**, `decisions` > 0.
- [ ] **`none` 카운터** 확인: else를 **없앤**(또는 빈) 시나리오에서 모든 조건이 false면 분기 레이블이
      **`none`** 이고 UI엔 **`(미매치)`** 로 표시된다. 빠른 확인 — `if-demo`에서 `else:` 블록을 통째로
      지우고 `variables.code: "999"`(어떤 조건도 안 맞음)로 Save → Run → 표에 `(미매치)` 행 1개,
      wiremock 저널엔 `/ok`·`/retry`·`/report` 모두 0(실행된 분기 없음 = fall-through).
- [ ] **정렬**: 한 if에 여러 분기가 잡히면(데이터 바인딩 멀티-VU run) 표시 순서가
      **then → elif_0 → elif_1 → … → else → (미매치)**. (SQL은 TEXT 사전순으로 주지만 UI `branchRank`가
      authoring 순서로 재정렬.)

### JSON 다운로드 교차 확인
- [ ] Report의 **Download JSON** → 최상위에 **`if_breakdown`** 배열이 있다. 각 항목:
      `{ "step_id": "<if 노드 id>", "branches": [ { "branch": "then|elif_0|else|none", "count": N } ] }`.
      **`error_count` 필드는 없다**(분기 결정은 요청이 아님 — loop breakdown과의 의도된 차이).
- [ ] `if_breakdown[*].branches[*].count` 합 ≈ wiremock 저널의 해당 분기 타깃 요청수와 맞는지
      (then 결정 수 ≈ `/ok` 요청수 등) — 분기 결정과 실제 실행이 같은 진실을 가리키는지 최종 교차 검증.
      (단 `none`은 http 타깃이 없어 저널에 대응 요청이 없다 — 결정 카운트로만 보인다.)

---

## 8. 정리(cleanup)

```bash
# controller(T1)·vite(있으면 T2) Ctrl-C
docker rm -f handicap-wm-9            # wiremock 정지
rm -f ./handicap.db                  # 점검용 DB (just 레시피가 쓰는 경로)
```

---

## 9. green 게이트 (`just`, 머지 전 최종)

```bash
# Rust (pre-commit 훅이 도는 것과 동일 클래스)
just lint        # cargo fmt --check + cargo clippy --workspace --all-targets -- -D warnings
just test        # cargo test --workspace

# UI — pre-commit 훅은 cargo만 돌리므로 UI는 수동 필수.
# 특히 just ui-build 의 tsc -b 가 최종 게이트(discriminatedUnion narrowing·Zod default 누출은
# pnpm test=jsdom/esbuild로는 안 잡힘 — Slice 9b/9c 함정).
just ui-lint
just ui-test
just ui-build
```

모두 통과해야 한다.

---

## 부록 — 빠른 트러블슈팅

- **run이 영영 `running` + 0 req**: controller가 옛 `target/debug/worker`를 spawn 중 → 새 `type: if`
  스텝을 못 읽음. **`just build`** 로 워커 재빌드(§1 함정). controller 로그의 worker exit를 먼저 본다.
- **status 0 폭주 / 전부 5xx**: wiremock stub 미등록이거나 Env `BASE_URL`이 비어 `${BASE_URL}`이
  unresolved, 또는 host 없는 URL. §2 stub + §6 Env 행 확인.
- **분기가 의도와 다르게 라우팅**: 조건은 **lenient + 문자열 기반**이다. `{{code}}`가 안 풀리면(미바인딩)
  빈 문자열 → eq "200" false → else/none로 떨어진다. `variables.code`가 시나리오에 저장됐는지,
  `eq`(문자열 동치)와 `gt`/`lt`(f64 파싱) 의미 차이를 확인(§6-1). `"200" eq "200.0"`은 false(문자열).
- **Branch decisions 표가 안 보임**: if 노드가 없는 시나리오면 `if_breakdown`이 비어(또는 absent)
  섹션이 렌더되지 않는다(정상). if가 있는데도 안 보이면 워커/엔진이 9d 미반영 옛 바이너리인지(§1) 확인.
- **UI에서 새 기능이 안 보임**: 다른 워크트리의 vite/controller가 포트 선점. `lsof`로 stray 정리 후
  재기동 + 브라우저 하드 리로드.

---

## 알려진 한계 (Slice 9 범위, ADR-0023 참고)

- **상호 1레벨 중첩만**: if-in-loop, loop-in-if 까지. **if-in-if·loop-in-loop·더 깊은 중첩**은
  authoring 게이트가 거부(엔진 타입은 자유 재귀지만 UI Zod two-tier 모델이 막는다).
- **조건은 문자열/f64 비교까지**: 숫자 주입/형변환·정규식 플래그(대소문자 무시 등)·문자열 DSL
  (`if: "{{x}}==1 && ..."`) 미지원.
- **분기 breakdown은 counts-only**: 분기별 **레이턴시** breakdown 없음(7-1 loop breakdown과 동일 한도).
  `error_count` 없음(결정은 요청이 아님), cap/overflow sentinel 없음(분기 집합이 유한).
- **`${loop_index}`는 스칼라**: if-in-loop이면 분기 안 http가 바깥 loop의 인덱스를 본다(엔진이 ctx를
  그대로 전달). 중첩 loop가 없으니 단일 레벨에선 모호함 없음.
