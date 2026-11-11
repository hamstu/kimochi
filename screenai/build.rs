fn main() {
    // On Linux the library imports one symbol from its host process (Chrome); the worker defines
    // it (`src/main.rs`) and must export it from its dynamic symbol table for the loader to bind it.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg-bins=-rdynamic");
    }
}
