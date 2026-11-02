# Robot Kol Canlı — tablet arayüzü

6 eksen robot kolun canlı 3D görünümü, eklem yükleri ve kontrol tuşları. Tablet,
kolun kontrol kartına (STM32 Nucleo, ST-LINK USB) **doğrudan USB ile** bağlanır.

**Kullanım:** Android tablette Chrome ile https://asevim.github.io/robotkol-arayuz/ adresini açın
→ menü → *Uygulamayı yükle*. İlk açılıştan sonra internetsiz çalışır. Tableti USB-OTG
kablosuyla kartın ST-LINK USB'sine takın → **USB'ye bağlan** → **▶ Başlat**.

Masaüstü Chrome/Edge'de de çalışır (Web Serial). Test için kartsız: adrese `?sahte=1` ekleyin.

Kütüphaneler: three.js r128 (MIT), web-serial-polyfill (Apache-2.0).
