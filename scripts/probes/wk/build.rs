fn main() {
    assert_eq!(std::env::var("CARGO_CFG_TARGET_OS").unwrap(), "macos");
    cc::Build::new().file("../../../src-tauri/acceptance/wk-driver.mm")
        .cpp(true).flag("-std=c++17").flag("-fobjc-arc").compile("wk_driver");
    for framework in ["AppKit", "WebKit"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rerun-if-changed=../../../src-tauri/acceptance/wk-driver.mm");
    tauri_build::build();
}
