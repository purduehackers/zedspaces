//! Drives the prebuild warm-up client (brief §3.16a, D14) against an in-process fake `serve`.
//!
//! The fake speaks exactly what b1/b2 specify: it requires `Sec-WebSocket-Protocol: zs.v1, <jwt>`
//! and echoes `zs.v1`, answers `hello` with `hello_ack`, sends `RemoteStarted` as the first binary
//! envelope, answers `AddWorktree`/`OpenBufferByPath`, and emits `UpdateLanguageServer` so the
//! client records a language server. It records every envelope it received, so the test can assert
//! that no persistence message (`SaveClientState`) is ever sent (b4 §3.15 item 7).

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt as _, StreamExt as _};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

use zs_agent::proto::messages;
use zs_agent::warm::{
    WarmArgs, decode_envelope_frame, encode_envelope_frame, generate_warm_key, run_standalone,
};

/// What the fake server observed.
#[derive(Default)]
struct Observed {
    subprotocol: Option<String>,
    hello: Option<serde_json::Value>,
    opened: Vec<String>,
    worktree_path: Option<String>,
    envelope_kinds: Vec<&'static str>,
}

fn kind_of(envelope: &messages::Envelope) -> &'static str {
    match envelope.payload {
        Some(messages::envelope::Payload::AddWorktree(_)) => "add_worktree",
        Some(messages::envelope::Payload::OpenBufferByPath(_)) => "open_buffer_by_path",
        Some(messages::envelope::Payload::Ack(_)) => "ack",
        Some(messages::envelope::Payload::Ping(_)) => "ping",
        Some(_) => "other",
        None => "unknown",
    }
}

/// Starts the fake and returns its address; it serves exactly one connection.
// `ErrorResponse` is tungstenite's handshake-callback error type; its size is not ours to choose.
#[allow(clippy::result_large_err)]
async fn start_fake(observed: Arc<Mutex<Observed>>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let recorder = observed.clone();
        let callback = move |request: &Request, mut response: Response| {
            let offered = request
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string();
            if !offered.starts_with("zs.v1, ") {
                return Err(ErrorResponse::new(Some(
                    "expected `zs.v1, <jwt>`".to_string(),
                )));
            }
            recorder.lock().unwrap().subprotocol = Some(offered);
            response
                .headers_mut()
                .insert("sec-websocket-protocol", "zs.v1".parse().unwrap());
            Ok(response)
        };
        let mut socket = tokio_tungstenite::accept_hdr_async(stream, callback)
            .await
            .unwrap();

        // hello → hello_ack, then RemoteStarted as the first binary envelope.
        let Some(Ok(Message::Text(hello))) = socket.next().await else {
            return;
        };
        observed.lock().unwrap().hello = serde_json::from_str(&hello).ok();
        socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "hello_ack",
                    "protocol": 1,
                    "build": "fake",
                    "os": "linux",
                    "arch": "x86_64",
                    "os_version": null,
                    "shell": "/bin/bash",
                    "resumed": false,
                    "session_id": "warm",
                    "epoch": 1,
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Binary(encode_envelope_frame(
                &messages::Envelope {
                    id: 0,
                    payload: Some(messages::envelope::Payload::RemoteStarted(
                        messages::RemoteStarted {},
                    )),
                    ..Default::default()
                },
            )))
            .await
            .unwrap();

        let mut next_id = 1u32;
        while let Some(Ok(message)) = socket.next().await {
            let Message::Binary(bytes) = message else {
                continue;
            };
            let envelope = decode_envelope_frame(&bytes).unwrap();
            observed
                .lock()
                .unwrap()
                .envelope_kinds
                .push(kind_of(&envelope));
            let reply = match &envelope.payload {
                Some(messages::envelope::Payload::AddWorktree(worktree)) => {
                    observed.lock().unwrap().worktree_path = Some(worktree.path.clone());
                    messages::envelope::Payload::AddWorktreeResponse(
                        messages::AddWorktreeResponse {
                            worktree_id: 7,
                            canonicalized_path: worktree.path.clone(),
                        },
                    )
                }
                Some(messages::envelope::Payload::OpenBufferByPath(open)) => {
                    observed.lock().unwrap().opened.push(open.path.clone());
                    messages::envelope::Payload::OpenBufferResponse(messages::OpenBufferResponse {
                        buffer_id: 42,
                    })
                }
                _ => continue,
            };
            // A language server starting for the buffer that was just opened.
            socket
                .send(Message::Binary(encode_envelope_frame(
                    &messages::Envelope {
                        id: next_id,
                        payload: Some(messages::envelope::Payload::UpdateLanguageServer(
                            messages::UpdateLanguageServer {
                                project_id: 0,
                                language_server_id: 1,
                                server_name: Some("rust-analyzer".to_string()),
                                variant: None,
                            },
                        )),
                        ..Default::default()
                    },
                )))
                .await
                .unwrap();
            next_id += 1;
            socket
                .send(Message::Binary(encode_envelope_frame(
                    &messages::Envelope {
                        id: next_id,
                        responding_to: Some(envelope.id),
                        payload: Some(reply),
                        ..Default::default()
                    },
                )))
                .await
                .unwrap();
            next_id += 1;
        }
    });
    addr
}

#[tokio::test(flavor = "multi_thread")]
async fn warm_up_opens_one_buffer_per_language() {
    let observed = Arc::new(Mutex::new(Observed::default()));
    let addr = start_fake(observed.clone()).await;

    let workspace = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(workspace.path().join("src")).unwrap();
    std::fs::write(workspace.path().join("src/main.rs"), "fn main() {}").unwrap();
    std::fs::write(workspace.path().join("app.py"), "print('hi')").unwrap();

    let key = generate_warm_key().unwrap();
    let key_file = workspace.path().join("warm.key");
    std::fs::write(
        &key_file,
        secrecy::ExposeSecret::expose_secret(&key.private_pem),
    )
    .unwrap();

    let outcome = run_standalone(WarmArgs {
        private_key: key_file,
        workspace_id: "ws_1".to_string(),
        audience: "sb-1".to_string(),
        issuer: "zs".to_string(),
        workspace_root: workspace.path().to_path_buf(),
        server_url: format!("http://{addr}"),
        // Comfortably longer than WARM_SETTLE: the run must end on the settle timer, not the
        // budget, which is what `settled` asserts below.
        budget_secs: 120,
    })
    .await
    .unwrap();

    assert_eq!(outcome.files_opened, 2);
    assert!(outcome.servers_seen.contains("rust-analyzer"));
    assert!(
        outcome.settled,
        "the fake stops talking, so the settle timer – not the budget – ends the run"
    );
    assert!(outcome.elapsed >= zs_agent::warm::WARM_SETTLE);

    let observed = observed.lock().unwrap();
    let offered = observed.subprotocol.clone().unwrap();
    assert!(offered.starts_with("zs.v1, eyJ"), "offered {offered}");
    let hello = observed.hello.clone().unwrap();
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["workspace_id"], "ws_1");
    assert_eq!(hello["client"], "desktop");
    assert_eq!(hello["reconnect"], false);
    assert!(hello["session_id"].as_str().unwrap().starts_with("warm-"));
    assert!(
        hello["identifier"]
            .as_str()
            .unwrap()
            .starts_with("zs-agent-warm/")
    );
    assert!(hello["instance"].is_string(), "D25 per-boot nonce");
    assert_eq!(
        observed.worktree_path.as_deref(),
        Some(workspace.path().to_string_lossy().as_ref())
    );
    assert_eq!(observed.opened, vec!["src/main.rs", "app.py"]);
    assert!(
        observed
            .envelope_kinds
            .iter()
            .all(|kind| matches!(*kind, "add_worktree" | "open_buffer_by_path" | "ack")),
        "the warm-up sends nothing but worktree/buffer requests and acks: {:?}",
        observed.envelope_kinds
    );
}
