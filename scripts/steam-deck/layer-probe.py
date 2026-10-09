#!/usr/bin/env python3
"""Bounded passive layer-shell probe; standard library only, no input grabs.

Run inside the target compositor's environment. This proves protocol acceptance,
not visible quality, capture exclusion, keyboard focus or controller ownership.

KNOWN FAILURE: SteamOS 3.8.16 / Gamescope 3.16.23.4 crashed after both probe
disconnects. Use a disposable nested compositor while investigating teardown.
"""
import array
import json
import mmap
import os
import socket
import struct
import time


def report(event, **fields):
    print(json.dumps({"event": event, "time": time.time(), **fields}), flush=True)


def uint(value):
    return struct.pack("=I", value)


def string(value):
    data = value.encode() + b"\0"
    return uint(len(data)) + data + b"\0" * ((-len(data)) % 4)


def main():
    if os.environ.get("KIMOCHI_ALLOW_LAYER_PROBE") != "1":
        raise RuntimeError("Known Gamescope session crash after teardown; set "
                           "KIMOCHI_ALLOW_LAYER_PROBE=1 only for intentional reproduction")
    display = os.environ.get("WAYLAND_DISPLAY", "wayland-0")
    path = display if display.startswith("/") else os.path.join(
        os.environ["XDG_RUNTIME_DIR"], display)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(path)
    sock.settimeout(1)
    objects = {1: "display"}
    next_id = 2
    pending = bytearray()
    globals_found = {}
    resources = []
    buffers = []
    teardown = os.environ.get("KIMOCHI_LAYER_TEARDOWN", "unmap")
    settle_seconds = float(os.environ.get("KIMOCHI_LAYER_SETTLE", "3"))
    if not 0 <= settle_seconds <= 5:
        raise RuntimeError("KIMOCHI_LAYER_SETTLE must be between 0 and 5 seconds")
    if teardown not in {"disconnect", "destroy", "unmap"}:
        raise RuntimeError("KIMOCHI_LAYER_TEARDOWN must be disconnect, destroy or unmap")

    def new(kind):
        nonlocal next_id
        result = next_id
        next_id += 1
        objects[result] = kind
        return result

    def send(obj, opcode, payload=b"", fd=None):
        message = struct.pack("=II", obj, ((len(payload) + 8) << 16) | opcode) + payload
        if fd is None:
            sock.sendall(message)
        else:
            sent = sock.sendmsg([message], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                            array.array("i", [fd]))])
            if sent < len(message):
                sock.sendall(message[sent:])

    def events():
        try:
            data = sock.recv(65536)
        except socket.timeout:
            return []
        if not data:
            raise RuntimeError("Compositor closed the connection")
        pending.extend(data)
        result = []
        while len(pending) >= 8:
            obj, header = struct.unpack_from("=II", pending)
            size, opcode = header >> 16, header & 65535
            if size < 8:
                raise RuntimeError("Invalid Wayland message size")
            if len(pending) < size:
                break
            payload = bytes(pending[8:size])
            del pending[:size]
            if obj == 1 and opcode == 0:
                target, code, length = struct.unpack_from("=III", payload)
                raise RuntimeError(f"Wayland error object={target} code={code}: "
                                   + payload[12:12 + length - 1].decode(errors="replace"))
            result.append((obj, opcode, payload))
        return result

    def roundtrip():
        callback = new("callback")
        send(1, 0, uint(callback))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            for obj, opcode, payload in events():
                if obj == callback and opcode == 0:
                    return
        raise RuntimeError("Wayland roundtrip timed out")

    def settle(seconds):
        deadline = time.monotonic() + seconds
        try:
            while time.monotonic() < deadline:
                sock.settimeout(min(1, max(0.001, deadline - time.monotonic())))
                events()
        finally:
            sock.settimeout(1)

    registry = new("registry")
    send(1, 1, uint(registry))
    callback = new("callback")
    send(1, 0, uint(callback))
    deadline = time.monotonic() + 5
    ready = False
    while time.monotonic() < deadline and not ready:
        for obj, opcode, payload in events():
            if obj == registry and opcode == 0:
                name, length = struct.unpack_from("=II", payload)
                interface = payload[8:8 + length - 1].decode()
                version = struct.unpack_from("=I", payload, 8 + ((length + 3) & ~3))[0]
                globals_found[interface] = (name, version)
            if obj == callback and opcode == 0:
                ready = True
    if not ready:
        raise RuntimeError("Registry discovery timed out")

    def bind(interface, requested):
        name, available = globals_found[interface]
        obj = new(interface)
        version = min(requested, available)
        send(registry, 0, uint(name) + string(interface) + uint(version) + uint(obj))
        report("bound", interface=interface, version=version)
        return obj

    compositor = bind("wl_compositor", 4)
    shm = bind("wl_shm", 1)
    layer_shell = bind("zwlr_layer_shell_v1", 1)
    surface, region, layer = new("surface"), new("region"), new("layer")
    send(compositor, 0, uint(surface))
    send(compositor, 1, uint(region))
    send(surface, 5, uint(region))  # Empty region: all pointer input passes through.
    send(region, 0)
    send(layer_shell, 0, uint(layer) + uint(surface) + uint(0) + uint(2)
         + string("kimochi-steam-deck-probe"))
    send(layer, 0, uint(240) + uint(48))
    send(layer, 1, uint(5))  # Top + left anchors.
    send(layer, 2, uint(0))  # No reserved desktop space.
    send(layer, 4, uint(0))  # Keyboard interactivity NONE.
    send(surface, 6)
    report("requested", display=display, size=[240, 48], pointer="empty-region",
           keyboard="none", lifetimeSeconds=10, teardown=teardown,
           settleSeconds=settle_seconds)
    deadline = time.monotonic() + 10
    configured = False
    try:
        while time.monotonic() < deadline:
            for obj, opcode, payload in events():
                if obj != layer:
                    continue
                if opcode == 1:
                    raise RuntimeError("Compositor closed layer surface")
                if opcode != 0:
                    continue
                serial, width, height = struct.unpack_from("=III", payload)
                width, height = width or 240, height or 48
                if width * height > 4_000_000:
                    raise RuntimeError(f"Unexpected configure size {width}x{height}")
                send(layer, 6, uint(serial))
                fd = os.memfd_create("kimochi-layer-probe", os.MFD_CLOEXEC)
                size = width * height * 4
                os.ftruncate(fd, size)
                memory = mmap.mmap(fd, size)
                # Gamescope may configure every external layer at output size,
                # ignoring the requested corner dimensions. Leave the remainder
                # transparent instead of painting over the whole game.
                row = struct.pack("=I", 0xFF2563EB) * min(width, 240)
                for y in range(min(height, 48)):
                    offset = y * width * 4
                    memory[offset:offset + len(row)] = row
                resources.append((fd, memory))
                pool, buffer = new("pool"), new("buffer")
                buffers.append(buffer)
                send(shm, 0, uint(pool) + uint(size), fd=fd)
                send(pool, 0, b"".join(uint(v) for v in
                     [buffer, 0, width, height, width * 4, 0]))
                send(pool, 1)
                send(surface, 1, uint(buffer) + uint(0) + uint(0))
                send(surface, 2, uint(0) + uint(0) + uint(width) + uint(height))
                send(surface, 6)
                configured = True
                report("buffer-committed", size=[width, height], stride=width * 4,
                       format="ARGB8888")
        if not configured:
            raise RuntimeError("No layer configure within 10 seconds")
        if teardown == "unmap":
            send(surface, 1, uint(0) + uint(0) + uint(0))
            send(surface, 6)
            roundtrip()
            report("unmapped")
            settle(settle_seconds)
        if teardown in {"destroy", "unmap"}:
            send(layer, 7)
            send(surface, 0)
            for buffer in buffers:
                send(buffer, 0)
            roundtrip()
            report("destroyed")
            settle(3)
        report("completed", protocolAccepted=True)
    finally:
        sock.close()  # Disconnect destroys every surface, even after an error.
        for fd, memory in resources:
            memory.close()
            os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        report("failed", error=str(error))
        raise SystemExit(1)
