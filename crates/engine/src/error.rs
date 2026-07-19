use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("scenario parse: {0}")]
    ScenarioParse(#[from] serde_yaml::Error),
    #[error("template: unknown variable {0}")]
    UnknownVar(String),
    #[error("template: malformed expression near '{0}'")]
    MalformedTemplate(String),
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("all VUs failed ({failed}/{total}){}", .cause.as_ref().map(|c| format!(": {c}")).unwrap_or_default())]
    AllVusFailed {
        failed: u32,
        total: u32,
        cause: Option<String>,
    },
    #[error("histogram: {0}")]
    Histogram(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("extract failed: {0}")]
    ExtractFailed(String),
    #[error("template: cannot cast {var} value {value:?} to {cast}")]
    CastFailed {
        var: String,
        cast: &'static str,
        value: String,
    },
    #[error("aborted")]
    Aborted,
}

pub type Result<T> = std::result::Result<T, EngineError>;

/// Value-free rendering of `e` for the persisted run message (`AllVusFailed.cause`
/// → worker `phase_for_result` → gRPC `RunStatus.message` → controller
/// `truncate_message` → the `runs.message` DB column → `GET /api/runs/{id}` →
/// UI). **Allowlist, not denylist**: a new `EngineError` variant must be
/// reviewed and explicitly added to an arm here before its `Display` output can
/// reach a persisted record. The exclusion arm below names every excluded
/// variant explicitly (no `_` catch-all) so that adding a new `EngineError`
/// variant fails this match at *compile time* instead of silently falling
/// through to `None` with no review signal — the fail-closed *behavior* is
/// identical to a catch-all (message falls back to the byte-identical
/// pre-cause `"all VUs failed (N/N)"` form, same as before Task 2), only the
/// compile-time enforcement differs.
///
/// `Http(#[from] reqwest::Error)` is the concrete reason for allowlist-over-
/// denylist: its `Display` renders URLs (`… for url
/// (https://user:pass@host/?token=…)`). It is not reachable as a VU-killer
/// today — transport failures become `Ok(ExecOutcome{error})`, not `Err`, in
/// `executor.rs::execute_step` — but `#[from]` means one future `?` could make
/// it reachable; a denylist would then silently start persisting URLs the day
/// that happens. Same reasoning keeps `Io` (may embed local paths) and
/// `ExtractFailed` (may embed response-body/JSON-parse-error snippets) off the
/// allowlist.
pub fn safe_cause(e: &EngineError) -> Option<String> {
    match e {
        // Authoring-time text only (variable/step name, YAML syntax, a
        // histogram config string) — never a resolved runtime value.
        EngineError::ScenarioParse(_)
        | EngineError::UnknownVar(_)
        | EngineError::MalformedTemplate(_)
        | EngineError::Histogram(_) => Some(e.to_string()),
        // Name + target type only — never the resolved value. `value` is the
        // post-render, fully-resolved secret this function exists to drop
        // (see executor.rs::render_json_value).
        EngineError::CastFailed { var, cast, .. } => {
            Some(format!("template: cannot cast {var} to {cast}"))
        }
        // Http (URL-bearing, see above), Io (may embed local paths),
        // ExtractFailed (may embed response-body/JSON-parse-error snippets),
        // AllVusFailed (not a per-VU cause — it's the very error this cause
        // gets embedded into), Aborted (already excluded by the caller before
        // this is ever invoked) — each named explicitly, not a wildcard.
        EngineError::Http(_)
        | EngineError::Io(_)
        | EngineError::ExtractFailed(_)
        | EngineError::AllVusFailed { .. }
        | EngineError::Aborted => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cause: None` is only reachable at the type level *via the cancel path*:
    /// cancel early-returns `Err(Aborted)` before `AllVusFailed` is ever
    /// constructed (see runner.rs), so no reachable cancel input can carry a
    /// cancel-tainted cause. It is NOT otherwise unreachable at runtime — two
    /// live producers exist: (1) an all-VUs-*panic* run drains through the
    /// `JoinError` arm of the post-spawn drain loop (`while let Some(res) =
    /// set.join_next().await` in `run_scenario`/`run_scenario_vu_curve`),
    /// *outside* the spawn closure that calls `cause.set(..)`, so a genuine
    /// all-panics run produces `cause: None` with no cancel involved; (2) since
    /// Task-2-follow-up, `safe_cause` (above) is an allowlist, so a
    /// non-allowlisted `EngineError` variant (e.g. `Http`/`Io`/`ExtractFailed`)
    /// is a second live producer of `cause: None` — its `Display` is
    /// deliberately withheld from `runs.message`. This test asserts the
    /// `#[error]` attribute keeps the pre-Task-2 message byte-identical
    /// whenever `cause` ends up `None` for any of the above reasons, so those
    /// runs see zero regression in their message.
    #[test]
    fn all_vus_failed_display_without_cause_is_byte_identical_to_pre_cause_message() {
        let err = EngineError::AllVusFailed {
            failed: 2,
            total: 2,
            cause: None,
        };
        assert_eq!(err.to_string(), "all VUs failed (2/2)");
    }

    #[test]
    fn all_vus_failed_display_with_cause_appends_sampled_cause() {
        let err = EngineError::AllVusFailed {
            failed: 1,
            total: 1,
            cause: Some("template: unknown variable token".to_string()),
        };
        assert_eq!(
            err.to_string(),
            "all VUs failed (1/1): template: unknown variable token"
        );
    }

    #[test]
    fn safe_cause_allowlists_unknown_var_display_unchanged() {
        let e = EngineError::UnknownVar("token".to_string());
        assert_eq!(
            safe_cause(&e).as_deref(),
            Some("template: unknown variable token")
        );
    }

    /// The security regression at the unit level (see also the acceptance test
    /// `all_vus_failed_cast_failed_cause_redacts_secret_value` in
    /// `tests/all_vus_failed.rs`): the redacted message must carry the var name
    /// + target type but explicitly must NOT contain the resolved value.
    #[test]
    fn safe_cause_redacts_cast_failed_value() {
        let secret = "eyJhbGciOiJIUzI1NiJ9.super-secret-payload.sig";
        let e = EngineError::CastFailed {
            var: "{{billing_token}}".to_string(),
            cast: "num",
            value: secret.to_string(),
        };
        let msg = safe_cause(&e).expect("CastFailed is allowlisted (redacted)");
        assert_eq!(msg, "template: cannot cast {{billing_token}} to num");
        assert!(
            !msg.contains(secret),
            "redacted cause must not contain the resolved value, got: {msg}"
        );
    }

    #[test]
    fn safe_cause_denylists_non_allowlisted_variants_by_default() {
        let extract_err = EngineError::ExtractFailed("no match: $.body".to_string());
        assert_eq!(safe_cause(&extract_err), None);

        let io_err = EngineError::Io(std::io::Error::other("disk full"));
        assert_eq!(safe_cause(&io_err), None);

        let aborted = EngineError::Aborted;
        assert_eq!(safe_cause(&aborted), None);
    }
}
