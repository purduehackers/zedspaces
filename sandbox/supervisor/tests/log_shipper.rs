//! Log shipping end to end (brief §6.1 `batch_flushes_on_count_and_bytes`,
//! `manifest_limits_applied`).
//!
//! The batching task runs against an in-process control plane that answers `413` once and `204`
//! afterwards, so the count trigger, the timer trigger, the 413 back-off and the final flush are
//! all exercised over a real socket.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use http_body_util::{BodyExt as _, Full};
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use zs_agent::config::Config;
use zs_agent::control_plane::ControlPlane;
use zs_agent::logs::{LogEntry, LogShipper, LogShipperConfig};

/// Every batch the fake control plane received, as parsed JSON.
type Batches = Arc<Mutex<Vec<serde_json::Value>>>;

/// Answers `413` for the first `reject_first` batches and `204` afterwards.
async fn spawn_ingest(batches: Batches, reject_first: usize) -> SocketAddr {
    spawn_ingest_with(batches, reject_first, StatusCode::NO_CONTENT).await
}

/// [`spawn_ingest`] with a configurable success status (b9 answers 204; any 2xx must count).
async fn spawn_ingest_with(
    batches: Batches,
    reject_first: usize,
    success: StatusCode,
) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let seen = Arc::new(AtomicUsize::new(0));
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let batches = batches.clone();
            let seen = seen.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req: Request<hyper::body::Incoming>| {
                    let batches = batches.clone();
                    let seen = seen.clone();
                    async move {
                        let body = req
                            .into_body()
                            .collect()
                            .await
                            .map(|collected| collected.to_bytes())
                            .unwrap_or_default();
                        let parsed: serde_json::Value =
                            serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
                        let index = seen.fetch_add(1, Ordering::SeqCst);
                        batches.lock().unwrap().push(parsed);
                        let status = if index < reject_first {
                            StatusCode::PAYLOAD_TOO_LARGE
                        } else {
                            success
                        };
                        let mut response = Response::new(Full::new(Bytes::new()));
                        *response.status_mut() = status;
                        Ok::<_, Infallible>(response)
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    addr
}

fn control_plane(addr: SocketAddr) -> ControlPlane {
    let env = BTreeMap::from([
        ("ZS_CONTROL_URL", format!("http://{addr}/api")),
        ("ZS_SANDBOX_TOKEN", "zsb_test".to_string()),
        ("ZS_SANDBOX_NAME", "sb-test".to_string()),
        ("ZS_WORKSPACE_ID", "ws_test".to_string()),
        ("HOME", "/tmp".to_string()),
    ]);
    let config = Config::from_lookup(|key| env.get(key).cloned()).expect("config");
    ControlPlane::new(Arc::new(config)).expect("client")
}

fn entry(index: usize) -> LogEntry {
    LogEntry {
        ts: 1_756_800_000_000 + index as u64,
        level: "info",
        // A distinct source per entry keeps the per-source token bucket out of the way.
        source: format!("s{index}"),
        msg: format!("line {index}"),
        fields: None,
    }
}

fn shipper_config(max_batch: usize) -> LogShipperConfig {
    LogShipperConfig {
        flush_interval: Duration::from_millis(100),
        max_batch,
        max_batch_bytes: 256 * 1024,
        workspace_id: "ws_test".to_string(),
        sandbox_name: "sb-test".to_string(),
        session_id: "ses_1".to_string(),
        build: "c3cf80c-42".to_string(),
    }
}

async fn wait_for(batches: &Batches, count: usize) {
    for _ in 0..200 {
        if batches.lock().unwrap().len() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!(
        "only {} batches arrived, expected {count}",
        batches.lock().unwrap().len()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn batches_flush_on_count_and_carry_the_identity() {
    let batches: Batches = Arc::new(Mutex::new(Vec::new()));
    let addr = spawn_ingest(batches.clone(), 0).await;
    let (shipper, handle) = LogShipper::start(control_plane(addr), "c3cf80c-42".to_string());
    shipper.configure(shipper_config(50));

    for index in 0..50 {
        shipper.push(entry(index));
    }
    wait_for(&batches, 1).await;
    let batch = batches.lock().unwrap()[0].clone();
    assert_eq!(batch["workspaceId"], "ws_test");
    assert_eq!(batch["sandboxName"], "sb-test");
    assert_eq!(batch["sessionId"], "ses_1");
    assert_eq!(batch["build"], "c3cf80c-42");
    assert_eq!(batch["entries"].as_array().unwrap().len(), 50);
    assert_eq!(batch["entries"][0]["msg"], "line 0");

    // A partial batch goes out on the flush timer.
    shipper.push(entry(1_000));
    wait_for(&batches, 2).await;
    assert_eq!(batches.lock().unwrap()[1]["entries"][0]["msg"], "line 1000");

    // The final flush ships whatever is still queued.
    shipper.push(entry(2_000));
    handle.flush(Duration::from_secs(3)).await;
    wait_for(&batches, 3).await;
    assert_eq!(batches.lock().unwrap()[2]["entries"][0]["msg"], "line 2000");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_bytes_threshold_flushes_before_the_count() {
    let batches: Batches = Arc::new(Mutex::new(Vec::new()));
    let addr = spawn_ingest(batches.clone(), 0).await;
    let (shipper, handle) = LogShipper::start(control_plane(addr), "c3cf80c-42".to_string());
    let mut config = shipper_config(200);
    config.max_batch_bytes = 64 * 1024;
    config.flush_interval = Duration::from_secs(30);
    shipper.configure(config);

    // 5 × 20 KiB: the count threshold (200) is far away, the bytes threshold (64 KiB) is not.
    for index in 0..5 {
        let mut big = entry(index);
        big.msg = "x".repeat(20 * 1024 - 64);
        shipper.push(big);
    }
    wait_for(&batches, 1).await;
    let first = batches.lock().unwrap()[0]["entries"]
        .as_array()
        .unwrap()
        .len();
    assert!(
        (1..5).contains(&first),
        "the first batch stops below the byte ceiling: {first} entries"
    );
    handle.flush(Duration::from_secs(3)).await;
    let total: usize = batches
        .lock()
        .unwrap()
        .iter()
        .map(|batch| batch["entries"].as_array().unwrap().len())
        .sum();
    assert_eq!(total, 5, "every entry ships, split over several batches");
    for batch in batches.lock().unwrap().iter() {
        assert!(serde_json::to_vec(batch).unwrap().len() <= 64 * 1024);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_202_counts_as_success() {
    let batches: Batches = Arc::new(Mutex::new(Vec::new()));
    let addr = spawn_ingest_with(batches.clone(), 0, StatusCode::ACCEPTED).await;
    let (shipper, handle) = LogShipper::start(control_plane(addr), "c3cf80c-42".to_string());
    shipper.configure(shipper_config(10));
    for index in 0..10 {
        shipper.push(entry(index));
    }
    wait_for(&batches, 1).await;
    // A re-queue would show up as a second batch carrying "line 0" again.
    shipper.push(entry(50));
    wait_for(&batches, 2).await;
    assert_eq!(batches.lock().unwrap()[1]["entries"][0]["msg"], "line 50");
    assert!(handle.flush(Duration::from_secs(3)).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn flush_before_configure_returns_promptly() {
    // The pre-manifest exit: the control plane is unreachable, `configure` never ran, entries
    // are queued from the agent's own tracing. The final flush must finish at once (exit 3 path).
    let unreachable: SocketAddr = "127.0.0.1:1".parse().unwrap();
    let (shipper, handle) = LogShipper::start(control_plane(unreachable), "c3cf80c-42".to_string());
    for index in 0..20 {
        shipper.push(entry(index));
    }
    let finished = tokio::time::timeout(
        Duration::from_secs(2),
        handle.flush(Duration::from_secs(10)),
    )
    .await
    .expect("the flush must not wait for its deadline");
    assert!(finished, "the batching task ends on its own");
    assert_eq!(
        shipper.dropped(),
        20,
        "unshippable entries are counted as dropped"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_entry_refused_alone_is_dropped_instead_of_poisoning_the_queue() {
    // A batch of one that the control plane answers 413 can never be made smaller: it used to be
    // re-queued at the head and re-sent forever, with every later line stuck behind it.
    let batches: Batches = Arc::new(Mutex::new(Vec::new()));
    let addr = spawn_ingest(batches.clone(), 1).await;
    let (shipper, handle) = LogShipper::start(control_plane(addr), "c3cf80c-42".to_string());
    shipper.configure(shipper_config(1));

    shipper.push(entry(0));
    wait_for(&batches, 1).await;
    shipper.push(entry(1));
    wait_for(&batches, 2).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let batches_seen = batches.lock().unwrap().clone();
    assert_eq!(batches_seen[0]["entries"][0]["msg"], "line 0");
    assert_eq!(
        batches_seen[1]["entries"][0]["msg"], "line 1",
        "the refused entry is not retried; the next line ships"
    );
    // Afterwards only the drop notice (`dropped 1 log lines`) may follow – never `line 0`.
    let later: Vec<String> = batches_seen
        .iter()
        .skip(2)
        .flat_map(|batch| batch["entries"].as_array().cloned().unwrap_or_default())
        .map(|entry| entry["msg"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(
        later.iter().all(|msg| msg != "line 0"),
        "the refused entry was re-sent: {later:?}"
    );
    assert!(
        later.iter().all(|msg| msg.starts_with("dropped ")),
        "unexpected batches after the drop: {later:?}"
    );
    assert_eq!(shipper.dropped(), 1);
    handle.flush(Duration::from_secs(3)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_413_halves_the_batch_and_nothing_is_lost() {
    let batches: Batches = Arc::new(Mutex::new(Vec::new()));
    let addr = spawn_ingest(batches.clone(), 1).await;
    let (shipper, handle) = LogShipper::start(control_plane(addr), "c3cf80c-42".to_string());
    shipper.configure(shipper_config(100));

    for index in 0..100 {
        shipper.push(entry(index));
    }
    wait_for(&batches, 2).await;
    let batches_seen = batches.lock().unwrap().clone();
    assert_eq!(batches_seen[0]["entries"].as_array().unwrap().len(), 100);
    let second = batches_seen[1]["entries"].as_array().unwrap().len();
    assert!(second <= 50, "the batch was halved after the 413: {second}");
    // The refused entries were re-queued, not dropped.
    assert_eq!(batches_seen[1]["entries"][0]["msg"], "line 0");
    handle.flush(Duration::from_secs(3)).await;
}
