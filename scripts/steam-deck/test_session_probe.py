"""No GTK/device dependency: Deck report and chord regression tests."""
import importlib.util
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('session-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ControllerReports(unittest.TestCase):
    def report(self):
        packet = bytearray(64)
        packet[:4] = bytes([1, 0, 9, 64])
        return packet

    def test_rejects_other_reports(self):
        for data in [b'', bytes(63), bytes(64), bytes(65)]:
            self.assertIsNone(probe.controller_buttons(data))

    def test_both_sticks_requires_both_and_rearms_after_release(self):
        packet = self.report()
        packet[10] = 1 << 6
        left = probe.controller_buttons(packet)
        self.assertFalse(probe.chord_pressed(left, set()))
        packet[11] = 1 << 2
        both = probe.controller_buttons(packet)
        self.assertTrue(probe.chord_pressed(both, left))
        self.assertFalse(probe.chord_pressed(both, both))
        self.assertTrue(probe.chord_pressed(both, left))

    def test_navigation_and_system_handoff_bits(self):
        packet = self.report()
        packet[8] = 1 << 7
        packet[9] = (1 << 5) | 1
        packet[14] = 1 << 2
        self.assertEqual(probe.controller_buttons(packet), {'a', 'up', 'steam', 'qam'})
        packet = self.report()
        struct.pack_into('<h', packet, 50, -20000)
        self.assertEqual(probe.controller_buttons(packet), {'down'})
        struct.pack_into('<h', packet, 50, 1000)
        self.assertEqual(probe.controller_buttons(packet), set())


if __name__ == '__main__':
    unittest.main()
