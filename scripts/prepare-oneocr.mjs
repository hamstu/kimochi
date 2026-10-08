// Only our tiny native adapter ships. Microsoft's Snipping Tool DLLs/model are
// discovered at runtime or supplied by the user; no Python or network server.
import { spawnSync } from "node:child_process";
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform === "win32") {
  const destination = path.join(root, "src-tauri/resources/oneocr");
  await mkdir(destination, { recursive: true });
  for (const [target, arch] of [
    ["x86_64-pc-windows-msvc", "x64"],
    ["aarch64-pc-windows-msvc", "arm64"],
  ]) {
    const built = spawnSync(
      "cargo",
      [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        path.join(root, "oneocr-worker/Cargo.toml"),
        "--target",
        target,
      ],
      { stdio: "inherit" },
    );
    if (built.error) throw built.error;
    if (built.status !== 0)
      throw new Error(
        `OneOCR ${arch} helper build failed (${built.status}). Install the ${target} Rust target and matching MSVC C++ tools.`,
      );
    await copyFile(
      path.join(
        root,
        `oneocr-worker/target/${target}/release/kimochi-oneocr-worker.exe`,
      ),
      path.join(destination, `kimochi-oneocr-${arch}.exe`),
    );
  }
  console.log(
    "OneOCR x64 and ARM64 helpers staged; uses Snipping Tool files on this computer.",
  );
}
