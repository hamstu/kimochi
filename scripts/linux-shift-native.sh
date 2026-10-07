#!/bin/bash
# Optional diagnostic; requires Wayland/xkbcommon dev files and protocol XMLs.
# Usage: bash scripts/linux-shift-native.sh PROTOCOL_DIR EXTERNAL_BUILD_DIR \
#        42 X1 Y1 X2 Y2 X3 Y3 ROOT_LOGICAL_WIDTH HEIGHT
set -euo pipefail
if [ "$#" -ne 11 ]; then
  echo "Usage: $0 PROTOCOL_DIR EXTERNAL_BUILD_DIR KEY(42|54) X1 Y1 X2 Y2 X3 Y3 ROOT_LOGICAL_WIDTH HEIGHT" >&2
  exit 2
fi
protocol_dir=$1
probe_build=$2
shift 2
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p -- "$probe_build"
wayland-scanner client-header "$protocol_dir/virtual-keyboard-unstable-v1.xml" "$probe_build/virtual-keyboard.h"
wayland-scanner private-code "$protocol_dir/virtual-keyboard-unstable-v1.xml" "$probe_build/virtual-keyboard-protocol.c"
wayland-scanner client-header "$protocol_dir/wlr-virtual-pointer-unstable-v1.xml" "$probe_build/virtual-pointer.h"
wayland-scanner private-code "$protocol_dir/wlr-virtual-pointer-unstable-v1.xml" "$probe_build/virtual-pointer-protocol.c"
# pkg-config intentionally emits compiler arguments, not file data or secrets.
cc -Wall -Wextra "$script_dir/linux-shift-native.c" -I"$probe_build" \
  "$probe_build/virtual-keyboard-protocol.c" "$probe_build/virtual-pointer-protocol.c" \
  -o "$probe_build/linux-shift-native" $(pkg-config --cflags --libs wayland-client xkbcommon)
exec "$probe_build/linux-shift-native" "$@"
