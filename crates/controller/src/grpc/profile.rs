//! `store::Profile` → `pb::Profile` 와이어 매핑. `spawn_run`에서 추출한 순수
//! 함수라 15필드를 단위 테스트로 잠글 수 있다(추출 전엔 0건이었다).

use crate::store::runs::Profile;
use handicap_proto::v1 as pb;

/// `spawn_run`이 워커에 보낼 `PendingAssignment.profile`을 만든다.
///
/// store 20필드 중 15개가 와이어로 간다. 의도적 미매핑 5개:
/// `data_binding`/`data_bindings`(→ `PendingDataBinding` 경유) ·
/// `criteria`(컨트롤러측 SLO 판정) · `worker_count`(컨트롤러가 register 시
/// 분할) · `apply_scenario_think_time`(워커는 strip된 YAML을 받는다).
pub(crate) fn to_proto_profile(p: &Profile) -> pb::Profile {
    pb::Profile {
        vus: p.vus,
        ramp_up_seconds: p.ramp_up_seconds,
        duration_seconds: p.duration_seconds,
        loop_breakdown_cap: p.loop_breakdown_cap,
        http_timeout_seconds: p.http_timeout_seconds,
        think_time: p.think_time.map(|t| pb::ThinkTime {
            min_ms: t.min_ms,
            max_ms: t.max_ms,
        }),
        think_seed: p.think_seed,
        target_rps: p.target_rps,
        max_in_flight: p.max_in_flight,
        stages: p
            .stages
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|s| pb::Stage {
                target: s.target,
                duration_seconds: s.duration_seconds,
            })
            .collect(),
        measure_phases: p.measure_phases,
        vu_stages: p
            .vu_stages
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|s| pb::Stage {
                target: s.target,
                duration_seconds: s.duration_seconds,
            })
            .collect(),
        ramp_down_immediate: matches!(p.ramp_down, Some(handicap_engine::RampDown::Immediate)),
        graceful_ramp_down_seconds: p.graceful_ramp_down_seconds,
        connect_timeout_seconds: p.connect_timeout_seconds,
    }
}

#[cfg(test)]
mod tests {
    // 테스트는 부모 모듈의 임포트(`Profile`·`pb`)를 glob으로 받는다.
    use super::*;

    /// C1 sentinel 픽스처 — **필드마다 서로 다른 값**.
    ///
    /// ⚠ `..Default::default()`를 절대 추가하지 말 것. 20필드를 전부 명시하는
    /// 것이 이 픽스처의 목적이다: `store::Profile`에 필드가 추가되면 여기서
    /// 컴파일 에러가 나서 "이 값이 와이어로 가야 하는가"를 판단하게 만든다.
    /// (`store::Profile`은 `Default`를 파생하지 않으므로 그 탈출구는 타입
    /// 레벨에서 이미 닫혀 있다 — 유지할 것.)
    ///
    /// bool 3종은 C1에서 `(measure_phases=true, apply_scenario_think_time=false,
    /// ramp_down→false)`, C3에서 `ramp_down→true`로 갈려 임의의 bool 전치가
    /// 최소 한 케이스에서 RED가 된다.
    ///
    /// ⚠ `target_rps` + `stages` + `vu_stages`를 **동시에** 채운 것은
    /// **의도**다. 실제 run에선 `validate_run_config`가 거부하는 조합이지만,
    /// 순수 매핑 함수는 검증을 하지 않고, 세 필드를 모두 채워야 같은-타입
    /// 이웃 전치(`stages`↔`vu_stages` 등) 판별력이 최대가 된다.
    /// "잘못된 픽스처"로 보고 고치지 말 것.
    fn c1_profile() -> Profile {
        Profile {
            vus: 11,
            ramp_up_seconds: 22,
            duration_seconds: 33,
            loop_breakdown_cap: 44,
            http_timeout_seconds: 55,
            data_binding: None,
            data_bindings: vec![],
            criteria: None,
            think_time: Some(handicap_engine::ThinkTime {
                min_ms: 66,
                max_ms: 77,
            }),
            think_seed: Some(88),
            target_rps: Some(99),
            max_in_flight: Some(111),
            stages: Some(vec![handicap_engine::Stage {
                target: 122,
                duration_seconds: 133,
            }]),
            measure_phases: true,
            // 원소 2개 필수: 1개면 워커측 파생 duration(합)이 그 원소와 같아져
            // sentinel 유일성이 깨진다. 합 = 155 + 177 = 332.
            vu_stages: Some(vec![
                handicap_engine::Stage {
                    target: 144,
                    duration_seconds: 155,
                },
                handicap_engine::Stage {
                    target: 166,
                    duration_seconds: 177,
                },
            ]),
            ramp_down: Some(handicap_engine::RampDown::Graceful),
            graceful_ramp_down_seconds: Some(188),
            connect_timeout_seconds: Some(199),
            worker_count: Some(211),
            apply_scenario_think_time: false,
        }
    }

    /// C1: 전 필드 sentinel. 통째 `assert_eq!`가 같은-타입 이웃 전치
    /// (`target_rps`↔`max_in_flight`, u32 5종, `stages`↔`vu_stages`,
    /// 중첩 struct 내부)를 전부 RED로 만든다 — 오늘 이걸 잡는 방어가 없다.
    ///
    /// ⚠ 기대 리터럴에도 `..Default::default()` 금지(prost가 `Default`를
    /// 파생하므로 문법상 가능하지만, 붙이면 proto 필드 추가 시 컴파일 강제가
    /// 사라진다).
    #[test]
    fn c1_all_fields_map_to_distinct_sentinels() {
        let expected = pb::Profile {
            vus: 11,
            ramp_up_seconds: 22,
            duration_seconds: 33,
            loop_breakdown_cap: 44,
            http_timeout_seconds: 55,
            think_time: Some(pb::ThinkTime {
                min_ms: 66,
                max_ms: 77,
            }),
            think_seed: Some(88),
            target_rps: Some(99),
            max_in_flight: Some(111),
            stages: vec![pb::Stage {
                target: 122,
                duration_seconds: 133,
            }],
            measure_phases: true,
            vu_stages: vec![
                pb::Stage {
                    target: 144,
                    duration_seconds: 155,
                },
                pb::Stage {
                    target: 166,
                    duration_seconds: 177,
                },
            ],
            ramp_down_immediate: false,
            graceful_ramp_down_seconds: Some(188),
            connect_timeout_seconds: Some(199),
        };
        assert_eq!(to_proto_profile(&c1_profile()), expected);
    }

    /// 통째 비교는 실패 시 구조체 전문을 뱉어 "어느 필드"를 지목하지 못한다.
    /// US1이 약속한 관찰(실패 메시지가 필드를 지목)을 위해 필드별 단언을
    /// 병행한다 — exhaustive 리터럴(위)은 컴파일 강제용으로 유지.
    #[test]
    fn c1_per_field_assertions_name_the_field() {
        let got = to_proto_profile(&c1_profile());
        assert_eq!(got.vus, 11, "vus");
        assert_eq!(got.ramp_up_seconds, 22, "ramp_up_seconds");
        assert_eq!(got.duration_seconds, 33, "duration_seconds");
        assert_eq!(got.loop_breakdown_cap, 44, "loop_breakdown_cap");
        assert_eq!(got.http_timeout_seconds, 55, "http_timeout_seconds");
        assert_eq!(
            got.think_time.map(|t| t.min_ms),
            Some(66),
            "think_time.min_ms"
        );
        assert_eq!(
            got.think_time.map(|t| t.max_ms),
            Some(77),
            "think_time.max_ms"
        );
        assert_eq!(got.think_seed, Some(88), "think_seed");
        assert_eq!(got.target_rps, Some(99), "target_rps");
        assert_eq!(got.max_in_flight, Some(111), "max_in_flight");
        assert_eq!(got.stages.len(), 1, "stages.len");
        assert_eq!(got.stages[0].target, 122, "stages[0].target");
        assert_eq!(
            got.stages[0].duration_seconds, 133,
            "stages[0].duration_seconds"
        );
        assert!(got.measure_phases, "measure_phases");
        assert_eq!(got.vu_stages.len(), 2, "vu_stages.len");
        assert_eq!(got.vu_stages[0].target, 144, "vu_stages[0].target");
        assert_eq!(
            got.vu_stages[0].duration_seconds, 155,
            "vu_stages[0].duration_seconds"
        );
        assert_eq!(got.vu_stages[1].target, 166, "vu_stages[1].target");
        assert_eq!(
            got.vu_stages[1].duration_seconds, 177,
            "vu_stages[1].duration_seconds"
        );
        assert!(!got.ramp_down_immediate, "ramp_down_immediate");
        assert_eq!(
            got.graceful_ramp_down_seconds,
            Some(188),
            "graceful_ramp_down_seconds"
        );
        assert_eq!(
            got.connect_timeout_seconds,
            Some(199),
            "connect_timeout_seconds"
        );
    }

    /// C2: 전부 부재/기본 — 변환 규칙의 반대 방향.
    /// `stages: Some(vec![])`가 `vec![]`로 접히는지(빈 Vec ≡ 부재 규약,
    /// `is_open_loop`/`is_vu_curve` 판별과 일관) 확인한다.
    #[test]
    fn c2_absent_and_defaults() {
        let p = Profile {
            vus: 0,
            ramp_up_seconds: 0,
            duration_seconds: 0,
            loop_breakdown_cap: 0,
            http_timeout_seconds: 0,
            data_binding: None,
            data_bindings: vec![],
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: Some(vec![]),
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
            worker_count: None,
            apply_scenario_think_time: true,
        };
        let expected = pb::Profile {
            vus: 0,
            ramp_up_seconds: 0,
            duration_seconds: 0,
            loop_breakdown_cap: 0,
            http_timeout_seconds: 0,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: vec![],
            measure_phases: false,
            vu_stages: vec![],
            ramp_down_immediate: false,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
        };
        assert_eq!(to_proto_profile(&p), expected);
    }

    /// C3: `Option<RampDown>` 3상태 → `bool`.
    /// `None`은 C2가, `Some(Graceful)`은 C1이 덮으므로 여기선 세 상태를
    /// 한자리에서 대조해 규칙을 못박는다.
    #[test]
    fn c3_ramp_down_three_states() {
        let mut p = c1_profile();

        p.ramp_down = None;
        assert!(
            !to_proto_profile(&p).ramp_down_immediate,
            "ramp_down=None → false"
        );

        p.ramp_down = Some(handicap_engine::RampDown::Graceful);
        assert!(
            !to_proto_profile(&p).ramp_down_immediate,
            "ramp_down=Graceful → false"
        );

        p.ramp_down = Some(handicap_engine::RampDown::Immediate);
        assert!(
            to_proto_profile(&p).ramp_down_immediate,
            "ramp_down=Immediate → true"
        );
    }
}
