/* usbmon-sahte.js - test icin sahte kart konsolu (adres ?sahte=1 iken).
 * Web Serial arayuzunu taklit eder; ax / pose / read / config / loop /
 * panel / disable / reset komutlarina kartin bicimiyle cevap verir.
 * Donanim olmadan usbmon.js + index.html'i uctan uca denemek icin. */
(function () {
"use strict";
if (!/[?&]sahte=1/.test(location.search)) return;

const ZERO = [85.2, 63.2, -29.3, 58.0, -1.0, 99.1];      /* kalibrasyon sifirlari (derece) */
const DIR = [1, 1, -1, 1, 1, 1];

class FakePort {
  constructor() {
    this.line = ""; this.cfg = false; this.loop = false; this.panel = false; this.en = false;
    this.pos = [60, 40, -60, 30, 45, 120, -45]; this.t0 = Date.now();
    /* joystik ham degerleri; test icin degistirilebilir: SAHTE_SERIAL.port.joy.RX = [22589, -109, false] */
    this.joy = { LX: [32833, 0, false], LY: [33143, 0, false], LZ: [30374, 0, false],
                 RX: [32870, 0, false], RY: [32870, 0, false], RZ: [31780, 0, false] };
    this.liveTimer = null;
    this.ej = {};               /* ekrandan oynatma: eklem -> {v, t} */
    this.lastTick = Date.now();
  }
  joyLines() {
    return Object.entries(this.joy).map(([k, [raw, n, f]]) => {
      const mv = Math.floor(raw * 3300 / 65535);
      return "\r\x1b[K    " + k + "  " + String(raw).padStart(5) + "  " + Math.floor(mv / 1000) + "." +
             String(mv % 1000).padStart(3, "0") + " V  " + ((n >= 0 ? "+" : "") + n).padStart(5) + "  " + (f ? "KABLO?" : "") + "\r\n";
    }).join("");
  }
  /* Enable anahtari kenari: firmware gibi notr/E-Stop denetimi */
  enableEdge() {
    const bad = Object.values(this.joy).some(([, n, f]) => n !== 0 || f);
    this.emit(bad ? "\r\n[PANEL] ENABLE REDDEDILDI: joystickler notrde degil.\r\n        Kollari birakin, anahtari kapatip tekrar acin.\r\n> "
                  : "\r\n[PANEL] Enable: eksenler enerjileniyor.\r\n> ");
    if (!bad) this.en = true;
  }
  getInfo() { return { usbVendorId: 0x0483, usbProductId: 0x374e }; }
  async open() {
    const self = this;
    this.readable = new ReadableStream({ start(c) { self.ctrl = c; } });
    this.writable = new WritableStream({ write(chunk) { self.onBytes(chunk); } });
    setTimeout(() => this.emit("\r\n GripperControl - Devreye alma konsolu (F2)\r\n> "), 50);
  }
  async close() {}
  emit(s) { try { this.ctrl.enqueue(new TextEncoder().encode(s)); } catch (e) {} }
  onBytes(chunk) {
    for (const b of chunk) {
      const ch = String.fromCharCode(b);
      if (this.liveTimer) {                         /* canli ekran: herhangi bir tus cikar */
        clearInterval(this.liveTimer); this.liveTimer = null; this.emit("> "); continue;
      }
      if (ch === "\x03") { this.line = ""; this.emit("^C\r\n> "); continue; }
      if (ch === "\r") {
        this.emit("\r\n");
        const l = this.line.trim(); this.line = "";
        setTimeout(() => { if (this.exec(l) !== "canli") this.emit("> "); }, 8);
      } else { this.line += ch; this.emit(ch); }
    }
  }
  run(n) {
    if (!this.cfg) return "yapilandirilmadi";
    if (!this.en) return "hazir (enerjisiz)";
    return (n === 7) ? "PARK (fren)" : "CALISIYOR";
  }
  tick() {   /* ekran komutu varsa o eklem 10 d/s ile doner (500 ms yenilenmezse durur) */
    const now = Date.now(), dt = (now - this.lastTick) / 1000; this.lastTick = now;
    for (const [n, j] of Object.entries(this.ej)) {
      if (now - j.t > 500) { delete this.ej[n]; continue; }
      const dir = DIR[n - 1] || 1;
      if (this.en && this.loop) this.pos[n - 1] += dir * 10 * j.v / 1000 * dt;
    }
  }
  exec(l) {
    const out = s => this.emit("  " + s + "\r\n");
    const a = l.split(/\s+/);
    this.tick();
    if (l === "") return;
    if (a[0] === "ej") {
      if (a.length === 1) { this.ej = {}; return; }
      const n = +a[1], v = +a[2];
      if (!this.panel) { out("EKRAN: panel kapali - once Baslat"); return; }
      if (!this.en) { out("EKRAN: paneldeki Enable kapali"); return; }
      if (v === 0) delete this.ej[n]; else this.ej[n] = { v, t: Date.now() };
      return;
    }
    if (a[0] === "joy") {
      out("Canli joystick - cikmak icin bir tus. Norm: -1000..+1000 (ol bolge 100)");
      out("  Eksen  Ham    Gerilim   Norm");
      this.emit(this.joyLines());
      this.liveTimer = setInterval(() => this.emit("\x1b[6A" + this.joyLines()), 150);
      return "canli";
    }
    if (a[0] === "ax") {
      out("Dongu: " + (this.loop ? "calisiyor" : "DURDU") + ", 1234 cevrim   heartbeat: acik");
      out(" ID Mod  Durum                Pozisyon        Hiz   Tork  SW      CiA402");
      for (let n = 1; n <= 7; n++) {
        const st = this.run(n);
        const p = this.cfg ? this.pos[n - 1] : 0;
        const tq = (st === "CALISIYOR") ? Math.round(n === 2 ? 600 + 500 * Math.sin((Date.now() - this.t0) / 4000) : 150 * Math.sin(n)) : 0;
        this.emit("  " + String(n).padStart(3) + " " + (n === 7 ? "CSV" : "CSP") + "  " + st.padEnd(17) + " " +
          p.toFixed(3).padStart(10) + "  " + (0.01).toFixed(3).padStart(9) + "  " + String(tq).padStart(5) +
          "  0x0237  " + (this.en ? "Operation enabled" : "Switch on disabled") + "\r\n");
      }
      return;
    }
    if (a[0] === "pose") {
      if (!this.cfg) { out("Eklemler yapilandirilmamis: config 0 -> loop on"); return; }
      const q = ZERO.map((z, i) => DIR[i] * (this.pos[i] - z));
      out("Model acilari (derece):  " + q.map((x, i) => "J" + (i + 1) + " " + x.toFixed(2)).join("  "));
      out("@POSE " + q.map(x => x.toFixed(3)).join(" ") + " | 0.00 0.00 0.00 | 0.00 0.00 0.00 | 0.1500 | 1");
      return;
    }
    if (a[0] === "read") {
      const n = +a[1], idx = a[2].toUpperCase().padStart(4, "0"), sub = String(a[3] || 0).padStart(2, "0");
      const v = idx === "6079" ? 24300 + Math.round(Math.random() * 80) : (this.en ? 2 : 0);
      out("Dugum " + n + " 0x" + idx + ":" + sub + " = 0x" + v.toString(16).toUpperCase().padStart(8, "0") + " (" + v + ")");
      return;
    }
    if (l === "config 0") {
      if (this.loop) { out("Once kontrol dongusunu durdurun: loop off"); return; }
      for (let n = 1; n <= 7; n++) { out("Dugum " + n + "  mod " + (n === 7 ? "CSV (hiz)" : "CSP (pozisyon)") + " ..."); out("tamam"); }
      out("7/7 dugum yapilandirildi."); this.cfg = true; return;
    }
    if (l === "loop on") { this.loop = true; out("Kontrol dongusu basladi (4 ms)"); return; }
    if (l === "loop off") { this.loop = false; this.panel = false; out("Kontrol dongusu durdu."); return; }
    if (l === "panel on") {
      this.panel = true;
      out("PANEL KONTROLU ACIK - 7/7 eksen yapilandirilmis.");
      out("Enable anahtarini KAPATIP ACIN (joystickler notrde olmali).");
      out("Mod anahtari: EKLEM");
      setTimeout(() => this.enableEdge(), 2500);
      return;
    }
    if (l === "panel off") { this.panel = false; out("Panel kontrolu kapali, hedef hizlar sifir. (Enerji kesilmedi.)"); return; }
    if (a[0] === "disable") { this.en = false; out("Dugum " + a[1] + " kapatiliyor."); return; }
    if (a[0] === "reset") { out("Dugum " + a[1] + " arizasi temizlendi, hazir durumda."); return; }
    out("Bilinmeyen komut: " + a[0] + "  ('help')");
  }
}

const port = new FakePort();
window.SAHTE_SERIAL = {
  port,
  async requestPort() { return port; },
  async getPorts() { return []; },
};
})();
