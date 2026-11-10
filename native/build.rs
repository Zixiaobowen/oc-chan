fn main() {
    assert_eq!(std::env::var("CARGO_CFG_TARGET_OS").unwrap(), "macos", "oc-native-bridge requires macOS");
    let mut build = cc::Build::new();
    build.cpp(true).file("oc_native.mm")
        .flag("-std=c++17").flag("-fobjc-arc").flag("-fobjc-weak")
        .flag("-mmacosx-version-min=13.0");
    let compiler = build.get_compiler();
    build.compile("oc_native");

    // @available emits __isPlatformVersionAtLeast. rustc suppresses the C
    // driver's default libraries, so explicitly link this compiler's runtime.
    // A weak copy in Rust std can satisfy debug links but is not a native ABI
    // dependency we can rely on surviving release LTO.
    let output = compiler.to_command()
        .arg("--print-file-name=libclang_rt.osx.a")
        .output().expect("failed to query the native compiler runtime");
    assert!(output.status.success(), "native compiler runtime query failed: {}",
        String::from_utf8_lossy(&output.stderr));
    let runtime = String::from_utf8(output.stdout)
        .expect("native compiler runtime path is not UTF-8");
    let runtime = std::path::Path::new(runtime.trim());
    assert!(runtime.is_absolute() && runtime.is_file(),
        "native compiler did not resolve libclang_rt.osx.a: {}", runtime.display());
    println!("cargo:rustc-link-search=native={}", runtime.parent().unwrap().display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
    println!("cargo:rerun-if-changed={}", runtime.display());
    for framework in ["AppKit", "ApplicationServices", "Foundation", "IOKit", "ServiceManagement", "UserNotifications", "Carbon"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    for source in ["oc_native.mm", "oc_native.h", "oc_notifications.inc", "oc_exports.inc"] {
        println!("cargo:rerun-if-changed={source}");
    }
}
