"""Private Jupyter channels over the supervisor's authenticated stdio tunnel."""

import asyncio
import contextlib
import datetime
import json
import os
import re
import secrets
import signal
import socket
import sys
import tempfile
from string import Template

from jupyter_client import AsyncKernelClient
from jupyter_client.kernelspec import KernelSpec, KernelSpecManager

MAX_MESSAGE = 8 * 1024 * 1024


def json_default(value):
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    raise TypeError(type(value).__name__)


def kernel_spec(request):
    if request["kind"] == "python":
        return KernelSpec(
            argv=[request["executable"] or sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
            display_name="Python", language="python",
        )
    if request["kind"] != "kernelspec":
        raise ValueError("Invalid kernel selection")
    spec = KernelSpecManager(ensure_native_kernel=False).get_kernel_spec(request["name"])
    if spec.metadata.get("kernel_provisioner", {}).get("provisioner_name", "local-provisioner") != "local-provisioner":
        raise ValueError("Only kernels running locally in this sandbox are supported")
    return spec


def list_kernels():
    kernels = [{"name": "Python (sandbox)", "language": "python", "kernel": {"kind": "python", "executable": None}}]
    for name, entry in sorted(KernelSpecManager(ensure_native_kernel=False).get_all_specs().items()):
        spec = entry["spec"]
        # The bundled interpreter already has a stable, friendly entry above.
        if name == "python3" and entry["resource_dir"] == os.path.join(sys.prefix, "share/jupyter/kernels/python3"):
            continue
        if spec.get("metadata", {}).get("kernel_provisioner", {}).get("provisioner_name", "local-provisioner") != "local-provisioner":
            continue
        # Like native Zed, use the registered identifier, also saved in notebook metadata.
        kernels.append({"name": name, "language": spec["language"], "kernel": {"kind": "kernelspec", "name": name}})
    return kernels


async def main():
    request = json.loads(sys.argv[1])
    if request["kind"] == "list":
        payload = json.dumps(list_kernels())
        if len(payload.encode()) >= MAX_MESSAGE:
            raise ValueError("Kernel list exceeds the 8 MiB message limit")
        print(payload, flush=True)
        return
    spec = kernel_spec(request)
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_MESSAGE)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    transport, protocol = await loop.connect_write_pipe(
        lambda: asyncio.streams.FlowControlMixin(loop=loop), sys.stdout.buffer
    )
    writer = asyncio.StreamWriter(transport, protocol, None, loop)
    send_lock = asyncio.Lock()

    async def send(message):
        message.pop("buffers", None)  # Inline rich output, not binary widget comms.
        if message.get("header", {}).get("msg_type") == "kernel_info_reply":
            # Some kernels (including Bash) omit this metadata. Zed requires a
            # string; an empty version means unknown, not a fabricated version.
            message["content"]["language_info"].setdefault("version", "")
        # Zed's typed protocol requires status on control replies; ipykernel
        # omits it on shutdown replies, and SIGINT replies are generated here.
        if message.get("header", {}).get("msg_type") in ("interrupt_reply", "shutdown_reply"):
            message["content"].setdefault("status", "ok")
        payload = json.dumps(message, default=json_default).encode() + b"\n"
        if len(payload) > MAX_MESSAGE:
            raise ValueError("Kernel output exceeds the 8 MiB message limit")
        async with send_lock:
            writer.write(payload)
            await writer.drain()

    # Linux anonymous file: neither disconnect nor SIGKILL leaves credentials on disk.
    # Address the bridge's fd so wrappers can spawn a kernel without inheriting it.
    with tempfile.TemporaryFile() as connection, contextlib.ExitStack() as handles:
        config = {"ip": "127.0.0.1", "transport": "tcp", "key": secrets.token_hex(32), "signature_scheme": "hmac-sha256"}
        with contextlib.ExitStack() as ports:
            for channel in ("shell", "iopub", "stdin", "control", "hb"):
                listener = ports.enter_context(socket.socket())
                listener.bind(("127.0.0.1", 0))
                config[channel + "_port"] = listener.getsockname()[1]
        connection.write(json.dumps(config).encode())
        connection.flush()
        substitutions = {"connection_file": f"/proc/{os.getpid()}/fd/{connection.fileno()}", "resource_dir": spec.resource_dir}
        command = [re.sub(r"\{([A-Za-z0-9_]+)\}", lambda match: substitutions.get(match[1], match[0]), arg) for arg in spec.argv]
        if not command:
            raise ValueError("Kernel specification has no command")
        # Match Jupyter's interpretation of an unqualified Python executable.
        if command[0] in ("python", f"python{sys.version_info.major}", f"python{sys.version_info.major}.{sys.version_info.minor}"):
            command[0] = sys.executable
        env = dict(os.environ)
        env.update({key: Template(value).safe_substitute(os.environ) for key, value in spec.env.items()})
        # Manage stderr separately: asyncio's subprocess wait otherwise waits for
        # EOF from every descendant that inherited the pipe, not just this child.
        error_input, error_output = os.pipe()
        error_input = handles.enter_context(os.fdopen(error_input, "rb"))
        error_output = handles.enter_context(os.fdopen(error_output, "wb"))
        error_reader = asyncio.StreamReader()
        error_transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(error_reader), error_input)
        handles.callback(error_transport.close)
        # Remain in the supervisor's process group so disconnect kills descendants too.
        child = await asyncio.create_subprocess_exec(
            *command, env=env, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL, stderr=error_output,
        )
        error_output.close()
        errors = bytearray()

        async def drain_errors():
            while data := await error_reader.read(4096):
                errors.extend(data)
                del errors[:-8192]

        stderr = asyncio.create_task(drain_errors())
        client = AsyncKernelClient()
        client.load_connection_info(config)
        tasks = []
        try:
            # We supervise the actual child below. A one-second heartbeat timeout
            # can falsely report a slow cold-starting kernel as dead.
            client.start_channels(hb=False)
            ready = asyncio.create_task(client.wait_for_ready(timeout=30))
            exited = asyncio.create_task(child.wait())
            tasks = [ready, exited]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            if exited in done:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(asyncio.shield(stderr), 0.1)
                hint = " Install ipykernel in the selected environment." if request["kind"] == "python" else " Check the installed kernelspec and its dependencies."
                raise RuntimeError(f"{spec.display_name} kernel could not start.{hint} " + errors.decode(errors="replace"))
            try:
                await ready
            except Exception as error:
                raise RuntimeError(f"Could not start {spec.display_name}: {error}. {errors.decode(errors='replace')}") from error
            await send({"ready": True, "pid": child.pid})

            async def receive():
                while line := await reader.readline():
                    if len(line) > MAX_MESSAGE:
                        raise ValueError("Kernel request exceeds the 8 MiB message limit")
                    message = json.loads(line)
                    kind = message["header"]["msg_type"]
                    channel = message.get("channel") or "shell"
                    if kind == "interrupt_request" and spec.interrupt_mode == "signal":
                        child.send_signal(signal.SIGINT)
                        reply = client.session.msg("interrupt_reply", {}, parent=message)
                        reply["channel"] = "control"
                        await send(reply)
                    else:
                        if kind in ("interrupt_request", "shutdown_request", "debug_request"):
                            channel = "control"
                        if channel not in ("shell", "control", "stdin"):
                            raise ValueError("Invalid kernel request channel")
                        getattr(client, channel + "_channel").send(message)

            async def relay(channel):
                while True:
                    message = await getattr(client, "get_" + channel + "_msg")()
                    message["channel"] = channel
                    await send(message)

            tasks.append(asyncio.create_task(receive()))
            tasks += [asyncio.create_task(relay(c)) for c in ("shell", "control", "stdin", "iopub")]
            done, _ = await asyncio.wait(tasks[1:], return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            client.stop_channels()
            if child.returncode is None:
                child.kill()
            await child.wait()
            error_transport.close()
            await stderr


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    except Exception as error:
        with contextlib.suppress(BrokenPipeError):
            print(json.dumps({"error": str(error)[:8192]}), flush=True)
        sys.exit(1)
