#!/usr/bin/env bash
# Bisq 2 local trade-spike environment: 1 clearnet seed + 2 headless api-apps.
# No Tor, no bitcoind, no GUI.
#
# Prereqs:  JDK 21 (set JAVA_HOME), a bisq2 checkout built with
#           ./gradlew :apps:seed-node-app:installDist :apps:api-app:installDist
# Usage:    BISQ2_REPO=~/src/bisq2 ./launch-env.sh seed     (then seller, buyer
#           in separate terminals; or background each)      ./launch-env.sh stop
set -euo pipefail

BISQ2_REPO="${BISQ2_REPO:?set BISQ2_REPO to your bisq2 checkout}"
NET="${SPIKE_DATA_DIR:-${TMPDIR:-/tmp}/bisq2-spike-localnet}"
mkdir -p "${NET}/seed" "${NET}/seller" "${NET}/buyer"

SEED_BIN="${BISQ2_REPO}/apps/seed-node-app/build/install/seed-node-app/bin/seed-node-app"
API_BIN="${BISQ2_REPO}/apps/api-app/build/install/api-app/bin/api-app"

COMMON="-Dapplication.network.supportedTransportTypes.0=CLEAR \
 -Dapplication.network.seedAddressByTransportType.clear.0=127.0.0.1:18000 \
 -Dapplication.network.seedAddressByTransportType.clear.1=127.0.0.1:18000"

case "${1:-}" in
  seed)
    exec env JAVA_OPTS="${COMMON} -Dapplication.network.configByTransportType.clear.defaultNodePort=18000" \
      "${SEED_BIN}" --app-name=bisq2_seed_spike --data-dir="${NET}/seed"
    ;;
  seller)
    # devModeReputationScore unlocks sell-offer creation (needs >= 1200; 200/USD).
    # authorizationRequired=false is for this LOCAL loopback spike only —
    # production clients use the pairing + session auth the mobile apps use.
    exec env JAVA_OPTS="${COMMON} \
      -Dapplication.network.configByTransportType.clear.defaultNodePort=18002 \
      -Dapplication.devMode=true \
      -Dapplication.devModeReputationScore=120000 \
      -Dapplication.api.accessTransportType=CLEAR \
      -Dapplication.api.server.restEnabled=true \
      -Dapplication.api.server.websocketEnabled=true \
      -Dapplication.api.server.security.authorizationRequired=false \
      -Dapplication.api.server.bind.host=127.0.0.1 \
      -Dapplication.api.server.bind.port=8090" \
      "${API_BIN}" --app-name=bisq2_seller_spike --data-dir="${NET}/seller"
    ;;
  buyer)
    exec env JAVA_OPTS="${COMMON} \
      -Dapplication.network.configByTransportType.clear.defaultNodePort=18003 \
      -Dapplication.devMode=true \
      -Dapplication.api.accessTransportType=CLEAR \
      -Dapplication.api.server.restEnabled=true \
      -Dapplication.api.server.websocketEnabled=true \
      -Dapplication.api.server.security.authorizationRequired=false \
      -Dapplication.api.server.bind.host=127.0.0.1 \
      -Dapplication.api.server.bind.port=8091" \
      "${API_BIN}" --app-name=bisq2_buyer_spike --data-dir="${NET}/buyer"
    ;;
  stop)
    pkill -f 'bisq2_(seed|seller|buyer)_spike' || true
    echo "stopped"
    ;;
  *)
    echo "usage: $0 seed|seller|buyer|stop"; exit 1
    ;;
esac
