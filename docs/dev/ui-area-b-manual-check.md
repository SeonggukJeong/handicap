# 영역 B — 환경(Environments) 수동 점검 매뉴얼

머지 직전(또는 회귀 점검 시) 실행. 자동 검증은 이미 충분하다(controller `store/environments.rs`
unit + `environments_api_test.rs` integration, UI RTL `environments.test.ts`/`EnvironmentsPage.test.tsx`/
`envOverlay.test.ts`/`EnvironmentPicker.test.tsx`/`RunDialog.test.tsx` overlay 케이스) — 이 매뉴얼은
사람이 실제 UI로 환경을 **등록·편집·삭제**하고, RunDialog에서 환경을 **골라 오버레이**한 값이
**실제 워커의 HTTP 요청까지 흘러가는지**(end-to-end `${ENV}` 주입)를 직접 확인하기 위한 것이다.

영역 B가 다루는 범위 (= 점검 대상):

| 하위 | 내용 | 이 매뉴얼 섹션 |
|---|---|---|
| **B-1** | 환경 리소스 + 관리 UI: `/environments` CRUD 페이지 + 검증(이름/키/예약명) | §4 (CRUD), §4-1 (검증) |
| **B-2** | RunDialog 오버레이: 환경 dropdown + read-only base 리스트 + per-run override + `resolveEnv` 병합 | §5 (오버레이 UI), §6 (end-to-end 주입), §7 (하위호환) |

각 체크박스를 진행하며 확인한다. 하나라도 실패하면 미완으로 보고 follow-up을 만든다.

> 결정 근거는 ADR-0025 / spec `docs/superpowers/specs/2026-05-31-global-variables-environments-design.md`.
> 핵심 불변식: 환경 vars = base, RunDialog 입력 = override(우선). 클라가 `resolveEnv(base, overrides)`로
> 병합해 **기존 평탄 `env` 맵**으로 제출 → `POST /api/runs` 계약 무변경. 환경 **미선택 = pre-B2와 byte-identical**.

---

## 0. 사전 도구 (최초 1회)

`CLAUDE.md`의 "개발 환경 세팅"과 동일. 이미 돼 있으면 건너뛴다. (slice-9 매뉴얼 §0와 동일 — Rust toolchain +
`protoc`/`just` + Node/pnpm + Docker.)

```bash
cargo --version && rustc --version && protoc --version && just --version && node --version
docker --version && docker ps >/dev/null && echo "docker OK"
```

---

## 1. 빌드 (`just`) — 체크아웃 루트에서

```bash
# 워크스페이스 전체 빌드 — controller·worker·engine 모두. target/debug/worker(= controller가
# subprocess로 spawn하는 그 바이너리)도 같이 빌드된다.
just build
just ui-install
just ui-build
```

> ⚠️ **워커 바이너리 함정**(slice-9 매뉴얼과 동일): `just run-controller*`는 controller만 다시 빌드하고
> `target/debug/worker`는 안 건드린다. 영역 B는 워커·엔진·proto를 **무변경**으로 두지만(B-1/B-2 둘 다),
> 다른 브랜치(예: 9d)를 pull/merge한 직후라면 옛 워커가 새 스텝 타입을 못 읽어 run이 영영 `running`+0req일 수
> 있으니 점검 전 `just build`를 한 번 돌려 둘 것. (증상이 보이면 controller 로그의 worker exit부터.)

---

## 2. 타깃(wiremock) 띄우고 stub 등록 (별도 터미널 T0)

end-to-end 주입(§6)에서 **환경이 넣은 `${BASE_URL}`이 실제로 이 wiremock을 때리는지** 요청 저널로 확인한다.

```bash
# T0 — wiremock 컨테이너 (호스트 9090 → 컨테이너 8080)
docker run --rm --name handicap-wm-b -p 9090:8080 wiremock/wiremock:3.7.0 --global-response-templating

# (다른 터미널) /ping stub 등록 — 200.
curl -s -X POST http://localhost:9090/__admin/mappings -H 'Content-Type: application/json' \
  -d '{"request":{"method":"GET","urlPath":"/ping"},"response":{"status":200,"jsonBody":{"ok":true}}}' >/dev/null

# 등록 확인 (health 단독 금지 — 방금 넣은 mapping을 실제로 read; Slice 6 학습)
curl -s http://localhost:9090/__admin/mappings | python3 -m json.tool | grep /ping

# 점검 시작 전 요청 로그 초기화
curl -s -X DELETE http://localhost:9090/__admin/requests
```

> subprocess 워커는 호스트에서 돌므로 `http://localhost:9090`로 wiremock에 닿는다(컨테이너 워커가 아님).

---

## 3. controller + UI 실행 (`just`, 별도 터미널 T1)

```bash
rm -f ./handicap.db        # (선택) 깨끗한 DB
just run-controller-with-ui   # REST 8080 + gRPC 8081 + 정적 UI

# 준비 확인 (다른 터미널)
curl -sf -o /dev/null -w "REST %{http_code}\n" http://127.0.0.1:8080/api/environments   # 200, {"environments":[]}
curl -s  -o /dev/null -w "UI   %{http_code}\n" http://127.0.0.1:8080/                    # 200
```

브라우저로 **http://localhost:8080** 접속.

- 포트 선점 확인: `lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(8080|8081|5173|9090)'` → stray 정리.
- HMR이 필요하면 controller는 `just run-controller`, UI는 T2에서 `just ui-dev`(5173, `/api`→8080 프록시) → 접속은 **http://localhost:5173**.

---

## 4. 환경 관리 페이지 CRUD (B-1) — `/environments`

상단 네비의 **Environments** 링크로 이동(`/environments`).

- [ ] 처음엔 **"No environments yet."** 빈 상태 + 우측 상단 **New environment** 버튼.
- [ ] **New environment** 클릭 → 폼이 열린다(Name 입력 + Variables 영역 + Save/Cancel).
- [ ] 이름 `local` 입력. add-row(키 `BASE_URL`, 값 `http://localhost:9090`)에 입력 후 **Add** → 변수 행이 추가된다.
- [ ] 변수 하나 더: `API_KEY` = `sk-demo` → **Add**.
- [ ] **Save** → 목록에 `local` 행이 뜨고 **Variables 칸에 `2`**(var_count)가 보인다. (vars 본문은 목록에 안 나옴 — 요약만.)
- [ ] `local` 행 **Edit** → 폼이 기존 값으로 채워진다(이름 `local`, 두 변수 행). 이름을 `staging`으로 바꾸고
      `API_KEY` 행의 `×`로 제거 → **Save** → 목록이 `staging`(var_count `1`)로 갱신.
- [ ] **Delete** → confirm 다이얼로그("이 환경을 삭제할까요? …스냅샷이라 영향 없음") → 확인 → 행이 사라지고 빈 상태로.
      (취소 누르면 안 지워진다.)

> 삭제는 **무가드**다(가드 메시지·차단 없음) — 환경을 참조하는 run/preset이 없는 스냅샷 모델이라 의도된 동작.
> REST로도 교차 확인 가능: `curl -s http://127.0.0.1:8080/api/environments | python3 -m json.tool`.

---

## 4-1. 환경 검증 (B-1)

다시 **New environment**로 폼을 연다. 검증은 **서버(CRUD 엔드포인트)** 가 권위 — UI가 에러 메시지를 그대로 표시한다.

- [ ] **빈 이름**: Name을 비우고 변수 하나 넣고 Save → `이름을 입력하세요`(또는 서버 400 메시지). 저장 안 됨.
- [ ] **중복 이름**: 위 §4에서 만든 이름과 같은 이름으로 새로 Save → **409** → `같은 이름의 환경이 이미 있습니다` 빨간 메시지. 저장 안 됨.
      (덮어쓰기 아님 — 수정은 Edit→Save(PUT)로만.)
- [ ] **잘못된 변수 키**: 키에 `BAD:KEY`(콜론) 또는 `BAD KEY`(공백) 또는 `BAD}`(중괄호)를 넣고 Save →
      `변수 이름 '…'에 공백·중괄호·콜론은 쓸 수 없습니다` 400. (이유: `${KEY}`/`${NAME:-default}`로 쓸 수 있어야 함.)
- [ ] **예약 시스템 변수명 경고(soft)**: 변수 키를 `vu_id`(또는 `iter_id`/`loop_index`)로 넣으면 → 폼에 amber 경고
      (`예약된 시스템 변수명…은 런타임에 시스템 값으로 해석되어 이 환경 값이 무시됩니다`). **하지만 저장은 막지 않는다**
      (엔진이 시스템 값으로 해석하므로 거부 대신 안내만).

§5 이후를 위해 §4의 `local`(BASE_URL=`http://localhost:9090`)을 다시 만들어 둔다(삭제했다면).

---

## 5. RunDialog 환경 오버레이 (B-2)

시나리오를 하나 만든다 — **New scenario → YAML 탭**에 붙여넣고 Create:

```yaml
version: 1
name: env-demo
steps:
  - id: "01HX0000000000000000000B01"
    name: ping
    type: http
    request: { method: GET, url: "${BASE_URL}/ping" }
```

> `${BASE_URL}`은 env 변수다. 미해석이면 URL이 `/ping`(host 없음)이 돼 connection 단계에서 fail-fast →
> status 0 + 비정상 RPS(루트 CLAUDE.md "status=0 함정"). 그래서 §6에서 BASE_URL이 실제로 주입됐는지가 핵심.

시나리오 목록에서 이 시나리오의 **Run**(또는 ▶) → RunDialog가 열린다. **Environment variables** 영역을 본다.

- [ ] **환경 dropdown**에 `(없음)` + 등록한 환경 이름들(`local` 등)이 보인다.
- [ ] `local` 선택 → 그 아래 **"from local (읽기 전용):"** base 리스트에 `BASE_URL = http://localhost:9090`이 뜬다
      (각 행에 **override** 버튼). 헤더가 `override (이 run 한정)`으로 바뀐다.
- [ ] base 행의 **override** 클릭 → 그 키가 **편집 가능한 override 행으로 시드**(값 prefill)되고, base 행은
      `재정의됨`(취소선)으로, override 행 옆엔 `BASE_URL 재정의` 라벨이 뜬다.
- [ ] add-row로 **임의 override** 추가: 키 `TOKEN` 값 `t1` → **Add** → override 행이 추가된다(base에 없는 키도 자유).
- [ ] **환경 전환 시 override 유지**: dropdown을 다른 환경으로 바꿔도 방금 추가한 override 행(`TOKEN`)은 사라지지 않는다(no orphan).
- [ ] dropdown을 `(없음)`으로 되돌리면 base 리스트가 사라지고 헤더가 `Env`로 — override 행만 남는다(= pre-B2 모습).

---

## 6. End-to-end `${ENV}` 주입 (B-2의 핵심) — 환경 값이 실제 요청까지 가는가

§5의 `env-demo` 시나리오 RunDialog에서:

**6-A. 환경 base만 (override 0)**
- [ ] wiremock 로그 초기화: `curl -s -X DELETE http://localhost:9090/__admin/requests`.
- [ ] 환경 `local` 선택, **override는 비운 채** VUs 작게(예 2)·duration 짧게(예 3s) → **Run**.
- [ ] run이 `completed`로 끝나고 **요청 수 > 0**(0이면 BASE_URL 미해석 — §5 경고 참고).
- [ ] **wiremock 저널 확인** — base가 실제 요청까지 갔다는 증거:
      `curl -s 'http://localhost:9090/__admin/requests?limit=5' | python3 -m json.tool | grep -E '"url"|/ping'`
      → `/ping` 요청이 보인다.
- [ ] Run 상세의 **Env 진단 패널**(Slice 4 M2)에 제출된 env가 `BASE_URL: http://localhost:9090`으로 표시된다.

**6-B. override가 base를 이긴다 (override-wins)**
- [ ] 같은 RunDialog에서 `local` 선택 + add-row로 `BASE_URL` = `http://localhost:9090`을 **override로 추가**
      (base와 같은 키 → base 행 `재정의됨`). 값을 일부러 식별 가능하게 바꿔도 됨(예: 쿼리 붙은 경로용 — 단 stub은 `/ping` urlPath 매칭이라 query 무시).
- [ ] **Run** → Run 상세 Env 패널의 `BASE_URL` 값이 **override 값**으로 표시된다(환경 값이 아니라). = 우선순위 환경 < override 확인.
- [ ] (선택, 더 확실히) 두 번째 wiremock stub을 다른 포트(예 9091)에 띄우고 override BASE_URL을 `http://localhost:9091`로 →
      Run 후 **9091** 저널에만 `/ping`이 찍히고 9090엔 안 찍힌다.

---

## 7. 하위호환 — 환경 미선택 = pre-B2 (B-2)

- [ ] RunDialog에서 환경 dropdown을 **`(없음)`** 으로 둔 채, 예전처럼 add-row로 직접 `BASE_URL` = `http://localhost:9090`
      입력 → **Run** → §6-A와 동일하게 `/ping`이 wiremock에 찍힌다(환경 기능 도입 전과 동일 동작).
- [ ] **프리셋/retry prefill**(영역 A): 과거 run의 **다시 실행**(retry) 또는 프리셋 불러오기로 RunDialog를 열면 →
      환경 dropdown은 `(없음)`이고, env 입력 행은 **저장된 해석값 스냅샷**으로 그대로 채워진다(환경 미선택 = override-only). Run하면 동일하게 동작.

> 이게 핵심 하위호환 불변식: 환경 미선택 ⇒ `resolveEnv({}, 입력행)` ⇒ 기존 제출 루프와 byte-identical.
> 프리셋/run에 저장된 env는 이미 **해석된 스냅샷**이라 환경을 나중에 수정/삭제해도 과거 설정엔 영향 없다.

---

## 트러블슈팅 (영역 B 특이)

- **run이 영영 `running` + 요청 수 0**: 워커가 죽었거나 URL이 미해석. controller 로그의 worker exit 먼저 →
  `just build`로 워커 재빌드. 또는 `${BASE_URL}` 미주입(환경 미선택인데 직접 입력도 안 함, 또는 키 오타).
- **status=0 + 비정상 RPS**: HTTP 도달 전 실패(connection refused / URL host 없음). 시나리오 URL이 `${BASE_URL}/ping`인데
  BASE_URL이 빈 채면 `/ping`(host 없음)이 된다 — 환경을 골랐는지/입력했는지 확인.
- **dropdown이 비어 있음**: `/environments`에서 먼저 환경을 등록했는지, `GET /api/environments`가 200인지 확인.
- **삭제했는데 과거 run이 멀쩡**: 정상이다(스냅샷 모델) — run/preset은 environment_id를 참조하지 않는다.

---

## 사인오프

- [ ] §4 CRUD(생성/목록 var_count/편집/삭제+confirm) 전부 통과
- [ ] §4-1 검증(빈 이름/중복 409/잘못된 키 400/예약명 soft 경고) 전부 통과
- [ ] §5 오버레이 UI(dropdown/base 리스트/override 시드/임의 override/전환 시 유지) 전부 통과
- [ ] §6 end-to-end(base 주입 wiremock 확인 + override-wins) 통과
- [ ] §7 하위호환(미선택=직접입력 동일, prefill 스냅샷) 통과

하나라도 실패 → follow-up 이슈/노트로 남기고 머지 보류.
