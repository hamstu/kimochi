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
</interface></node>`;

export default class KimochiOverlay extends Extension {
    enable() {
        this._words = [];
        this._owner = null;
        this._lastUpdate = 0;
        this._lastLookup = null;
        this._group = new Clutter.Actor({reactive: false});
        Main.layoutManager.addChrome(this._group, {affectsInputRegion: false, trackFullscreen: true});
        this._bus = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this._bus.export(Gio.DBus.session, '/dev/kimochi/GnomeOverlay');
        this._name = Gio.bus_own_name_on_connection(Gio.DBus.session, IFACE, Gio.BusNameOwnerFlags.NONE, null, null);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (this._lastUpdate && GLib.get_monotonic_time() - this._lastUpdate > 5000000)
                this._clear();
            if (this._placement) {
                const win = global.get_window_actors().map(a => a.meta_window).find(w =>
                    w.get_pid() === this._placement.pid && w.get_title() === 'Kimochi · popup-host');
                if (win) this._placePopup(win, this._placement.rect);
            }
            if (!this._words.length) return GLib.SOURCE_CONTINUE;
            // Never publish input/text when the emergency panel control is hidden.
            const visible = !this._suspended && this._controlVisible();
            this._group.visible = visible;
            if (this._popup) this._popup.visible = visible;
            if (!visible) return GLib.SOURCE_CONTINUE;
            const [x, y, mods] = global.get_pointer();
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
            if (event.type() !== Clutter.EventType.BUTTON_PRESS || !this._nativePopup?.get_compositor_private()?.get_paint_visibility()) return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            const r = this._nativePopup.get_frame_rect();
            if (x < r.x || x >= r.x + r.width || y < r.y || y >= r.y + r.height) {
                if (!this._words.some(w => x >= w.x && x < w.x + w.width && y >= w.y && y < w.y + w.height)) {
                    this._bus.emit_signal('Dismiss', null);
                    this._nativePopup.get_compositor_private()?.hide();
                    this._placement = this._nativePopup = null;
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._lockSignal = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
                this._clear();
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
            appearance: 'hover-highlight', desktopPopup: true, revision: this.metadata.revision,
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
                const actor = new St.Widget({reactive: true, can_focus: false, track_hover: true,
                    style: restingStyle});
                actor.connect('notify::hover', () => actor.set_style(actor.hover
                    ? 'background-color: rgba(135,87,217,0.14); border: 0; border-bottom: 2px solid rgba(135,87,217,0.8); border-radius: 3px;'
                    : restingStyle));
                actor.set_position(w.x, w.y);
                actor.set_size(w.width, w.height);
                actor.connect('button-press-event', () => {
                    const [x, y] = global.get_pointer();
                    this._bus.emit_signal('Lookup', new GLib.Variant('(s)', [JSON.stringify({index: this._words.indexOf(w), serial: this._serial, text: w.text, sentence: w.sentence, offset: w.offset, rect: w, x, y})]));
                    return Clutter.EVENT_STOP;
                });
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
        win.move_frame(false, Math.round(r.x), Math.round(r.y));
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
    }

    disable() {
        this._bus?.emit_signal('Dismiss', null);
        this._nativePopup?.get_compositor_private()?.hide();
        if (this._timer) GLib.source_remove(this._timer);
        if (this._lockSignal) Main.sessionMode.disconnect(this._lockSignal);
        if (this._pointerSignal) global.stage.disconnect(this._pointerSignal);
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
    }
}
