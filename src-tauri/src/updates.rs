//! Presentation contract for Sparkle's delegate/KVO observations. Sparkle owns
//! update selection, downloading, installation and automatic-check preferences.
use oc_core::error::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatePhase {
    Idle, Checking, NoUpdate, Available, Downloading, Downloaded, Extracting,
    ReadyToInstall, Installing, AwaitingQuit, Cancelled, Error,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSnapshot {
    pub current_version: String,
    pub available_version: Option<String>,
    pub phase: UpdatePhase,
    pub error: Option<String>,
    pub can_check: bool,
    pub automatic_checks: bool,
    pub probe_only: bool,
    pub session_in_progress: bool,
    pub checked_at: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutomaticChecks { pub enabled: bool }

pub fn decode(value: Value) -> Result<UpdateSnapshot> {
    let state: UpdateSnapshot = serde_json::from_value(value).map_err(|_| Error::invalid("Sparkle snapshot schema"))?;
    if state.current_version.is_empty() || state.current_version.len() > 256
        || state.available_version.as_ref().is_some_and(|v| v.is_empty() || v.len() > 256)
        || state.error.as_ref().is_some_and(|v| v.is_empty() || v.len() > 8192)
        || state.checked_at.as_ref().is_some_and(|v| v.is_empty() || v.len() > 128)
        || (state.phase == UpdatePhase::Error && state.error.is_none())
        || (state.probe_only && (state.automatic_checks || (state.session_in_progress && state.can_check))) {
        return Err(Error::invalid("Sparkle snapshot values"));
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn snapshot() -> Value { json!({"currentVersion":"0.1.0", "availableVersion":null,
        "phase":"idle", "error":null, "canCheck":true, "automaticChecks":false,
        "probeOnly":true, "sessionInProgress":false, "checkedAt":null}) }
    #[test]
    fn sparkle_snapshots_preserve_observed_availability_and_errors() {
        let mut value = snapshot();
        value["phase"] = json!("available"); value["availableVersion"] = json!("0.2.0");
        assert_eq!(decode(value.clone()).unwrap().available_version.as_deref(), Some("0.2.0"));
        value["phase"] = json!("error"); value["error"] = json!("The appcast signature is invalid (SUSparkleErrorDomain:3001)");
        let state = decode(value).unwrap(); assert_eq!(state.phase, UpdatePhase::Error);
        assert!(state.error.unwrap().contains("signature is invalid"));
        let mut no_update = snapshot(); no_update["phase"] = json!("no-update");
        assert_eq!(decode(no_update).unwrap().phase, UpdatePhase::NoUpdate);
    }
    #[test]
    fn sparkle_boundary_rejects_unknown_legacy_and_inconsistent_states() {
        for patch in [json!({"phase":"disabled"}), json!({"disabledReason":"unsigned"}),
            json!({"phase":"error"}), json!({"automaticChecks":true}),
            json!({"sessionInProgress":true}), json!({"canCheck":"yes"}),
            json!({"availableVersion":""})] {
            let mut value = snapshot(); value.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            assert!(decode(value).is_err());
        }
        let mut production = snapshot(); production["probeOnly"] = json!(false);
        production["automaticChecks"] = json!(true); production["sessionInProgress"] = json!(true);
        assert!(decode(production).is_ok()); // Sparkle may resume a standard UI session.
    }
    #[test]
    fn automatic_checks_accepts_only_explicit_boolean_preference() {
        assert!(serde_json::from_value::<AutomaticChecks>(json!({"enabled":false})).is_ok());
        for value in [json!({}), json!({"enabled":1}), json!({"enabled":true,"feed":"http://attacker"})] {
            assert!(serde_json::from_value::<AutomaticChecks>(value).is_err());
        }
    }
}
