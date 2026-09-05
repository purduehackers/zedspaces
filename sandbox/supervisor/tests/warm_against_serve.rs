//! The warm-up client against the real `remote_server serve` (brief §6.2 `warm_against_serve.rs`).
//!
//! Runs only when `ZS_RUN_WARM_INTEGRATION=1` **and** a locally built server exists
//! (`../../zed/target/{debug,release}/remote_server`, or `ZS_REMOTE_SERVER_BIN`); otherwise it
//! prints why it skipped and passes. CI's `agent-tests` job has no server binary, so it skips
//! there; the `image` job's real-server `run-local.sh` pass covers the same path end to end.

use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use zs_agent::warm::{WarmArgs, generate_warm_key, run_standalone};

fn server_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("ZS_REMOTE_SERVER_BIN") {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../zed/target");
    ["debug", "release"]
        .iter()
        .map(|profile| root.join(profile).join("remote_server"))
        .find(|path| path.is_file())
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// `Ok(true)` once `/health` answers, `Ok(false)` when the budget passes, `Err(status)` when the
/// server process exited first.
async fn wait_for_health(
    child: &mut std::process::Child,
    addr: SocketAddr,
    budget: Duration,
) -> Result<bool, std::process::ExitStatus> {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let deadline = Instant::now() + budget;
    let mut pause = Duration::from_millis(200);
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(status);
        }
        if let Ok(response) = client
            .get(format!("http://{addr}/health"))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            && response.status().is_success()
        {
            return Ok(true);
        }
        tokio::time::sleep(pause).await;
        pause = (pause * 2).min(Duration::from_secs(2));
    }
    Ok(false)
}

#[tokio::test(flavor = "multi_thread")]
async fn warm_up_starts_language_servers_on_a_real_serve() {
    if std::env::var("ZS_RUN_WARM_INTEGRATION").as_deref() != Ok("1") {
        eprintln!("warm_against_serve: ZS_RUN_WARM_INTEGRATION is not 1; skipping");
        return;
    }
    let Some(server_bin) = server_binary() else {
        eprintln!("warm_against_serve: no remote_server binary found; skipping");
        return;
    };

    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(workspace.join("src")).unwrap();
    std::fs::write(
        workspace.join("src/main.rs"),
        "fn main() { println!(\"hello\"); }\n",
    )
    .unwrap();
    std::fs::write(
        workspace.join("Cargo.toml"),
        "[package]\nname = \"w\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    std::fs::write(
        workspace.join("app.py"),
        "def hello() -> str:\n    return 'hello'\n",
    )
    .unwrap();

    // The warm-up key is what the prebuild boot mints: its public half is the server's only
    // trusted key here, its private half signs the session token.
    let key = generate_warm_key().unwrap();
    let key_file = dir.path().join("warm.key");
    std::fs::write(
        &key_file,
        secrecy::ExposeSecret::expose_secret(&key.private_pem),
    )
    .unwrap();
    let public_file = dir.path().join("key-warm.pem");
    std::fs::write(&public_file, &key.public_pem).unwrap();
    let secret_file = dir.path().join("control.secret");
    std::fs::write(&secret_file, "zs-test-control-secret-0123456789ab").unwrap();

    let listen: SocketAddr = format!("127.0.0.1:{}", free_port()).parse().unwrap();
    let control_listen: SocketAddr = format!("127.0.0.1:{}", free_port()).parse().unwrap();
    let log_file = dir.path().join("serve.log");
    let mut child = Command::new(&server_bin)
        .args([
            "serve",
            "--listen",
            &listen.to_string(),
            "--jwt-public-key",
            &public_file.to_string_lossy(),
            "--workspace-id",
            "ws_warm",
            "--audience",
            "sb-warm",
            "--issuer",
            "zs",
            "--workspace-root",
            &workspace.to_string_lossy(),
            "--control-secret-file",
            &secret_file.to_string_lossy(),
            "--control-listen",
            &control_listen.to_string(),
            // A test-support build of the server hard-codes a fake home directory; relocating
            // its data and config under the temp dir keeps the test hermetic either way.
            "--user-data-dir",
            &dir.path().join("server-data").to_string_lossy(),
        ])
        .env_remove("ZS_CONTROL_SECRET")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(&log_file).unwrap())
        .spawn()
        .expect("spawn remote_server serve");
    match wait_for_health(&mut child, listen, Duration::from_secs(60)).await {
        Ok(true) => {}
        Ok(false) => panic!(
            "serve never answered /health; log:\n{}",
            std::fs::read_to_string(&log_file).unwrap_or_default()
        ),
        Err(status) => {
            let log = std::fs::read_to_string(&log_file).unwrap_or_default();
            // A `test-support` build of the server hard-codes `/Users/zed` (macOS) or
            // `/home/zed` as its home and cannot create its log directory outside
            // `--user-data-dir`; that is a property of the checked-out binary, not of `serve`,
            // so it is a skip rather than a failure. Any other early exit is a real failure.
            if log.contains("/Users/zed") || log.contains("/home/zed") {
                eprintln!(
                    "warm_against_serve: the local remote_server is a test-support build \
                     (fake home directory); skipping. Exit {status}; log:\n{log}"
                );
                return;
            }
            panic!("serve exited with {status} before answering /health; log:\n{log}");
        }
    }

    let outcome = run_standalone(WarmArgs {
        private_key: key_file,
        workspace_id: "ws_warm".to_string(),
        audience: "sb-warm".to_string(),
        issuer: "zs".to_string(),
        workspace_root: workspace.clone(),
        server_url: format!("http://{listen}"),
        budget_secs: 120,
    })
    .await;
    let _ = child.kill();
    let _ = child.wait();
    let log = std::fs::read_to_string(&log_file).unwrap_or_default();
    let outcome =
        outcome.unwrap_or_else(|error| panic!("warm-up failed: {error:#}\nserve log:\n{log}"));

    assert!(
        outcome.files_opened >= 1,
        "at least one buffer opens: {outcome:?}"
    );
    assert!(
        !outcome.servers_seen.is_empty(),
        "a language server (rust-analyzer from PATH, or pyright) should have started: {outcome:?}\nserve log:\n{log}"
    );
    // b4 §3.15 item 7: the warm-up never persists client state.
    assert!(
        !log.contains("SaveClientState") && !log.contains("save_client_state"),
        "the warm-up must not send SaveClientState:\n{log}"
    );
}
