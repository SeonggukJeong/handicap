//! 사용자 설정 — 칸 테두리 모양(Task 6이 파일 입출력을 더한다).

use serde::{Deserialize, Serialize};

/// 칸 테두리 모양 — 굵은 선(기본) 또는 반 칸 블록.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BorderStyle {
    #[default]
    Heavy,
    Block,
}

impl BorderStyle {
    pub fn toggled(self) -> Self {
        match self {
            Self::Heavy => Self::Block,
            Self::Block => Self::Heavy,
        }
    }
}
