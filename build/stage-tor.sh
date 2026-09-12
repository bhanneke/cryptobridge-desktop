#!/usr/bin/env bash
# Stage the Tor daemon the installer ships.
#
# The wallet cannot report a balance without it: chain sync goes through a
# SOCKS proxy on 127.0.0.1:9050 and there is deliberately no clearnet
# fallback. So a user without Tor gets no balance, and shipping one is not
# optional.
#
# Uses the Tor Project's "expert bundle", which is the standalone daemon meant
# for exactly this, and verifies it against the checksums the project
# publishes alongside it. A binary that moves someone's privacy is not
# something to download and trust unchecked.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HERE}/../src-tauri/resources/tor"
VERSION="${TOR_BUNDLE_VERSION:-15.0.22}"
BASE="https://archive.torproject.org/tor-package-archive/torbrowser/${VERSION}"

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux)  OS=linux ;;
  *)      echo "unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=aarch64 ;;
  x86_64|amd64)  ARCH=x86_64 ;;
  *)             echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

TARBALL="tor-expert-bundle-${OS}-${ARCH}-${VERSION}.tar.gz"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> downloading ${TARBALL}"
curl -fsSL --max-time 300 -o "${WORK}/${TARBALL}" "${BASE}/${TARBALL}"
curl -fsSL --max-time 120 -o "${WORK}/sha256sums.txt" "${BASE}/sha256sums-unsigned-build.txt"

echo "==> verifying the checksum"
EXPECTED="$(grep " ${TARBALL}\$" "${WORK}/sha256sums.txt" | awk '{print $1}' | head -1)"
if [[ -z "$EXPECTED" ]]; then
  echo "no published checksum for ${TARBALL} -- refusing to ship an unverified binary" >&2
  exit 1
fi
ACTUAL="$(shasum -a 256 "${WORK}/${TARBALL}" | awk '{print $1}')"
if [[ "$EXPECTED" != "$ACTUAL" ]]; then
  echo "CHECKSUM MISMATCH -- not staging" >&2
  echo "  expected $EXPECTED" >&2
  echo "  got      $ACTUAL" >&2
  exit 1
fi
echo "    ok: ${ACTUAL}"

echo "==> extracting"
tar -xzf "${WORK}/${TARBALL}" -C "$WORK"
[[ -f "${WORK}/tor/tor" ]] || { echo "no tor/tor in the bundle" >&2; exit 1; }
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "${WORK}/tor/." "$DEST/"
chmod +x "${DEST}/tor"

# Apple Silicon refuses to run an unsigned executable at all -- the kernel
# SIGKILLs it before main(), which surfaces as a bare "Killed: 9" with no
# explanation. The expert bundle ships unsigned ("code object is not signed at
# all"), so it has to be signed before it will start.
#
# Ad-hoc here. When the app itself is signed for distribution this binary must
# be re-signed with the same identity and covered by the app's signature, or
# notarisation will reject the bundle.
if [[ "$OS" == "macos" ]]; then
  echo "==> ad-hoc signing (Apple Silicon will not run unsigned binaries)"
  # Every Mach-O in the bundle, not just the executable. tor loads libevent
  # from @executable_path and dyld refuses an unsigned dylib, so signing only
  # the binary turns a SIGKILL into an equally opaque abort on the first
  # library it needs. pluggable_transports/ holds more binaries again.
  # Libraries first, then the executable, so its signature covers what it
  # loads.
  signed=0
  while IFS= read -r f; do
    if file "$f" 2>/dev/null | grep -q "Mach-O"; then
      codesign --force --sign - --timestamp=none "$f" 2>/dev/null && signed=$((signed+1))
    fi
  done < <(find "$DEST" -type f ! -name tor)
  codesign --force --sign - --timestamp=none "${DEST}/tor"
  signed=$((signed+1))
  echo "    signed ${signed} Mach-O files"
fi

echo "==> verifying the staged binary runs"
"${DEST}/tor" --version | head -1

echo
du -sh "$DEST" | sed 's/^/staged: /'
