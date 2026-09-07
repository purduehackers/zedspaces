"""Private Jupyter channels over the supervisor's authenticated stdio tunnel."""

import asyncio
import contextlib
import datetime
import json
import secrets
import signal
import socket
import sys
import tempfile

from jupyter_client import AsyncKernelClient

MAX_MESSAGE = 8 * 1024 * 1024


def json_default(value):
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    raise TypeError(type(value).__name__)


async def main():
    python = sys.argv[1]
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
        payload = json.dumps(message, default=json_default).encode() + b"\n"
        if len(payload) > MAX_MESSAGE:
            raise ValueError("Kernel output exceeds the 8 MiB message limit")
        async with send_lock:
            writer.write(payload)
            await writer.drain()

    # Linux anonymous file: neither disconnect nor SIGKILL leaves credentials on disk.
    # Keep the fd inherited so ipykernel's connection_file remains readable at runtime.
    with tempfile.TemporaryFile() as connection:
        config = {"ip": "127.0.0.1", "transport": "tcp", "key": secrets.token_hex(32), "signature_scheme": "hmac-sha256"}
        with contextlib.ExitStack() as ports:
            for channel in ("shell", "iopub", "stdin", "control", "hb"):
                listener = ports.enter_context(socket.socket())
                listener.bind(("127.0.0.1", 0))
                config[channel + "_port"] = listener.getsockname()[1]
        connection.write(json.dumps(config).encode())
        connection.flush()
        # Remain in the supervisor's process group so disconnect kills descendants too.
        child = await asyncio.create_subprocess_exec(
            python, "-m", "ipykernel_launcher", "-f", f"/proc/self/fd/{connection.fileno()}",
            pass_fds=(connection.fileno(),), stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        errors = bytearray()

        async def drain_errors():
            while data := await child.stderr.read(4096):
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
                await stderr
                raise RuntimeError("Python kernel could not start; install ipykernel in the selected environment. " + errors.decode(errors="replace"))
            try:
                await ready
            except Exception as error:
                raise RuntimeError(f"Could not start the selected Python kernel: {error}. {errors.decode(errors='replace')}") from error
            await send({"ready": True, "pid": child.pid})

            async def receive():
                while line := await reader.readline():
                    if len(line) > MAX_MESSAGE:
                        raise ValueError("Kernel request exceeds the 8 MiB message limit")
                    message = json.loads(line)
                    kind = message["header"]["msg_type"]
                    channel = message.get("channel") or "shell"
                    if kind == "interrupt_request":
                        child.send_signal(signal.SIGINT)
                        reply = client.session.msg("interrupt_reply", {}, parent=message)
                        reply["channel"] = "control"
                        await send(reply)
                    else:
                        if kind in ("shutdown_request", "debug_request"):
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
