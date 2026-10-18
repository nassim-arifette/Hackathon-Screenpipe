#!/usr/bin/env bash
# Engine for the harness: upstream screenpipe at the pinned commit plus
# patches/harness.patch, built (dev profile) into .engines/target.
#
# `setup-engine.sh <variant>` builds a changed engine instead: a worktree
# .engines/wf-<variant> with patches/harness.patch and patches/variants/<variant>.patch
# applied, built into .engines/target-wf-<variant>, the paths variants/<variant>.json
# names. Same files on every Mac, so run.json records the same engine changes.
# On Linux, run ./setup-linux.sh once first.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
commit=a8aaee2d6348aa1a0578981098fe97c2ec46d32a
src=$here/.engines/upstream
if [ ! -d "$src/.git" ]; then
  git clone --filter=blob:none https://github.com/screenpipe/screenpipe.git "$src"
fi
if [ -z "$(git -C "$src" status --porcelain)" ]; then
  git -C "$src" fetch --quiet origin "$commit" 2>/dev/null || true
  git -C "$src" checkout --quiet "$commit"
  git -C "$src" apply "$here/patches/harness.patch"
else
  echo "$src already has changes (patched earlier?); building it as it is" >&2
fi
target=$here/.engines/target
if [ -n "${1:-}" ]; then
  variant=$1
  patch=$here/patches/variants/$variant.patch
  [ -f "$patch" ] || { echo "no $patch" >&2; exit 1; }
  wt=$here/.engines/wf-$variant
  if [ ! -d "$wt" ]; then
    git -C "$src" worktree add --quiet --detach "$wt" "$commit"
    git -C "$wt" apply "$here/patches/harness.patch"
    git -C "$wt" apply "$patch"
  else
    echo "$wt exists; building it as it is" >&2
  fi
  target=$here/.engines/target-wf-$variant
  # Start from the baseline build when there is one: only the changed crates rebuild.
  if [ ! -d "$target" ] && [ -d "$here/.engines/target" ]; then
    /bin/cp -cR "$here/.engines/target" "$target" 2>/dev/null || cp -R "$here/.engines/target" "$target"
  fi
  src=$wt
fi
cd "$src"
features=()
if [ "$(uname -s)" = Darwin ]; then
  features=(--features metal)
else
  # Linux: the system OpenBLAS, laid out the way screenpipe's release-cli.yml does (setup-linux.sh).
  export OPENBLAS_PATH=${OPENBLAS_PATH:-/usr/lib/$(gcc -print-multiarch)/openblas}
  # ort's prebuilt onnxruntime calls glibc 2.38's __isoc23_strto*; on older glibc
  # (Ubuntu 22.04) link forwarders to the classic functions.
  if [ "$(printf '%s\n' "$(ldd --version | head -1 | grep -oE '[0-9]+\.[0-9]+$')" 2.38 | sort -V | head -1)" != 2.38 ]; then
    compat=$here/.engines/glibc-compat
    mkdir -p "$compat"
    printf '%s\n' '#include <stdlib.h>' \
      'long __isoc23_strtol(const char *s, char **e, int b) { return strtol(s, e, b); }' \
      'long long __isoc23_strtoll(const char *s, char **e, int b) { return strtoll(s, e, b); }' \
      'unsigned long __isoc23_strtoul(const char *s, char **e, int b) { return strtoul(s, e, b); }' \
      'unsigned long long __isoc23_strtoull(const char *s, char **e, int b) { return strtoull(s, e, b); }' \
      > "$compat/isoc23.c"
    cc -O2 -fPIC -c "$compat/isoc23.c" -o "$compat/isoc23.o"
    printf '#!/bin/sh\nexec cc "$@" %s\n' "$compat/isoc23.o" > "$compat/cc"
    chmod +x "$compat/cc"
    triple=$(uname -m | tr a-z A-Z)_UNKNOWN_LINUX_GNU
    export "CARGO_TARGET_${triple}_LINKER=$compat/cc"
  fi
fi
CARGO_TARGET_DIR=$target cargo build -p screenpipe-engine --bin screenpipe "${features[@]}"
echo "engine: $target/debug/screenpipe"
