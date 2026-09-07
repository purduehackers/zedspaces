#!/usr/bin/env python3
"""Bounded working-tree ZIP export. Never follows links or includes .git."""

import argparse
import json
import os
import signal
import stat
import subprocess
import tempfile
import time
import zipfile

MAX_FILES = 20_000
MAX_BYTES = 256 * 1024 * 1024
MAX_NAMES = 4 * 1024 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class ExportError(Exception):
    pass


def components(path):
    parts = path.split("/") if path else []
    if any(part in ("", ".", "..", ".git") for part in parts) or "\0" in path or "\\" in path:
        raise ExportError("Choose a folder inside the project; .git cannot be exported.")
    return parts


def open_dir(root, parts):
    fd = os.dup(root)
    try:
        for part in parts:
            next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def git_paths(fd):
    # Keep cwd anchored to the already-open directory, even if it is renamed.
    # No shell, hooks, credentials or repository-provided executables are used.
    previous = os.open(".", DIR_FLAGS)
    process = None
    try:
        os.fchdir(fd)
        process = subprocess.Popen(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1",
                 "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0"},
        )
        pending = b""
        total = 0
        while chunk := process.stdout.read(65536):
            total += len(chunk)
            if total > MAX_NAMES:
                raise ExportError("Too many project paths. Export a smaller folder.")
            paths = (pending + chunk).split(b"\0")
            pending = paths.pop()
            for path in paths:
                yield path.decode("utf-8").rstrip("/")
        if process.wait() != 0 or pending:
            raise ExportError("Could not read Git's working-file list.")
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()
        os.fchdir(previous)
        os.close(previous)


def walk(fd, prefix=""):
    with os.scandir(fd) as entries:
        for entry in entries:
            if entry.name == ".git":
                continue
            name = prefix + entry.name
            if entry.is_dir(follow_symlinks=False):
                child = os.open(entry.name, DIR_FLAGS, dir_fd=fd)
                try:
                    yield from walk(child, name + "/")
                finally:
                    os.close(child)
            else:
                yield name


def create(root_path, folder, include_ignored):
    root = os.open(root_path, DIR_FLAGS)
    selected = None
    temporary = None
    count = total = skipped = 0
    try:
        selected = open_dir(root, components(folder))
        temporary = tempfile.mkdtemp(prefix="zedspaces-export-")
        destination = os.path.join(temporary, "project.zip")
        seen = set()
        candidates = walk(selected) if include_ignored else git_paths(selected)
        with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
            # A Git-listed directory is a submodule or a nested repository.
            def add_paths(base, paths, archive_prefix=""):
                nonlocal count, total, skipped
                for path in paths:
                    parts = components(path)
                    if not parts:
                        continue
                    name = archive_prefix + path
                    if name in seen:
                        continue
                    seen.add(name)
                    if len(seen) > MAX_FILES:
                        raise ExportError("Export exceeds 20,000 files. Choose a smaller folder.")
                    try:
                        parent = open_dir(base, parts[:-1])
                    except FileNotFoundError:
                        # A tracked file deleted from the working tree isn't exported.
                        continue
                    try:
                        try:
                            info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                        except FileNotFoundError:
                            continue
                        if stat.S_ISDIR(info.st_mode):
                            child = os.open(parts[-1], DIR_FLAGS, dir_fd=parent)
                            try:
                                add_paths(child, git_paths(child), name + "/")
                            finally:
                                os.close(child)
                            continue
                        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                            skipped += 1
                            continue
                        # O_NOFOLLOW protects against replacing a file with a symlink
                        # between listing and reading; directory components are fd-relative.
                        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                        with os.fdopen(fd, "rb") as source:
                            actual = os.fstat(source.fileno())
                            if not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1:
                                raise ExportError("A project file changed type during export. Try again.")
                            if total + actual.st_size > MAX_BYTES:
                                raise ExportError("Export exceeds 256 MiB. Choose a smaller folder.")
                            timestamp = min(4354819199, max(315532800, actual.st_mtime))
                            member = zipfile.ZipInfo(name, time.gmtime(timestamp)[:6])
                            member.compress_type = zipfile.ZIP_DEFLATED
                            member.external_attr = (stat.S_IFREG | (actual.st_mode & 0o777)) << 16
                            with archive.open(member, "w") as target:
                                while chunk := source.read(65536):
                                    total += len(chunk)
                                    if total > MAX_BYTES:
                                        raise ExportError("Export exceeds 256 MiB. Choose a smaller folder.")
                                    target.write(chunk)
                            count += 1
                    finally:
                        os.close(parent)

            add_paths(selected, candidates)
        return {"directory": os.path.basename(temporary), "bytes": os.path.getsize(destination), "files": count,
                "skippedFiles": skipped, "sourceBytes": total}
    except BaseException:
        if temporary:
            cleanup(os.path.join(temporary, "project.zip"))
        raise
    finally:
        if selected is not None:
            os.close(selected)
        os.close(root)


def cleanup(path):
    parent, basename = os.path.split(path)
    if basename != "project.zip" or os.path.dirname(parent) != tempfile.gettempdir():
        raise ExportError("Invalid temporary export path.")
    name = os.path.basename(parent)
    if not name.startswith("zedspaces-export-") or "/" in name:
        raise ExportError("Invalid temporary export path.")
    try:
        fd = os.open(parent, DIR_FLAGS)
    except FileNotFoundError:
        return
    try:
        try:
            os.unlink(basename, dir_fd=fd)
        except FileNotFoundError:
            pass
    finally:
        os.close(fd)
    os.rmdir(parent)


def cleanup_abandoned():
    with os.scandir(tempfile.gettempdir()) as entries:
        for entry in entries:
            if entry.name.startswith("zedspaces-export-") and entry.is_dir(follow_symlinks=False):
                try:
                    if entry.stat(follow_symlinks=False).st_mtime < time.time() - 1800:
                        cleanup(os.path.join(entry.path, "project.zip"))
                except OSError:
                    pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root")
    parser.add_argument("--folder", default="")
    parser.add_argument("--include-ignored", action="store_true")
    parser.add_argument("--cleanup")
    args = parser.parse_args()
    def timeout(_signum, _frame):
        raise ExportError("Export timed out. Choose a smaller folder.")
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(90)
    try:
        if args.cleanup:
            cleanup(args.cleanup)
        else:
            if not args.root:
                parser.error("--root is required")
            cleanup_abandoned()
            print(json.dumps(create(args.root, args.folder, args.include_ignored)))
    except (ExportError, OSError, UnicodeError, ValueError) as error:
        print(json.dumps({"error": str(error)}))
        raise SystemExit(1)
