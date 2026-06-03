# Disabled Row Toggle (Postman식) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 헤더·폼 body의 KV 행을 지우지 않고 체크박스로 잠시 끄고, 꺼둔 행을 시나리오 YAML에 보존해 reload·git 공유 후에도 살리되 부하 실행 시엔 전송하지 않는다.

**Architecture:** 엔진 `Request`에 executor가 **절대 읽지 않는** 추가·무시 필드 `disabled: DisabledRows{headers,form}`를 더한다(hot-path byte-identical, proto/migration/워커 로직 무변경). UI는 `KeyValueGrid`를 active+disabled 두 맵을 소유하는 계약으로 확장하고(`onChange(active, disabled)`), `yamlDoc.ts::normalizeRequest`가 `disabled`를 파싱 모델로 통과시켜 read 경로를 연다.

**Tech Stack:** Rust(serde_yaml 0.9, wiremock) · TypeScript/React(Zod, `yaml` Document API, vitest/RTL).

**Spec:** `docs/superpowers/specs/2026-06-03-disabled-row-toggle-design.md`

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `crates/engine/src/scenario.rs` | `DisabledRows` 구조체 + `Request.disabled` 필드 + `is_empty` + serde 단위 테스트 | 1 |
| `crates/engine/src/executor.rs` | (프로덕션 무변경) 9개 `Request{…}` 테스트 리터럴 갱신 + "비활성 행 미전송" 가드 테스트 | 1 |
| `crates/engine/tests/proptests.rs` | `arb_http_step`의 `Request{…}` 리터럴 1개 갱신 | 1 |
| `ui/src/scenario/model.ts` | `RequestModel.disabled?` (와이어 1:1) | 2 |
| `ui/src/scenario/yamlDoc.ts` | `normalizeRequest` passthrough(read 경로) | 2 |
| `ui/src/components/scenario/KeyValueGrid.tsx` | `disabledEntries` prop + `enabled` 행 + `onChange(active, disabled)` 2-맵 계약 + bulk 보존/충돌 | 3 |
| `ui/src/components/scenario/Inspector.tsx` | `HeadersEditor`/`FormBodyField` 배선(두 경로 write + `buildDisabled` cleanup) | 3 |

**커밋 경계 주의(루트 CLAUDE.md 전체-게이트 함정)**: pre-commit이 비-`.md` 커밋마다 `cargo build/clippy/test --workspace`를 돌리므로, 각 task는 **로컬에서 RED→GREEN을 확인하되 하나의 green 커밋으로 fold**한다(헬퍼+테스트+배선을 쪼개 커밋하면 dead-code clippy 또는 RED-test 게이트로 막힘). `git commit`은 `run_in_background:false` + timeout 600000ms 단일 호출, 폴링 금지, 파이프(`| tail`) 금지 — 직후 `git log -1`로 landed 확인.

---

## Task 1: 엔진 `Request.disabled` 사이드카 필드 (단일 green 커밋)

**Files:**
- Modify: `crates/engine/src/scenario.rs` (Request 구조체 114–123, 테스트 모듈 427+)
- Modify: `crates/engine/src/executor.rs` (테스트 리터럴 라인 473·516·559·601·639·670·714·754·796 + import 452 + 새 가드 테스트)
- Modify: `crates/engine/tests/proptests.rs` (라인 76)

- [ ] **Step 1: `DisabledRows` 구조체 + `Request.disabled` 필드 추가**

`crates/engine/src/scenario.rs`의 `Request` 정의(114–123)를 교체:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub method: HttpMethod,
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<Body>,
    /// Authoring-only "disabled" rows persisted in the scenario YAML. The
    /// executor NEVER reads this — disabled headers/form fields are kept here
    /// (not in `headers`/`body`) so they survive reload but are not sent during
    /// a run. Empty → omitted on serialize (byte-identical to pre-feature YAML).
    #[serde(default, skip_serializing_if = "DisabledRows::is_empty")]
    pub disabled: DisabledRows,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DisabledRows {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub form: BTreeMap<String, String>,
}

impl DisabledRows {
    pub fn is_empty(&self) -> bool {
        self.headers.is_empty() && self.form.is_empty()
    }
}
```

- [ ] **Step 2: scenario.rs 단위 테스트 추가 (RED)**

`crates/engine/src/scenario.rs` 테스트 모듈(`mod tests`, 427+) 안에 추가:

```rust
    #[test]
    fn request_disabled_round_trips() {
        let yaml = r#"
method: POST
url: https://api/login
headers:
  Content-Type: application/json
disabled:
  headers:
    X-Debug: "on"
  form:
    skip: "2"
"#;
        let req: Request = serde_yaml::from_str(yaml).expect("parses disabled");
        assert_eq!(req.disabled.headers.get("X-Debug").map(String::as_str), Some("on"));
        assert_eq!(req.disabled.form.get("skip").map(String::as_str), Some("2"));
        assert!(req.headers.contains_key("Content-Type")); // active untouched
        let out = serde_yaml::to_string(&req).expect("serializes");
        assert!(out.contains("disabled:"), "round-trip keeps disabled: {out}");
        assert!(out.contains("X-Debug"));
    }

    #[test]
    fn request_without_disabled_parses_and_omits_on_serialize() {
        let yaml = "method: GET\nurl: https://api/x\n";
        let req: Request = serde_yaml::from_str(yaml).expect("parses w/o disabled");
        assert!(req.disabled.is_empty());
        let out = serde_yaml::to_string(&req).expect("serializes");
        assert!(!out.contains("disabled"), "empty disabled must be omitted: {out}");
    }

    #[test]
    fn request_still_rejects_unknown_fields() {
        let yaml = "method: GET\nurl: https://api/x\nbogus: 1\n";
        assert!(serde_yaml::from_str::<Request>(yaml).is_err());
    }
```

- [ ] **Step 3: 9개 executor.rs 테스트 리터럴 + import 갱신**

`crates/engine/src/executor.rs` 라인 452의 import에 `DisabledRows` 추가:

```rust
    use crate::scenario::{Body, DisabledRows, Extract, HttpMethod, HttpStep, Request};
```

라인 473·516·559·601·639·670·714·754·796의 각 `Request { method, url, headers, body }` 리터럴에 `disabled` 필드를 추가(각 `body: ...,` 다음 줄):

```rust
            request: Request {
                method: HttpMethod::Post,
                url: format!("{}/login", server.uri()),
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
```

(필드 값은 9곳 모두 동일하게 `disabled: DisabledRows::default(),` 한 줄 추가. `cargo build`가 빠뜨린 곳을 `E0063`으로 정확히 알려준다.)

- [ ] **Step 4: executor "비활성 행 미전송" 가드 테스트 추가 (RED)**

`crates/engine/src/executor.rs` 테스트 모듈에 추가(`server.received_requests()`는 동 crate `vu_offset.rs`/`if_node.rs`에서 검증된 패턴):

```rust
    #[tokio::test]
    async fn disabled_header_and_form_rows_are_not_sent() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/submit"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let mut headers = BTreeMap::new();
        headers.insert("X-Active".to_string(), "on".to_string());
        let mut disabled_headers = BTreeMap::new();
        disabled_headers.insert("X-Disabled".to_string(), "off".to_string());
        let mut form = BTreeMap::new();
        form.insert("keep".to_string(), "1".to_string());
        let mut disabled_form = BTreeMap::new();
        disabled_form.insert("skip".to_string(), "2".to_string());

        let step = HttpStep {
            id: "01HX0000000000000000000099".into(),
            name: "submit".into(),
            request: Request {
                method: HttpMethod::Post,
                url: format!("{}/submit", server.uri()),
                headers,
                body: Some(Body::Form(form)),
                disabled: DisabledRows { headers: disabled_headers, form: disabled_form },
            },
            assert: vec![],
            extract: vec![],
        };
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let client = VuClient::new(CookieJarMode::Off).unwrap();
        let outcome = execute_step(&client, &step, &ctx).await.unwrap();
        assert_eq!(outcome.status, 200);

        let reqs = server.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        let req = &reqs[0];
        assert!(req.headers.get("x-disabled").is_none(), "disabled header must not be sent");
        assert_eq!(
            req.headers.get("x-active").map(|v| v.to_str().unwrap()),
            Some("on"),
        );
        let body = String::from_utf8_lossy(&req.body);
        assert!(body.contains("keep=1"), "active form field present: {body}");
        assert!(!body.contains("skip"), "disabled form field must not be sent: {body}");
    }
```

- [ ] **Step 5: proptests.rs 리터럴 갱신**

`crates/engine/tests/proptests.rs`의 import(9–11)에 `DisabledRows` 추가 — 현재 `use handicap_engine::scenario::{ … HttpStep, IfStep, LoopStep, Request, Step };`에 `DisabledRows`를 끼운다. 라인 76의 `Request { method, url, headers, body }`에 한 줄 추가:

```rust
                request: Request {
                    // …기존 method/url/headers/body…
                    disabled: DisabledRows::default(),
                },
```

(`arb_http_step`은 `disabled`를 안 세팅하므로 `scenario_yaml_round_trip`의 `prop_assert_eq!`는 양쪽 `DisabledRows::default()`라 통과한다.)

- [ ] **Step 6: 전체 게이트 green 확인**

Run: `cargo test --workspace 2>&1 | tail -30`
Expected: 신규 테스트(`request_disabled_round_trips`, `request_without_disabled_parses_and_omits_on_serialize`, `request_still_rejects_unknown_fields`, `disabled_header_and_form_rows_are_not_sent`) 포함 0 fail.
Run: `cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -15`
Expected: 0 warning (`is_empty`는 `skip_serializing_if`가 참조하므로 dead-code 아님).

- [ ] **Step 7: 워커 재빌드 + 커밋**

Run: `cargo build -p handicap-worker` (subprocess가 spawn하는 `target/debug/worker` 갱신 — 엔진 필드 추가 후 필수).
그 다음 단일 foreground 커밋:

```bash
git add crates/engine/src/scenario.rs crates/engine/src/executor.rs crates/engine/tests/proptests.rs
git commit -m "feat(engine): Request.disabled 사이드카 필드 (executor 미사용, byte-identical)"
git log -1 --oneline
```

---

## Task 2: UI 모델 + read 경로 (`normalizeRequest` passthrough) (단일 green 커밋)

**Files:**
- Modify: `ui/src/scenario/model.ts` (RequestModel 23–31)
- Modify: `ui/src/scenario/yamlDoc.ts` (normalizeRequest 470–478)
- Test: `ui/src/scenario/__tests__/yamlDoc.test.ts`, `ui/src/scenario/__tests__/model.test.ts`, `ui/src/scenario/__tests__/scanVars.test.ts`

- [ ] **Step 1: 모델 read 테스트 추가 (RED)**

`ui/src/scenario/__tests__/yamlDoc.test.ts`에 추가(`parseScenarioDoc`로 YAML→모델에 `disabled`가 살아있는지 = §1 reload 보존의 핵심):

```ts
  it("preserves request.disabled (headers + form) into the parsed model", () => {
    const yaml = `version: 1
name: t
steps:
  - id: "01HX0000000000000000000001"
    name: s
    type: http
    request:
      method: POST
      url: https://api/x
      headers:
        A: "1"
      body:
        form:
          keep: "1"
      disabled:
        headers:
          X-Off: "h"
        form:
          skip: "2"
`;
    const out = parseScenarioDoc(yaml);
    if (!("model" in out)) throw new Error(out.error);
    const step = out.model.steps[0];
    if (step.type !== "http") throw new Error("expected http step");
    expect(step.request.disabled?.headers).toEqual({ "X-Off": "h" });
    expect(step.request.disabled?.form).toEqual({ skip: "2" });
    expect(step.request.headers).toEqual({ A: "1" }); // active unaffected
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test yamlDoc 2>&1 | tail -20`
Expected: FAIL — `step.request.disabled`가 `undefined`(normalizeRequest가 떨굼).

- [ ] **Step 3: `RequestModel`에 `disabled` 추가**

`ui/src/scenario/model.ts`의 `RequestModel`(23–30)을 교체:

```ts
export const RequestModel = z
  .object({
    method: HttpMethod,
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
    body: BodyModel.optional(),
    disabled: z
      .object({
        headers: z.record(z.string(), z.string()).optional(),
        form: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
```

(`.default({})` **금지** — 중첩 `.default()`는 부모 `z.infer`에 `T|undefined` 누출(`pnpm build`에서만 잡힘). `.optional()`로. `.strict()`는 known 필드 `disabled`를 통과시킨다.)

- [ ] **Step 4: `normalizeRequest` passthrough**

`ui/src/scenario/yamlDoc.ts`의 `normalizeRequest`(470–478)를 교체:

```ts
function normalizeRequest(r: Record<string, unknown>): unknown {
  const body = r.body === undefined || r.body === null ? undefined : normalizeBody(r.body);
  return {
    method: r.method,
    url: r.url,
    headers: r.headers ?? {},
    ...(body === undefined ? {} : { body }),
    ...(r.disabled === undefined || r.disabled === null ? {} : { disabled: r.disabled }),
  };
}
```

- [ ] **Step 5: 모델 단위 테스트 추가 (model.test.ts)**

`ui/src/scenario/__tests__/model.test.ts`에 `RequestModel`이 `disabled`를 수용하는지 추가:

```ts
  it("RequestModel accepts an optional disabled sidecar", () => {
    const r = {
      method: "GET" as const,
      url: "https://api/x",
      headers: {},
      disabled: { headers: { "X-Off": "h" } },
    };
    expect(RequestModel.parse(r).disabled).toEqual({ headers: { "X-Off": "h" } });
    // absent disabled stays undefined (byte-identical pre-feature shape)
    expect(RequestModel.parse({ method: "GET", url: "https://api/x", headers: {} }).disabled)
      .toBeUndefined();
  });
```

(`RequestModel`이 `model.test.ts`에 import돼 있지 않으면 import 추가: `import { RequestModel } from "../model";`)

- [ ] **Step 5b: `scanFlowVars`가 비활성 행 토큰을 제외하는지 가드 테스트**

`ui/src/scenario/__tests__/scanVars.test.ts`에 추가 — disabled 행의 `{{var}}`가 data-binding 스캔에 안 잡혀야 한다(`scanVars.ts`가 `request.headers`/`body`만 walk하므로 현재 통과하지만, 나중에 누가 `disabled`를 walk에 넣으면 깨지게 하는 회귀 잠금):

```ts
  it("excludes {{vars}} that live in disabled rows", () => {
    const s = {
      version: 1,
      name: "t",
      cookie_jar: "auto" as const,
      variables: {},
      steps: [
        {
          id: "01HX0000000000000000000001",
          name: "s",
          type: "http" as const,
          request: {
            method: "GET" as const,
            url: "https://api/{{active}}",
            headers: {},
            disabled: { headers: { "X-Off": "{{ghost}}" }, form: { skip: "{{ghost2}}" } },
          },
          assert: [],
          extract: [],
        },
      ],
    };
    const vars = scanFlowVars(s);
    expect(vars.has("active")).toBe(true);
    expect(vars.has("ghost")).toBe(false);
    expect(vars.has("ghost2")).toBe(false);
  });
```

(타입이 `Scenario`와 안 맞으면 기존 scanVars.test.ts의 fixture 생성 헬퍼/캐스트 스타일을 따른다 — 파일 상단을 읽고 동일 패턴으로.)

- [ ] **Step 6: 게이트 green**

Run: `cd ui && pnpm test yamlDoc model scanVars 2>&1 | tail -20`
Expected: 신규 테스트 PASS.
Run: `cd ui && pnpm lint && pnpm test && pnpm build 2>&1 | tail -20`
Expected: lint 0 warning, 전 테스트 pass, `tsc -b` clean(중첩 default 누출 없음 확인).

- [ ] **Step 7: 커밋 (단일 foreground)**

```bash
git add ui/src/scenario/model.ts ui/src/scenario/yamlDoc.ts \
  ui/src/scenario/__tests__/yamlDoc.test.ts ui/src/scenario/__tests__/model.test.ts \
  ui/src/scenario/__tests__/scanVars.test.ts
git commit -m "feat(ui): RequestModel.disabled + normalizeRequest passthrough (read 경로)"
git log -1 --oneline
```

---

## Task 3: `KeyValueGrid` 2-맵 계약 + Inspector 배선 + bulk/충돌 (단일 green 커밋)

**Files:**
- Modify: `ui/src/components/scenario/KeyValueGrid.tsx`
- Modify: `ui/src/components/scenario/Inspector.tsx` (HeadersEditor 191–209, FormBodyField 310–326)
- Test: `ui/src/components/scenario/__tests__/KeyValueGrid.test.tsx` (Harness + 신규), `ui/src/components/scenario/__tests__/Inspector.test.tsx`(필요 시)

> 이 task는 `KeyValueGrid.onChange` 시그니처를 `(active) => void` → `(active, disabled) => void`로 바꾼다. 호출부는 `Inspector.tsx`(2곳)와 테스트 `Harness`뿐 — 셋 다 같은 커밋에서 갱신해야 `tsc -b`/`pnpm build`가 green.

- [ ] **Step 1: KeyValueGrid 테스트 Harness를 2-맵 계약으로 갱신 + 신규 테스트 (RED)**

`ui/src/components/scenario/__tests__/KeyValueGrid.test.tsx`의 `Harness`(8–30)를 교체:

```tsx
function Harness(props: {
  initial?: Record<string, string>;
  initialDisabled?: Record<string, string>;
  withCommon?: boolean;
  format?: "header" | "form";
}) {
  const [entries, setEntries] = useState<Record<string, string>>(props.initial ?? {});
  const [disabled, setDisabled] = useState<Record<string, string>>(props.initialDisabled ?? {});
  return (
    <>
      <KeyValueGrid
        entries={entries}
        disabledEntries={disabled}
        onChange={(a, d) => {
          setEntries(a);
          setDisabled(d);
        }}
        resetKey="step-1"
        bulkFormat={props.format ?? "header"}
        itemLabel="header"
        keyPlaceholder="Header"
        valuePlaceholder="value"
        emptyText="No headers"
        commonKeys={props.withCommon ? COMMON_HEADERS : undefined}
      />
      <pre data-testid="dump">{JSON.stringify(entries)}</pre>
      <pre data-testid="dump-disabled">{JSON.stringify(disabled)}</pre>
    </>
  );
}

const dump = () => JSON.parse(screen.getByTestId("dump").textContent || "{}");
const dumpDisabled = () => JSON.parse(screen.getByTestId("dump-disabled").textContent || "{}");
```

같은 파일에 신규 테스트 추가:

```tsx
describe("KeyValueGrid — disabled toggle", () => {
  it("toggling a row's checkbox moves it to the disabled map (and back)", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1" }} />);
    const cb = screen.getByLabelText("header enabled 0") as HTMLInputElement;
    expect(cb.checked).toBe(true);
    await user.click(cb); // disable
    expect(dump()).toEqual({});
    expect(dumpDisabled()).toEqual({ A: "1" });
    await user.click(screen.getByLabelText("header enabled 0")); // re-enable
    expect(dump()).toEqual({ A: "1" });
    expect(dumpDisabled()).toEqual({});
  });

  it("a disabled row is still editable", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{}} initialDisabled={{ A: "1" }} />);
    const value = screen.getByLabelText("header value 0");
    await user.clear(value);
    await user.type(value, "2");
    await user.tab(); // blur commit
    expect(dumpDisabled()).toEqual({ A: "2" });
    expect(dump()).toEqual({});
  });

  it("bulk replace keeps disabled rows; active wins on key collision", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1" }} initialDisabled={{ B: "x", A: "old" }} />);
    // Note: A exists active+disabled only transiently; split makes active win — disabled has only B.
    await user.click(screen.getByRole("button", { name: "Bulk Edit" }));
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "A: 9\nC: 3" } });
    await user.click(screen.getByRole("button", { name: /apply/i }));
    expect(dump()).toEqual({ A: "9", C: "3" }); // active replaced
    expect(dumpDisabled()).toEqual({ B: "x" }); // disabled preserved, A collision dropped from disabled
  });
});
```

(주의: `<input list>` 든 key 입력은 ARIA role이 `combobox`다 — 기존 행-단위 textbox 단언이 있으면 `getAllByRole("combobox")+getAllByRole("textbox")` 합집합으로. Bulk apply 버튼의 정확한 라벨은 `BulkEditPanel.tsx`에서 확인 후 셀렉터 맞출 것.)

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test KeyValueGrid 2>&1 | tail -25`
Expected: FAIL — `disabledEntries` prop·`header enabled 0` 체크박스·2-맵 onChange 미구현.

- [ ] **Step 3: KeyValueGrid 구현 — Row에 `enabled`, props/계약, split, bulk**

`ui/src/components/scenario/KeyValueGrid.tsx`를 다음대로 수정:

(a) `Row` 인터페이스(6–9) + props(11–24):

```tsx
interface Row {
  key: string;
  value: string;
  enabled: boolean;
}

interface KeyValueGridProps {
  entries: Record<string, string>;
  /** Disabled rows (kept but not sent). Default {}. */
  disabledEntries?: Record<string, string>;
  onChange: (active: Record<string, string>, disabled: Record<string, string>) => void;
  resetKey: string;
  bulkFormat: BulkFormat;
  itemLabel: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  emptyText?: string;
  commonKeys?: CommonHeader[];
}
```

(b) `toRows`/`toRecord`(26–38)를 `toRows`(2-맵→행) + `splitRows`(행→2-맵, active-우선 충돌)로 교체:

```tsx
function toRows(active: Record<string, string>, disabled: Record<string, string>): Row[] {
  return [
    ...Object.entries(active).map(([key, value]) => ({ key, value, enabled: true })),
    ...Object.entries(disabled).map(([key, value]) => ({ key, value, enabled: false })),
  ];
}

function splitRows(rows: Row[]): {
  active: Record<string, string>;
  disabled: Record<string, string>;
} {
  const active: Record<string, string> = {};
  const disabled: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k === "" || !r.enabled) continue;
    active[k] = r.value; // last-wins
  }
  for (const r of rows) {
    const k = r.key.trim();
    if (k === "" || r.enabled) continue;
    if (k in active) continue; // active wins on collision (one key = one row)
    disabled[k] = r.value;
  }
  return { active, disabled };
}
```

(c) 컴포넌트 시그니처에 `disabledEntries = {}` 구조분해 추가, `useState`/reseed/commit 갱신:

```tsx
export function KeyValueGrid({
  entries,
  disabledEntries = {},
  onChange,
  resetKey,
  // …나머지 동일
}: KeyValueGridProps) {
  const [rows, setRows] = useState<Row[]>(() => toRows(entries, disabledEntries));
  // …(newKey/newValue/bulkOpen/refs 동일)

  // reseed effect(74–80): toRows에 두 맵 전달
  useEffect(() => {
    setRows(toRows(entries, disabledEntries));
    setNewKey("");
    setNewValue("");
    setBulkOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const commit = (next: Row[]) => {
    setRows(next);
    const { active, disabled } = splitRows(next);
    onChange(active, disabled);
  };
  const commitRows = () => {
    const { active, disabled } = splitRows(rows);
    onChange(active, disabled);
  };
```

(d) `addRow`/`updateKey`/`updateValue`/`pickCommon`이 `enabled`를 보존하도록(새 행은 `enabled: true`):

```tsx
  const addRow = () => {
    const k = newKey.trim();
    if (!k) return;
    commit([...rows, { key: k, value: newValue, enabled: true }]);
    setNewKey("");
    setNewValue("");
    newKeyRef.current?.focus();
  };

  const toggleEnabled = (idx: number) => {
    commit(rows.map((r, i) => (i === idx ? { ...r, enabled: !r.enabled } : r)));
  };
```

`updateValue`/`updateKey`는 `{ ...r, value }` / `{ ...r, key, value }` 스프레드라 `enabled` 자동 보존(현 코드 그대로 OK). `pickCommon`의 두 `commit([..., { key, value }])`에 `enabled: true` 추가.

(e) Bulk 분기(132–144): `entries`는 active만, apply는 보존+충돌:

```tsx
  if (bulkOpen) {
    return (
      <BulkEditPanel
        entries={splitRows(rows).active}
        format={bulkFormat}
        onApply={(nextActive) => {
          const preserved = rows.filter(
            (r) => !r.enabled && r.key.trim() !== "" && !(r.key.trim() in nextActive),
          );
          commit([...toRows(nextActive, {}), ...preserved]);
          setBulkOpen(false);
        }}
        onCancel={() => setBulkOpen(false)}
      />
    );
  }
```

(f) 각 행(`<li>` 169–198)에 enabled 체크박스를 key 입력 앞에 추가:

```tsx
          <li key={idx} className="flex gap-2 items-center">
            <input
              type="checkbox"
              aria-label={`${itemLabel} enabled ${idx}`}
              className="shrink-0"
              checked={r.enabled}
              onChange={() => toggleEnabled(idx)}
            />
            <input
              aria-label={`${itemLabel} key ${idx}`}
              /* …기존 key 입력 그대로 */
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test KeyValueGrid 2>&1 | tail -25`
Expected: disabled-toggle describe 블록 + 기존 grid 테스트 모두 PASS.

- [ ] **Step 5: Inspector 배선(`HeadersEditor`/`FormBodyField`) + `buildDisabled` 헬퍼**

`ui/src/components/scenario/Inspector.tsx`에 모듈 스코프 헬퍼 추가(파일 상단 import 아래 아무 곳):

```tsx
function buildDisabled(
  headers: Record<string, string> | undefined,
  form: Record<string, string> | undefined,
): { headers?: Record<string, string>; form?: Record<string, string> } | undefined {
  const h = headers && Object.keys(headers).length ? headers : undefined;
  const f = form && Object.keys(form).length ? form : undefined;
  if (!h && !f) return undefined; // setStepField(undefined) → deleteIn → clean YAML
  return { ...(h ? { headers: h } : {}), ...(f ? { form: f } : {}) };
}
```

`HeadersEditor`(191–209)를 교체:

```tsx
function HeadersEditor({ step }: { step: HttpStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold text-slate-600 mb-1">Headers</div>
      <KeyValueGrid
        entries={step.request.headers ?? {}}
        disabledEntries={step.request.disabled?.headers ?? {}}
        onChange={(active, disabled) => {
          setStepField(step.id, ["request", "headers"], active);
          setStepField(
            step.id,
            ["request", "disabled"],
            buildDisabled(disabled, step.request.disabled?.form),
          );
        }}
        resetKey={step.id}
        bulkFormat="header"
        itemLabel="header"
        keyPlaceholder="Header"
        valuePlaceholder="value"
        emptyText="No headers"
        commonKeys={COMMON_HEADERS}
      />
    </div>
  );
}
```

`FormBodyField`(310–326)를 교체:

```tsx
function FormBodyField({ step }: { step: HttpStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const body = step.request.body;
  const map = body?.kind === "form" ? body.value : {};
  return (
    <KeyValueGrid
      entries={map ?? {}}
      disabledEntries={step.request.disabled?.form ?? {}}
      onChange={(active, disabled) => {
        setStepField(step.id, ["request", "body"], { form: active });
        setStepField(
          step.id,
          ["request", "disabled"],
          buildDisabled(step.request.disabled?.headers, disabled),
        );
      }}
      resetKey={step.id}
      bulkFormat="form"
      itemLabel="form field"
      keyPlaceholder="field"
      valuePlaceholder="value"
      emptyText="No fields"
    />
  );
}
```

`BodyEditor.setKind`(216–224)를 수정 — body가 form을 떠나면 orphan될 `disabled.form`을 떨군다(보이지 않는 데이터 방지, spec §7):

```tsx
  const setKind = (k: BodyKind) => {
    // form body를 떠나면 disabled.form은 더 이상 편집 UI에 안 보임 → orphan 제거
    if (k !== "form" && step.request.disabled?.form) {
      setStepField(
        step.id,
        ["request", "disabled"],
        buildDisabled(step.request.disabled?.headers, undefined),
      );
    }
    if (k === "none") {
      setStepField(step.id, ["request", "body"], undefined);
      return;
    }
    const value: unknown = k === "json" ? {} : k === "form" ? {} : "";
    setStepField(step.id, ["request", "body"], { [k]: value });
  };
```

- [ ] **Step 6: Inspector write 경로 테스트 추가 (Inspector.test.tsx)**

`ui/src/components/scenario/__tests__/Inspector.test.tsx`에 헤더 토글이 YAML `request.disabled`로 write되는지 검증. 이 파일의 store 패턴은 `loadFromString(yaml)` + `select(id)` + `useScenarioEditor.getState().yamlText` 읽기다(기존 ExtractEditor 테스트와 동일). 헤더가 있는 자체 YAML로 self-contained describe 추가:

```tsx
describe("Inspector — disabled header toggle", () => {
  const HEADER_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
      headers:
        A: "1"
    assert:
      - status: 200
`;

  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(HEADER_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
  });

  it("disabling a header moves it under request.disabled.headers in the YAML", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByLabelText("header enabled 0")); // uncheck → disable
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).toMatch(/disabled:/);
    expect(yaml).toMatch(/headers:\s*\n\s*A:/); // A now under disabled.headers
    // re-parse → active headers empty, disabled has A
    const out = parseScenarioDoc(yaml);
    if (!("model" in out)) throw new Error(out.error);
    const step = out.model.steps[0];
    if (step.type !== "http") throw new Error("expected http");
    expect(step.request.headers).toEqual({});
    expect(step.request.disabled?.headers).toEqual({ A: "1" });
  });
});
```

(파일 상단 import에 `parseScenarioDoc`(from `../../../scenario/yamlDoc`)가 없으면 추가. `yamlText`에 `disabled:` 정규식이 깨지면 re-parse 단언만으로 충분 — round-trip이 핵심.)

- [ ] **Step 7: 기존 Inspector 테스트 회귀 확인 + 게이트**

Run: `cd ui && pnpm test Inspector KeyValueGrid 2>&1 | tail -25`
Expected: 기존 + 신규 모두 PASS(헤더 active 동작은 불변이라 기존 테스트 영향 없음; 깨지면 2-call onChange 단언 차이만 조정).
Run: `cd ui && pnpm lint && pnpm test && pnpm build 2>&1 | tail -20`
Expected: lint 0 warning, 전 테스트 pass, `tsc -b` clean(KeyValueGrid 호출부 3곳 모두 새 시그니처).

- [ ] **Step 8: 커밋 (단일 foreground)**

```bash
git add ui/src/components/scenario/KeyValueGrid.tsx \
  ui/src/components/scenario/Inspector.tsx \
  ui/src/components/scenario/__tests__/KeyValueGrid.test.tsx \
  ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): KeyValueGrid disabled 토글 체크박스 + Inspector 2-맵 배선 (write 경로)"
git log -1 --oneline
```

---

## 최종 검증 (전 task 완료 후)

- [ ] **handicap-reviewer 전체 리뷰**: UI Zod `disabled.{headers,form}` ↔ 엔진 serde 와이어 1:1, executor 무시 불변식(`request.disabled` 비참조), byte-identical(빈 disabled 직렬화 부재), bulk 보존/충돌 규칙, deferral 추적.
- [ ] **수동 확인(선택)**: `dev-doctor`로 로컬 스택 기동(워커 재빌드 확인) → 시나리오 에디터에서 헤더 토글 → 저장 → reload → 꺼진 행이 체크 꺼진 채 살아있는지 + run 시 비활성 헤더 미전송(`server.received_requests` 가드가 이미 자동 커버).
- [ ] **CLAUDE.md 함정 기록**: `crates/engine/CLAUDE.md`에 "Request.disabled = executor 미사용 authoring-only 사이드카(byte-identical, skip_serializing_if)" 한 줄, `ui/CLAUDE.md`에 "KeyValueGrid는 active+disabled 2-맵 계약(`onChange(active, disabled)`)·split active-우선 충돌·Inspector `buildDisabled` cleanup" 한 줄.

## 연기 항목 (spec §2 OUT)

변수 토글 / 멀티값 헤더 / 비활성 dim / JSON·raw 부분 비활성 — 이 슬라이스 범위 밖.
