//! 화면 렌더링 — 뷰 모델(`model`)·시각 줄(`axis`)·모니터(`monitor`)·팝업(`overlay`)·오류(`error`)·
//! 오류 보기 등 새 화면 틀(`inspect`)·칸 설정 보기(`settings`).

pub mod axis;
pub mod bigfont;
pub mod edit;
pub mod error;
pub mod graph;
pub mod inspect;
pub mod model;
pub mod monitor;
pub mod overlay;
pub mod settings;
pub mod tier;
pub mod values;

use ratatui::buffer::CellWidth;
use ratatui::layout::Rect;
use unicode_segmentation::{Graphemes, UnicodeSegmentation};

/// 글자 묶음 하나의 칸 수 — ratatui `Buffer::set_stringn`과 같은 규칙: 제어 문자가 든 묶음은 0칸(그려지지 않는다),
/// 그 밖은 `CellWidth::cell_width`.
fn cell_of(g: &str) -> usize {
    if g.contains(char::is_control) {
        0
    } else {
        usize::from(g.cell_width())
    }
}

/// 글자 묶음과 그 칸 수(앞에서부터). 폭을 재거나 자르는 코드는 전부 이것(뒤에서부터는 [`cells_rev`])만 쓴다.
/// 내는 묶음은 `graphemes(true)`와 같다 — ASCII가 이어지는 구간만 묶음 나누기를 건너뛴다([`Cells`]).
pub(crate) fn cells(s: &str) -> Cells<'_> {
    Cells {
        s,
        at: 0,
        slow: None,
    }
}

/// 글자 묶음과 그 칸 수(뒤에서부터) — 끝에서 몇 칸만 볼 때(`fit_head`).
pub(crate) fn cells_rev(s: &str) -> impl Iterator<Item = (&str, usize)> {
    s.graphemes(true).rev().map(|g| (g, cell_of(g)))
}

/// [`cells`]의 반복자. 앞뒤 바이트도 ASCII인 ASCII 인쇄 글자(0x20..=0x7E)는 언제나 혼자 한 묶음·1칸이다:
/// ASCII 글자는 앞 글자에 붙는 종류(결합·ZWJ·뒤붙임)가 아니고, 앞 글자가 ASCII면 뒤 글자를 끌어당기는 종류
/// (앞붙임 글자)도 아니며, 제어 문자 옆은 언제나 경계다. 그런 글자는 바로 내고, 그 밖의 구간
/// (ASCII가 아닌 글자·제어 문자와 그 옆 ASCII 한 글자씩)만 `graphemes`로 나눈다(속도 — spec §2.1-10).
pub(crate) struct Cells<'a> {
    s: &'a str,
    at: usize,
    /// 묶음 나누기로 도는 구간과 그 끝 위치.
    slow: Option<(Graphemes<'a>, usize)>,
}

impl Cells<'_> {
    fn plain(&self, i: usize) -> bool {
        let b = self.s.as_bytes();
        (0x20..=0x7e).contains(&b[i])
            && (i == 0 || b[i - 1].is_ascii())
            && (i + 1 == b.len() || b[i + 1].is_ascii())
    }
}

impl<'a> Iterator for Cells<'a> {
    type Item = (&'a str, usize);

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some((it, end)) = &mut self.slow {
                if let Some(g) = it.next() {
                    return Some((g, cell_of(g)));
                }
                self.at = *end;
                self.slow = None;
            }
            let s = self.s;
            if self.at >= s.len() {
                return None;
            }
            if self.plain(self.at) {
                let g = &s[self.at..self.at + 1];
                self.at += 1;
                return Some((g, 1));
            }
            let mut end = self.at + 1;
            while end < s.len() && !self.plain(end) {
                end += 1;
            }
            self.slow = Some((s[self.at..end].graphemes(true), end));
        }
    }
}

/// 문자열의 표시 폭(셀 수) — 화면에 그려지는 칸 수와 같다.
pub(crate) fn text_width(s: &str) -> usize {
    cells(s).map(|(_, w)| w).sum()
}

/// 표시 폭 `w`에 맞게 자른다. 잘리면 끝에 `…`(1칸) — 글자 묶음은 쪼개지 않는다.
pub(crate) fn fit(s: &str, w: usize) -> String {
    if text_width(s) <= w {
        return s.to_string();
    }
    if w == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for (g, gw) in cells(s) {
        if used + gw > w - 1 {
            break;
        }
        used += gw;
        out.push_str(g);
    }
    out.push('…');
    out
}

/// 표시 폭 `w` 행들로 글자 묶음 단위로 자른다. 폭 0 묶음은 줄을 바꾸지 않는다.
pub(crate) fn wrap_width(s: &str, w: usize) -> Vec<String> {
    let mut rows = Vec::new();
    let mut cur = String::new();
    let mut used = 0;
    for (g, gw) in cells(s) {
        if gw > 0 && used + gw > w && !cur.is_empty() {
            rows.push(std::mem::take(&mut cur));
            used = 0;
        }
        cur.push_str(g);
        used += gw;
    }
    rows.push(cur);
    rows
}

/// 키 안내 줄 — 폭에 안 들어가면 앞 조각부터 통째로 뺀다(마지막 조각은 남기고, 그래도 넘치면 `…`).
/// 앞에 공백 1칸을 둔다.
pub(crate) fn key_bar(segments: &[&str], width: u16) -> String {
    let avail = usize::from(width).saturating_sub(1);
    let mut from = 0;
    while from + 1 < segments.len() && text_width(&segments[from..].join("  ")) > avail {
        from += 1;
    }
    format!(" {}", fit(&segments[from..].join("  "), avail))
}

/// `area` 가운데에 `w`×`h`(영역보다 크면 영역만큼) 사각형.
pub(crate) fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width);
    let h = h.min(area.height);
    Rect::new(
        area.x + (area.width - w) / 2,
        area.y + (area.height - h) / 2,
        w,
        h,
    )
}

#[cfg(test)]
mod tests {
    use super::values::fit_head;
    use super::*;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;
    use ratatui::style::Style;
    use unicode_segmentation::UnicodeSegmentation;

    /// ratatui가 실제로 쓰는 칸 수.
    fn drawn(s: &str) -> usize {
        let mut buf = Buffer::empty(Rect::new(0, 0, 200, 1));
        usize::from(buf.set_stringn(0, 0, s, usize::MAX, Style::default()).0)
    }

    const POOL: &[&str] = &[
        "a",
        "\u{d55c}",
        "\u{2764}\u{FE0F}",
        "\u{2764}",
        "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
        "\u{1F44D}\u{1F3FD}",
        "e\u{301}",
        "\u{644}\u{627}",
        "\u{1F1F0}\u{1F1F7}",
        "\u{FF76}\u{FF9E}",
        "1\u{FE0F}\u{20E3}",
        "\u{FFFD}",
        "\u{1112}\u{1161}\u{11AB}",
        // 묶음 경계가 까다로운 것: 제어 갈래지만 그려지는 글자(soft hyphen)·그 뒤에서 홀로 서는 결합 글자·앞붙임 글자.
        "\u{AD}",
        "\u{301}",
        "\u{600}",
    ];

    fn samples() -> Vec<String> {
        let mut v = Vec::new();
        for a in POOL {
            v.push((*a).to_string());
            for b in POOL {
                v.push(format!("{a}{b}"));
                for c in POOL {
                    v.push(format!("{a}{b}{c}"));
                }
            }
        }
        v
    }

    #[test]
    fn width_is_what_ratatui_draws() {
        for s in samples() {
            assert_eq!(text_width(&s), drawn(&s), "{s:?}");
        }
    }

    /// `cells`의 ASCII 빠른 길이 `graphemes(true)`와 같은 묶음을 낸다 — 빠른 길의 경계
    /// (ASCII 옆의 결합 글자·앞붙임 글자·제어 문자·CR LF·변형 선택자)를 훑는다.
    #[test]
    fn cells_fast_path_equals_graphemes() {
        const EDGE: &[&str] = &[
            "a",
            "b ",
            "1",
            "\r",
            "\n",
            "\t",
            "\u{1b}",
            "\u{7f}",
            "\u{600}",
            "\u{301}",
            "\u{200D}",
            "\u{FE0F}",
            "\u{20E3}",
            "\u{d55c}",
            "\u{FF9E}",
            "\u{1F1F0}",
            "\u{915}\u{94D}",
            "\u{1F44D}",
            "\u{AD}",
        ];
        let mut all = samples();
        for a in EDGE {
            for b in EDGE {
                all.push(format!("{a}{b}"));
                for c in EDGE {
                    all.push(format!("{a}{b}{c}"));
                    for d in EDGE {
                        all.push(format!("{a}{b}{c}{d}"));
                    }
                }
            }
        }
        all.push("plain ascii only".repeat(10));
        // 빠른 길과 묶음 나누기를 여러 번 오가는 긴 글자.
        all.push(
            "ab\u{d55c}cd\u{301}ef\r\ngh\u{1F1F0}ij\u{915}\u{94D}k\u{1F44D}\u{200D}l\u{AD}\u{301}m"
                .into(),
        );
        for s in all {
            let want: Vec<(&str, usize)> = s.graphemes(true).map(|g| (g, cell_of(g))).collect();
            assert_eq!(cells(&s).collect::<Vec<_>>(), want, "{s:?}");
            let mut back: Vec<(&str, usize)> = cells_rev(&s).collect();
            back.reverse();
            assert_eq!(back, want, "{s:?}");
            assert_eq!(text_width(&s), drawn(&s), "{s:?}");
        }
    }

    #[test]
    fn fit_and_fit_head_stay_within_width() {
        for s in samples() {
            for w in 0..=12 {
                assert!(drawn(&fit(&s, w)) <= w, "fit {s:?} w{w}");
                assert!(drawn(&fit_head(&s, w)) <= w, "fit_head {s:?} w{w}");
                if text_width(&s) <= w {
                    assert_eq!(fit(&s, w), s);
                    assert_eq!(fit_head(&s, w), s);
                } else if w > 0 {
                    // 잘렸으면 `…` + 더 넣을 수 없을 만큼 채웠다(덜 채운 회귀를 잡는다).
                    let f = fit(&s, w);
                    let kept = f.strip_suffix('\u{2026}').expect("fit …");
                    assert!(s.starts_with(kept), "fit {s:?} w{w}");
                    let next = cells(&s[kept.len()..]).next().map_or(0, |(_, gw)| gw);
                    assert!(text_width(kept) + 1 + next > w, "fit {s:?} w{w}: {f:?}");
                    let h = fit_head(&s, w);
                    let kept = h.strip_prefix('\u{2026}').expect("fit_head …");
                    assert!(s.ends_with(kept), "fit_head {s:?} w{w}");
                    let left = &s[..s.len() - kept.len()];
                    let prev = cells_rev(left).map(|(_, gw)| gw).find(|gw| *gw > 0);
                    assert!(
                        text_width(kept) + 1 + prev.unwrap_or(0) > w,
                        "fit_head {s:?} w{w}: {h:?}"
                    );
                    // `…` 바로 뒤에 폭 0 묶음(홀로 선 결합 글자)이 오지 않는다 — `…` 위에 얹힌다.
                    assert!(
                        cells(kept).next().is_none_or(|(_, gw)| gw > 0),
                        "fit_head {s:?} w{w}: {h:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn wrap_rows_fit_and_join_back() {
        for s in samples() {
            for w in 1..=12 {
                let rows = wrap_width(&s, w);
                assert_eq!(rows.concat(), s, "{s:?} w{w}");
                for r in &rows {
                    let single = r.graphemes(true).filter(|g| drawn(g) > 0).count() <= 1;
                    assert!(drawn(r) <= w || single, "{s:?} w{w} row {r:?}");
                }
                // 줄마다 더 넣을 수 없을 만큼 채웠다 — 다음 줄의 첫 묶음이 이 줄에 안 들어간다.
                for pair in rows.windows(2) {
                    let first = cells(&pair[1]).next().map_or(0, |(_, gw)| gw);
                    assert!(first > 0, "{s:?} w{w} row {:?}", pair[1]);
                    assert!(text_width(&pair[0]) + first > w, "{s:?} w{w} rows {pair:?}");
                }
            }
        }
        assert_eq!(wrap_width("", 5), vec![String::new()]);
        assert_eq!(wrap_width("ab", 0), vec!["a".to_string(), "b".to_string()]);
    }

    /// 속도 기준선·확인(spec §2.1-10) — `cargo test -p handicap-tui --release --lib perf_width -- --ignored --nocapture`.
    #[test]
    #[ignore = "수동 측정"]
    fn perf_width() {
        let unit = "abc \u{d55c}\u{ae00} \u{2764}\u{FE0F} {\"key\": 12345.678} ";
        let s = unit.repeat(1024 * 1024 / unit.len());
        let t = std::time::Instant::now();
        let rows = wrap_width(&s, 80);
        let wrap = t.elapsed();
        let t = std::time::Instant::now();
        let mut n = 0;
        for _ in 0..10 {
            n += text_width(&s);
        }
        let width = t.elapsed();
        let t = std::time::Instant::now();
        let mut m = 0;
        for r in rows.iter().take(30_000) {
            m += fit(r, 40).len() + text_width(r);
        }
        let per_row = t.elapsed();
        println!(
            "perf_width wrap={wrap:?} text_width_x10={width:?} rows={} per_row={per_row:?} ({n} {m})",
            rows.len()
        );
    }
}
