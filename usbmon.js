/* usbmon.js - tarayicidan karta dogrudan baglanti (USB seri, Mac'siz).
 *
 * mon.py'nin yaptigini yapar: 'ax' / 'pose' / gerilim yoklamasi, olay
 * satirlari, sesli uyarilar, kontrol tuslarinin komutlari. state() nesnesi
 * mon_state.json ile ayni bicimde: index.html iki kaynagi da ayni cizer.
 *
 * Masaustu Chrome/Edge: Web Serial (navigator.serial).
 * Android Chrome: WebUSB uzerinden Google web-serial-polyfill
 *   (vendor/serial-polyfill.js) - ST-LINK'in sanal seri portu (CDC-ACM).
 * Guvenli baglam gerekir: https ya da http://localhost.
 *
 * Kart konsolu FIFO'suz ve yoklamali: karakterler 4 ms arayla gonderilir.
 */
(function () {
"use strict";

const ROW  = /^\s*(\d+)\s(CSP|CSV)\s\s(.{17})\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+)\s+0x([0-9A-Fa-f]{4})\s*(.*)$/;
const LOOP = /Dongu:\s*(\S+),\s*(\d+)\s*cevrim/;
const GEN  = /Dugum\s+(\d+)\s+0x([0-9A-Fa-f]{4}):([0-9A-Fa-f]{2})\s*=\s*0x[0-9A-Fa-f]+\s+\((\d+)\)/;
const POSE = /@POSE\s+(.*)$/;
const EMCY = /\[EMCY\]\s*Dugum\s*(\d+)/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
/* 'joy' ekran satiri: "    RX  22589  1.137 V   -109  KABLO?" */
const JOY = /\b(LX|LY|LZ|RX|RY|RZ)\s+(\d+)\s+([\d.]+) V\s+([+-]?\d+)[ \t]*(KABLO\?)?/g;
const JOY_NAME = {     /* X = sag-sol, Y = ileri-geri, Z = burgu; eklem modunda surdugu eklem */
  LX: "sol çubuk sağ-sol (J1)", LY: "sol çubuk ileri-geri (J2)", LZ: "sol çubuk burgu (J3)",
  RX: "sağ çubuk sağ-sol (J4)", RY: "sağ çubuk ileri-geri (J5)", RZ: "sağ çubuk burgu (J6)" };
const JOY_SAY = { LX: "sol çubuk sağ sol", LY: "sol çubuk ileri geri", LZ: "sol çubuk burgu",
                  RX: "sağ çubuk sağ sol", RY: "sağ çubuk ileri geri", RZ: "sağ çubuk burgu" };

const PERIOD = 250, POSE_PERIOD = 500, VOLT_PERIOD = 500;      /* ms */
const PERIODIC = [[1, 0x6079, 0], [7, 0x6079, 0], [2, 0x2014, 2]];
const T_WARN = 800, T_OVER = 1000, SUSTAIN = 1000, V_WARN = 20000;
const SURUM = "08.11.2026 15:13";                                           /* yayinla.sh damgalar */
const ST_VID = 0x0483;                                          /* STMicroelectronics (ST-LINK) */
const ACTIONS = {
  panel_kapat: ["panel off"],
  fren:  [1, 2, 3, 4, 5, 6, 7].map(n => "disable " + n),
  reset: [1, 2, 3, 4, 5, 6, 7].map(n => "reset " + n),
};
const BRAKE_STR = { 0: "KAPALI (fren tutuyor)", 1: "20V acma", 2: "7V tutma (acik)" };

const sleep = ms => new Promise(r => setTimeout(r, ms));
function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

/* Sesli uyari: ayni mesaj 'every' saniyede bir, tek seferde tek konusma */
class Speaker {
  constructor() { this.last = {}; this.on = "speechSynthesis" in window; }
  say(text, key, every) {
    if (!this.on) return;
    key = key || text; every = (every || 10) * 1000;
    const now = Date.now();
    if (now - (this.last[key] || 0) < every) return;
    this.last[key] = now;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "tr-TR"; u.rate = 1.1;
      const v = speechSynthesis.getVoices().find(x => /^tr/i.test(x.lang));
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch (e) { /* ses yok - sessiz devam */ }
  }
}

class UsbMon {
  constructor() {
    this.spk = new Speaker();
    this.port = null; this.reader = null; this.writer = null;
    this.connected = false;
    this.pending = [];          /* arayuz tuslarindan gelen komutlar */
    this.collecting = false; this.resp = ""; this.lineBuf = "";
    this.usbDev = null;         /* WebUSB cihazi (polyfill) - kopma olayini ayirt etmek icin */
    this.lastErr = ""; this.retryErr = ""; this.drops = 0; this.retry = null; this.userClosed = false;
    this.reset();
  }

  reset() {
    this.rows = {}; this.latest = {}; this.loop = "?"; this.samples = 0; this.t = 0;
    this.prevState = {}; this.warnSince = {}; this.overSince = {};
    this.peak = {}; for (let n = 1; n <= 7; n++) this.peak[n] = 0;
    this.volt = {}; this.voltMin = {}; this.brake = {}; this.voltI = 0;
    this.kin = null; this.poseOk = true; this.rebootedAt = 0;
    this.panel = { on: null, mode: null, enable: null };
    this.recent = [];
    this.joyCheck = false;      /* Enable joystik yuzunden reddedildi: 'joy' ile hangisi oku */
    this.enableBlock = null;    /* {t, text}: arayuzde gosterilen red sebebi */
  }

  static supported() {
    return !!window.SAHTE_SERIAL || (window.isSecureContext && !!(navigator.serial || navigator.usb));
  }

  async api() {
    if (window.SAHTE_SERIAL) { this.yol = "sahte kart"; return window.SAHTE_SERIAL; }   /* test: ?sahte=1 */
    /* Yerlesik Web Serial: masaustu Chrome 89+, Android Chrome 148+ (2026).
     * Yoksa (eski Android Chrome) WebUSB uzerinden yamali kutuphane.
     * Adrese ?webusb=1 eklenirse yerlesik olsa da kutuphane kullanilir. */
    const forceUsb = /[?&]webusb=1/.test(location.search);
    if (navigator.serial && !forceUsb) { this.yol = "yerleşik seri port"; return navigator.serial; }
    if (navigator.usb) {
      const mod = await import("./vendor/serial-polyfill.js");
      this.yama = mod.YEREL_YAMA || 0;
      this.yol = "WebUSB kütüphanesi (yama " + this.yama + ")";
      return mod.serial;
    }
    throw new Error("Bu tarayıcı USB seri bağlantıyı desteklemiyor — Chrome'u güncelleyin.");
  }

  /* ask=true: cihaz secme penceresi (kullanici tiklamasi gerekir).
   * ask=false: daha once izin verilmis porta sessizce baglan. */
  async connect(ask) {
    if (this.connected) return true;
    /* kart takilinca birden cok yer (usb/serial 'connect' olayi, 2 s deneme)
     * ayni anda baglanmak isteyebilir: suren deneme varsa onu bekle */
    if (this.connecting && !ask) return this.connecting;
    const p = this.connectOnce(ask);
    this.connecting = p;
    try { return await p; } finally { if (this.connecting === p) this.connecting = null; }
  }

  async connectOnce(ask) {
    const api = await this.api();
    let port = null;
    if (ask) {
      port = await api.requestPort({ filters: [{ usbVendorId: ST_VID }] });
    } else {
      const ports = await api.getPorts();
      port = ports.find(p => { try { return p.getInfo().usbVendorId === ST_VID; } catch (e) { return true; } }) || null;
      if (!port) return false;
    }
    await port.open({ baudRate: 115200, bufferSize: 4096 });
    this.port = port;
    this.usbDev = port.device_ || null;
    this.userClosed = false;
    if (this.retry) { clearInterval(this.retry); this.retry = null; }
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.connected = true; this.connectedAt = Date.now();
    this.event("[izleyici] baglandi (" + this.yol + ")");
    this.readLoop();
    this.mainLoop();
    return true;
  }

  /* navigator.usb / navigator.serial 'disconnect' olayi: yalniz bizim kart */
  onDeviceGone(evt) {
    if (!this.connected) return;
    if (evt && evt.device && this.usbDev && evt.device !== this.usbDev) return;   /* baska USB cihazi */
    if (evt && evt.target && evt.target !== navigator.serial && evt.target !== this.port &&
        !evt.device) return;
    this.disconnect("kablo çıktı ya da kart yeniden başladı");
  }

  async disconnect(why) {
    if (!this.connected && !this.port) return;
    this.connected = false;
    this.drops++;
    const dur = this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) : 0;
    this.lastErr = (why || "") + " [" + dur + " s bağlı kaldı]"; this.retryErr = "";
    this.panel = { on: null, mode: null, enable: null };
    try { await this.reader.cancel(); } catch (e) {}
    try { this.reader.releaseLock(); } catch (e) {}
    try { this.writer.releaseLock(); } catch (e) {}
    try { await this.port.close(); } catch (e) {}
    this.port = null;
    this.event("[izleyici] baglanti kesildi" + (why ? " (" + why + ")" : ""));
    this.spk.say("Seri bağlantı koptu", null, 20);
    /* izin verilmis karta 2 s'de bir sessizce yeniden baglanmayi dene */
    if (!this.userClosed && !this.retry) {
      this.retry = setInterval(async () => {
        if (this.connected) { clearInterval(this.retry); this.retry = null; return; }
        try {
          if (await this.connect(false)) this.event("[izleyici] yeniden baglandi (" + this.drops + ". kopmadan sonra)");
          else this.retryErr = "kart USB'de görünmüyor — tablet USB gücünü kesmiş olabilir; kabloyu çıkarıp takın";
        } catch (e) { this.retryErr = String(e.message || e); }
      }, 2000);
    }
  }

  /* ---------------------------------------------------------- okuma/yazma */
  async readLoop() {
    const dec = new TextDecoder("ascii");
    try {
      while (this.connected) {
        const { value, done } = await this.reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        if (this.collecting) {
          this.resp += text;
        } else {
          this.lineBuf += text;
          let i;
          while ((i = this.lineBuf.indexOf("\n")) >= 0) {
            this.handleLine(this.lineBuf.slice(0, i));
            this.lineBuf = this.lineBuf.slice(i + 1);
          }
          if (this.lineBuf.length > 4096) this.lineBuf = "";
        }
      }
    } catch (e) {
      if (this.connected) this.disconnect(String(e.message || e));
    }
  }

  async writeSlow(s) {
    const enc = new TextEncoder();
    for (const ch of s) {
      await this.writer.write(enc.encode(ch));
      await sleep(4);
    }
  }

  /* Komut gonder, istem ("> ") gelip 50 ms sessiz kalana kadar yaniti topla */
  async cmd(s, timeout) {
    timeout = timeout || 3000;
    if (this.lineBuf) { this.handleLine(this.lineBuf); this.lineBuf = ""; }
    this.resp = ""; this.collecting = true;
    try {
      await this.writeSlow(s + "\r");
      const t0 = Date.now();
      let quietFrom = 0, lastLen = -1;
      while (Date.now() - t0 < timeout && this.connected) {
        await sleep(10);
        if (this.resp.endsWith("> ")) {
          if (this.resp.length !== lastLen) { lastLen = this.resp.length; quietFrom = Date.now(); }
          else if (Date.now() - quietFrom >= 50) break;
        } else { lastLen = -1; }
      }
    } finally { this.collecting = false; }
    return this.resp.replace(/\r/g, "");
  }

  respLines(resp, c) {
    return resp.split("\n").map(l => l.replace(ANSI, "").replace(/^(> )+/, "").trim())
      .filter(l => l && l !== ">" && l !== c);
  }

  /* ---------------------------------------------------------- ana dongu */
  async mainLoop() {
    try {
      await this.writeSlow("\x03"); await sleep(200);        /* yarim satiri temizle */
      this.collecting = false; this.lineBuf = "";
      for (const [n, idx, sub] of [[2, 0x2014, 2]]) await this.readObj(n, idx, sub);
      let nextPoll = 0, nextPose = 0, nextVolt = 0;
      while (this.connected) {
        const now = Date.now();
        if (this.pending.length) {
          const c = this.pending.shift();
          this.event("[izleyici] komut gonderiliyor: " + c);
          const r = await this.cmd(c, c.startsWith("config") ? 25000 : 3000);
          for (const l of this.respLines(r, c)) { this.track(l); this.event("    " + l); }
          nextPoll = 0;
          continue;
        }
        if (this.joyCheck) { this.joyCheck = false; await this.checkJoy(); continue; }
        if (now >= nextVolt) { await this.readVolt(); nextVolt = Date.now() + VOLT_PERIOD; continue; }
        if (this.poseOk && now >= nextPose) { await this.readPose(); nextPose = Date.now() + POSE_PERIOD; continue; }
        if (now >= nextPoll) {
          const r = await this.cmd("ax", 1500);
          this.rows = {};
          for (const l of r.split("\n")) this.handleLine(l);
          nextPoll = Date.now() + PERIOD;
          continue;
        }
        await sleep(15);
      }
    } catch (e) {
      if (this.connected) this.disconnect(String(e.message || e));
    }
  }

  /* Enable "joystickler notrde degil" diye reddedildi: 'joy' canli ekranini
   * kisa sure oku (150 ms'de bir yenilenir), bir tusla cik, nötrde olmayan ya
   * da kablo arizasi gosteren eksenleri arayuze ve sesli uyariya ver. */
  async checkJoy() {
    if (this.lineBuf) { this.handleLine(this.lineBuf); this.lineBuf = ""; }
    this.resp = ""; this.collecting = true;
    let r = "";
    try {
      await this.writeSlow("joy\r");
      await sleep(600);
      await this.writeSlow(" ");                       /* canli ekrandan cik */
      const t0 = Date.now();
      while (Date.now() - t0 < 1000 && this.connected && !this.resp.endsWith("> ")) await sleep(10);
      await sleep(60);
    } finally { this.collecting = false; r = this.resp; }
    const last = {};
    for (const m of r.replace(ANSI, "").matchAll(JOY)) last[m[1]] = { v: +m[3], n: +m[4], kablo: !!m[5] };
    if (!Object.keys(last).length) {
      this.setBlock("Enable reddedildi: joystickler nötrde değil (değerler okunamadı — çubukları bırakıp Enable'ı kapatıp açın).");
      return;
    }
    const bad = Object.keys(JOY_NAME).filter(k => last[k] && (last[k].n !== 0 || last[k].kablo));
    if (!bad.length) {
      this.setBlock("Enable reddedildi ama şu an bütün çubuklar ortada — reddedildiği anda bir çubuk oynuyordu. " +
                    "Çubuklara dokunmadan Enable'ı kapatıp açın.");
      this.spk.say("Çubuklar şimdi ortada, Enable'ı kapatıp açın", null, 5);
      return;
    }
    const parts = bad.map(k => {
      const j = last[k];
      const volt = j.v.toFixed(2).replace(".", ",") + " V; ortası ≈1,65 V";
      return k + " — " + JOY_NAME[k] + (j.kablo ? ": KABLO ARIZASI olabilir (" + volt + ")"
                                                : ": ortada değil (" + (j.n > 0 ? "+" : "") + j.n + ", " + volt + ")");
    });
    const cable = bad.some(k => last[k].kablo);
    this.setBlock("Enable reddedildi: " + parts.join(" · ") + ". " +
                  (cable ? "Kablo/konnektörü kontrol edin; çubuk ortada 0,5 s kalınca arıza kalkar. "
                         : "Çubuğu oynatıp bırakın (burguysa çevirip bırakın). ") +
                  "Sonra Enable'ı kapatıp açın.");
    this.spk.say("Enable reddedildi. " + bad.map(k => JOY_SAY[k]).join(", ") + (cable ? " kablo arızası" : " ortada değil"), null, 5);
  }

  setBlock(text) {
    this.enableBlock = { t: Date.now(), text };
    this.event("[izleyici] " + text);
  }

  async readObj(n, idx, sub) {
    const c = "read " + n + " " + idx.toString(16).toUpperCase().padStart(4, "0") + " " + sub;
    const r = await this.cmd(c, 1000);
    let val = null;
    for (const l of this.respLines(r, c)) {
      const m = GEN.exec(l);
      if (m && +m[1] === n && parseInt(m[2], 16) === idx) { val = +m[4]; continue; }
      if (l.startsWith("[")) this.handleLine(l);
    }
    return val;
  }

  async readVolt() {
    const [n, idx, sub] = PERIODIC[this.voltI++ % PERIODIC.length];
    const v = await this.readObj(n, idx, sub);
    if (v === null) return;
    if (idx === 0x6079) {
      this.volt[n] = v;
      this.voltMin[n] = Math.min(v, this.voltMin[n] === undefined ? v : this.voltMin[n]);
      if (v < V_WARN) {
        this.event("[izleyici] BESLEME DUSUK: dugum " + n + " " + (v / 1000).toFixed(2) + " V");
        this.spk.say("Besleme gerilimi düşük", null, 10);
      }
    } else if (idx === 0x2014) {
      if (this.brake[n] !== v) {
        const st = (this.latest[n] || ["?"])[0];
        this.event("[izleyici] J" + n + " fren: " + (BRAKE_STR[v] || v) + "  (eksen: " + st + ")");
      }
      this.brake[n] = v;
    }
  }

  async readPose() {
    const r = await this.cmd("pose", 1000);
    for (const l of this.respLines(r, "pose")) {
      if (l.includes("Bilinmeyen komut")) {
        this.poseOk = false;
        this.event("[izleyici] firmware 'pose' bilmiyor - TCP okunmuyor (eski surum)");
        return;
      }
      if (l.startsWith("[")) { this.handleLine(l); continue; }
      const m = POSE.exec(l);
      if (!m) continue;
      try {
        const [q, tcp, rpy, w, valid] = m[1].split("|").map(p => p.trim().split(/\s+/));
        this.kin = { q: q.map(Number), tcp: tcp.map(Number), rpy: rpy.map(Number),
                     w: Number(w[0]) / (w[0].includes(".") ? 1 : 1000),
                     valid: valid[0] === "1", t: Date.now() / 1000 };
      } catch (e) {}
    }
  }

  /* ---------------------------------------------------------- ayristirma */
  event(text) {
    this.recent.push(stamp() + " " + text);
    if (this.recent.length > 8) this.recent.splice(0, this.recent.length - 8);
  }

  track(s) {
    const p = this.panel;
    if (s.includes("PANEL KONTROLU ACIK")) p.on = true;
    else if (s.includes("Panel kontrolu kapali") || s.includes("KONTROL DONGUSU DURDU")) p.on = false;
    else if (s.includes("Devreye alma konsolu")) { this.panel = { on: false, mode: null, enable: null }; return; }
    const m = /Mod anahtari: (EKLEM|KARTEZYEN)/.exec(s);
    if (m) p.mode = m[1];
    else if (s.startsWith("[PANEL] KARTEZYEN mod")) p.mode = "KARTEZYEN";
    else if (s.startsWith("[PANEL] EKLEM modu")) p.mode = "EKLEM";
    if (s.startsWith("[PANEL] Enable: eksenler enerjileniyor")) { p.enable = "acik"; this.enableBlock = null; }
    else if (s.startsWith("[PANEL] Enable kapandi")) p.enable = "kapali";
    else if (s.includes("ENABLE REDDEDILDI")) p.enable = "reddedildi";
    else if (s.includes("enable anahtari su an ACIK")) p.enable = "anahtar acik - kapatip acin";
  }

  handleLine(raw) {
    let line = raw.replace(ANSI, "").replace(/\r/g, "");
    while (line.startsWith("> ")) line = line.slice(2);
    const s = line.trim();
    this.track(s);
    if (s === "" || s === ">" || s === "ax" || s === "^C") return;
    if (line.includes("Devreye alma konsolu")) {
      this.rebootedAt = Date.now(); this.poseOk = true; this.kin = null;
      this.event("[izleyici] KART YENIDEN BASLADI (yukleme/reset)");
      this.spk.say("Kart yeniden başladı", null, 10);
    }
    let m = LOOP.exec(line);
    if (m) {
      this.rows = {};
      if (m[1] === "DURDU" && this.loop === "calisiyor") {
        this.event("[izleyici] KONTROL DONGUSU DURDU");
        if (Date.now() - this.rebootedAt > 15000) this.spk.say("Kontrol döngüsü durdu", null, 30);
      }
      this.loop = m[1];
      if (m[1] === "DURDU") this.panel.on = false;
      return;
    }
    if (s.startsWith("ID Mod")) return;
    m = ROW.exec(line);
    if (m) {
      this.rows[+m[1]] = [m[3].trim(), +m[4], +m[5], +m[6], m[7]];
      if (Object.keys(this.rows).length === 7) this.commit();
      return;
    }
    this.event(s);
    this.alert(s);
  }

  alert(s) {
    const say = (t, k, e) => this.spk.say(t, k, e);
    const me = EMCY.exec(s);
    if (me) { if (!s.includes("temizlendi")) say("Eklem " + me[1] + " hata verdi", null, 5); return; }
    if (s.startsWith("[JOYSTICK]") && s.includes("sicradi")) {
      const m = /\] (\w\w) okumasi/.exec(s); say("Joystik " + (m ? m[1] : "") + " kablo arızası", null, 5); return;
    }
    if (s.startsWith("[SINIR]")) { const m = /Eklem (\d+)/.exec(s); const j = m ? m[1] : ""; say("Eklem " + j + " sınırda", "lim" + j, 4); return; }
    if (s.startsWith("[HAT]")) { say("CAN hattı hatası", null, 10); return; }
    if (s.includes("ENABLE REDDEDILDI") && s.includes("notr")) { this.joyCheck = true; return; }   /* ses: checkJoy */
    if (s.includes("ENABLE REDDEDILDI")) {
      this.setBlock("Enable reddedildi: E-Stop basılı (ya da kablosu kopuk). E-Stop'u çevirip bırakın, sonra Enable'ı kapatıp açın.");
      say("Enable reddedildi. E stop basılı.", null, 5); return;
    }
    if (s.startsWith("[PANEL] KARTEZYEN mod: kalibrasyon")) { say("Kartezyen mod kalibre edilmedi, kol duruyor", null, 5); return; }
    if (s.startsWith("[PANEL] KARTEZYEN mod")) { say("Kartezyen mod", null, 3); return; }
    if (s.startsWith("[PANEL] EKLEM modu")) { say("Eklem modu", null, 3); return; }
    const table = s.startsWith("[SIFIR]") ? [
        ["gidiliyor", "Sıfır konumuna gidiliyor"], ["konumunda", "Sıfır konumunda, Reset'i bırakın"],
        ["Kalibrasyon", "Kalibrasyon geçerli değil"]]
      : s.startsWith("[KARTEZYEN]") ? [
        ["sinirda (", "Eklem sınırda. Ters taraftan dolanmak için Reset'e basılı tutun"],
        ["dolaniyor", "Eklem ters taraftan dönüyor"], ["dolandi", "Dolanma bitti, çubukları bırakın"],
        ["Hareket baslamadi", "Kartezyen başlamadı, önce dirseği ve bileği bükün"],
        ["J2 (omuz) yuku", "Omuz yükü yüksek, ucu yukarı ya da geri sürün"],
        ["Tekil poz", "Tekil poz, ters yöne gidin"], ["Zemin", "Zemin sınırı"], ["Erisim", "Erişim sınırı"],
        ["yazilim sinirinda", "Eklem sınırı"], ["hazir degil", "Eklem hazır değil"], ["Kalibrasyon", "Kalibrasyon yok"]]
      : [];
    for (const [k, t] of table) if (s.includes(k)) { say(t, null, 4); break; }
  }

  commit() {
    const now = Date.now();
    this.samples++;
    for (let n = 1; n <= 7; n++) {
      const [st, , , tq] = this.rows[n];
      const prev = this.prevState[n];
      if (prev !== undefined && prev !== st) {
        this.event("[izleyici] eklem " + n + ": " + prev + " -> " + st);
        if (st === "ARIZA") this.spk.say("Eklem " + n + " arıza", null, 3);
      }
      this.prevState[n] = st;
      const a = Math.abs(tq);
      if (st === "CALISIYOR") {
        this.peak[n] = Math.max(this.peak[n], a);
        if (a >= T_OVER) { if (!this.overSince[n]) this.overSince[n] = now; } else delete this.overSince[n];
        if (a >= T_WARN) { if (!this.warnSince[n]) this.warnSince[n] = now; } else delete this.warnSince[n];
        if (this.overSince[n] && now - this.overSince[n] >= SUSTAIN) {
          this.spk.say("Eklem " + n + " aşırı yük", "over" + n, 6);
          this.event("[izleyici] EKLEM " + n + " ASIRI YUK: tork " + tq);
        } else if (this.warnSince[n] && now - this.warnSince[n] >= SUSTAIN) {
          this.spk.say("Eklem " + n + " tork yüksek", "warn" + n, 15);
        }
      } else { delete this.overSince[n]; delete this.warnSince[n]; }
    }
    this.latest = this.rows; this.rows = {}; this.t = now;
  }

  /* ---------------------------------------------------------- arayuz */
  /* mon_state.json + server.py'nin ekledigi alanlar */
  state() {
    const joints = [];
    for (let n = 1; n <= 7; n++) {
      const r = this.latest[n]; if (!r) continue;
      joints.push({ id: n, state: r[0], pos: r[1], vel: r[2], tq: r[3], peak: this.peak[n], brake: this.brake[n] });
    }
    const t = this.t / 1000;
    return { t, age: this.t ? (Date.now() - this.t) / 1000 : null, samples: this.samples, loop: this.loop,
             joints, volt: this.volt, volt_min: this.voltMin, kin: this.kin,
             connected: this.connected, panel: this.panel, events: this.recent.slice(),
             enable_block: this.enableBlock,
             usb_err: this.lastErr, retry_err: this.retryErr, drops: this.drops, retrying: !!this.retry,
             mon_alive: true, error: this.connected ? undefined : "USB bağlı değil" };
  }

  /* Baslat komutlari (server.py start_cmds ile ayni kural). Dongu calisiyor
   * diye kurulum atlanmasin: sürücüler gucsuzken 'config 0' basarisiz olduysa
   * eksenler yapilandirilmamis kalir, Enable hicbir seyi enerjilendirmez. */
  startCmds() {
    const st = [1, 2, 3, 4, 5, 6, 7].map(n => (this.latest[n] || ["?"])[0]);
    const unconf = st.some(s => s === "?" || /yapilandirilmadi/.test(s));
    const live = st.some(s => /CALISIYOR|PARK|enerjileniyor|kapatiliyor/.test(s));
    if (this.loop !== "calisiyor") return { cmds: ["config 0", "loop on", "panel on"] };
    if (!unconf) return { cmds: ["panel on"] };
    if (live) return { err: "Bazı eksenler yapılandırılmamış, diğerleri enerjili — önce Fren (eksenleri kapat), sonra ▶ Başlat." };
    return { cmds: ["loop off", "config 0", "loop on", "panel on"] };   /* hepsi enerjisiz: guvenli */
  }

  /* Kontrol tusu -> {ok, msg}. server.py do_action ile ayni kurallar. */
  action(a) {
    if (!this.connected) return { ok: false, msg: "USB bağlı değil - önce 'USB'ye bağlan'." };
    let cmds;
    if (a === "baslat") {
      const r = this.startCmds();
      if (r.err) return { ok: false, msg: r.err };
      cmds = r.cmds;
    } else if (ACTIONS[a]) {
      cmds = ACTIONS[a];
    } else {
      return { ok: false, msg: "Bilinmeyen işlem." };
    }
    this.pending.push(...cmds);
    return { ok: true, msg: cmds.join(" → ") + " gönderildi" +
             (a === "baslat" ? ". Sonra Enable anahtarını kapatıp açın." : ".") };
  }
}

UsbMon.SURUM = SURUM;
window.UsbMon = UsbMon;
})();
