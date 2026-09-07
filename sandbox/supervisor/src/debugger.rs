//! Authenticated DAP/kernel byte tunnel on the service listener, never a preview port.

use anyhow::{Context as _, Result, bail, ensure};
use base64::Engine as _;
use bytes::Bytes;
use futures_util::{SinkExt as _, StreamExt as _};
use http_body_util::Full;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use parking_lot::Mutex;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _},
    net::TcpStream,
    process::{Child, Command},
    sync::Semaphore,
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        Message,
        handshake::derive_accept_key,
        protocol::{Role, WebSocketConfig},
    },
};
use tokio_util::sync::CancellationToken;

const PROTOCOL: &str = "zs.dap.v1";
const MAX_LAUNCH: usize = 64 * 1024;
const MAX_FRAME: usize = 8 * 1024 * 1024;

pub struct DebugService {
    config: OnceLock<Config>,
    slots: Arc<Semaphore>,
    used: Mutex<BTreeMap<String, u64>>,
    shutdown: CancellationToken,
}

struct Config {
    workspace: String,
    root: PathBuf,
    origins: Vec<String>,
    keys: Vec<DecodingKey>,
    validation: Validation,
}

#[derive(Deserialize)]
struct Claims {
    ws: String,
    sub: String,
    exp: u64,
    iat: u64,
    jti: String,
    launch: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Launch {
    command: Option<String>,
    arguments: Vec<String>,
    envs: BTreeMap<String, String>,
    cwd: Option<PathBuf>,
    connection: Option<Connection>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Connection {
    host: IpAddr,
    port: u16,
    timeout: Option<u64>,
}

impl DebugService {
    pub fn new(shutdown: CancellationToken) -> Self {
        Self {
            config: OnceLock::new(),
            slots: Arc::new(Semaphore::new(4)),
            used: Mutex::new(BTreeMap::new()),
            shutdown,
        }
    }

    pub fn configure(
        &self,
        workspace: String,
        root: PathBuf,
        origins: Vec<String>,
        issuer: &str,
        audience: &str,
        pems: &[String],
    ) -> Result<()> {
        let mut validation = Validation::new(Algorithm::ES256);
        validation.set_issuer(&[issuer]);
        validation.set_audience(&[format!("{audience}/debug")]);
        validation.set_required_spec_claims(&["exp", "iat", "sub", "aud", "iss", "jti"]);
        validation.leeway = 5;
        let keys = pems
            .iter()
            .map(|pem| DecodingKey::from_ec_pem(pem.as_bytes()))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ensure!(!keys.is_empty(), "No debugger verification keys");
        self.config
            .set(Config {
                workspace,
                root,
                origins,
                keys,
                validation,
            })
            .map_err(|_| anyhow::anyhow!("Debugger service is already configured"))
    }

    fn authorize<B>(&self, req: &Request<B>) -> Result<Claims> {
        let config = self.config.get().context("Workspace is starting")?;
        ensure!(req.method() == hyper::Method::GET, "WebSocket GET required");
        let origin = req
            .headers()
            .get("origin")
            .and_then(|h| h.to_str().ok())
            .context("Origin required")?;
        ensure!(
            config.origins.iter().any(|allowed| allowed == origin),
            "Origin not allowed"
        );
        let protocols = req
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|h| h.to_str().ok())
            .context("Missing debug token")?;
        ensure!(protocols.len() <= 4096, "Debug token too large");
        let protocols = protocols.split(',').map(str::trim).collect::<Vec<_>>();
        ensure!(
            protocols.len() == 2 && protocols[0] == PROTOCOL,
            "Invalid debug protocol"
        );
        let claims = config
            .keys
            .iter()
            .find_map(|key| {
                jsonwebtoken::decode::<Claims>(protocols[1], key, &config.validation).ok()
            })
            .context("Invalid or expired debug token")?
            .claims;
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        ensure!(
            claims.ws == config.workspace && !claims.sub.is_empty(),
            "Wrong workspace"
        );
        ensure!(
            claims.exp > now
                && claims.iat <= now + 5
                && claims.exp >= claims.iat
                && claims.exp - claims.iat <= 120,
            "Expired debug token"
        );
        ensure!(
            claims.jti.len() <= 128 && !claims.jti.is_empty() && claims.launch.len() == 64,
            "Invalid debug token"
        );
        let mut used = self.used.lock();
        used.retain(|_, expiry| *expiry > now);
        ensure!(
            used.len() < 128 && !used.contains_key(&claims.jti),
            "Debug token already used"
        );
        used.insert(claims.jti.clone(), claims.exp);
        Ok(claims)
    }

    pub fn upgrade<B>(self: &Arc<Self>, mut req: Request<B>) -> Response<Full<Bytes>> {
        let claims = match self.authorize(&req) {
            Ok(claims) => claims,
            Err(_) => return response(StatusCode::UNAUTHORIZED, "Debugger access refused"),
        };
        let Ok(permit) = self.slots.clone().try_acquire_owned() else {
            return response(
                StatusCode::TOO_MANY_REQUESTS,
                "Four debugger or kernel sessions are already running",
            );
        };
        if !req
            .headers()
            .get("connection")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
            })
            || req
                .headers()
                .get("upgrade")
                .and_then(|v| v.to_str().ok())
                .map(str::to_ascii_lowercase)
                .as_deref()
                != Some("websocket")
            || req
                .headers()
                .get("sec-websocket-version")
                .and_then(|v| v.to_str().ok())
                != Some("13")
        {
            return response(StatusCode::BAD_REQUEST, "WebSocket upgrade required");
        }
        let Some(key) = req.headers().get("sec-websocket-key").filter(|v| {
            base64::engine::general_purpose::STANDARD
                .decode(v.as_bytes())
                .is_ok_and(|key| key.len() == 16)
        }) else {
            return response(StatusCode::BAD_REQUEST, "Missing WebSocket key");
        };
        let accept = derive_accept_key(key.as_bytes());
        let upgraded = hyper::upgrade::on(&mut req);
        let service = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(10), upgraded).await
            else {
                return;
            };
            let config = WebSocketConfig {
                max_message_size: Some(MAX_FRAME),
                max_frame_size: Some(MAX_FRAME),
                max_write_buffer_size: MAX_FRAME * 2,
                ..Default::default()
            };
            let mut socket =
                WebSocketStream::from_raw_socket(TokioIo::new(stream), Role::Server, Some(config))
                    .await;
            let result = tokio::select! {
                result = service.session(&mut socket, claims) => result,
                _ = service.shutdown.cancelled() => Ok(()),
                _ = tokio::time::sleep(Duration::from_secs(3600)) => Err(anyhow::anyhow!("Debug session reached its one-hour limit")),
            };
            if result.is_err() {
                let _ = tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Text("{\"error\":\"Debug adapter stopped or could not start. Check its configuration and debug console.\"}".into()))).await;
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
        });
        Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header("connection", "Upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-accept", accept)
            .header("sec-websocket-protocol", PROTOCOL)
            .body(Full::new(Bytes::new()))
            .unwrap()
    }

    async fn session<S>(&self, socket: &mut WebSocketStream<S>, claims: Claims) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let first = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await?
            .context("Missing launch definition")??;
        ensure!(
            first.is_text() && first.len() <= MAX_LAUNCH,
            "Invalid launch definition"
        );
        let raw = first.into_data();
        ensure!(
            hex::encode(Sha256::digest(&raw)) == claims.launch,
            "Launch definition does not match token"
        );
        let launch: Launch = serde_json::from_slice(&raw)?;
        let config = self.config.get().context("Workspace is starting")?;
        let cwd = tokio::fs::canonicalize(launch.cwd.as_ref().unwrap_or(&config.root)).await?;
        ensure!(
            cwd.starts_with(tokio::fs::canonicalize(&config.root).await?),
            "Debug working directory is outside the project"
        );
        if let Some(connection) = &launch.connection {
            // Child DAP sessions reconnect to their parent's adapter port. It is
            // private to previews, but still a valid debugger destination.
            ensure!(
                connection.host.is_loopback()
                    && connection.port > 1023
                    && !crate::config::INFRA_PORTS.contains(&connection.port),
                "Private loopback debug port required"
            );
        }
        ensure!(
            launch.arguments.len() <= 512 && launch.envs.len() <= 1024,
            "Launch definition is too large"
        );
        ensure!(
            launch.command.is_some() || launch.connection.is_some(),
            "No debug adapter command or connection"
        );
        let _port = launch
            .connection
            .as_ref()
            .map(|connection| PrivatePort::new(connection.port));
        let mut process = if let Some(program) = &launch.command {
            ensure!(!program.is_empty(), "No debug adapter program");
            let mut command = Command::new(program);
            command
                .args(&launch.arguments)
                .current_dir(cwd)
                .env_clear()
                .env("PATH", "/usr/local/bin:/usr/bin:/bin")
                .env(
                    "HOME",
                    std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".into()),
                )
                .envs(launch.envs)
                .env("ZS_PRIVATE_SERVICE", "debug")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0)
                .kill_on_drop(true);
            Some(Process::new(command.spawn()?))
        } else {
            None
        };
        let (input, output): (
            Box<dyn AsyncWrite + Unpin + Send>,
            Box<dyn AsyncRead + Unpin + Send>,
        ) = if let Some(connection) = &launch.connection {
            if let Some(process) = &mut process {
                process.drain_stdout();
            }
            let connect = async {
                loop {
                    if let Some(process) = &mut process {
                        ensure!(
                            process.child.try_wait()?.is_none(),
                            "Debug adapter exited before connecting"
                        );
                    }
                    match TcpStream::connect(SocketAddr::new(connection.host, connection.port))
                        .await
                    {
                        Ok(stream) => break Ok::<_, anyhow::Error>(stream),
                        Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                    }
                }
            };
            let stream = tokio::time::timeout(
                Duration::from_millis(connection.timeout.unwrap_or(15_000).clamp(1_000, 20_000)),
                connect,
            )
            .await??;
            stream.set_nodelay(true)?;
            let (read, write) = stream.into_split();
            (Box::new(write), Box::new(read))
        } else {
            let process = process
                .as_mut()
                .context("Stdio adapter requires a process")?;
            (
                Box::new(process.child.stdin.take().context("Missing stdin")?),
                Box::new(process.child.stdout.take().context("Missing stdout")?),
            )
        };
        socket
            .send(Message::Text("{\"ready\":true}".into()))
            .await?;
        tunnel(socket, input, output).await
    }
}

async fn tunnel<S>(
    socket: &mut WebSocketStream<S>,
    mut input: Box<dyn AsyncWrite + Unpin + Send>,
    mut output: Box<dyn AsyncRead + Unpin + Send>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut sink, mut stream) = socket.split();
    let send = async {
        let mut buffer = vec![0; 64 * 1024];
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        loop {
            tokio::select! {
                read = output.read(&mut buffer) => {
                    let count = read?;
                    if count == 0 { break; }
                    sink.send(Message::Binary(buffer[..count].to_vec())).await?;
                },
                _ = heartbeat.tick() => sink.send(Message::Ping(Vec::new())).await?,
            }
        }
        Ok::<_, anyhow::Error>(())
    };
    let receive = async {
        while let Some(message) = stream.next().await {
            match message? {
                Message::Binary(bytes) => input.write_all(&bytes).await?,
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) => {}
                _ => bail!("Binary DAP messages required"),
            }
        }
        Ok::<_, anyhow::Error>(())
    };
    tokio::select! { result = send => result, result = receive => result }
}

struct Process {
    child: Child,
    group: u32,
    drains: Vec<tokio::task::JoinHandle<()>>,
}
impl Process {
    fn new(mut child: Child) -> Self {
        let stderr = child.stderr.take().unwrap();
        let group = child.id().unwrap();
        Self {
            child,
            group,
            drains: vec![tokio::spawn(async move {
                let _ = tokio::io::copy(
                    &mut tokio::io::BufReader::new(stderr),
                    &mut tokio::io::sink(),
                )
                .await;
            })],
        }
    }
    fn drain_stdout(&mut self) {
        if let Some(stdout) = self.child.stdout.take() {
            self.drains.push(tokio::spawn(async move {
                let _ = tokio::io::copy(
                    &mut tokio::io::BufReader::new(stdout),
                    &mut tokio::io::sink(),
                )
                .await;
            }));
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(self.group as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
        for task in &self.drains {
            task.abort();
        }
    }
}

fn response(status: StatusCode, message: &'static str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("cache-control", "no-store")
        .body(Full::new(Bytes::from_static(message.as_bytes())))
        .unwrap()
}

static PRIVATE_PORTS: OnceLock<Mutex<BTreeMap<u16, usize>>> = OnceLock::new();
pub fn is_private_port(port: u16) -> bool {
    PRIVATE_PORTS
        .get()
        .is_some_and(|ports| ports.lock().contains_key(&port))
}

/// Debug-managed processes can open additional inspector/control listeners.
/// Those are never automatically advertised as public app previews.
#[cfg(target_os = "linux")]
pub fn is_debug_process(pid: u32) -> bool {
    pid != 0
        && std::fs::read(format!("/proc/{pid}/environ")).is_ok_and(|env| {
            env.split(|byte| *byte == 0)
                .any(|entry| entry == b"ZS_PRIVATE_SERVICE=debug")
        })
}
#[cfg(not(target_os = "linux"))]
pub fn is_debug_process(_: u32) -> bool {
    false
}
struct PrivatePort(u16);
impl PrivatePort {
    fn new(port: u16) -> Self {
        *PRIVATE_PORTS
            .get_or_init(Default::default)
            .lock()
            .entry(port)
            .or_default() += 1;
        Self(port)
    }
}
impl Drop for PrivatePort {
    fn drop(&mut self) {
        let mut ports = PRIVATE_PORTS.get().unwrap().lock();
        if let Some(count) = ports.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                ports.remove(&self.0);
            }
        }
    }
}
