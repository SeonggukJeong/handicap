//! 순수 트리거 엔진 — once/5-field cron의 다음 발사 시각 계산 + 검증.
//! TZ-aware(`chrono_tz::Tz`). DB·IO 없음. 소비자는 34b(store/runner/api).
use std::str::FromStr;

use chrono::DateTime;
use chrono_tz::Tz;
use croner::Cron;

/// 스케줄 트리거: 특정 일시 1회(once) 또는 반복(5-field 표준 crontab).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trigger {
    /// 특정 epoch ms에 1회.
    Once { run_at: i64 },
    /// 5-field crontab(분 시 일 월 요일, seconds 미사용).
    Cron { expr: String },
}

/// epoch ms → 설정 TZ의 wall-clock DateTime. 음수/범위밖은 epoch 0으로 폴백.
fn to_tz(now_ms: i64, tz: Tz) -> DateTime<Tz> {
    DateTime::from_timestamp_millis(now_ms)
        .unwrap_or_else(|| DateTime::from_timestamp_millis(0).expect("epoch 0 is valid"))
        .with_timezone(&tz)
}

/// `now_ms` 직후의 다음 발사 시각(epoch ms).
/// None = 계산 불가(잘못된 cron). validate_trigger 통과분은 항상 Some.
/// once는 항상 `Some(run_at)`(루프가 발사 후 비활성화하므로 과거여부는 루프가 처리).
pub fn next_fire_after(t: &Trigger, now_ms: i64, tz: Tz) -> Option<i64> {
    match t {
        Trigger::Once { run_at } => Some(*run_at),
        Trigger::Cron { expr } => {
            let cron = Cron::from_str(expr).ok()?;
            cron.find_next_occurrence(&to_tz(now_ms, tz), false)
                .ok()
                .map(|dt| dt.timestamp_millis())
        }
    }
}

/// 다음 `count`개 발사 시각(epoch ms). preview-next 엔드포인트(34b)용.
/// 잘못된 cron이면 빈 Vec. once는 최대 1개(`count == 0`이면 빈 Vec — cron 분기와 일관).
pub fn next_fires(t: &Trigger, now_ms: i64, tz: Tz, count: usize) -> Vec<i64> {
    match t {
        Trigger::Once { run_at } => {
            if count == 0 {
                Vec::new()
            } else {
                vec![*run_at]
            }
        }
        Trigger::Cron { expr } => {
            let Ok(cron) = Cron::from_str(expr) else {
                return Vec::new();
            };
            let mut out = Vec::with_capacity(count);
            let mut cursor = to_tz(now_ms, tz);
            for _ in 0..count {
                // exclusive(false)라 매번 직전 발사 다음으로 전진.
                match cron.find_next_occurrence(&cursor, false) {
                    Ok(next) => {
                        out.push(next.timestamp_millis());
                        cursor = next;
                    }
                    Err(_) => break,
                }
            }
            out
        }
    }
}

/// 생성/수정 시 검증: cron 파싱 실패 / once run_at 과거 → Err(메시지).
/// TZ 불필요(cron 파싱·epoch ms 비교만).
pub fn validate_trigger(t: &Trigger, now_ms: i64) -> Result<(), String> {
    match t {
        Trigger::Once { run_at } => {
            if *run_at <= now_ms {
                Err("예약 시각은 미래여야 합니다".into())
            } else {
                Ok(())
            }
        }
        Trigger::Cron { expr } => Cron::from_str(expr)
            .map(|_| ())
            .map_err(|e| format!("cron 표현식이 올바르지 않습니다: {e}")),
    }
}
