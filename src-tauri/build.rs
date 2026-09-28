fn main() {
    tauri_build::build();
    // The upstream Swift bridge assumes XcodeDefault.xctoolchain. CLT puts
    // compatibility archives beside its own swiftc instead. Discover, don't
    // change xcode-select globally or depend on an unaccepted Xcode license.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        if let Ok(out) = std::process::Command::new("xcrun")
            .args(["--find", "swiftc"])
            .output()
        {
            if out.status.success() {
                let path = std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
                if let Some(usr) = path.parent().and_then(|p| p.parent()) {
                    let lib = usr.join("lib/swift/macosx");
                    if lib.is_dir() {
                        println!("cargo:rustc-link-search=native={}", lib.display());
                    }
                }
            }
        }
    }
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
}
