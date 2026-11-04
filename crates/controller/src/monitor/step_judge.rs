//! 스텝 칸 판정 — 실행 단위(묶음) 전체를 trace 1회로 한 번에 판정한다(spec §5, §6.3).
//!
//! 판정 순서(칸마다 처음 맞는 것 하나): ① 스텝 없음 → 설정 오류 ② 앞 구간의 엔진 수준
//! 실패 → 확인 못 함(또는 대리 원인 칸) ③ 실행됨 → 기존 규칙 ④ 분기 제외 ⑤ 그 외 미실행.
//! 대리 원인 칸 때문에 칸별 순수 함수가 아니라 실행 단위 전체를 한 번에 계산한다.
//! 새 reason·detail은 전부 `shown()`을 거친다(서식 문자 정리 + 200자 `…`).

use std::collections::{HashMap, HashSet};

use handicap_engine::{
    BranchEval, CompareOp, HttpStep, IfStep, Scenario, ScenarioTrace, Step, StepKind, StepTrace,
    scenario::Extract,
};

use super::check::{
    CheckResult, MONITOR_MAX_REQUESTS, REASON_BRANCH_VALUE_MISSING, REASON_COND_STEP_NOT_RUN,
    REASON_LATENCY_STEP_MISSING, REASON_REQUEST_CAP, REASON_TRACE_ERROR, REASON_UNBOUND_VAR,
    REASON_UPSTREAM, Verdict, classify, collect_http_steps, display_values, eval_conditions,
    reason_timeout, shown,
};
use super::config::{AUTH_HEADERS, PanelConfig};

/// 칸 없는 스텝의 기본 요청 제한(초) — `step_limits`에 없을 때만 쓰는 방어값.
const DEFAULT_STEP_LIMIT_SECS: u32 = 5;

/// 빈 문자열 표기(대상 값·기대 값 공통).
const EMPTY_TEXT: &str = "\"\"";

/// 환경 값(`${…}`) 대신 보이는 문구.
const ENV_VALUE_TEXT: &str = "(환경 값)";

/// 인증 출처(쿠키·인증 헤더 추출) 흐름 변수 값 대신 보이는 문구.
const AUTH_VALUE_TEXT: &str = "(인증 값)";

/// 인증 출처 흐름 변수 이름 — 쿠키 추출 전부와 인증 헤더(`AUTH_HEADERS`) 추출의 `var`,
/// parallel 분기 안이면 merge 이름 `{분기}.{var}`까지. 내용으로 비밀을 추측하지 않고
/// **출처**로만 가린다(①b 인증 헤더 가드가 추출 경유로 우회되는 것을 막는다).
fn auth_var_names(scenario: &Scenario) -> HashSet<String> {
    fn is_auth(e: &Extract) -> bool {
        match e {
            Extract::Cookie { .. } => true,
            Extract::Header { name, .. } => AUTH_HEADERS
                .iter()
                .any(|h| name.trim().eq_ignore_ascii_case(h)),
            Extract::Body { .. } | Extract::Status { .. } => false,
        }
    }
    /// `steps` 서브트리의 인증 출처 이름(중첩 parallel 안까지 — 과하게 가리는 쪽이 안전).
    fn walk(steps: &[Step], out: &mut HashSet<String>) {
        for s in steps {
            match s {
                Step::Http(h) => out.extend(
                    h.extract
                        .iter()
                        .filter(|e| is_auth(e))
                        .map(|e| e.var().to_string()),
                ),
                Step::Loop(l) => walk(&l.do_, out),
                Step::If(i) => {
                    walk(&i.then_, out);
                    for e in &i.elif {
                        walk(&e.then_, out);
                    }
                    walk(&i.else_, out);
                }
                Step::Parallel(p) => {
                    for b in &p.branches {
                        let mut inner = HashSet::new();
                        walk(&b.steps, &mut inner);
                        out.extend(inner.iter().map(|v| format!("{}.{v}", b.name)));
                        out.extend(inner);
                    }
                }
            }
        }
    }
    let mut out = HashSet::new();
    walk(&scenario.steps, &mut out);
    out
}

/// 원문 안의 `{{이름}}` 토큰 중 하나라도 `names`에 있으면 참(엔진 토큰 규칙: 안쪽 trim).
fn refs_any(raw: &str, names: &HashSet<String>) -> bool {
    if names.is_empty() {
        return false;
    }
    let mut rest = raw;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            return false;
        };
        let name = after[..end].trim();
        // 캐스트 접미(`:num` 등)가 붙은 꼴도 같은 변수로 본다.
        let bare = name.rsplit_once(':').map_or(name, |(n, _)| n.trim());
        if names.contains(name) || names.contains(bare) {
            return true;
        }
        rest = &after[end + 2..];
    }
    false
}

/// IF 조건 연산 기호(성공 조건 라벨과 별개 — spec §6.3).
pub(crate) fn if_op_symbol(op: CompareOp) -> &'static str {
    match op {
        CompareOp::Eq => "=",
        CompareOp::Ne => "≠",
        CompareOp::Lt => "<",
        CompareOp::Gt => ">",
        CompareOp::Lte => "≤",
        CompareOp::Gte => "≥",
        CompareOp::Contains => "포함",
        CompareOp::Matches => "~",
        CompareOp::Exists => "값 있음",
        CompareOp::Empty => "비어 있음",
    }
}

/// 스텝을 감싼 조상 하나(바깥→안 순서로 쌓인다).
#[derive(Clone)]
enum Anc<'a> {
    /// IF 노드와 이 스텝이 속한 분기 라벨(`then`/`elif_{j}`/`else`).
    If(&'a IfStep, String),
    /// parallel 노드 id와 분기 인덱스.
    Par(&'a str, usize),
}

/// http 스텝·IF 노드 id → 조상 체인(바깥→안).
fn ancestors(scenario: &Scenario) -> HashMap<&str, Vec<Anc<'_>>> {
    fn walk<'a>(
        steps: &'a [Step],
        stack: &mut Vec<Anc<'a>>,
        out: &mut HashMap<&'a str, Vec<Anc<'a>>>,
    ) {
        for s in steps {
            match s {
                Step::Http(h) => {
                    out.insert(h.id.as_str(), stack.clone());
                }
                Step::Loop(l) => walk(&l.do_, stack, out),
                Step::If(i) => {
                    out.insert(i.id.as_str(), stack.clone());
                    let arms = std::iter::once(("then".to_string(), &i.then_))
                        .chain(
                            i.elif
                                .iter()
                                .enumerate()
                                .map(|(j, e)| (format!("elif_{j}"), &e.then_)),
                        )
                        .chain(std::iter::once(("else".to_string(), &i.else_)));
                    for (label, body) in arms {
                        stack.push(Anc::If(i, label));
                        walk(body, stack, out);
                        stack.pop();
                    }
                }
                Step::Parallel(p) => {
                    for (bi, b) in p.branches.iter().enumerate() {
                        stack.push(Anc::Par(p.id.as_str(), bi));
                        walk(&b.steps, stack, out);
                        stack.pop();
                    }
                }
            }
        }
    }
    let mut out = HashMap::new();
    walk(&scenario.steps, &mut Vec::new(), &mut out);
    out
}

/// 이 스텝과 같은 parallel 조상의 **다른 분기**에 속한 행인가.
fn in_sibling_branch(mine: &[Anc<'_>], theirs: Option<&Vec<Anc<'_>>>) -> bool {
    let Some(theirs) = theirs else {
        return false;
    };
    mine.iter().any(|m| {
        let Anc::Par(pid, bi) = m else {
            return false;
        };
        theirs
            .iter()
            .any(|t| matches!(t, Anc::Par(tp, tb) if tp == pid && tb != bi))
    })
}

/// 제외 결정 행 — IF 조상을 바깥→안으로 보며 각 IF의 마지막 결정 행이 이 스텝의 분기를
/// 고르지 않았으면 그 행. 결정 행 없는 IF(도달 못 함)를 만나면 없음.
fn exclusion_row<'a>(
    chain: &[Anc<'a>],
    trace: &ScenarioTrace,
) -> Option<(usize, &'a IfStep, String)> {
    for a in chain {
        let Anc::If(if_step, label) = a else {
            continue;
        };
        let (idx, row) = trace
            .steps
            .iter()
            .enumerate()
            .rfind(|(_, s)| s.kind == StepKind::If && s.step_id == if_step.id)?;
        if row.branch.as_deref() != Some(label.as_str()) {
            return Some((idx, if_step, label.clone()));
        }
    }
    None
}

fn step_name(h: Option<&HttpStep>, id: &str) -> String {
    match h {
        Some(h) if !h.name.is_empty() => h.name.clone(),
        _ => id.to_string(),
    }
}

fn if_name(i: &IfStep) -> &str {
    if i.name.is_empty() { &i.id } else { &i.name }
}

/// 규칙 3의 에러 사유: 변수 미설정 → 설정 오류 / 시간 초과 → `시간 초과(N초)` / 그 밖 `classify`.
fn error_verdict(
    http: Option<&HttpStep>,
    row: &StepTrace,
    err: &str,
    limit_secs: u32,
) -> (Verdict, String) {
    if !row.unbound_vars.is_empty() {
        (Verdict::ConfigError, REASON_UNBOUND_VAR.to_string())
    } else if row.timed_out {
        (Verdict::Fail, reason_timeout(limit_secs))
    } else {
        (Verdict::Fail, classify(http, row, err))
    }
}

/// 대상 표기: 원문이 정확히 `{{이름}}`이면 `이름`, 아니면 원문.
fn target_label(left: &str) -> &str {
    left.strip_prefix("{{")
        .and_then(|s| s.strip_suffix("}}"))
        .map(str::trim)
        .filter(|n| !n.is_empty() && !n.contains(['{', '}']) && !n.contains(char::is_whitespace))
        .unwrap_or(left)
}

fn result(
    at_ms: i64,
    verdict: Verdict,
    reason: Option<String>,
    detail: Option<String>,
) -> CheckResult {
    CheckResult {
        at_ms,
        verdict,
        latency_ms: None,
        reason: reason.map(|r| shown(&r)),
        detail: detail.map(|d| shown(&d)),
        display: Vec::new(),
    }
}

/// 규칙 4 — 제외 결정 행의 판정 근거로 분기 제외(또는 분기 값 없음) 결과.
fn branch_result(
    at_ms: i64,
    row: &StepTrace,
    if_step: &IfStep,
    label: &str,
    auth_vars: &HashSet<String>,
) -> CheckResult {
    let name = if_name(if_step);
    // 이 스텝 분기의 조건이 평가돼 거짓이면 그 조건, 아니면 앞 분기가 참이라 선점한 조건.
    let blocking: Option<&BranchEval> = row
        .branch_eval
        .iter()
        .find(|e| e.branch == label && !e.passed)
        .or_else(|| row.branch_eval.iter().find(|e| e.passed));
    let Some(e) = blocking else {
        return result(at_ms, Verdict::BranchSkipped, None, Some(name.to_string()));
    };
    let Some(l) = &e.leaf else {
        let big = if e.passed {
            "조건 = 참"
        } else {
            "조건 = 거짓"
        };
        return result(
            at_ms,
            Verdict::BranchSkipped,
            Some(big.to_string()),
            Some(name.to_string()),
        );
    };
    let presence_op = matches!(l.op, CompareOp::Exists | CompareOp::Empty);
    if l.left_unbound && !presence_op {
        return result(
            at_ms,
            Verdict::Fail,
            Some(REASON_BRANCH_VALUE_MISSING.to_string()),
            Some(name.to_string()),
        );
    }
    let target = target_label(&l.left);
    // 보안: 환경 값 참조는 엔진이 값을 싣지 않지만, 원문으로도 한 번 더 막는다.
    // 인증 출처 흐름 변수(쿠키·인증 헤더 추출)는 값 대신 고정 문구 — 출처 기반.
    let value = match l.left_value.as_deref() {
        Some(_) if l.left.contains("${") => ENV_VALUE_TEXT.to_string(),
        None => ENV_VALUE_TEXT.to_string(),
        Some(_) if refs_any(&l.left, auth_vars) => AUTH_VALUE_TEXT.to_string(),
        Some(v) if presence_op => if v.is_empty() {
            "비어 있음"
        } else {
            "값 있음"
        }
        .to_string(),
        Some("") => EMPTY_TEXT.to_string(),
        Some(v) => v.to_string(),
    };
    let sym = if_op_symbol(l.op);
    let cond = if presence_op {
        format!("조건 {target} {sym}")
    } else {
        let right = l
            .right
            .as_deref()
            .filter(|r| !r.is_empty())
            .unwrap_or(EMPTY_TEXT);
        format!("조건 {target} {sym} {right}")
    };
    result(
        at_ms,
        Verdict::BranchSkipped,
        Some(format!("{target} = {value}")),
        Some(format!("{cond} · {name}")),
    )
}

/// 칸별 1차 분류(대리 원인 칸 결정 전).
enum Pre {
    Missing,
    /// 앞 구간의 첫 엔진 수준 실패 행 인덱스.
    Cause(usize),
    Own,
}

/// 실행 단위의 스텝 칸 전부를 한 번에 판정 — 결과는 `panels`와 같은 길이·순서.
pub fn judge_unit(
    scenario: &Scenario,
    panels: &[PanelConfig],
    trace: &ScenarioTrace,
    at_ms: i64,
    flow_cap_secs: u32,
    step_limits: &HashMap<String, u32>,
) -> Vec<CheckResult> {
    // 설정 단계 실패(HTTP 클라이언트 생성 등 — 행 0개)는 흐름 전체 판정과 같게 모든 칸 실패.
    if trace.error.is_some() {
        return panels
            .iter()
            .map(|p| {
                let mut r = result(
                    at_ms,
                    Verdict::Fail,
                    Some(REASON_TRACE_ERROR.to_string()),
                    None,
                );
                r.display = display_values(p, trace);
                r
            })
            .collect();
    }
    let mut all = Vec::new();
    collect_http_steps(&scenario.steps, &mut all);
    let find_http = |id: &str| all.iter().copied().find(|h| h.id == id);
    let anc = ancestors(scenario);
    let auth_vars = auth_var_names(scenario);
    let limit = |id: &str, fallback: u32| step_limits.get(id).copied().unwrap_or(fallback);
    let rows = &trace.steps;
    let empty: Vec<Anc<'_>> = Vec::new();

    // 1차: 칸마다 스텝 존재·앞 구간 끝·원인 행.
    let mut pre: Vec<Pre> = Vec::with_capacity(panels.len());
    let mut front_end: Vec<usize> = Vec::with_capacity(panels.len());
    for p in panels {
        let sid = p.step_id.as_deref().unwrap_or_default();
        if find_http(sid).is_none() {
            pre.push(Pre::Missing);
            front_end.push(0);
            continue;
        }
        let chain = anc.get(sid).unwrap_or(&empty);
        let first_row = rows
            .iter()
            .position(|s| s.kind == StepKind::Http && s.step_id == sid);
        let end = first_row
            .or_else(|| exclusion_row(chain, trace).map(|(i, _, _)| i))
            .unwrap_or(rows.len());
        let cause = rows[..end].iter().position(|s| {
            s.kind == StepKind::Http
                && s.error.is_some()
                && !in_sibling_branch(chain, anc.get(s.step_id.as_str()))
        });
        pre.push(cause.map_or(Pre::Own, Pre::Cause));
        front_end.push(end);
    }

    // 원인 칸의 판정이 먼저 정해지도록 앞 구간 끝 순서로 계산(원인 칸의 앞 구간 끝 ≤ 원인 행
    // < 이 칸의 앞 구간 끝 — 순환 없음).
    let mut order: Vec<usize> = (0..panels.len()).collect();
    order.sort_by_key(|&i| front_end[i]);
    let mut out: Vec<Option<CheckResult>> = vec![None; panels.len()];

    for i in order {
        let p = &panels[i];
        let sid = p.step_id.as_deref().unwrap_or_default();
        let r = match pre[i] {
            Pre::Missing => result(
                at_ms,
                Verdict::ConfigError,
                Some(REASON_LATENCY_STEP_MISSING.to_string()),
                None,
            ),
            Pre::Cause(ci) => {
                let crow = &rows[ci];
                let cid = crow.step_id.as_str();
                let chttp = find_http(cid);
                let cname = step_name(chttp, cid);
                let cause_panel_failed = panels.iter().enumerate().any(|(j, q)| {
                    q.step_id.as_deref() == Some(cid)
                        && out[j].as_ref().is_some_and(|r| {
                            matches!(r.verdict, Verdict::Fail | Verdict::ConfigError)
                        })
                });
                // 같은 원인 스텝을 가진 칸 중 칸 배열 순서가 가장 앞인 칸 = 대리 원인 칸.
                let stand_in = !cause_panel_failed
                    && (0..panels.len())
                        .find(|&k| matches!(pre[k], Pre::Cause(ck) if rows[ck].step_id == cid))
                        == Some(i);
                if stand_in {
                    let err = crow.error.as_deref().unwrap_or_default();
                    let (v, why) =
                        error_verdict(chttp, crow, err, limit(cid, DEFAULT_STEP_LIMIT_SECS));
                    result(
                        at_ms,
                        v,
                        Some(REASON_UPSTREAM.to_string()),
                        Some(format!("{cname} · {why}")),
                    )
                } else {
                    result(
                        at_ms,
                        Verdict::UpstreamFailed,
                        Some(REASON_UPSTREAM.to_string()),
                        Some(format!("{cname}에서 멈춤")),
                    )
                }
            }
            Pre::Own => own_result(
                &all,
                p,
                sid,
                trace,
                at_ms,
                flow_cap_secs,
                limit(sid, p.timeout_seconds),
                anc.get(sid).unwrap_or(&empty),
                &auth_vars,
            ),
        };
        out[i] = Some(r);
    }

    out.into_iter()
        .zip(panels)
        .map(|(r, p)| {
            let mut r = r.expect("모든 칸이 계산됨");
            r.display = display_values(p, trace);
            r
        })
        .collect()
}

/// 규칙 3–5(앞 단계 실패 없음).
#[allow(clippy::too_many_arguments)]
fn own_result(
    all: &[&HttpStep],
    panel: &PanelConfig,
    sid: &str,
    trace: &ScenarioTrace,
    at_ms: i64,
    flow_cap_secs: u32,
    limit_secs: u32,
    chain: &[Anc<'_>],
    auth_vars: &HashSet<String>,
) -> CheckResult {
    // 규칙 3: 실행됨 — 마지막 행 기준.
    if let Some(row) = trace
        .steps
        .iter()
        .rfind(|s| s.kind == StepKind::Http && s.step_id == sid)
    {
        if let Some(err) = row.error.as_deref() {
            let http = all.iter().copied().find(|h| h.id == sid);
            let (v, why) = error_verdict(http, row, err, limit_secs);
            return result(at_ms, v, Some(why), None);
        }
        if let Some(r) = eval_conditions(all, panel, trace, at_ms) {
            return r;
        }
        return CheckResult {
            at_ms,
            verdict: Verdict::Ok,
            latency_ms: row.response.as_ref().map(|r| r.latency_ms),
            reason: None,
            detail: None,
            display: Vec::new(),
        };
    }
    // 규칙 4: 분기 제외(truncated와 무관하게 우선).
    if let Some((idx, if_step, label)) = exclusion_row(chain, trace) {
        return branch_result(at_ms, &trace.steps[idx], if_step, &label, auth_vars);
    }
    // 규칙 5: 그 외 미실행.
    let reason = if trace.truncated {
        let http_rows = trace
            .steps
            .iter()
            .filter(|s| s.kind == StepKind::Http)
            .count();
        if http_rows >= MONITOR_MAX_REQUESTS as usize {
            REASON_REQUEST_CAP.to_string()
        } else {
            reason_timeout(flow_cap_secs)
        }
    } else {
        REASON_COND_STEP_NOT_RUN.to_string()
    };
    result(at_ms, Verdict::Fail, Some(reason), None)
}

#[cfg(test)]
mod tests {
    use super::super::check::{
        CheckResult, MONITOR_MAX_REQUESTS, REASON_LATENCY_STEP_MISSING, REASON_REQUEST_CAP,
        REASON_TRACE_ERROR, SHOWN_MAX_CHARS, Verdict,
    };
    use super::super::config::{
        Condition, ConditionOp as Op, ConditionSource as Src, LatencySource, PanelConfig,
    };
    use super::*;
    use handicap_engine::{
        BranchEval, CompareOp, LeafEval, Scenario, ScenarioTrace, StepKind, StepTrace,
        TracedRequest, TracedResponse,
    };
    use std::collections::{BTreeMap, HashMap};

    const L1: &str = "01HX0000000000000000000001";
    const L2: &str = "01HX0000000000000000000002";
    const BB: &str = "01HX0000000000000000000003";
    const IF: &str = "01HX0000000000000000000004";
    const H: &str = "01HX0000000000000000000005";
    const P: &str = "01HX0000000000000000000006";
    const Z: &str = "01HX0000000000000000000007";
    const LP: &str = "01HX0000000000000000000008";
    const PAR: &str = "01HX0000000000000000000009";
    const EA: &str = "01HX000000000000000000000A";
    const EB: &str = "01HX000000000000000000000B";
    const X: &str = "01HX000000000000000000000C";
    const FA: &str = "01HX000000000000000000000D";
    const FB: &str = "01HX000000000000000000000E";
    const GHOST: &str = "01HX00000000000000000000ZZ";

    fn http_yaml(id: &str, name: &str, indent: usize) -> String {
        let p = " ".repeat(indent);
        format!(
            "{p}- id: \"{id}\"\n{p}  name: {name}\n{p}  type: http\n{p}  request: {{ method: GET, url: \"http://x/{name}\" }}\n{p}  assert:\n{p}    - status: 200\n"
        )
    }

    /// `L1 → L2 → B(isRaceDay 추출) → IF "경마일 분기"({{isRaceDay}} eq true){ H, P } → Z`
    fn base() -> Scenario {
        let mut y = String::from("version: 1\nname: s\nsteps:\n");
        y += &http_yaml(L1, "L1", 2);
        y += &http_yaml(L2, "L2", 2);
        y += &http_yaml(BB, "B", 2);
        y += &format!(
            "  - id: \"{IF}\"\n    name: 경마일 분기\n    type: if\n    cond: {{ left: \"{{{{isRaceDay}}}}\", op: eq, right: \"true\" }}\n    then:\n"
        );
        y += &http_yaml(H, "H", 6);
        y += &http_yaml(P, "P", 6);
        y += &http_yaml(Z, "Z", 2);
        Scenario::from_yaml(&y).unwrap()
    }

    /// IF "경마일 분기" { then: [X], elif_0: [H] }
    fn elif_scn() -> Scenario {
        let mut y = String::from("version: 1\nname: s\nsteps:\n");
        y += &format!(
            "  - id: \"{IF}\"\n    name: 경마일 분기\n    type: if\n    cond: {{ left: \"{{{{a}}}}\", op: eq, right: \"1\" }}\n    then:\n"
        );
        y += &http_yaml(X, "X", 6);
        y += "    elif:\n      - cond: { left: \"{{a}}\", op: eq, right: \"2\" }\n        then:\n";
        y += &http_yaml(H, "H", 10);
        Scenario::from_yaml(&y).unwrap()
    }

    /// loop(2) { IF "경마일 분기" { H } }
    fn loop_if_scn() -> Scenario {
        let mut y = String::from("version: 1\nname: s\nsteps:\n");
        y += &format!("  - id: \"{LP}\"\n    name: 반복\n    type: loop\n    repeat: 2\n    do:\n");
        y += &format!(
            "      - id: \"{IF}\"\n        name: 경마일 분기\n        type: if\n        cond: {{ left: \"{{{{isRaceDay}}}}\", op: eq, right: \"true\" }}\n        then:\n"
        );
        y += &http_yaml(H, "H", 10);
        Scenario::from_yaml(&y).unwrap()
    }

    /// loop(2) { L1 } → L2
    fn loop_scn() -> Scenario {
        let mut y = String::from("version: 1\nname: s\nsteps:\n");
        y += &format!("  - id: \"{LP}\"\n    name: 반복\n    type: loop\n    repeat: 2\n    do:\n");
        y += &http_yaml(L1, "L1", 6);
        y += &http_yaml(L2, "L2", 2);
        Scenario::from_yaml(&y).unwrap()
    }

    /// parallel { a: [Ea], b: [Eb] }
    fn par_scn() -> Scenario {
        let mut y = String::from("version: 1\nname: s\nsteps:\n");
        y += &format!("  - id: \"{PAR}\"\n    name: 동시\n    type: parallel\n    branches:\n");
        y += "      - name: a\n        steps:\n";
        y += &http_yaml(EA, "Ea", 10);
        y += "      - name: b\n        steps:\n";
        y += &http_yaml(EB, "Eb", 10);
        Scenario::from_yaml(&y).unwrap()
    }

    fn resp(status: u16, latency: u64) -> TracedResponse {
        TracedResponse {
            status,
            latency_ms: latency,
            download_ms: None,
            headers: BTreeMap::new(),
            set_cookies: vec![],
            body: "{\"code\":\"1\"}".into(),
            body_truncated: false,
        }
    }

    fn st(id: &str, response: Option<TracedResponse>, error: Option<&str>) -> StepTrace {
        StepTrace {
            step_id: id.into(),
            kind: StepKind::Http,
            loop_index: None,
            branch: None,
            request: Some(TracedRequest {
                method: "GET".into(),
                url: "http://x".into(),
                headers: BTreeMap::new(),
                body: None,
            }),
            response,
            extracted: BTreeMap::new(),
            unbound_vars: vec![],
            error: error.map(String::from),
            branch_eval: vec![],
            timed_out: false,
        }
    }

    fn ok(id: &str, ms: u64) -> StepTrace {
        st(id, Some(resp(200, ms)), None)
    }

    fn li(mut s: StepTrace, i: u32) -> StepTrace {
        s.loop_index = Some(i);
        s
    }

    fn leaf(left: &str, op: CompareOp, right: Option<&str>, lv: Option<&str>) -> LeafEval {
        LeafEval {
            left: left.into(),
            op,
            right: right.map(String::from),
            left_value: lv.map(String::from),
            right_value: right.map(String::from),
            left_unbound: false,
        }
    }

    fn be(branch: &str, passed: bool, leaf: Option<LeafEval>) -> BranchEval {
        BranchEval {
            branch: branch.into(),
            passed,
            leaf,
        }
    }

    fn if_row(branch: &str, evals: Vec<BranchEval>) -> StepTrace {
        StepTrace {
            step_id: IF.into(),
            kind: StepKind::If,
            loop_index: None,
            branch: Some(branch.into()),
            request: None,
            response: None,
            extracted: BTreeMap::new(),
            unbound_vars: vec![],
            error: None,
            branch_eval: evals,
            timed_out: false,
        }
    }

    fn race_then() -> StepTrace {
        if_row(
            "then",
            vec![be(
                "then",
                true,
                Some(leaf(
                    "{{isRaceDay}}",
                    CompareOp::Eq,
                    Some("true"),
                    Some("true"),
                )),
            )],
        )
    }

    fn race_none(lv: &str) -> StepTrace {
        if_row(
            "none",
            vec![be(
                "then",
                false,
                Some(leaf("{{isRaceDay}}", CompareOp::Eq, Some("true"), Some(lv))),
            )],
        )
    }

    fn tr(steps: Vec<StepTrace>) -> ScenarioTrace {
        ScenarioTrace {
            ok: steps.iter().all(|s| s.error.is_none()),
            total_ms: 999,
            steps,
            final_vars: BTreeMap::new(),
            truncated: false,
            error: None,
        }
    }

    fn sp(step: &str) -> PanelConfig {
        PanelConfig {
            id: format!("p-{step}"),
            scenario_id: "sc".into(),
            latency_source: LatencySource::Step {
                step_id: step.into(),
            },
            step_id: Some(step.into()),
            ..PanelConfig::default()
        }
    }

    fn panels(ids: &[&str]) -> Vec<PanelConfig> {
        ids.iter().map(|s| sp(s)).collect()
    }

    fn run(sc: &Scenario, ps: &[PanelConfig], t: &ScenarioTrace) -> Vec<CheckResult> {
        judge_unit(sc, ps, t, 7, 21, &HashMap::new())
    }

    fn run_lim(
        sc: &Scenario,
        ps: &[PanelConfig],
        t: &ScenarioTrace,
        lim: &[(&str, u32)],
    ) -> Vec<CheckResult> {
        let m: HashMap<String, u32> = lim.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        judge_unit(sc, ps, t, 7, 21, &m)
    }

    fn assert_up(r: &CheckResult, cause: &str) {
        assert_eq!(r.verdict, Verdict::UpstreamFailed, "{r:?}");
        assert_eq!(r.reason.as_deref(), Some("앞 단계 실패"));
        assert_eq!(
            r.detail.as_deref(),
            Some(format!("{cause}에서 멈춤").as_str())
        );
        assert_eq!(r.latency_ms, None);
    }

    fn full_ok_trace() -> ScenarioTrace {
        tr(vec![
            ok(L1, 11),
            ok(L2, 12),
            ok(BB, 13),
            race_then(),
            ok(H, 14),
            ok(P, 15),
            ok(Z, 16),
        ])
    }

    #[test]
    fn all_ok() {
        let r = run(&base(), &panels(&[L1, L2, BB, H, P]), &full_ok_trace());
        assert_eq!(r.len(), 5);
        for (res, ms) in r.iter().zip([11, 12, 13, 14, 15]) {
            assert_eq!(res.verdict, Verdict::Ok, "{res:?}");
            assert_eq!(res.latency_ms, Some(ms));
            assert_eq!(res.at_ms, 7);
            assert_eq!(res.reason, None);
        }
    }

    #[test]
    fn upstream_error_greys_later_panels() {
        let t = tr(vec![
            ok(L1, 11),
            st(L2, Some(resp(503, 5)), Some("assertion failed: status")),
        ]);
        let r = run(&base(), &panels(&[L1, L2, BB, H, P]), &t);
        assert_eq!(r[0].verdict, Verdict::Ok);
        assert_eq!(r[1].verdict, Verdict::Fail);
        assert_eq!(r[1].reason.as_deref(), Some("HTTP 503"));
        assert_eq!(r[1].latency_ms, None);
        for x in &r[2..] {
            assert_up(x, "L2");
        }
    }

    #[test]
    fn cause_without_panel_stand_in() {
        let t = tr(vec![st(L1, None, Some("send: connection refused"))]);
        let r = run(&base(), &panels(&[L2, BB, H, P]), &t);
        assert_eq!(r[0].verdict, Verdict::Fail);
        assert_eq!(r[0].reason.as_deref(), Some("앞 단계 실패"));
        assert_eq!(r[0].detail.as_deref(), Some("L1 · 요청 실패"));
        assert_eq!(r[0].latency_ms, None);
        for x in &r[1..] {
            assert_up(x, "L1");
        }
    }

    #[test]
    fn stand_in_timeout_reason() {
        let mut row = st(L1, None, Some("send: timeout"));
        row.timed_out = true;
        let r = run_lim(&base(), &panels(&[L2, H]), &tr(vec![row]), &[(L1, 5)]);
        assert_eq!(r[0].verdict, Verdict::Fail);
        assert_eq!(r[0].reason.as_deref(), Some("앞 단계 실패"));
        assert_eq!(r[0].detail.as_deref(), Some("L1 · 시간 초과(5초)"));
        assert_up(&r[1], "L1");
    }

    #[test]
    fn stand_in_unbound_is_config_error() {
        let mut row = st(L1, None, Some("unbound var"));
        row.unbound_vars = vec!["token".into()];
        let r = run(&base(), &panels(&[L2]), &tr(vec![row]));
        assert_eq!(r[0].verdict, Verdict::ConfigError);
        assert_eq!(r[0].reason.as_deref(), Some("앞 단계 실패"));
        assert_eq!(r[0].detail.as_deref(), Some("L1 · 변수 미설정"));
    }

    #[test]
    fn loop_last_iteration_success_uses_stand_in() {
        let t = tr(vec![
            li(st(L1, None, Some("send: refused")), 0),
            li(ok(L1, 20), 1),
            ok(L2, 30),
        ]);
        let r = run(&loop_scn(), &panels(&[L1, L2]), &t);
        assert_eq!(r[0].verdict, Verdict::Ok);
        assert_eq!(r[0].latency_ms, Some(20));
        assert_eq!(r[1].verdict, Verdict::Fail);
        assert_eq!(r[1].reason.as_deref(), Some("앞 단계 실패"));
        assert_eq!(r[1].detail.as_deref(), Some("L1 · 요청 실패"));
    }

    #[test]
    fn condition_failure_upstream_does_not_grey() {
        let mut ps = panels(&[L1, L2]);
        ps[0].conditions = vec![Condition {
            step_id: L1.into(),
            source: Src::Body,
            path: "$.code".into(),
            op: Op::Eq,
            value: "0".into(),
            ..Condition::default()
        }];
        let r = run(&base(), &ps, &full_ok_trace());
        assert_eq!(r[0].verdict, Verdict::Fail);
        assert_eq!(r[0].reason.as_deref(), Some("1"));
        assert_eq!(r[1].verdict, Verdict::Ok);
        assert_eq!(r[1].latency_ms, Some(12));
    }

    #[test]
    fn own_timeout() {
        let mut h = st(H, None, Some("send: timeout"));
        h.timed_out = true;
        let t = tr(vec![ok(L1, 1), ok(L2, 1), ok(BB, 1), race_then(), h]);
        let r = run_lim(&base(), &panels(&[H, P]), &t, &[(H, 3)]);
        assert_eq!(r[0].verdict, Verdict::Fail);
        assert_eq!(r[0].reason.as_deref(), Some("시간 초과(3초)"));
        assert_up(&r[1], "H");
    }

    #[test]
    fn branch_skipped_shows_value() {
        let t = tr(vec![ok(L1, 1), ok(L2, 1), ok(BB, 1), race_none("false")]);
        let r = run(&base(), &panels(&[H, P]), &t);
        for x in &r {
            assert_eq!(x.verdict, Verdict::BranchSkipped, "{x:?}");
            assert_eq!(x.reason.as_deref(), Some("isRaceDay = false"));
            assert_eq!(
                x.detail.as_deref(),
                Some("조건 isRaceDay = true · 경마일 분기")
            );
            assert_eq!(x.latency_ms, None);
        }
    }

    #[test]
    fn branch_after_error_not_upstream() {
        let t = tr(vec![
            ok(L1, 1),
            ok(L2, 1),
            ok(BB, 1),
            race_none("false"),
            st(Z, None, Some("send: refused")),
        ]);
        let r = run(&base(), &panels(&[H, P, Z]), &t);
        assert_eq!(r[0].verdict, Verdict::BranchSkipped);
        assert_eq!(r[1].verdict, Verdict::BranchSkipped);
        assert_eq!(r[2].verdict, Verdict::Fail);
        assert_eq!(r[2].reason.as_deref(), Some("요청 실패"));
    }

    #[test]
    fn branch_value_missing() {
        let mut l = leaf("{{isRaceDay}}", CompareOp::Eq, Some("true"), Some(""));
        l.left_unbound = true;
        let t = tr(vec![
            ok(L1, 1),
            if_row("none", vec![be("then", false, Some(l))]),
        ]);
        let r = run(&base(), &panels(&[H]), &t);
        assert_eq!(r[0].verdict, Verdict::Fail);
        assert_eq!(r[0].reason.as_deref(), Some("분기 값 없음"));
        assert_eq!(r[0].detail.as_deref(), Some("경마일 분기"));
        assert_eq!(r[0].latency_ms, None);
    }

    #[test]
    fn branch_exists_op_unbound_is_skip() {
        let mut l = leaf("{{isRaceDay}}", CompareOp::Exists, None, Some(""));
        l.left_unbound = true;
        let t = tr(vec![if_row("none", vec![be("then", false, Some(l))])]);
        let r = run(&base(), &panels(&[H]), &t);
        assert_eq!(r[0].verdict, Verdict::BranchSkipped);
        assert_eq!(r[0].reason.as_deref(), Some("isRaceDay = 비어 있음"));
        assert_eq!(
            r[0].detail.as_deref(),
            Some("조건 isRaceDay 값 있음 · 경마일 분기")
        );
    }

    #[test]
    fn exists_op_with_value_shows_present() {
        // empty 연산이 값 때문에 거짓 → "값 있음"
        let l = leaf("{{isRaceDay}}", CompareOp::Empty, None, Some("Y"));
        let t = tr(vec![if_row("none", vec![be("then", false, Some(l))])]);
        let r = run(&base(), &panels(&[H]), &t);
        assert_eq!(r[0].reason.as_deref(), Some("isRaceDay = 값 있음"));
        assert_eq!(
            r[0].detail.as_deref(),
            Some("조건 isRaceDay 비어 있음 · 경마일 분기")
        );
    }

    #[test]
    fn env_value_hidden() {
        let l = leaf("${RACE}", CompareOp::Eq, Some("Y"), None);
        let t = tr(vec![if_row("none", vec![be("then", false, Some(l))])]);
        let r = run(&base(), &panels(&[H]), &t);
        assert_eq!(r[0].verdict, Verdict::BranchSkipped);
        assert_eq!(r[0].reason.as_deref(), Some("${RACE} = (환경 값)"));
        assert_eq!(
            r[0].detail.as_deref(),
            Some("조건 ${RACE} = Y · 경마일 분기")
        );
    }

    #[test]
    fn preempted_by_earlier_branch() {
        let t = tr(vec![
            if_row(
                "then",
                vec![be(
                    "then",
                    true,
                    Some(leaf("{{a}}", CompareOp::Eq, Some("1"), Some("1"))),
                )],
            ),
            ok(X, 3),
        ]);
        let r = run(&elif_scn(), &panels(&[H, X]), &t);
        assert_eq!(r[0].verdict, Verdict::BranchSkipped);
        assert_eq!(r[0].reason.as_deref(), Some("a = 1"));
        assert_eq!(r[0].detail.as_deref(), Some("조건 a = 1 · 경마일 분기"));
        assert_eq!(r[1].verdict, Verdict::Ok);
    }

    #[test]
    fn own_branch_false_after_earlier_false() {
        // then 거짓 → elif_0(H) 거짓 → none: 막은 조건 = H 분기 자신의 조건
        let t = tr(vec![if_row(
            "none",
            vec![
                be(
                    "then",
                    false,
                    Some(leaf("{{a}}", CompareOp::Eq, Some("1"), Some("3"))),
                ),
                be(
                    "elif_0",
                    false,
                    Some(leaf("{{a}}", CompareOp::Eq, Some("2"), Some("3"))),
                ),
            ],
        )]);
        let r = run(&elif_scn(), &panels(&[H]), &t);
        assert_eq!(r[0].verdict, Verdict::BranchSkipped);
        assert_eq!(r[0].reason.as_deref(), Some("a = 3"));
        assert_eq!(r[0].detail.as_deref(), Some("조건 a = 2 · 경마일 분기"));
    }

    #[test]
    fn empty_group_reason() {
        let t = tr(vec![if_row("none", vec![be("then", false, None)])]);
        let r = run(&base(), &panels(&[H]), &t);
        assert_eq!(r[0].verdict, Verdict::BranchSkipped);
        assert_eq!(r[0].reason.as_deref(), Some("조건 = 거짓"));
        assert_eq!(r[0].detail.as_deref(), Some("경마일 분기"));
        // 빈 then이 참이라 elif_0(H)를 선점
        let t = tr(vec![if_row("then", vec![be("then", true, None)])]);
        let r = run(&elif_scn(), &panels(&[H]), &t);
        assert_eq!(r[0].reason.as_deref(), Some("조건 = 참"));
        assert_eq!(r[0].detail.as_deref(), Some("경마일 분기"));
    }

    #[test]
    fn if_in_loop_uses_last_decision_row() {
        let t = tr(vec![li(race_none("x"), 0), li(race_none("y"), 1)]);
        let r = run(&loop_if_scn(), &panels(&[H]), &t);
        assert_eq!(r[0].verdict, Verdict::BranchSkipped);
        assert_eq!(r[0].reason.as_deref(), Some("isRaceDay = y"));
        // 보조: 첫 회차 then(H 성공), 둘째 none → 규칙 3(실행됨)이 우선
        let t = tr(vec![
            li(race_then(), 0),
            li(ok(H, 9), 0),
            li(race_none("y"), 1),
        ]);
        let r = run(&loop_if_scn(), &panels(&[H]), &t);
        assert_eq!(r[0].verdict, Verdict::Ok);
        assert_eq!(r[0].latency_ms, Some(9));
    }

    #[test]
    fn parallel_sibling_error_not_upstream() {
        let t = tr(vec![st(EA, None, Some("send: refused")), ok(EB, 4)]);
        let r = run(&par_scn(), &panels(&[EA, EB]), &t);
        assert_eq!(r[0].verdict, Verdict::Fail);
        assert_eq!(r[0].reason.as_deref(), Some("요청 실패"));
        assert_eq!(r[1].verdict, Verdict::Ok);
        assert_eq!(r[1].latency_ms, Some(4));
        // Eb가 실행되지 않았어도(분기 b 미실행) a의 에러는 원인이 아니다.
        let t = tr(vec![st(EA, None, Some("send: refused"))]);
        let mut t = t;
        t.truncated = true;
        let r = run(&par_scn(), &panels(&[EB]), &t);
        assert_eq!(r[0].verdict, Verdict::Fail);
        assert_eq!(r[0].reason.as_deref(), Some("시간 초과(21초)"));
    }

    #[test]
    fn missing_step_only_that_panel_config_error() {
        let r = run(&base(), &panels(&[L1, GHOST, L2]), &full_ok_trace());
        assert_eq!(r[0].verdict, Verdict::Ok);
        assert_eq!(r[1].verdict, Verdict::ConfigError);
        assert_eq!(r[1].reason.as_deref(), Some(REASON_LATENCY_STEP_MISSING));
        assert_eq!(r[2].verdict, Verdict::Ok);
        assert_eq!(r[2].latency_ms, Some(12));
    }

    #[test]
    fn truncated_not_run_reason() {
        let mut t = tr(vec![ok(L1, 1), ok(L2, 1)]);
        t.truncated = true;
        let r = run(&base(), &panels(&[H]), &t);
        assert_eq!(r[0].verdict, Verdict::Fail);
        assert_eq!(r[0].reason.as_deref(), Some("시간 초과(21초)"));
        let mut t = tr((0..MONITOR_MAX_REQUESTS).map(|_| ok(L1, 1)).collect());
        t.truncated = true;
        let r = run(&base(), &panels(&[H]), &t);
        assert_eq!(r[0].reason.as_deref(), Some(REASON_REQUEST_CAP));
        // truncated 아님 + 미실행 → 조건 스텝 미실행
        let r = run(&base(), &panels(&[H]), &tr(vec![ok(L1, 1)]));
        assert_eq!(r[0].verdict, Verdict::Fail);
        assert_eq!(r[0].reason.as_deref(), Some("조건 스텝 미실행"));
    }

    #[test]
    fn skip_beats_truncated() {
        let mut t = tr(vec![ok(L1, 1), race_none("false")]);
        t.truncated = true;
        let r = run(&base(), &panels(&[H]), &t);
        assert_eq!(r[0].verdict, Verdict::BranchSkipped);
    }

    #[test]
    fn new_reasons_pass_through_shown() {
        let long = format!("\u{202E}{}", "v".repeat(300));
        let t = tr(vec![race_none(&long)]);
        let r = run(&base(), &panels(&[H]), &t);
        let reason = r[0].reason.as_deref().unwrap();
        assert!(!reason.contains('\u{202E}'), "{reason}");
        assert!(reason.chars().count() <= SHOWN_MAX_CHARS);
        assert!(reason.ends_with('…'));
        // 긴 IF 이름·대상도 상세에서 잘린다
        let sc = Scenario::from_yaml(&format!(
            "version: 1\nname: s\nsteps:\n  - id: \"{IF}\"\n    name: \"\u{202E}{}\"\n    type: if\n    cond: {{ left: \"1\", op: eq, right: \"2\" }}\n    then:\n{}",
            "n".repeat(300),
            http_yaml(H, "H", 6)
        ))
        .unwrap();
        let t = tr(vec![if_row("none", vec![be("then", false, None)])]);
        let r = run(&sc, &panels(&[H]), &t);
        let d = r[0].detail.as_deref().unwrap();
        assert!(!d.contains('\u{202E}'));
        assert!(d.chars().count() <= SHOWN_MAX_CHARS && d.ends_with('…'));
        // 원인 스텝 이름도 shown 통과
        let mut sc = base();
        let Step::Http(h) = &mut sc.steps[0] else {
            panic!("L1은 http");
        };
        h.name = format!("\u{202E}{}", "m".repeat(300));
        let r = run(
            &sc,
            &panels(&[L2]),
            &tr(vec![st(L1, None, Some("send: x"))]),
        );
        let d = r[0].detail.as_deref().unwrap();
        assert!(!d.contains('\u{202E}') && d.chars().count() <= SHOWN_MAX_CHARS);
    }

    /// parallel { a: [Ea, Fa], b: [Eb, Fb] }
    fn par2_scn() -> Scenario {
        let mut y = String::from("version: 1\nname: s\nsteps:\n");
        y += &format!("  - id: \"{PAR}\"\n    name: 동시\n    type: parallel\n    branches:\n");
        y += "      - name: a\n        steps:\n";
        y += &http_yaml(EA, "Ea", 10);
        y += &http_yaml(FA, "Fa", 10);
        y += "      - name: b\n        steps:\n";
        y += &http_yaml(EB, "Eb", 10);
        y += &http_yaml(FB, "Fb", 10);
        Scenario::from_yaml(&y).unwrap()
    }

    #[test]
    fn earliest_cause_row_wins() {
        // 실제 trace는 첫 에러에서 멈추지 않는다 — 앞 구간에 에러 행이 여럿.
        let t = tr(vec![
            st(L1, None, Some("send: refused")),
            st(L2, Some(resp(503, 5)), Some("assertion failed: status")),
            ok(BB, 1),
            race_then(),
            ok(H, 1),
            ok(P, 1),
            ok(Z, 1),
        ]);
        let r = run(&base(), &panels(&[L1, L2, H]), &t);
        assert_eq!(r[0].verdict, Verdict::Fail);
        assert_eq!(r[0].reason.as_deref(), Some("요청 실패"));
        assert_up(&r[1], "L1");
        assert_up(&r[2], "L1");
    }

    #[test]
    fn panel_order_differs_from_trace_order() {
        // 칸 배열 [H, L2](trace 순서와 반대) — L2 칸이 빨강이므로 H는 대리 칸이 아니라 확인 못 함.
        let t = tr(vec![
            ok(L1, 1),
            st(L2, Some(resp(503, 5)), Some("assertion failed: status")),
            ok(BB, 1),
            race_then(),
            ok(H, 1),
            ok(P, 1),
        ]);
        let r = run(&base(), &panels(&[H, L2]), &t);
        assert_up(&r[0], "L2");
        assert_eq!(r[1].verdict, Verdict::Fail);
        assert_eq!(r[1].reason.as_deref(), Some("HTTP 503"));
        // 원인 L1에 칸 없음, 칸 배열 [P, H] — H의 앞 구간이 먼저 끝나도 대리 칸은 배열 맨 앞 P.
        let t = tr(vec![
            st(L1, None, Some("send: refused")),
            ok(L2, 1),
            ok(BB, 1),
            race_then(),
            ok(H, 1),
            ok(P, 1),
        ]);
        let r = run(&base(), &panels(&[P, H]), &t);
        assert_eq!(r[0].verdict, Verdict::Fail);
        assert_eq!(r[0].reason.as_deref(), Some("앞 단계 실패"));
        assert_eq!(r[0].detail.as_deref(), Some("L1 · 요청 실패"));
        assert_up(&r[1], "L1");
    }

    #[test]
    fn trace_error_all_panels_fail() {
        let mut t = tr(vec![]);
        t.error = Some("http client build: boom".into());
        let r = run(&base(), &panels(&[L1, H, GHOST]), &t);
        assert_eq!(r.len(), 3);
        for x in &r {
            assert_eq!(x.verdict, Verdict::Fail, "{x:?}");
            assert_eq!(x.reason.as_deref(), Some(REASON_TRACE_ERROR));
            assert_eq!(x.detail, None);
            assert_eq!(x.latency_ms, None);
        }
    }

    #[test]
    fn empty_left_value_shown_as_quotes() {
        let t = tr(vec![race_none("")]);
        let r = run(&base(), &panels(&[H]), &t);
        assert_eq!(r[0].verdict, Verdict::BranchSkipped);
        assert_eq!(r[0].reason.as_deref(), Some("isRaceDay = \"\""));
    }

    #[test]
    fn one_stand_in_per_cause() {
        let t = tr(vec![
            st(EA, None, Some("send: refused")),
            ok(FA, 1),
            st(EB, Some(resp(503, 2)), Some("assertion failed: status")),
            ok(FB, 1),
        ]);
        let r = run(&par2_scn(), &panels(&[FA, FB]), &t);
        assert_eq!(r[0].verdict, Verdict::Fail);
        assert_eq!(r[0].reason.as_deref(), Some("앞 단계 실패"));
        assert_eq!(r[0].detail.as_deref(), Some("Ea · 요청 실패"));
        assert_eq!(r[1].verdict, Verdict::Fail);
        assert_eq!(r[1].reason.as_deref(), Some("앞 단계 실패"));
        assert_eq!(r[1].detail.as_deref(), Some("Eb · HTTP 503"));
    }

    #[test]
    fn display_values_filled() {
        use super::super::config::{DisplayItem, DisplaySource};
        let mut ps = panels(&[L1]);
        ps[0].display_items = vec![DisplayItem {
            step_id: L1.into(),
            source: DisplaySource::Status,
            path: String::new(),
        }];
        let r = run(&base(), &ps, &full_ok_trace());
        assert_eq!(r[0].display, vec![Some("200".to_string())]);
    }

    #[test]
    fn if_op_symbols() {
        let cases = [
            (CompareOp::Eq, "="),
            (CompareOp::Ne, "≠"),
            (CompareOp::Lt, "<"),
            (CompareOp::Gt, ">"),
            (CompareOp::Lte, "≤"),
            (CompareOp::Gte, "≥"),
            (CompareOp::Contains, "포함"),
            (CompareOp::Matches, "~"),
            (CompareOp::Exists, "값 있음"),
            (CompareOp::Empty, "비어 있음"),
        ];
        for (op, sym) in cases {
            assert_eq!(if_op_symbol(op), sym, "{op:?}");
        }
    }

    /// `B({extract}) → IF "경마일 분기"({{isRaceDay}} ne "") { H }` — B가 `extract` 줄을 가진다.
    fn extract_scn(extract: &str) -> Scenario {
        let mut y = String::from("version: 1\nname: s\nsteps:\n");
        y += &http_yaml(BB, "B", 2);
        y += &format!("    extract:\n      - {extract}\n");
        y += &format!(
            "  - id: \"{IF}\"\n    name: 경마일 분기\n    type: if\n    cond: {{ left: \"{{{{isRaceDay}}}}\", op: ne, right: \"\" }}\n    then:\n"
        );
        y += &http_yaml(H, "H", 6);
        Scenario::from_yaml(&y).unwrap()
    }

    fn skipped_reason(sc: &Scenario, left: &str) -> CheckResult {
        let l = leaf(left, CompareOp::Ne, Some(""), Some("SECRET-SID-123"));
        let t = tr(vec![
            ok(BB, 1),
            if_row("none", vec![be("then", false, Some(l))]),
        ]);
        let r = run(sc, &panels(&[H]), &t);
        assert_eq!(r[0].verdict, Verdict::BranchSkipped, "{:?}", r[0]);
        r.into_iter().next().unwrap()
    }

    fn assert_no_secret(r: &CheckResult) {
        for s in [&r.reason, &r.detail].into_iter().flatten() {
            assert!(!s.contains("SECRET-SID-123"), "값 노출: {r:?}");
        }
    }

    #[test]
    fn cookie_extract_value_masked() {
        let sc = extract_scn("{ from: cookie, var: isRaceDay, name: SESSION }");
        let r = skipped_reason(&sc, "{{isRaceDay}}");
        assert_eq!(r.reason.as_deref(), Some("isRaceDay = (인증 값)"));
        assert_no_secret(&r);
        // 토큰이 원문 안 어디에 있든(공백 포함) 같은 출처면 가린다.
        let r = skipped_reason(&sc, "Bearer {{ isRaceDay }}");
        assert_eq!(
            r.reason.as_deref(),
            Some("Bearer {{ isRaceDay }} = (인증 값)")
        );
        assert_no_secret(&r);
    }

    #[test]
    fn auth_header_extract_value_masked() {
        let sc = extract_scn("{ from: header, var: isRaceDay, name: AUTHORIZATION }");
        let r = skipped_reason(&sc, "{{isRaceDay}}");
        assert_eq!(r.reason.as_deref(), Some("isRaceDay = (인증 값)"));
        assert_no_secret(&r);
    }

    #[test]
    fn non_auth_header_extract_value_shown() {
        let sc = extract_scn("{ from: header, var: isRaceDay, name: X-Race-Day }");
        let r = skipped_reason(&sc, "{{isRaceDay}}");
        assert_eq!(r.reason.as_deref(), Some("isRaceDay = SECRET-SID-123"));
    }

    #[test]
    fn parallel_merged_auth_name_masked() {
        // parallel { a: [Ea(cookie → sid)], b: [Eb] } → IF({{a.sid}} ne "") { H }
        let mut y = String::from("version: 1\nname: s\nsteps:\n");
        y += &format!("  - id: \"{PAR}\"\n    name: 동시\n    type: parallel\n    branches:\n");
        y += "      - name: a\n        steps:\n";
        y += &http_yaml(EA, "Ea", 10);
        y += "            extract:\n              - { from: cookie, var: sid, name: SESSION }\n";
        y += "      - name: b\n        steps:\n";
        y += &http_yaml(EB, "Eb", 10);
        y += &format!(
            "  - id: \"{IF}\"\n    name: 경마일 분기\n    type: if\n    cond: {{ left: \"{{{{a.sid}}}}\", op: ne, right: \"\" }}\n    then:\n"
        );
        y += &http_yaml(H, "H", 6);
        let sc = Scenario::from_yaml(&y).unwrap();
        let l = leaf("{{a.sid}}", CompareOp::Ne, Some(""), Some("SECRET-SID-123"));
        let t = tr(vec![
            ok(EA, 1),
            ok(EB, 1),
            if_row("none", vec![be("then", false, Some(l))]),
        ]);
        let r = run(&sc, &panels(&[H]), &t);
        assert_eq!(r[0].verdict, Verdict::BranchSkipped, "{:?}", r[0]);
        assert_eq!(r[0].reason.as_deref(), Some("a.sid = (인증 값)"));
        assert_no_secret(&r[0]);
    }
}
