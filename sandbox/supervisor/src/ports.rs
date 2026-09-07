//! Listening-port discovery (brief §3.7): pure `/proc/net/tcp{,6}` parsing plus the watcher task
//! that republishes `PortsChanged` to the server through `POST /control/ports`.
//!
//! The socket table comes from `/proc` on Linux (the sandbox image). On every other host the
//! same entry points ([`scan`], [`owner_of_port`], [`resolve_owners`], [`process_name`]) are
//! served by an `lsof`/`ps` fallback that is enabled only under `ZS_LOCAL=1` (the control
//! plane's local backend on a developer's macOS); without the flag they report
//! `io::ErrorKind::Unsupported`, which the watcher logs once and otherwise ignores.

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::config::INFRA_PORTS;
use crate::server::ServerControl;
use crate::state::{AgentState, ForwardsState, HealthStatus};

/// One LISTEN socket as read from `/proc/net/tcp` or `tcp6`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ListenSocket {
    /// Local port.
    pub port: u16,
    /// Seen in `/proc/net/tcp`.
    pub v4: bool,
    /// Seen in `/proc/net/tcp6`.
    pub v6: bool,
    /// Bound to a loopback address only.
    pub loopback_only: bool,
    /// Owning uid.
    pub uid: u32,
    /// Socket inode (resolved to a pid through `/proc/<pid>/fd`).
    pub inode: u64,
}

/// Parses the body of `/proc/net/tcp` or `/proc/net/tcp6` (header line skipped); keeps `st == 0A`.
pub fn parse_proc_net_tcp(text: &str, v6: bool) -> Vec<ListenSocket> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 10 || fields[3] != "0A" {
                return None;
            }
            let (ip, port) = parse_local_address(fields[1], v6)?;
            let uid = fields[7].parse().ok()?;
            let inode = fields[9].parse().ok()?;
            Some(ListenSocket {
                port,
                v4: !v6,
                v6,
                loopback_only: ip.is_loopback(),
                uid,
                inode,
            })
        })
        .collect()
}

/// `0100007F:0BB8` → `(127.0.0.1, 3000)`; tcp6 `00000000000000000000000001000000:1F90` → `(::1, 8080)`.
pub fn parse_local_address(field: &str, v6: bool) -> Option<(IpAddr, u16)> {
    let (address, port) = field.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    if v6 {
        if address.len() != 32 {
            return None;
        }
        let mut bytes = [0u8; 16];
        for (index, chunk) in address.as_bytes().chunks(8).enumerate() {
            let word = u32::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
            bytes[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
        }
        Some((IpAddr::V6(Ipv6Addr::from(bytes)), port))
    } else {
        if address.len() != 8 {
            return None;
        }
        let word = u32::from_str_radix(address, 16).ok()?;
        Some((IpAddr::V4(Ipv4Addr::from(word.to_le_bytes())), port))
    }
}

/// A listening port with its owner, as published to the server.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ListeningPort {
    /// Port number.
    pub port: u16,
    /// Owning pid (0 when unresolved).
    pub pid: u32,
    /// `/proc/<pid>/comm`.
    pub process_name: String,
    /// Has an IPv4 listener.
    #[serde(skip)]
    pub v4: bool,
    /// Has an IPv6 listener.
    #[serde(skip)]
    pub v6: bool,
    /// Every listener is loopback-bound; the preview proxy reaches it locally.
    #[serde(skip)]
    pub loopback_only: bool,
}

/// Ports that appeared and disappeared between two scans.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PortDiff {
    /// Newly listening.
    pub added: Vec<u16>,
    /// No longer listening.
    pub removed: Vec<u16>,
}

/// Set difference in both directions.
pub fn diff_ports(previous: &BTreeSet<u16>, current: &BTreeSet<u16>) -> PortDiff {
    PortDiff {
        added: current.difference(previous).copied().collect(),
        removed: previous.difference(current).copied().collect(),
    }
}

/// Reserved VM services, control listeners and preview slots.
pub fn is_infra_port(port: u16) -> bool {
    INFRA_PORTS.contains(&port)
}

/// `/proc/net/tcp`, the IPv4 socket table.
pub const PROC_NET_TCP: &str = "/proc/net/tcp";
/// `/proc/net/tcp6`, the IPv6 socket table.
pub const PROC_NET_TCP6: &str = "/proc/net/tcp6";

/// Unions the two tables by port: `v4`/`v6` say where the port was seen (so the proxy can pick
/// `[::1]` for a v6-only listener) and `loopback_only` holds only when **every** listener on that
/// port is bound to a loopback address.
pub fn union_by_port(sockets: Vec<ListenSocket>) -> BTreeMap<u16, ListenSocket> {
    let mut by_port: BTreeMap<u16, ListenSocket> = BTreeMap::new();
    for socket in sockets {
        match by_port.get_mut(&socket.port) {
            Some(existing) => {
                existing.v4 |= socket.v4;
                existing.v6 |= socket.v6;
                existing.loopback_only &= socket.loopback_only;
                if existing.inode == 0 {
                    existing.inode = socket.inode;
                    existing.uid = socket.uid;
                }
            }
            None => {
                by_port.insert(socket.port, socket);
            }
        }
    }
    by_port
}

/// Reads both proc files (a missing `tcp6` is not an error), unions v4/v6 by port, drops
/// [`INFRA_PORTS`] and ports owned by `self_pid`.
#[cfg(target_os = "linux")]
pub fn scan(self_pid: u32) -> std::io::Result<BTreeMap<u16, ListenSocket>> {
    let mut sockets = parse_proc_net_tcp(&std::fs::read_to_string(PROC_NET_TCP)?, false);
    match std::fs::read_to_string(PROC_NET_TCP6) {
        Ok(text) => sockets.extend(parse_proc_net_tcp(&text, true)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let own = if self_pid != 0 {
        own_socket_inodes(self_pid)
    } else {
        BTreeSet::new()
    };
    Ok(user_ports(union_by_port(sockets), &own))
}

/// The pure filter behind [`scan`]: drops the D21 infrastructure ports and every socket whose
/// inode is one of `own` (the agent's own listeners, resolved through `/proc/<pid>/fd`).
pub fn user_ports(
    mut by_port: BTreeMap<u16, ListenSocket>,
    own: &BTreeSet<u64>,
) -> BTreeMap<u16, ListenSocket> {
    by_port.retain(|port, socket| !is_infra_port(*port) && !own.contains(&socket.inode));
    by_port
}

/// `lsof` fallback of [`scan`] for hosts without `/proc` (macOS under `ZS_LOCAL=1`): the
/// agent's own listeners are dropped by pid, and the owners are remembered for
/// [`resolve_owners`].
#[cfg(not(target_os = "linux"))]
pub fn scan(self_pid: u32) -> std::io::Result<BTreeMap<u16, ListenSocket>> {
    let listeners = lsof::listen_table(None)?;
    lsof::remember_owners(&listeners);
    let own: BTreeSet<u64> = listeners
        .iter()
        .filter(|listener| listener.pid == self_pid)
        .map(lsof::LsofListener::key)
        .collect();
    let sockets = listeners.iter().map(lsof::LsofListener::socket).collect();
    Ok(user_ports(union_by_port(sockets), &own))
}

/// Socket inodes held by one process, from `/proc/<pid>/fd`.
#[cfg(target_os = "linux")]
fn own_socket_inodes(pid: u32) -> BTreeSet<u64> {
    let mut inodes = BTreeSet::new();
    let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return inodes;
    };
    for entry in entries.flatten() {
        if let Ok(target) = std::fs::read_link(entry.path())
            && let Some(inode) = socket_inode(&target.to_string_lossy())
        {
            inodes.insert(inode);
        }
    }
    inodes
}

/// `socket:[12345]` → `12345`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn socket_inode(link: &str) -> Option<u64> {
    link.strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse()
        .ok()
}

/// Walks `/proc/<pid>/fd/*` for `socket:[<inode>]` links (only for the inodes given), returns
/// pid + `/proc/<pid>/comm`.
#[cfg(target_os = "linux")]
pub fn resolve_owners(inodes: &[u64]) -> BTreeMap<u64, (u32, String)> {
    let wanted: BTreeSet<u64> = inodes.iter().copied().collect();
    let mut owners = BTreeMap::new();
    if wanted.is_empty() {
        return owners;
    }
    let Ok(processes) = std::fs::read_dir("/proc") else {
        return owners;
    };
    for process in processes.flatten() {
        let name = process.file_name();
        let Ok(pid) = name.to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(fds) = std::fs::read_dir(process.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else {
                continue;
            };
            let Some(inode) = socket_inode(&target.to_string_lossy()) else {
                continue;
            };
            if wanted.contains(&inode) {
                owners.insert(inode, (pid, process_name(pid)));
            }
        }
        if owners.len() == wanted.len() {
            break;
        }
    }
    owners
}

/// Owners of the synthetic socket keys handed out by the `lsof` [`scan`] (pid and command as
/// `lsof` reported them; `ps` when the key was never seen by a scan).
#[cfg(not(target_os = "linux"))]
pub fn resolve_owners(inodes: &[u64]) -> BTreeMap<u64, (u32, String)> {
    let cached = lsof::owners();
    inodes
        .iter()
        .map(|inode| {
            let pid = lsof::pid_of_key(*inode);
            let name = cached
                .get(&pid)
                .cloned()
                .unwrap_or_else(|| process_name(pid));
            (*inode, (pid, name))
        })
        .collect()
}

/// `/proc/<pid>/comm`, or `"?"` when it cannot be read (the process just exited).
#[cfg(target_os = "linux")]
pub fn process_name(pid: u32) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .map(|comm| comm.trim().to_string())
        .unwrap_or_else(|_| "?".to_string())
}

/// `ps -o comm= -p <pid>` (basename), or `"?"` when it cannot be read.
#[cfg(not(target_os = "linux"))]
pub fn process_name(pid: u32) -> String {
    let output = std::process::Command::new("ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let name = String::from_utf8_lossy(&output.stdout);
            let name = name.trim();
            if name.is_empty() {
                "?".to_string()
            } else {
                name.rsplit('/').next().unwrap_or(name).to_string()
            }
        }
        _ => "?".to_string(),
    }
}

/// Owner pid of a listening socket on `port` (any address), if any – used by §3.9 to clear a stale
/// server (the RPC port and the control port). Infra ports are **not** filtered here.
#[cfg(target_os = "linux")]
pub fn owner_of_port(port: u16) -> std::io::Result<Option<(u32, String)>> {
    let mut sockets = parse_proc_net_tcp(&std::fs::read_to_string(PROC_NET_TCP)?, false);
    match std::fs::read_to_string(PROC_NET_TCP6) {
        Ok(text) => sockets.extend(parse_proc_net_tcp(&text, true)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let inodes: Vec<u64> = sockets
        .iter()
        .filter(|socket| socket.port == port)
        .map(|socket| socket.inode)
        .collect();
    Ok(resolve_owners(&inodes).into_values().next())
}

/// `lsof -iTCP:<port> -sTCP:LISTEN` fallback of [`owner_of_port`] (macOS under `ZS_LOCAL=1`).
#[cfg(not(target_os = "linux"))]
pub fn owner_of_port(port: u16) -> std::io::Result<Option<(u32, String)>> {
    let listeners = lsof::listen_table(Some(port))?;
    Ok(listeners
        .into_iter()
        .find(|listener| listener.port == port)
        .map(|listener| (listener.pid, listener.command)))
}

/// The `lsof`-backed socket table used where `/proc` does not exist. The parser is pure and
/// compiled everywhere (so it is unit-tested on Linux too); only the process spawning is gated
/// to non-Linux hosts and to `ZS_LOCAL=1`.
pub mod lsof {
    use std::collections::BTreeMap;
    use std::net::IpAddr;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::ListenSocket;

    /// One LISTEN socket as `lsof -nP -iTCP -sTCP:LISTEN -F pctn` reports it.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct LsofListener {
        /// Owning pid (`p` field).
        pub pid: u32,
        /// Command name (`c` field).
        pub command: String,
        /// `t` field is `IPv6`.
        pub v6: bool,
        /// Bound address; `None` for the wildcard (`*`).
        pub ip: Option<IpAddr>,
        /// Local port.
        pub port: u16,
    }

    /// Bits of the synthetic socket key reserved for the port.
    const PORT_BITS: u32 = 20;

    impl LsofListener {
        /// Synthetic stand-in for the `/proc` socket inode: `(pid << 20) | port`, unique per
        /// (process, port) and decodable by [`pid_of_key`].
        pub fn key(&self) -> u64 {
            ((self.pid as u64) << PORT_BITS) | self.port as u64
        }

        /// The [`ListenSocket`] view the platform-independent code works on.
        pub fn socket(&self) -> ListenSocket {
            ListenSocket {
                port: self.port,
                v4: !self.v6,
                v6: self.v6,
                loopback_only: self.ip.is_some_and(|ip| ip.is_loopback()),
                uid: 0,
                inode: self.key(),
            }
        }
    }

    /// The pid encoded in a [`LsofListener::key`].
    pub fn pid_of_key(key: u64) -> u32 {
        (key >> PORT_BITS) as u32
    }

    /// Parses `lsof -F pctn` output: `p<pid>` starts a process, `c<command>` names it, and every
    /// `n<addr>:<port>` line (preceded by `tIPv4`/`tIPv6`) is one listener. Unknown field
    /// letters are skipped, an unparsable name line is dropped.
    pub fn parse_listen_table(text: &str) -> Vec<LsofListener> {
        let mut listeners = Vec::new();
        let mut pid: Option<u32> = None;
        let mut command = String::new();
        let mut v6 = false;
        for line in text.lines() {
            let Some(letter) = line.chars().next() else {
                continue;
            };
            let value = &line[letter.len_utf8()..];
            match letter {
                'p' => {
                    pid = value.trim().parse().ok();
                    command.clear();
                    v6 = false;
                }
                'c' => command = value.trim().to_string(),
                't' => v6 = value.trim().eq_ignore_ascii_case("IPv6"),
                'n' => {
                    let Some(pid) = pid else { continue };
                    let Some((ip, port)) = parse_name(value.trim()) else {
                        continue;
                    };
                    listeners.push(LsofListener {
                        pid,
                        command: command.clone(),
                        v6,
                        ip,
                        port,
                    });
                }
                _ => {}
            }
        }
        listeners
    }

    /// `127.0.0.1:3000` → `(Some(127.0.0.1), 3000)`; `*:8080` → `(None, 8080)`;
    /// `[::1]:5173` → `(Some(::1), 5173)`. A `->peer` suffix (never present for LISTEN sockets)
    /// is cut off.
    pub fn parse_name(name: &str) -> Option<(Option<IpAddr>, u16)> {
        let name = name.split("->").next()?;
        let (address, port) = name.rsplit_once(':')?;
        let port: u16 = port.parse().ok()?;
        let address = address.trim_start_matches('[').trim_end_matches(']');
        if address == "*" {
            return Some((None, port));
        }
        Some((Some(address.parse().ok()?), port))
    }

    static FORCED: AtomicBool = AtomicBool::new(false);

    /// `zs-agent start --local`: the fallback without the environment variable.
    pub fn force_enabled() {
        FORCED.store(true, Ordering::Relaxed);
    }

    /// Whether the fallback may spawn `lsof` (`ZS_LOCAL=1`, or [`force_enabled`]).
    pub fn enabled() -> bool {
        FORCED.load(Ordering::Relaxed)
            || std::env::var("ZS_LOCAL").is_ok_and(|value| matches!(value.trim(), "1" | "true"))
    }

    /// Runs `lsof -nP -iTCP[:port] -sTCP:LISTEN -F pctn` and parses it. `Unsupported` unless
    /// `ZS_LOCAL=1`; an `lsof` that exits non-zero with no output means "no listeners".
    pub fn listen_table(port: Option<u16>) -> std::io::Result<Vec<LsofListener>> {
        if !enabled() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "no /proc/net/tcp on this host; set ZS_LOCAL=1 for the lsof fallback",
            ));
        }
        let selector = match port {
            Some(port) => format!("-iTCP:{port}"),
            None => "-iTCP".to_string(),
        };
        let output = std::process::Command::new("lsof")
            .args(["-nP", &selector, "-sTCP:LISTEN", "-F", "pctn"])
            .stdin(std::process::Stdio::null())
            .output()?;
        if !output.status.success() && !output.stderr.is_empty() && output.stdout.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // `lsof` exits 1 both for "nothing matched" and for real failures; only the
            // latter carries a diagnostic worth surfacing.
            if !stderr.trim().is_empty() && !stderr.contains("no Internet files") {
                return Err(std::io::Error::other(format!("lsof: {}", stderr.trim())));
            }
        }
        Ok(parse_listen_table(&String::from_utf8_lossy(&output.stdout)))
    }

    static OWNERS: Mutex<BTreeMap<u32, String>> = Mutex::new(BTreeMap::new());

    /// Remembers pid → command from a scan so [`super::resolve_owners`] needs no second
    /// `lsof` round trip.
    pub fn remember_owners(listeners: &[LsofListener]) {
        let mut owners = OWNERS.lock().unwrap_or_else(|e| e.into_inner());
        owners.clear();
        for listener in listeners {
            owners.insert(listener.pid, listener.command.clone());
        }
    }

    /// The last remembered pid → command map.
    pub fn owners() -> BTreeMap<u32, String> {
        OWNERS.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// Shared, lock-protected copy of the last scan.
#[derive(Clone, Default)]
pub struct ListeningState {
    inner: Arc<RwLock<Vec<ListeningPort>>>,
    changed: Arc<tokio::sync::Notify>,
}

impl ListeningState {
    /// The last published list.
    pub fn current(&self) -> Vec<ListeningPort> {
        self.inner
            .read()
            .map(|ports| ports.clone())
            .unwrap_or_default()
    }

    /// Replaces the list.
    pub fn set(&self, ports: Vec<ListeningPort>) {
        if let Ok(mut inner) = self.inner.write()
            && *inner != ports
        {
            *inner = ports;
            self.changed.notify_one();
        }
    }

    /// Wake the activity relay immediately when discovery changes.
    pub async fn changed(&self) {
        self.changed.notified().await;
    }

    /// `(v4, v6)` flags of a listening port, if known.
    pub fn address_family(&self, port: u16) -> Option<(bool, bool)> {
        self.inner
            .read()
            .ok()?
            .iter()
            .find(|entry| entry.port == port)
            .map(|entry| (entry.v4, entry.v6))
    }
}

/// Every `interval` (2 s): scan → diff → on change resolve owners for new inodes, cache the rest,
/// update `listening`, then `server.post_ports(ports, forwards.current())`. A publish that the
/// server did not acknowledge (it was still binding its control listener, or it is down) stays
/// `pending` and is retried every tick, and the table is republished whenever a (re)spawned
/// server starts accepting (`AgentState::server_up_watch`) and after every forwards change
/// (`forwards.changed()`). Paused while `state.status() == Stopping`.
pub async fn watch(
    interval: Duration,
    server: ServerControl,
    forwards: ForwardsState,
    listening: ListeningState,
    state: Arc<AgentState>,
    shutdown: CancellationToken,
) {
    let self_pid = std::process::id();
    let mut forwards_changed = forwards.changed();
    let mut server_up = state.server_up_watch();
    let mut previous = BTreeMap::new();
    let mut owners: BTreeMap<u64, (u32, String)> = BTreeMap::new();
    let mut scan_error_logged = false;
    // The first pass always publishes, so the server learns the table even when nothing listens;
    // afterwards `pending` is cleared only by an acknowledged POST.
    let mut pending = true;
    loop {
        if state.status() != HealthStatus::Stopping {
            match scan(self_pid) {
                Ok(scanned) => {
                    scan_error_logged = false;
                    let current: BTreeSet<u16> = scanned.keys().copied().collect();
                    let diff = diff_ports(&previous.keys().copied().collect(), &current);
                    // Rebinding the same port can change the owner or IPv4/IPv6 address family.
                    let changed = previous != scanned;
                    if changed || pending {
                        let unknown: Vec<u64> = scanned
                            .values()
                            .map(|socket| socket.inode)
                            .filter(|inode| !owners.contains_key(inode))
                            .collect();
                        if !unknown.is_empty() {
                            // The `/proc/*/fd` walk is synchronous and can take a while on a
                            // busy box; keep it off the two runtime workers.
                            let resolved =
                                tokio::task::spawn_blocking(move || resolve_owners(&unknown))
                                    .await
                                    .unwrap_or_default();
                            owners.extend(resolved);
                        }
                        owners.retain(|inode, _| {
                            scanned.values().any(|socket| socket.inode == *inode)
                        });
                        let ports: Vec<ListeningPort> = scanned
                            .values()
                            .map(|socket| {
                                let (pid, process_name) = owners
                                    .get(&socket.inode)
                                    .cloned()
                                    .unwrap_or((0, String::new()));
                                ListeningPort {
                                    port: socket.port,
                                    pid,
                                    process_name,
                                    v4: socket.v4,
                                    v6: socket.v6,
                                    loopback_only: socket.loopback_only,
                                }
                            })
                            .collect();
                        listening.set(ports.clone());
                        if changed {
                            tracing::info!(
                                added = ?diff.added,
                                removed = ?diff.removed,
                                "listening ports changed"
                            );
                        }
                        previous = scanned;
                        pending = true;
                        match server.post_ports(&ports, &forwards.current()).await {
                            Ok(()) => pending = false,
                            Err(error) => tracing::debug!(
                                error = %error,
                                "could not publish ports to the server; retrying next tick"
                            ),
                        }
                    }
                }
                Err(error) => {
                    if !scan_error_logged {
                        scan_error_logged = true;
                        tracing::warn!(error = %error, "cannot read the socket table");
                    }
                }
            }
        }
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = tokio::time::sleep(interval) => {}
            changed = forwards_changed.changed() => {
                if changed.is_err() {
                    break;
                }
                pending = true;
            }
            changed = server_up.changed() => {
                if changed.is_err() {
                    break;
                }
                // A freshly accepting server has no port table yet (and a dead one will
                // refuse the POST until it is respawned): republish.
                pending = true;
            }
        }
    }
}
