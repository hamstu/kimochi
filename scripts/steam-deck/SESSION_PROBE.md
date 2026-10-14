# Steam-managed controls / external overlay experiment

## Current launch path

Deploy `session-probe.py`, `gamescope_focus_relay.py`, `controller_neutral.py` and
`session-probe-launch.sh` together; use the last file as the registered shortcut's
`launch.sh` beside the Python files. Normal startup explicitly uses **guarded**
mode and starts its sidecar automatically. Input mode and lifetime are forwarded
to sidecar restarts. Both processes are bounded to one hour for these interactive
tests; each menu still auto-dismisses after 20 seconds, and independent input
recovery still uses a 2.5-second heartbeat timeout. The overlay heading changes
from acquiring input to **game input blocked** only after the pause/neutral
handoff succeeds. Observation mode remains an explicit diagnostic option.

This supersedes earlier touch-only/default-observe/90-second-launch descriptions
below, which document the investigation history.

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

### Isolation results after clean restart

- **PASS, user confirmed:** game-only controller baseline after PIN unlock.
- **FAIL, user confirmed:** launching the ordinary GTK Steam shortcut, manually
  switching back through Steam, loses game input **before any overlay is opened**.
  The guarded input helper was disabled. Therefore the guard and compositor
  switching are not necessary to reproduce the initial fault.
- A read-only PE diagnostic opened Proton's named
  `__wine_steamclient_GameOverlayActivated` event in the game's existing prefix:
  exact result `overlay-event=inactive`. The proposed stale-overlay-event cause
  was **not confirmed**, and the event was not reset.
- A separate no-window XInput diagnostic in that prefix reported slot 0 success
  and button transitions `00001000` (A), `00002000` (B), `00000004`/`00000008`
  (D-pad left/right). Slots 1–3 returned `0000048f` (not connected). This proves
  usable XInput state in a fresh process, not the game's private XInput state.
- **Diagnostic limitation:** user saw the stub selected during the button test.
  Root compositor focus writes do not prove coherent Steam UI selection. A
  synthetic click subsequently reached the stub, not the game; it is **not** a
  valid game activation/recovery test. Do not infer game-side failure solely
  from that interval. Earlier user-confirmed manual-switch failure remains valid.
- Initial `proton run` diagnostic attempts additionally passed through Proton's
  `steam.exe` launch wrapper and changed Steam's tracked process metadata. Later
  successful probes invoked Wine directly inside the runtime, using the existing
  prefix. That initial attempt is a confound for later focus observations;
  avoid `proton run` for diagnostic utilities attached to a running game's prefix.
  Logs included `wine: failed to start ...: c000007b` for an initial malformed PE;
  removing non-loadable ELF metadata before PE linking corrected the utility.
  The successful diagnostics had no window and sent no controller output.

Relevant upstream report: [Valve steam-for-linux #13418](https://github.com/ValveSoftware/steam-for-linux/issues/13418)
(open at inspection): game → Discord → game loses controller input. This matches
our manual-switch symptom but does not establish the same cause or a fix.
[Proton lsteamclient source](https://github.com/ValveSoftware/Proton/blob/proton_11.0/lsteamclient/steamclient_main.c)
and [Wine XInput implementation](https://github.com/ValveSoftware/wine/blob/bleeding-edge/dlls/xinput1_3/main.c)
explain the event suppression investigated above.

Next isolation gate: keep stub running, relaunch only the game, then manually
switch away/back. This separates second-app launch effects from repeated focus
changes. Foreground harness lifetime increased to 900 seconds for this test;
overlay service remains stopped. No forced controller-profile override is used.

### Confirmed Wine activation gap and targeted recovery

App-first launch order also failed, per user. Investigation continued inside the
actual running game (PID 54834, Proton 11.0) rather than relying on the separate
XInput process:

- Read-only inspection found controller slot 0 enabled in both loaded XInput
  DLLs, with changing cached state. Their exported GetState functions retained
  Wine entry code, rather than a replacement Steam jump at the entry point.
- A bounded debugger trace caught the game's actual `XInputGetState(0)` and its
  return: success (`0`) with nonzero packet/axis state. The initial trace stopped
  on Wine SIGUSR1 before the return and is invalid; corrected tracing passed
  Wine's internal SIGUSR1/SIGUSR2 through and verified the return address.
  Debugger detached and removed its temporary breakpoints each time.
- While Gamescope graphics/input and X11 focus selected Sea of Stars, Wine's
  `GetForegroundWindow()` returned **0x10020**, untitled, Windows PID **0xd4**.
  The visible Sea of Stars HWND was **0x20086**, Windows PID **0x134**. A normal
  Windows `SetForegroundWindow` attempt returned false.
- The game advertised `WM_TAKE_FOCUS` in `WM_PROTOCOLS`. Sent exactly one ICCCM
  ClientMessage to its X11 client **0x2000001**, using a fresh X server timestamp.
  Wine then reported foreground **0x20086 / Sea of Stars**; Gamescope remained on
  app **1244090**. **PASS, user confirmed: game controls worked again**, without
  game, Steam or compositor restart. No event flag, Wine binary, game memory,
  prefix setting, controller profile or system package was modified for recovery.

This matches the activation gap described in
[Wine's Proton 11 branch](https://github.com/ValveSoftware/wine/blob/e60892cc2398b0a83c332a2078c7b85e47bdb42b/dlls/winex11.drv/event.c#L880):
`X11DRV_FocusIn` can return without activating when `use_take_focus` is enabled;
its comment explicitly identifies Gamescope's missing WM_TAKE_FOCUS support.
The WM_PROTOCOLS handler performs the intended activation. This is a confirmed
local mechanism/recovery, not proof of the root cause of every report in #13418.

`gamescope_focus_relay.py` implements that handoff for the harness. On each
ownership transition it requires graphics app == input app == target window's
STEAM_GAME, matching valid keyboard/mouse display names, a Wine window marker,
and advertised WM_TAKE_FOCUS. Steam/Kimochi are excluded. It obtains a real server
timestamp, rechecks ownership, and sends once. No root property writes, grabs,
forced app selection, controller events or Steam signals occur in the relay.
It runs separately so its Xlib error handling cannot alter GTK, and exits after
EOF/no heartbeat (2.5 seconds). A disappearing target is handled as a normal X11
race. No persistent focus enforcement is added.

Five harness tests pass, including rejection of mismatched/incomplete ownership,
non-Wine/nonparticipating windows, and once-per-transition rearming. The relay is
deployed in observe mode for repeat manual-switch acceptance; guarded controller
loop acceptance remains a subsequent gate. Changes are confined to the opt-in
Steam Deck harness, with no production/macOS/Windows implementation changes.

### Focus-relay acceptance and guarded-loop retest

**PASS, user confirmed:** repeated switching with the automatic Wine focus relay
preserved game input; user reported everything working. Native logs recorded
validated handoffs after returning from the overlay as well. Reintroduced
`--input-mode guarded` on the transient overlay service at 11:27 on 2026-10-14,
keeping the relay enabled. Game and Steam were not restarted. Test requires
exclusive menu selection, B dismissal with game input recovery, and menu →
Steam-managed app → both sticks → game. Guarded physical acceptance pending.

Native guarded retest observed menu open at 11:27:59, watchdog paused Steam PID
50945, Cancel at 11:28:04, relay sent WM_TAKE_FOCUS to game XID 33554433,
and watchdog resumed Steam. Post-dismiss state was Steam Sl, game app 1244090
selected. This confirms lifecycle ordering, not physical exclusivity by itself.

### Guarded loop acceptance and stale held-state correction

**PASS, user confirmed:** the guarded game → menu → main app → game loop works,
including game input recovery. User then found a separate takeover edge case:
tilting a stick while clicking LS+RS left the game menu auto-repeating behind
the overlay until dismissal. Pausing Steam stops new reports; it does not clear
the virtual controller's last held state.

The harness now sends an initial watchdog heartbeat immediately, waits for the
validated Steam PID/start token to report stopped state, then sends one neutral
evdev frame on matching Steam virtual Xbox devices. It releases currently held
gamepad buttons, centres stick/hat axes and releases triggers, followed by
SYN_REPORT. `controller_neutral.py` requires the virtual sysfs path, USB VID/PID
28de:11ff and expected virtual-pad name; it never writes physical controllers,
HID feature/output reports, keyboard keys, or unrelated axes. No grabs or device
permission changes. If the guard ends, pause acknowledgement times out, or no
writable matching device exists, the menu dismisses and releases its lease.
Old held values are not replayed on exit; Steam resumes physical reporting.

Native check at 11:32:35: event10 stick axes before `{0:-79,1:1227,3:-569,4:401}`
and after all zero; triggers/hats also zero. One five-event frame was delivered,
then dismissal resumed Steam (Sl) and the Wine relay restored game activation.
Eight Python tests pass, including stale held-state release, trigger/axis rest
values, idempotence and rejection of physical/non-Steam devices. User's specific
intentional-tilt reproduction with this new correction remains pending.

The evdev delivery mechanism uses the kernel's existing
[`evdev_write` → `input_inject_event` path](https://github.com/torvalds/linux/blob/master/drivers/input/evdev.c).
This is confined to the opt-in harness, not a production platform change.


### Steam relaunch regression corrected

User relaunched the shortcut after the manually configured guarded sidecar
expired and reported game input passing through the menu. Exact captured log:
`"overlay-shown" ... "inputMode": "observe"`; ExecStart lacked --input-mode and
used --seconds 90. This was the on-demand launch path resetting to the diagnostic
default, not evidence that the active guard failed.

Corrected the parser default to guarded and pass input mode, lifetime and helper
explicitly into the child service. Added a tracked shortcut launcher, automatic
sidecar startup from the app, and visible guarded/acquiring/blocked UI states.
Foreground and sidecar lifetime increased to one hour so slow interactive tests
do not repeatedly lose the harness. No persistent background service was added.

Relaunched through the actual Steam shortcut: app PID 56911 and sidecar PID 56922
both reported guarded mode/3600 seconds. Native check at 11:51:18 engaged watchdog
PID 56949, neutralized event10 axes to zero and restored Steam Sl on dismissal.
Ten tests pass, including normal-start guarded default and explicit mode/lifetime
propagation through on-demand service creation. Physical tilted-stick retest is
pending; do not count the prior observe-mode attempt against neutral handoff.

## Native Kimochi integration, 2026-10-14

User confirmed the final guarded/neutralized harness works excellently. Native
integration is on **feat/steam-managed-kimochi**, based on the completed harness
branch. A focused extra probe established that a normal STEAM_GAME app on root
XWayland :0 is Steam-managed just like the :1 stub (app 2999444207 selected,
keyboard routed to :0). Therefore the real app can retain **one Tauri process**,
shared WebKit data store, dictionary database, settings and OCR service. No
second controls process, replicated state or new IPC layer is needed.

The Steam launcher now execs the real AppImage (rather than detaching a service)
with `KIMOCHI_STEAM_MANAGED=1` and Steam's real app ID. Ordinary controls are normal
focusable STEAM_GAME windows, without STEAM_OVERLAY/STEAM_INPUT_FOCUS. The reader
remains an external overlay; explicit editing/navigation owns modal input. The
native Wine relay mirrors the proven ownership/timestamp/protocol checks. The
independent native pause watchdog neutralizes matching Steam virtual pads after
SIGSTOP and retains the existing timeout/focus-loss/EOF recovery.

Explicit Return-to-game and the controller-menu chord in focused controls switch
to the remembered running game. Main stays mapped behind it so Steam's running-app
switcher can select it again; closing a secondary panel returns to main. Steam
system-menu buttons release input without forcing a competing game selection.
One-shot priority updates preserve other entries, without the probe's hardcoded
413091 prefix. A stale GTK focus state cannot authorize native controls/actions
or drive controller navigation in background React panels: actual compositor
ownership is supplied in Linux Gaming Mode gamepad snapshots.

### Changes / scope

- Linux-only `gamescope_handoff.rs`: regular app selection, game identity fallback,
  one-shot WM_TAKE_FOCUS activation on validated Wine ownership transitions.
- Linux-only `controller_neutral.rs` and watchdog: scoped evdev neutral frame,
  no physical/HID writes, no device permission changes.
- Linux-only `gamescope.rs` / `window.rs`: normal Steam controls, return/show/hide
  behavior, authoritative input ownership and touch/zoom retained.
- Linux-gated branches in `main.rs`, `actions.rs`, `gamepad.rs`: startup relay,
  return command/chord and controller ownership snapshots.
- `usePanelController.ts`: existing Linux/Gamescope capability gate prevents
  background controls from navigating on game inputs. Other platforms unchanged.
- Steam launcher stays attached to native app; an executable launcher regression
  test checks child PID, display, managed flag and registered app ID.
- No macOS/Windows native files, vendor assets, lockfiles, dependency/model versions
  or SteamOS system configuration changed. No PR/main push.

### Build / deployment

- JS: **813 passed, 2 skipped, 0 failed**. Verify, typecheck and lint pass.
  Current main's verify output is `Verified: dist/ holds no dictionary engine,
  and the pinned records are exact.` (dictionary distribution changed on main;
  no vendor manifest or hashes edited here).
- x86_64 app Clippy passes; Rust tests **266 passed, 2 ignored**.
- x86_64 capture-core: **67 passed**; Clippy qualified with EXTERNAL MSRV 1.87.
  First attempt using the app's external MSRV 1.88 hit Rust 1.99's existing
  `chunks_exact_to_as_chunks` lint (6 library / 9 test errors). Preserved error
  log, used separate external capture config; no shared-code refactor/allow.
- App uses external MSRV 1.88 because current main uses as_chunks. Resource-limited
  existing rootless build container: 2 CPUs, 6 GiB. No tool/dependency upgrades.
- Built frontend and debug native binary, then repacked the existing validated
  dependency-complete AppDir (same packaged libraries/runtime; native binary and
  embedded frontend rebuilt). Nonfatal existing AppStream metadata warnings.
- Artifact: `Kimochi-steam-managed.AppImage`, SHA-256
  `a48bcd063607b77b896d82b6f9f0ca520ef87dfb936a2c4aed14bf8ca49eda3b`.
- Installed as user-local release `releases/1792005105-58907`; previous installed
  `releases/1791998752-47498` retained for rollback. Settings/dictionaries retained.
- Stopped probe service/app; launched the original registered Kimochi shortcut
  (app **3826138355**, launch ID **16433139104729792512**). Native Kimochi PID 58960
  is tracked by Steam; Sea of Stars PID 54834 remained running. Focusable app list
  contained **3826138355, 1244090, 769**. No Steam/Gamescope/game restart.
- Main xid **0x3200020**: 1280×800, STEAM_GAME=3826138355,
  STEAM_OVERLAY=0, STEAM_INPUT_FOCUS=0, no external-overlay marker,
  _NET_WM_WINDOW_TYPE_NORMAL, WM_HINTS input=True. Native watchdog logged neutral
  handoff and controlled Steam pause while controls were focused.
- Existing Hachidori engine/background/content reported ready in the unchanged
  user data at `~/.local/share/dev.kimochi.app/evidence.jsonl`.

Physical acceptance of native main/radial/Steam switching, touch, OCR and
lookup remains pending user verification; harness acceptance is not substituted
for full-app runtime acceptance. Native logs/build output/property dumps are
retained under ignored `evidence/steam-deck-bringup/managed-app/`.

### Native regression correction (2026-10-14)

The first full-app acceptance failed: screen sharing reported `The portal
refused the screen share`, and the user reported lost game/Steam button input.
Captured before stopping the app: Steam was `Sl`; Kimochi and a touch watchdog
were alive. This snapshot does not prove that every earlier input failure was
caused by a stopped Steam process.

Portal journal: `A backend call failed: Invalid app id`. A D-Bus monitor showed
CreateSession identifying the Steam-managed caller as `app3826138355`, from
`app-steam-app3826138355-60289.scope`. Registering a fresh host connection as
`dev.kimochi.app` fixes that identity, without permission resets. This Deck's
portal also requires the matching desktop entry: the first focused probe failed
with `Could not register app ID: App info not found for 'dev.kimochi.app'`.
After adding that entry, CreateSession, SelectSources and Start all returned 0
and Start supplied PipeWire node 72. The installer now supplies a hidden matching
entry if no ordinary installation already supplies it. Existing entries are
preserved; source settings and dictionaries are untouched.

Input migration differed from the successful harness: it paused Steam while
ordinary registered controls were open, as well as while an external modal
menu was active. Managed ordinary controls now use Steam's own foreground
routing, matching the harness; modal overlays retain the guarded neutral
handoff. The independent watchdog additionally reads the physical system keys,
so Steam/QAM release does not depend on the app/webview poller. Ownership refuses
Steam's input app ID 769, even if :0 retains stale GTK focus. A focus callback
cannot immediately clear an explicit system-menu yield.

Linux scope: portal change is in the Linux-only backend and only enabled for
the explicit managed launch; input changes are all in platform/linux. Packaging
changes affect the gaming-mode installer only. No macOS/Windows/vendor/dependency
changes. Raw failure logs are retained in ignored
`evidence/steam-deck-bringup/managed-regressions/`.

Checks: capture tests 67 passed; app tests 267 passed, 2 ignored (including a
regression test that managed controls do not stop Steam while modal navigation
does). Both Clippy checks passed with the previously documented external MSRV
configs. Installer creation/preservation check, shell syntax, diff check and
vendor verification passed. The artifact uses the dependency-complete cached
AppDir, updated native executable and rebuilt embedded frontend, then AppImage
repacking, as for the preceding native integration.

Deployed corrected artifact SHA-256
`81ec1cd52eea42f00c43a3e0f9fb69d5b306e26a62876e2e7f618c2d60cc7491`
as release `1792006683-64624`. Real app PID 64676 launched through the existing
Steam shortcut. At 12:38:05 PDT the actual app's portal session
`ashpd_y2s7LyDDoY` successfully selected sources and started PipeWire node 72.
Steam PID 50945 stayed `Sl` with the controls open; only the independent touch
helper was running, not a Steam-stop input lease. Physical controller/Steam-menu
acceptance is awaiting the user; do not infer it solely from these native checks.
