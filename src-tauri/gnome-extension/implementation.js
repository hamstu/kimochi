/* global global */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const IFACE = 'dev.kimochi.GnomeOverlay';
const XML = `<node><interface name="${IFACE}">
<method name="Status"><arg type="s" direction="out"/></method>
<method name="Present"><arg type="s" direction="in"/></method>
<method name="Clear"/>
<method name="OwnWindow"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
<signal name="Dismiss"/>
<method name="Suspend"><arg type="b" direction="in"/><arg type="b" direction="out"/></method>
<signal name="Lookup"><arg type="s"/></signal>
<signal name="Modifier"><arg type="b"/></signal>
<method name="Highlight"><arg type="s" direction="in"/></method>
</interface></node>`;

export default class KimochiOverlay extends Extension {
    enable() {
        this._words = [];
        this._owner = null;
        this._lastUpdate = 0;
        this._lastLookup = null;
        this._hoverIndex = -1;
        this._shift = null;
        this._buttons = 0;
        this._focusBeforePopup = null;
        this._group = new Clutter.Actor({reactive: false});
        Main.layoutManager.addChrome(this._group, {affectsInputRegion: false, trackFullscreen: true});
        this._bus = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this._bus.export(Gio.DBus.session, '/dev/kimochi/GnomeOverlay');
        this._name = Gio.bus_own_name_on_connection(Gio.DBus.session, IFACE, Gio.BusNameOwnerFlags.NONE, null, null);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            if (this._lastUpdate && GLib.get_monotonic_time() - this._lastUpdate > 5000000)
                this._clear();
            if (this._placement) {
                const win = global.get_window_actors().map(a => a.meta_window).find(w =>
                    w.get_pid() === this._placement.pid && w.get_title() === 'Kimochi · popup-host');
                if (win) this._placePopup(win, this._placement.rect);
            }
            const [x, y, mods] = global.get_pointer();
            const shift = Boolean(mods & Clutter.ModifierType.SHIFT_MASK);
            if (shift !== this._shift) {
                this._shift = shift;
                this._bus.emit_signal('Modifier', new GLib.Variant('(b)', [shift]));
            }
            if (!this._words.length) return GLib.SOURCE_CONTINUE;
            // Never publish input/text when the emergency panel control is hidden.
            const visible = !this._suspended && this._controlVisible();
            this._group.visible = visible;
            if (this._popup) this._popup.visible = visible;
            if (!visible) return GLib.SOURCE_CONTINUE;
            const nativeRect = this._nativePopup?.get_compositor_private()?.get_paint_visibility() ? this._nativePopup.get_frame_rect() : null;
            if (nativeRect && x >= nativeRect.x && y >= nativeRect.y && x < nativeRect.x + nativeRect.width && y < nativeRect.y + nativeRect.height)
                return GLib.SOURCE_CONTINUE;
            const p = this._popup?.get_transformed_position();
            const size = this._popup?.get_transformed_size();
            if (p && size && x >= p[0] && y >= p[1] && x < p[0] + size[0] && y < p[1] + size[1]) return GLib.SOURCE_CONTINUE;
            const index = this._words.findIndex(w => x >= w.x && y >= w.y && x < w.x + w.width && y < w.y + w.height);
            const key = (mods & Clutter.ModifierType.SHIFT_MASK) && index >= 0 ? index : null;
            if (key !== null && key !== this._lastLookup)
                this._bus.emit_signal('Lookup', new GLib.Variant('(s)', [JSON.stringify({index: key, serial: this._serial, text: this._words[key].text, sentence: this._words[key].sentence, offset: this._words[key].offset, rect: this._words[key], x, y})]));
            this._lastLookup = key;
            if (index !== this._hoverIndex) {
                this._hoverIndex = index;
                this._match = null;
                this._paintHighlight();
            }
            return GLib.SOURCE_CONTINUE;
        });
        // A visible emergency control; no global key interception or menu grab.
        this._hideButton = new PanelMenu.Button(0.0, 'Hide Kimochi annotations', true);
        this._hideButton.add_child(new St.Label({text: 'Hide Kimochi', y_align: Clutter.ActorAlign.CENTER}));
        this._hideButton.connect('button-press-event', () => {
            this._dismissedPayload = this._payload;
            this._clear();
            return Clutter.EVENT_STOP;
        });
        Main.panel.addToStatusArea(this.uuid, this._hideButton);
        this._hideButton.hide();
        this._pointerSignal = global.stage.connect('captured-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                const [x, y] = event.get_coords();
                this._outsidePress(x, y);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._focusSignal = global.display.connect('notify::focus-window', () => {
            const win = global.display.focus_window;
            if (!win) return;
            if (!this._placement || win.get_pid() !== this._placement.pid || win.get_title() !== 'Kimochi · popup-host') {
                if (this._popupClicked && !this._restoringFocus) this._dismissPopup();
                return;
            }
            const [x, y, mods] = global.get_pointer();
            const r = win.get_frame_rect();
            const clicked = Boolean(mods & Clutter.ModifierType.BUTTON1_MASK) &&
                x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
            if (clicked || this._popupClicked) return;
            // Mutter can activate a newly mapped same-app toplevel despite GTK's
            // focus_on_map=false. Restore the focus it had immediately before map;
            // do not override a deliberate click or a subsequent unrelated switch.
            const previous = this._focusBeforePopup;
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!this._popupClicked && global.display.focus_window === win && previous?.get_compositor_private()) {
                    this._restoringFocus = true;
                    try { previous.activate(global.get_current_time()); }
                    finally { this._restoringFocus = false; }
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        this._lockSignal = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
                this._clear();
        });
    }

    _outsidePress(x, y) {
        if (!this._nativePopup?.get_compositor_private()?.get_paint_visibility()) return;
        const rects = this._popupRects ?? [this._nativePopup.get_frame_rect()];
        if (rects.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) {
            this._popupClicked = true;
            return;
        }
        this._dismissPopup();
    }

    _dismissPopup() {
        if (!this._nativePopup?.get_compositor_private()?.get_paint_visibility()) return;
        this._bus.emit_signal('Dismiss', null);
        this._nativePopup.get_compositor_private()?.hide();
        this._placement = this._nativePopup = null;
        this._popupClicked = false;
        this._popupRects = null;
        this._match = null;
        this._paintHighlight();
    }

    _watchPopupButtons() {
        if (this._buttonTimer || !this._nativePopup?.get_compositor_private()?.get_paint_visibility()) return;
        const mask = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK;
        this._buttons = global.get_pointer()[2] & mask;
        // Only the small visible dictionary needs this cadence. Ordinary client
        // presses bypass Shell actor events and can be shorter than a frame.
        this._buttonTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2, () => {
            if (!this._nativePopup?.get_compositor_private()?.get_paint_visibility()) {
                this._buttonTimer = null;
                return GLib.SOURCE_REMOVE;
            }
            const [x, y, mods] = global.get_pointer();
            const buttons = mods & mask;
            if (buttons && !this._buttons) this._outsidePress(x, y);
            this._buttons = buttons;
            return GLib.SOURCE_CONTINUE;
        });
    }

    HighlightAsync([payload], invocation) {
        try {
            if (this._owner !== invocation.get_sender()) throw new Error('Only the annotation owner may highlight');
            if (payload.length > 1024) throw new Error('Highlight exceeds limit');
            const data = JSON.parse(payload);
            if (data.serial !== this._serial || data.index !== this._lastLookup) {
                invocation.return_value(null);
                return;
            }
            if (!Number.isInteger(data.index) || !this._words[data.index] || !Number.isInteger(data.length) || data.length < 0 || data.length > 512)
                throw new Error('Invalid dictionary match');
            this._match = {index: data.index, length: data.length};
            this._paintHighlight();
            invocation.return_value(null);
        } catch (e) { invocation.return_dbus_error(`${IFACE}.InvalidHighlight`, e.message); }
    }

    _paintHighlight() {
        const match = this._match;
        const first = match ? this._words[match.index] : null;
        let end = match?.index ?? -1;
        if (first) {
            while (end < this._words.length) {
                const w = this._words[end];
                if (w.sentence !== first.sentence || w.offset >= first.offset + match.length ||
                    (end > match.index && w.offset <= this._words[end - 1].offset)) break;
                ++end;
            }
        }
        this._words.forEach((w, i) => {
            const selected = first ? i >= match.index && i < end : i === this._hoverIndex;
            this._group.get_child_at_index(i)?.set_style(selected
                ? 'background-color: rgba(135,87,217,0.14); border: 0; border-bottom: 2px solid rgba(135,87,217,0.8); border-radius: 3px;'
                : 'background-color: transparent; border: 0; border-radius: 3px;');
        });
    }

    _controlVisible() {
        const [width, height] = this._hideButton.get_transformed_size();
        return this._hideButton.get_paint_visibility() && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
    }

    Status() {
        return JSON.stringify({protocol: 1, shell: '46', words: this._words.length,
            keyboardGrab: false, fullscreenInputSurface: false, hideButton: this._hideButton?.visible ? {position: this._hideButton.get_transformed_position(), size: this._hideButton.get_transformed_size()} : null, pointer: global.get_pointer(),
            painted: this._group.get_paint_visibility(),
            appearance: 'matched-word-highlight', matched: this._match ?? null, desktopPopup: true, revision: this.metadata.revision,
            ownPopup: this._nativePopup ? (() => { const r = this._nativePopup.get_frame_rect(); return {x: r.x, y: r.y, width: r.width, height: r.height}; })() : null,
            focus: global.display.focus_window?.get_title() ?? null,
            actors: this._words.map((w, i) => ({...w, position: this._group.get_child_at_index(i)?.get_transformed_position(), size: this._group.get_child_at_index(i)?.get_transformed_size(), style: this._group.get_child_at_index(i)?.get_style()})),
            lastClear: this._lastClearReason ?? null, suspended: Boolean(this._suspended), serial: this._serial, popup: Boolean(this._popup),
            monitors: Main.layoutManager.monitors.map(m => ({x: m.x, y: m.y, width: m.width, height: m.height, workArea: (() => { const r = Main.layoutManager.getWorkAreaForMonitor(m.index); return {x: r.x, y: r.y, width: r.width, height: r.height}; })()}))});
    }

    PresentAsync([payload], invocation) {
        try {
            const sender = invocation.get_sender();
            if (this._owner && this._owner !== sender)
                throw new Error('Another client owns these annotations');
            if (payload.length > 262144)
                throw new Error('Annotation payload exceeds limit');
            const data = JSON.parse(payload);
            if (data.sourceKind !== 'screen' || !Array.isArray(data.words) || data.words.length > 500)
                throw new Error('Only bounded screen annotations are supported; window tracking is deferred');
            const monitors = Main.layoutManager.monitors;
            const words = data.words.map(w => {
                if (![w.x, w.y, w.width, w.height].every(Number.isFinite) || w.width <= 0 || w.height <= 0 || typeof w.text !== 'string' || w.text.length > 512)
                    throw new Error('Invalid annotation');
                if (!monitors.some(m => w.x >= m.x && w.y >= m.y && w.x + w.width <= m.x + m.width && w.y + w.height <= m.y + m.height))
                    throw new Error('Annotation lies outside a monitor');
                return w;
            }).filter(w => {
                const primary = Main.layoutManager.primaryMonitor;
                return !primary || w.x + w.width <= primary.x || w.x >= primary.x + primary.width || w.y >= primary.y + Main.panel.height || w.y + w.height <= primary.y;
            });
            if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
                throw new Error('Annotations are unavailable on the lock screen');
            // A heartbeat must not undo the user's dismissal. A new OCR frame
            // includes a new frameId and can explicitly publish again.
            if (this._dismissedPayload === payload) {
                invocation.return_value(null);
                return;
            }
            this._dismissedPayload = null;
            if (this._payload === payload && this._owner === sender) {
                this._lastUpdate = GLib.get_monotonic_time();
                invocation.return_value(null);
                return;
            }
            const suspended = this._suspended;
            this._clear();
            this._suspended = suspended;
            this._payload = payload;
            this._owner = sender;
            this._ownerWatch = Gio.bus_watch_name_on_connection(Gio.DBus.session, sender, Gio.BusNameWatcherFlags.NONE, null, () => this._clear('owner-vanished'));
            this._lastUpdate = GLib.get_monotonic_time();
            this._words = words;
            for (const w of words) {
                // Preserve the source's typography; only the hovered word is marked.
                const restingStyle = 'background-color: transparent; border: 0; border-radius: 3px;';
                const actor = new St.Widget({reactive: false, can_focus: false,
                    style: restingStyle});
                actor.set_position(w.x, w.y);
                actor.set_size(w.width, w.height);
                this._group.add_child(actor);
            }
            this._hideButton.visible = words.length > 0;
            this._group.visible = !this._suspended && this._controlVisible();
            invocation.return_value(null);
        } catch (e) {
            invocation.return_dbus_error(`${IFACE}.InvalidAnnotations`, e.message);
        }
    }

    ClearAsync(_args, invocation) {
        if (this._owner && this._owner !== invocation.get_sender()) {
            invocation.return_dbus_error(`${IFACE}.NotOwner`, 'Only the publishing client may clear annotations');
            return;
        }
        this._clear('client-clear');
        invocation.return_value(null);
    }

    // Only Kimochi's own process windows; never a portal window or foreign client.
    OwnWindowAsync([payload], invocation) {
        try {
            if (payload.length > 4096) throw new Error('Window request exceeds limit');
            const data = JSON.parse(payload);
            if (!['log', 'popup-host'].includes(data.label)) throw new Error('Unsupported own window');
            const response = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                new GLib.Variant('(s)', [invocation.get_sender()]), new GLib.VariantType('(u)'),
                Gio.DBusCallFlags.NONE, 1000, null);
            const [pid] = response.deep_unpack();
            const win = global.get_window_actors().map(a => a.meta_window)
                .find(w => w.get_pid() === pid && w.get_title() === `Kimochi · ${data.label}`);
            if (data.interactiveRects !== undefined) {
                if (data.label !== 'popup-host' || !Array.isArray(data.interactiveRects) || data.interactiveRects.length > 32 ||
                    !data.interactiveRects.every(r => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0 &&
                        Main.layoutManager.monitors.some(m => r.x >= m.x && r.y >= m.y && r.x + r.width <= m.x + m.width && r.y + r.height <= m.y + m.height)))
                    throw new Error('Invalid dictionary input rectangles');
                this._popupRects = data.interactiveRects;
            }
            if (data.sourceKind !== undefined) {
                if (data.label !== 'popup-host' || !['desktop', 'reader'].includes(data.sourceKind)) throw new Error('Invalid dictionary source');
                this._popupSourceKind = data.sourceKind;
            }
            if (data.rect) {
                if (data.label !== 'popup-host') throw new Error('Only the dictionary popup may be positioned');
                const r = data.rect;
                if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0 ||
                    !Main.layoutManager.monitors.some(m => r.width <= m.width && r.height <= m.height &&
                        r.x + r.width > m.x && r.x < m.x + m.width && r.y + r.height > m.y && r.y < m.y + m.height))
                    throw new Error('Dictionary popup must fit a monitor');
                if (!win?.get_compositor_private()?.get_paint_visibility()) this._popupClicked = false;
                // Snapshot only for this own-popup request; no foreign-window
                // geometry or general window-following/foreground tracker.
                const focused = global.display.focus_window;
                if (focused && focused !== win) this._focusBeforePopup = focused;
                this._placement = {pid, rect: r};
                if (win) {
                    this._placePopup(win, r);
                    if (!this._suspended) win.get_compositor_private()?.show();
                }
            }
            if (!win && !data.rect && !data.sourceKind) throw new Error('Own window is not mapped');
            const r = win?.get_frame_rect();
            invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(r ? {x: r.x, y: r.y, width: r.width, height: r.height} : {pending: true})]));
        } catch (e) { invocation.return_dbus_error(`${IFACE}.InvalidOwnWindow`, e.message); }
    }

    _placePopup(win, r) {
        this._nativePopup = win;
        win.make_above();
        const current = win.get_frame_rect();
        if (current.x !== Math.round(r.x) || current.y !== Math.round(r.y))
            win.move_frame(false, Math.round(r.x), Math.round(r.y));
        this._watchPopupButtons();
    }

    SuspendAsync([on], invocation) {
        if (this._owner && this._owner !== invocation.get_sender()) {
            invocation.return_dbus_error(`${IFACE}.NotOwner`, 'Only the annotation owner may suppress annotations');
            return;
        }
        const hadAnnotations = this._words.length > 0 || Boolean(this._nativePopup?.get_compositor_private()?.visible);
        this._suspended = on;
        this._group.visible = !on && this._controlVisible();
        if (this._popup) this._popup.visible = !on && this._controlVisible();
        const actor = this._nativePopup?.get_compositor_private();
        if (actor) {
            if (on) { this._popupWasVisible = actor.visible; actor.hide(); }
            else if (this._popupWasVisible) actor.show();
        }
        invocation.return_value(new GLib.Variant('(b)', [hadAnnotations]));
    }

    _clear(reason = 'replace-or-disable') {
        this._lastClearReason = reason;
        if (this._ownerWatch) Gio.bus_unwatch_name(this._ownerWatch);
        this._ownerWatch = null;
        this._suspended = false;
        this._serial = (this._serial ?? 0) + 1;
        if (this._popupSourceKind === 'desktop') {
            this._bus?.emit_signal('Dismiss', null);
            this._nativePopup?.get_compositor_private()?.hide();
            this._placement = this._nativePopup = null;
            this._popupRects = null;
        }
        this._popup?.destroy();
        this._popup = null;
        this._payload = null;
        this._group?.destroy_all_children();
        this._words = [];
        this._hideButton?.hide();
        this._owner = null;
        this._lastUpdate = 0;
        this._lastLookup = null;
        this._hoverIndex = -1;
        this._match = null;
    }

    disable() {
        this._bus?.emit_signal('Dismiss', null);
        this._nativePopup?.get_compositor_private()?.hide();
        if (this._timer) GLib.source_remove(this._timer);
        if (this._buttonTimer) GLib.source_remove(this._buttonTimer);
        this._buttonTimer = null;
        if (this._lockSignal) Main.sessionMode.disconnect(this._lockSignal);
        if (this._pointerSignal) global.stage.disconnect(this._pointerSignal);
        if (this._focusSignal) global.display.disconnect(this._focusSignal);
        this._clear();
        this._bus?.unexport();
        if (this._name) Gio.bus_unown_name(this._name);
        this._group?.destroy();
        this._hideButton?.destroy();
        this._hideButton = null;
        this._timer = this._lockSignal = this._name = null;
        this._dismissedPayload = null;
        this._bus = this._group = null;
        this._words = [];
        this._owner = null;
        this._placement = this._nativePopup = null;
        this._popupRects = null;
    }
}
