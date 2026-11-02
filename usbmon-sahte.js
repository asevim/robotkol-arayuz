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
      if (ch === "\x03") { this.line = ""; this.emit("^C\r\n> "); continue; }
      if (ch === "\r") {
        this.emit("\r\n");
        const l = this.line.trim(); this.line = "";
        setTimeout(() => { this.exec(l); this.emit("> "); }, 8);
      } else { this.line += ch; this.emit(ch); }
    }
  }
  run(n) {
    if (!this.cfg) return "yapilandirilmadi";
    if (!this.en) return "hazir (enerjisiz)";
    return (n === 7) ? "PARK (fren)" : "CALISIYOR";
  }
  tick() {   /* enerjili iken eklemler yavasca salinir */
    const t = (Date.now() - this.t0) / 1000;
    if (this.en && this.loop) for (let i = 0; i < 6; i++) this.pos[i] += 0.4 * Math.sin(t * 0.5 + i);
  }
  exec(l) {
    const out = s => this.emit("  " + s + "\r\n");
    const a = l.split(/\s+/);
    this.tick();
    if (l === "") return;
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
      setTimeout(() => { this.en = true; this.emit("\r\n[PANEL] Enable: eksenler enerjileniyor.\r\n> "); }, 2500);
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
  async requestPort() { return port; },
  async getPorts() { return []; },
};
})();
