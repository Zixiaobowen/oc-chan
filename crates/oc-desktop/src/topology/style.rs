use oc_core::settings::{ResolvedTheme,SettingsSnapshot};
/// Native equivalents of src/shared/themes.ts semantic colors.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub(crate) struct Palette {pub bg:u32,pub surface:u32,pub text:u32,pub muted:u32,pub line:u32,pub accent:u32,pub selected:u32,pub warning:u32,pub edge:u32,pub active:u32}
impl Default for Palette{fn default()->Self{Self::named("oc-chan",false)}}
impl Palette{
    pub fn from_settings(snapshot:&SettingsSnapshot)->Self{let dark=snapshot.resolved_theme==ResolvedTheme::Dark;Self::named(if dark{&snapshot.settings.dark_theme}else{&snapshot.settings.light_theme},dark)}
    fn named(name:&str,dark:bool)->Self{
        let [bg,surface,text,muted,line,accent,selected,warning,edge,active]=match(name,dark){
            ("oc-chan",false)=>[0xf8faff,0xffffff,0x1e293b,0x536579,0xdce5f2,0x2563eb,0xeaf1ff,0x866517,0x6c82a3,0x526b8b],
            ("oc-chan",true)=>[0x111827,0x192334,0xe9f1ff,0xa9b8cf,0x30415c,0x8bb8ff,0x243e65,0xddc386,0x8fa7c8,0xb4c8e7],
            ("github",false)=>[0xf6f8fa,0xffffff,0x1f2328,0x525b66,0xd1d9e0,0x0550ae,0xddedff,0x7d4e00,0x59697c,0x1a7f37],
            ("github",true)=>[0x0d1117,0x161b22,0xf0f6fc,0xb1bac4,0x30363d,0x79c0ff,0x1c3552,0xe3b341,0x8b9fb6,0x7ee787],
            ("nord",false)=>[0xeceff4,0xf8fafc,0x2e3440,0x4c566a,0xcbd3df,0x285e70,0xd8e5ec,0x795413,0x596b81,0x4c6a43],
            ("nord",true)=>[0x2e3440,0x343b49,0xeceff4,0xc0cadb,0x485367,0x8fcedb,0x3b4559,0xebcb8b,0xa5b5cd,0xa3be8c],
            ("catppuccin",false)=>[0xeff1f5,0xffffff,0x4c4f69,0x575a72,0xccd0da,0x6c2db0,0xe8e0f4,0x805914,0x6c6f85,0x407627],
            ("catppuccin",true)=>[0x1e1e2e,0x272738,0xcdd6f4,0xbac2de,0x45475a,0xcba6f7,0x393750,0xf9e2af,0xa6adc8,0xa6e3a1],
            ("solarized",false)=>[0xfdf6e3,0xfffbef,0x073642,0x465c63,0xd5d1bd,0x006b83,0xe4e9d5,0x805900,0x5e7478,0x617500],
            ("solarized",true)=>[0x002b36,0x073642,0xeee8d5,0xb3c4bf,0x28515a,0x7dc8ce,0x154753,0xe4bf68,0x93aead,0xa7ba64],
            ("gruvbox",false)=>[0xfbf1c7,0xfff8de,0x3c3836,0x5c5146,0xd5c4a1,0x4e6220,0xeadbab,0x805500,0x726451,0x62722a],
            ("gruvbox",true)=>[0x282828,0x32302f,0xebdbb2,0xd5c4a1,0x504945,0xb8bb26,0x45423a,0xfabd2f,0xbdae93,0xb8bb26],
            _=>unreachable!("SettingsStore validates theme identifiers"),
        };Self{bg,surface,text,muted,line,accent,selected,warning,edge,active}
    }
}
