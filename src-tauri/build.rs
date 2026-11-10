use std::{env, fs, path::PathBuf, sync::LazyLock};
use sha2::{Digest, Sha256};
include!("src/commands.rs");
static COMMAND_NAMES: LazyLock<Vec<&'static str>> = LazyLock::new(|| COMMANDS.iter().map(|(name, _)| *name).collect());
static CAPABILITY_PATTERN: LazyLock<String> = LazyLock::new(|| format!("{}/capabilities/*.json", env::var("OUT_DIR").expect("build output directory")));

fn main() {
    println!("cargo:rerun-if-changed=src/commands.rs");
    println!("cargo:rerun-if-env-changed=OC_CHAN_RESOURCE_DIR");
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let resources = env::var_os("OC_CHAN_RESOURCE_DIR").map(PathBuf::from).unwrap_or_else(|| manifest.join("../out/host-resources"));
    let catalog = resources.join("plugin-market/catalog.json");
    println!("cargo:rerun-if-changed={}", catalog.display());
    let metadata = fs::symlink_metadata(&catalog).expect("build the bundled plugin catalog first");
    assert!(metadata.is_file() && metadata.len() <= 256 * 1024, "invalid bundled catalog");
    let bytes = fs::read(&catalog).expect("read bundled catalog");
    assert!(bytes.len() <= 256 * 1024, "bundled catalog changed beyond budget");
    let digest = format!("{:x}", Sha256::digest(bytes));
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("build output directory"));
    fs::write(out.join("catalog.rs"), format!("#[used]\npub static CATALOG_MARKER: &str = \"OC_CHAN_CATALOG_SHA256={digest}\";\n")).expect("write pinned catalog marker");

    let capabilities = out.join("capabilities");
    fs::create_dir_all(&capabilities).expect("create capability directory");
    for (view, mask) in [("main", 1), ("tray", 2), ("recovery", 4)] {
        let mut permissions: Vec<String> = COMMANDS.iter().filter(|(_, windows)| windows & mask != 0)
            .map(|(name, _)| format!("allow-{}", name.replace('_', "-"))).collect();
        if view != "recovery" { permissions.extend(["core:event:allow-listen".into(), "core:event:allow-unlisten".into()]); }
        let capability = serde_json::json!({"identifier":view,"description":format!("OC Chan {view} local document"),"local":true,"windows":[view],"permissions":permissions});
        fs::write(capabilities.join(format!("{view}.json")), serde_json::to_vec(&capability).expect("serialize capability")).expect("write capability");
    }
    tauri_build::try_build(tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&COMMAND_NAMES))
        .capabilities_path_pattern(&CAPABILITY_PATTERN)).expect("Tauri application capabilities");

    if env::var_os("CARGO_FEATURE_ACCEPTANCE").is_some() {
        println!("cargo:rerun-if-changed=acceptance/wk-driver.mm");
        cc::Build::new().cpp(true).file("acceptance/wk-driver.mm").flag("-fobjc-arc")
            .flag("-std=c++17").flag("-mmacosx-version-min=13.0").compile("oc_wk_acceptance");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=WebKit");
    }
}
