# Trusted ShellBeam Monitoring Agent distribution

The application keeps its existing Ed25519 trust root, `komari` runtime and
`0xJean/shellbeam` download origin. This maintenance change adds release tooling
without merging the separate frontend feature branch or changing installed
applications. Server plugins stay in the application repository.

## Reviewed 1.5.12 inputs

The ShellBeam fork is based on upstream Agent 1.5.11. Its source commit is
`4e81478e4bde5c22b7b65e422ae87ca40a6c877a`, from successful native CI
[39908111443](https://github.com/0xJean/shellbeam-monitoring-agent/actions/runs/39908111443).
The selected Linux bytes were built with Go 1.25.14 and were copied from that
CI without rebuilding. `releases/compatible-probe-pins.json` records executable
and complete archive hashes/sizes plus the exact source tag/commit. Original
1.5.10 and 1.5.11 pins remain unchanged.

| Architecture | Executable SHA-256 | Bytes |
| --- | --- | ---: |
| amd64 | `daf4ec3bc514f0cc1e8150a55a2c02737dc3cec76890ca0f79de5c52b5a1480d` | 12148920 |
| arm64 | `d053c98fe7c8ed2252d3516deb22ef932a793b16f94c5228fbd9bda9fe37c478` | 11468984 |

The two pinned native archives include the fork's MIT attribution, dependency
license inventory, build identity and provenance. They accompany the bare
executables in the application distribution release. They are not additional
manifest/catalog fields: the signed wire format is unchanged.

Exact arm64 release bytes passed system and user systemd tests with the
unchanged production remote helper and a real isolated ShellBeam Server:
22 checks and 12 fresh CPU samples across both scopes. Coverage includes old
1.5.11 installation, candidate tamper rejection, 1.5.12 upgrade, retained-byte
rollback, another upgrade, actual restart, read-only inspection, uninstall,
reinstall and final uninstall. MainPID executable SHA/path/argv and process
incarnation were checked. Configuration, node identity/token and recent reports
were retained. Temporary signing keys were used only in those isolated tests;
this is separate from native App/SSH and production catalog acceptance.

## Protected publication

After the maintenance PR passes CI and merges into `main`, dispatch
`komari-agent-release.yml` with version `1.5.12` and revision `1`.

1. The prepare job validates source pins, resolves the fork tag to its expected
   commit, downloads and hashes both executables and complete archives, and
   uploads the exact unsigned release inputs for review. It receives no signing
   secret.
2. The publish job waits for the existing `komari-agent-release` environment.
   That environment permits only `main` and requires reviewer `0xJean`. Its
   protection remains enabled. The production key is available only to the
   protected signing step and is removed from the temporary filesystem afterward.
3. Promotion checks local and already-uploaded bytes, creates an immutable
   versioned release, verifies anonymous download availability, then advances
   `monitoring-probe-releases/stable/catalog.json` atomically. Retries reuse the
   same valid signed bytes; conflicting or altered published assets are refused.

The signed 1.5.12 executable URLs retain this shape:

```text
https://github.com/0xJean/shellbeam/releases/download/monitoring-probe-v1.5.12-r1/komari-agent-linux-{amd64,arm64}
```

Catalog sequence must increase. Public feed rollback is never used to test
client rollback: the client explicitly restores its retained, previously
verified manifest and exact local executable. Native client acceptance should
cover a fresh 1.5.12 installation and 1.5.11 → 1.5.12 → retained 1.5.11 → 1.5.12,
checking the real process hash, original fresh reports, same node/token/config,
SSH/Vault ownership and recovery/audit state against ShellBeam Server.

## Reviewed 1.5.13 inputs

Second owned maintenance release: source `a7154f8151222c2eff3146e2acb7b3c8c1b6276c`,
tag `v1.5.13`, source CI `39983161969` and release build `39983163294`.
Collection behavior/configuration remain compatible with 1.5.12. Both native
Linux checks and all eleven release platform builds passed. Exact Linux binaries
and complete legal archives were downloaded from that draft, checked against
its checksum files and inspected for original source identity and attribution.

- amd64: `53708f015e53618be1722668b49766376a70bd432d44911c75e116c4e227df73`, 12148920 bytes.
- arm64: `b2531bc213b4cb84a340d81f77fde4629d093c0f9129a3a37c843f5ed64c1c56`, 11468984 bytes.

The new pin row is additive; original 1.5.10/1.5.11/1.5.12 artifact metadata,
release assets, signatures and the production root remain unchanged. After this
release metadata reaches main, dispatch version 1.5.13/revision 1 through the
existing protected environment. No private key is copied to the workstation.
Clients with the prior compiled allowlist need an updated App before admitting
1.5.13. Rollback explicitly restores retained 1.5.12 bytes; it never rewinds the
public stable feed. Real WEB acceptance is tracked in PR #2 separately.
