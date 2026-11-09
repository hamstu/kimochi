// voicehook web adapter: injected into an NW.js game's pages (manifest `inject_js_end`).
// Reports every sound the page starts, with its URL, and copies the original file (decrypted
// for RPG Maker's .rpgmvo/.ogg_) into the capture folder, in the same events.jsonl + clips/
// format as the native hook. NW.js pages have Node (`require`), so it writes the files itself.
//
// Hooks, each installed once its target exists (polled, since engines load scripts late):
// - RPG Maker MV/MZ `WebAudio.prototype.play` / `stop` (BGM, BGS, ME, SE, and voice plugins)
// - howler.js `Howl.prototype.play` (TyranoScript and many others)
// - `HTMLMediaElement.prototype.play` (plain <audio>)
(function () {
  'use strict';
  var OUT = '__VOICEHOOK_OUT__';
  if (window.__voicehook) return;
  window.__voicehook = true;
  var req = (typeof require === 'function') ? require : (typeof nw !== 'undefined' && nw.require);
  if (!req) return;
  var fs = req('fs'), path = req('path');
  var clipsDir = path.join(OUT, 'clips');
  try { fs.mkdirSync(clipsDir, { recursive: true }); } catch {}
  var eventsFile = path.join(OUT, 'events.jsonl');
  var streams = {}, nextStream = 1, seq = 0;
  var seqFile = path.join(OUT, '.web-seq');
  try { var st = JSON.parse(fs.readFileSync(seqFile, 'utf8')); seq = st.seq; nextStream = st.next; } catch {}

  function write(ev) {
    if (ev.t === undefined) ev.t = Date.now();
    try { fs.appendFileSync(eventsFile, JSON.stringify(ev) + '\n'); } catch {}
  }
  function save() { try { fs.writeFileSync(seqFile, JSON.stringify({ seq: seq, next: nextStream })); } catch {} }

  function stream(channel) {
    if (!streams[channel]) {
      streams[channel] = nextStream++;
      write({ ev: 'stream', s: streams[channel], api: 'web', ptr: channel, fmt: null, info: { channel: channel } });
      save();
    }
    return streams[channel];
  }

  // The app's root folder: where package.json is.
  var roots = [];
  try { roots.push(path.dirname(process.mainModule.filename)); } catch {}
  try { roots.push(process.cwd()); } catch {}
  try { roots.push(path.dirname(process.execPath)); } catch {}

  // RPG Maker keeps the plain name (.ogg/.m4a) in the URL and loads the encrypted file.
  function variants(p) {
    var v = [p];
    if (/\.ogg$/i.test(p)) v.push(p.replace(/\.ogg$/i, '.rpgmvo'), p + '_');
    if (/\.m4a$/i.test(p)) v.push(p.replace(/\.m4a$/i, '.rpgmvm'), p + '_');
    return v;
  }

  function firstExisting(p) {
    var v = variants(p);
    for (var i = 0; i < v.length; i++) if (fs.existsSync(v[i])) return v[i];
    return null;
  }

  function toPath(url) {
    var u;
    try { u = new URL(url, location.href); } catch { return null; }
    var p = decodeURIComponent(u.pathname);
    if (u.protocol === 'file:') return firstExisting(p.replace(/^\/([A-Za-z]:)/, '$1'));
    for (var i = 0; i < roots.length; i++) {
      var c = firstExisting(path.join(roots[i], p));
      if (c) return c;
    }
    return null;
  }

  function hex2bytes(h) {
    var out = [];
    for (var i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
    return out;
  }

  // RPG Maker encrypted audio: a 16-byte header, then the file with its first 16 bytes XORed.
  function decrypt(buf, file) {
    if (!/\.(rpgmvo|rpgmvm|ogg_|m4a_)$/i.test(file) || buf.length < 32) return { data: buf, ext: null };
    var key = null;
    try { key = hex2bytes(window.$dataSystem.encryptionKey); } catch {}
    var data = Buffer.from(buf.slice(16));
    if (key && key.length >= 16) for (var i = 0; i < 16; i++) data[i] ^= key[i];
    var ext = /rpgmvm|m4a_/i.test(file) ? 'm4a' : 'ogg';
    return { data: data, ext: ext };
  }

  function sniff(b) {
    var s = b.slice(0, 4).toString('latin1');
    if (s === 'OggS') return b.slice(0, 200).toString('latin1').indexOf('OpusHead') >= 0 ? 'opus' : 'ogg';
    if (s === 'RIFF') return 'wav';
    if (s === 'fLaC') return 'flac';
    if (s.substr(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
    if (b.slice(4, 8).toString('latin1') === 'ftyp') return 'm4a';
    return null;
  }

  // Length of an Ogg Vorbis/Opus file from its last page's granule position.
  function oggDur(b) {
    try {
      if (b.slice(0, 4).toString('latin1') !== 'OggS') return 0;
      var head = b.slice(0, 4096).toString('latin1');
      var rate, preskip = 0, i = head.indexOf('OpusHead');
      if (i >= 0) { rate = 48000; preskip = b.readUInt16LE(i + 10); }
      else { i = head.indexOf('\x01vorbis'); if (i < 0) return 0; rate = b.readUInt32LE(i + 12); }
      for (var p = b.length - 14; p >= Math.max(0, b.length - 65536); p--) {
        if (b[p] === 0x4f && b[p + 1] === 0x67 && b[p + 2] === 0x67 && b[p + 3] === 0x53) {
          var g = b.readUInt32LE(p + 6) + b.readUInt32LE(p + 10) * 4294967296;
          return rate > 0 ? Math.max(0, (g - preskip) / rate) : 0;
        }
      }
    } catch {}
    return 0;
  }

  function stem(p) {
    var b = p.split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
    return b.replace(/[^A-Za-z0-9_\-぀-ヿ一-鿿]/g, '_').slice(0, 40);
  }

  var last = {}, copied = {};
  function report(channel, url, info) {
    try {
      var now = Date.now();
      var k = channel + '|' + url;
      if (last[k] && now - last[k] < 1500) return; // MV calls play() again once the file has loaded
      last[k] = now;
      var s = stream(channel);
      var file = toPath(url);
      var rel = url;
      try { rel = decodeURIComponent(new URL(url, location.href).pathname).replace(/^\/+/, ''); } catch {}
      seq++;
      var out = null, bytes = 0, fmt = null;
      var again = file && copied[file];
      if (again) {
        // Played before (a looping track, a replayed voice): point at the first copy.
        out = again.out; bytes = again.bytes; fmt = again.fmt;
        info.replay = true;
        if (!info.dur) info.dur = again.dur;
      } else if (file) {
        var raw = fs.readFileSync(file);
        var d = decrypt(raw, file);
        fmt = sniff(d.data) || d.ext || (file.split('.').pop() || 'bin').toLowerCase();
        var name = ('0000' + seq).slice(-5) + '_web_s' + s + '_' + stem(file) + '.' + fmt;
        fs.writeFileSync(path.join(clipsDir, name), d.data);
        out = 'clips/' + name;
        bytes = d.data.length;
        if (!info.dur) info.dur = oggDur(d.data);
        copied[file] = { out: out, bytes: bytes, fmt: fmt, dur: info.dur };
      }
      save();
      write({
        ev: 'clip', t: now, seq: seq, s: s, api: 'web', why: 'whole', start: now, data_at: now,
        dur: info.dur || 0, bytes: bytes, looping: !!info.loop, played: true, peak: null, rms: null,
        silent: false, fmt: fmt, file: out, source: rel, meta: info,
      });
    } catch (e) {
      write({ ev: 'web_error', what: String(e && e.stack || e) });
    }
  }

  // Which RPG Maker folder (bgm/bgs/me/se/voice) a URL is in: the stream for it.
  function rpgChannel(url) {
    var m = /audio\/([^/]+)\//.exec(url);
    return m ? 'rpgm:' + m[1] : 'rpgm';
  }

  var installed = {};
  function hookRpgMaker() {
    if (installed.rpgm || typeof WebAudio !== 'function' || !WebAudio.prototype.play) return;
    installed.rpgm = true;
    var play = WebAudio.prototype.play, stop = WebAudio.prototype.stop;
    WebAudio.prototype.play = function (loop, offset) {
      try {
        if (this._url) report(rpgChannel(this._url), this._url, { engine: 'rpgmaker', loop: !!loop, offset: offset || 0, dur: this._totalTime || 0 });
      } catch {}
      return play.apply(this, arguments);
    };
    WebAudio.prototype.stop = function () {
      try { if (this._url && this.isPlaying && this.isPlaying()) write({ ev: 'web_stop', s: stream(rpgChannel(this._url)), source: this._url }); } catch {}
      return stop.apply(this, arguments);
    };
    write({ ev: 'adapter', adapter: 'web', hook: 'rpgmaker WebAudio' });
  }

  function hookHowler() {
    if (installed.howl || typeof Howl !== 'function' || !Howl.prototype.play) return;
    installed.howl = true;
    var play = Howl.prototype.play;
    Howl.prototype.play = function (sprite) {
      try {
        var src = this._src;
        if (Array.isArray(src)) src = src[0];
        if (typeof src === 'string' && src.indexOf('data:') !== 0) report('howl', src, { engine: 'howler', loop: !!this._loop, dur: this._duration || 0, sprite: typeof sprite === 'string' ? sprite : null });
      } catch {}
      return play.apply(this, arguments);
    };
    write({ ev: 'adapter', adapter: 'web', hook: 'howler' });
  }

  function hookMedia() {
    if (installed.media) return;
    installed.media = true;
    var play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try {
        var src = this.currentSrc || this.src;
        if (src && src.indexOf('blob:') !== 0 && src.indexOf('data:') !== 0 && !(this instanceof HTMLVideoElement)) {
          report('media', src, { engine: 'html5', loop: !!this.loop, dur: isFinite(this.duration) ? this.duration : 0 });
        }
      } catch {}
      return play.apply(this, arguments);
    };
  }

  hookMedia();
  write({ ev: 'adapter', adapter: 'web', page: location.href });
  var tries = 0;
  var timer = setInterval(function () {
    hookRpgMaker();
    hookHowler();
    if (++tries > 600 || (installed.rpgm && installed.howl)) clearInterval(timer);
  }, 100);
})();
