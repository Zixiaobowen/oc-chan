use super::*;
use serde::Deserialize;

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrayPreferences { pub excluded: Vec<String> }
impl TrayPreferences {
    fn validate(&self) -> Result<()> {
        if self.excluded.len() > 64 { return Err(Error::invalid("tray preference count")); }
        let mut seen = std::collections::BTreeSet::new();
        for id in &self.excluded {
            if id.is_empty() || id.len() > 128 || !id.as_bytes()[0].is_ascii_lowercase()
                || !id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-".contains(&byte))
                || !seen.insert(id) { return Err(Error::invalid("tray preference panel")); }
        }
        Ok(())
    }
    fn bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|error| Error::new("OC_TRAY_PREFERENCES", error.to_string()))?;
        if bytes.len() > 8192 { return Err(Error::limit("tray preferences", 8192, bytes.len())); }
        Ok(bytes)
    }
}
impl Desktop {
    async fn read_tray_preferences(&self) -> Result<TrayPreferences> {
        let file = match self.io.read_file("settings", &self.config.profile.join("tray-panels.json"), 8192, true, &self.io.cancellation()).await {
            Ok(file) => file,
            Err(error) if error.code == "ENOENT" => return Ok(TrayPreferences::default()),
            Err(error) => return Err(error),
        };
        let preferences: TrayPreferences = serde_json::from_slice(&file.bytes).map_err(|error| Error::new("OC_TRAY_PREFERENCES", error.to_string()))?;
        preferences.validate()?;
        Ok(preferences)
    }
    pub(super) async fn tray_preferences_snapshot(&self) -> Result<TrayPreferences> {
        let state = self.tray_preferences.lock().await;
        if let Some(error) = state.as_ref() { return Err(error.clone()); }
        self.read_tray_preferences().await
    }
    pub(super) async fn tray_preferences_save(&self, preferences: TrayPreferences) -> Result<TrayPreferences> {
        let bytes = preferences.bytes()?;
        let mut state = self.tray_preferences.lock().await;
        if let Some(error) = state.as_ref() { return Err(error.clone()); }
        let previous = self.read_tray_preferences().await?.bytes()?;
        let path = self.config.profile.join("tray-panels.json");
        if let Err(error) = self.io.write_atomic("settings", &path, bytes, &self.io.cancellation()).await {
            if error.code == "OC_ATOMIC_COMMIT" {
                if let Err(cleanup) = self.io.write_atomic("settings", &path, previous, &self.io.cancellation()).await {
                    let failure = Error::aggregate(vec![error, cleanup]);
                    *state = Some(failure.clone());
                    return Err(failure);
                }
            }
            return Err(error);
        }
        self.emit("tray-preferences-changed", &preferences)?;
        Ok(preferences)
    }
}
