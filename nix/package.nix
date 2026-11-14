{ pkgs, src, rust, mingw, windowsRustFlags, buildLibraries, libraries }:
let
  inherit (pkgs) lib;
  version = (builtins.fromTOML (builtins.readFile ../src-tauri/Cargo.toml)).package.version;
  rustPlatform = pkgs.makeRustPlatform { cargo = rust; rustc = rust; };
  x64 = pkgs.stdenv.hostPlatform.isx86_64;
  resourceName = (builtins.fromJSON (builtins.readFile ../src-tauri/tauri.conf.json)).productName;
  ocrSources = {
    meikiocr = pkgs.fetchFromGitHub {
      owner = "hamstu";
      repo = "kimochi-meikiocr";
      rev = "7a1b9a762acbdf6b09d7386b4395c366f135733b";
      hash = "sha256-9UrrJtPSbMSyc/irBw5RYIcVBpuW4XjBSrXWSXpLZsI=";
    };
    mangaocr = pkgs.fetchFromGitHub {
      owner = "hamstu";
      repo = "kimochi-mangaocr";
      rev = "6a5dec4fd59977ca70a76255ca1ff4633aa790bd";
      hash = "sha256-TYDUTuG9Nh6v5ryco5X6TT9SBnJBXBPVxywqsUps8ks=";
    };
  };
  frontend = pkgs.buildNpmPackage {
    pname = "kimochi-frontend";
    inherit version src;
    nodejs = pkgs.nodejs_22;
    npmDepsHash = "sha256-INLBxoRwHPdUfTQSrxZoN7mY/7IMB9JVY+njIW+IBoQ=";
    npmFlags = [ "--ignore-scripts" ];
    preBuild = "node scripts/prepare.mjs";
    npmBuildScript = "build:frontend";
    installPhase = ''
      runHook preInstall
      cp -r dist "$out"
      runHook postInstall
    '';
  };
  screenai = rustPlatform.buildRustPackage {
    pname = "kimochi-screenai-worker";
    inherit version src;
    cargoRoot = "screenai";
    buildAndTestSubdir = "screenai";
    cargoLock.lockFile = ../screenai/Cargo.lock;
    buildFeatures = [ "worker" ];
    doCheck = false;
  };
  # These are Windows programs used inside the game's existing Wine/Proton prefix.
  # Build them separately so the main application's dependencies stay native.
  windowsHelpers = crate: rustPlatform.buildRustPackage ({
    pname = "kimochi-${crate}-windows";
    inherit version src;
    cargoRoot = crate;
    cargoLock.lockFile = ../. + "/${crate}/Cargo.lock";
    nativeBuildInputs = [ mingw ];
    dontFixup = true;
    doCheck = false;
    buildPhase = ''
      runHook preBuild
      export CARGO_TARGET_DIR="$PWD/target"
      for target in x86_64-pc-windows-gnu i686-pc-windows-gnu; do
        cargo build --offline --locked --release -j "$NIX_BUILD_CORES" \
          --manifest-path ${crate}/Cargo.toml --target "$target" ${lib.optionalString (crate == "voicehook") "-p vh-hook"}
      done
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      ${if crate == "hookd" then ''
        cp target/x86_64-pc-windows-gnu/release/kimochi-hookd.exe "$out/kimochi-hookd-x64.exe"
        cp target/i686-pc-windows-gnu/release/kimochi-hookd.exe "$out/kimochi-hookd-x86.exe"
      '' else ''
        cp target/x86_64-pc-windows-gnu/release/vhhook.dll "$out/kimochi-voicehook-x64.dll"
        cp target/i686-pc-windows-gnu/release/vhhook.dll "$out/kimochi-voicehook-x86.dll"
      ''}
      runHook postInstall
    '';
  } // windowsRustFlags);
  hookd = windowsHelpers "hookd";
  voicehook = windowsHelpers "voicehook";
  # Use the same upstream ONNX Runtime version and checksums as the staging script.
  ortArchive = pkgs.fetchurl {
    url = "https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/onnxruntime-linux-${if x64 then "x64" else "aarch64"}-1.22.0.tgz";
    sha256 = if x64
      then "8344d55f93d5bc5021ce342db50f62079daf39aaafb5d311a451846228be49b3"
      else "bb76395092d150b52c7092dc6b8f2fe4d80f0f3bf0416d2f269193e347e24702";
  };
in
rustPlatform.buildRustPackage {
  pname = "kimochi";
  inherit version src;
  cargoRoot = "src-tauri";
  buildAndTestSubdir = "src-tauri";
  cargoLock = {
    lockFile = ../src-tauri/Cargo.lock;
    outputHashes = {
      "meikiocr-0.1.0" = "sha256-9UrrJtPSbMSyc/irBw5RYIcVBpuW4XjBSrXWSXpLZsI=";
      "mangaocr-0.1.0" = "sha256-TYDUTuG9Nh6v5ryco5X6TT9SBnJBXBPVxywqsUps8ks=";
      "ppocr-0.1.0" = "sha256-c0BGWoq6FNySpMnkmMjc1Yx/j0+amKS4/7CtC6HAd4s=";
    };
  };
  nativeBuildInputs = with pkgs; [
    pkg-config cmake perl python3 wrapGAppsHook3 autoPatchelfHook makeWrapper
    rustPlatform.bindgenHook
  ];
  buildInputs = buildLibraries ++ [ pkgs.stdenv.cc.cc.lib ];
  LIBCLANG_PATH = "${pkgs.libclang.lib}/lib";
  buildFeatures = [ "custom-protocol" ];
  # GUI and capture tests need a desktop session; the frontend verifies its assets
  # in its own build, and the installed binary has a headless AVIF smoke test.
  doCheck = false;
  preBuild = ''
    cp -r ${frontend} dist
    chmod -R u+w dist
    mkdir -p src-tauri/resources/{meikiocr/runtime,mangaocr,screenai,hookd,silero-vad}
    cp ${ocrSources.meikiocr}/{LICENSE,NOTICE} src-tauri/resources/meikiocr/
    cp ${ocrSources.mangaocr}/{LICENSE,LICENSE-APACHE,NOTICE} src-tauri/resources/mangaocr/
    cp ${ocrSources.mangaocr}/scripts/model-manifest.json src-tauri/resources/mangaocr/
    tar -xzf ${ortArchive} --strip-components=2 --wildcards \
      -C src-tauri/resources/meikiocr/runtime '*/lib/libonnxruntime.so*'
    tar -xzf ${ortArchive} --strip-components=1 --wildcards \
      -C src-tauri/resources/meikiocr/runtime '*/LICENSE' '*/ThirdPartyNotices.txt'
    cp ${screenai}/bin/kimochi-screenai-worker src-tauri/resources/screenai/
    ${lib.optionalString x64 ''
      cp ${hookd}/* ${voicehook}/* src-tauri/resources/hookd/
    ''}
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin" "$out/lib/${resourceName}/licenses"
    cp target/${pkgs.stdenv.hostPlatform.rust.rustcTarget}/release/kimochi "$out/bin/"
    cp -r src-tauri/resources/{meikiocr,mangaocr,screenai,hookd,silero-vad} "$out/lib/${resourceName}/"
    cp -r browser-extension/extension "$out/lib/${resourceName}/browser-extension"
    cp LICENSE LICENSE-APACHE LICENSE-OFL.txt NOTICE "$out/lib/${resourceName}/licenses/"
    install -Dm644 src-tauri/linux/kimochi-screencast.desktop "$out/share/applications/kimochi-screencast.desktop"
    substituteInPlace "$out/share/applications/kimochi-screencast.desktop" \
      --replace-fail /usr/bin/kimochi "$out/bin/kimochi"
    for size in 32 64 128 320 512; do
      install -Dm644 "src-tauri/icons/''${size}x''${size}.png" \
        "$out/share/icons/hicolor/''${size}x''${size}/apps/kimochi.png"
    done
    install -Dm644 ${pkgs.makeDesktopItem {
      name = "kimochi";
      desktopName = "Kimochi";
      comment = "Read visual novels with OCR and pop-up dictionaries";
      exec = "kimochi %u";
      icon = "kimochi";
      categories = [ "Education" "Languages" ];
      mimeTypes = [ "x-scheme-handler/kimochi" ];
    }}/share/applications/kimochi.desktop "$out/share/applications/kimochi.desktop"
    runHook postInstall
  '';
  preFixup = ''
    gappsWrapperArgs+=(
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath libraries}
      --prefix GST_PLUGIN_SYSTEM_PATH_1_0 : ${lib.makeSearchPath "lib/gstreamer-1.0" (map lib.getLib (with pkgs.gst_all_1; [
        gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav
      ]))}
    )
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/kimochi" --check-avif src-tauri/src/platform/linux/testdata/sample.avif
    test -x "$out/lib/${resourceName}/screenai/kimochi-screenai-worker"
    test -f "$out/lib/${resourceName}/meikiocr/runtime/libonnxruntime.so.1.22.0"
    test -f "$out/lib/${resourceName}/meikiocr/runtime/LICENSE"
    test -f "$out/lib/${resourceName}/meikiocr/runtime/ThirdPartyNotices.txt"
    python3 - "$out/lib/${resourceName}/meikiocr/runtime/libonnxruntime.so" <<'PY'
    import ctypes
    import sys
    runtime = ctypes.CDLL(sys.argv[1])
    runtime.OrtGetApiBase.restype = ctypes.c_void_p
    assert runtime.OrtGetApiBase()
    PY
    ${lib.optionalString x64 ''
      test -f "$out/lib/${resourceName}/hookd/kimochi-hookd-x64.exe"
      test -f "$out/lib/${resourceName}/hookd/kimochi-hookd-x86.exe"
      test -f "$out/lib/${resourceName}/hookd/kimochi-voicehook-x64.dll"
      test -f "$out/lib/${resourceName}/hookd/kimochi-voicehook-x86.dll"
    ''}
    runHook postInstallCheck
  '';
  passthru = { inherit frontend screenai; } // lib.optionalAttrs x64 {
    inherit hookd voicehook;
  };
  meta = {
    description = "On-screen OCR, pop-up dictionaries and a reading log for visual novels";
    homepage = "https://github.com/hamstu/kimochi";
    license = lib.licenses.gpl3Only;
    platforms = [ "x86_64-linux" "aarch64-linux" ];
    mainProgram = "kimochi";
  };
}
