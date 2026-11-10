use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum View { Main, Tray, Recovery }
impl View {
    pub fn label(self) -> &'static str { match self { Self::Main => "main", Self::Tray => "tray", Self::Recovery => "recovery" } }
    pub fn from_label(label: &str) -> Option<Self> { match label { "main" => Some(Self::Main), "tray" => Some(Self::Tray), "recovery" => Some(Self::Recovery), _ => None } }
    pub fn mask(self) -> u8 { match self { Self::Main => 1, Self::Tray => 2, Self::Recovery => 4 } }
}

include!("commands.rs");

pub fn permits(view: View, command: &str) -> bool {
    COMMANDS.iter().any(|(name, windows)| *name == command && windows & view.mask() != 0)
}
