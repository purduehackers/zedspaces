//! VS Code resolves PID attachments before calling js-debug's standalone adapter.
//! Do that OS work here, where the Node process actually runs, not in Zed's UI.

use anyhow::{Context as _, Result, ensure};
use bytes::BytesMut;
use serde_json::Value;

#[derive(Default)]
pub(super) struct Requests(BytesMut);

impl Requests {
    pub(super) fn push(&mut self, bytes: &[u8]) -> Result<()> {
        ensure!(
            self.0.len() + bytes.len() <= super::MAX_FRAME * 2,
            "DAP input too large"
        );
        self.0.extend_from_slice(bytes);
        Ok(())
    }

    pub(super) fn next(&mut self) -> Result<Option<Value>> {
        let Some(end) = self.0.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
            ensure!(self.0.len() <= 8192, "DAP header too large");
            return Ok(None);
        };
        ensure!(end <= 8192, "DAP header too large");
        let header = std::str::from_utf8(&self.0[..end])?;
        let lengths: Vec<_> = header
            .lines()
            .filter_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case("Content-Length")
                    .then_some(value.trim())
            })
            .collect();
        ensure!(lengths.len() == 1, "Expected one DAP Content-Length");
        let length: usize = lengths[0].parse()?;
        ensure!(
            length > 0 && length <= super::MAX_FRAME,
            "Invalid DAP content length"
        );
        let total = end + 4 + length;
        if self.0.len() < total {
            return Ok(None);
        }
        let frame = self.0.split_to(total);
        Ok(Some(serde_json::from_slice(&frame[end + 4..])?))
    }
}

pub(super) async fn prepare(request: &mut Value) -> Result<()> {
    if request["type"] != "request" || request["command"] != "attach" {
        return Ok(());
    }
    let args = &mut request["arguments"];
    if !matches!(args["type"].as_str(), Some("node" | "pwa-node")) || args["processId"].is_null() {
        return Ok(());
    }
    let pid = match &args["processId"] {
        Value::String(value) => value.trim().parse::<u32>()?,
        Value::Number(value) => u32::try_from(value.as_u64().context("Invalid Node PID")?)?,
        _ => anyhow::bail!("Invalid Node PID"),
    };
    let endpoint = attach(pid).await?;
    let args = args.as_object_mut().context("Invalid attach arguments")?;
    args.remove("processId");
    args.insert("websocketAddress".into(), endpoint.into());
    args.insert("address".into(), "127.0.0.1".into());
    Ok(())
}

#[cfg(target_os = "linux")]
use {
    parking_lot::Mutex,
    std::{collections::BTreeMap, sync::OnceLock, time::Duration},
};

#[cfg(target_os = "linux")]
static ATTACHED: OnceLock<Mutex<BTreeMap<u32, u64>>> = OnceLock::new();

#[cfg(target_os = "linux")]
fn started(pid: u32) -> Option<u64> {
    // comm is parenthesized and can itself contain spaces or parentheses.
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()?
        .rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
pub(super) fn is_attached(pid: u32) -> bool {
    ATTACHED.get().is_some_and(|attached| {
        let mut attached = attached.lock();
        match attached.get(&pid) {
            Some(time) if started(pid) == Some(*time) => true,
            _ => {
                attached.remove(&pid);
                false
            }
        }
    })
}

#[cfg(target_os = "linux")]
async fn attach(pid: u32) -> Result<String> {
    use nix::{
        sys::signal::{Signal, kill},
        unistd::Pid,
    };
    use std::os::unix::fs::MetadataExt as _;

    ensure!(pid > 1 && pid <= i32::MAX as u32, "Invalid Node PID");
    let process = std::path::PathBuf::from(format!("/proc/{pid}"));
    let executable = std::fs::read_link(process.join("exe"))?;
    ensure!(
        executable
            .file_name()
            .is_some_and(|name| name == "node" || name == "nodejs"),
        "Selected process is not Node.js"
    );
    ensure!(
        std::fs::metadata(&process)?.uid() == nix::unistd::geteuid().as_raw(),
        "Node process belongs to another user"
    );
    let start = started(pid).context("Node process exited")?;
    {
        let mut attached = ATTACHED.get_or_init(Default::default).lock();
        attached.retain(|pid, time| started(*pid) == Some(*time));
        ensure!(
            attached.len() < 256 || attached.contains_key(&pid),
            "Too many attached Node processes"
        );
        // The inspector remains alive after detach. Keep it private until this
        // process exits; start time prevents hiding an unrelated, reused PID.
        attached.insert(pid, start);
    }
    kill(Pid::from_raw(pid as i32), Signal::SIGUSR1)
        .context("Could not enable the Node inspector")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(300))
        .build()?;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            ensure!(
                started(pid) == Some(start),
                "Node process exited while attaching"
            );
            let ports = tokio::task::spawn_blocking(move || {
                let sockets = crate::ports::scan(std::process::id())?;
                let owners = crate::ports::resolve_owners(
                    &sockets.values().map(|s| s.inode).collect::<Vec<_>>(),
                );
                Ok::<_, std::io::Error>(
                    sockets
                        .into_values()
                        .filter(|s| owners.get(&s.inode).is_some_and(|(owner, _)| *owner == pid))
                        .collect::<Vec<_>>(),
                )
            })
            .await??;
            for port in ports {
                let host = if port.v4 { "127.0.0.1" } else { "[::1]" };
                if let Ok(endpoint) = inspector(&client, host, port.port).await {
                    return Ok(endpoint);
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("Node inspector did not open; check its stderr for a port conflict")?
}

#[cfg(target_os = "linux")]
async fn inspector(client: &reqwest::Client, host: &str, port: u16) -> Result<String> {
    let mut response = client
        .get(format!("http://{host}:{port}/json/list"))
        .send()
        .await?
        .error_for_status()?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            body.len() + chunk.len() <= 64 * 1024,
            "Inspector response too large"
        );
        body.extend_from_slice(&chunk);
    }
    let targets: Vec<Value> = serde_json::from_slice(&body)?;
    let target = targets
        .iter()
        .find(|target| target["type"] == "node")
        .context("Not a Node inspector")?;
    let mut endpoint = reqwest::Url::parse(
        target["webSocketDebuggerUrl"]
            .as_str()
            .context("Missing inspector endpoint")?,
    )?;
    ensure!(
        endpoint.scheme() == "ws" && endpoint.port() == Some(port),
        "Invalid inspector endpoint"
    );
    endpoint.set_host(Some(host))?;
    Ok(endpoint.into())
}

#[cfg(not(target_os = "linux"))]
async fn attach(_: u32) -> Result<String> {
    anyhow::bail!("Node PID attachment requires a Linux sandbox")
}
