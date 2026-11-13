// Where cargo puts a crate's build output, for the stagers that copy built helpers into
// src-tauri/resources (scripts/prepare-*.mjs): `<crate>/target`, or `CARGO_TARGET_DIR` when it is
// set (a relative value is relative to the directory cargo runs in, which for the stagers is this
// process's own).
import path from 'node:path'

/** The target directory for the crate in `crateDir`. */
export function cargoTargetDir(crateDir, env = process.env, cwd = process.cwd()) {
  const dir = env.CARGO_TARGET_DIR
  return dir ? path.resolve(cwd, dir) : path.join(crateDir, 'target')
}
