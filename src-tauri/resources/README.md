# Bundled runtime dependencies

Staged here by the scripts in `build/`, not committed — together these are
about 180 MB, which does not belong in git.

| directory | staged by | measured |
|-----------|-----------|----------|
| `bisq/`   | `build/stage-node.sh` | ~91 MB — Bisq 2's api-app (launcher + jars) |
| `jre/`    | `build/stage-node.sh` | ~52 MB — a jlink'd runtime with only the modules Bisq needs (a full JDK is 336 MB) |
| `tor/`    | `build/stage-tor.sh`  | ~34 MB — the Tor Project's expert bundle, checksum-verified |

With the 19 MB app that is a ~196 MB installer. Measured, not estimated.

The app prefers whatever is here over anything installed on the machine: it is
the version we configured and the version we tested.

## Two things that are easy to get wrong

**The bundler keeps this directory's name.** A file staged at
`src-tauri/resources/tor/tor` arrives at `<resource_dir>/resources/tor/tor`,
not `<resource_dir>/tor/tor`. The discovery code in `src/tor.rs` and
`src/node.rs` looks for both, longest first.

**`resources/*` matches files only.** It silently skipped the staged
directories and produced a bundle that looked fine and shipped nothing. The
config uses `resources/**/*`.

## macOS signing

The Tor expert bundle ships unsigned, and Apple Silicon SIGKILLs unsigned
executables before `main()` — which surfaces as a bare `Killed: 9`. Signing
only `tor` then fails again on the first unsigned dylib it loads. So
`stage-tor.sh` ad-hoc signs **every** Mach-O in the bundle, libraries first.

When the app is signed for distribution these binaries must be re-signed with
the same identity and covered by the app's signature, or notarisation will
reject it.
