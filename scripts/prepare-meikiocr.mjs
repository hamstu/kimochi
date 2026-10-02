/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Build-time JavaScript. */
// Stage self-contained native assets. Nothing here runs on an end user's machine.
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, "src-tauri/resources/meikiocr");
const version =
  process.platform === "darwin" && (process.env.MEIKIOCR_ARCH ?? process.arch) === "arm64"
    ? "1.30.0"
    : "1.22.0";
const packagingVersion = 2;
const models = [
  [
    "rtr46/meiki.text.detect.v0",
    "a9cffa4f60cbf72ddb87edf19c6f98a01cd042e6",
    "meiki.text.detect.v0.1.960x544.onnx",
  ],
  [
    "rtr46/meiki.txt.recognition.v0",
    "a28cf5874dc2438ebb1c86336be26bcec51e3375",
    "meiki.text.rec.v0.960x32.onnx",
  ],
  [
    "rtr46/meiki.txt.recognition.v0",
    "a28cf5874dc2438ebb1c86336be26bcec51e3375",
    "meiki.text.rec.v0.vertical.32x480.onnx",
  ],
];
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok)
    throw new Error(`MeikiOCR download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(path.join(destination, "models"), { recursive: true });
for (const [repo, revision, name] of models) {
  const metadata = JSON.parse(
    await get(
      `https://huggingface.co/api/models/${repo}/revision/${revision}?blobs=true`,
    ),
  );
  const expected = metadata.siblings.find((s) => s.rfilename === name)?.lfs
    ?.sha256;
  if (!expected) throw new Error(`Missing model SHA-256: ${name}`);
  const target = path.join(destination, "models", name);
  const existing = await readFile(target).catch(() => null);
  if (existing && sha(existing) === expected) continue;
  const bytes = await get(
    `https://huggingface.co/${repo}/resolve/${revision}/${name}`,
  );
  if (sha(bytes) !== expected)
    throw new Error(`Model checksum mismatch: ${name}`);
  await writeFile(`${target}.tmp`, bytes);
  const { rename } = await import("node:fs/promises");
  await rename(`${target}.tmp`, target);
}
const runtime = path.join(destination, "runtime");
const override = process.env.MEIKIOCR_RUNTIME_DIR;
const arch = process.env.MEIKIOCR_ARCH ?? process.arch;
const platform = process.platform;
const flavor =
  process.env.MEIKIOCR_RUNTIME_FLAVOR ??
  (platform === "win32" ? "directml" : "cpu");
const marker = JSON.stringify({
  packagingVersion,
  version,
  platform,
  arch,
  flavor,
  override: override ?? null,
});
if (
  (await readFile(path.join(runtime, "build.json"), "utf8").catch(() => "")) !==
  marker
) {
  const stage = await mkdtemp(path.join(tmpdir(), "kimochi-meikiocr-"));
  try {
    const install = path.join(stage, "install");
    await mkdir(install);
    if (override) {
      await cp(path.resolve(override), install, {
        recursive: true,
        dereference: true,
      });
    } else {
      let archive, nativePath;
      const nativeArch = { arm64: "arm64", x64: "x64" }[arch];
      if (!nativeArch)
        throw new Error(`Unsupported MeikiOCR architecture: ${arch}`);
      if (platform === "darwin") {
        archive = `onnxruntime-osx-${arch === "x64" ? "x86_64" : "arm64"}-${version}.tgz`;
        nativePath = `${archive.replace(".tgz", "")}/lib`;
      } else if (platform === "win32" && flavor === "directml") {
        archive = `Microsoft.ML.OnnxRuntime.DirectML.${version}.nupkg`;
        nativePath = `runtimes/win-${nativeArch}/native`;
      } else if (platform === "win32" || platform === "linux") {
        const os = platform === "win32" ? "win" : "linux";
        const cpuArch =
          platform === "linux" && arch === "arm64" ? "aarch64" : nativeArch;
        if (flavor === "cuda" && arch !== "x64")
          throw new Error("CUDA runtime requires x64");
        archive = `onnxruntime-${os}-${cpuArch}${flavor === "cuda" ? "-gpu" : ""}-${version}.${platform === "win32" ? "zip" : "tgz"}`;
        nativePath = `${archive.replace(/\.(zip|tgz)$/, "")}/lib`;
      } else throw new Error(`Unsupported MeikiOCR platform: ${platform}`);
      const bytes = await get(
        `https://github.com/microsoft/onnxruntime/releases/download/v${version}/${archive}`,
      );
      if (archive === "onnxruntime-osx-arm64-1.30.0.tgz" &&
          sha(bytes) !== "6ebb5062a934537c352937821f9fe9718e7de1a2db1122a93dd363ffd53a7012") {
        throw new Error("ONNX Runtime archive checksum mismatch");
      }
      const archivePath = path.join(stage, archive);
      await writeFile(archivePath, bytes);
      const unpack =
        archive.endsWith(".tgz") || platform === "win32"
          ? spawnSync("tar", ["-xf", archivePath, "-C", stage], {
              stdio: "inherit",
            })
          : spawnSync("unzip", ["-q", archivePath, "-d", stage], {
              stdio: "inherit",
            });
      if (unpack.status !== 0) throw new Error(`Could not extract ${archive}`);
      const source = path.join(stage, nativePath);
      const library =
        platform === "darwin"
          ? "libonnxruntime.dylib"
          : platform === "win32"
            ? "onnxruntime.dll"
            : "libonnxruntime.so";
      for (const name of await readdir(source)) {
        if (
          name === library ||
          /\.dll$/i.test(name) ||
          /providers.*\.so/.test(name)
        ) {
          await cp(path.join(source, name), path.join(install, name), {
            dereference: true,
          });
        }
      }
      // Retain license/notice files from release archives and NuGet packages.
      const releaseRoot = archive.endsWith(".nupkg")
        ? stage
        : path.join(stage, archive.replace(/\.(tgz|zip)$/, ""));
      for (const name of await readdir(releaseRoot)) {
        if (/license|notice|thirdparty/i.test(name))
          await cp(path.join(releaseRoot, name), path.join(install, name));
      }
      await writeFile(
        path.join(install, "archive-sha256.txt"),
        `${sha(bytes)}  ${archive}\n`,
      );
    }
    const library =
      platform === "darwin"
        ? "libonnxruntime.dylib"
        : platform === "win32"
          ? "onnxruntime.dll"
          : "libonnxruntime.so";
    await readFile(path.join(install, library));
    await writeFile(path.join(install, "build.json"), marker);
    await rm(runtime, { recursive: true, force: true });
    await cp(install, runtime, { recursive: true });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
await cp(
  path.join(root, "../kimochi-meikiocr/LICENSE"),
  path.join(destination, "LICENSE"),
);
await cp(
  path.join(root, "../kimochi-meikiocr/NOTICE"),
  path.join(destination, "NOTICE"),
);
console.log(
  `MeikiOCR models and ${platform}/${arch} runtime ready for bundling.`,
);
