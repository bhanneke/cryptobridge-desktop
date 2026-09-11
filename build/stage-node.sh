#!/usr/bin/env bash
# Stage the runtime dependencies the installer ships: Bisq's api-app and a
# minimal Java runtime.
#
# Why jlink rather than a JDK: measured on this project, a full Temurin 21 JDK
# is 336 MB while a jlink'd image with the modules Bisq needs is 52 MB. That is
# the difference between a ~446 MB download and a ~163 MB one, for a wallet
# someone is deciding whether to trust.
#
# Not run by CI. It needs a Bisq build and a JDK, and it produces ~145 MB of
# files that are deliberately not in git.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HERE}/../src-tauri/resources"

BISQ_INSTALL="${BISQ_INSTALL:-}"
JAVA_HOME="${JAVA_HOME:-}"

if [[ -z "$BISQ_INSTALL" || ! -x "$BISQ_INSTALL/bin/api-app" ]]; then
  cat >&2 <<'MSG'
Set BISQ_INSTALL to a built Bisq 2 api-app install directory, i.e. the one
containing bin/api-app and lib/*.jar. From a Bisq checkout that is:

    ./gradlew :apps:api-app:installDist
    export BISQ_INSTALL=apps/api-app/build/install/api-app
MSG
  exit 1
fi

if [[ -z "$JAVA_HOME" || ! -x "$JAVA_HOME/bin/jlink" ]]; then
  echo "Set JAVA_HOME to a JDK 21 (needs bin/jlink)." >&2
  exit 1
fi

# The modules Bisq needs. jdeps cannot analyse Bisq's jar set (it fails on a
# multi-release conflict), so this is a deliberately generous hand-picked set:
# over-including costs a few MB, under-including fails at runtime in a way the
# user cannot fix.
MODULES="java.base,java.logging,java.naming,java.net.http,java.sql,java.management,\
java.security.jgss,java.instrument,java.scripting,java.xml,java.desktop,\
java.transaction.xa,jdk.crypto.ec,jdk.crypto.cryptoki,jdk.unsupported,jdk.zipfs,jdk.net"

echo "==> staging Bisq from $BISQ_INSTALL"
rm -rf "$DEST/bisq"
mkdir -p "$DEST/bisq"
cp -R "$BISQ_INSTALL/bin" "$BISQ_INSTALL/lib" "$DEST/bisq/"

echo "==> building a minimal Java runtime with jlink"
rm -rf "$DEST/jre"
"$JAVA_HOME/bin/jlink" \
  --add-modules "$MODULES" \
  --strip-debug --no-header-files --no-man-pages --compress=zip-9 \
  --output "$DEST/jre"

echo "==> verifying the staged runtime actually runs"
"$DEST/jre/bin/java" -version

echo
echo "staged:"
du -sh "$DEST/bisq" "$DEST/jre" | sed 's/^/  /'
echo
echo "Now build the app as usual; src-tauri/tauri.conf.json bundles resources/."
