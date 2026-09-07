//! `zs-agent`: the supervisor that runs inside every Zed Codespaces workspace sandbox.
//!
//! Plan of record: `docs/briefs/b8-supervisor-image.md` (module layout §3.3-§3.17) as amended by
//! `docs/briefs/DECISIONS.md` (D21 port map, D22/D23 wire changes seen by the warm-up client,
//! D28 child environment, D29 names and shapes). The binary in `src/main.rs` is a thin clap front
//! end over these modules.
//!
//! Module map (bottom-up dependency order):
//!
//! | Module | Brief | Purpose |
//! |---|---|---|
//! | [`config`] | §3.3 | environment and filesystem contract, port map |
//! | [`manifest`] | §3.4 | `SandboxManifest` and `devcontainer.json` types |
//! | [`control_plane`] | §3.5 | HTTP client for the sandbox-facing control-plane routes |
//! | [`logs`] | §3.6 | log batching, scrubbing and shipping |
//! | [`ports`] | §3.7 | `/proc/net/tcp` parsing and the listening-port watcher |
//! | [`state`] | §3.8 | shared runtime state, health report, forwards |
//! | [`server`] | §3.9 | `zed-remote-server serve` spawn, supervision and control client |
//! | [`port_auth`] | §3.10 | HMAC port bootstrap tokens and proxy cookies |
//! | [`proxy`] | §3.11 | cookie-gated private-port reverse proxy (one listener per D21 slot) |
//! | [`api`] | §3.12 | health listener and loopback supervisor API |
//! | [`credential`] | §3.13 | git credential helper |
//! | [`bootstrap`] | §3.14 | clone/restore, dotfiles, settings, lifecycle commands |
//! | [`activity`] | §3.15 | activity ping relay and lifecycle notice policy |
//! | [`start`] | §3.16 | `start`/`resume`/`prebuild` orchestration |
//! | [`warm`] | §3.16a | headless language-server warm-up client (D14) |
//! | [`proto`] | §3.2a | generated prost types for the warm-up client |

pub mod activity;
pub mod api;
pub mod bootstrap;
pub mod config;
pub mod control_plane;
pub mod credential;
pub mod debugger;
pub mod logs;
pub mod manifest;
pub mod port_auth;
pub mod ports;
pub mod proto;
pub mod proxy;
pub mod server;
pub mod start;
pub mod state;
pub mod warm;
