# Neon Atölye

**Canlı:** https://rhinoffensive.github.io/neon-atolye/ — telefonda bu linki Chrome'da açıp **📱 AR**'ye basman yeterli (HTTPS olduğu için kablo/adb gerekmez).

LED neon flex tabelaları tasarlamak, **yapım planını** çıkarmak ve sonucu önizlemek için web aracı. Önizleme masaüstünde yapılır, AR ile duvarda görmek Android telefonda çalışır.

- **Tasarım:** Türkçe karakterleri tam olan tek-çizgi fontlarla yazı yazılır (EMS Allure / Readability / Tech / Felix / Nixish, Hershey Script / Sans). Ayrıca serbest çizim ve SVG içe aktarma var.
- **Plan:** Şeridin fiziğine göre hesaplanır:
  - parçalar, 25 mm'lik kesim birimleri ve uç kapakları;
  - köşelerin yuvarlatılması ya da kesilmesi;
  - kesişimlerde alttaki çizginin kesilmesi;
  - şeritler arası boşluk;
  - büküm adımları, şeritteki kesim işaretlerine göre verilir: `İ3+8 → sola 90° R20`;
  - kablo delikleri, arka kablolama ağacı, adaptör ve kablo kesiti;
  - stok.
- **Çıktılar:**
  - **PDF:** yapım föyü, 1:1 açılmış şeritler ve A4'e bölünmüş 1:1 şablon (hizalama işaretli). %100 / gerçek boyutta yazdırılmalı.
  - **SVG:** katmanlı plan; Inkscape ve lazer yazılımları için.
  - **Proje dosyası:** `.neon.json`.
- **Önizleme:**
  - LED'ler kesim fazına göre dizilir ve silikon difüzörden geçer.
  - Duvara vuran ışık duvar rengiyle çarpılır ve tabelanın duvara uzaklığına göre yayılır.
  - "Kamera" modunda çekirdek beyaza yanar; "Göz" modunda renk doygun kalır.
  - Gece/gündüz ayarı, hazır duvarlar ve fotoğraf arka planı, yanma animasyonu, PNG kaydetme var.
- **AR (Android Chrome + ARCore):**
  - Telefonu duvara tutup tabelayı gerçek boyutta görürsün.
  - Dokununca tabela duvara sabitlenir.
  - Boyut, parlaklık ve pozlama AR'nin içinden değiştirilebilir.
- **Yapım modu:** Hazırlık adımları ve her parça için "kes → bük → yerleştir" kartları.

## Çalıştırma

```bash
npm install
```

```bash
npm run dev
```

Tarayıcıda `http://localhost:5173` adresini aç.

Testler:

```bash
npm test
```

## Telefonda AR

Yayındaki sürümde doğrudan çalışır. Geliştirirken yerel sunucuyu telefonda denemek için (WebXR yalnızca HTTPS ya da `localhost` üzerinde çalışır) USB kablosu kullan:

1. Telefonda Geliştirici seçenekleri → USB hata ayıklama'yı aç ve telefonu USB ile bağla.
2. Telefonun, bilgisayardaki sunucuya `localhost` üzerinden ulaşmasını sağla:

   ```bash
   adb reverse tcp:5173 tcp:5173
   ```

3. Telefonda Chrome'da `http://localhost:5173` adresini aç ve **📱 AR** düğmesine bas.
4. Kamera izni ver. Telefonu duvara tut; halka duvarın üstüne oturunca dokun.

Hata ayıklama için bilgisayarda Chrome'da `chrome://inspect` aç. Düz beyaz duvarlarda ARCore düzlem bulmakta zorlanabilir; dokulu bir yüzey ya da duvara yapıştırılmış bir kâğıt yardımcı olur.

## Kendi şeridine göre ayarla (Şerit profili)

| Alan | Nasıl bulunur |
|---|---|
| Kesim birimi | Şeritteki makas işaretleri arası (12 V'ta genelde 25 mm) |
| Min R (hata/uyarı) | Şeridi R10/15/20/30'luk yaylara bükerek dene; zorlamadan dönebildiği en küçük yarıçap |
| Besleme / kör kapak | Kapaklı ucun kesim işaretinden ne kadar dışarı taştığı |
| Kablo çıkışı | Kapağın kablosu alttan mı uçtan mı çıkıyor (delik yeri buna göre) |
| Difüzyon q | Şerit yanarken LED'ler nokta nokta görünüyorsa 0,35–0,45, düz çizgiyse 0,6 |
| Stok | Elindeki metre |

## Yayın

`main` dalına her gönderimde GitHub Actions testleri çalıştırır, `BASE_PATH=/neon-atolye/` ile derler ve GitHub Pages'e yükler (`.github/workflows/deploy.yml`).

## Klasörler

```
src/core/      saf TypeScript (DOM yok): model, geometri, font, planlayıcı, PDF/SVG çıktıları
src/render/    three.js ışık motoru, önizleme, xr/ (WebXR AR)
src/workers/   planlama worker'ı
src/app/       React arayüzü (SVG editör, paneller, yapım modu)
public/fonts/  EMS (OFL) ve Hershey tek-çizgi fontlar, PDF için DejaVu Sans
tests/         Vitest (planlayıcı, fontlar, gerçek tabela regresyonları)
```

## Sonraki adımlar

- AR v2 (`camera-access`):
  - kamera görüntüsü alınacak;
  - duvar ışığı gerçek duvar rengiyle çarpılacak;
  - oda aydınlıkken bile gece simülasyonu yapılabilecek.
- Düğüm düzenleme ve kesişimde hangi çizginin üstte kalacağının seçilmesi.
- Karartmalı geçiş arayüzü.
- Pano konturu ve lazer kesim (DXF).
- "Ölçek yakalama": tüm tabelayı ±%3 ayarlayıp 25 mm'lik artıkları en aza indirme.
- iPhone için fotoğraf + A4 kalibrasyonlu önizleme.
- Her fonttan otomatik orta çizgi çıkarma.
