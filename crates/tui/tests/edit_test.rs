use handicap_controller::monitor::config::{
    BoardConfig, Condition, ConditionOp, ConditionSource, DisplayItem, LatencySource, PanelConfig,
    Threshold,
};
use handicap_tui::edit::*;
use handicap_tui::names::Names;
use handicap_tui::text;

const SC: &str = r#"
version: 1
name: 흐름
variables:
  host: "x"
steps:
  - { id: "01J00000000000000000000A01", name: a, type: http, request: { method: GET, url: "/a" }, assert: [] }
  - id: "01J00000000000000000000I01"
    name: 분기A
    type: if
    cond: { left: "{{code}}", op: eq, right: "200" }
    then:
      - { id: "01J00000000000000000000A03", name: c, type: http, request: { method: GET, url: "/c" }, assert: [] }
    else: []
"#;
const SC2: &str = "version: 1\nname: 빈\nsteps: []\n";

fn names() -> Names {
    let b = serde_json::json!({
        "format": "handicap-bundle", "format_version": 1, "boards": [],
        "scenarios": [{ "id": "S1", "yaml": SC }, { "id": "S2", "yaml": SC2 }],
        "environments": [
            { "id": "E1", "name": "운영", "vars": { "K": "v" } },
            { "id": "E2", "name": "빈환경", "vars": {} }
        ]
    });
    Names::from_bundle(&serde_json::to_vec(&b).unwrap())
}

const A: &str = "01J00000000000000000000A01";
const C: &str = "01J00000000000000000000A03";

fn cond(step: &str) -> Condition {
    Condition {
        step_id: step.into(),
        source: ConditionSource::Body,
        path: "$.x".into(),
        op: ConditionOp::Eq,
        value: "1".into(),
        ..Default::default()
    }
}
fn disp(step: &str) -> DisplayItem {
    DisplayItem {
        step_id: step.into(),
        path: "$.y".into(),
        ..Default::default()
    }
}
fn panel() -> PanelConfig {
    PanelConfig {
        id: "P1".into(),
        title: "t".into(),
        scenario_id: "S1".into(),
        ..Default::default()
    }
}
fn board(panels: Vec<PanelConfig>) -> BoardConfig {
    BoardConfig {
        panels,
        ..Default::default()
    }
}
fn ro(k: EditKind) -> &'static str {
    match k {
        EditKind::ReadOnly(s) => s,
        o => panic!("ReadOnly 아님: {o:?}"),
    }
}

#[test]
fn edit_kind_table() {
    let n = names();
    let mut p = panel();
    p.environment_id = Some("E1".into());
    assert_eq!(edit_kind(1, &p, &n), EditKind::Input(Field::Title));
    assert_eq!(ro(edit_kind(2, &p, &n)), "시나리오는 GUI에서 바꿉니다");
    assert_eq!(edit_kind(3, &p, &n), EditKind::Pick(Pick::Env));
    assert_eq!(ro(edit_kind(4, &p, &n)), "볼 스텝은 GUI에서 바꿉니다");
    assert_eq!(edit_kind(5, &p, &n), EditKind::Input(Field::Interval));
    assert_eq!(edit_kind(6, &p, &n), EditKind::Input(Field::Timeout));
    assert_eq!(edit_kind(7, &p, &n), EditKind::Pick(Pick::Latency));
    assert_eq!(edit_kind(8, &p, &n), EditKind::List(ListKind::Thresholds));
    assert_eq!(edit_kind(9, &p, &n), EditKind::Input(Field::BarCount));
    assert_eq!(edit_kind(10, &p, &n), EditKind::Input(Field::GraphMax));
    // 11·12 비었음
    assert_eq!(
        ro(edit_kind(11, &p, &n)),
        "조건 추가는 GUI에서(다음 버전에서 TUI 지원)"
    );
    assert_eq!(
        ro(edit_kind(12, &p, &n)),
        "표시 값 추가는 GUI에서(다음 버전에서 TUI 지원)"
    );
    p.conditions.push(cond(A));
    p.display_items.push(disp(A));
    assert_eq!(edit_kind(11, &p, &n), EditKind::List(ListKind::Conditions));
    assert_eq!(edit_kind(12, &p, &n), EditKind::List(ListKind::Display));
    // 13 환경 있음 / 없음 / 키 0개
    assert_eq!(edit_kind(13, &p, &n), EditKind::EnvVars);
    let mut q = p.clone();
    q.environment_id = None;
    assert_eq!(ro(edit_kind(13, &q, &n)), "이 칸은 환경을 쓰지 않습니다");
    q.environment_id = Some("E2".into());
    assert_eq!(ro(edit_kind(13, &q, &n)), "이 환경에는 변수가 없습니다");
    // 14 시나리오 변수 있음 / 없음(변수 비었음) / 못 읽음
    assert_eq!(edit_kind(14, &p, &n), EditKind::ScenarioVars);
    q.scenario_id = "S2".into();
    assert_eq!(ro(edit_kind(14, &q, &n)), "이 시나리오에는 변수가 없습니다");
    q.scenario_id = "nope".into();
    assert_eq!(ro(edit_kind(14, &q, &n)), "이 시나리오에는 변수가 없습니다");
    // 범위 밖
    assert_eq!(ro(edit_kind(0, &p, &n)), "");
    assert_eq!(ro(edit_kind(15, &p, &n)), "");

    // 묶음 스텝 칸
    let mut g = panel();
    g.group_id = Some("G1".into());
    g.step_id = Some(A.into());
    g.latency_source = LatencySource::Step { step_id: A.into() };
    let mg = "묶음의 값입니다 — 묶음 설정은 GUI에서";
    assert_eq!(ro(edit_kind(3, &g, &n)), mg);
    assert_eq!(ro(edit_kind(5, &g, &n)), mg);
    assert_eq!(edit_kind(4, &g, &n), EditKind::Pick(Pick::Step));
    assert_eq!(
        ro(edit_kind(7, &g, &n)),
        "스텝 칸은 그 스텝의 응답 시간을 씁니다"
    );
    assert_eq!(edit_kind(1, &g, &n), EditKind::Input(Field::Title));
    assert_eq!(edit_kind(6, &g, &n), EditKind::Input(Field::Timeout));
    assert_eq!(
        ro(edit_kind(11, &g, &n)),
        "조건 추가는 GUI에서(다음 버전에서 TUI 지원)"
    );
    // 단독 스텝 칸(묶음 아님·step_id 있음): 7은 읽기 전용, 4는 묶음 칸만 고른다
    let mut solo = panel();
    solo.step_id = Some(A.into());
    solo.latency_source = LatencySource::Step { step_id: A.into() };
    assert_eq!(
        ro(edit_kind(7, &solo, &n)),
        "스텝 칸은 그 스텝의 응답 시간을 씁니다"
    );
    assert_eq!(ro(edit_kind(4, &solo, &n)), "볼 스텝은 GUI에서 바꿉니다");
    // 묶음 칸의 환경이 키 0개
    g.environment_id = Some("E2".into());
    assert_eq!(ro(edit_kind(13, &g, &n)), "이 환경에는 변수가 없습니다");
}

#[test]
fn field_ranges_and_values() {
    assert_eq!(field_range(Field::Title), None);
    assert_eq!(field_range(Field::Interval), Some((1, 3600)));
    assert_eq!(field_range(Field::Timeout), Some((1, 30)));
    assert_eq!(field_range(Field::BarCount), Some((10, 300)));
    assert_eq!(field_range(Field::GraphMax), Some((100, 600_000)));
    let p = panel();
    assert_eq!(field_value(&p, Field::Title), "t");
    assert_eq!(field_value(&p, Field::Interval), "10");
    assert_eq!(field_value(&p, Field::Timeout), "5");
    assert_eq!(field_value(&p, Field::BarCount), "60");
    assert_eq!(field_value(&p, Field::GraphMax), "2000");
}

#[test]
fn set_field_and_env_and_out_of_range_index() {
    let cfg = board(vec![panel(), panel()]);
    let c = set_field(&cfg, 1, Field::Interval, " 30 ");
    assert_eq!(c.panels[1].interval_seconds, 30);
    assert_eq!(c.panels[0].interval_seconds, 10);
    assert_eq!(cfg.panels[1].interval_seconds, 10, "원본 불변");
    assert_eq!(
        set_field(&cfg, 0, Field::Timeout, "abc").panels[0].timeout_seconds,
        0
    );
    assert_eq!(set_field(&cfg, 0, Field::Title, "새").panels[0].title, "새");
    assert_eq!(
        set_field(&cfg, 0, Field::BarCount, "99").panels[0].bar_count,
        99
    );
    assert_eq!(
        set_field(&cfg, 0, Field::GraphMax, "500").panels[0].graph_max_ms,
        500
    );
    let e = set_env(&cfg, 0, Some("E2".into()));
    assert_eq!(e.panels[0].environment_id.as_deref(), Some("E2"));
    assert_eq!(set_env(&e, 0, None).panels[0].environment_id, None);
    // 범위 밖 칸 번호는 패닉 없이 그대로
    assert_eq!(set_field(&cfg, 9, Field::Title, "x"), cfg);
    assert_eq!(set_env(&cfg, 9, None), cfg);
    assert_eq!(set_step(&cfg, 9, A), cfg);
    assert_eq!(set_latency(&cfg, 9, None), cfg);
    assert_eq!(threshold_add(&cfg, 9, 5), cfg);
    assert_eq!(remove_at(&cfg, 9, ListKind::Display, 0), cfg);
    assert_eq!(swap_display(&cfg, 9), cfg);
}

#[test]
fn set_latency_total_and_step() {
    let cfg = board(vec![panel()]);
    let c = set_latency(&cfg, 0, Some(C));
    assert_eq!(
        c.panels[0].latency_source,
        LatencySource::Step { step_id: C.into() }
    );
    assert_eq!(
        set_latency(&c, 0, None).panels[0].latency_source,
        LatencySource::Total
    );
}

#[test]
#[allow(non_snake_case)]
fn set_step_matches_gui_setPanelStep() {
    let mut p = panel();
    p.conditions = vec![cond(A), cond(A)];
    p.display_items = vec![disp(A)];
    p.step_id = Some(A.into());
    assert_eq!(step_change_counts(&p), (2, 1));
    assert_eq!(step_change_counts(&panel()), (0, 0));
    let c = set_step(&board(vec![p]), 0, C);
    let q = &c.panels[0];
    assert_eq!(q.step_id.as_deref(), Some(C));
    assert_eq!(q.latency_source, LatencySource::Step { step_id: C.into() });
    assert!(q.conditions.iter().all(|x| x.step_id == C));
    assert!(q.display_items.iter().all(|x| x.step_id == C));
    // 대상·규칙은 그대로
    assert_eq!(q.conditions[0].path, "$.x");
}

#[test]
fn threshold_palette_and_default() {
    let mut p = panel();
    assert_eq!(threshold_default_ms(&p), 1000);
    let c = threshold_add(&board(vec![p.clone()]), 0, 1000);
    assert_eq!(
        c.panels[0].thresholds,
        vec![Threshold {
            ms: 1000,
            color: "#f59e0b".into()
        }]
    );
    p.thresholds = vec![
        Threshold {
            ms: 800,
            color: "#f59e0b".into(),
        },
        Threshold {
            ms: 1500,
            color: "#ef4444".into(),
        },
    ];
    assert_eq!(threshold_default_ms(&p), 2500);
    let c = threshold_add(&board(vec![p]), 0, 2500);
    assert_eq!(c.panels[0].thresholds[2].color, "#a855f7");
    assert_eq!(c.panels[0].thresholds[2].ms, 2500);
    // 6번째 칸은 색 순환(5개 % 5 = 0)
    let mut p5 = panel();
    p5.thresholds = (1..=5)
        .map(|i| Threshold {
            ms: i * 10,
            color: "#000000".into(),
        })
        .collect();
    let c = threshold_add(&board(vec![p5]), 0, 99);
    assert_eq!(c.panels[0].thresholds[5].color, "#f59e0b");
    // set: ms만, 색 유지; 범위 밖 i는 그대로
    let s = threshold_set(&c, 0, 1, 77);
    assert_eq!(s.panels[0].thresholds[1].ms, 77);
    assert_eq!(s.panels[0].thresholds[1].color, "#000000");
    assert_eq!(threshold_set(&c, 0, 99, 1), c);
}

#[test]
fn remove_and_swap() {
    let mut p = panel();
    p.thresholds = vec![
        Threshold {
            ms: 1,
            color: "#000000".into(),
        },
        Threshold {
            ms: 2,
            color: "#000000".into(),
        },
    ];
    p.conditions = vec![cond(A), cond(C)];
    p.display_items = vec![disp(A), disp(C)];
    let cfg = board(vec![p]);
    assert_eq!(
        remove_at(&cfg, 0, ListKind::Thresholds, 0).panels[0].thresholds[0].ms,
        2
    );
    let removed = remove_at(&cfg, 0, ListKind::Conditions, 1);
    assert_eq!(removed.panels[0].conditions.len(), 1);
    assert_eq!(removed.panels[0].conditions[0].step_id, A);
    assert_eq!(
        remove_at(&cfg, 0, ListKind::Display, 0).panels[0].display_items[0].step_id,
        C
    );
    assert_eq!(remove_at(&cfg, 0, ListKind::Display, 5), cfg, "범위 밖 i");
    let s = swap_display(&cfg, 0);
    assert_eq!(s.panels[0].display_items[0].step_id, C);
    assert_eq!(s.panels[0].display_items[1].step_id, A);
    let one = remove_at(&cfg, 0, ListKind::Display, 0);
    assert_eq!(swap_display(&one, 0), one);
}

#[test]
fn ops_for_matches_server_allows() {
    use ConditionOp::*;
    // 순서는 GUI 드롭다운(`ui/src/monitor/conditions.ts` `OPS_BY_SOURCE`)과 같다.
    let ten = vec![Eq, Ne, Exists, NotEmpty, Contains, Gt, Lt, Gte, Lte, OneOf];
    assert_eq!(ops_for(ConditionSource::Body), ten);
    assert_eq!(ops_for(ConditionSource::Header), ten);
    assert_eq!(
        ops_for(ConditionSource::Status),
        vec![Eq, Ne, Gt, Lt, Gte, Lte, OneOf]
    );
    assert_eq!(ops_for(ConditionSource::BodyText), vec![Contains, NotEmpty]);
    // 집합은 서버 허용 표와 같다(순서만 GUI를 따른다) — 서버가 안 받는 규칙을 고르게 두지 않는다.
    for source in [
        ConditionSource::Body,
        ConditionSource::Header,
        ConditionSource::Status,
        ConditionSource::BodyText,
    ] {
        let listed = ops_for(source);
        for op in ten.iter().copied() {
            assert_eq!(listed.contains(&op), source.allows(op), "{source:?} {op:?}");
        }
        assert_eq!(
            listed.len(),
            ten.iter().filter(|o| source.allows(**o)).count(),
            "{source:?} 중복 없음"
        );
    }
    let flags: Vec<_> = ops_for(ConditionSource::Body)
        .into_iter()
        .filter(|o| o.has_flags())
        .collect();
    assert_eq!(flags, vec![Eq, Ne, Contains, OneOf]);
}

/// GUI 파일에서 직접 읽어 대조한다 — GUI가 드롭다운 순서를 바꾸면 이 테스트가 알려 준다.
#[test]
fn ops_order_matches_gui_dropdown() {
    let ts = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../ui/src/monitor/conditions.ts"
    ))
    .unwrap();
    // `[ … ]` 안의 따옴표 문자열들.
    fn list(src: &str, after: &str) -> Vec<String> {
        let at = src.find(after).unwrap_or_else(|| panic!("{after:?} 없음"));
        let rest = &src[at + after.len()..];
        let open = rest.find('[').unwrap();
        let close = rest.find(']').unwrap();
        rest[open + 1..close]
            .split(',')
            .map(|t| t.trim().trim_matches('"').to_string())
            .filter(|t| !t.is_empty())
            .collect()
    }
    let names = |source: ConditionSource| -> Vec<String> {
        ops_for(source)
            .into_iter()
            .map(|o| {
                serde_json::to_value(o)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    };
    let ten = list(&ts, "const TEN: readonly ConditionOp[] =");
    assert_eq!(ten.len(), 10, "{ten:?}");
    // body·header는 TEN을 그대로 쓴다.
    assert!(ts.contains("body: TEN,") && ts.contains("header: TEN,"));
    assert_eq!(names(ConditionSource::Body), ten);
    assert_eq!(names(ConditionSource::Header), ten);
    assert_eq!(names(ConditionSource::Status), list(&ts, "status:"));
    assert_eq!(names(ConditionSource::BodyText), list(&ts, "body_text:"));
}

#[test]
fn set_condition_keeps_target_and_step() {
    let cfg = board(vec![{
        let mut p = panel();
        p.conditions = vec![cond(A)];
        p
    }]);
    let c = set_condition(&cfg, 0, 0, ConditionOp::Contains, "ok", true, true);
    let k = &c.panels[0].conditions[0];
    assert_eq!(
        (k.step_id.as_str(), k.source, k.path.as_str()),
        (A, ConditionSource::Body, "$.x")
    );
    assert_eq!(
        (k.op, k.value.as_str(), k.ignore_case, k.trim),
        (ConditionOp::Contains, "ok", true, true)
    );
    assert_eq!(
        set_condition(&cfg, 0, 7, ConditionOp::Eq, "", false, false),
        cfg
    );
}

#[test]
fn dropped_env_rules() {
    let mut a = panel();
    a.environment_id = Some("E1".into());
    let mut other = panel();
    other.environment_id = Some("E1".into());
    let mut none = panel();
    none.environment_id = None;
    // 혼자 쓰던 E1 → E2
    let boards = vec![board(vec![a.clone(), none.clone()])];
    assert_eq!(
        dropped_env(&boards, 0, 0, Some("E2")),
        Some("E1".to_string())
    );
    assert_eq!(dropped_env(&boards, 0, 0, None), Some("E1".to_string()));
    // 같은 값으로 바꾸면 안 빠짐
    assert_eq!(dropped_env(&boards, 0, 0, Some("E1")), None);
    // 같은 보드의 다른 칸도 E1
    let boards = vec![board(vec![a.clone(), other.clone()])];
    assert_eq!(dropped_env(&boards, 0, 0, Some("E2")), None);
    // 다른 보드 칸도 E1
    let boards = vec![board(vec![a.clone()]), board(vec![other])];
    assert_eq!(dropped_env(&boards, 0, 0, Some("E2")), None);
    // 옛 환경 없음 → E2
    let boards = vec![board(vec![none])];
    assert_eq!(dropped_env(&boards, 0, 0, Some("E2")), None);
    // 범위 밖
    assert_eq!(dropped_env(&boards, 5, 0, Some("E2")), None);
}

#[test]
fn usage_counts_across_boards() {
    let mut a = panel();
    a.environment_id = Some("E1".into());
    let mut b = panel();
    b.environment_id = Some("E2".into());
    let boards = vec![
        board(vec![a.clone(), a.clone(), b.clone()]),
        board(vec![b.clone()]),
        board(vec![a.clone()]),
    ];
    assert_eq!(
        usage(&boards, |p| p.environment_id.as_deref() == Some("E1")),
        (3, 2)
    );
    assert_eq!(
        usage(&boards, |p| p.environment_id.as_deref() == Some("E2")),
        (2, 2)
    );
    assert_eq!(usage(&boards, |_| false), (0, 0));
    assert_eq!(usage(&boards, |p| p.scenario_id == "S1"), (5, 3));
}

#[test]
fn strip_prefix_only_own_panel() {
    assert_eq!(
        strip_panel_prefix("칸 3: 제한 시간은 1~30초여야 합니다", 3),
        "제한 시간은 1~30초여야 합니다"
    );
    assert_eq!(
        strip_panel_prefix("칸 3: 제한 시간은 1~30초여야 합니다", 2),
        "칸 3: 제한 시간은 1~30초여야 합니다"
    );
    assert_eq!(strip_panel_prefix("칸 13: x", 1), "칸 13: x");
    assert_eq!(strip_panel_prefix("보드 오류", 1), "보드 오류");
}

#[test]
fn step_options_branch_hint() {
    let n = names();
    let o = step_options(&n, "S1");
    assert_eq!(o.len(), 2);
    assert_eq!(o[0].0, A);
    assert_eq!(o[0].1, "1 a  GET /a");
    assert_eq!(o[1].0, C);
    assert!(o[1].1.starts_with("2 c  GET /c"));
    assert!(o[1].1.ends_with("  (분기A 분기)"));
    assert!(step_options(&n, "nope").is_empty());
}

#[test]
fn texts() {
    assert_eq!(
        text::VALUE_UNEDITABLE,
        "이 값은 TUI에서 못 고칩니다 — GUI에서"
    );
    assert_eq!(
        text::step_change_confirm(2, 1),
        "조건 2개·표시 값 1개도 이 스텝으로 바뀝니다 — Enter 계속 · Esc 취소"
    );
    assert_eq!(
        text::env_drop_confirm("운영"),
        "\"운영\" 환경은 다른 칸이 안 써서 파일에서 빠집니다 — Enter 계속 · Esc 취소"
    );
    assert_eq!(
        text::delete_confirm(2),
        "2번을 지울까요? y 지우기 · 다른 키 취소"
    );
    assert_eq!(
        text::share_note(4, 2),
        "이 값을 쓰는 칸 4개(보드 2개)가 함께 바뀝니다"
    );
    assert_eq!(text::usage_note(4, 2), "이 환경을 쓰는 칸 4개(보드 2개)");
    assert_eq!(
        text::usage_note_scenario(3, 1),
        "이 시나리오를 쓰는 칸 3개(보드 1개)"
    );
}

#[test]
fn add_condition_appends() {
    // 흐름 전체 칸 — step_id 그대로, 끝에 붙음, 다른 칸 불변
    let mut p0 = panel();
    p0.conditions.push(cond(A));
    let mut p1 = panel();
    p1.id = "P2".into();
    let cfg = board(vec![p0.clone(), p1.clone()]);
    let out = add_condition(&cfg, 0, cond(C));
    assert_eq!(out.panels[0].conditions.len(), 2);
    assert_eq!(out.panels[0].conditions[0], p0.conditions[0]);
    assert_eq!(out.panels[0].conditions[1].step_id, C);
    assert_eq!(out.panels[1], p1);
    // 스텝 칸 — 칸의 스텝으로 덮어씀
    let mut sp = panel();
    sp.step_id = Some(A.into());
    let out = add_condition(&board(vec![sp]), 0, cond(C));
    assert_eq!(out.panels[0].conditions[0].step_id, A);
    // 범위 밖이면 그대로
    let cfg = board(vec![panel()]);
    assert_eq!(add_condition(&cfg, 5, cond(A)), cfg);
}

#[test]
fn add_display_appends() {
    let mut p0 = panel();
    p0.display_items.push(disp(A));
    let mut p1 = panel();
    p1.id = "P2".into();
    let cfg = board(vec![p0.clone(), p1.clone()]);
    let out = add_display(&cfg, 0, disp(C));
    assert_eq!(out.panels[0].display_items.len(), 2);
    assert_eq!(out.panels[0].display_items[0], p0.display_items[0]);
    assert_eq!(out.panels[0].display_items[1].step_id, C);
    assert_eq!(out.panels[1], p1);
    let mut sp = panel();
    sp.step_id = Some(A.into());
    let out = add_display(&board(vec![sp]), 0, disp(C));
    assert_eq!(out.panels[0].display_items[0].step_id, A);
    let cfg = board(vec![panel()]);
    assert_eq!(add_display(&cfg, 5, disp(A)), cfg);
}
