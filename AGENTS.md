# AGENTS.md

Guidelines for human contributors and coding agents working in `shellbeam`.

## Repository Layout

- `src/` — React 19 + TypeScript + Vite frontend (unit tests via Vitest, lint via ESLint 9 flat config in `eslint.config.js`).
- `src-tauri/` — Tauri 2 Rust desktop/mobile backend.
- `agent/` — Standalone monitoring collector Rust crate (see `docs/agent.md` and `.github/workflows/agent-ci.yml`).
- `scripts/` — CI guard scripts, packaging helpers, and live acceptance harnesses.

## Toolchain

- **Node.js**: `20.19+` or `22.12+` (required by Vite 7). Use `npm ci` for reproducible installs.
- **Rust**: Stable toolchain with `rustfmt` and `clippy` components. Always pass `--locked` to `cargo` commands unless intentionally updating `Cargo.lock`.

## Required Checks Before Opening or Updating a PR

Run the checks matching the areas you touched:

### Frontend (`src/`, `vite.config.ts`, `package.json`, `eslint.config.js`)

```bash
npm ci
npm run lint -- --max-warnings=0
npm test
npm run build
```

- `npm run lint -- --max-warnings=0` runs `eslint .` across the full repository and is enforced in CI with zero errors and zero warnings.
- `npm run build` (`tsc -b && vite build`) must succeed without TypeScript errors or Vite/Rollup mixed-import or chunk-size warnings.

### Rust Backend (`src-tauri/`)

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
```

- Full-crate `cargo clippy --all-targets -- -D warnings` is enforced in CI across Linux, macOS, and Windows.

### Standalone Agent (`agent/`)

```bash
cargo test --manifest-path agent/Cargo.toml --locked
cargo clippy --manifest-path agent/Cargo.toml --locked --all-targets -- -D warnings
```

## Coding & Review Standards

- **React Hooks & ESLint**:
  - Do not read or mutate `ref.current` during render; synchronize refs in `useEffect`.
  - Do not call `setState` synchronously inside `useEffect` bodies (`react-hooks/set-state-in-effect`); prefer derived state, keyed state, or subscription/event callbacks.
  - Avoid mixing static and dynamic imports of the same module so Rollup chunking stays deterministic and warning-free.
- **Cross-Platform Rust**:
  - CI runs on Linux, macOS, and Windows. Gate OS-specific items with `#[cfg(...)]` or `#[cfg_attr(..., allow(dead_code))]` rather than leaving unused-code warnings on other targets.
- **Security**:
  - Never commit secrets, API keys, private keys, or credentials.
  - Keep command-risk / read-only classification fail-closed (`src/lib/command-risk.ts`) and ensure external AI CLI subprocesses cannot invoke unauthorized tools (`src-tauri/src/ai_cli.rs`).
- **PR Scope & Baseline Hygiene**:
  - Keep PRs focused on the task. Distinguish newly introduced issues from pre-existing baseline debt on `main`.
  - Do not disable lint rules (`eslint-disable`, `#[allow(...)]`) without a concrete reason scoped as narrowly as possible.

## Release Hygiene

- Follow `docs/release-process.md` end-to-end for every tagged release (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `docs/releases/vX.Y.Z.md`).
- Never publish a public GitHub Release with an unsigned/unnotarized macOS DMG or unsigned Android APK: verify `codesign -dv`, `xcrun stapler validate`, `spctl -a -vvv` (macOS `.app` and `.dmg`), `apksigner verify` (Android), and `SHA256SUMS` before publishing.
