//! The real `zs-agent` binary against `sandbox/image/test/fake-zed-remote-server.py` and an
//! in-process control plane (brief §6.2 `start_against_fake_server.rs`, cases (a)-(g) plus the
//! manifest-failure exit).
//!
//! Every test runs only under `ZS_RUN_START_INTEGRATION=1` (CI's `agent-tests` job sets it) and
//! needs `python3` and `git` on `PATH`; otherwise it prints why it skipped and passes. Each test
//! gets its own temp directories, ephemeral ports and mock, so they run in parallel.
//!
//! Linux-only assertions (the `/proc`-based port watcher and stale-server sweep, `cpuBusyPct`)
//! are gated on `cfg!(target_os = "linux")`; everything else runs on macOS too.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::net::{SocketAddr, TcpListener as StdTcpListener};
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use http_body_util::{BodyExt as _, Full};
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;
use tokio::net::TcpListener;

use zs_agent::bootstrap::sha256_hex;

const BUILD: &str = "itest-1";
const TOKEN: &str = "zsb_itest_token";
const PORT_SECRET_B64: &str = "SINHpxpbpVmePoUhJ6DCSY40C8VwRX/5opOCaKN2+/w=";
const SETTINGS_TEXT: &str = "// itest settings\n{ \"theme\": \"One Dark\" }";
const PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE8GjvHyuPnvZ9lAyi/2TFruWJOK1t\nWSAAU4HkCL/XnuFbMrND5mkdYD4lntedCo27L4Wu3AzMja+LcprGdOP4ug==\n-----END PUBLIC KEY-----\n";
const DEVCONTAINER: &str = r#"{
  "postCreateCommand": "sleep 3 && echo post-create > .post-create",
  "postStartCommand": "echo post-start > .post-start",
  "postAttachCommand": "echo post-attach > .post-attach",
  "forwardPorts": [3000],
  "portsAttributes": { "3000": { "label": "web", "visibility": "private" } },
  "customizations": { "zed": { "extensions": ["toml"] } }
}
"#;

fn enabled() -> bool {
    if std::env::var("ZS_RUN_START_INTEGRATION").as_deref() != Ok("1") {
        eprintln!("start_against_fake_server: ZS_RUN_START_INTEGRATION is not 1; skipping");
        return false;
    }
    for tool in ["python3", "git", "tar"] {
        if std::process::Command::new(tool)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| !status.success())
            .unwrap_or(true)
        {
            eprintln!("start_against_fake_server: {tool} is not available; skipping");
            return false;
        }
    }
    true
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn free_port() -> u16 {
    StdTcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_AUTHOR_NAME", "test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .expect("git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

// ---------------------------------------------------------------------------------------------
// The in-process control plane (the routes of sandbox/image/test/mock-control-plane.mjs).

#[derive(Default)]
struct Directive {
    idle_stop_at: Option<u64>,
    session_cap_at: Option<u64>,
    stop: bool,
}

struct Restore {
    tarball: Vec<u8>,
    sha256: Option<String>,
}

#[derive(Default)]
struct MockState {
    workspace_id: String,
    sandbox_name: String,
    user_id: String,
    clone_url: String,
    workspace_dir: String,
    origin: String,
    slots: Vec<u16>,
    prebuild: bool,
    manifest_status: u16,
    manifest_delay: Duration,
    restore: Option<Restore>,
    forwards: BTreeMap<u16, serde_json::Value>,
    directive: Directive,
    requests: Vec<(String, String)>,
    pings: Vec<serde_json::Value>,
    logs: Vec<serde_json::Value>,
    client_errors: Vec<serde_json::Value>,
    extensions: Vec<serde_json::Value>,
    restore_fetches: Vec<bool>,
    started_at: u64,
}

impl MockState {
    fn manifest(&self) -> serde_json::Value {
        let restore = self.restore.as_ref().map(|restore| {
            serde_json::json!({
                "tarballUrl": format!("{}/__blob/restore.tgz", self.origin),
                "sha256": restore.sha256,
            })
        });
        let prebuild = self.prebuild.then(|| {
            serde_json::json!({
                "id": self.workspace_id,
                "branch": "main",
                "commit": "0123456789abcdef0123456789abcdef01234567",
            })
        });
        serde_json::json!({
            "version": 1,
            "workspaceId": self.workspace_id,
            "sandboxName": self.sandbox_name,
            "sandboxGeneration": 1,
            "userId": self.user_id,
            "build": BUILD,
            "region": "local",
            "repo": {
                "owner": "acme",
                "name": "fixture",
                "cloneUrl": self.clone_url,
                "defaultBranch": "main",
                "revision": "main",
                "depth": 0,
                "ref": null,
            },
            "workspaceDir": self.workspace_dir,
            "restore": restore,
            "dotfiles": null,
            "env": { "ZS_WORKSPACE_ID": self.workspace_id, "ZS_REGION": "local", "NODE_ENV": "development" },
            "secretNames": [],
            "jwt": { "issuer": "zs", "audience": self.sandbox_name, "publicKeys": [PUBLIC_KEY_PEM] },
            "portSessionSecret": PORT_SECRET_B64,
            "proxySlots": self.slots,
            "forwards": self.forwards.values().cloned().collect::<Vec<_>>(),
            "portPool": [3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888],
            "idle": { "minutes": 30 },
            "session": {
                "id": "ses_itest",
                "startedAt": self.started_at,
                "capAt": self.started_at + 24 * 3600 * 1000,
                "resumed": false,
            },
            "devcontainer": null,
            "settings": { "settings": SETTINGS_TEXT, "keymap": "[]" },
            "logs": { "flushIntervalSecs": 1, "maxBatch": 200, "maxBatchBytes": 262144 },
            "activity": { "intervalSecs": 10 },
            "allowedOrigins": [self.origin],
            "extensions": ["toml"],
            "prebuild": prebuild,
        })
    }

    fn forward(
        &mut self,
        port: u16,
        visibility: &str,
        label: Option<String>,
    ) -> Result<serde_json::Value, (u16, &'static str)> {
        if port == 0 || (8443..=8451).contains(&port) {
            return Err((400, "invalid_port"));
        }
        if let Some(existing) = self.forwards.get(&port)
            && existing["visibility"] == visibility
        {
            return Ok(existing.clone());
        }
        let forward = if visibility == "private" {
            let used: Vec<u16> = self
                .forwards
                .values()
                .filter_map(|f| f["slot"].as_u64())
                .map(|slot| slot as u16)
                .collect();
            let Some(slot) = self.slots.iter().find(|slot| !used.contains(slot)) else {
                return Err((409, "slots_exhausted"));
            };
            serde_json::json!({
                "port": port,
                "visibility": "private",
                "label": label,
                "url": format!("{}/api/workspaces/{}/ports/{port}/open", self.origin, self.workspace_id),
                "slot": slot,
            })
        } else {
            serde_json::json!({
                "port": port,
                "visibility": "public",
                "label": label,
                "url": format!("http://127.0.0.1:{port}"),
                "slot": null,
            })
        };
        self.forwards.insert(port, forward.clone());
        Ok(forward)
    }

    fn directive(&self) -> serde_json::Value {
        let now = now_ms();
        serde_json::json!({
            "idleStopAt": self.directive.idle_stop_at.unwrap_or(now + 30 * 60 * 1000),
            "sessionCapAt": self.directive.session_cap_at.unwrap_or(self.started_at + 24 * 3600 * 1000),
            "stop": self.directive.stop,
            "forwards": self.forwards.values().cloned().collect::<Vec<_>>(),
            "serverTime": now,
        })
    }
}

type Shared = Arc<Mutex<MockState>>;

fn json(status: StatusCode, value: serde_json::Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(serde_json::to_vec(&value).unwrap())));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    response
}

fn error(status: u16, code: &str) -> Response<Full<Bytes>> {
    json(
        StatusCode::from_u16(status).unwrap(),
        serde_json::json!({ "error": { "code": code, "message": code } }),
    )
}

fn empty(status: StatusCode) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
}

async fn handle_mock(
    state: Shared,
    parts: http::request::Parts,
    body: Bytes,
) -> Response<Full<Bytes>> {
    let method = parts.method.as_str().to_string();
    let path = parts.uri.path().to_string();
    let parsed: serde_json::Value =
        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    let authorized = parts
        .headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some(&format!("Bearer {TOKEN}"));
    {
        let mut state = state.lock().unwrap();
        state.requests.push((method.clone(), path.clone()));
    }

    if path == "/__blob/restore.tgz" {
        let has_credentials = parts.headers.contains_key("authorization")
            || parts.headers.contains_key("x-vercel-protection-bypass");
        let mut state = state.lock().unwrap();
        state.restore_fetches.push(has_credentials);
        if has_credentials {
            return error(400, "unexpected_credentials");
        }
        return match &state.restore {
            Some(restore) => {
                let mut response = Response::new(Full::new(Bytes::from(restore.tarball.clone())));
                response
                    .headers_mut()
                    .insert("content-type", "application/gzip".parse().unwrap());
                response
            }
            None => error(404, "not_found"),
        };
    }

    let sandbox_name = state.lock().unwrap().sandbox_name.clone();
    let prefix = format!("/api/sandboxes/{sandbox_name}/");
    let Some(rest) = path.strip_prefix(&prefix).map(str::to_string) else {
        return error(404, "not_found");
    };
    if !authorized {
        return error(401, "unauthenticated");
    }
    match (method.as_str(), rest.as_str()) {
        ("GET", "manifest") => {
            let (status, delay, manifest) = {
                let state = state.lock().unwrap();
                (
                    state.manifest_status,
                    state.manifest_delay,
                    state.manifest(),
                )
            };
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            if status != 200 {
                return error(status, "manifest_unavailable");
            }
            json(StatusCode::OK, manifest)
        }
        ("POST", "git-token") => {
            if parsed["host"]
                .as_str()
                .is_some_and(|host| host != "github.com")
            {
                return error(404, "host_unsupported");
            }
            json(
                StatusCode::OK,
                serde_json::json!({
                    "username": "x-access-token",
                    "token": "ghs_mock",
                    "expiresAt": now_ms() / 1000 + 3600,
                }),
            )
        }
        ("POST", "ports") => {
            let port = parsed["port"].as_u64().unwrap_or(0) as u16;
            let visibility = if parsed["visibility"] == "public" {
                "public"
            } else {
                "private"
            };
            let label = parsed["label"].as_str().map(str::to_string);
            match state.lock().unwrap().forward(port, visibility, label) {
                Ok(forward) => json(
                    StatusCode::OK,
                    serde_json::json!({ "url": forward["url"], "visibility": forward["visibility"], "slot": forward["slot"] }),
                ),
                Err((status, code)) => error(status, code),
            }
        }
        ("DELETE", rest) if rest.starts_with("ports/") => {
            if let Ok(port) = rest.trim_start_matches("ports/").parse::<u16>() {
                state.lock().unwrap().forwards.remove(&port);
            }
            empty(StatusCode::NO_CONTENT)
        }
        ("POST", "activity") => {
            let mut state = state.lock().unwrap();
            state.pings.push(parsed);
            json(StatusCode::OK, state.directive())
        }
        ("POST", "logs") => {
            if body.len() > 262_144 {
                return error(413, "payload_too_large");
            }
            let mut state = state.lock().unwrap();
            if let Some(entries) = parsed["entries"].as_array() {
                state.logs.extend(entries.iter().cloned());
            }
            empty(StatusCode::NO_CONTENT)
        }
        ("POST", "client-errors") => {
            state.lock().unwrap().client_errors.push(parsed);
            json(
                StatusCode::ACCEPTED,
                serde_json::json!({ "accepted": true }),
            )
        }
        ("POST", "extensions") => {
            state.lock().unwrap().extensions.push(parsed);
            empty(StatusCode::NO_CONTENT)
        }
        _ => error(404, "not_found"),
    }
}

async fn spawn_mock(state: Shared) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let state = state.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req: Request<hyper::body::Incoming>| {
                    let state = state.clone();
                    async move {
                        let (parts, body) = req.into_parts();
                        let bytes = body
                            .collect()
                            .await
                            .map(|collected| collected.to_bytes())
                            .unwrap_or_default();
                        Ok::<_, Infallible>(handle_mock(state, parts, bytes).await)
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

/// A TCP listener that accepts and never answers: a `git fetch` against it blocks forever.
async fn spawn_black_hole() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((stream, _)) = listener.accept().await {
            held.push(stream);
        }
    });
    addr
}

// ---------------------------------------------------------------------------------------------
// One sandbox: temp directories, ephemeral ports, fixture repository, the mock and the agent.

struct Ports {
    health: u16,
    local: u16,
    rpc: u16,
    control: u16,
    slots: [u16; 4],
}

struct Sandbox {
    _dir: tempfile::TempDir,
    root: PathBuf,
    mock: Shared,
    mock_addr: SocketAddr,
    ports: Ports,
    fixture_sha: String,
    client: reqwest::Client,
    runs: usize,
}

struct Agent {
    child: tokio::process::Child,
    pid: u32,
    stderr_path: PathBuf,
    server_pid: Arc<Mutex<Option<u32>>>,
}

impl Drop for Agent {
    fn drop(&mut self) {
        // Best effort on a failed test: the agent is its own group leader, the server its own.
        let _ = killpg(Pid::from_raw(self.pid as i32), Signal::SIGKILL);
        if let Some(pid) = *self.server_pid.lock().unwrap() {
            let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
        }
    }
}

impl Agent {
    fn stderr(&self) -> String {
        std::fs::read_to_string(&self.stderr_path).unwrap_or_default()
    }

    fn sigterm(&self) {
        kill(Pid::from_raw(self.pid as i32), Signal::SIGTERM).expect("SIGTERM the agent");
    }

    async fn wait_exit(&mut self, budget: Duration) -> Option<i32> {
        match tokio::time::timeout(budget, self.child.wait()).await {
            Ok(Ok(status)) => status.code(),
            Ok(Err(error)) => panic!("waiting for the agent: {error}"),
            Err(_) => {
                let _ = self.child.start_kill();
                panic!(
                    "the agent did not exit within {budget:?}; stderr tail:\n{}",
                    tail(&self.stderr(), 40)
                );
            }
        }
    }
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    all[start..].join("\n")
}

impl Sandbox {
    async fn new(prebuild: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        for sub in ["home", "state", "data", "workspaces", "seed"] {
            std::fs::create_dir_all(root.join(sub)).unwrap();
        }
        // Fixture repository: one commit with a devcontainer and two probe files.
        let seed = root.join("seed");
        std::fs::create_dir_all(seed.join(".devcontainer")).unwrap();
        std::fs::write(seed.join(".devcontainer/devcontainer.json"), DEVCONTAINER).unwrap();
        std::fs::write(seed.join("main.rs"), "fn main() { println!(\"hello\"); }\n").unwrap();
        std::fs::write(
            seed.join("app.py"),
            "def hello() -> str:\n    return 'hello'\n",
        )
        .unwrap();
        git(&seed, &["init", "-q", "-b", "main", "."]);
        git(&seed, &["add", "-A"]);
        git(
            &seed,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "fixture"],
        );
        let fixture_sha = git(&seed, &["rev-parse", "HEAD"]);
        let bare = root.join("fixture.git");
        git(
            &root,
            &[
                "clone",
                "-q",
                "--bare",
                seed.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );

        // The supervisor builds the server command line itself; extra flags travel in a wrapper.
        let fake = repo_root().join("sandbox/image/test/fake-zed-remote-server.py");
        assert!(fake.is_file(), "{} is missing", fake.display());
        let state_file = root.join("fake-state.json");
        std::fs::write(
            root.join("fake-server.sh"),
            format!(
                "#!/bin/sh\nexec python3 {} \"$@\" --state-file {} $ZS_FAKE_EXTRA_FLAGS\n",
                fake.display(),
                state_file.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(
            root.join("fake-server.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        let ports = Ports {
            health: free_port(),
            local: free_port(),
            rpc: free_port(),
            control: free_port(),
            slots: [free_port(), free_port(), free_port(), free_port()],
        };
        let (workspace_id, sandbox_name, user_id) = if prebuild {
            ("pb_itest", "pb-itest", "system")
        } else {
            ("ws_itest", "sb-itest", "user_itest")
        };
        let mock: Shared = Arc::new(Mutex::new(MockState {
            workspace_id: workspace_id.to_string(),
            sandbox_name: sandbox_name.to_string(),
            user_id: user_id.to_string(),
            clone_url: format!("file://{}", bare.display()),
            workspace_dir: root
                .join("workspaces/fixture")
                .to_string_lossy()
                .into_owned(),
            slots: ports.slots.to_vec(),
            prebuild,
            manifest_status: 200,
            started_at: now_ms(),
            ..MockState::default()
        }));
        let mock_addr = spawn_mock(mock.clone()).await;
        mock.lock().unwrap().origin = format!("http://{mock_addr}");
        Self {
            _dir: dir,
            root,
            mock,
            mock_addr,
            ports,
            fixture_sha,
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            runs: 0,
        }
    }

    fn workspace(&self) -> PathBuf {
        self.root.join("workspaces/fixture")
    }

    fn state_dir(&self) -> PathBuf {
        self.root.join("state")
    }

    fn env(&self) -> BTreeMap<String, String> {
        let mock = self.mock.lock().unwrap();
        // Without SHELL/USER/LANG the D28 fill is what the server sees (the image sets them;
        // a developer's login shell must not leak into the assertion).
        let mut env: BTreeMap<String, String> = std::env::vars()
            .filter(|(key, _)| {
                !key.starts_with("ZS_")
                    && !matches!(key.as_str(), "RUST_LOG" | "SHELL" | "USER" | "LANG")
            })
            .collect();
        for (key, value) in [
            ("ZS_CONTROL_URL", format!("http://{}/api", self.mock_addr)),
            ("ZS_SANDBOX_TOKEN", TOKEN.to_string()),
            ("ZS_SANDBOX_NAME", mock.sandbox_name.clone()),
            ("ZS_WORKSPACE_ID", mock.workspace_id.clone()),
            ("ZS_REGION", "local".to_string()),
            ("ZS_BUILD_ID", BUILD.to_string()),
            (
                "ZS_SERVER_BIN",
                self.root
                    .join("fake-server.sh")
                    .to_string_lossy()
                    .into_owned(),
            ),
            (
                "ZS_WORKSPACES_DIR",
                self.root.join("workspaces").to_string_lossy().into_owned(),
            ),
            (
                "ZS_STATE_DIR",
                self.state_dir().to_string_lossy().into_owned(),
            ),
            (
                "ZS_DATA_DIR",
                self.root.join("data").to_string_lossy().into_owned(),
            ),
            (
                "HOME",
                self.root.join("home").to_string_lossy().into_owned(),
            ),
            (
                "ZS_HEALTH_LISTEN",
                format!("127.0.0.1:{}", self.ports.health),
            ),
            (
                "ZS_LOCAL_API_LISTEN",
                format!("127.0.0.1:{}", self.ports.local),
            ),
            ("ZS_RPC_LISTEN", format!("127.0.0.1:{}", self.ports.rpc)),
            (
                "ZS_SERVER_CONTROL_LISTEN",
                format!("127.0.0.1:{}", self.ports.control),
            ),
            ("ZS_PROXY_BIND_IP", "127.0.0.1".to_string()),
            (
                "ZS_PROXY_SLOTS",
                self.ports
                    .slots
                    .iter()
                    .map(u16::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
            ),
            ("ZS_INSECURE_COOKIES", "1".to_string()),
            ("RUST_LOG", "info".to_string()),
            ("GIT_CONFIG_GLOBAL", "/dev/null".to_string()),
            ("GIT_CONFIG_SYSTEM", "/dev/null".to_string()),
        ] {
            env.insert(key.to_string(), value);
        }
        if mock.prebuild {
            env.insert("ZS_PREBUILD".to_string(), "1".to_string());
        }
        env
    }

    fn spawn(&mut self, subcommand: &str, extra: &[(&str, &str)]) -> Agent {
        self.runs += 1;
        let stderr_path = self
            .root
            .join(format!("agent-{}-{subcommand}.stderr", self.runs));
        let stdout_path = self
            .root
            .join(format!("agent-{}-{subcommand}.stdout", self.runs));
        let mut env = self.env();
        for (key, value) in extra {
            env.insert((*key).to_string(), (*value).to_string());
        }
        let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_zs-agent"))
            .arg(subcommand)
            .env_clear()
            .envs(&env)
            .stdin(Stdio::null())
            .stdout(std::fs::File::create(&stdout_path).unwrap())
            .stderr(std::fs::File::create(&stderr_path).unwrap())
            .process_group(0)
            .kill_on_drop(false)
            .spawn()
            .expect("spawn zs-agent");
        let pid = child.id().expect("pid");
        Agent {
            child,
            pid,
            stderr_path,
            server_pid: Arc::new(Mutex::new(None)),
        }
    }

    /// `GET 127.0.0.1:<local>/health` – the full loopback body, or `None` while unreachable.
    async fn health(&self, agent: &Agent) -> Option<(StatusCode, serde_json::Value)> {
        let response = self
            .client
            .get(format!("http://127.0.0.1:{}/health", self.ports.local))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .ok()?;
        let status = response.status();
        let body: serde_json::Value = response.json().await.ok()?;
        if let Some(pid) = body["server"]["pid"].as_u64() {
            *agent.server_pid.lock().unwrap() = Some(pid as u32);
        }
        Some((status, body))
    }

    /// Polls the loopback health (100 ms pauses, D29-style bounded polling) until `predicate`
    /// holds; panics with the agent's stderr tail when `budget` passes.
    async fn wait_health(
        &self,
        agent: &Agent,
        what: &str,
        budget: Duration,
        predicate: impl Fn(&serde_json::Value) -> bool,
    ) -> serde_json::Value {
        let deadline = Instant::now() + budget;
        let mut last = None;
        while Instant::now() < deadline {
            if let Some((_, body)) = self.health(agent).await {
                if predicate(&body) {
                    return body;
                }
                last = Some(body);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!(
            "waited {budget:?} for {what}; last health: {last:?}\nagent stderr tail:\n{}",
            tail(&agent.stderr(), 40)
        );
    }

    async fn fake_state(&self) -> Option<serde_json::Value> {
        self.client
            .get(format!("http://127.0.0.1:{}/__fake/state", self.ports.rpc))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()
    }

    fn fake_state_file(&self) -> serde_json::Value {
        let path = self.root.join("fake-state.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        serde_json::from_str(&text).expect("fake state json")
    }

    async fn fake_post(&self, path: &str) {
        self.client
            .post(format!("http://127.0.0.1:{}{path}", self.ports.rpc))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .expect("fake hook");
    }

    /// Polls an async `probe` (100 ms pauses) until it yields a value; panics with the agent's
    /// stderr tail when `budget` passes.
    async fn wait_for<T, Fut>(
        &self,
        agent: &Agent,
        what: &str,
        budget: Duration,
        mut probe: impl FnMut() -> Fut,
    ) -> T
    where
        Fut: Future<Output = Option<T>>,
    {
        let deadline = Instant::now() + budget;
        while Instant::now() < deadline {
            if let Some(value) = probe().await {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!(
            "waited {budget:?} for {what}\nagent stderr tail:\n{}",
            tail(&agent.stderr(), 40)
        );
    }

    fn lifecycle_kinds(state: &serde_json::Value) -> Vec<String> {
        state["recorded"]["lifecycle"]
            .as_array()
            .map(|notices| {
                notices
                    .iter()
                    .filter_map(|notice| notice["kind"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn alive(pid: u32) -> bool {
    kill(Pid::from_raw(pid as i32), None).is_ok()
}

// ---------------------------------------------------------------------------------------------

/// Case (a): the happy path from listeners-first through clone, server, lifecycle commands,
/// forwards, notices, postAttach and the stop sequence, then a resume on the same state dir.
#[tokio::test(flavor = "multi_thread")]
async fn start_boots_clones_serves_and_stops_cleanly() {
    if !enabled() {
        return;
    }
    let mut sandbox = Sandbox::new(false).await;
    sandbox.mock.lock().unwrap().manifest_delay = Duration::from_millis(1500);
    let mut agent = sandbox.spawn("start", &[]);

    // Listeners come up before the manifest: the first answer is a 503 with `phase: manifest`.
    let first = sandbox
        .wait_for(
            &agent,
            "the health listener",
            Duration::from_secs(10),
            || async { sandbox.health(&agent).await },
        )
        .await;
    assert_eq!(first.0, StatusCode::SERVICE_UNAVAILABLE, "{:?}", first.1);
    assert_eq!(first.1["status"], "booting");
    assert_eq!(first.1["phase"], "manifest");
    assert!(first.1.get("lastError").is_none() || first.1["lastError"].is_null());

    // The server is up while postCreateCommand (3 s) is still running, with `busy` reported.
    let during = sandbox
        .wait_health(
            &agent,
            "the server beside postCreate",
            Duration::from_secs(30),
            |body| {
                body["server"]["running"] == true
                    && body["phase"] == "post_create"
                    && body["busy"] == true
            },
        )
        .await;
    assert_eq!(during["status"], "ready", "{during}");
    assert_eq!(during["server"]["health"]["build"], BUILD);

    let ready = sandbox
        .wait_health(&agent, "phase ready", Duration::from_secs(30), |body| {
            body["phase"] == "ready" && body["busy"] == false
        })
        .await;
    assert_eq!(ready["status"], "ready");
    assert!(ready["proxy"]["running"].as_bool().unwrap(), "{ready}");

    // The checkout and the lifecycle commands.
    let workspace = sandbox.workspace();
    assert_eq!(git(&workspace, &["rev-parse", "HEAD"]), sandbox.fixture_sha);
    assert!(sandbox.state_dir().join("markers/clone.done").is_file());
    assert_eq!(
        std::fs::read_to_string(workspace.join(".post-create"))
            .unwrap()
            .trim(),
        "post-create"
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join(".post-start"))
            .unwrap()
            .trim(),
        "post-start"
    );
    let marker =
        std::fs::read_to_string(sandbox.state_dir().join("markers/post-create.done")).unwrap();
    assert!(marker.starts_with("sha256:"), "{marker}");
    assert!(
        sandbox
            .state_dir()
            .join("markers/first-boot.done")
            .is_file()
    );
    assert_eq!(
        std::fs::read_to_string(sandbox.root.join("home/.config/zed/settings.json")).unwrap(),
        SETTINGS_TEXT
    );

    // What the fake server was started with (D18, D28, D5).
    let fake = sandbox.fake_state().await.expect("fake state");
    let argv = fake["argv"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    for flag in [
        "--control-secret-file",
        "--control-listen",
        "--supervisor-url",
        "--allowed-origin",
        "--client-build itest-1",
    ] {
        assert!(argv.contains(flag), "argv lacks {flag}: {argv}");
    }
    let env = &fake["env"];
    for absent in [
        "ZS_CONTROL_SECRET",
        "ZS_SANDBOX_TOKEN",
        "ZS_CONTROL_URL",
        "ZS_BYPASS_SECRET",
    ] {
        assert!(
            env.get(absent).is_none(),
            "{absent} reached the server: {env}"
        );
    }
    let secret_file = PathBuf::from(
        env["ZS_CONTROL_SECRET_FILE"]
            .as_str()
            .expect("ZS_CONTROL_SECRET_FILE"),
    );
    assert_eq!(secret_file, sandbox.state_dir().join("run/control.secret"));
    assert_eq!(
        std::fs::metadata(&secret_file)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(env["SHELL"], "/bin/bash", "D28: SHELL filled when missing");
    assert_eq!(
        env["USER"],
        zs_agent::config::runtime_user_name(),
        "D28: USER filled when missing (the runtime user; `ubuntu` in the image)"
    );
    assert_eq!(env["LANG"], "C.UTF-8", "D28: LANG filled when missing");
    assert!(env["PATH"].as_str().is_some_and(|path| !path.is_empty()));
    assert_eq!(
        env["ZS_SUPERVISOR_URL"],
        format!("http://127.0.0.1:{}", sandbox.ports.local)
    );
    assert_eq!(
        env["NODE_ENV"], "development",
        "manifest.env literals reach the server"
    );
    let extensions = &fake["recorded"]["extensions"];
    assert_eq!(
        extensions[0]["install"],
        serde_json::json!(["toml"]),
        "{extensions}"
    );

    // The devcontainer's forwardPorts entry was requested through the control plane.
    {
        let mock = sandbox.mock.lock().unwrap();
        let forward = mock.forwards.get(&3000).expect("port 3000 forwarded");
        assert_eq!(forward["visibility"], "private");
        assert_eq!(forward["slot"], sandbox.ports.slots[0]);
        assert_eq!(forward["label"], "web");
    }
    if cfg!(target_os = "linux") {
        // The port watcher republishes the table to the server on every forwards change.
        let fake = sandbox
            .wait_for(
                &agent,
                "/control/ports with the forward",
                Duration::from_secs(10),
                || async {
                    sandbox.fake_state().await.filter(|state| {
                        state["recorded"]["ports"].as_array().is_some_and(|posts| {
                            posts.iter().any(|post| {
                                post["forwards"]
                                    .as_array()
                                    .is_some_and(|f| f.iter().any(|x| x["port"] == 3000))
                            })
                        })
                    })
                },
            )
            .await;
        assert!(!fake["recorded"]["ports"].as_array().unwrap().is_empty());
    }

    // Pings started before the clone finished and carry the D13 fields.
    {
        let mock = sandbox.mock.lock().unwrap();
        assert!(!mock.pings.is_empty(), "no activity ping arrived");
        let first = &mock.pings[0];
        assert_ne!(
            first["phase"], "ready",
            "the first ping predates readiness: {first}"
        );
        assert!(
            first["lastInputAt"].is_u64(),
            "bootstrapping counts as active: {first}"
        );
        assert!(first["busy"].is_boolean());
        assert!(first["agentUptimeSecs"].is_u64());
        if cfg!(target_os = "linux") && mock.pings.len() >= 2 {
            assert!(mock.pings[1]["cpuBusyPct"].is_number(), "{}", mock.pings[1]);
        }
    }

    // A directive with an idle deadline inside the lead produces exactly one notice.
    sandbox.mock.lock().unwrap().directive.idle_stop_at = Some(now_ms() + 200_000);
    let fake = sandbox
        .wait_for(
            &agent,
            "the idle_stop_in notice",
            Duration::from_secs(20),
            || async {
                sandbox.fake_state().await.filter(|state| {
                    Sandbox::lifecycle_kinds(state)
                        .iter()
                        .any(|k| k == "idle_stop_in")
                })
            },
        )
        .await;
    let seconds = fake["recorded"]["lifecycle"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["kind"] == "idle_stop_in")
        .and_then(|n| n["seconds"].as_u64())
        .unwrap();
    assert!((150..=200).contains(&seconds), "seconds = {seconds}");
    let pings_then = sandbox.mock.lock().unwrap().pings.len();
    // The first attached session runs postAttachCommand (from its own task).
    sandbox.fake_post("/__fake/attach").await;
    sandbox
        .wait_for(
            &agent,
            "two more pings",
            Duration::from_secs(30),
            || async { (sandbox.mock.lock().unwrap().pings.len() >= pings_then + 2).then_some(()) },
        )
        .await;
    let fake = sandbox.fake_state().await.unwrap();
    let idle_notices = Sandbox::lifecycle_kinds(&fake)
        .iter()
        .filter(|k| *k == "idle_stop_in")
        .count();
    assert_eq!(
        idle_notices,
        1,
        "one notice per deadline: {:?}",
        Sandbox::lifecycle_kinds(&fake)
    );
    sandbox
        .wait_for(&agent, ".post-attach", Duration::from_secs(15), || async {
            workspace.join(".post-attach").is_file().then_some(())
        })
        .await;
    let after_attach = sandbox.mock.lock().unwrap().pings.last().cloned().unwrap();
    assert_eq!(after_attach["sessionActive"], true, "{after_attach}");
    assert_eq!(after_attach["sid"], "ses_fake", "{after_attach}");

    // The stop sequence: stopping notice, then SIGTERM, exit 0 quickly, final log batch.
    let stop_started = Instant::now();
    agent.sigterm();
    assert_eq!(
        agent.wait_exit(Duration::from_secs(15)).await,
        Some(0),
        "{}",
        tail(&agent.stderr(), 40)
    );
    assert!(
        stop_started.elapsed() < Duration::from_secs(12),
        "stop took {:?}",
        stop_started.elapsed()
    );
    let fake = sandbox.fake_state_file();
    let stopping_at = fake["timeline"]["stopping_at"]
        .as_u64()
        .expect("stopping recorded");
    let sigterm_at = fake["timeline"]["sigterm_at"]
        .as_u64()
        .expect("SIGTERM recorded");
    assert!(
        stopping_at <= sigterm_at,
        "stopping {stopping_at} before SIGTERM {sigterm_at}"
    );
    assert!(!sandbox.state_dir().join("run/zs-agent.pid").exists());
    assert!(!sandbox.state_dir().join("run/control.secret").exists());
    {
        let mock = sandbox.mock.lock().unwrap();
        assert!(
            mock.logs
                .iter()
                .any(|entry| entry["source"] == "agent" && entry["msg"] == "shutdown complete"),
            "the final batch carries 'shutdown complete' ({} entries)",
            mock.logs.len()
        );
        assert!(
            mock.logs
                .iter()
                .any(|entry| entry["source"] == "server:fake_zed_remote_server")
        );
        assert!(
            mock.logs
                .iter()
                .any(|entry| entry["source"] == "post_start" || entry["source"] == "agent")
        );
        assert!(
            mock.client_errors.is_empty(),
            "a clean stop is not a crash: {:?}",
            mock.client_errors
        );
    }
    let stderr = agent.stderr();
    assert!(!stderr.contains("server exited; restarting"), "{stderr}");

    // Resume on the same state directory: no clone, a `resumed` notice, exit 0 again.
    let mut agent = sandbox.spawn("resume", &[]);
    sandbox
        .wait_health(
            &agent,
            "phase ready after resume",
            Duration::from_secs(30),
            |body| body["phase"] == "ready" && body["resumed"] == true,
        )
        .await;
    let fake = sandbox
        .wait_for(
            &agent,
            "the resumed notice",
            Duration::from_secs(10),
            || async {
                sandbox.fake_state().await.filter(|state| {
                    Sandbox::lifecycle_kinds(state)
                        .iter()
                        .any(|k| k == "resumed")
                })
            },
        )
        .await;
    assert_eq!(
        Sandbox::lifecycle_kinds(&fake)
            .iter()
            .filter(|k| *k == "resumed")
            .count(),
        1
    );
    assert!(
        agent
            .stderr()
            .contains("workspace checkout already present")
    );
    assert_eq!(git(&workspace, &["rev-parse", "HEAD"]), sandbox.fixture_sha);
    agent.sigterm();
    assert_eq!(agent.wait_exit(Duration::from_secs(15)).await, Some(0));
}

/// Case (b): a SIGTERM while `git fetch` blocks leaves no checkout, no `.partial`, exit 0.
#[tokio::test(flavor = "multi_thread")]
async fn sigterm_during_the_clone_leaves_nothing_behind() {
    if !enabled() {
        return;
    }
    let mut sandbox = Sandbox::new(false).await;
    let black_hole = spawn_black_hole().await;
    sandbox.mock.lock().unwrap().clone_url = format!("http://{black_hole}/fixture.git");
    let mut agent = sandbox.spawn("start", &[]);
    sandbox
        .wait_health(&agent, "phase clone", Duration::from_secs(15), |body| {
            body["phase"] == "clone"
        })
        .await;
    // Let git get as far as the blocking fetch.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    agent.sigterm();
    assert_eq!(
        agent.wait_exit(Duration::from_secs(10)).await,
        Some(0),
        "{}",
        tail(&agent.stderr(), 40)
    );
    assert!(
        !sandbox.workspace().exists(),
        "the workspace dir must not exist"
    );
    assert!(
        !sandbox.root.join("workspaces/fixture.partial").exists(),
        ".partial must be gone"
    );
    assert!(!sandbox.state_dir().join("markers/clone.done").exists());
    assert!(
        agent.stderr().contains("stopped during the checkout"),
        "{}",
        tail(&agent.stderr(), 20)
    );

    // A second start with a reachable repository clones cleanly.
    let bare = sandbox.root.join("fixture.git");
    sandbox.mock.lock().unwrap().clone_url = format!("file://{}", bare.display());
    let mut agent = sandbox.spawn("start", &[]);
    sandbox
        .wait_health(&agent, "phase ready", Duration::from_secs(30), |body| {
            body["phase"] == "ready"
        })
        .await;
    assert_eq!(
        git(&sandbox.workspace(), &["rev-parse", "HEAD"]),
        sandbox.fixture_sha
    );
    agent.sigterm();
    assert_eq!(agent.wait_exit(Duration::from_secs(15)).await, Some(0));
}

/// Case (c), Linux only (`/proc`): a server left behind by a previous agent is swept – process
/// group and all – before ours is spawned.
#[tokio::test(flavor = "multi_thread")]
async fn a_stale_server_is_swept_before_the_boot() {
    if !enabled() {
        return;
    }
    if !cfg!(target_os = "linux") {
        eprintln!("stale-server sweep needs /proc; skipping on this platform");
        return;
    }
    let mut sandbox = Sandbox::new(false).await;
    let secret_file = sandbox.root.join("stale.secret");
    std::fs::write(&secret_file, "stale-secret").unwrap();
    let stale_state = sandbox.root.join("stale-state.json");
    let fake = repo_root().join("sandbox/image/test/fake-zed-remote-server.py");
    let mut stale = tokio::process::Command::new("python3")
        .arg(&fake)
        .args([
            "serve",
            "--listen",
            &format!("127.0.0.1:{}", sandbox.ports.rpc),
            "--control-listen",
            &format!("127.0.0.1:{}", sandbox.ports.control),
            "--control-secret-file",
            secret_file.to_str().unwrap(),
            "--linger-child",
            "--state-file",
            stale_state.to_str().unwrap(),
        ])
        .env_remove("ZS_CONTROL_SECRET")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the stale fake");
    let stale_pid = stale.id().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let linger_pid = loop {
        if let Ok(text) = std::fs::read_to_string(&stale_state)
            && let Ok(state) = serde_json::from_str::<serde_json::Value>(&text)
            && let Some(pid) = state["lingerChildPid"].as_u64()
        {
            break pid as u32;
        }
        assert!(
            Instant::now() < deadline,
            "the stale fake never wrote its state"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(alive(linger_pid));

    let mut agent = sandbox.spawn("start", &[]);
    let ready = sandbox
        .wait_health(&agent, "phase ready", Duration::from_secs(40), |body| {
            body["phase"] == "ready"
        })
        .await;
    assert_ne!(ready["server"]["pid"].as_u64().unwrap() as u32, stale_pid);
    assert_eq!(ready["server"]["running"], true);
    let stderr = agent.stderr();
    assert!(
        stderr.contains("stale_server_killed"),
        "{}",
        tail(&stderr, 30)
    );
    // The stale fake was killed by group: reap it here, then its sleep child must be gone.
    let _ = tokio::time::timeout(Duration::from_secs(5), stale.wait()).await;
    sandbox
        .wait_for(
            &agent,
            "the lingering sleep to die",
            Duration::from_secs(10),
            || async { (!alive(linger_pid)).then_some(()) },
        )
        .await;
    agent.sigterm();
    assert_eq!(agent.wait_exit(Duration::from_secs(15)).await, Some(0));
}

/// Case (d): a crashed server is swept (its orphan child included), reported to
/// `/client-errors` from the background, and respawned; six crashes trip the crash loop.
#[tokio::test(flavor = "multi_thread")]
async fn a_crashed_server_is_respawned_and_the_crash_loop_trips() {
    if !enabled() {
        return;
    }
    let mut sandbox = Sandbox::new(false).await;
    let mut agent = sandbox.spawn("start", &[("ZS_FAKE_EXTRA_FLAGS", "--linger-child")]);
    sandbox
        .wait_health(&agent, "phase ready", Duration::from_secs(30), |body| {
            body["phase"] == "ready"
        })
        .await;

    let mut crash_loop_seen = false;
    for round in 1..=6u64 {
        // Right after a respawn `running` flips before the fake has bound its listener.
        let fake = sandbox
            .wait_for(
                &agent,
                "the fake to answer before the crash",
                Duration::from_secs(15),
                || async { sandbox.fake_state().await },
            )
            .await;
        let linger = fake["lingerChildPid"].as_u64().expect("linger child pid") as u32;
        let old_pid = fake["pid"].as_u64().unwrap() as u32;
        assert!(
            alive(linger),
            "round {round}: linger child should be alive before the crash"
        );
        sandbox.fake_post("/__fake/crash").await;
        // Every crash bumps `restarts` by one: the round number is the expected count.
        let health = sandbox
            .wait_health(
                &agent,
                &format!("crash {round} handled"),
                Duration::from_secs(60),
                |body| {
                    body["server"]["restarts"].as_u64() == Some(round)
                        && (body["server"]["crashLoop"] == true
                            || (body["server"]["running"] == true
                                && body["server"]["pid"]
                                    .as_u64()
                                    .is_some_and(|pid| pid as u32 != old_pid)))
                },
            )
            .await;
        sandbox
            .wait_for(
                &agent,
                "the orphan child to be swept",
                Duration::from_secs(10),
                || async { (!alive(linger)).then_some(()) },
            )
            .await;
        if health["server"]["crashLoop"] == true {
            crash_loop_seen = true;
            assert_eq!(
                round, 6,
                "the crash loop trips on the sixth exit, not earlier"
            );
            assert_eq!(health["status"], "degraded");
            assert_eq!(health["lastError"], "server_crash_loop");
            assert_eq!(health["server"]["running"], false);
            break;
        }
        if round == 1 {
            // The report is posted in the background; it must arrive without delaying the respawn.
            sandbox
                .wait_for(
                    &agent,
                    "the server_crash report",
                    Duration::from_secs(10),
                    || async {
                        let mock = sandbox.mock.lock().unwrap();
                        mock.client_errors
                            .iter()
                            .any(|report| {
                                report["kind"] == "server_crash" && report["build"] == BUILD
                            })
                            .then_some(())
                    },
                )
                .await;
            // The new server was up within a second or two of the crash (backoff 1 s), which the
            // wait above already proved by seeing a fresh pid; the crash tail travels along.
            let mock = sandbox.mock.lock().unwrap();
            let report = mock
                .client_errors
                .iter()
                .find(|r| r["kind"] == "server_crash")
                .unwrap();
            assert!(
                report["message"].as_str().unwrap().contains("exit"),
                "{report}"
            );
        }
    }
    assert!(crash_loop_seen, "six crashes must trip the crash loop");
    assert_eq!(sandbox.mock.lock().unwrap().client_errors.len(), 6);
    agent.sigterm();
    assert_eq!(agent.wait_exit(Duration::from_secs(15)).await, Some(0));
}

/// Case (e): `stop: true` in the directive runs the stop sequence without any signal.
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_directive_runs_the_stop_sequence() {
    if !enabled() {
        return;
    }
    let mut sandbox = Sandbox::new(false).await;
    let mut agent = sandbox.spawn("start", &[]);
    sandbox
        .wait_health(&agent, "phase ready", Duration::from_secs(30), |body| {
            body["phase"] == "ready"
        })
        .await;
    sandbox.mock.lock().unwrap().directive.stop = true;
    // The next ping (≤ 10 s away) carries the directive; the stop path then takes ≈ 1 s.
    assert_eq!(
        agent.wait_exit(Duration::from_secs(25)).await,
        Some(0),
        "{}",
        tail(&agent.stderr(), 40)
    );
    assert!(
        agent.stderr().contains("stop_directive"),
        "{}",
        tail(&agent.stderr(), 20)
    );
    let fake = sandbox.fake_state_file();
    assert!(
        fake["timeline"]["stopping_at"].is_u64(),
        "the server got the stopping notice: {fake}"
    );
    assert!(fake["timeline"]["sigterm_at"].is_u64());
    assert!(sandbox.mock.lock().unwrap().client_errors.is_empty());
}

/// Case (f): a rebuild tarball is fetched header-less, verified, and laid out; the manifest's
/// settings win over the archived ones; postCreate runs once on the fresh state dir; a wrong
/// digest is exit 4.
#[tokio::test(flavor = "multi_thread")]
async fn a_rebuild_tarball_is_restored_and_its_digest_verified() {
    if !enabled() {
        return;
    }
    let mut sandbox = Sandbox::new(false).await;
    // Build the archive: the pre-D9 three-path shape, to exercise the tolerant mapping.
    let stage = sandbox.root.join("archive");
    let tree = stage.join("workspaces/fixture");
    std::fs::create_dir_all(tree.join(".devcontainer")).unwrap();
    std::fs::write(tree.join(".devcontainer/devcontainer.json"), DEVCONTAINER).unwrap();
    std::fs::write(tree.join("main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(tree.join("restored.txt"), "from the archive\n").unwrap();
    std::fs::create_dir_all(stage.join("vercel/.local/share/zed")).unwrap();
    std::fs::write(stage.join("vercel/.local/share/zed/marker"), "data dir\n").unwrap();
    std::fs::create_dir_all(stage.join("vercel/.config/zed")).unwrap();
    std::fs::write(
        stage.join("vercel/.config/zed/settings.json"),
        "{ \"archived\": true }",
    )
    .unwrap();
    let archive = sandbox.root.join("restore.tgz");
    let status = std::process::Command::new("tar")
        .args([
            "czf",
            archive.to_str().unwrap(),
            "-C",
            stage.to_str().unwrap(),
            "workspaces",
            "vercel",
        ])
        .status()
        .unwrap();
    assert!(status.success());
    let tarball = std::fs::read(&archive).unwrap();
    let digest = sha256_hex(&tarball);
    sandbox.mock.lock().unwrap().restore = Some(Restore {
        tarball: tarball.clone(),
        sha256: Some(digest),
    });

    let mut agent = sandbox.spawn("start", &[]);
    sandbox
        .wait_health(
            &agent,
            "phase ready after restore",
            Duration::from_secs(40),
            |body| body["phase"] == "ready",
        )
        .await;
    let workspace = sandbox.workspace();
    assert_eq!(
        std::fs::read_to_string(workspace.join("restored.txt")).unwrap(),
        "from the archive\n"
    );
    assert!(
        sandbox.root.join("data/marker").is_file(),
        "the data dir entry landed in ZS_DATA_DIR"
    );
    assert_eq!(
        std::fs::read_to_string(sandbox.root.join("home/.config/zed/settings.json")).unwrap(),
        SETTINGS_TEXT,
        "the manifest's settings win over the archived copy"
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join(".post-create"))
            .unwrap()
            .trim(),
        "post-create"
    );
    {
        let mock = sandbox.mock.lock().unwrap();
        assert!(!mock.restore_fetches.is_empty(), "the tarball was fetched");
        assert!(
            mock.restore_fetches
                .iter()
                .all(|authenticated| !authenticated),
            "fetched header-less"
        );
    }
    agent.sigterm();
    assert_eq!(agent.wait_exit(Duration::from_secs(15)).await, Some(0));
    {
        let mock = sandbox.mock.lock().unwrap();
        let post_create_runs = mock
            .logs
            .iter()
            .filter(|entry| {
                entry["source"] == "agent"
                    && entry["msg"] == "lifecycle command"
                    && entry["fields"]["label"] == "post_create"
            })
            .count();
        assert_eq!(
            post_create_runs, 1,
            "markers are not archived, so postCreate runs once"
        );
    }

    // A wrong digest never becomes a workspace: exit 4, nothing left behind.
    let mut sandbox = Sandbox::new(false).await;
    sandbox.mock.lock().unwrap().restore = Some(Restore {
        tarball,
        sha256: Some("cd".repeat(32)),
    });
    let mut agent = sandbox.spawn("start", &[]);
    assert_eq!(
        agent.wait_exit(Duration::from_secs(40)).await,
        Some(4),
        "{}",
        tail(&agent.stderr(), 40)
    );
    assert!(!sandbox.workspace().exists());
    assert!(
        agent.stderr().contains("sha256 mismatch"),
        "{}",
        tail(&agent.stderr(), 20)
    );
}

/// Case (g): `zs-agent prebuild` clones, runs postCreate, warms the language servers through
/// the fake's `/rpc`, removes the warm-up key and exits 0 – as a deliberate stop, not a crash.
#[tokio::test(flavor = "multi_thread")]
async fn prebuild_warms_the_language_servers_and_exits_zero() {
    if !enabled() {
        return;
    }
    let mut sandbox = Sandbox::new(true).await;
    // `start` refuses to run under ZS_PREBUILD=1.
    let mut refused = sandbox.spawn("start", &[]);
    assert_eq!(refused.wait_exit(Duration::from_secs(10)).await, Some(2));

    let mut agent = sandbox.spawn("prebuild", &[]);
    sandbox
        .wait_health(
            &agent,
            "the warm-up phase",
            Duration::from_secs(60),
            |body| body["phase"] == "warm",
        )
        .await;
    let status = agent.wait_exit(Duration::from_secs(120)).await;
    let stderr = agent.stderr();
    assert_eq!(status, Some(0), "{}", tail(&stderr, 40));

    assert!(
        sandbox
            .state_dir()
            .join("markers/post-create.done")
            .is_file()
    );
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace().join(".post-create"))
            .unwrap()
            .trim(),
        "post-create"
    );
    assert!(
        !sandbox.state_dir().join("jwt/key-warm.pem").exists(),
        "the warm-up key is removed"
    );
    assert!(sandbox.state_dir().join("jwt/key-0.pem").is_file());
    let fake = sandbox.fake_state_file();
    let argv = fake["argv"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        argv.contains("key-warm.pem"),
        "the warm key was passed as --jwt-public-key: {argv}"
    );
    assert!(
        fake["warm"]["subprotocol"]
            .as_str()
            .unwrap()
            .starts_with("zs.v1, eyJ"),
        "{}",
        fake["warm"]
    );
    assert_eq!(fake["warm"]["hello"]["type"], "hello");
    assert_eq!(fake["warm"]["hello"]["workspace_id"], "pb_itest");
    assert!(fake["warm"]["hello"]["instance"].is_string(), "D25 nonce");
    assert_eq!(
        fake["warm"]["worktree"],
        sandbox.workspace().to_string_lossy().as_ref()
    );
    // One probe file per language, in PROBE_EXTENSIONS priority: rs, py, then json (the
    // devcontainer file is the fixture's only JSON document).
    assert_eq!(
        fake["warm"]["opened"],
        serde_json::json!(["main.rs", "app.py", ".devcontainer/devcontainer.json"])
    );
    let kinds: Vec<&str> = fake["warm"]["kinds"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|k| k.as_str())
        .collect();
    assert!(
        kinds
            .iter()
            .all(|kind| matches!(*kind, "add_worktree" | "open_buffer_by_path" | "ack")),
        "no persistence message is ever sent: {kinds:?}"
    );
    assert!(
        fake["timeline"]["stopping_at"].is_u64(),
        "the server was stopped deliberately"
    );
    {
        let mock = sandbox.mock.lock().unwrap();
        assert!(
            mock.pings.is_empty(),
            "a prebuild sends no activity pings: {:?}",
            mock.pings
        );
        assert!(
            mock.client_errors.is_empty(),
            "a clean prebuild exit is not a server crash: {:?}",
            mock.client_errors
        );
        assert!(mock.extensions.is_empty() || true);
        assert!(
            mock.logs.iter().any(|entry| entry["source"] == "warm"),
            "warm-up lines are shipped"
        );
    }
    assert!(
        !stderr.contains("server exited; restarting"),
        "{}",
        tail(&stderr, 40)
    );
    assert!(!stderr.contains("server_crash"), "{}", tail(&stderr, 40));
    assert!(
        stderr.contains("language-server warm-up finished"),
        "{}",
        tail(&stderr, 40)
    );
}

/// A manifest that cannot be fetched keeps the listeners up with the reason on the loopback
/// body and exits 3 as soon as it is asked to stop (the drain path with nothing configured).
#[tokio::test(flavor = "multi_thread")]
async fn an_unavailable_manifest_exits_three_promptly() {
    if !enabled() {
        return;
    }
    let mut sandbox = Sandbox::new(false).await;
    sandbox.mock.lock().unwrap().manifest_status = 503;
    let mut agent = sandbox.spawn("start", &[]);
    let body = sandbox
        .wait_health(
            &agent,
            "the manifest failure",
            Duration::from_secs(30),
            |body| {
                body["lastError"]
                    .as_str()
                    .is_some_and(|e| e.starts_with("manifest:"))
            },
        )
        .await;
    assert_eq!(body["status"], "booting", "nothing is usable: not degraded");
    assert_eq!(body["phase"], "manifest");
    let public: serde_json::Value = sandbox
        .client
        .get(format!("http://127.0.0.1:{}/health", sandbox.ports.health))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(public["ok"], false, "D21 minimal body: {public}");
    assert_eq!(public["phase"], "manifest");
    assert!(public.get("lastError").is_none());
    let started = Instant::now();
    agent.sigterm();
    assert_eq!(
        agent.wait_exit(Duration::from_secs(10)).await,
        Some(3),
        "{}",
        tail(&agent.stderr(), 40)
    );
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "exit took {:?}",
        started.elapsed()
    );
    assert!(!sandbox.state_dir().join("run/zs-agent.pid").exists());
}
