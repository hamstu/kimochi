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
<method name="Definition"><arg type="s" direction="in"/></method>
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
            if (!this._words.length) return GLib.SOURCE_CONTINUE;
            // Never publish input/text when the emergency panel control is hidden.
            const visible = !this._suspended && this._controlVisible();
            this._group.visible = visible;
            if (this._popup) this._popup.visible = visible;
            if (!visible) return GLib.SOURCE_CONTINUE;
            const [x, y, mods] = global.get_pointer();
            const p = this._popup?.get_transformed_position();
            const size = this._popup?.get_transformed_size();
            if (p && size && x >= p[0] && y >= p[1] && x < p[0] + size[0] && y < p[1] + size[1]) return GLib.SOURCE_CONTINUE;
            const index = this._words.findIndex(w => x >= w.x && y >= w.y && x < w.x + w.width && y < w.y + w.height);
            const key = (mods & Clutter.ModifierType.SHIFT_MASK) && index >= 0 ? index : null;
            if (key !== null && key !== this._lastLookup)
                this._bus.emit_signal('Lookup', new GLib.Variant('(s)', [JSON.stringify({index: key, serial: this._serial, text: this._words[key].text, x, y})]));
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
            appearance: 'hover-highlight',
            actors: this._words.map((w, i) => ({...w, position: this._group.get_child_at_index(i)?.get_transformed_position(), size: this._group.get_child_at_index(i)?.get_transformed_size(), style: this._group.get_child_at_index(i)?.get_style()})),
            suspended: Boolean(this._suspended), serial: this._serial, popup: Boolean(this._popup),
            monitors: Main.layoutManager.monitors.map(m => ({x: m.x, y: m.y, width: m.width, height: m.height}))});
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
            this._ownerWatch = Gio.bus_watch_name_on_connection(Gio.DBus.session, sender, Gio.BusNameWatcherFlags.NONE, null, () => this._clear());
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
                    this._bus.emit_signal('Lookup', new GLib.Variant('(s)', [JSON.stringify({index: this._words.indexOf(w), serial: this._serial, text: w.text, x, y})]));
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
        this._clear();
        invocation.return_value(null);
    }

    DefinitionAsync([payload], invocation) {
        try {
            if (!this._owner || this._owner !== invocation.get_sender())
                throw new Error('Only the annotation owner may publish definitions');
            if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) throw new Error('Definitions are unavailable on the lock screen');
            if (payload.length > 16384) throw new Error('Definition exceeds limit');
            const data = JSON.parse(payload);
            if (data.serial !== this._serial) throw new Error('This lookup belongs to an older annotation frame');
            if (![data.x, data.y].every(Number.isFinite) || !['text', 'reading', 'definition'].every(k => typeof data[k] === 'string'))
                throw new Error('Invalid definition');
            this._popup?.destroy();
            const monitor = Main.layoutManager.monitors.find(m => data.x >= m.x && data.y >= m.y && data.x < m.x + m.width && data.y < m.y + m.height);
            if (!monitor) throw new Error('Lookup is outside a monitor');
            const width = Math.min(420, monitor.width);
            this._popup = new St.BoxLayout({vertical: true, reactive: true, can_focus: false,
                style: 'background-color: #fff; color: #111; border: 1px solid #8757d9; border-radius: 8px; padding: 12px;'});
            this._popup.add_child(new St.Label({text: `${data.text.slice(0, 512)} ${data.reading.slice(0, 512)}`, style: 'font-size: 22px;'}));
            const label = new St.Label({text: data.definition.slice(0, 4000)});
            label.clutter_text.line_wrap = true;
            const scroll = new St.ScrollView({reactive: true, can_focus: false});
            scroll.set_height(Math.min(180, monitor.height - 60));
            const content = new St.BoxLayout({vertical: true});
            content.add_child(label);
            scroll.set_child(content);
            this._popup.add_child(scroll);
            this._popup.set_width(width);
            this._popup.set_position(Math.max(monitor.x, Math.min(data.x + 16, monitor.x + monitor.width - width)), Math.max(monitor.y, Math.min(data.y + 20, monitor.y + monitor.height - 240)));
            Main.layoutManager.addChrome(this._popup, {affectsStruts: false});
            this._popup.visible = !this._suspended && this._controlVisible();
            invocation.return_value(null);
        } catch (e) { invocation.return_dbus_error(`${IFACE}.InvalidDefinition`, e.message); }
    }

    SuspendAsync([on], invocation) {
        if (this._owner && this._owner !== invocation.get_sender()) {
            invocation.return_dbus_error(`${IFACE}.NotOwner`, 'Only the annotation owner may suppress annotations');
            return;
        }
        const hadAnnotations = this._words.length > 0;
        this._suspended = on;
        this._group.visible = !on && this._controlVisible();
        if (this._popup) this._popup.visible = !on && this._controlVisible();
        invocation.return_value(new GLib.Variant('(b)', [hadAnnotations]));
    }

    _clear() {
        if (this._ownerWatch) Gio.bus_unwatch_name(this._ownerWatch);
        this._ownerWatch = null;
        this._suspended = false;
        this._serial = (this._serial ?? 0) + 1;
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
        if (this._timer) GLib.source_remove(this._timer);
        if (this._lockSignal) Main.sessionMode.disconnect(this._lockSignal);
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
    }
}
