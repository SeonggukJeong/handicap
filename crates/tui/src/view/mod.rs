//! 화면 렌더링 — 뷰 모델(`model`)·시각 줄(`axis`)·모니터(`monitor`)·팝업(`overlay`)·오류(`error`).

pub mod axis;
pub mod error;
pub mod model;
pub mod monitor;
pub mod overlay;

use ratatui::layout::Rect;
use ratatui::text::Span;

/// 문자열의 표시 폭(셀 수).
pub(crate) fn text_width(s: &str) -> usize {
    Span::raw(s.to_string()).width()
}

/// 표시 폭 `w`에 맞게 뒤를 자른다(넓은 문자는 반쪽으로 자르지 않는다).
pub(crate) fn fit(s: &str, w: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let cw = text_width(c.encode_utf8(&mut [0; 4]));
        if used + cw > w {
            break;
        }
        used += cw;
        out.push(c);
    }
    out
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
