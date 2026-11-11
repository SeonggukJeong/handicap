//! 칸 설정 보기 — 번호 목록 12개·조건/표시 문구·묶음 표시·그리기(spec §5.4, 목업 §4).

use handicap_controller::monitor::config::{
    BoardConfig, CheckGroup, Condition, ConditionOp, ConditionSource, DisplayItem, DisplaySource,
    LatencySource, PanelConfig, Threshold,
};
use handicap_tui::names::Names;
use handicap_tui::panel_settings::{
    condition_summary, condition_target, display_target, edit_menu_lines, ensure_visible,
    group_note, group_number, settings_items, settings_items_edit, settings_lines,
};
use handicap_tui::text;
use handicap_tui::view::inspect::sub_layout;
use handicap_tui::view::monitor::HeaderView;
use handicap_tui::view::settings::{EditMenuView, OverlayView, render_edit_menu, settings_height};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::text::Span;

/// 행마다 셀 심볼을 잇되 넓은 문자 뒤 빈 채움 셀은 건너뛴다.
fn buffer_text(buf: &Buffer) -> String {
    let area = buf.area;
    let mut out = String::new();
    for y in 0..area.height {
        let mut skip = 0usize;
        for x in 0..area.width {
            if skip > 0 {
                skip -= 1;
                continue;
            }
            let sym = buf[(x, y)].symbol();
            let w = Span::raw(sym.to_string()).width();
            skip = w.saturating_sub(1);
            out.push_str(sym);
        }
        out.push('\n');
    }
    out
}

fn width(s: &str) -> usize {
    Span::raw(s.to_string()).width()
}

// ---------- fixtures (names_test.rs에서 복사) ----------

const NESTED: &str = r#"
version: 1
name: 중첩
steps:
  - { id: "01J00000000000000000000A01", name: a, type: http, request: { method: GET, url: "/a" }, assert: [] }
  - id: "01J00000000000000000000L01"
    name: 반복
    type: loop
    repeat: 2
    do:
      - { id: "01J00000000000000000000A02", name: b, type: http, request: { method: GET, url: "/b" }, assert: [] }
  - id: "01J00000000000000000000I01"
    name: 분기
    type: if
    cond: { left: "{{code}}", op: eq, right: "200" }
    then:
      - { id: "01J00000000000000000000A03", name: c, type: http, request: { method: GET, url: "/c" }, assert: [] }
    elif:
      - cond: { left: "{{code}}", op: eq, right: "404" }
        then:
          - { id: "01J00000000000000000000A04", name: d, type: http, request: { method: GET, url: "/d" }, assert: [] }
    else:
      - { id: "01J00000000000000000000A05", name: e, type: http, request: { method: GET, url: "/e" }, assert: [] }
  - id: "01J00000000000000000000P01"
    name: 동시
    type: parallel
    branches:
      - name: x
        steps:
          - { id: "01J00000000000000000000A06", name: f, type: http, request: { method: GET, url: "/f" }, assert: [] }
      - name: y
        steps:
          - { id: "01J00000000000000000000A07", name: g, type: http, request: { method: GET, url: "/g" }, assert: [] }
"#;

const TEMPLATED: &str = r#"
version: 1
name: 주문 흐름
steps:
  - { id: "01J00000000000000000000T01", name: 주문 상세, type: http, request: { method: GET, url: "${BASE_URL}/orders/{{order_id}}" }, assert: [] }
"#;

fn bundle(scenarios: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "format": "handicap-bundle",
        "format_version": 1,
        "boards": [],
        "scenarios": scenarios,
        "environments": [
            { "id": "E1", "name": "운영", "vars": { "K": "비밀" } }
        ]
    }))
    .unwrap()
}

fn names() -> Names {
    Names::from_bundle(&bundle(serde_json::json!([
        { "id": "S1", "yaml": NESTED },
        { "id": "S2", "yaml": TEMPLATED }
    ])))
}

const A01: &str = "01J00000000000000000000A01";
const A04: &str = "01J00000000000000000000A04";
const SID: &str = "01HZZZZZZZZZZZZZZZZZZZZZA1";

fn cond(over: impl FnOnce(&mut Condition)) -> Condition {
    let mut c = Condition {
        step_id: SID.into(),
        source: ConditionSource::Body,
        path: "$.a".into(),
        op: ConditionOp::Eq,
        value: "v".into(),
        ignore_case: false,
        trim: false,
    };
    over(&mut c);
    c
}

fn head() -> HeaderView {
    HeaderView {
        board_name: "운영 API 보드".into(),
        board_pos: (1, 1),
        server_time: Some(1_700_000_000_000),
        server_down: false,
        notice: None,
    }
}

const LABELS: [&str; 12] = [
    "제목",
    "시나리오",
    "환경",
    "볼 스텝",
    "점검 주기(초)",
    "제한 시간(초)",
    "표시할 응답 시간",
    "응답속도 기준선",
    "막대 개수",
    "그래프 최대 높이(ms)",
    "성공 조건",
    "화면에 표시",
];

// ---------- 문구 (GUI conditions.test.ts와 1:1) ----------

#[test]
fn target_labels_match_gui() {
    let t = |source, path: &str| {
        condition_target(&cond(|c| {
            c.source = source;
            c.path = path.into();
        }))
    };
    use ConditionSource as S;
    assert_eq!(t(S::Body, "$.data.items[0].code"), "data.items[0].code");
    assert_eq!(t(S::Body, "$.resultCode"), "resultCode");
    assert_eq!(t(S::Body, "$"), "본문");
    assert_eq!(t(S::Body, "$['a b']"), "['a b']");
    assert_eq!(t(S::Header, "X-A"), "헤더 X-A");
    assert_eq!(t(S::Status, ""), "상태코드");
    assert_eq!(t(S::BodyText, ""), "본문 전체");

    let d = |source, path: &str| {
        display_target(&DisplayItem {
            step_id: SID.into(),
            source,
            path: path.into(),
        })
    };
    assert_eq!(d(DisplaySource::Body, "$.resultCode"), "resultCode");
    assert_eq!(d(DisplaySource::Body, "$"), "본문");
    assert_eq!(d(DisplaySource::Header, "X-A"), "헤더 X-A");
    assert_eq!(d(DisplaySource::Status, ""), "상태코드");
}

#[test]
fn condition_summary_matches_gui() {
    // target_and_summary_labels
    assert_eq!(
        condition_summary(
            &cond(|c| {
                c.path = "$.resultCode".into();
                c.value = "0000".into();
                c.ignore_case = true;
            }),
            Some("로그인")
        ),
        "resultCode = 0000 · 로그인 · 대소문자 무시"
    );
    assert_eq!(
        condition_summary(
            &cond(|c| {
                c.op = ConditionOp::Exists;
                c.value = String::new();
            }),
            Some("로그인")
        ),
        "a 키 있음 · 로그인"
    );
    assert_eq!(
        condition_summary(&cond(|c| c.value = String::new()), None),
        format!("a = \"\" · {SID}")
    );
    assert_eq!(
        condition_summary(&cond(|c| c.trim = true), Some("s")),
        "a = v · s · 앞뒤 공백 무시"
    );

    // condition_summary_symbols_table
    let sum = |op, value: &str, ignore_case: bool| {
        condition_summary(
            &cond(|c| {
                c.path = "$.n".into();
                c.op = op;
                c.value = value.into();
                c.ignore_case = ignore_case;
            }),
            Some("로그인"),
        )
    };
    use ConditionOp as O;
    assert_eq!(sum(O::Ne, "1", false), "n ≠ 1 · 로그인");
    assert_eq!(sum(O::Gt, "1", false), "n > 1 · 로그인");
    assert_eq!(sum(O::Lt, "1", false), "n < 1 · 로그인");
    assert_eq!(sum(O::Gte, "1", false), "n ≥ 1 · 로그인");
    assert_eq!(sum(O::Lte, "1", false), "n ≤ 1 · 로그인");
    assert_eq!(sum(O::Contains, "x", false), "n 글자 포함 x · 로그인");
    assert_eq!(sum(O::NotEmpty, "", false), "n 값 있음 · 로그인");
    assert_eq!(
        sum(O::OneOf, "0000, 0020", false),
        "n ∈ {0000, 0020} · 로그인"
    );
    assert_eq!(
        sum(O::OneOf, " 0000 ,, ok ", true),
        "n ∈ {0000, ok} · 로그인 · 대소문자 무시"
    );
    assert_eq!(
        condition_summary(
            &cond(|c| {
                c.source = ConditionSource::Status;
                c.path = String::new();
                c.op = O::Gte;
                c.value = "200".into();
            }),
            Some("로그인")
        ),
        "상태코드 ≥ 200 · 로그인"
    );
}

// ---------- 항목 ----------

#[test]
fn settings_items_fixed_twelve() {
    let items = settings_items(&PanelConfig::default(), &Names::default());
    assert_eq!(items.len(), 12);
    let labels: Vec<&str> = items.iter().map(|i| i.label).collect();
    assert_eq!(labels, LABELS);
    let v = |i: usize| items[i].values.clone();
    assert_eq!(v(0), ["(제목 없음)"]);
    assert_eq!(v(1), [text::NO_VALUE]);
    assert_eq!(v(2), ["환경 없음"]);
    assert_eq!(v(3), ["시나리오 전체"]);
    assert_eq!(v(6), ["시나리오 전체"]);
    assert_eq!(v(7), ["없음"]);
    assert_eq!(v(10), ["없음"]);
    assert_eq!(v(11), ["없음"]);
    assert_eq!(v(4), ["10"]);
    assert_eq!(v(5), ["5"]);
    assert_eq!(v(8), ["60"]);
    assert_eq!(v(9), ["2,000"]);
    assert!(items.iter().all(|i| !i.from_group));
    assert!(items.iter().all(|i| !i.values.is_empty()));
}

#[test]
fn settings_items_resolve_names() {
    let n = names();
    let p = PanelConfig {
        title: "주문 조회".into(),
        scenario_id: "S1".into(),
        environment_id: Some("E1".into()),
        step_id: Some(A04.into()),
        latency_source: LatencySource::Step {
            step_id: A04.into(),
        },
        thresholds: vec![
            Threshold {
                ms: 800,
                color: "#f59e0b".into(),
            },
            Threshold {
                ms: 1500,
                color: "#ef4444".into(),
            },
        ],
        conditions: vec![cond(|c| {
            c.step_id = A04.into();
            c.path = "$.resultCode".into();
            c.value = "0000".into();
        })],
        display_items: vec![
            DisplayItem {
                step_id: A04.into(),
                source: DisplaySource::Body,
                path: "$.resultCode".into(),
            },
            DisplayItem {
                step_id: A04.into(),
                source: DisplaySource::Status,
                path: String::new(),
            },
        ],
        ..PanelConfig::default()
    };
    let items = settings_items(&p, &n);
    assert_eq!(items[0].values, ["주문 조회"]);
    assert_eq!(items[1].values, ["중첩"]);
    assert_eq!(items[2].values, ["운영"]);
    assert!(
        items[3].values[0].starts_with("4 d  GET /d"),
        "{:?}",
        items[3]
    );
    assert_eq!(items[6].values, ["이 스텝"]);
    assert_eq!(items[7].values, ["800 ms 이상 · 1,500 ms 이상"]);
    assert_eq!(items[10].values, ["resultCode = 0000 · d"]);
    assert_eq!(
        items[11].values,
        ["① 큰 글자 resultCode · d", "② 작은 줄 상태코드 · d"]
    );

    // 없는 스텝 — 경고.
    let gone = PanelConfig {
        step_id: Some("01J00000000000000000000ZZZ".into()),
        ..p.clone()
    };
    assert_eq!(
        settings_items(&gone, &n)[3].values,
        ["01J00000000000000000000ZZZ ⚠ 스텝 없음"]
    );
    // 시나리오를 못 읽음 — id만.
    let unknown = PanelConfig {
        scenario_id: "S9".into(),
        environment_id: Some("E9".into()),
        ..gone.clone()
    };
    let items = settings_items(&unknown, &n);
    assert_eq!(items[1].values, ["S9"]);
    assert_eq!(items[2].values, ["E9"]);
    assert_eq!(items[3].values, ["01J00000000000000000000ZZZ"]);
    assert_eq!(items[10].values, [format!("resultCode = 0000 · {A04}")]);

    // 다른 스텝의 응답 시간 — 이름.
    let other = PanelConfig {
        step_id: None,
        latency_source: LatencySource::Step {
            step_id: A01.into(),
        },
        ..p.clone()
    };
    assert_eq!(settings_items(&other, &n)[6].values, ["a"]);
}

#[test]
fn step_url_template_shown_as_written() {
    let n = names();
    let sid = "01J00000000000000000000T01";
    let (_, info) = n.step_info("S2", sid).unwrap();
    assert_eq!(info.url, "${BASE_URL}/orders/{{order_id}}");
    let p = PanelConfig {
        scenario_id: "S2".into(),
        step_id: Some(sid.into()),
        ..PanelConfig::default()
    };
    let v = &settings_items(&p, &n)[3].values[0];
    assert_eq!(v, "1 주문 상세  GET ${BASE_URL}/orders/{{order_id}}");
    assert!(v.contains("{{order_id}}") && v.contains("${BASE_URL}"));
}

fn group_board() -> BoardConfig {
    let panel = |id: &str, gid: &str| PanelConfig {
        id: id.into(),
        title: id.into(),
        scenario_id: "S1".into(),
        group_id: Some(gid.into()),
        step_id: Some(A04.into()),
        ..PanelConfig::default()
    };
    BoardConfig {
        groups: vec![
            CheckGroup {
                id: "G1".into(),
                scenario_id: "S1".into(),
                ..CheckGroup::default()
            },
            CheckGroup {
                id: "G2".into(),
                scenario_id: "S1".into(),
                ..CheckGroup::default()
            },
        ],
        panels: vec![panel("P1", "G2"), panel("P2", "G1"), panel("P3", "G2")],
        ..BoardConfig::default()
    }
}

#[test]
fn group_panel_marks_and_note() {
    let board = group_board();
    let p = &board.panels[0];
    let items = settings_items(p, &names());
    for (i, it) in items.iter().enumerate() {
        assert_eq!(it.from_group, matches!(i, 1 | 2 | 4), "{i}");
    }
    let lines = settings_lines(&items, 100);
    for no in [" 2  ", " 3  ", " 5  "] {
        let l = lines.iter().find(|l| l.starts_with(no)).unwrap();
        assert!(l.ends_with(text::GROUP_MARK), "{l:?}");
    }
    for no in [" 1  ", " 4  ", " 6  "] {
        let l = lines.iter().find(|l| l.starts_with(no)).unwrap();
        assert!(!l.contains(text::GROUP_MARK), "{l:?}");
    }

    assert_eq!(group_number(&board, "G2"), 1);
    assert_eq!(group_number(&board, "G1"), 2);
    assert_eq!(group_number(&board, "G9"), 0);
    // GUI는 빈 문자열 group_id를 세지 않는다.
    let mut blank = board.clone();
    blank.panels.insert(
        0,
        PanelConfig {
            id: "P0".into(),
            group_id: Some(String::new()),
            ..PanelConfig::default()
        },
    );
    assert_eq!(
        (group_number(&blank, "G2"), group_number(&blank, "")),
        (1, 0)
    );
    assert_eq!(
        group_note(&board, p).as_deref(),
        Some("(묶음) = 점검 묶음 1의 값 — 칸마다 따로 못 바꿉니다")
    );
    assert_eq!(
        group_note(&board, &board.panels[1]).as_deref(),
        Some("(묶음) = 점검 묶음 2의 값 — 칸마다 따로 못 바꿉니다")
    );

    // 어느 칸도 안 쓰는 묶음 / 목록에 없는 묶음 → 번호 없는 각주.
    for gid in ["G3", "G9"] {
        let mut b = board.clone();
        if gid == "G3" {
            b.groups.push(CheckGroup {
                id: "G3".into(),
                ..CheckGroup::default()
            });
        }
        let lone = PanelConfig {
            group_id: Some(gid.into()),
            ..PanelConfig::default()
        };
        assert_eq!(group_number(&b, gid), 0);
        assert_eq!(
            group_note(&b, &lone).as_deref(),
            Some(text::GROUP_NOTE_PLAIN)
        );
    }

    let solo = PanelConfig::default();
    assert_eq!(group_note(&board, &solo), None);
    let lines = settings_lines(&settings_items(&solo, &names()), 100);
    assert!(lines.iter().all(|l| !l.contains(text::GROUP_MARK)));
}

#[test]
fn settings_lines_numbering_and_wrap() {
    let p = PanelConfig {
        title: "주문 조회".into(),
        conditions: vec![
            cond(|c| c.path = "$.x".into()),
            cond(|c| c.path = "$.y".into()),
        ],
        ..PanelConfig::default()
    };
    let items = settings_items(&p, &Names::default());
    let lines = settings_lines(&items, 70);
    assert!(lines[0].starts_with(" 1  제목"), "{lines:?}");
    assert!(lines[0].ends_with("주문 조회"), "{lines:?}");
    assert!(lines.iter().any(|l| l.starts_with("12  화면에 표시")));
    let first = lines.iter().position(|l| l.starts_with("11  ")).unwrap();
    let col = lines[first].find("x = v").unwrap();
    let second = &lines[first + 1];
    let col2 = second.find("y = v").unwrap();
    assert_eq!(
        width(&second[..col2]),
        width(&lines[first][..col]),
        "{lines:?}"
    );
    assert!(second[..col2].trim().is_empty());
    assert!(lines.iter().all(|l| width(l) <= 70));

    let mut p2 = p.clone();
    p2.title = "제목\x1b[31m 빨강 아주 긴 제목이 이어진다 계속 계속".into();
    let lines = settings_lines(&settings_items(&p2, &Names::default()), 20);
    assert!(lines.iter().all(|l| width(l) <= 20), "{lines:?}");
    assert!(lines.iter().all(|l| !l.contains('\x1b')), "{lines:?}");
    // 좁아도 12개 번호가 다 있다.
    for n in 1..=12 {
        let no = format!("{n:>2}  ");
        assert!(lines.iter().any(|l| l.starts_with(&no)), "{n} {lines:?}");
    }
}

// ---------- 그리기 ----------

// ---------- tui-2a-1 Task 8: 편집 메뉴 ----------

const SCEN_VARS: &str = r#"
version: 1
name: 주문 흐름
variables:
  order_id: "A-1"
  page_size: "20"
steps:
  - { id: "01J00000000000000000000T01", name: 주문 상세, type: http, request: { method: GET, url: "${BASE_URL}/orders/{{order_id}}" }, assert: [] }
"#;

fn edit_names() -> Names {
    Names::from_bundle(
        &serde_json::to_vec(&serde_json::json!({
            "format": "handicap-bundle",
            "format_version": 1,
            "boards": [],
            "scenarios": [
                { "id": "S3", "yaml": SCEN_VARS },
                { "id": "S2", "yaml": TEMPLATED }
            ],
            "environments": [
                { "id": "E1", "name": "운영",
                  "vars": { "BASE_URL": "x", "API_TOKEN": "y", "SHOP_ID": "z" } },
                { "id": "E2", "name": "빈 환경", "vars": {} }
            ]
        }))
        .unwrap(),
    )
}

fn edit_panel() -> PanelConfig {
    PanelConfig {
        id: "P1".into(),
        title: "주문 조회".into(),
        scenario_id: "S3".into(),
        environment_id: Some("E1".into()),
        ..PanelConfig::default()
    }
}

#[test]
fn edit_items_fourteen() {
    let items = settings_items_edit(&edit_panel(), &edit_names(), 100);
    assert_eq!(items.len(), 14);
    assert_eq!(
        &items[..12],
        &settings_items(&edit_panel(), &edit_names())[..]
    );
    assert_eq!(items[12].label, text::SET_ENV_VARS);
    assert_eq!(
        items[12].values,
        ["운영 · 3개  (API_TOKEN · BASE_URL · SHOP_ID)"]
    );
    assert_eq!(items[13].label, text::SET_SCEN_VARS);
    assert_eq!(
        items[13].values,
        ["주문 흐름 · 2개  (order_id · page_size)"]
    );
    assert!(!items[12].from_group && !items[13].from_group);

    let none = PanelConfig {
        scenario_id: "S2".into(),
        ..PanelConfig::default()
    };
    let items = settings_items_edit(&none, &edit_names(), 100);
    assert_eq!(items[12].values, [text::NONE]);
    assert_eq!(items[13].values, [text::NONE]);
    let empty_env = PanelConfig {
        environment_id: Some("E2".into()),
        ..none
    };
    let items = settings_items_edit(&empty_env, &edit_names(), 100);
    assert_eq!(items[12].values, ["빈 환경 · 0개"]);
}

#[test]
fn edit_items_shorten_keys_by_whole_pieces() {
    let all = ["API_TOKEN", "BASE_URL", "SHOP_ID"];
    for w in 10..=100usize {
        let items = settings_items_edit(&edit_panel(), &edit_names(), w);
        let v = &items[12].values[0];
        // 보이는 키는 앞에서부터 통째 조각이고, 빠진 만큼 `(… 외 N개)`.
        let shown: Vec<&str> = match v.split_once("  (") {
            Some((_, rest)) if !rest.starts_with("… 외") => {
                rest.split(')').next().unwrap().split(" · ").collect()
            }
            _ => vec![],
        };
        assert!(shown.len() <= 3, "{w}: {v}");
        for (i, k) in shown.iter().enumerate() {
            assert_eq!(*k, all[i], "{w}: {v}");
        }
        if shown.len() < 3 && v.contains("(") {
            assert!(
                v.contains(&format!("(… 외 {}개)", 3 - shown.len())),
                "{w}: {v}"
            );
        }
        assert!(!v.replace("(… 외", "").contains('…'), "{w}: {v}");
        for (l, _) in edit_menu_lines(&items, w) {
            assert!(width(&l) <= w, "{w}: {l}");
        }
    }
    // 폭이 좁으면 나머지 개수.
    let items = settings_items_edit(&edit_panel(), &edit_names(), 52);
    let v = &items[12].values[0];
    assert!(v.starts_with("운영 · 3개  ("), "{v}");
    assert!(v.contains("(… 외 "), "{v}");
}

#[test]
fn edit_menu_lines_map_items() {
    let cond2 = |i: usize| cond(|c| c.value = format!("v{i}"));
    let p = PanelConfig {
        conditions: vec![cond2(1), cond2(2)],
        ..edit_panel()
    };
    let items = settings_items_edit(&p, &edit_names(), 100);
    let lines = edit_menu_lines(&items, 100);
    // 여러 줄 항목(성공 조건, 인덱스 10)의 모든 줄이 Some(10).
    assert_eq!(lines.iter().filter(|(_, n)| *n == Some(10)).count(), 2);
    let cond_rows: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, (_, n))| *n == Some(10))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(cond_rows[1], cond_rows[0] + 1);
    // 구분 줄은 12와 13 사이, None.
    let none_rows: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, (_, n))| n.is_none())
        .map(|(i, _)| i)
        .collect();
    assert_eq!(none_rows.len(), 1);
    let d = none_rows[0];
    assert_eq!(lines[d - 1].1, Some(11));
    assert_eq!(lines[d + 1].1, Some(12));
    assert!(lines[d].0.contains(text::EDIT_DIVIDER), "{}", lines[d].0);
    // `▶ ` 두 칸을 예약.
    assert!(lines.iter().all(|(l, _)| l.starts_with("  ")));
    assert!(lines[0].0.starts_with("   1  제목"), "{}", lines[0].0);
    assert_eq!(lines.last().unwrap().1, Some(13));
    for w in [1usize, 2, 3, 10, 20, 40] {
        let items = settings_items_edit(&p, &edit_names(), w);
        for (l, _) in edit_menu_lines(&items, w) {
            assert!(width(&l) <= w, "{w}: {l}");
        }
    }
    // 폭 20에서도 14개 항목이 모두 줄을 가진다.
    let items = settings_items_edit(&p, &edit_names(), 20);
    let lines = edit_menu_lines(&items, 20);
    for n in 0..14 {
        assert!(lines.iter().any(|(_, k)| *k == Some(n)), "{n}");
    }
}

#[test]
fn edit_menu_values_are_sanitized() {
    let mut p = edit_panel();
    p.title = "a\u{202E}b".into();
    let items = settings_items_edit(&p, &edit_names(), 100);
    let lines = edit_menu_lines(&items, 100);
    assert!(lines[0].0.contains("a\u{FFFD}b"), "{}", lines[0].0);
    assert!(!lines[0].0.contains('\u{202E}'));
}

#[test]
fn ensure_visible_scrolls_minimally() {
    let lines: Vec<(String, Option<usize>)> = (0..10)
        .map(|i| (format!("l{i}"), Some(i)))
        .chain([("div".to_string(), None)])
        .collect();
    assert_eq!(ensure_visible(&lines, 0, 5), 0);
    assert_eq!(ensure_visible(&lines, 4, 5), 0);
    // 5번 항목(줄 5)을 보이려면 맨 아래에 맞춘다.
    assert_eq!(ensure_visible(&lines, 5, 5), 1);
    assert_eq!(ensure_visible(&lines, 9, 5), 5);
    // 높이 0·항목 없음 — 패닉 없이 0.
    assert_eq!(ensure_visible(&lines, 3, 0), 0);
    assert_eq!(ensure_visible(&[], 3, 5), 0);
    assert_eq!(ensure_visible(&lines, 99, 5), 0);
    // 여러 줄 항목은 그 줄 전부가 보이게(다 못 넣으면 첫 줄이 맨 위).
    let multi: Vec<(String, Option<usize>)> = [0, 1, 1, 1, 2]
        .iter()
        .map(|n| (format!("m{n}"), Some(*n)))
        .collect();
    assert_eq!(ensure_visible(&multi, 1, 3), 1);
    assert_eq!(ensure_visible(&multi, 1, 2), 1);
    assert_eq!(ensure_visible(&multi, 2, 3), 2);
}

fn menu_view<'a>(
    lines: &'a [(String, Option<usize>)],
    cursor: usize,
    note: Option<&'a str>,
    overlay: Option<OverlayView<'a>>,
) -> EditMenuView<'a> {
    EditMenuView {
        title: "주문 조회",
        lines,
        cursor,
        scroll: 0,
        note,
        overlay,
    }
}

fn menu_keys() -> Vec<&'static str> {
    vec!["↑↓ 고르기", "Enter 수정", "Esc 모니터로"]
}

fn draw_menu(
    w: u16,
    h: u16,
    v: &EditMenuView,
    keys: &[&str],
) -> (Buffer, Vec<(u16, usize)>, String) {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    let mut table = vec![];
    t.draw(|f| table = render_edit_menu(f, &head(), v, keys))
        .unwrap();
    let buf = t.backend().buffer().clone();
    let txt = buffer_text(&buf);
    (buf, table, txt)
}

/// 줄의 모든 글자 칸 바탕이 `bg`인가 — 넓은 문자 뒤 채움 칸은 ratatui가 스타일을 안 입히므로 건너뛴다.
fn row_bg_is(buf: &Buffer, y: u16, bg: Color) -> bool {
    let mut skip = 0usize;
    for x in 0..buf.area.width {
        if skip > 0 {
            skip -= 1;
            continue;
        }
        let sym = buf[(x, y)].symbol();
        skip = width(sym).saturating_sub(1);
        if buf[(x, y)].style().bg != Some(bg) {
            return false;
        }
    }
    true
}

const WHITE: Color = Color::Rgb(0xf2, 0xf5, 0xf8);

#[test]
fn render_edit_menu_selection_and_note() {
    let p = PanelConfig {
        conditions: vec![
            cond(|c| c.value = "v1".into()),
            cond(|c| c.value = "v2".into()),
        ],
        ..edit_panel()
    };
    let items = settings_items_edit(&p, &edit_names(), 100);
    let lines = edit_menu_lines(&items, 100);
    let note = "(묶음) = 점검 묶음 1의 값";
    let v = menu_view(&lines, 5, Some(note), None);
    let (buf, table, t) = draw_menu(100, 30, &v, &menu_keys());
    let rows: Vec<&str> = t.lines().collect();
    assert!(rows[0].contains(text::MONITOR_TITLE), "{t}");
    assert!(rows[1].starts_with("칸 설정 · 주문 조회"), "{t}");
    assert!(
        rows[1].trim_end().ends_with(text::SETTINGS_EDIT_NOTE),
        "{t}"
    );
    assert!(!t.contains("보기 전용"), "{t}");
    let y6 = rows
        .iter()
        .position(|r| r.contains("제한 시간(초)"))
        .unwrap();
    assert!(rows[y6].starts_with("▶ "), "{t}");
    assert!(row_bg_is(&buf, y6 as u16, WHITE), "{t}");
    // 다른 항목 줄은 흰 바탕이 아니고 ▶도 없다.
    assert!(
        !rows[y6 - 1].contains('▶') && !rows[y6 + 1].contains('▶'),
        "{t}"
    );
    assert_ne!(buf[(5, (y6 - 1) as u16)].style().bg, Some(WHITE));
    // 구분 줄·각주·키 줄.
    assert!(t.contains(text::EDIT_DIVIDER), "{t}");
    assert!(rows.iter().any(|r| r.contains(note)), "{t}");
    assert!(rows.last().unwrap().contains("Esc 모니터로"), "{t}");
    // 반환 표: 고른 항목 줄의 y가 6번(인덱스 5)으로.
    assert!(table.contains(&(y6 as u16, 5)), "{table:?}");
    let div_y = rows
        .iter()
        .position(|r| r.contains(text::EDIT_DIVIDER))
        .unwrap() as u16;
    assert!(table.iter().all(|(y, _)| *y != div_y));
    assert!(table.windows(2).all(|w| w[0].0 < w[1].0));
    assert_eq!(table.iter().map(|(_, n)| *n).max(), Some(13));

    // 여러 줄 항목: 줄 전부 흰 바탕, ▶는 첫 줄만, 표는 두 줄 다 10번(인덱스 10).
    let v = menu_view(&lines, 10, None, None);
    let (buf, table, t) = draw_menu(100, 30, &v, &menu_keys());
    let ys: Vec<u16> = table
        .iter()
        .filter(|(_, n)| *n == 10)
        .map(|(y, _)| *y)
        .collect();
    assert_eq!(ys.len(), 2, "{table:?}");
    let rows: Vec<&str> = t.lines().collect();
    assert!(rows[usize::from(ys[0])].starts_with("▶ "), "{t}");
    assert!(!rows[usize::from(ys[1])].contains('▶'), "{t}");
    for y in &ys {
        assert!(row_bg_is(&buf, *y, WHITE), "{t}");
    }

    // 고른 항목이 없는 커서(범위 밖)도 안전 — 흰 바탕 줄이 없다.
    let v = menu_view(&lines, usize::MAX, None, None);
    let (buf, _, t) = draw_menu(100, 30, &v, &menu_keys());
    assert!(!t.contains('▶'), "{t}");
    assert!((0..30u16).all(|y| buf[(5, y)].style().bg != Some(WHITE)));
}

#[test]
fn render_input_overlay() {
    let lines = edit_menu_lines(&settings_items_edit(&edit_panel(), &edit_names(), 100), 100);
    let share = "이 값을 쓰는 칸 4개(보드 2개)가 함께 바뀝니다";
    let err = "제한 시간은 1~30초여야 합니다";
    let hint = text::range_hint(1, 30);
    assert_eq!(hint, "1~30");
    let input_keys = vec![text::KEYS_SAVE, text::KEYS_CANCEL, text::KEYS_CLEAR];
    let v = menu_view(
        &lines,
        5,
        None,
        Some(OverlayView::Input {
            label: "제한 시간(초)",
            text: "45".into(),
            cursor_x: 2,
            hint: Some(hint.clone()),
            error: Some(err),
            share: Some(share),
        }),
    );
    let (buf, _, t) = draw_menu(100, 30, &v, &input_keys);
    let rows: Vec<&str> = t.lines().collect();
    let y_in = rows
        .iter()
        .rposition(|r| r.contains("제한 시간(초)") && r.contains("45"))
        .unwrap_or_else(|| panic!("{t}"));
    assert!(rows[y_in].contains("1~30"), "{t}");
    assert!(rows[y_in + 1].contains(err), "{t}");
    assert!(rows[y_in - 1].contains(share), "{t}");
    // 노란(공유) 줄 / 빨간(오류) 줄.
    let fg = |y: usize| buf[(1, y as u16)].style().fg;
    assert_eq!(fg(y_in - 1), Some(Color::Rgb(0xf5, 0x9e, 0x0b)), "{t}");
    assert_eq!(fg(y_in + 1), Some(Color::Rgb(0xef, 0x44, 0x44)), "{t}");
    // 키 줄 바로 위 영역(무입력 안내 줄 제외)에 있고 맨 아래는 입력줄 키.
    assert!(rows.last().unwrap().contains("Enter 저장"), "{t}");
    assert!(rows.last().unwrap().contains("Ctrl+U 지우기"), "{t}");
    // 목록은 위쪽에 그대로 보인다.
    assert!(t.contains("점검 주기(초)"), "{t}");

    // 오류·공유 없이 1줄.
    let v = menu_view(
        &lines,
        5,
        None,
        Some(OverlayView::Input {
            label: "제한 시간(초)",
            text: "15".into(),
            cursor_x: 2,
            hint: Some(hint),
            error: None,
            share: None,
        }),
    );
    let (_, _, t2) = draw_menu(100, 30, &v, &input_keys);
    assert!(
        t2.contains("제한 시간(초)  15")
            || t2.lines().any(|r| r.contains("15") && r.contains("1~30")),
        "{t2}"
    );
    assert!(!t2.contains(err) && !t2.contains(share), "{t2}");
}

#[test]
fn render_other_overlays() {
    let lines = edit_menu_lines(&settings_items_edit(&edit_panel(), &edit_names(), 100), 100);
    for (ov, want, keys) in [
        (
            OverlayView::Confirm(
                "조건 2개·표시 값 1개도 이 스텝으로 바뀝니다 — Enter 계속 · Esc 취소",
            ),
            "조건 2개·표시 값 1개",
            vec![],
        ),
        (OverlayView::Saving, text::SAVING, vec![]),
        (
            OverlayView::Notice("시나리오는 GUI에서 바꿉니다"),
            "시나리오는 GUI에서 바꿉니다",
            vec!["Esc 모니터로"],
        ),
    ] {
        let v = menu_view(&lines, 1, None, Some(ov));
        let (_, _, t) = draw_menu(100, 30, &v, &keys);
        assert!(t.contains(want), "{t}");
        assert!(t.contains("점검 주기(초)"), "{t}");
    }
}

fn five_options() -> Vec<String> {
    vec![
        "1 로그인       POST /login".into(),
        "2 주문 목록    GET  /orders".into(),
        "3 주문 상세    GET  /orders/{{order_id}}".into(),
        "4 재고         GET  /stock/{{sku}}".into(),
    ]
}

#[test]
fn render_pick_overlay() {
    let lines = edit_menu_lines(&settings_items_edit(&edit_panel(), &edit_names(), 100), 100);
    let opts = five_options();
    let v = menu_view(
        &lines,
        3,
        None,
        Some(OverlayView::Pick {
            title: "볼 스텝",
            options: &opts,
            cursor: 2,
        }),
    );
    let (_, _, t) = draw_menu(100, 30, &v, &["↑↓ 고르기", "Enter 저장", "Esc 취소"]);
    let rows: Vec<&str> = t.lines().collect();
    assert!(!t.contains("흐름 전체"), "{t}");
    assert!(
        t.contains('┌') && t.contains("볼 스텝") && t.contains('└'),
        "{t}"
    );
    let y3 = rows.iter().position(|r| r.contains("3 주문 상세")).unwrap();
    assert!(rows[y3].contains('▶'), "{t}");
    assert_eq!(rows.iter().filter(|r| r.contains('▶')).count(), 2, "{t}"); // 메뉴 4번 + 고른 줄
    // 박스는 고른 항목(볼 스텝) 줄 아래에 있다.
    let y_item = rows
        .iter()
        .position(|r| r.contains("볼 스텝") && r.contains("▶") && !r.contains('┌'))
        .unwrap();
    let y_top = rows.iter().position(|r| r.contains('┌')).unwrap();
    assert!(y_top > y_item, "{t}");
    assert!(rows.iter().any(|r| r.contains("4 재고")), "{t}");

    // 아래에 공간이 없으면 위로: 마지막 항목(14번)을 고르면 박스가 그 줄 위에 온다.
    let v = menu_view(
        &lines,
        13,
        None,
        Some(OverlayView::Pick {
            title: "t",
            options: &opts,
            cursor: 0,
        }),
    );
    let (_, _, t) = draw_menu(100, 24, &v, &["x"]);
    let rows: Vec<&str> = t.lines().collect();
    let y_top = rows.iter().position(|r| r.contains('┌')).unwrap();
    let y_item = rows
        .iter()
        .position(|r| r.contains("시나리오 변수"))
        .unwrap();
    assert!(y_top < y_item, "{t}");
    assert!(rows.iter().any(|r| r.contains("1 로그인")), "{t}");

    // 위아래 다 모자라면 body 전체 — 선택 옵션이 스크롤돼 보인다.
    let many: Vec<String> = (1..=30).map(|i| format!("{i} 스텝")).collect();
    let v = menu_view(
        &lines,
        5,
        None,
        Some(OverlayView::Pick {
            title: "t",
            options: &many,
            cursor: 25,
        }),
    );
    let (_, _, t) = draw_menu(60, 14, &v, &["x"]);
    assert!(t.contains("26 스텝"), "{t}");
    assert!(t.contains('┌'), "{t}");
}

#[test]
fn pick_and_title_are_sanitized() {
    let lines = edit_menu_lines(&settings_items_edit(&edit_panel(), &edit_names(), 100), 100);
    let opts = vec![
        "1 a\u{202E}b  GET /x".to_string(),
        "2 c\u{2028}d".to_string(),
    ];
    let v = EditMenuView {
        title: "t\u{202E}x",
        lines: &lines,
        cursor: 3,
        scroll: 0,
        note: Some("n\u{202E}m"),
        overlay: Some(OverlayView::Pick {
            title: "p\u{202E}q",
            options: &opts,
            cursor: 0,
        }),
    };
    let (_, _, t) = draw_menu(100, 30, &v, &["x"]);
    assert!(t.contains("a\u{FFFD}b"), "{t}");
    assert!(t.contains("c\u{FFFD}d"), "{t}");
    assert!(t.contains("t\u{FFFD}x"), "{t}");
    assert!(t.contains("p\u{FFFD}q"), "{t}");
    assert!(!t.contains('\u{202E}'));
    // 입력줄·확인·안내도.
    for ov in [
        OverlayView::Input {
            label: "l\u{202E}1",
            text: "v\u{202E}2".into(),
            cursor_x: 0,
            hint: None,
            error: Some("e\u{202E}3"),
            share: Some("s\u{202E}4"),
        },
        OverlayView::Confirm("c\u{202E}5"),
        OverlayView::Notice("n\u{202E}6"),
    ] {
        let v = menu_view(&lines, 3, None, Some(ov));
        let (_, _, t) = draw_menu(100, 30, &v, &["x"]);
        assert!(!t.contains('\u{202E}'), "{t}");
        for k in [
            "l\u{FFFD}1",
            "v\u{FFFD}2",
            "e\u{FFFD}3",
            "s\u{FFFD}4",
            "c\u{FFFD}5",
            "n\u{FFFD}6",
        ] {
            let _ = k;
        }
        assert!(t.contains('\u{FFFD}'), "{t}");
    }
}

#[test]
fn edit_menu_size_sweep_no_panic() {
    let p = PanelConfig {
        conditions: vec![cond(|c| c.value = "v1".into())],
        ..edit_panel()
    };
    let opts = five_options();
    for w in 1..=60u16 {
        let items = settings_items_edit(&p, &edit_names(), usize::from(w));
        let lines = edit_menu_lines(&items, usize::from(w));
        for h in 1..=16u16 {
            for cursor in [0usize, 13] {
                let overlays = [
                    None,
                    Some(OverlayView::Input {
                        label: "제한 시간(초)",
                        text: "가나다라마바사".into(),
                        cursor_x: 14,
                        hint: Some("1~30".into()),
                        error: Some("제한 시간은 1~30초여야 합니다"),
                        share: Some("이 값을 쓰는 칸 4개가 함께 바뀝니다"),
                    }),
                    Some(OverlayView::Pick {
                        title: "볼 스텝",
                        options: &opts,
                        cursor: 3,
                    }),
                    Some(OverlayView::Confirm(
                        "조건 2개도 바뀝니다 — Enter 계속 · Esc 취소",
                    )),
                    Some(OverlayView::Saving),
                    Some(OverlayView::Notice("시나리오는 GUI에서 바꿉니다")),
                ];
                for ov in overlays {
                    let mut v = menu_view(&lines, cursor, Some("(묶음) = 묶음의 값"), ov);
                    v.scroll = usize::from(h) % 5;
                    let _ = draw_menu(w, h, &v, &menu_keys());
                }
            }
        }
    }
}

#[test]
fn settings_height_still_counts_title_and_note() {
    let body = sub_layout(Rect::new(0, 0, 100, 20)).body;
    assert_eq!(settings_height(body, true), usize::from(body.height) - 2);
    assert_eq!(settings_height(body, false), usize::from(body.height) - 1);
}
