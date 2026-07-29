# Bisq 2 trade spike

Proof that a full **Bisq Easy BTC/EUR SEPA trade** works end to end over Bisq 2's REST +
WebSocket API, headless, with no bitcoind and no Tor. Findings and the decision this produced:
[`docs/BISQ2_SPIKE_FINDINGS.md`](../../docs/BISQ2_SPIKE_FINDINGS.md).

## Reproduce

```bash
# 1. Toolchain: JDK 21 (Temurin works), Node 22+ (native fetch + WebSocket)
# 2. Build the headless apps in a bisq2 checkout (~3 min):
git clone https://github.com/bisq-network/bisq2 && cd bisq2
./gradlew :apps:seed-node-app:installDist :apps:api-app:installDist

# 3. Start the local network (three terminals, or background each):
export BISQ2_REPO=~/path/to/bisq2
./launch-env.sh seed
./launch-env.sh seller     # REST on :8090, dev-mode reputation
./launch-env.sh buyer      # REST on :8091

# 4. Run the trade (~40 s):
node spike-trade.js        # writes spike-evidence.json
./launch-env.sh stop
```

`evidence/spike-evidence.json` is the captured run from 2026-07-19 (every request/response and
the WebSocket trade-state frames; throwaway localnet key material redacted).

Pinned context: executed against bisq2 `main` just after v2.1.11, JDK Temurin 21.0.11, macOS 15
(Apple Silicon). The API surface is young — if a call fails on a newer bisq2, diff the endpoint
classes under `api/src/main/java/bisq/api/rest_api/endpoints/` first.
