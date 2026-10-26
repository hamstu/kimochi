fn main() {
    // ScreenCaptureKit's Swift bridge (kimochi-capture) links the system's Swift runtime: let the
    // lab and the tests find it without DYLD_LIBRARY_PATH.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
