//! 상태 코드 판정 규칙. 검사(`assert`) 줄이 없으면 400 이상이 오류(기본 규칙),
//! 있으면 그 줄들만 따른다(모든 줄 만족). `any` 줄은 늘 만족.

use crate::scenario::{Assertion, StatusExpect};

/// 판정 결과. `Mismatch` = 검사 줄 불일치, `DefaultRule` = 검사 없는 스텝의 400 이상.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusVerdict {
    Pass,
    Mismatch,
    DefaultRule,
}

fn satisfies(expect: &StatusExpect, status: u16) -> bool {
    match expect {
        StatusExpect::One(c) => *c == status,
        StatusExpect::AnyOf(cs) => cs.contains(&status),
        StatusExpect::Any => true,
    }
}

/// 응답 상태 코드 판정. 할당 없음.
pub fn judge_status(asserts: &[Assertion], status: u16) -> StatusVerdict {
    if asserts.is_empty() {
        return if status >= 400 {
            StatusVerdict::DefaultRule
        } else {
            StatusVerdict::Pass
        };
    }
    let all = asserts.iter().all(|a| match a {
        Assertion::Status(e) => satisfies(e, status),
    });
    if all {
        StatusVerdict::Pass
    } else {
        StatusVerdict::Mismatch
    }
}

/// 검사 줄이 모두 `any`뿐(1개 이상)이라 상태 코드를 확인하지 않는 스텝인가.
pub fn status_unchecked(asserts: &[Assertion]) -> bool {
    !asserts.is_empty()
        && asserts
            .iter()
            .all(|a| matches!(a, Assertion::Status(StatusExpect::Any)))
}

/// 판정에 대응하는 오류 글. `Pass`면 `None`. 불일치 글은 처음 어긋난 줄의 기대값.
pub fn status_error_text(asserts: &[Assertion], status: u16, v: StatusVerdict) -> Option<String> {
    match v {
        StatusVerdict::Pass => None,
        StatusVerdict::DefaultRule => Some(format!("status {status} (>= 400)")),
        StatusVerdict::Mismatch => {
            let first = asserts.iter().find_map(|a| match a {
                Assertion::Status(e) if !satisfies(e, status) => Some(e),
                Assertion::Status(_) => None,
            })?;
            Some(match first {
                StatusExpect::One(c) => format!("status {status} != {c}"),
                StatusExpect::AnyOf(cs) => {
                    let list = cs.iter().map(u16::to_string).collect::<Vec<_>>().join(", ");
                    format!("status {status} not in [{list}]")
                }
                // Any는 늘 만족하므로 어긋난 줄이 될 수 없다.
                StatusExpect::Any => format!("status {status} != any"),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::StatusVerdict::*;
    use super::*;

    fn one(c: u16) -> Assertion {
        Assertion::Status(StatusExpect::One(c))
    }
    fn list(cs: &[u16]) -> Assertion {
        Assertion::Status(StatusExpect::AnyOf(cs.to_vec()))
    }
    fn any() -> Assertion {
        Assertion::Status(StatusExpect::Any)
    }

    fn read(y: &str) -> Result<Assertion, serde_yaml::Error> {
        serde_yaml::from_str::<Assertion>(y)
    }

    #[test]
    fn status_one_reads_and_writes_number() {
        let a = read("status: 200").unwrap();
        assert_eq!(a, one(200));
        assert_eq!(serde_yaml::to_string(&a).unwrap().trim(), "status: 200");
    }

    #[test]
    fn status_list_reads() {
        assert_eq!(read("status: [200, 409]").unwrap(), list(&[200, 409]));
        let a = list(&[200, 409]);
        let out = serde_yaml::to_string(&a).unwrap();
        assert_eq!(read(&out).unwrap(), a);
    }

    #[test]
    fn status_single_list_reads_as_one() {
        let a = read("status: [200]").unwrap();
        assert_eq!(a, one(200));
        assert_eq!(serde_yaml::to_string(&a).unwrap().trim(), "status: 200");
        // 코드에서 직접 만든 원소 하나짜리 목록도 숫자로 쓴다.
        assert_eq!(
            serde_yaml::to_string(&list(&[200])).unwrap().trim(),
            "status: 200"
        );
    }

    #[test]
    fn status_rejects_bad_numbers() {
        for y in [
            "status: -1",
            "status: 70000",
            "status: 200.5",
            "status: [200, -1]",
        ] {
            assert!(read(y).is_err(), "{y} must be rejected");
        }
    }

    #[test]
    fn status_duplicate_list_accepted() {
        assert_eq!(read("status: [200, 200]").unwrap(), list(&[200, 200]));
    }

    #[test]
    fn status_any_reads_and_writes() {
        let a = read("status: any").unwrap();
        assert_eq!(a, any());
        assert_eq!(serde_yaml::to_string(&a).unwrap().trim(), "status: any");
    }

    #[test]
    fn status_empty_list_is_error() {
        assert!(read("status: []").is_err());
    }

    #[test]
    fn status_unknown_word_is_error() {
        let e = read("status: all").unwrap_err().to_string();
        assert!(e.contains("any"), "message: {e}");
    }

    #[test]
    fn judge_table() {
        assert_eq!(judge_status(&[], 200), Pass);
        assert_eq!(judge_status(&[], 302), Pass);
        assert_eq!(judge_status(&[], 399), Pass);
        assert_eq!(judge_status(&[], 400), DefaultRule);
        assert_eq!(judge_status(&[], 404), DefaultRule);
        assert_eq!(judge_status(&[], 500), DefaultRule);
        assert_eq!(judge_status(&[one(404)], 404), Pass);
        assert_eq!(judge_status(&[one(404)], 200), Mismatch);
        assert_eq!(judge_status(&[list(&[200, 409])], 409), Pass);
        assert_eq!(judge_status(&[list(&[200, 409])], 500), Mismatch);
        assert_eq!(judge_status(&[any()], 500), Pass);
        assert_eq!(judge_status(&[one(200), one(201)], 200), Mismatch);
        assert_eq!(judge_status(&[any(), one(200)], 200), Pass);
        assert_eq!(judge_status(&[any(), one(200)], 500), Mismatch);
    }

    #[test]
    fn unchecked_table() {
        assert!(!status_unchecked(&[]));
        assert!(!status_unchecked(&[one(200)]));
        assert!(status_unchecked(&[any()]));
        assert!(status_unchecked(&[any(), any()]));
        assert!(!status_unchecked(&[any(), one(200)]));
    }

    #[test]
    fn error_text_contract() {
        assert_eq!(
            status_error_text(&[], 404, DefaultRule).as_deref(),
            Some("status 404 (>= 400)")
        );
        assert_eq!(
            status_error_text(&[one(200)], 503, Mismatch).as_deref(),
            Some("status 503 != 200")
        );
        assert_eq!(
            status_error_text(&[list(&[200, 409])], 503, Mismatch).as_deref(),
            Some("status 503 not in [200, 409]")
        );
        assert_eq!(status_error_text(&[], 200, Pass), None);
        // 처음 어긋난 줄의 기대값
        assert_eq!(
            status_error_text(&[one(200), one(201)], 200, Mismatch).as_deref(),
            Some("status 200 != 201")
        );
    }
}
