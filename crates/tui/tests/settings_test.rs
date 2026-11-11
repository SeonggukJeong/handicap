//! 칸 설정 보기 — 번호 목록 12개·조건/표시 문구·묶음 표시·그리기(spec §5.4, 목업 §4).

use handicap_controller::monitor::config::{
    BoardConfig, CheckGroup, Condition, ConditionOp, ConditionSource, DisplayItem, DisplaySource,
    LatencySource, PanelConfig, Threshold,
};
use handicap_tui::names::Names;
use handicap_tui::panel_settings::{
    condition_summary, condition_target, display_target, group_note, group_number, settings_items,
    settings_lines,
};
use handicap_tui::text;
use handicap_tui::view::inspect::sub_layout;
use handicap_tui::view::monitor::HeaderView;
use handicap_tui::view::settings::{render_settings, settings_height};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
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

fn draw<F: FnOnce(&mut ratatui::Frame)>(w: u16, h: u16, f: F) -> String {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(f).unwrap();
    buffer_text(t.backend().buffer())
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

fn keys() -> Vec<&'static str> {
    vec!["↑↓ 스크롤", "Esc 모니터로"]
}

#[test]
fn render_settings_shows_title_notice_keys() {
    let board = group_board();
    let p = &board.panels[0];
    let lines = settings_lines(&settings_items(p, &names()), 100);
    let note = group_note(&board, p);
    let t = draw(100, 20, |f| {
        render_settings(f, &head(), "주문 조회", &lines, note.as_deref(), 0, &keys())
    });
    let rows: Vec<&str> = t.lines().collect();
    assert!(rows[0].contains(text::MONITOR_TITLE), "{t}");
    assert!(rows[1].starts_with("칸 설정 · 주문 조회"), "{t}");
    assert!(rows[1].trim_end().ends_with(text::SETTINGS_READONLY), "{t}");
    assert!(rows[2].starts_with(" 1  제목"), "{t}");
    assert!(rows[17].contains("(묶음) = 점검 묶음 1의 값"), "{t}");
    assert!(rows[18].contains(text::IDLE_NOTICE), "{t}");
    assert!(rows[19].contains("Esc 모니터로"), "{t}");
    let area = Rect::new(0, 0, 100, 20);
    let body = sub_layout(area).body;
    assert_eq!(settings_height(body, true), usize::from(body.height) - 2);
    assert_eq!(settings_height(body, false), usize::from(body.height) - 1);

    let t = draw(100, 20, |f| {
        render_settings(f, &head(), "주문 조회", &lines, note.as_deref(), 3, &keys())
    });
    let rows: Vec<&str> = t.lines().collect();
    assert!(rows[2].starts_with(" 4  볼 스텝"), "{t}");
    assert!(!t.contains(" 1  제목"), "{t}");

    let t = draw(40, 20, |f| {
        render_settings(f, &head(), "주문 조회", &lines, note.as_deref(), 0, &keys())
    });
    assert!(t.contains("칸 설정 · 주문 조회"), "{t}");
    assert!(!t.contains("보기 전용"), "{t}");
}

#[test]
fn settings_size_sweep_no_panic() {
    let board = group_board();
    let p = &board.panels[0];
    let items = settings_items(p, &names());
    let note = group_note(&board, p);
    for w in 1..=50u16 {
        let lines = settings_lines(&items, usize::from(w));
        for h in 1..=12u16 {
            for n in [note.as_deref(), None] {
                draw(w, h, |f| {
                    render_settings(f, &head(), "주문 조회", &lines, n, 2, &keys())
                });
                let body = sub_layout(Rect::new(0, 0, w, h)).body;
                let _ = settings_height(body, n.is_some());
            }
        }
    }
}
