//! 순수 트리거 엔진(schedule::trigger) 동작 테스트.
use chrono::{Datelike, TimeZone, Timelike};
use chrono_tz::Asia::Seoul;
use handicap_controller::schedule::trigger::{
    Trigger, next_fire_after, next_fires, validate_trigger,
};

fn seoul_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
    Seoul
        .with_ymd_and_hms(y, mo, d, h, mi, 0)
        .unwrap()
        .timestamp_millis()
}

#[test]
fn once_next_fire_is_the_run_at_itself() {
    let t = Trigger::Once { run_at: 5_000 };
    assert_eq!(next_fire_after(&t, 0, Seoul), Some(5_000));
    // now 이후여도 once는 run_at을 그대로 돌려준다(루프가 발사 후 비활성화).
    assert_eq!(next_fire_after(&t, 9_999, Seoul), Some(5_000));
}

#[test]
fn cron_daily_next_is_same_day_when_time_not_yet_passed() {
    // 매일 02:00. now = 2026-06-06 01:00 KST → 다음 = 같은 날 02:00 KST.
    let t = Trigger::Cron {
        expr: "0 2 * * *".into(),
    };
    let now = seoul_ms(2026, 6, 6, 1, 0);
    let next = next_fire_after(&t, now, Seoul).expect("cron has a next");
    let dt = chrono::DateTime::from_timestamp_millis(next)
        .unwrap()
        .with_timezone(&Seoul);
    assert_eq!((dt.year(), dt.month(), dt.day()), (2026, 6, 6));
    assert_eq!((dt.hour(), dt.minute()), (2, 0));
}

#[test]
fn cron_daily_next_rolls_to_tomorrow_when_time_passed() {
    // now = 2026-06-06 03:00 KST, 02:00은 지남 → 다음 = 2026-06-07 02:00 KST.
    let t = Trigger::Cron {
        expr: "0 2 * * *".into(),
    };
    let now = seoul_ms(2026, 6, 6, 3, 0);
    let next = next_fire_after(&t, now, Seoul).unwrap();
    let dt = chrono::DateTime::from_timestamp_millis(next)
        .unwrap()
        .with_timezone(&Seoul);
    assert_eq!((dt.year(), dt.month(), dt.day()), (2026, 6, 7));
    assert_eq!((dt.hour(), dt.minute()), (2, 0));
}

#[test]
fn next_fires_returns_count_strictly_increasing() {
    let t = Trigger::Cron {
        expr: "0 2 * * *".into(),
    };
    let now = seoul_ms(2026, 6, 6, 1, 0);
    let fires = next_fires(&t, now, Seoul, 3);
    assert_eq!(fires.len(), 3);
    assert!(fires[0] < fires[1] && fires[1] < fires[2]);
    // 첫 발사 = 같은 날 02:00.
    assert_eq!(fires[0], seoul_ms(2026, 6, 6, 2, 0));
}

#[test]
fn next_fires_once_is_single() {
    let t = Trigger::Once { run_at: 42 };
    assert_eq!(next_fires(&t, 0, Seoul, 5), vec![42]);
}

#[test]
fn validate_rejects_bad_cron_and_past_once() {
    let now = seoul_ms(2026, 6, 6, 1, 0);
    assert!(
        validate_trigger(
            &Trigger::Cron {
                expr: "not a cron".into()
            },
            now
        )
        .is_err()
    );
    assert!(validate_trigger(&Trigger::Once { run_at: now - 1 }, now).is_err());
    assert!(validate_trigger(&Trigger::Once { run_at: now + 1 }, now).is_ok());
    assert!(
        validate_trigger(
            &Trigger::Cron {
                expr: "0 2 * * *".into()
            },
            now
        )
        .is_ok()
    );
}
