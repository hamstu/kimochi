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


class WineFocusHandoff(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).with_name('gamescope_focus_relay.py')
        spec = importlib.util.spec_from_file_location('focus_relay', path)
        self.relay = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.relay)
        self.target = dict(app=1244090, graphics=1244090, keyboard=':1', mouse=':1',
                           window_app=1244090, wine=True, protocol=True,
                           excluded={0, 769, 2999444207})

    def test_requires_coherent_game_input_ownership(self):
        self.assertTrue(self.relay.eligible_target(**self.target))
        for key, value in [('app',769), ('app',2999444207), ('graphics',769),
                           ('keyboard',':0'), ('keyboard','evil'), ('mouse',''),
                           ('window_app',2999444207), ('wine',False), ('protocol',False)]:
            with self.subTest(key=key,value=value):
                self.assertFalse(self.relay.eligible_target(**dict(self.target,**{key:value})))

    def test_sends_once_and_rearms_after_menu_or_app_handoff(self):
        gate = self.relay.Transition()
        game = (1244090, ':1', 33554433)
        self.assertFalse(gate.changed(None))
        self.assertTrue(gate.changed(game))
        self.assertFalse(gate.changed(game))
        self.assertFalse(gate.changed(None))
        self.assertTrue(gate.changed(game))
        self.assertFalse(gate.changed(game))
        self.assertTrue(gate.changed((1244090, ':1', 33554434)))


if __name__ == '__main__':
    unittest.main()
