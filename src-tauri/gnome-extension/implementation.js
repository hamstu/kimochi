/* global global */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const IFACE = 'dev.kimochi.GnomeOverlay';
const ORDINARY = ['log','settings','diagnostics','dictionary','welcome','sync-log'];
const COVERING = ['log','settings','diagnostics','dictionary','welcome'];
const XML = `<node><interface name="${IFACE}">
<method name="Status"><arg type="s" direction="out"/></method>
<method name="Present"><arg type="s" direction="in"/></method>
<method name="Clear"/>
<method name="Surface"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
<signal name="Pointer"><arg type="s"/></signal>
<method name="OwnWindow"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
<signal name="Dismiss"/>
<method name="Suspend"><arg type="b" direction="in"/><arg type="b" direction="out"/></method>
<signal name="Lookup"><arg type="s"/></signal>
<signal name="Modifier"><arg type="b"/></signal>
<method name="Crop"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
<method name="Controller"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
<method name="Shortcuts"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
<signal name="Action"><arg type="s"/></signal>
<method name="Track"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
<signal name="TrackResult"><arg type="s"/></signal>
<signal name="CropResult"><arg type="s"/></signal>
<method name="Highlight"><arg type="s" direction="in"/></method>
</interface></node>`;

export default class KimochiOverlay extends Extension {
    enable() {
        this._pins=new Map();
        this._passiveWindows=new Map();this._passiveApps=new Map();
        this._shortcuts=new Map();
        this._acceleratorSignal=global.display.connect('accelerator-activated',(_display,id)=>{
            const name=this._shortcuts.get(id);
            if(name&&!Main.sessionMode.isLocked&&!Main.sessionMode.isGreeter)this._bus.emit_signal('Action',new GLib.Variant('(s)',[name]));
        });
        this._words = [];
        this._owner = null;
        this._lastUpdate = 0;
        this._lastLookup = null;
        this._hoverIndex = -1;
        this._shift = null;
        this._buttons = 0;
        this._focusBeforePopup = null;
        this._group = new Clutter.Actor({reactive: false});
        Main.layoutManager.addChrome(this._group, {affectsInputRegion: false, trackFullscreen: false});
        this._bus = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this._bus.export(Gio.DBus.session, '/dev/kimochi/GnomeOverlay');
        this._name = Gio.bus_own_name_on_connection(Gio.DBus.session, IFACE, Gio.BusNameOwnerFlags.NONE, null, null);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            if (this._pick && GLib.get_monotonic_time()-this._pick.started>30000000) this._finishPick(null,'timeout');
            if(this._controller&&GLib.get_monotonic_time()-this._controller.updated>5000000)this._finishController();
            this._followTracked();
            this._syncPins();
            this._syncSurface();
            this._transparentCrop();
            if (this._crop && GLib.get_monotonic_time() - this._crop.updated > 5000000) this._finishCrop(false, 'timeout');
            if (this._lastUpdate && GLib.get_monotonic_time() - this._lastUpdate > 5000000)
                this._clear();
            if (this._crop?.sourceId?.startsWith('portal:window:')) {
                const t=this._trackedStatus(),a=this._crop.area;
                if(!t||!this._crop.webview&&!t.visible||['x','y','width','height'].some(k=>Math.abs(t.bounds[k]-a[k])>=2)) this._finishCrop(false,'window-changed');
            }
            if (this._crop || this._pick) return GLib.SOURCE_CONTINUE;
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
            const visible = !this._suspended && !this._pick && !this._crop && (this._sourceKind!=='window'||this._trackedVisible) && this._controlVisible();
            this._group.visible = visible && (!this._surface || this._controller?.mode === 'words');
            if (this._popup) this._popup.visible = visible;
            if (!visible || this._surface) return GLib.SOURCE_CONTINUE;
            const nativeRect = this._nativePopup?.get_compositor_private()?.get_paint_visibility() ? this._nativePopup.get_frame_rect() : null;
            if (nativeRect && x >= nativeRect.x && y >= nativeRect.y && x < nativeRect.x + nativeRect.width && y < nativeRect.y + nativeRect.height)
                return GLib.SOURCE_CONTINUE;
            const p = this._popup?.get_transformed_position();
            const size = this._popup?.get_transformed_size();
            if (p && size && x >= p[0] && y >= p[1] && x < p[0] + size[0] && y < p[1] + size[1]) return GLib.SOURCE_CONTINUE;
            if(this._controller?.mode==='words')return GLib.SOURCE_CONTINUE;
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
            this._finishPick(null,'cancelled');
            this._finishCrop(false, 'cancelled');
            this._finishController();
            this._dismissedPayload = this._payload;
            this._clear();
            return Clutter.EVENT_STOP;
        });
        Main.panel.addToStatusArea(this.uuid, this._hideButton);
        this._hideButton.hide();
        // A bounded emergency button remains reachable over fullscreen sources;
        // no ordinary transparent toplevel or whole-screen passive input region.
        this._fallbackHide = new St.Button({label:'Hide Kimochi',reactive:true,can_focus:false,
            style:'background-color: rgba(32,33,38,0.88); color: #eeeeef; border: 1px solid #45434d; border-radius: 8px; padding: 6px 12px;'});
        this._fallbackHide.set_size(128,36);
        this._fallbackHide.connect('clicked',()=>{
            this._finishPick(null,'cancelled');this._finishCrop(false,'cancelled');
            this._dismissedPayload=this._payload;this._clear('emergency-hide');
        });
        Main.layoutManager.addChrome(this._fallbackHide,{affectsInputRegion:true,trackFullscreen:false});
        this._fallbackHide.hide();
        this._pointerSignal = global.stage.connect('captured-event', (_actor, event) => {
            if ((this._crop && !this._crop.webview || this._pick) && event.type() === Clutter.EventType.KEY_PRESS) {
                if (event.get_key_symbol() === Clutter.KEY_Escape) { this._finishCrop(false, 'cancelled'); this._finishPick(null,'cancelled'); return Clutter.EVENT_STOP; }
                if (event.get_key_symbol() === Clutter.KEY_Return) { this._finishCrop(true); return Clutter.EVENT_STOP; }
            }
            if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                const [x, y] = event.get_coords();
                this._outsidePress(x, y);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._focusSignal = global.display.connect('notify::focus-window', () => {
            const win = global.display.focus_window;
            if (!win) return;
            // The annotation WebView is permanently non-focusable. This also
            // fences an unsolicited map activation by Mutter without a grab.
            if (win === this._surface?.window) {
                const previous = this._surface.previousFocus;
                if (previous && previous !== win && previous.get_compositor_private())
                    previous.activate(global.get_current_time());
                return;
            }
            if(this._controller&&win!==this._controller.previousFocus&&win!==this._controller.window&&win!==this._nativePopup&&!(win.get_pid()===this._controller.pid&&win.get_title()==='Kimochi · controller-host'))this._finishController();
            if(this._crop&&win!==this._crop.previousFocus&&win!==this._crop.window&&!(this._crop.webview&&win.get_pid()===this._crop.pid&&win.get_title()==='Kimochi · crop-host'))this._finishCrop(false,'focus-changed');
            if(this._pick&&win!==this._pick.previousFocus)this._finishPick(null,'focus-changed');
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
                { this._finishController();this._finishPick(null,'locked'); this._finishCrop(false, 'locked'); this._clear(); }
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

    // Portal streams deliberately omit a Mutter window identity. Pair explicitly
    // with the user-selected live window; never guess from a title or frame size.
    TrackAsync([payload], invocation) {
        try {
            if (payload.length>4096) throw new Error('Tracking request exceeds limit');
            const data=JSON.parse(payload),sender=invocation.get_sender();
            if (data.operation==='status') {
                invocation.return_value(new GLib.Variant('(s)',[JSON.stringify(this._tracked?.sourceId===data.sourceId ? this._trackedStatus() : null)])); return;
            }
            if (this._tracked && this._tracked.owner!==sender || this._pick && this._pick.owner!==sender) throw new Error('Another client owns window tracking');
            if (data.operation==='activate') {
                if(this._tracked?.sourceId!==data.sourceId||!this._trackedStatus()) throw new Error('Shared window is not linked');
                this._tracked.window.unminimize();this._tracked.window.activate_with_workspace(global.get_current_time(),this._tracked.window.get_workspace());
                invocation.return_value(new GLib.Variant('(s)',[JSON.stringify({ok:true})]));return;
            }
            if (data.operation==='match') {
                if(typeof data.sourceId!=='string'||!/^portal:window:[0-9]+$/.test(data.sourceId)||
                    ![data.width,data.height].every(v=>Number.isInteger(v)&&v>0&&v<=65535)) throw new Error('Invalid shared window frame');
                const current=this._trackedStatus();
                if(current?.sourceId===data.sourceId){invocation.return_value(new GLib.Variant('(s)',[JSON.stringify(current)]));return;}
                const response=Gio.DBus.session.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetConnectionUnixProcessID',
                    new GLib.Variant('(s)',[sender]),new GLib.VariantType('(u)'),Gio.DBusCallFlags.NONE,1000,null);
                const pid=response.deep_unpack()[0],win=this._matchWindow(data,pid);
                if(win)this._bindTracked(win,sender,data.sourceId,false,'automatic',pid);
                invocation.return_value(new GLib.Variant('(s)',[JSON.stringify(win?this._trackedStatus():null)]));return;
            }
            if (data.operation==='clear') {this._finishPick(null,'source-changed');this._finishCrop(false,'source-changed');this._forgetTracked();}
            else if (data.operation==='cancel') this._finishPick(null,'cancelled');
            else if (data.operation==='choose') {
                if (this._pick || this._crop || Main.sessionMode.isLocked || Main.sessionMode.isGreeter) throw new Error('Window selection is currently unavailable');
                if (typeof data.sourceId!=='string' || !/^portal:window:[0-9]+$/.test(data.sourceId)) throw new Error('Share a window before linking its desktop position');
                const response=Gio.DBus.session.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetConnectionUnixProcessID',
                    new GLib.Variant('(s)',[sender]),new GLib.VariantType('(u)'),Gio.DBusCallFlags.NONE,1000,null);
                this._pick={owner:sender,pid:response.deep_unpack()[0],sourceId:data.sourceId,previousFocus:global.display.focus_window,started:GLib.get_monotonic_time()};
                this._pickWatch=Gio.bus_watch_name_on_connection(Gio.DBus.session,sender,Gio.BusNameWatcherFlags.NONE,null,()=>this._finishPick(null,'owner-vanished'));
                this._dismissPopup();this._group.hide();
                this._pickGroup=new Clutter.Actor({reactive:false});
                Main.layoutManager.addChrome(this._pickGroup,{affectsInputRegion:true,trackFullscreen:false});
                for (const m of Main.layoutManager.monitors) {
                    const surface=new St.Widget({reactive:true,can_focus:true,style:'background-color: rgba(0,0,0,0.12);'});
                    surface.set_position(m.x,m.y);surface.set_size(m.width,m.height);this._pickGroup.add_child(surface);
                    surface.connect('button-press-event',(_a,event)=>{
                        if(event.get_button()!==1)return Clutter.EVENT_PROPAGATE;
                        const [x,y]=event.get_coords();
                        const win=global.get_window_actors().slice().reverse().map(a=>a.meta_window).find(w=>{
                            const r=w.get_frame_rect();return w.get_pid()!==this._pick.pid && w.showing_on_its_workspace() && !w.minimized &&
                                x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height;
                        });
                        if(win)this._finishPick(win,'linked');
                        return Clutter.EVENT_STOP;
                    });
                    const bar=new St.BoxLayout({style:'background-color: #202126; color: #eeeeef; border: 1px solid #45434d; border-radius: 12px; padding: 10px; spacing: 12px;'});
                    bar.add_child(new St.Label({text:'Click the window you shared to link its overlay',y_align:Clutter.ActorAlign.CENTER}));
                    const cancel=new St.Button({label:'Cancel',style:'padding: 8px 16px; background-color: #454050; border-radius: 7px;'});
                    cancel.connect('clicked',()=>this._finishPick(null,'cancelled'));bar.add_child(cancel);
                    bar.set_position(m.x+Math.max(8,(m.width-600)/2),m.y+Math.max(Main.panel.height+12,40));this._pickGroup.add_child(bar);
                }
                this._hideButton.show();this._controlVisible();
            } else throw new Error('Unknown tracking operation');
            invocation.return_value(new GLib.Variant('(s)',[JSON.stringify({ok:true})]));
        } catch(e) {invocation.return_dbus_error(`${IFACE}.InvalidTracking`,e.message);}
    }

    _finishPick(win,reason) {
        const p=this._pick;if(!p)return;
        this._pick=null;this._pickGroup?.destroy();this._pickGroup=null;
        if(this._pickWatch)Gio.bus_unwatch_name(this._pickWatch);this._pickWatch=null;
        if(win){
            this._bindTracked(win,p.owner,p.sourceId,true,'manual',p.pid);
        }
        this._hideButton.visible=this._words.length>0;
        this._bus?.emit_signal('TrackResult',new GLib.Variant('(s)',[JSON.stringify({sourceId:p.sourceId,linked:Boolean(win),reason,window:win?this._trackedStatus():null})]));
    }

    _matchWindow(data,pid) {
        const normalize=s=>String(s??'').trim().toLocaleLowerCase();
        const name=normalize(data.name);
        const usableName=name&&!['shared window','window'].includes(name);
        const candidates=global.get_window_actors().map(a=>a.meta_window).filter(w=>{
            if(w.get_pid()===pid||!w.get_compositor_private())return false;
            const r=w.get_buffer_rect(),scale=w.get_compositor_private().get_resource_scale();
            return scale>0&&Math.abs(r.width*scale-data.width)<=2&&Math.abs(r.height*scale-data.height)<=2;
        });
        const named=usableName?candidates.filter(w=>normalize(w.get_title())===name):[];
        if(named.length===1)return named[0];
        return candidates.length===1?candidates[0]:null;
    }

    _bindTracked(win,owner,sourceId,activate,method,pid) {
        this._forgetTracked();
        this._tracked={owner,pid,sourceId,window:win,sequence:win.get_stable_sequence(),method};
        this._trackWatch=Gio.bus_watch_name_on_connection(Gio.DBus.session,owner,Gio.BusNameWatcherFlags.NONE,null,()=>this._forgetTracked());
        if(activate)win.activate(global.get_current_time());
    }

    _forgetTracked() {
        if(this._trackWatch)Gio.bus_unwatch_name(this._trackWatch);this._trackWatch=null;
        this._tracked=null;
        this._coverage=null;
        if(this._sourceKind==='window'){this._finishController();this._clear('tracked-window-unavailable');}
    }

    ControllerAsync([payload],invocation) {
        try {
            if(payload.length>4096)throw new Error('Controller request exceeds limit');
            const data=JSON.parse(payload),owner=invocation.get_sender();
            if(this._controller&&this._controller.owner!==owner)throw new Error('Another client owns controller navigation');
            if(data.operation==='open') {
                if(this._crop||this._pick||Main.sessionMode.isLocked||Main.sessionMode.isGreeter)throw new Error('Controller menu unavailable during selection or lock');
                if(!this._controller) {
                    const reply=Gio.DBus.session.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetConnectionUnixProcessID',new GLib.Variant('(s)',[owner]),new GLib.VariantType('(u)'),Gio.DBusCallFlags.NONE,1000,null);
                    const m=Main.layoutManager.monitors[Main.layoutManager.primaryIndex],t=this._trackedStatus();
                    const width=Math.min(520,m.width),height=Math.min(520,m.height);
                    const cx=t?t.bounds.x+t.bounds.width/2:m.x+m.width/2,cy=t?t.bounds.y+t.bounds.height/2:m.y+m.height/2;
                    this._controller={owner,pid:reply.deep_unpack()[0],previousFocus:global.display.focus_window,rect:{x:Math.max(m.x,Math.min(m.x+m.width-width,Math.round(cx-width/2))),y:Math.max(m.y,Math.min(m.y+m.height-height,Math.round(cy-height/2))),width,height},mode:'menu'};
                    this._controllerWatch=Gio.bus_watch_name_on_connection(Gio.DBus.session,owner,Gio.BusNameWatcherFlags.NONE,null,()=>this._finishController());
                }
            } else if(data.operation==='close') {this._finishController();}
            else {
                if(!this._controller)throw new Error('Controller lease is closed');
                if(data.operation==='mode') {
                    if(!['menu','words'].includes(data.mode))throw new Error('Invalid controller mode');
                    this._controller.mode=data.mode;
                    if(data.mode==='words') {this._controller.rect.height=100;this._controller.window?.move_resize_frame(false,this._controller.rect.x,this._controller.rect.y,this._controller.rect.width,100);}
                } else if(data.operation==='lookup') {
                    const w=this._words[data.index];
                    if(!Number.isInteger(data.index)||!w||this._suspended)throw new Error('Word is no longer available');
                    this._lastLookup=data.index;this._hoverIndex=data.index;
                    this._bus.emit_signal('Lookup',new GLib.Variant('(s)',[JSON.stringify({index:data.index,serial:this._serial,text:w.text,sentence:w.sentence,offset:w.offset,rect:w,x:w.x,y:w.y})]));
                } else if(data.operation!=='keep')throw new Error('Unknown controller operation');
            }
            if(this._controller)this._controller.updated=GLib.get_monotonic_time();
            invocation.return_value(new GLib.Variant('(s)',[JSON.stringify({ok:true,rect:this._controller?.rect??null})]));
        }catch(e){invocation.return_dbus_error(`${IFACE}.InvalidController`,e.message);}
    }

    _finishController() {
        const c=this._controller;if(!c)return;this._controller=null;
        if(this._controllerWatch)Gio.bus_unwatch_name(this._controllerWatch);this._controllerWatch=null;
        c.window?.get_compositor_private()?.hide();
        if(global.display.focus_window===c.window&&c.previousFocus?.get_compositor_private())c.previousFocus.activate(global.get_current_time());
        this._bus?.emit_signal('Action',new GLib.Variant('(s)',['controllerClosed']));
    }

    ShortcutsAsync([payload], invocation) {
        try {
            const sender=invocation.get_sender(),data=JSON.parse(payload);
            if(payload.length>16384||!Array.isArray(data.bindings)||data.bindings.length>32||!data.bindings.every(b=>typeof b.name==='string'&&/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(b.name)&&typeof b.accelerator==='string'&&b.accelerator.length<=128))throw new Error('Invalid action shortcuts');
            if(this._shortcutOwner&&this._shortcutOwner!==sender)throw new Error('Another client owns the shortcuts');
            this._clearShortcuts();
            const registered=[],failed=[];
            for(const b of data.bindings){
                const id=global.display.grab_accelerator(b.accelerator,Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);
                if(!id){failed.push({name:b.name,error:'Shortcut is already used by the desktop or another application'});continue;}
                Main.wm.allowKeybinding(`external-grab-${id}`,Shell.ActionMode.NORMAL);
                this._shortcuts.set(id,b.name);registered.push(b.name);
            }
            this._shortcutOwner=sender;
            this._shortcutWatch=Gio.bus_watch_name_on_connection(Gio.DBus.session,sender,Gio.BusNameWatcherFlags.NONE,null,()=>this._clearShortcuts());
            invocation.return_value(new GLib.Variant('(s)',[JSON.stringify({backend:'gnome-shell',registered,failed,pending:false})]));
        }catch(e){invocation.return_dbus_error(`${IFACE}.InvalidShortcuts`,e.message);}
    }

    _clearShortcuts() {
        if(this._shortcutWatch)Gio.bus_unwatch_name(this._shortcutWatch);this._shortcutWatch=null;this._shortcutOwner=null;
        for(const id of this._shortcuts?.keys()??[]){global.display.ungrab_accelerator(id);Main.wm.allowKeybinding(`external-grab-${id}`,Shell.ActionMode.NONE);}
        this._shortcuts?.clear();
    }

    _trackedStatus() {
        const t=this._tracked,w=t?.window;if(!w)return null;
        if(!w.get_compositor_private()||w.get_stable_sequence()!==t.sequence){this._forgetTracked();return null;}
        const r=w.get_buffer_rect(),focused=global.display.focus_window;
        const popup=focused===this._nativePopup||focused===this._controller?.window;
        const appActive=focused&&t.pid&&focused.get_pid()===t.pid&&focused!==this._surface?.window&&!popup;
        // Match the shared cover rule: only TEXT overlap hides annotations.
        // Keep these rectangles while hidden, or coverage would oscillate.
        const coverage=this._coverage?.sourceId===t.sourceId?this._coverage:null;
        const dx=r.x-(coverage?.bounds?.x??r.x),dy=r.y-(coverage?.bounds?.y??r.y);
        const text=coverage?.rects??[];
        const covered=Boolean(global.get_window_actors().some(({meta_window:own})=>{
            if(own.get_pid()!==t.pid||!COVERING.some(label=>own.get_title()===`Kimochi · ${label}`)||
                !(appActive||own.is_above())||
                own.minimized||!own.showing_on_its_workspace()||!own.get_compositor_private()?.get_paint_visibility())return false;
            const a=own.get_frame_rect();
            return text.some(b=>a.x<b.x+dx+b.width+8&&b.x+dx-8<a.x+a.width&&
                a.y<b.y+dy+b.height+8&&b.y+dy-8<a.y+a.height);
        }));
        const app=Shell.WindowTracker.get_default().get_window_app(w),info=app?.get_app_info();
        return {appName:app?.get_name()??null,appId:info?.get_id()??w.get_gtk_application_id()??null,iconName:info?.get_icon()?.to_string()??'application-x-executable',sourceId:t.sourceId,sequence:t.sequence,method:t.method,windowId:String(w.get_id()),title:w.get_title(),bounds:{x:r.x,y:r.y,width:r.width,height:r.height},
            covered,visible:!w.minimized&&w.showing_on_its_workspace()&&w.get_compositor_private().get_paint_visibility()&&Boolean((focused===w||popup||appActive)&&!covered),
            scale:w.get_compositor_private().get_resource_scale()};
    }

    _followTracked() {
        if(this._sourceKind!=='window')return;
        const t=this._trackedStatus();
        const valid=t&&t.sourceId===this._sourceId;
        this._trackedVisible=Boolean(valid&&t.visible&&Math.abs(t.bounds.width-this._referenceBounds.width)<2&&Math.abs(t.bounds.height-this._referenceBounds.height)<2);
        if(!valid){this._clear('tracked-window-unavailable');return;}
        const dx=t.bounds.x-this._referenceBounds.x,dy=t.bounds.y-this._referenceBounds.y;
        this._words.forEach((w,i)=>{
            w.x=this._baseWords[i].x+dx;w.y=this._baseWords[i].y+dy;
            this._group.get_child_at_index(i)?.set_position(w.x,w.y);
        });
        if(!this._trackedVisible&&this._popupSourceKind==='desktop')this._dismissPopup();
    }

    CropAsync([payload], invocation) {
        try {
            if (payload.length > 4096) throw new Error('Crop request exceeds limit');
            const data = JSON.parse(payload), sender = invocation.get_sender();
            if (this._crop && this._crop.owner !== sender) throw new Error('Another client owns the crop editor');
            if (data.operation === 'keep') {
                if (!this._crop || data.id !== this._crop.id) throw new Error('Crop editor is no longer open');
                this._crop.updated = GLib.get_monotonic_time();
            } else if (data.operation === 'editor') {
                if (!this._crop || data.id !== this._crop.id || !this._crop.webview) throw new Error('Shared editor lease is unavailable');
                const c=this._crop;
                invocation.return_value(new GLib.Variant('(s)',[JSON.stringify({id:c.id,monitor:c.monitor,area:c.area,initial:c.rect,label:c.label,theme:c.theme})]));return;
            } else if (data.operation === 'complete') {
                const c=this._crop,r=data.rect;
                if(!c||data.id!==c.id||!c.webview) throw new Error('Shared editor lease is unavailable');
                if(r){const a=c.area;if(![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.width<1||r.height<1||r.x<a.x-1||r.y<a.y-1||r.x+r.width>a.x+a.width+1||r.y+r.height>a.y+a.height+1)throw new Error('Crop is outside the shared source');c.rect=r;}
                this._finishCrop(Boolean(r));
            } else if (data.operation === 'cancel') {
                if (this._crop && data.id === this._crop.id) this._finishCrop(false, 'cancelled');
            } else if (data.operation === 'start') {
                if (this._crop) throw new Error('Crop editor is already open');
                if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) throw new Error('Crop editor unavailable while locked');
                if (Main.layoutManager.monitors.length !== 1) throw new Error('Desktop crop requires one monitor until portal output mapping is validated');
                if (typeof data.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(data.id) ||
                    typeof data.sourceId !== 'string' || !/^portal:(display|window):[0-9]+$/.test(data.sourceId) ||
                    ![data.width, data.height].every(v => Number.isInteger(v) && v > 0 && v <= 65535) || !['Save', 'Scan'].includes(data.label))
                    throw new Error('An entire shared screen and valid frame dimensions are required');
                const m = Main.layoutManager.monitors[0];
                const monitor = {x:m.x, y:m.y, width:m.width, height:m.height};
                const tracked=data.sourceId.startsWith('portal:window:')?this._trackedStatus():null;
                if(data.sourceId.startsWith('portal:window:')&&(!tracked||tracked.sourceId!==data.sourceId||!this._tracked.window.showing_on_its_workspace()||this._tracked.window.minimized||this._tracked.owner!==sender)) throw new Error('Link and bring the shared window to the front before desktop cropping');
                const area=tracked?tracked.bounds:monitor;
                if(area.x<monitor.x||area.y<monitor.y||area.x+area.width>monitor.x+monitor.width||area.y+area.height>monitor.y+monitor.height) throw new Error('Move the shared window fully onto this screen before cropping');
                if(tracked&&(Math.abs(data.width-area.width*tracked.scale)>2||Math.abs(data.height-area.height*tracked.scale)>2)) throw new Error('Shared frame and linked window dimensions disagree; link the correct window or retry after resizing');
                let initial = null;
                if (data.initial) {
                    const c = data.initial;
                    if (![c.x,c.y,c.width,c.height,c.reference_width,c.reference_height].every(Number.isFinite) ||
                        c.x < 0 || c.y < 0 || c.width <= 0 || c.height <= 0 || c.reference_width <= 0 || c.reference_height <= 0 ||
                        c.x + c.width > c.reference_width || c.y + c.height > c.reference_height) throw new Error('Invalid saved crop');
                    initial = {x:area.x+c.x*area.width/c.reference_width,y:area.y+c.y*area.height/c.reference_height,
                        width:c.width*area.width/c.reference_width,height:c.height*area.height/c.reference_height};
                }
                if(tracked)this._tracked.window.activate(global.get_current_time());
                this._dismissPopup();
                this._group.hide();
                const pidReply=Gio.DBus.session.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetConnectionUnixProcessID',new GLib.Variant('(s)',[sender]),new GLib.VariantType('(u)'),Gio.DBusCallFlags.NONE,1000,null);
                this._crop = {id:data.id, owner:sender, pid:pidReply.deep_unpack()[0], width:data.width, height:data.height, monitor, area, sourceId:data.sourceId, rect:initial,
                    updated:GLib.get_monotonic_time(), previousFocus:global.display.focus_window, webview:data.ui==='shared',label:data.label,theme:data.theme==='light'?'light':'dark'};
                this._cropWatch = Gio.bus_watch_name_on_connection(Gio.DBus.session, sender, Gio.BusNameWatcherFlags.NONE, null,
                    () => this._finishCrop(false, 'owner-vanished'));
                if(!this._crop.webview)this._openCrop(data.label);
            } else throw new Error('Unknown crop operation');
            invocation.return_value(new GLib.Variant('(s)', [JSON.stringify({ok:true})]));
        } catch (e) { invocation.return_dbus_error(`${IFACE}.InvalidCrop`, e.message); }
    }

    // Mutter46 adds an opaque black backing to fullscreen Wayland actors.
    // Only the explicit, PID/owner-validated crop window may bypass that backing.
    _transparentCrop() {
        const c=this._crop;if(!c?.webview||!c.window)return;
        const actor=c.window.get_compositor_private();if(!actor)return;
        const background=actor.get_children().find(child=>{
            const color=child.get_background_color();
            return child.get_n_children()===0&&child.reactive&&color?.red===0&&color.green===0&&color.blue===0&&color.alpha===255;
        });
        if(!background)return;
        background.opacity=0;
        c.backgroundSuppressed=true;
        // Mutter's background culling checks the parent's paint opacity, not
        // whether that backing is painted.254 keeps lower windows rendered.
        if(!c.fadingIn){c.fadingIn=true;actor.ease({opacity:254,duration:120,mode:Clutter.AnimationMode.EASE_OUT_QUAD});}
        else if(!actor.get_transition('opacity'))actor.opacity=254;
    }

    _openCrop(label) {
        const c = this._crop, m = c.monitor;
        this._cropGroup = new Clutter.Actor({reactive:false});
        Main.layoutManager.addChrome(this._cropGroup, {affectsInputRegion:true, trackFullscreen:false});
        const surface = new St.Widget({reactive:true, can_focus:true});
        surface.set_position(m.x,m.y); surface.set_size(m.width,m.height);
        this._cropGroup.add_child(surface);
        this._cropShades = Array.from({length:4}, () => {
            const a = new St.Widget({reactive:false, style:'background-color: rgba(0,0,0,0.42);'});
            this._cropGroup.add_child(a); return a;
        });
        this._cropBox = new St.Widget({reactive:false, style:'border: 2px solid #a78bfa; background-color: rgba(135,87,217,0.05); border-radius: 3px;'});
        this._cropGroup.add_child(this._cropBox);
        surface.connect('button-press-event', (_a,event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            const [x,y] = event.get_coords(); this._cropBegin(x,y); surface.grab_key_focus(); return Clutter.EVENT_STOP;
        });
        surface.connect('motion-event', (_a,event) => { const [x,y]=event.get_coords(); this._cropMove(x,y); return Clutter.EVENT_STOP; });
        surface.connect('button-release-event', (_a,event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            const [x,y]=event.get_coords(); this._cropMove(x,y); if (this._crop) this._crop.drag=null; return Clutter.EVENT_STOP;
        });
        const bar = new St.BoxLayout({style:'background-color: #202126; color: #eeeeef; border: 1px solid #45434d; border-radius: 12px; padding: 10px; spacing: 12px;'});
        this._cropLabel = new St.Label({text:'Drag to select a region',y_align:Clutter.ActorAlign.CENTER}); bar.add_child(this._cropLabel);
        for (const [text,action] of [[label,()=>this._finishCrop(true)],['Reset',()=>{this._crop.rect=null;this._cropPaint();}],['Cancel',()=>this._finishCrop(false,'cancelled')]]) {
            const button=new St.Button({label:text,can_focus:true,style:'padding: 8px 16px; border-radius: 7px; background-color: #454050; color: #ffffff;'});
            button.connect('clicked', action); bar.add_child(button);
            if (text===label) this._cropSave=button;
            if (text==='Cancel') this._cropCancel=button;
        }
        bar.set_position(m.x+Math.max(8,(m.width-600)/2),m.y+Math.max(Main.panel.height+12,40));
        this._cropGroup.add_child(bar);
        this._hideButton.show();this._controlVisible();
        this._cropPaint();
    }

    _cropBegin(x,y) {
        const c=this._crop, r=c.rect;
        const a=c.area??c.monitor;x=Math.max(a.x,Math.min(a.x+a.width,x));y=Math.max(a.y,Math.min(a.y+a.height,y));
        let mode='new';
        if (r && x>=r.x-10 && x<=r.x+r.width+10 && y>=r.y-10 && y<=r.y+r.height+10) {
            const left=Math.abs(x-r.x)<=10,right=Math.abs(x-r.x-r.width)<=10;
            const top=Math.abs(y-r.y)<=10,bottom=Math.abs(y-r.y-r.height)<=10;
            mode=left||right||top||bottom ? {left,right,top,bottom} : 'move';
        }
        c.drag={x,y,mode,rect:r ? {...r} : null};
        if (mode==='new') c.rect={x,y,width:0,height:0};
        this._cropPaint();
    }

    _cropMove(x,y) {
        const c=this._crop, d=c?.drag; if (!d) return;
        const m=c.area??c.monitor; x=Math.max(m.x,Math.min(m.x+m.width,x)); y=Math.max(m.y,Math.min(m.y+m.height,y));
        if (d.mode==='new') c.rect={x:Math.min(d.x,x),y:Math.min(d.y,y),width:Math.abs(x-d.x),height:Math.abs(y-d.y)};
        else if (d.mode==='move') c.rect={...d.rect,x:Math.max(m.x,Math.min(m.x+m.width-d.rect.width,d.rect.x+x-d.x)),y:Math.max(m.y,Math.min(m.y+m.height-d.rect.height,d.rect.y+y-d.y))};
        else {
            const r=d.rect; const left=d.mode.left?x:r.x, right=d.mode.right?x:r.x+r.width;
            const top=d.mode.top?y:r.y, bottom=d.mode.bottom?y:r.y+r.height;
            c.rect={x:Math.min(left,right),y:Math.min(top,bottom),width:Math.abs(right-left),height:Math.abs(bottom-top)};
        }
        this._cropPaint();
    }

    _cropPaint() {
        const c=this._crop,m=c.monitor,a=c.area??m,r=c.rect??{x:a.x,y:a.y,width:0,height:0};
        const parts=[{x:m.x,y:m.y,width:m.width,height:r.y-m.y},
            {x:m.x,y:r.y+r.height,width:m.width,height:m.y+m.height-r.y-r.height},
            {x:m.x,y:r.y,width:r.x-m.x,height:r.height},
            {x:r.x+r.width,y:r.y,width:m.x+m.width-r.x-r.width,height:r.height}];
        parts.forEach((p,i)=>{this._cropShades[i].set_position(p.x,p.y);this._cropShades[i].set_size(Math.max(0,p.width),Math.max(0,p.height));});
        this._cropBox.set_position(r.x,r.y);this._cropBox.set_size(r.width,r.height);this._cropBox.visible=r.width>0&&r.height>0;
        this._cropSave.reactive=r.width>=2&&r.height>=2;
        this._cropLabel.text=r.width>=2&&r.height>=2 ? `${Math.round(r.width*c.width/a.width)} × ${Math.round(r.height*c.height/a.height)} · drag edges to resize` : 'Drag to select a region';
    }

    _finishCrop(save, reason='cancelled') {
        const c=this._crop; if (!c) return;
        const r=c.rect,m=c.area??c.monitor;
        if (save && (!r || r.width<1 || r.height<1)) return;
        let crop=null;
        if (save) {
            const x=Math.max(0,Math.round((r.x-m.x)*c.width/m.width)),y=Math.max(0,Math.round((r.y-m.y)*c.height/m.height));
            const right=Math.min(c.width,Math.round((r.x+r.width-m.x)*c.width/m.width));
            const bottom=Math.min(c.height,Math.round((r.y+r.height-m.y)*c.height/m.height));
            crop={x,y,width:right-x,height:bottom-y,reference_width:c.width,reference_height:c.height};
            if (crop.width<=0||crop.height<=0) return;
        }
        this._crop=null;
        c.window?.get_compositor_private()?.hide();
        if (this._cropWatch) Gio.bus_unwatch_name(this._cropWatch);this._cropWatch=null;
        this._cropGroup?.destroy();this._cropGroup=null;this._cropShades=null;this._cropBox=null;
        this._hideButton.visible=this._words.length>0;
        this._group.visible=!this._suspended&&this._controlVisible();
        // Release Shell key focus before returning input to the previous application.
        global.stage.set_key_focus(null);
        if ((!global.display.focus_window || global.display.focus_window === c.previousFocus || global.display.focus_window === c.window) && c.previousFocus?.get_compositor_private()) c.previousFocus.activate(global.get_current_time());
        this._bus?.emit_signal('CropResult',new GLib.Variant('(s)',[JSON.stringify({id:c.id,crop,reason:crop?'saved':reason})]));
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
        const [width,height]=this._hideButton.get_transformed_size();
        const panelVisible=this._hideButton.get_paint_visibility()&&Number.isFinite(width)&&Number.isFinite(height)&&width>0&&height>0;
        if(this._fallbackHide){
            const m=Main.layoutManager.primaryMonitor??Main.layoutManager.monitors[0];
            if(m)this._fallbackHide.set_position(m.x+m.width-140,m.y+m.height-48);
            this._fallbackHide.visible=this._hideButton.visible&&!panelVisible;
        }
        return panelVisible||Boolean(this._fallbackHide?.get_paint_visibility());
    }

    Status() {
        return JSON.stringify({controller:this._controller?{mode:this._controller.mode,rect:this._controller.rect,mapped:Boolean(this._controller.window)}:null,nativeShortcuts:true,protocol: 1, shell: '46', words: this._words.length,
            keyboardGrab: false, fullscreenInputSurface: Boolean(this._crop || this._pick), hideButton: this._hideButton?.visible ? (()=>{const b=this._fallbackHide?.get_paint_visibility()?this._fallbackHide:this._hideButton;return {position:b.get_transformed_position(),size:b.get_transformed_size(),floating:b===this._fallbackHide};})() : null, pointer: global.get_pointer(),
            sharedOverlay: true, windowPolicy: true,
            panels:[...(this._pins?.values()??[])].map(p=>({label:p.label,above:Boolean(p.window?.is_above()),mapped:Boolean(p.window)})),
            surface: this._surface ? {rect:this._surface.rect,sourceId:this._surface.sourceId,
                origin:this._surfaceState().origin,windowListHidden:this._passiveWindows?.has(this._surface.window)??false,visible:Boolean(this._surface.visible),mapped:Boolean(this._surface.window)} : null,
            painted: this._surface ? Boolean(this._surface.visible) : this._words.length > 0 && this._group.get_paint_visibility(),
            windowTracking: true, tracked: this._trackedStatus(), picking: Boolean(this._pick), pickWindows:this._pick ? global.get_window_actors().map(a=>a.meta_window).filter(w=>w.get_pid()!==this._pick.pid&&w.showing_on_its_workspace()&&!w.minimized).slice(-50).map(w=>{const r=w.get_frame_rect();return {title:w.get_title(),pid:w.get_pid(),bounds:{x:r.x,y:r.y,width:r.width,height:r.height}};}) : [], cropEditor: true, crop: this._crop ? this._crop.webview ? {id:this._crop.id,ui:'shared',backgroundSuppressed:Boolean(this._crop.backgroundSuppressed),opacity:this._crop.window?.get_compositor_private()?.opacity,monitor:this._crop.monitor,mapped:Boolean(this._crop.window),rect:this._crop.rect} : {id: this._crop.id, rect: this._crop.rect, dragging: Boolean(this._crop.drag), monitor: this._crop.monitor, save: {position:this._cropSave.get_transformed_position(),size:this._cropSave.get_transformed_size()}, cancel:{position:this._cropCancel.get_transformed_position(),size:this._cropCancel.get_transformed_size()}} : null,
            appearance: 'matched-word-highlight', matched: this._match ?? null, desktopPopup: true, revision: this.metadata.revision,
            ownPopup: this._nativePopup ? (() => { const r = this._nativePopup.get_frame_rect(); return {x: r.x, y: r.y, width: r.width, height: r.height, windowType: this._nativePopup.get_window_type(), overrideRedirect: this._nativePopup.is_override_redirect(), above: this._nativePopup.is_above(), visible: Boolean(this._nativePopup.get_compositor_private()?.get_paint_visibility())}; })() : null,
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
            if (!['screen','window'].includes(data.sourceKind) || !Array.isArray(data.words) || data.words.length > 500)
                throw new Error('Only bounded screen or linked GNOME window annotations are supported');
            const tracked=data.sourceKind==='window'?this._trackedStatus():null;
            if(data.sourceKind==='window'&&(!tracked||tracked.sourceId!==data.sourceId||this._tracked.owner!==sender||
                !data.referenceBounds||!['x','y','width','height'].every(k=>Number.isFinite(data.referenceBounds[k])&&Math.abs(data.referenceBounds[k]-tracked.bounds[k])<2)))
                throw new Error('Window annotations require the explicitly linked live source and current bounds');
            const monitors = Main.layoutManager.monitors;
            if(data.textRects!==undefined&&(!Array.isArray(data.textRects)||data.textRects.length>2000||
                !data.textRects.every(r=>['x','y','width','height'].every(k=>Number.isFinite(r[k])&&Math.abs(r[k])<=1000000)&&r.width>0&&r.height>0)))
                throw new Error('Invalid text coverage rectangles');
            if (data.sentences !== undefined && (!Array.isArray(data.sentences) || data.sentences.length > 500 ||
                !data.sentences.every(sentence => typeof sentence === 'string')))
                throw new Error('Invalid annotation sentences');
            const words = data.words.map(cell => {
                let w = cell;
                if (data.sentences !== undefined) {
                    const sentence = data.sentences[cell.sentenceId];
                    if (!Number.isInteger(cell.sentenceId) || typeof sentence !== 'string' ||
                        !Number.isInteger(cell.offset) || cell.offset < 0 || cell.offset >= sentence.length)
                        throw new Error('Invalid annotation text offset');
                    w = {...cell,sentence,text:sentence.slice(cell.offset,cell.offset+512).replace(/[\uD800-\uDBFF]$/u,'')};
                }
                if (![w.x, w.y, w.width, w.height].every(Number.isFinite) || w.width <= 0 || w.height <= 0 || typeof w.text !== 'string' || w.text.length > 512)
                    throw new Error('Invalid annotation');
                if (!monitors.some(m => w.x >= m.x && w.y >= m.y && w.x + w.width <= m.x + m.width && w.y + w.height <= m.y + m.height))
                    throw new Error('Annotation lies outside a monitor');
                return w;
            }).filter(w => {
                const primary = Main.layoutManager.primaryMonitor;
                return !primary || !Main.panel.get_paint_visibility() || w.x + w.width <= primary.x || w.x >= primary.x + primary.width || w.y >= primary.y + Main.panel.height || w.y + w.height <= primary.y;
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
            this._sourceKind=data.sourceKind;this._sourceId=data.sourceId;
            this._referenceBounds=data.referenceBounds;this._trackedVisible=data.sourceKind!=='window'||tracked.visible;
            this._baseWords=words.map(w=>({...w}));
            this._textRects=data.textRects??words;
            this._coverage={sourceId:data.sourceId,bounds:data.referenceBounds,rects:this._textRects};
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
            this._group.visible = !this._suspended && !this._surface && this._controlVisible();
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

    // A lease only for Kimochi's existing, non-focusable annotation WebView.
    // Shell owns desktop placement/visibility; the shared DOM renderer owns text,
    // layout, hover indicators and dictionary hit testing. No guessed glyph cells.
    SurfaceAsync([payload], invocation) {
        try {
            const sender = invocation.get_sender();
            if (payload.length > 4096) throw new Error('Surface request exceeds limit');
            const data = JSON.parse(payload);
            if (this._surface && this._surface.owner !== sender)
                throw new Error('Another client owns the annotation surface');
            if (data.operation === 'close') {
                this._finishSurface();
                invocation.return_value(new GLib.Variant('(s)', [JSON.stringify({closed:true})]));return;
            }
            if (data.operation !== 'open' || this._owner !== sender ||
                !['screen', 'window'].includes(data.sourceKind) || data.sourceId !== this._sourceId)
                throw new Error('Publish current source annotations before opening its surface');
            if (Main.layoutManager.monitors.length !== 1)
                throw new Error('Shared GNOME annotation surfaces currently require one monitor');
            const monitor = Main.layoutManager.monitors[0];
            if (data.sourceKind === 'screen' && !/^portal:display:[0-9]+$/.test(data.sourceId))
                throw new Error('Annotation surface requires a shared screen');
            if (data.sourceKind === 'window' && (this._sourceKind !== 'window' ||
                this._tracked?.owner !== sender || !this._trackedStatus()))
                throw new Error('Annotation surface requires a linked window');
            if (!this._surface) {
                const response = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                    'org.freedesktop.DBus', 'GetConnectionUnixProcessID', new GLib.Variant('(s)', [sender]),
                    new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, 1000, null);
                this._surface = {owner:sender,pid:response.deep_unpack()[0],previousFocus:global.display.focus_window};
            }
            Object.assign(this._surface, {sourceId:data.sourceId,sourceKind:data.sourceKind,
                rect:{x:monitor.x,y:monitor.y,width:monitor.width,height:monitor.height},updated:GLib.get_monotonic_time()});
            if (this._controller?.mode !== 'words') this._group.hide();
            this._syncSurface();
            invocation.return_value(new GLib.Variant('(s)', [JSON.stringify({rect:this._surfaceState().origin,visible:this._surfaceState().visible})]));
        } catch (e) { invocation.return_dbus_error(`${IFACE}.InvalidSurface`, e.message); }
    }

    _finishSurface() {
        this._surface?.window?.get_compositor_private()?.hide();
        this._surface = null;
        this._surfacePointer = null;
        this._surfacePointerTime = 0;
    }

    _surfaceState() {
        const s = this._surface;
        if (!s) return null;
        const tracked = s.sourceKind === 'window' ? this._trackedStatus() : null;
        const bounds = tracked?.bounds ?? s.rect;
        // Mutter may constrain a normal Wayland toplevel below the top panel.
        // All DOM, pointer and native input-region coordinates must use where
        // the surface actually mapped, rather than where we requested it.
        const frame=s.window?.get_frame_rect();
        const origin=frame?{x:frame.x,y:frame.y,width:frame.width,height:frame.height}:s.rect;
        const visible = !this._suspended && !this._crop && !this._pick &&
            !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter && !Main.overview.visible &&
            this._words.length > 0 && this._controlVisible() &&
            (s.sourceKind === 'screen' || tracked?.sourceId === s.sourceId && this._trackedVisible);
        return {origin,bounds,visible:Boolean(visible)};
    }

    _syncSurface() {
        const s = this._surface;if (!s) return;
        if (GLib.get_monotonic_time() - s.updated > 5000000) { this._clear('surface-timeout');return; }
        const win = global.get_window_actors().map(a => a.meta_window).find(w =>
            w.get_pid() === s.pid && w.get_title() === 'Kimochi · overlay');
        if (win && win !== s.window) {
            s.window = win;
            this._hideFromWindowLists(win);
            s.placementKey = null;
            const actor = win.get_compositor_private();
            Main.wm.skipNextEffect(actor);
            actor.remove_all_transitions();actor.set_scale(1,1);actor.set_translation(0,0,0);
        }
        const actor = s.window?.get_compositor_private();
        if (actor) {
            const r=s.rect,key=JSON.stringify(r);
            if (s.placementKey!==key) {
                s.placementKey=key;
                const current=s.window.get_frame_rect();
                if (['x','y','width','height'].some(k=>Math.abs(current[k]-r[k])>=1))
                    s.window.move_resize_frame(false,r.x,r.y,r.width,r.height);
            }
        }
        const state = this._surfaceState();
        s.visible = Boolean(state.visible && actor);
        if (actor) {
            // 254 prevents Mutter's opaque-window culling from discarding the
            // game behind a full-monitor transparent surface (as in crop mode).
            actor.opacity = 254;
            actor.visible = s.visible;
            if (s.visible && !s.window.is_above() && !s.window.is_override_redirect()) s.window.make_above();
        }
        const [x,y,mods] = global.get_pointer();
        const popup = this._nativePopup?.get_compositor_private()?.get_paint_visibility() ? this._nativePopup.get_frame_rect() : null;
        const blocked = Boolean(popup && x >= popup.x && y >= popup.y && x < popup.x+popup.width && y < popup.y+popup.height || this._controller);
        const pointer = {...state,sourceId:s.sourceId,x,y,over:s.visible,blocked,down:Boolean(mods&Clutter.ModifierType.BUTTON1_MASK),
            shift:Boolean(mods&Clutter.ModifierType.SHIFT_MASK),ctrl:Boolean(mods&Clutter.ModifierType.CONTROL_MASK),
            alt:Boolean(mods&Clutter.ModifierType.MOD1_MASK),meta:Boolean(mods&Clutter.ModifierType.SUPER_MASK)};
        const signature = JSON.stringify(pointer);
        if (signature !== this._surfacePointer || s.visible && GLib.get_monotonic_time() - (this._surfacePointerTime ?? 0) >= 100000) {
            this._surfacePointerTime = GLib.get_monotonic_time();
            this._surfacePointer = signature;
            this._bus.emit_signal('Pointer',new GLib.Variant('(s)',[signature]));
        }
    }

    // Only Kimochi's own process windows; never a portal window or foreign client.
    OwnWindowAsync([payload], invocation) {
        try {
            if (payload.length > 4096) throw new Error('Window request exceeds limit');
            const data = JSON.parse(payload);
            if (![...ORDINARY, 'popup-host', 'crop-host','controller-host', 'overlay'].includes(data.label)) throw new Error('Unsupported own window');
            const response = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                new GLib.Variant('(s)', [invocation.get_sender()]), new GLib.VariantType('(u)'),
                Gio.DBusCallFlags.NONE, 1000, null);
            const [pid] = response.deep_unpack();
            const win = global.get_window_actors().map(a => a.meta_window)
                .find(w => w.get_pid() === pid && w.get_title() === `Kimochi · ${data.label}`);
            if(data.pinned!==undefined){
                if(!ORDINARY.includes(data.label)||typeof data.pinned!=='boolean')throw new Error('Only ordinary own panels may be pinned');
                const owner=invocation.get_sender(),key=`${owner}:${data.label}`;
                if(!data.pinned)this._dropPin(key);
                if(data.pinned){
                    if(!this._pins.has(key)){
                        const pin={owner,pid,label:data.label,window:win,originalAbove:Boolean(win?.is_above())};
                        pin.watch=Gio.bus_watch_name_on_connection(Gio.DBus.session,owner,Gio.BusNameWatcherFlags.NONE,null,()=>this._dropPin(key));
                        this._pins.set(key,pin);
                    }
                    this._syncPins();
                }else if(win?.is_above())win.unmake_above();
                invocation.return_value(new GLib.Variant('(s)',[JSON.stringify({pinned:data.pinned,pending:!win})]));return;
            }
            if (data.label === 'overlay') {
                if (!this._surface || this._surface.owner !== invocation.get_sender())
                    throw new Error('Annotation surface requires an active owner lease');
                if (!win) throw new Error('Annotation surface is not mapped yet');
                const r = this._surfaceState().origin;
                invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(r)]));return;
            }
            if(data.label==='controller-host') {
                const c=this._controller;
                if(!c||c.owner!==invocation.get_sender())throw new Error('Controller window requires an active owner lease');
                if(!win)throw new Error('Controller window is not mapped yet');
                c.window=win;
                Main.wm.skipNextEffect(win.get_compositor_private());
                win.make_above();win.move_resize_frame(false,c.rect.x,c.rect.y,c.rect.width,c.rect.height);
                win.activate(global.get_current_time());
                invocation.return_value(new GLib.Variant('(s)',[JSON.stringify({ok:true})]));return;
            }
            if(data.label==='crop-host') {
                const c=this._crop;
                if(!c?.webview||c.owner!==invocation.get_sender())throw new Error('Crop window requires an active owner lease');
                if(!win)throw new Error('Crop window is not mapped yet');
                c.window=win;
                const actor=win.get_compositor_private();
                actor.remove_all_transitions();actor.set_pivot_point(0,0);actor.set_scale(1,1);actor.set_translation(0,0,0);actor.opacity=0;
                Main.wm.skipNextEffect(actor);
                win.make_fullscreen();win.make_above();win.move_resize_frame(false,c.monitor.x,c.monitor.y,c.monitor.width,c.monitor.height);
                win.get_compositor_private()?.show();this._transparentCrop();win.activate(global.get_current_time());
                invocation.return_value(new GLib.Variant('(s)',[JSON.stringify({ok:true})]));return;
            }
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
            invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(r ? {x: r.x, y: r.y, width: r.width, height: r.height,pinned:win.is_above()} : {pending: true})]));
        } catch (e) { invocation.return_dbus_error(`${IFACE}.InvalidOwnWindow`, e.message); }
    }

    _syncPins() {
        for(const p of this._pins?.values()??[]){
            const win=global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_pid()===p.pid&&w.get_title()===`Kimochi · ${p.label}`);
            p.window=win;
            if(win?.get_compositor_private()?.get_paint_visibility()&&!win.is_above()&&!win.is_override_redirect())win.make_above();
        }
    }

    // GNOME46 has no public setter for a pre-existing Wayland client's native
    // skip-taskbar flag. Filter only the validated passive MetaWindow at the
    // Shell boundary; do not alter Mutter, the dock extension, or other apps.
    // NEVER notify skip-taskbar here: GNOME46's native handler adjusts its
    // interesting-window counter for every notification, even when the native
    // flag did not change. False notifications can leave RUNNING with freed
    // running_state and crash shell_app_compare after the last window closes.
    _hideFromWindowLists(win) {
        if(this._passiveWindows?.has(win))return;
        this._passiveWindows??=new Map();this._passiveApps??=new Map();
        const saved=new Map();
        for(const key of ['skip_taskbar','skipTaskbar']){
            saved.set(key,Object.getOwnPropertyDescriptor(win,key));
            Object.defineProperty(win,key,{configurable:true,get:()=>true});
        }
        const app=Shell.WindowTracker.get_default().get_window_app(win);
        if(app&&!this._passiveApps.has(app)){
            const descriptor=Object.getOwnPropertyDescriptor(app,'get_windows'),original=app.get_windows;
            const hidden=this._passiveWindows;
            const replacement=function(...args){return original.apply(this,args).filter(w=>!hidden.has(w));};
            Object.defineProperty(app,'get_windows',{configurable:true,writable:true,value:replacement});
            this._passiveApps.set(app,{descriptor,original,replacement});
        }
        const signal=win.connect('unmanaged',()=>this._restoreWindowLists(win));
        this._passiveWindows.set(win,{saved,app,signal});
    }

    _restoreWindowLists(win) {
        const p=this._passiveWindows?.get(win);if(!p)return;
        this._passiveWindows.delete(win);win.disconnect(p.signal);
        for(const [key,descriptor]of p.saved){if(descriptor)Object.defineProperty(win,key,descriptor);else delete win[key];}
        if(p.app&&![...this._passiveWindows.values()].some(w=>w.app===p.app)){
            const a=this._passiveApps.get(p.app);
            if(p.app.get_windows===a.replacement){if(a.descriptor)Object.defineProperty(p.app,'get_windows',a.descriptor);else delete p.app.get_windows;}
            this._passiveApps.delete(p.app);
        }
    }

    _dropPin(key) {
        const p=this._pins?.get(key);if(!p)return;
        if(p.watch)Gio.bus_unwatch_name(p.watch);
        if(!p.originalAbove&&p.window?.get_compositor_private()&&p.window.is_above())p.window.unmake_above();
        this._pins.delete(key);
    }

    _placePopup(win, r) {
        this._nativePopup = win;
        // Placement is requested before GTK maps the surface. Mutter cannot
        // raise an unstacked window, and repeated raises disturb game focus.
        if (win.get_compositor_private()?.get_paint_visibility() &&
            !win.is_override_redirect() && !win.is_above()) win.make_above();
        const current = win.get_frame_rect();
        if (current.x !== Math.round(r.x) || current.y !== Math.round(r.y))
            win.move_frame(false, Math.round(r.x), Math.round(r.y));
        this._watchPopupButtons();
    }

    SuspendAsync([on], invocation) {
        if (this._controller) { invocation.return_dbus_error(`${IFACE}.Busy`, 'Close controller navigation before capturing'); return; }
        if (this._crop) { invocation.return_dbus_error(`${IFACE}.Busy`, 'Finish crop editing before capturing'); return; }
        if (this._owner && this._owner !== invocation.get_sender()) {
            invocation.return_dbus_error(`${IFACE}.NotOwner`, 'Only the annotation owner may suppress annotations');
            return;
        }
        const hadAnnotations = this._words.length > 0 || Boolean(this._nativePopup?.get_compositor_private()?.visible);
        this._suspended = on;
        this._group.visible = !on && !this._surface && this._controlVisible();
        this._syncSurface();
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
        this._finishSurface();
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
        this._baseWords=[];this._textRects=[];this._sourceKind=null;this._referenceBounds=null;
        if(!this._crop&&!this._pick){this._hideButton?.hide();this._fallbackHide?.hide();}
        this._owner = null;
        this._lastUpdate = 0;
        this._lastLookup = null;
        this._hoverIndex = -1;
        this._match = null;
    }

    disable() {
        for(const win of this._passiveWindows?.keys()??[])this._restoreWindowLists(win);
        for(const key of this._pins?.keys()??[])this._dropPin(key);
        this._finishController();
        this._clearShortcuts();
        if(this._acceleratorSignal)global.display.disconnect(this._acceleratorSignal);this._acceleratorSignal=null;
        this._finishPick(null,'disabled');this._forgetTracked();
        this._finishCrop(false, 'disabled');
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
        this._fallbackHide?.destroy();this._fallbackHide=null;
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
