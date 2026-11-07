//! 막대 아래 시각 줄(spec §5.1 US6) — 순수 함수.

/// 시각 줄의 눈금 1개: 막대 슬롯 `start`부터 `text`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    pub start: u16,
    pub text: String,
}

/// 눈금끼리 최소 간격(칸).
const MIN_GAP: usize = 2;

fn len(s: &str) -> usize {
    s.chars().count()
}

/// `times` = 보이는 막대 슬롯의 `at_ms`(왼→오, 빈 슬롯 `None`은 왼쪽에만).
pub fn axis_marks(times: &[Option<i64>], label: &dyn Fn(i64) -> String) -> Vec<Mark> {
    let w = times.len();
    let Some(f) = times.iter().position(|t| t.is_some()) else {
        return Vec::new();
    };
    let left_text = label(times[f].unwrap_or_default());
    let ll = len(&left_text);
    if w < ll {
        return Vec::new();
    }
    let left_start = f.min(w - ll);
    let left_end = left_start + ll;
    let mut marks = vec![Mark {
        start: left_start as u16,
        text: left_text,
    }];

    // 오른쪽 끝: 마지막 슬롯의 시각, 끝을 폭에 맞춘다. 못 띄우거나 글자가 같으면 생략.
    let mut right: Option<Mark> = None;
    if let Some(ms) = times[w - 1] {
        let text = label(ms);
        let rl = len(&text);
        if rl <= w && w - rl >= left_end + MIN_GAP && text != marks[0].text {
            right = Some(Mark {
                start: (w - rl) as u16,
                text,
            });
        }
    }

    // 중간: 왼→오 탐욕 배치(앞 눈금과 글자 길이만큼 띄워 듬성듬성).
    let limit = match &right {
        Some(r) => (r.start as usize).saturating_sub(MIN_GAP),
        None => w,
    };
    let mut prev_end = left_end;
    let mut prev_text = marks[0].text.clone();
    for (k, t) in times.iter().enumerate().skip(f + 1) {
        let Some(ms) = *t else { continue };
        let text = label(ms);
        let tl = len(&text);
        if text == prev_text || right.as_ref().is_some_and(|r| r.text == text) {
            continue;
        }
        if limit < tl {
            break;
        }
        let lo = prev_end + tl.max(MIN_GAP);
        let s = k.saturating_sub(tl / 2).max(lo).min(limit - tl);
        if s < lo || s > k || k >= s + tl {
            continue;
        }
        prev_end = s + tl;
        prev_text.clone_from(&text);
        marks.push(Mark {
            start: s as u16,
            text,
        });
    }
    marks.extend(right);
    marks
}

/// 명목 구간 `(보이는 칸 수 − 1) × interval` < 600초면 초 단위 형식.
pub fn axis_uses_seconds(visible_slots: usize, interval_sec: u32) -> bool {
    (visible_slots.saturating_sub(1) as u64) * u64::from(interval_sec) < 600
}

/// 폭만큼 공백 위에 눈금을 얹은 한 줄.
pub fn axis_line(times: &[Option<i64>], label: &dyn Fn(i64) -> String) -> String {
    let mut line: Vec<char> = vec![' '; times.len()];
    for m in axis_marks(times, label) {
        for (i, c) in m.text.chars().enumerate() {
            if let Some(slot) = line.get_mut(m.start as usize + i) {
                *slot = c;
            }
        }
    }
    line.into_iter().collect()
}
