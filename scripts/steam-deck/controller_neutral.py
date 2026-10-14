"""Release stale state on Steam's virtual pad after a guarded input takeover.

Never write physical input devices or HID output/feature reports. The caller
must own the independent Steam pause lease before invoking neutralize().
"""
import fcntl
import os
from pathlib import Path
import re
import struct

EVENT = struct.Struct('@llHHi')
STICKS = {0, 1, 3, 4}
TRIGGERS = {2, 5}
HATS = {16, 17}


def neutral_axis(code, minimum, maximum):
    if code in TRIGGERS:
        return minimum
    if code in STICKS:
        return 0 if minimum < 0 < maximum else (minimum + maximum) // 2
    if code in HATS:
        return 0 if minimum <= 0 <= maximum else minimum
    raise ValueError('not a supported gamepad axis')


def neutral_events(axes, pressed):
    events = [(1, code, 0) for code in sorted(pressed) if 256 <= code <= 767]
    for code, info in sorted(axes.items()):
        if code not in STICKS | TRIGGERS | HATS:
            continue
        current, minimum, maximum, *_ = info
        neutral = neutral_axis(code, minimum, maximum)
        if current != neutral:
            events.append((3, code, neutral))
    return events + [(0, 0, 0)] if events else []


def query(fd, number, size):
    value = bytearray(size)
    fcntl.ioctl(fd, 0x80000000 | (size << 16) | (ord('E') << 8) | number, value, True)
    return value


def is_steam_virtual(identity, realpath, name):
    return (identity[:3] == (3, 0x28de, 0x11ff)
            and str(realpath).startswith('/sys/devices/virtual/input/')
            and bool(re.fullmatch(r'Microsoft X-Box 360 pad [0-9]+', name)))


def neutralize():
    observations = []
    for node in sorted(Path('/sys/class/input').glob('event*')):
        device = node / 'device'
        try:
            realpath = device.resolve()
            name = (device / 'name').read_text().strip()
            # Filter before opening: no keyboard, touchscreen or physical pad.
            if not str(realpath).startswith('/sys/devices/virtual/input/') or not re.fullmatch(r'Microsoft X-Box 360 pad [0-9]+', name):
                continue
            fd = os.open('/dev/input/' + node.name, os.O_RDWR | os.O_NONBLOCK)
            try:
                identity = struct.unpack('HHHH', query(fd, 2, 8))
                if not is_steam_virtual(identity, realpath, name):
                    continue
                supported = int.from_bytes(query(fd, 0x23, 8), 'little')
                axes = {code: struct.unpack('iiiiii', query(fd, 0x40 + code, 24))
                        for code in STICKS | TRIGGERS | HATS if supported & (1 << code)}
                keys = int.from_bytes(query(fd, 0x18, 96), 'little')
                pressed = {code for code in range(256, 768) if keys & (1 << code)}
                events = neutral_events(axes, pressed)
                if events:
                    payload = b''.join(EVENT.pack(0, 0, *event) for event in events)
                    written = os.write(fd, payload)
                    if written != len(payload):
                        raise RuntimeError('partial neutral controller report')
                after = {code: struct.unpack('iiiiii', query(fd, 0x40 + code, 24))[0] for code in axes}
                observations.append(dict(device=node.name, axesBefore={code: info[0] for code, info in axes.items()},
                                         axesAfter=after, releasedButtons=sorted(pressed), events=len(events)))
            finally:
                os.close(fd)
        except FileNotFoundError:
            continue  # Controller disconnected between discovery and opening.
    if not observations:
        raise RuntimeError('no writable Steam virtual gamepad found for neutral handoff')
    return observations
