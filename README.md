# Maç Analiz — Birleştirilmiş paket

Bu paket, gönderdiğin Maç Analiz arayüzünü korur ve SKORZEN v1.0'daki kişisel defter özelliklerini aynı ekrana ekler.

## Dahil edilenler
- Orijinal Maç Analiz React arayüzü ve CSS dosyaları
- Mobil uyumlu Defterim paneli
- Favori takım ve maç kaydı
- Analiz/sayfa kaydı
- JSON yedeği dışa aktarma ve içe aktarma
- Eski sürümün SportScore sunucu uç noktaları (`/api/sportscore/...`)

## Çalıştırma
Node.js 18 veya üzeri gerekir:

```bash
npm start
```

Sonra `http://localhost:3000` adresini aç.

## Veri/API durumu
- Maç detayı, takım fikstürü, puan durumu, maç kadrosu ve oyuncu profili için arayüz uyumluluk yolları eklendi.
- Tahmin endpoint'i şu an bilerek 501 döndürür; doğrulanmış geçmiş maç verisi ve model eşlemesi tamamlanmadan sahte tahmin göstermez.
- `/api/matches/:YYYYMMDD/:league` artık SportScore `/api/v1/fixtures/` uç noktasından gerçek maç listesini alıp arayüzün beklediği temel `events` yapısına dönüştürür.
- `/api/search?q=` SportScore aramasını arayüzün beklediği temel listeye dönüştürür.
- `/api/health` hangi uyumluluk parçalarının hazır olduğunu bildirir.
- Maç detayları, oyuncu maç istatistikleri, takım sezon ortalamaları, puan durumu ve Poisson tahminlerinin tamamı henüz uçtan uca eşlenmiş değildir. Bu alanlar veri varmış gibi üretilmez.

SportScore ücretsiz API kullanımı, veri gösterilen sayfalarda görünür ve dofollow `Powered by SportScore` atfı gerektirir. Kaynak: https://sportscore.com/developers/.

Defter kayıtları tarayıcı `localStorage` alanında tutulur. Hesap veya cihazlar arası otomatik senkronizasyon yoktur. JSON yedeğiyle aktarılabilir.
