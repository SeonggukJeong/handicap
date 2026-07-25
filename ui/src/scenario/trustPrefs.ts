import { hashSeed } from "./genVars";
import type { Scenario, Step } from "./model";
import type { TestRunState } from "./trust";

const KEY = "handicap:trust-testrun:v1";
/** 저장 안 된 새 시나리오의 버킷 — 저장 시 `adoptDraftBucket`이 새 id로 옮긴다. */
export const DRAFT_KEY = "__draft__";
const PER_SCENARIO_CAP = 5;
const BUCKET_CAP = 50;

type Buckets = Record<string, number[]>;

// ── 실행 지문 ─────────────────────────────────────────────────────────────
// 원칙: test-run이 실제로 행사하는 실행 표면만 담는다. 레코드/객체형은 키를 정렬한다
// (엔진 headers·serde_json Value::Object 둘 다 BTreeMap이라 키 순서는 실행 무영향).
// 배열형(assert·extract·elif·steps)은 순서가 의미를 가지므로 정렬하지 않는다.

/** 객체 키를 **모든 깊이에서** 정렬한다 — 최상위만 정렬하면 중첩 객체 키 순서 변경이
 *  거짓 `stale`을 만든다. */
function canonJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function canonRecord(rec: Record<string, string> | undefined): string {
  if (!rec) return "{}";
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(rec[k])}`)
    .join(",")}}`;
}

function canonSteps(steps: ReadonlyArray<Step>): string {
  return `[${steps.map(canonStep).join(",")}]`;
}

function canonStep(s: Step): string {
  if (s.type === "http") {
    const r = s.request;
    const body =
      r.body === undefined
        ? "none"
        : r.body.kind === "form"
          ? `form:${canonRecord(r.body.value)}`
          : r.body.kind === "raw"
            ? `raw:${JSON.stringify(r.body.value)}`
            : `json:${canonJson(r.body.value)}`;
    // 스텝 name·id·think_time·request.disabled는 제외(실행 표면 아님 / test-run 미행사).
    // timeout_seconds는 **포함** — test-run이 실행하는 트레이스 경로
    // (execute_step_traced, crates/engine/src/executor.rs:392)가 이를 실제로
    // request builder에 적용한다. 부재는 안정 토큰 "none"으로 표현(undefined 직렬화 회피).
    const timeout = s.timeout_seconds === undefined ? "none" : String(s.timeout_seconds);
    return `http(${r.method}|${JSON.stringify(r.url)}|${canonRecord(r.headers)}|${body}|${timeout}|${canonJson(
      s.assert,
    )}|${canonJson(s.extract)})`;
  }
  if (s.type === "loop") return `loop(${s.repeat}|do:${canonSteps(s.do)})`;
  if (s.type === "parallel")
    // 분기 name은 {{분기.변수}} 네임스페이스의 일부라 실행 의미를 바꾼다(ADR-0033).
    return `par(${s.branches
      .map((b) => `${JSON.stringify(b.name)}:${canonSteps(b.steps)}`)
      .join(",")})`;
  // if — then / elif[i].then / else를 **구분해** 직렬화한다. 라벨 없이 자식 목록만
  // 이어 붙이면 then↔else 이동이 지문에 안 잡혀 거짓 verified가 된다.
  return `if(cond:${canonJson(s.cond)}|then:${canonSteps(s.then)}|elif:[${s.elif
    .map((e) => `(cond:${canonJson(e.cond)}|then:${canonSteps(e.then)})`)
    .join(",")}]|else:${canonSteps(s.else)})`;
}

export function executionFingerprint(scenario: Scenario): string {
  // 시나리오 name·notes·default_think_time은 제외(실행 표면 아님 / test-run 미행사).
  return [
    `v${scenario.version}`,
    `jar:${scenario.cookie_jar}`,
    `vars:${canonJson(scenario.variables)}`,
    `steps:${canonSteps(scenario.steps)}`,
  ].join("|");
}

export function fingerprintHash(scenario: Scenario): number {
  return hashSeed(executionFingerprint(scenario));
}

// ── 버킷 (localStorage, fail-soft) ────────────────────────────────────────

function load(): Buckets {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Buckets = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((n): n is number => typeof n === "number");
    }
    return out;
  } catch {
    return {};
  }
}

function save(b: Buckets): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(b));
  } catch {
    // 프라이빗 모드 등 — 조용히 무시. 기능 저하는 "항상 never"뿐.
  }
}

/**
 * 버킷 수 상한 축출. 객체 키 삽입 순서 = **최근 쓰기 순서**(아래 두 writer가 쓰기 전에
 * 기존 키를 지우고 재할당하므로) → 앞쪽, 즉 가장 오래 *쓰지 않은* 버킷부터 버린다.
 * 읽기(`testRunStateFor`)는 순서를 갱신하지 않으므로 LRU가 아니라 *쓰기-최근성* 축출이다.
 */
function evictOldest(b: Buckets): void {
  const keys = Object.keys(b);
  if (keys.length > BUCKET_CAP) {
    for (const k of keys.slice(0, keys.length - BUCKET_CAP)) delete b[k];
  }
}

/** 성공한 test-run의 지문 해시를 기록. 순서 갱신은 **쓰기 시에만**(읽기는 순서 불변). */
export function recordVerified(scenarioKey: string, hash: number): void {
  const b = load();
  const list = (b[scenarioKey] ?? []).filter((h) => h !== hash);
  list.push(hash);
  // **재할당은 삽입 순서를 옮기지 않는다** — 먼저 지워야 이 키가 맨 뒤(=가장 최근 쓰기)로
  // 간다. 안 지우면 ① 방금 재기록한 버킷이 여전히 "가장 오래된" 자리에 있어 다음 새
  // 시나리오 기록에 축출되고, ② 저장소가 이미 상한을 넘긴 상태(다른 탭/옛 빌드)라면
  // 방금 쓴 그 키가 이 호출의 축출 대상에 들어가 기록이 조용히 사라진다(칩이 영구 `(미확인)`).
  delete b[scenarioKey];
  b[scenarioKey] = list.slice(-PER_SCENARIO_CAP);
  evictOldest(b);
  save(b);
}

export function testRunStateFor(scenarioKey: string, scenario: Scenario): TestRunState {
  const list = load()[scenarioKey] ?? [];
  if (list.length === 0) return "never";
  return list.includes(fingerprintHash(scenario)) ? "verified" : "stale";
}

/**
 * 저장 성공 시 드래프트 버킷을 새 시나리오 id로 이관한다. 이게 없으면 표준 흐름
 * (작성 → test-run → 저장)에서 내용이 하나도 안 바뀌었는데 `never`로 뒤집힌다.
 * fail-soft: 복사와 삭제를 **한 번의 write로** 수행하고, 실패하면 아무것도 바꾸지 않는다.
 */
export function adoptDraftBucket(newScenarioId: string): void {
  const b = load();
  const draft = b[DRAFT_KEY];
  if (!draft || draft.length === 0) return;
  // recordVerified와 동일 규약: 지우고 재할당해 새 id를 맨 뒤(최근 쓰기)로 보내고,
  // 같은 상한을 적용한다(이 writer만 상한을 건너뛰면 저장소가 상한 위로 자란다).
  delete b[newScenarioId];
  b[newScenarioId] = draft.slice(-PER_SCENARIO_CAP);
  delete b[DRAFT_KEY];
  evictOldest(b);
  save(b);
}
