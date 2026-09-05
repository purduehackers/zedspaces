//! Live `/proc/net/tcp` tests (brief §6.2 `port_watcher_live.rs`).
//!
//! Linux only: the socket table and `/proc/<pid>/fd` do not exist elsewhere, so on any other
//! platform the test compiles to a no-op and the pure parsing is covered by `ports.rs`'s unit
//! tests instead.

#![cfg(target_os = "linux")]

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

use tokio::net::TcpListener;

use zs_agent::ports;

#[tokio::test(flavor = "multi_thread")]
async fn scan_sees_a_loopback_listener_and_resolves_its_owner() {
    let listener = TcpListener::bind(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)))
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();

    // `self_pid = 0` disables the "drop our own sockets" filter, so the test's own listener shows.
    let scanned = ports::scan(0).expect("read the socket table");
    let socket = scanned
        .get(&port)
        .unwrap_or_else(|| panic!("port {port} is missing from the scan"));
    assert!(socket.loopback_only, "bound to 127.0.0.1");
    assert!(socket.v4);
    assert_ne!(socket.inode, 0);

    let owners = ports::resolve_owners(&[socket.inode]);
    let (pid, comm) = owners
        .get(&socket.inode)
        .expect("the socket's owner is this process");
    assert_eq!(*pid, std::process::id());
    assert!(!comm.is_empty());

    let owner = ports::owner_of_port(port).expect("read the socket table");
    assert_eq!(owner.map(|(pid, _)| pid), Some(std::process::id()));

    // The agent's own sockets are filtered out when it passes its real pid.
    let filtered = ports::scan(std::process::id()).expect("read the socket table");
    assert!(!filtered.contains_key(&port));
}

#[tokio::test(flavor = "multi_thread")]
async fn scan_hides_the_infrastructure_ports() {
    let scanned = ports::scan(0).expect("read the socket table");
    assert!(
        scanned.keys().all(|port| !ports::is_infra_port(*port)),
        "the D21 infrastructure set is never reported as a user port"
    );
}
