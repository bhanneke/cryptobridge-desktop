#!/usr/bin/env bash
# A Bisq 2 api-app with authorization ON, for exercising the pairing flow.
#
# Note this does NOT pass -Dapplication.api.server.security.authorizationRequired=false:
# `true` is the api-app's own default, and launch-env.sh is the one that turns it
# off. Everything about pairing auth is therefore the shipped behaviour, not a
# special mode we invented.
#
# Prereqs:  JDK 21 (set JAVA_HOME), a bisq2 checkout built with
#           ./gradlew :apps:seed-node-app:installDist :apps:api-app:installDist
# Usage:    BISQ2_REPO=~/src/bisq2 ./launch-env.sh seed     # in one terminal
#           BISQ2_REPO=~/src/bisq2 ./launch-auth.sh         # in another
set -euo pipefail

BISQ2_REPO="${BISQ2_REPO:?set BISQ2_REPO to your bisq2 checkout}"
NET="${SPIKE_DATA_DIR:-${TMPDIR:-/tmp}/bisq2-spike-localnet}"
mkdir -p "${NET}/auth"

API_BIN="${BISQ2_REPO}/apps/api-app/build/install/api-app/bin/api-app"

COMMON="-Dapplication.network.supportedTransportTypes.0=CLEAR \
 -Dapplication.network.seedAddressByTransportType.clear.0=127.0.0.1:18000 \
 -Dapplication.network.seedAddressByTransportType.clear.1=127.0.0.1:18000"

exec env JAVA_OPTS="${COMMON} \
  -Dapplication.network.configByTransportType.clear.defaultNodePort=18004 \
  -Dapplication.devMode=true \
  -Dapplication.api.accessTransportType=CLEAR \
  -Dapplication.api.writePairingQrCodeToDisk=true \
  -Dapplication.api.server.restEnabled=true \
  -Dapplication.api.server.websocketEnabled=true \
  -Dapplication.api.server.bind.host=127.0.0.1 \
  -Dapplication.api.server.bind.port=8092" \
  "${API_BIN}" --app-name=bisq2_auth_spike --data-dir="${NET}/auth"

# Once up, the node logs "Pairing QR code created. Code ID: <uuid>" and writes
# ${NET}/auth/pairing_qr_code.txt — whose FIRST LINE is the base64url pairing
# payload (the rest is an ASCII-art rendering of the same QR). Feed that first
# line to the app as `cryptobridge.pairing`, or to the live test:
#
#   CODE_ID=$(head -1 "${NET}/auth/pairing_qr_code.txt" | node -e '
#     import("./src/adapters/pairing.js").then(({parsePairingInput}) => {
#       let s=""; process.stdin.on("data",d=>s+=d)
#         .on("end",()=>console.log(parsePairingInput(s.trim()).pairingCodeId)); });')
#   BISQ_AUTH_API_URL=http://127.0.0.1:8092/api/v1 BISQ_PAIRING_CODE_ID=$CODE_ID \
#     cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture live_auth
