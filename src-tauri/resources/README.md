# Bundled runtime dependencies

Staged here by `build/stage-node.sh`, not committed — between them these are
about 145 MB, which does not belong in git.

    bisq/   Bisq 2's api-app (launcher + jars), ~91 MB
    jre/    a jlink'd Java runtime with only the modules Bisq needs, ~52 MB

The app prefers whatever is here over anything installed on the machine: it is
the version we configured and the version we tested. `src-tauri/src/node.rs`
looks for `bisq/bin/api-app` and `jre/bin/java` in the bundle's resource
directory before falling back to a system install.

Tor is not staged here yet. Chain sync needs a SOCKS proxy on 127.0.0.1:9050
and there is no clearnet fallback by design, so a user without Tor gets no
wallet balance. Shipping it is part of the same job.
