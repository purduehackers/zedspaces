//! Generated prost types for the warm-up client's minimal envelope schema (brief §3.2a).
//!
//! `build.rs` compiles `proto/zs_warm.proto` (package `zed.messages`, the same package name as
//! Zed's `zed.proto` so the generated module path matches) into `$OUT_DIR/zed.messages.rs`.

/// Prost-generated `zed.messages` types: `Envelope`, `PeerId`, the request/response messages
/// the warm-up client sends and the notifications it observes (§3.16a).
pub mod messages {
    include!(concat!(env!("OUT_DIR"), "/zed.messages.rs"));
}
