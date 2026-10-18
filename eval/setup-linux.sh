#!/usr/bin/env bash
# One-time Linux host setup for the harness (Ubuntu/Debian, x86_64 or arm64), the Linux
# counterpart of "an Apple Silicon Mac with the screenpipe app". Needs sudo. Afterwards:
# ./setup-engine.sh, sandbox/load.sh, then the usual template/login/check-engine steps.
#
#   - build deps of screenpipe-engine (the list in screenpipe's release-cli.yml), and
#     PipeWire >= 1.0 headers where the distro ships older ones (libspa 0.9 needs them)
#   - OpenBLAS where screenpipe's build looks for it (OPENBLAS_PATH, setup-engine.sh)
#   - qemu binfmt on x86_64: the published sandbox image is arm64
#   - .engines/app/{bun,ffmpeg}: what the harness takes from screenpipe.app on a Mac, with
#     the bun version the app ships
#   - /Users/Shared/wfeval: the run slots, the same path as on a Mac so the agents' prompts match
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
BUN_VERSION=1.3.10  # screenpipe/apps/screenpipe-app-tauri/scripts/pre_build.js
[ "$(uname -s)" = Linux ] || { echo "Linux only; on a Mac follow README.md" >&2; exit 1; }
command -v apt-get >/dev/null || { echo "needs apt (Ubuntu/Debian); install the same packages by hand" >&2; exit 1; }

sudo apt-get update -qq
sudo apt-get install -y -qq software-properties-common curl unzip
if ! pkg-config --atleast-version=1.0 libpipewire-0.3 2>/dev/null \
   && ! apt-cache policy libpipewire-0.3-dev | grep -qE 'Candidate: (1|[2-9])\.'; then
  sudo add-apt-repository -y ppa:pipewire-debian/pipewire-upstream
  sudo apt-get update -qq
fi
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  pkg-config ffmpeg libavcodec-dev libavformat-dev libavutil-dev libswscale-dev \
  libasound2-dev libdbus-1-dev libxcb1-dev libxcb-render0-dev libxcb-shape0-dev \
  libxcb-xfixes0-dev libtesseract-dev libssl-dev cmake build-essential clang libclang-dev \
  libx11-dev libxi-dev libxext-dev libxtst-dev libxrandr-dev libxinerama-dev libxcursor-dev \
  libxdo-dev libwayland-dev libpipewire-0.3-dev libgbm-dev libegl-dev libopenblas-dev

# antirez-asr-sys links -llibopenblas (double prefix): same symlinks as release-cli.yml.
multiarch=$(gcc -print-multiarch)
sudo mkdir -p "/usr/lib/$multiarch/openblas/lib"
sudo ln -sf "/usr/lib/$multiarch/libopenblas.so" "/usr/lib/$multiarch/openblas/lib/liblibopenblas.so"
sudo ln -sf "/usr/lib/$multiarch/libopenblas.a" "/usr/lib/$multiarch/openblas/lib/liblibopenblas.a"

if [ "$(uname -m)" != aarch64 ]; then
  sudo apt-get install -y -qq qemu-user-static binfmt-support
fi

app=$here/.engines/app
mkdir -p "$app"
if [ "$("$app/bun" --version 2>/dev/null)" != "$BUN_VERSION" ]; then
  case $(uname -m) in
    x86_64) asset=bun-linux-x64 ;;
    aarch64) asset=bun-linux-aarch64 ;;
    *) echo "no bun build for $(uname -m)" >&2; exit 1 ;;
  esac
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$asset.zip"
  unzip -q "$tmp/bun.zip" -d "$tmp"
  install -m 0755 "$tmp/$asset/bun" "$app/bun"
fi
ln -sf "$(command -v ffmpeg)" "$app/ffmpeg"

sudo mkdir -p /Users/Shared/wfeval
sudo chown "$(id -u):$(id -g)" /Users/Shared/wfeval
chmod 700 /Users/Shared/wfeval

command -v uv >/dev/null || echo "note: install uv (https://docs.astral.sh/uv/) and Rust (rustup)" >&2
command -v docker >/dev/null || echo "note: install Docker (the agents' tools run in a container)" >&2
echo "ready: bun $("$app/bun" --version), $("$app/ffmpeg" -version | head -1)"
