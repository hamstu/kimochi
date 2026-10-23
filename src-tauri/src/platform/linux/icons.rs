//! Refresh Kimochi's managed user-level icon, including development/AppImage runs.
pub fn refresh() -> Result<(), String> {
    let home = std::env::var_os("HOME").ok_or("HOME unavailable")?;
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(home).join(".local/share"));
    // An explicitly authored user launcher may intentionally use custom branding.
    if std::fs::read_to_string(data.join("applications/Kimochi.desktop"))
        .is_ok_and(|entry| !entry.contains("X-Kimochi-Generated=true")) {
        return Ok(());
    }
    refresh_app_icon(&data)
}

/// The user's hicolor icon overrides packaged icons. Keep our managed copy
/// current even when an installed desktop entry already supplies app identity.
fn refresh_app_icon(data: &std::path::Path) -> Result<(), String> {
    let theme = data.join("icons/hicolor");
    let sizes: &[(&str, &[u8])] = &[
        ("32x32", include_bytes!("../../../icons/32x32.png")),
        ("64x64", include_bytes!("../../../icons/64x64.png")),
        ("128x128", include_bytes!("../../../icons/128x128.png")),
        ("256x256", include_bytes!("../../../icons/128x128@2x.png")),
        ("320x320", include_bytes!("../../../icons/320x320.png")),
        ("512x512", include_bytes!("../../../icons/512x512.png")),
        ("32x32@2", include_bytes!("../../../icons/64x64.png")),
        ("64x64@2", include_bytes!("../../../icons/128x128.png")),
        ("128x128@2", include_bytes!("../../../icons/128x128@2x.png")),
        ("256x256@2", include_bytes!("../../../icons/512x512.png")),
    ];
    let mut changed = false;
    for (size, bytes) in sizes {
        let icon = theme.join(size).join("apps/kimochi.png");
        if std::fs::read(&icon).ok().as_deref() == Some(*bytes) { continue; }
        std::fs::create_dir_all(icon.parent().ok_or("icon directory missing")?)
            .map_err(|e| e.to_string())?;
        let pending = icon.with_extension("png.next");
        std::fs::write(&pending, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(pending, icon).map_err(|e| e.to_string())?;
        changed = true;
    }
    if !changed { return Ok(()); }
    // Optional host utility: invalidate a previously cached hicolor asset. The
    // image still works on desktops without this utility or a theme cache.
    let _ = std::process::Command::new("gtk-update-icon-cache")
        .args(["--force", "--ignore-theme-index"])
        .arg(theme).output();
    Ok(())
}

