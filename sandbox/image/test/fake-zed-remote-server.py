#!/usr/bin/env python3
"""A stand-in for `zed-remote-server serve` (brief b8 §3.23).

Speaks just enough of the b2 `serve` contract for the supervisor to boot against it:

* accepts the `ServeArgs` command line the supervisor builds (`sandbox/supervisor/src/server.rs`),
* binds `--listen` (public) and `--control-listen` (loopback control listener),
* writes `--port-file`, prints `ZS_LISTENING=` and `ZS_CONTROL_LISTENING=` on stdout,
* serves `GET /health` (b2 `HealthResponse` shape) on the public listener,
* serves `POST /control/{lifecycle,ports,extensions}` on the control listener only, authenticated
  with the bearer from `--control-secret-file`, and records every body for `GET /__fake/state`,
* refuses to start when `ZS_CONTROL_SECRET` is in the environment (D18: the secret only ever
  travels as a file path),
* exits 0 on SIGTERM.

Extra test hooks: `POST /__fake/attach` flips `session_active`, `POST /__fake/crash` makes the
process exit 1 (leaving any linger child behind, like a crashed server would), `GET /__fake/state`
returns the recorded control calls plus the environment and argv the server was started with,
`--stopping-delay` slows the `stopping` lifecycle answer, `--linger-child` spawns a `sleep 3600`
inside the server's own process group (the supervisor gives the server one with
`process_group(0)`) so the harness can prove the shutdown path kills the whole group and not just
the leader, and `--state-file <path>` dumps the same state as `/__fake/state` when the process
exits (SIGTERM or crash), so a harness can inspect it after the fact.

The public listener also speaks just enough of b1's `/rpc` wire protocol for the prebuild
warm-up client (`sandbox/supervisor/src/warm.rs`): a WebSocket upgrade with
`Sec-WebSocket-Protocol: zs.v1, <jwt>` (echoed as `zs.v1`, the token is not verified), the
`hello` → `hello_ack` text frames, then `u32 LE len || protobuf(Envelope)` binary frames –
`RemoteStarted` first, `AddWorktree` → `AddWorktreeResponse`, `OpenBufferByPath` →
`OpenBufferResponse` preceded by one `UpdateLanguageServer`. The protobuf subset is hand-encoded
(tag numbers from `sandbox/supervisor/proto/zs_warm.proto`); every envelope kind the client sent
is recorded under `state.warm`.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

VERSION = "0.0.0-fake"
MAX_BODY = 64 * 1024
# b2 `ServeLogRecord.level` is `usize` in `log::Level` order: Error = 1 … Trace = 5.
LEVEL_INFO = 3
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

started_at = time.time()
state_lock = threading.Lock()
recorded: dict[str, list[Any]] = {"lifecycle": [], "ports": [], "extensions": []}
session_active = False
last_input_at: int | None = None
workspace_id = os.environ.get("ZS_WORKSPACE_ID", "")
# Filled by `main`: what the supervisor started us with, exposed at /__fake/state.
started_with: dict[str, Any] = {"argv": [], "env": {}, "linger_child_pid": None}
# Timeline the shutdown assertions read: when `stopping` arrived, when SIGTERM did.
timeline: dict[str, Any] = {"stopping_at": None, "sigterm_at": None, "crash_at": None}
warm: dict[str, Any] = {"connections": 0, "subprotocol": None, "hello": None, "worktree": None, "opened": [], "kinds": []}
state_file: str | None = None


def log(message: str, **fields: Any) -> None:
    """One JSON object per line on stderr, like b2's `ServeLogRecord`."""
    record = {
        "ts_ms": int(time.time() * 1000),
        "level": LEVEL_INFO,
        "module_path": "fake_zed_remote_server",
        "file": "fake-zed-remote-server.py",
        "line": 0,
        "message": message,
        "ws": workspace_id,
        "mode": "serve",
    }
    record.update(fields)
    sys.stderr.write(json.dumps(record) + "\n")
    sys.stderr.flush()


def snapshot() -> dict[str, Any]:
    """Everything a harness may assert on (`GET /__fake/state`, `--state-file`)."""
    with state_lock:
        return {
            "recorded": json.loads(json.dumps(recorded)),
            "sessionActive": session_active,
            "argv": list(started_with["argv"]),
            "env": dict(started_with["env"]),
            "lingerChildPid": started_with["linger_child_pid"],
            "timeline": dict(timeline),
            "warm": json.loads(json.dumps(warm)),
            "pid": os.getpid(),
        }


def dump_state() -> None:
    if not state_file:
        return
    try:
        tmp = f"{state_file}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(snapshot(), handle)
        os.replace(tmp, state_file)
    except OSError as error:
        log("could not write the state file", error=str(error))


# --- minimal protobuf (tags from sandbox/supervisor/proto/zs_warm.proto) -------------------

def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _field(number: int, wire_type: int, payload: bytes | int) -> bytes:
    key = _varint((number << 3) | wire_type)
    if wire_type == 0:
        return key + _varint(int(payload))
    assert isinstance(payload, bytes)
    return key + _varint(len(payload)) + payload


def _read_varint(data: bytes, index: int) -> tuple[int, int]:
    shift = 0
    value = 0
    while True:
        byte = data[index]
        index += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, index
        shift += 7


def parse_message(data: bytes) -> list[tuple[int, int, Any]]:
    """`(field number, wire type, value)` triples; length-delimited values are raw bytes."""
    fields: list[tuple[int, int, Any]] = []
    index = 0
    while index < len(data):
        key, index = _read_varint(data, index)
        number, wire_type = key >> 3, key & 0x7
        if wire_type == 0:
            value, index = _read_varint(data, index)
        elif wire_type == 1:
            value, index = data[index : index + 8], index + 8
        elif wire_type == 2:
            length, index = _read_varint(data, index)
            value, index = data[index : index + length], index + length
        elif wire_type == 5:
            value, index = data[index : index + 4], index + 4
        else:
            raise ValueError(f"unsupported wire type {wire_type}")
        fields.append((number, wire_type, value))
    return fields


# Envelope oneof tags (zed.proto) the warm-up exchange uses.
TAG_ADD_WORKTREE = 222
TAG_ADD_WORKTREE_RESPONSE = 223
TAG_OPEN_BUFFER_BY_PATH = 57
TAG_OPEN_BUFFER_RESPONSE = 58
TAG_UPDATE_LANGUAGE_SERVER = 55
TAG_REMOTE_STARTED = 381
TAG_ACK = 5
TAG_PING = 7
TAG_FLUSH_BUFFERED_MESSAGES = 267
KIND_BY_TAG = {
    TAG_ADD_WORKTREE: "add_worktree",
    TAG_OPEN_BUFFER_BY_PATH: "open_buffer_by_path",
    TAG_ACK: "ack",
    TAG_PING: "ping",
    TAG_FLUSH_BUFFERED_MESSAGES: "flush_buffered_messages",
}


def envelope(envelope_id: int, payload_tag: int, payload: bytes, responding_to: int | None = None) -> bytes:
    body = _field(1, 0, envelope_id) if envelope_id else b""
    if responding_to is not None:
        body += _field(2, 0, responding_to)
    body += _field(payload_tag, 2, payload)
    return len(body).to_bytes(4, "little") + body


def decode_envelope(frame: bytes) -> tuple[int, int | None, bytes]:
    """`(id, payload tag, payload bytes)` of one `u32 LE len || Envelope` frame."""
    length = int.from_bytes(frame[:4], "little")
    body = frame[4 : 4 + length]
    envelope_id = 0
    payload_tag = None
    payload = b""
    for number, wire_type, value in parse_message(body):
        if number == 1 and wire_type == 0:
            envelope_id = value
        elif wire_type == 2 and number not in (3,):
            payload_tag = number
            payload = value
    return envelope_id, payload_tag, payload


# --- minimal WebSocket server side --------------------------------------------------------

def ws_read_frame(rfile: Any) -> tuple[int, bytes] | None:
    head = rfile.read(2)
    if len(head) < 2:
        return None
    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F
    if length == 126:
        length = int.from_bytes(rfile.read(2), "big")
    elif length == 127:
        length = int.from_bytes(rfile.read(8), "big")
    mask = rfile.read(4) if masked else b""
    payload = rfile.read(length)
    if masked:
        payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
    return opcode, payload


def ws_frame(opcode: int, payload: bytes) -> bytes:
    header = bytes([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header += bytes([length])
    elif length < 65536:
        header += bytes([126]) + length.to_bytes(2, "big")
    else:
        header += bytes([127]) + length.to_bytes(8, "big")
    return header + payload


def parse_addr(value: str) -> tuple[str, int]:
    host, _, port = value.rpartition(":")
    return (host or "0.0.0.0", int(port))


def parse_args(argv: list[str]) -> argparse.Namespace:
    if argv and argv[0] == "serve":
        argv = argv[1:]
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--listen", default="0.0.0.0:8443")
    parser.add_argument("--jwt-public-key", action="append", default=[])
    parser.add_argument("--workspace-id", "--workspace", dest="workspace_id", default="")
    parser.add_argument("--audience", default="")
    parser.add_argument("--issuer", default="zs")
    parser.add_argument("--workspace-root", default="/workspaces")
    parser.add_argument("--client-build", "--allow-build", dest="client_build", default="dev")
    parser.add_argument("--allowed-origin", action="append", default=[])
    parser.add_argument("--control-secret-file", required=True)
    parser.add_argument("--control-listen", default="127.0.0.1:8451")
    parser.add_argument("--supervisor-url", default="http://127.0.0.1:8450")
    parser.add_argument("--port-file", default=None)
    parser.add_argument("--log-file", default=None)
    parser.add_argument("--stopping-delay", type=float, default=0.5)
    parser.add_argument("--linger-child", action="store_true")
    parser.add_argument("--state-file", default=None)
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        log("ignoring unknown arguments", message_extra=" ".join(unknown))
    return args


class Handler(BaseHTTPRequestHandler):
    """Shared handler; `listener` says which socket the request arrived on."""

    protocol_version = "HTTP/1.1"
    listener = "public"
    secret = ""

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003 - BaseHTTPRequestHandler API
        log(fmt % args, listener=self.listener)

    def _json(self, status: int, body: Any) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("content-length", "0")
        self.end_headers()

    def _body(self) -> Any:
        length = min(int(self.headers.get("content-length") or 0), MAX_BODY)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"_raw": raw.decode("utf-8", "replace")}

    def _authorized(self) -> bool:
        peer = self.client_address[0]
        if peer not in ("127.0.0.1", "::1"):
            return False
        return self.headers.get("authorization", "") == f"Bearer {self.secret}"

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/rpc" and self.listener == "public":
            self._rpc()
            return
        if self.path == "/health":
            with state_lock:
                body = {
                    "build": os.environ.get("ZS_BUILD_ID", "dev"),
                    "version": VERSION,
                    "uptime_secs": int(time.time() - started_at),
                    "workspace_id": os.environ.get("ZS_WORKSPACE_ID", ""),
                    "session_active": session_active,
                    "last_input_at": last_input_at,
                    "session": {"session_id": "ses_fake"} if session_active else None,
                    "dirty_buffers": 0,
                }
            self._json(200, body)
            return
        if self.path == "/__fake/state":
            self._json(200, snapshot())
            return
        self._json(404, {"error": "not_found"})

    def _rpc(self) -> None:
        """The warm-up client's WebSocket session (see the module docstring)."""
        upgrade = self.headers.get("upgrade", "").lower()
        key = self.headers.get("sec-websocket-key", "")
        offered = self.headers.get("sec-websocket-protocol", "")
        if upgrade != "websocket" or not key:
            self._json(400, {"error": "expected a websocket upgrade"})
            return
        if not offered.startswith("zs.v1, "):
            self._json(401, {"error": "expected `zs.v1, <token>` in sec-websocket-protocol"})
            return
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.send_response(101)
        self.send_header("upgrade", "websocket")
        self.send_header("connection", "Upgrade")
        self.send_header("sec-websocket-accept", accept)
        self.send_header("sec-websocket-protocol", "zs.v1")
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        with state_lock:
            warm["connections"] += 1
            warm["subprotocol"] = offered
        log("rpc: websocket upgraded")

        def send(opcode: int, payload: bytes) -> None:
            self.wfile.write(ws_frame(opcode, payload))
            self.wfile.flush()

        next_id = 1
        while True:
            frame = ws_read_frame(self.rfile)
            if frame is None:
                break
            opcode, payload = frame
            if opcode == 8:  # close
                send(8, payload[:2])
                break
            if opcode == 9:  # ping
                send(10, payload)
                continue
            if opcode == 1:  # text control frame
                try:
                    control = json.loads(payload.decode("utf-8", "replace"))
                except json.JSONDecodeError:
                    control = {}
                if control.get("type") == "hello":
                    with state_lock:
                        warm["hello"] = control
                    ack = {
                        "type": "hello_ack",
                        "protocol": 1,
                        "build": os.environ.get("ZS_BUILD_ID", "dev"),
                        "os": "linux",
                        "arch": "x86_64",
                        "os_version": None,
                        "shell": "/bin/bash",
                        "resumed": False,
                        "session_id": control.get("session_id"),
                        "epoch": 1,
                    }
                    send(1, json.dumps(ack).encode())
                    send(2, envelope(0, TAG_REMOTE_STARTED, b""))
                    with state_lock:
                        global session_active, last_input_at
                        session_active = True
                        last_input_at = int(time.time() * 1000)
                continue
            if opcode != 2:
                continue
            envelope_id, tag, body = decode_envelope(payload)
            with state_lock:
                warm["kinds"].append(KIND_BY_TAG.get(tag, f"unknown:{tag}"))
            if tag == TAG_ADD_WORKTREE:
                path = ""
                for number, wire_type, value in parse_message(body):
                    if number == 1 and wire_type == 2:
                        path = value.decode("utf-8", "replace")
                with state_lock:
                    warm["worktree"] = path
                response = _field(1, 0, 7) + _field(2, 2, path.encode())
                send(2, envelope(next_id, TAG_ADD_WORKTREE_RESPONSE, response, responding_to=envelope_id))
                next_id += 1
            elif tag == TAG_OPEN_BUFFER_BY_PATH:
                path = ""
                for number, wire_type, value in parse_message(body):
                    if number == 3 and wire_type == 2:
                        path = value.decode("utf-8", "replace")
                with state_lock:
                    warm["opened"].append(path)
                update = _field(1, 0, 0) + _field(2, 0, 1) + _field(8, 2, b"rust-analyzer")
                send(2, envelope(next_id, TAG_UPDATE_LANGUAGE_SERVER, update))
                next_id += 1
                send(2, envelope(next_id, TAG_OPEN_BUFFER_RESPONSE, _field(1, 0, 42), responding_to=envelope_id))
                next_id += 1
        log("rpc: websocket closed")
        with state_lock:
            session_active = False

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/__fake/attach":
            global session_active, last_input_at
            with state_lock:
                session_active = True
                last_input_at = int(time.time() * 1000)
            self._json(200, {"sessionActive": True})
            return
        if self.path == "/__fake/crash":
            with state_lock:
                timeline["crash_at"] = int(time.time() * 1000)
            log("crash requested; exiting 1")
            self._json(200, {"crashing": True})
            dump_state()

            def die() -> None:
                time.sleep(0.2)
                os._exit(1)

            threading.Thread(target=die, daemon=True).start()
            return

        if not self.path.startswith("/control/"):
            self._json(404, {"error": "not_found"})
            return
        if self.listener != "control":
            # The public listener never exposes /control (D5).
            self._json(404, {"error": "not_found"})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return

        kind = self.path.removeprefix("/control/")
        if kind not in recorded:
            self._json(404, {"error": "not_found"})
            return
        body = self._body()
        if isinstance(body, dict):
            body["at"] = int(time.time() * 1000)
        with state_lock:
            recorded[kind].append(body)
            if kind == "lifecycle" and isinstance(body, dict) and body.get("kind") == "stopping":
                timeline["stopping_at"] = body["at"]
        log("control call", control=kind)
        if kind == "lifecycle" and isinstance(body, dict) and body.get("kind") == "stopping":
            time.sleep(self.server.stopping_delay)  # type: ignore[attr-defined]
        self._empty(204)

    def do_DELETE(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._json(404, {"error": "not_found"})


def make_server(addr: tuple[str, int], listener: str, secret: str, stopping_delay: float) -> ThreadingHTTPServer:
    handler = type(f"Handler_{listener}", (Handler,), {"listener": listener, "secret": secret})
    server = ThreadingHTTPServer(addr, handler)
    server.daemon_threads = True
    server.stopping_delay = stopping_delay  # type: ignore[attr-defined]
    return server


def main() -> int:
    if os.environ.get("ZS_CONTROL_SECRET"):
        sys.stderr.write("ZS_CONTROL_SECRET must not be in the server environment (D18)\n")
        return 2

    argv = sys.argv[1:]
    if argv and argv[0] == "version":
        print(f"zed-remote-server {VERSION} (fake)")
        return 0

    args = parse_args(argv)
    global state_file
    state_file = args.state_file
    with open(args.control_secret_file, encoding="utf-8") as handle:
        secret = handle.read().rstrip("\n")
    if not secret:
        sys.stderr.write("--control-secret-file is empty\n")
        return 2
    with state_lock:
        started_with["argv"] = list(sys.argv[1:])
        started_with["env"] = dict(os.environ)

    public = make_server(parse_addr(args.listen), "public", secret, args.stopping_delay)
    control = make_server(parse_addr(args.control_listen), "control", secret, args.stopping_delay)

    listen_addr = f"{args.listen.rsplit(':', 1)[0]}:{public.server_address[1]}"
    control_addr = f"127.0.0.1:{control.server_address[1]}"
    if args.port_file:
        with open(args.port_file, "w", encoding="utf-8") as handle:
            handle.write(str(public.server_address[1]))
    print(f"ZS_LISTENING={listen_addr}", flush=True)
    print(f"ZS_CONTROL_LISTENING={control_addr}", flush=True)
    log(f"listening on {listen_addr}")

    child: subprocess.Popen[bytes] | None = None
    if args.linger_child:
        # Deliberately in this process's group: the supervisor's SIGKILL targets the group.
        child = subprocess.Popen(["sleep", "3600"], start_new_session=False)
        with state_lock:
            started_with["linger_child_pid"] = child.pid
        log("spawned linger child", pid=child.pid)
    dump_state()

    stop = threading.Event()

    def on_term(_signum: int, _frame: Any) -> None:
        with state_lock:
            timeline["sigterm_at"] = int(time.time() * 1000)
        log("received SIGTERM")
        stop.set()

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)

    for server in (public, control):
        threading.Thread(target=server.serve_forever, daemon=True).start()

    stop.wait()
    dump_state()
    public.shutdown()
    control.shutdown()
    log("exiting")
    return 0


if __name__ == "__main__":
    sys.exit(main())
