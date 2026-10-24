fn main() {
    // `kimochi-ext` (main.rs `ext_ipc_plugin`): the extension windows' commands as a plugin, so
    // capabilities can grant them to Hachidori's loopback origin, which Tauri treats as remote and
    // never lets reach app commands. Its default permission allows them all; which window may
    // call which is checked in the plugin itself (loopback.rs `plugin_command_allowed`).
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "kimochi-ext",
        tauri_build::InlinedPlugin::new()
            .commands(&[
                "ext_relay",
                "ext_relay_listen",
                "ext_relay_bytes",
                "report",
                "anki_connect_relay",
                "ext_migration_begin",
                "ext_migration_put",
                "ext_migration_exported",
                "ext_migration_manifest",
                "ext_migration_get",
                "ext_migration_done",
                "ext_migration_failed",
            ])
            .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
    ))
    .expect("tauri-build failed");
    // The upstream Swift bridge assumes XcodeDefault.xctoolchain. CLT puts
    // compatibility archives beside its own swiftc instead. Discover, don't
    // change xcode-select globally or depend on an unaccepted Xcode license.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // Swift-backed crates link `@rpath/libswift_*.dylib`, which lives in the OS at
        // /usr/lib/swift. Without this rpath a bare `cargo run` / `tauri dev` binary fails
        // at launch with "Library not loaded: @rpath/libswift_Concurrency.dylib".
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
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
