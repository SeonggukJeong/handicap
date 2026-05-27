/// Placeholder integration test for runner.rs env-field wiring.
/// Real env wiring (passing env vars from scenario/config) is Task 6.
/// This file ensures the workspace compiles with the new `env` field on
/// TemplateContext and the runner's `empty_env` placeholder.
///
/// (Kept minimal intentionally — behavioral tests live in template::tests.)

#[test]
fn placeholder_env_wiring_compiles() {
    // No runtime assertion needed — the act of compilation and linking
    // of this crate already proves runner.rs builds with the env field.
}
