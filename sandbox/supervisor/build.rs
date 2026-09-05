//! Compiles the warm-up client's minimal envelope schema (brief §3.2a) with `protox`, so no
//! `protoc` binary is needed. The generated `zed.messages.rs` is included by `src/proto.rs`.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=proto");
    let fds = protox::compile(["proto/zs_warm.proto"], ["proto"])?;
    prost_build::Config::new().compile_fds(fds)?;
    Ok(())
}
