use handicap_controller::store;
use handicap_controller::store::open_loop::{
    OpenLoopTotal, insert_open_loop_seconds, open_loop_seconds, open_loop_totals, sum_by_second,
};

fn t(ts_second: i64, launched: i64, completed: i64, dropped: i64) -> OpenLoopTotal {
    OpenLoopTotal {
        ts_second,
        launched,
        completed,
        dropped,
    }
}

async fn seeded() -> store::Db {
    let db = store::connect("sqlite::memory:").await.unwrap();
    insert_open_loop_seconds(&db, "A", "w0", &[(1000, 5, 4, 0), (1001, 6, 6, 1)])
        .await
        .unwrap();
    insert_open_loop_seconds(&db, "A", "w1", &[(1001, 3, 2, 0), (1002, 2, 3, 0)])
        .await
        .unwrap();
    insert_open_loop_seconds(&db, "B", "w0", &[(1001, 100, 100, 100)])
        .await
        .unwrap();
    db
}

#[tokio::test]
async fn totals_sum_workers_and_isolate_runs() {
    let db = seeded().await;
    let totals = open_loop_totals(&db, "A").await.unwrap();
    assert_eq!(
        totals,
        vec![t(1000, 5, 4, 0), t(1001, 9, 8, 1), t(1002, 2, 3, 0)]
    );
}

#[tokio::test]
async fn sum_by_second_matches_sql() {
    let db = seeded().await;
    let rows = open_loop_seconds(&db, "A").await.unwrap();
    assert_eq!(
        sum_by_second(&rows),
        open_loop_totals(&db, "A").await.unwrap()
    );
}

#[tokio::test]
async fn totals_empty_for_unknown_run() {
    let db = seeded().await;
    assert!(open_loop_totals(&db, "nope").await.unwrap().is_empty());
}
