//! Run-config data binding (serialized into `profile_json`, spec §4). Kept out
//! of the proto layer: the controller converts this to `pb::DataBinding`
//! (policy/seed/row_count) + applies mappings while streaming rows, so the
//! worker stays mapping-agnostic. `unique` partitions the dataset into disjoint
//! per-worker slices (`assignment_for`/`dataset_slice`); the engine stops a VU
//! when its slice is exhausted.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingPolicy {
    PerVu,
    IterSequential,
    IterRandom,
    /// Consume each row at most once globally: the controller partitions the
    /// dataset into disjoint per-worker slices and the engine stops the VU when
    /// its slice is exhausted (gate requires `rows >= N`, `rows <= u32::MAX`).
    Unique,
}

/// One variable's source: a dataset column or a constant literal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Mapping {
    Column { var: String, column: String },
    Literal { var: String, value: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataBinding {
    pub dataset_id: String,
    pub policy: BindingPolicy,
    #[serde(default)]
    pub mappings: Vec<Mapping>,
}

/// Every variable name produced across a set of bindings, in binding-then-
/// mapping order (both `Column` and `Literal` carry a `var`). Used by the
/// run-create gate to detect a variable name mapped by more than one binding
/// (cross-binding duplicate → 400). Duplicates are preserved in the returned
/// vec; the caller decides how to flag them.
pub(crate) fn collect_var_names(bindings: &[&DataBinding]) -> Vec<String> {
    bindings
        .iter()
        .flat_map(|b| b.mappings.iter())
        .map(|m| match m {
            Mapping::Column { var, .. } | Mapping::Literal { var, .. } => var.clone(),
        })
        .collect()
}

/// Apply mappings to one source row (`{column: value}`) → `{var: value}`.
/// Missing columns yield empty string (defensive; the gate ensures columns
/// exist, but a short/ragged row could still lack a cell).
pub fn apply_mappings(
    mappings: &[Mapping],
    source: &std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    for m in mappings {
        match m {
            Mapping::Column { var, column } => {
                out.insert(var.clone(), source.get(column).cloned().unwrap_or_default());
            }
            Mapping::Literal { var, value } => {
                out.insert(var.clone(), value.clone());
            }
        }
    }
    out
}

impl DataBinding {
    /// Columns this binding reads from the dataset (literals excluded). Used by
    /// the validation gate to confirm every referenced column exists.
    pub fn referenced_columns(&self) -> Vec<&str> {
        self.mappings
            .iter()
            .filter_map(|m| match m {
                Mapping::Column { column, .. } => Some(column.as_str()),
                Mapping::Literal { .. } => None,
            })
            .collect()
    }

    /// Apply mappings to one source row (`{column: value}`) → `{var: value}`.
    /// Missing columns yield an empty string (defensive — the gate ensures
    /// columns exist, but a short/ragged row could still lack a cell).
    pub fn apply(
        &self,
        source: &std::collections::BTreeMap<String, String>,
    ) -> std::collections::BTreeMap<String, String> {
        apply_mappings(&self.mappings, source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn parses_per_vu_with_column_mapping() {
        let json = r#"{
            "dataset_id": "01J",
            "policy": "per_vu",
            "mappings": [{"kind": "column", "var": "username", "column": "email"}]
        }"#;
        let b: DataBinding = serde_json::from_str(json).unwrap();
        assert_eq!(b.policy, BindingPolicy::PerVu);
        assert_eq!(b.referenced_columns(), vec!["email"]);
    }

    #[test]
    fn parses_literal_mapping() {
        let json = r#"{"kind": "literal", "var": "role", "value": "admin"}"#;
        let m: Mapping = serde_json::from_str(json).unwrap();
        assert_eq!(
            m,
            Mapping::Literal {
                var: "role".into(),
                value: "admin".into()
            }
        );
    }

    #[test]
    fn apply_maps_columns_and_literals() {
        let b = DataBinding {
            dataset_id: "d".into(),
            policy: BindingPolicy::PerVu,
            mappings: vec![
                Mapping::Column {
                    var: "u".into(),
                    column: "email".into(),
                },
                Mapping::Literal {
                    var: "role".into(),
                    value: "admin".into(),
                },
            ],
        };
        let mut src = BTreeMap::new();
        src.insert("email".to_string(), "a@x.com".to_string());
        let out = b.apply(&src);
        assert_eq!(out.get("u").map(String::as_str), Some("a@x.com"));
        assert_eq!(out.get("role").map(String::as_str), Some("admin"));
    }

    #[test]
    fn collect_var_names_spans_bindings_and_keeps_duplicates() {
        let a = DataBinding {
            dataset_id: "A".into(),
            policy: BindingPolicy::PerVu,
            mappings: vec![
                Mapping::Column {
                    var: "x".into(),
                    column: "c1".into(),
                },
                Mapping::Literal {
                    var: "role".into(),
                    value: "admin".into(),
                },
            ],
        };
        let b = DataBinding {
            dataset_id: "B".into(),
            policy: BindingPolicy::IterSequential,
            // 'x' duplicates a var from binding A → the gate must catch this.
            mappings: vec![Mapping::Column {
                var: "x".into(),
                column: "c2".into(),
            }],
        };
        let names = collect_var_names(&[&a, &b]);
        assert_eq!(names, vec!["x", "role", "x"]);
        // A HashSet pass detects the cross-binding duplicate.
        let mut seen = std::collections::HashSet::new();
        let dup = names.iter().find(|n| !seen.insert((*n).clone()));
        assert_eq!(dup.map(String::as_str), Some("x"));
    }

    #[test]
    fn unique_policy_parses() {
        // serde accepts it; the run-create gate (Task 4) rejects it.
        let p: BindingPolicy = serde_json::from_str("\"unique\"").unwrap();
        assert_eq!(p, BindingPolicy::Unique);
    }
}
