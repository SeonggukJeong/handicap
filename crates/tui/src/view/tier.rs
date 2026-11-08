//! 크기 단계(S/M/L) 결정 — 설정(`timeout_seconds`·표시 항목 유무·통계 표시)과 칸 크기로만 정한다.
//! 점검 값·상태는 입력에 없다(시그니처로 강제 — spec §2 반목표 1, §4.1).

use super::bigfont::{self, Tier};
use crate::judge::format_stat_num;

/// 칸 하나의 크기 결정 입력(설정만).
pub struct TierInput {
    pub timeout_seconds: u32,
    /// `PanelView.n_display_items > 0`.
    pub has_display_items: bool,
    pub show_stats: bool,
}

/// 막대 영역 최소 줄 수.
pub const MIN_BAR_ROWS: u16 = 3;
/// 표시 항목 영역 최소 폭.
pub const MIN_DISPLAY_W: u16 = 6;
/// 단위 `" ms"` 폭.
pub const UNIT_W: u16 = 3;

/// 가장 넓은 값(타임아웃 ms)의 문구.
pub fn reference_text(timeout_seconds: u32) -> String {
    format_stat_num(f64::from(timeout_seconds) * 1000.0)
}

/// 기준 문구를 그 단계 글꼴로 쓴 폭 + 단위.
pub fn reference_width(timeout_seconds: u32, tier: Tier) -> u16 {
    let w = bigfont::width(&reference_text(timeout_seconds), tier) + usize::from(UNIT_W);
    u16::try_from(w).unwrap_or(u16::MAX)
}

/// 그 단계가 예약하는 줄 수: 1 + 글자 높이 + 1 + 1 + 1 + 통계 + 최소 막대.
pub fn reserved_rows(tier: Tier, show_stats: bool) -> u16 {
    let glyph_h = match tier {
        Tier::L => 5,
        Tier::M => 3,
        Tier::S => 0,
    };
    1 + glyph_h + 1 + 1 + 1 + u16::from(show_stats) + MIN_BAR_ROWS
}

/// `inner` = 테두리 안쪽 폭·높이. L·M은 좌우 여백 1씩 뺀 폭으로 잰다.
pub fn panel_tier(inner_w: u16, inner_h: u16, p: &TierInput) -> Tier {
    let usable = inner_w.saturating_sub(2);
    for tier in [Tier::L, Tier::M] {
        let need_w =
            reference_width(p.timeout_seconds, tier).saturating_add(if p.has_display_items {
                1 + MIN_DISPLAY_W
            } else {
                0
            });
        if usable >= need_w && inner_h >= reserved_rows(tier, p.show_stats) {
            return tier;
        }
    }
    Tier::S
}

/// 보드 전체 단계 = 칸별 단계의 최소. 빈 목록은 S.
pub fn board_tier(inners: &[(u16, u16)], ps: &[TierInput]) -> Tier {
    inners
        .iter()
        .zip(ps)
        .map(|(&(w, h), p)| panel_tier(w, h, p))
        .min()
        .unwrap_or(Tier::S)
}
