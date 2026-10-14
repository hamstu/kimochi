# Steam-managed controls / external overlay experiment

## Controller-loop extension (2026-10-14)

The current experimental overlay role reads the Deck's input-only HID reports
without grabs or output writes. Both stick clicks while a game is selected open
the menu; D-pad/left-stick selects, A activates, B cancels. Kimochi selects the
registered stub app, and both sticks there return to the previously selected
game. Steam/QAM buttons dismiss the menu and release interception. A blue focus
ring identifies the selected button. Touch buttons remain supported.

**Requires** the existing fixed Kimochi AppImage passed as `--touch-watchdog`.
Its independent input watchdog temporarily pauses Steam while the external menu
owns input, restoring it on dismissal, focus loss, missing heartbeat, process
exit or timeout. The harness never sends stop signals directly. No interception
is requested while the ordinary Steam-managed app is selected; background game
isolation in that state remains a physical acceptance gate.

App switching performs a single explicit write to Gamescope's
`GAMESCOPECTRL_BASELAYER_APPID` on :0. There is no repeated focus enforcement.
This is an experimental compositor interface, **not a Steam UI switching API**;
Steam-menu synchronization and handoff still need user verification. The current
probe uses this test shortcut's app ID 2999444207 and the observed Steam priority
prefix 413091. These are deliberately not production discovery logic. The last
game is learned from compositor focus when opening the menu, not a launch URI.

Native checks: one-shot switching selected the stub and then Sea of Stars;
menu input guard changed Steam from Sl to Tl and dismissal restored Sl. With
only overlay GTK SIGSTOPped, the independent helper restored Steam within the
3-second observation interval while GTK remained stopped. No game/Steam/session
restart occurred. Three pure Python report/chord regression tests pass:

```sh
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover \
  -s scripts/steam-deck -p test_session_probe.py
```

The earlier results below describe the touch-only baseline. Its claims of no
Steam signals/root writes and no controller handling are superseded by this
explicitly opt-in extension. The deployed controller sidecar has a 900-second
service lifetime; each menu still auto-dismisses after 20 seconds. End-to-end physical switching/menu navigation was user-confirmed, but **FAIL:
game controller input was lost afterward**. Do not treat this loop as accepted.
The sidecar was stopped for diagnosis. Steam was Sl, no watchdog survived,
Gamescope and X11 focus selected Sea of Stars, and Steam selected its profile.
A simultaneous read-only physical/virtual trace recorded matching A/B edges on
hidraw2 and event10. Wine's open event10 descriptor matched the current device
inode. Steam's normal Resume action did not recover game input. Thus a leftover
Steam pause/grab is ruled out; the Proton/game input boundary and app-switch
handoff remain under investigation. No game/session restart has been performed.

## Original touch-only baseline

`session-probe.py` is an opt-in GTK3/Python stub, not a replacement application.
The Deck's existing PyGObject/Cairo packages run it directly: no Rust, Node,
WebKit, OCR runtime, models or build container. Source edits take effect on the
next launch. `--seconds` bounds each process to 10–900 seconds (default 300). The foreground
UI starts/restarts a short-lived overlay service on demand if its socket is absent.

Run the two roles separately:

```sh
# Sidecar, in a user service or terminal outside Steam's app process tree:
DISPLAY=:0 GDK_BACKEND=x11 KIMOCHI_SESSION_PROBE=1 \
  python3 session-probe.py overlay --seconds 600

# Foreground launch target of a separate registered Steam development shortcut:
# Preserve SteamAppId and Steam's supplied DISPLAY (typically :1).
unset LD_PRELOAD
GDK_BACKEND=x11 KIMOCHI_SESSION_PROBE=1 \
  python3 session-probe.py app --seconds 600
```

The foreground process stays alive so Steam can track it as a running app. It
sets `STEAM_GAME` on its own window from the real `SteamAppId`. The overlay is a
separate process on root XWayland `:0`; it changes only its own properties and
input shape. “Show external overlay” sends a local IPC message. Cancel hides it;
The experimental return button asks the existing app window to present itself. Whether that presentation
actually changes Steam's selected app is an acceptance test, not assumed.

This is a **touch/mouse architecture probe**. It does not grab controllers or
pause Steam. It does not prove modal gamepad ownership, OCR/capture exclusion,
WebKit compatibility or final Kimochi process/window integration. The overlay is
still rendered by Gamescope; “sidecar” describes its process/Steam-app lifetime,
not a separate compositor session.

The app checkbox selects passive or interactive overlay mode. Interactive mode
requests focus on the overlay's own window. Its default `--touch-mode 1`
pointer-emulated touch works for the two buttons. `--touch-mode 4` native touch
passthrough did not deliver taps here. A separate tiny Python `touch-guard`
process restores the previous mode on EOF/no heartbeat (2.5s)/SIGTERM; GTK never
writes the setting itself. `--touch-watchdog /path/to/Kimochi.AppImage` optionally
reuses the existing native helper for mode 4. No Steam signals are used. Each show has a visible
20-second auto-dismiss countdown. The device test also limits the overlay user
service to 90 seconds as an independent escape if its GTK loop hangs.

IPC uses fixed commands on per-role sockets under the current user's runtime
directory, mode 0600, with peer UID checks. Graceful exit unlinks its socket. If a
probe is killed, confirm it has exited before removing only its stale socket.
No Steam VDF writes, Steam restart, foreign-window/root-property changes, global
input grabs, system packages or persistent configuration changes occur in this script.
The independent touch guard temporarily changes and restores only Gamescope touch mode.
Registration is a separate development operation using Valve's existing
[SteamOS devkit helper](https://gitlab.steamos.cloud/devkit/steamos-devkit).
[Gamescope](https://github.com/ValveSoftware/gamescope) supplies the compositor
window-property model.

## Initial device evidence, 2026-10-14

Separate development shortcut `Devkit Game: kimochi_session_probe`: app ID
`2999444207`, launch ID `12882514775275208704`. Foreground GTK process PID 48318
started directly from Steam on `:1` while Sea of Stars app `1244090` remained
running. Steam's process log tracked the probe launch, and
`GAMESCOPE_FOCUSABLE_APPS` simultaneously reported `2999444207, 769, 1244090`.
Graphics/input focus selected the probe without stopping Steam or restarting
Gamescope. This establishes concurrent registration/processes; Steam menu visual listing and switching were subsequently confirmed by the user.
Overlay touch and Return activation remain separate runtime gates.

The normal Kimochi service is stopped during this experiment, with its separately
fixed input-recovery build installed. No original shortcut was replaced. Probe
logs/evidence are retained locally under the ignored `evidence/` directory.

## Results and boundaries

- **PASS, user confirmed:** both entries appear in Steam and switching between
  them works. The app remains a genuine Steam-tracked foreground process.
- **PASS, native state:** independent 1280×800 depth-32 overlay maps on :0 while
  Steam retains selection of the regular app on :1. No Steam/Gamescope restart.
- **FAIL, first passive probe:** visible buttons did not receive touch. Corrected
  the harness to offer explicit interactive focus and scoped touch passthrough.
  Native touch passthrough still failed. An owned-focus synthetic mouse click
  reached Cancel at its published coordinates, distinguishing button geometry
  from touch delivery. **PASS, user confirmed:** pointer-emulated touch then made
  Cancel work. The refreshed app opens tests on demand rather than requiring the
  user to catch a remotely timed window.
- **FAIL:** `Gtk.present()` does not select the Steam app. This is not a reliable
  Return-to-app implementation.
- **Rejected switching approach:** launching the already-running game's URI
  brought Steam UI forward, and the user saw a Sea of Stars error message while
  the game remained alive. Do not use launch URIs to implement Resume.

[RomM Tender's implementation notes](https://github.com/danielcopper/romm-tender/blob/main/docs/architecture/save-file-sync-architecture.md)
use Steam UI store `SetRunningApp(appId)` followed by `NavigateToRunningApp()` for
Resume. That is a concrete research lead, not a callable public native API or a
proven Kimochi integration. It requires a Steam UI bridge (e.g. an optional
plugin) or another supported app-switch mechanism. Neither Decky nor CEF remote
debugging was installed/enabled for this experiment. Manual Steam-menu switching
already works and should remain the fallback.

The next production gate is a real WebKit/Tauri controls client in the same
Steam-tracked context with a narrow IPC boundary to the core/overlay process;
one writer must retain settings/models/capture and dictionary state. Also prove
background controller routing, Steam/QAM handoff, touch scrolling, capture
exclusion and per-game identity before migrating the existing app. The stub
proves session ownership/switching, not those production integrations.

- **PASS, user confirmed over Sea of Stars:** selected the game through Steam,
  independent interactive overlay appeared, Cancel responded to touch, and the
  game stayed visible and usable afterward. Native observation selected game
  app 1244090 before requesting the overlay. Steam was never paused by the stub.

The input-recovery production fix is separately committed as `bd75a66` on
`fix/gamescope-controls-input`; this harness is on
`experiment/steam-managed-controls`. Normal Kimochi's shortcut still points to
the fixed installed release. The real app stays stopped during the stub test;
launch it from the original shortcut when returning to normal use. The stub
expires automatically and can be relaunched from its separate Steam entry.

### Recovery after input-loss failure

User additionally reported all controller input (including Steam/PIN) unavailable
following sleep/wake. No probe or watchdog was running and Steam was Sl. The
runtime-only `steam://forceinputappid/1244090` diagnostic had not restored game
input; it was cleared with `/0` before session recovery. Do not add that override
to the harness: forcing a game profile can interfere with lock-screen routing.

With explicit user authorization, stopped `gamescope-session.target`; SteamOS
re-entered Gaming Mode automatically. The old game closed. Fresh Gamescope PID
50566 and Steam PID 50945 started; Steam logged controller detection and UI
profile 769 activation. No probe was restarted. The restart also applied an
already-staged Steam client build change (1788652215 → 1791918634); no update was
manually installed. This is a material variable for subsequent reproduction.
Physical PIN/controller recovery remains pending user confirmation. Resume
acceptance tests in separate stages: game alone, concurrent app/manual switching,
controller menu without Steam pause, then guarded menu. Verify game input after
every stage rather than accepting visible switching as proof of input recovery.

### Staged retest after recovery

User confirmed PIN entry and Steam controls work after restart. Harness now
starts in `--input-mode observe` by default: the physical reader and menu can be
tested without pausing Steam. `--input-mode guarded` explicitly enables the
independent input lease. Observation mode may pass menu controller input through
to the game; that is expected during isolation, not acceptable final behavior.
Do not enable the guard until game-only, concurrent Steam app/manual switching,
and compositor switching without the guard preserve game input independently.
