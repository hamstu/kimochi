{
  description = "Kimochi Linux application and development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, rust-overlay, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      perSystem = system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };
          inherit (pkgs) lib;
          x64 = system == "x86_64-linux";
          rust = pkgs.rust-bin.stable.latest.default.override {
            targets = lib.optionals x64 [
              "x86_64-pc-windows-gnu"
              "i686-pc-windows-gnu"
            ];
          };
          # Expose cross tools without sourcing their stdenv hooks into the native
          # shell (which would replace CC and mix Windows and Linux linker flags).
          mingw = pkgs.buildEnv {
            name = "kimochi-mingw-tools";
            paths = [
              pkgs.pkgsCross.mingwW64.stdenv.cc
              pkgs.pkgsCross.mingw32.stdenv.cc
            ];
            pathsToLink = [ "/bin" ];
          };
          buildLibraries = with pkgs; [
            gtk3 webkitgtk_4_1 libsoup_3 openssl libayatana-appindicator
            librsvg xdotool pipewire udev wayland libavif
          ];
          libraries = buildLibraries ++ (with pkgs; [
            gtk-layer-shell stdenv.cc.cc.lib
            gst_all_1.gstreamer gst_all_1.gst-plugins-base
            gst_all_1.gst-plugins-good gst_all_1.gst-plugins-bad
            gst_all_1.gst-libav
          ]);
          windowsRustFlags = lib.optionalAttrs x64 {
            CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS = "-L native=${pkgs.pkgsCross.mingwW64.windows.pthreads}/lib";
            CARGO_TARGET_I686_PC_WINDOWS_GNU_RUSTFLAGS = lib.concatStringsSep " " [
              "-L native=${pkgs.pkgsCross.mingw32.windows.pthreads}/lib"
              "-L native=${pkgs.pkgsCross.mingw32.windows.mcfgthreads}/lib"
              "-C link-arg=-l:libmcfgthread.a"
              "-C link-arg=-l:libssp.a"
              "-C link-arg=-lmingwex"
              "-C link-arg=-lmsvcrt"
              "-C link-arg=-lkernel32"
              "-C link-arg=-lntdll"
              "-C link-arg=-ladvapi32"
            ];
          };
          shell = pkgs.mkShell ({
            packages = with pkgs; [
              rust nodejs_22 pkg-config cmake gnumake perl rustPlatform.bindgenHook
              git curl wget file patchelf unzip zip
            ] ++ lib.optionals x64 [ mingw ];
            buildInputs = buildLibraries;
            LIBCLANG_PATH = "${pkgs.libclang.lib}/lib";
            # GTK layer shell and downloaded OCR libraries are opened with dlopen.
            LD_LIBRARY_PATH = lib.makeLibraryPath libraries;
            GST_PLUGIN_SYSTEM_PATH_1_0 = lib.makeSearchPath "lib/gstreamer-1.0" (map lib.getLib (with pkgs.gst_all_1; [
              gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav
            ]));
            shellHook = ''
              export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:''${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
              export LD_LIBRARY_PATH="${lib.makeLibraryPath libraries}:''${LD_LIBRARY_PATH:-}"
            '';
          } // windowsRustFlags);
          package = import ./nix/package.nix {
            inherit pkgs rust mingw windowsRustFlags buildLibraries libraries;
            src = lib.cleanSourceWith {
              src = self;
              filter = path: type:
                lib.cleanSourceFilter path type
                && !(builtins.elem (builtins.baseNameOf path) [
                  "node_modules" "target" "dist" ".agents" ".aws" ".codex" ".claude"
                ])
                && !(lib.hasPrefix ".env" (builtins.baseNameOf path))
                && !(builtins.elem (lib.removePrefix "${self}/" path) [
                  "flake.nix" "flake.lock" "nix" "README.md"
                  "extensions/yomitan" "extensions/hachidori" "extensions/tenten"
                  "src-tauri/resources/meikiocr" "src-tauri/resources/mangaocr"
                  "src-tauri/resources/screenai" "src-tauri/resources/hookd"
                ]);
            };
          };
          resourcesCheck = pkgs.runCommand "kimochi-resource-discovery" {
            nativeBuildInputs = [ pkgs.xvfb-run pkgs.dbus pkgs.python3 ];
          } ''
            export GDK_BACKEND=x11
            # WebKit's nested namespace sandbox cannot run in the Nix build sandbox.
            # This setting applies only to this isolated GUI test.
            export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
            xvfb-run -a dbus-run-session --config-file=${pkgs.dbus}/share/dbus-1/session.conf -- ${pkgs.bash}/bin/bash \
              ${./nix/check-resources.sh} ${package}
            touch "$out"
          '';
        in { inherit shell package resourcesCheck; };
    in {
      devShells = forAllSystems (system: { default = (perSystem system).shell; });
      packages = forAllSystems (system: rec {
        kimochi = (perSystem system).package;
        default = kimochi;
      });
      checks = forAllSystems (system: {
        package = self.packages.${system}.kimochi;
        resources = (perSystem system).resourcesCheck;
      });
      apps = forAllSystems (system: {
        default = {
          type = "app";
          meta.description = "Run Kimochi";
          program = "${(perSystem system).package}/bin/kimochi";
        };
      });
    };
}
