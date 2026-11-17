use std::{env, fs, path::PathBuf};
use sha2::{Digest, Sha256};

fn main() {
    // Packaged apps resolve only their embedded framework. Cargo tests use the
    // controlled SDK via DYLD_FRAMEWORK_PATH supplied by the verification runner.
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    println!("cargo:rerun-if-env-changed=OC_CHAN_RESOURCE_DIR");
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let resources = env::var_os("OC_CHAN_RESOURCE_DIR").map(PathBuf::from).unwrap_or_else(|| manifest.join("../../out/host-resources"));
    let catalog = resources.join("plugin-market/catalog.json");
    println!("cargo:rerun-if-changed={}", catalog.display());
    let metadata = fs::symlink_metadata(&catalog).expect("build the bundled plugin catalog first");
    assert!(metadata.is_file() && metadata.len() <= 256 * 1024, "invalid bundled catalog");
    let bytes = fs::read(&catalog).expect("read bundled catalog");
    assert!(bytes.len() <= 256 * 1024, "bundled catalog changed beyond budget");
    let digest = format!("{:x}", Sha256::digest(bytes));
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("build output directory"));
    fs::write(out.join("catalog.rs"), format!("#[used]\npub static CATALOG_MARKER: &str = \"OC_CHAN_CATALOG_SHA256={digest}\";\n")).expect("write pinned catalog marker");
    if env::var_os("CARGO_FEATURE_ACCEPTANCE").is_some() {
        println!("cargo:rerun-if-changed=acceptance/metal-capture.mm");
        cc::Build::new().cpp(true).file("acceptance/metal-capture.mm").flag("-fobjc-arc")
            .flag("-std=c++17").flag("-mmacosx-version-min=13.0").compile("oc_gpui_capture");
        for framework in ["AppKit", "Metal", "QuartzCore"] { println!("cargo:rustc-link-lib=framework={framework}"); }
    }
}
