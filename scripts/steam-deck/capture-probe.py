#!/usr/bin/env python3
"""Bounded public ScreenCast portal + PipeWire probe, without saving pixels.

Requires the device's existing PyGObject/GStreamer introspection packages. Uses
the system picker when the backend requires one; cancels pending requests after
30 seconds. No Gamescope-private protocol, persistent token or global input grab.
"""
import json
import os
import time
import uuid

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstApp", "1.0")
gi.require_version("GstVideo", "1.0")
from gi.repository import Gio, GLib, Gst, GstVideo  # noqa: E402


def report(event, **fields):
    print(json.dumps({"event": event, "time": time.time(), **fields}), flush=True)


def main():
    Gst.init(None)
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    context = GLib.MainContext.default()
    destination = "org.freedesktop.portal.Desktop"
    root = "/org/freedesktop/portal/desktop"
    interface = "org.freedesktop.portal.ScreenCast"
    responses = {}
    session = None
    pipeline = None
    remote = None

    def response(_connection, _sender, path, _interface, _signal, parameters, _data):
        responses[path] = parameters.unpack()

    subscription = connection.signal_subscribe(
        destination, "org.freedesktop.portal.Request", "Response", None, None,
        Gio.DBusSignalFlags.NONE, response, None)

    def request(method, signature, arguments, options):
        token = "kimochi_probe_" + uuid.uuid4().hex
        options["handle_token"] = GLib.Variant("s", token)
        path = connection.call_sync(
            destination, root, interface, method,
            GLib.Variant(signature, (*arguments, options)), None,
            Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
        report("request", method=method, path=path)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            while context.pending():
                context.iteration(False)
            if path in responses:
                code, result = responses.pop(path)
                report("response", method=method, code=code, result=result)
                if code:
                    raise RuntimeError(f"{method}: portal response {code}")
                return result
            time.sleep(0.02)
        connection.call_sync(destination, path, "org.freedesktop.portal.Request",
                             "Close", None, None, Gio.DBusCallFlags.NONE, 5000, None)
        raise RuntimeError(f"{method}: no response within 30 seconds; request cancelled")

    try:
        created = request("CreateSession", "(a{sv})", (), {
            "session_handle_token": GLib.Variant("s", "kimochi_" + uuid.uuid4().hex)})
        session = created["session_handle"]
        request("SelectSources", "(oa{sv})", (session,), {
            "types": GLib.Variant("u", 1),
            "multiple": GLib.Variant("b", False),
            "cursor_mode": GLib.Variant("u", 1),
            "persist_mode": GLib.Variant("u", 0)})
        started = request("Start", "(osa{sv})", (session, ""), {})
        streams = started.get("streams", [])
        if not streams:
            raise RuntimeError("Start returned no streams")
        reply, descriptors = connection.call_with_unix_fd_list_sync(
            destination, root, interface, "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (session, {})), None,
            Gio.DBusCallFlags.NONE, 5000, None, None)
        remote = descriptors.get(reply.unpack()[0])
        node = streams[0][0]
        pipeline = Gst.parse_launch(
            f"pipewiresrc fd={remote} path={node} num-buffers=8 "
            "! videoconvert ! video/x-raw,format=RGB "
            "! appsink name=frames sync=false max-buffers=2 drop=true")
        sink = pipeline.get_by_name("frames")
        bus = pipeline.get_bus()
        pipeline.set_state(Gst.State.PLAYING)
        frames = 0
        deadline = time.monotonic() + 15
        while frames < 8 and time.monotonic() < deadline:
            sample = sink.emit("try-pull-sample", Gst.SECOND)
            if sample:
                buffer = sample.get_buffer()
                source_caps = pipeline.get_by_name("pipewiresrc0").get_static_pad("src").get_current_caps()
                video = GstVideo.VideoInfo.new_from_caps(sample.get_caps())
                mapped, memory = buffer.map(Gst.MapFlags.READ)
                marker_pixels = None
                if mapped:
                    try:
                        # Numeric marker measurement only: never save frame bytes.
                        marker_pixels = sum(
                            bytes(memory.data[y * video.stride[0]:
                                  y * video.stride[0] + min(240, video.width) * 3])
                            .count(b"\x25\x63\xeb")
                            for y in range(min(48, video.height)))
                    finally:
                        buffer.unmap(memory)
                frames += 1
                report("frame", number=frames, bytes=buffer.get_size(),
                       pts=buffer.pts, outputCaps=sample.get_caps().to_string(),
                       outputStride=video.stride[0], markerPixels=marker_pixels,
                       sourceCaps=source_caps.to_string() if source_caps else None)
            error = bus.pop_filtered(Gst.MessageType.ERROR)
            if error:
                value, debug = error.parse_error()
                raise RuntimeError(f"GStreamer: {value}; {debug}")
            if bus.pop_filtered(Gst.MessageType.EOS):
                break
        if not frames:
            raise RuntimeError("No PipeWire frames within 15 seconds")
        report("completed", frames=frames, pixelsSaved=False)
    finally:
        if pipeline:
            pipeline.set_state(Gst.State.NULL)
        if remote is not None:
            os.close(remote)
        if session:
            connection.call_sync(destination, session, "org.freedesktop.portal.Session",
                                 "Close", None, None, Gio.DBusCallFlags.NONE, 5000, None)
        connection.signal_unsubscribe(subscription)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        report("failed", error=str(error))
        raise SystemExit(1)
