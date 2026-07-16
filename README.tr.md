<div align="center">
  <img src="public/logo.png" alt="Gajae App" width="96" height="96">
  <h1>Gajae App</h1>
  <p>Gajae Code (GJC), Claude Code, Cursor, Codex ve OpenCode'u tek bir kendi kendine barındırılan web ve masaüstü çalışma alanından çalıştırın.</p>
</div>

<p align="center">
  <a href="#quick-start">Hızlı başlangıç</a> ·
  <a href="#first-run">İlk çalıştırma</a> ·
  <a href="#daily-workflow">Günlük iş akışı</a> ·
  <a href="docs/INSTALL.md">Üretim kurulumu</a> ·
  <a href="https://github.com/devswha/gajae-app/issues">Sorunlar</a>
</p>

<div align="right"><i><a href="./README.md">English</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.ru.md">Русский</a> · <b>Türkçe</b> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a></i></div>

## Gajae App ne yapar

Gajae App, kendi makinenizde veya sunucunuzda çalışan kodlama ajanları için tek kullanıcılı bir kontrol yüzeyidir. Proje ve oturum keşfini, akışlı sohbeti, onay işlemeyi, dosya tarayıcısı ve düzenleyicisini, canlı CLI görünürlüğünü, bildirimleri, skills'i, MCP yapılandırmasını ve uzak masaüstü hedeflerini birleştirir.

Uygulama bir model aboneliği içermez. Kullanmayı planladığınız her ajan CLI'ını, Gajae App'i çalıştıran aynı hostta ve aynı işletim sistemi kullanıcısı altında kurun ve kimlik doğrulamasını yapın.

### Desteklenen ajanlar

- **Gajae Code (GJC)**
- **Claude Code**
- **Cursor**
- **Codex**
- **OpenCode**

Sağlayıcıya özgü modeller, çaba denetimleri, izin modları, oturum geçmişi, skills ve MCP özellikleri yalnızca sağlayıcı bunları desteklediğinde görünür.

<a id="quick-start"></a>
## Hızlı başlangıç

### Gereksinimler

- Node.js 22.22.2+ (22.x serisi) veya 24.15.0+ (24.x serisi)
- Kaynaktan geliştirme için rustup üzerinden Rust 1.85.1; sürüm yapıtları yerel çekirdeği içerir
- npm ve Git
- En az bir desteklenen, önceden kurulmuş ve kimliği doğrulanmış ajan CLI'ı

### Web uygulamasını kaynak kodundan başlatma

```bash
git clone https://github.com/devswha/gajae-app.git
cd gajae-app
npm ci
npm run dev
```

<http://127.0.0.1:5173> adresini açın. Geliştirme arka ucu `127.0.0.1:3001` üzerinde dinler.

### Masaüstü uygulamasını geliştirme ortamında başlatma

Web yığınını çalışır durumda tutun ve Electron'u ikinci bir terminalde başlatın.

Terminal 1:

```bash
npm run dev
```

Terminal 2:

```bash
npm run desktop:dev
```

<a id="first-run"></a>
## İlk çalıştırma

1. **Sahip hesabını oluşturun.** Gajae App'i açın ve tek yerel uygulama hesabını oluşturun. Kullanıcı adı en az 3, parola en az 6 karakter içermelidir.
2. **Git kimliğini ayarlayın.** Bu hostta yapılan commit'lerde kullanılacak adı ve e-posta adresini girin. Bu işlem genel Git `user.name` ve `user.email` değerlerini yazar; GitHub oturumu açmak gerekmez.
3. **Kodlama ajanlarını bağlayın.** Onboarding sırasında kullanılabilir sağlayıcı giriş akışlarını tamamlayın veya bunları atlayıp daha sonra **Settings → Agents** kullanın. Host düzeyindeki CLI kimlik doğrulaması doğruluk kaynağı olmaya devam eder.
4. **Bir proje ekleyin.** Var olan bir dizini seçmek veya çalışma alanı oluşturmak/klonlamak için kenar çubuğundaki proje eylemini kullanın. Yollar, tarayıcının gösterildiği cihazı değil, sunucunun çalıştığı makineyi ifade eder.
5. **Bir oturum başlatın.** Projeyi seçin, kullanılabilir bir sağlayıcı belirleyin, sağlayıcının desteklediği model ve izin denetimlerini ayarlayın, ardından ilk prompt'u gönderin.

<a id="daily-workflow"></a>
## Günlük iş akışı

### Projeler ve oturumlar

- Yerel çalışma alanını mutlak yolla ekleyin veya proje sihirbazı aracılığıyla bir Git deposunu klonlayın.
- GitHub belirtecini **Settings → API & Credentials** altında yalnızca HTTPS klonlamanın buna ihtiyacı olduğunda saklayın; SSH URL'leri sunucu kullanıcısının SSH yapılandırmasını kullanır.
- Dizine alınmış oturumları sürdürmek için kenar çubuğunda projeyi genişletin. Gajae App desteklenen sağlayıcıların oturum depolarını okur ve sağlayıcı kimliklerini ayrı tutar.
- Seçilen projeden yeni bir sohbet başlatın. Bir çalıştırmayı durdurmak etkin ajan sürecini durdurur; projeyi veya geçmişini silmez.

### Sohbet ve onaylar

- Metin, resim ekleri, dosya anmaları ve sağlayıcının desteklediği slash komutları gönderin.
- Sınırsız yürütmeyi körlemesine etkinleştirmek yerine araç çağrılarını inceleyin ve sohbet içinde izin isteklerini yanıtlayın.
- Model, çaba, düşünme ve izin denetimlerini yalnızca seçili sağlayıcı bunları sunduğunda kullanın.
- Önceki oturumları kenar çubuğundan sürdürün. Oturum adları, sağlayıcının yerel oturum tanımlayıcılarını değiştirmeden düzenlenebilir.

### Dosyalar

Yapılandırılmış çalışma alanı köküne göz atmak, resimleri ve Markdown'u önizlemek, metin dosyalarını düzenlemek, klasör oluşturmak ve dosya yüklemek için Files panelini açın. Dosya erişimi doğrulanmış proje yollarıyla sınırlıdır; sembolik bağlantı ve dizin geçişi kaçışları reddedilir.

### Canlı CLI oturumları

Gajae App, `tmux` altında hâlihazırda çalışan desteklenen ajan oturumlarını gösterebilir. Canlı satırlar tmux oturum adını kullanır, terminal destekli görünümler olarak açılır ve web sunucusu yerine tmux'un mülkiyetinde kalır. Sunucunun yeniden başlatılması bu harici oturumları sonlandırmamalıdır.

### Bildirimler

Tarayıcı veya masaüstü bildirimlerini **Settings → Notifications** altında etkinleştirin. Çalıştırma tamamlandı, hata, izin gerekli ve desteklenen canlı-turn olayları ayrı denetimlere sahiptir; böylece gürültülü hatlar bağımsız olarak devre dışı bırakılabilir.

## Uzak kullanım

Sunucu varsayılan olarak loopback'e bağlanır. Başka bir cihaz için bu bağlamayı koruyun ve güvenilir bir VPN veya SSH tüneli kullanın:

```bash
ssh -N -L 3001:127.0.0.1:3001 user@server
```

Ardından yerel olarak <http://127.0.0.1:3001> adresini açın. 3001 numaralı bağlantı noktasını doğrudan genel internete açmayın.

Electron uygulaması uzak Gajae App sunucularını kaydedebilir. Uzak hedefler HTTPS gerektirir; düz HTTP yalnızca tam loopback origin'leri için kabul edilir. Her yerel veya uzak hedef, çerezlerin ve depolamanın paylaşılmaması için yalıtılmış bir Electron oturum bölümü kullanır.

## Üretim kurulumu

Üretim; glibc 2.35 veya daha yeni sürümü, 22.x serisinde Node.js 22.22.2 veya daha yeni bir sürüm ve kullanıcı düzeyinde systemd hizmeti bulunan Linux x86_64 üzerinde desteklenir.

[GitHub Releases](https://github.com/devswha/gajae-app/releases) içinden değişmez bir `gajae-app-server-<version>-linux-x64-node22.tar.gz` yapıtı kullanın. Desteklenen bir kurulum şunları yapmalıdır:

1. sabitlenmiş bir sürümü ve eşleşen `.sha256` dosyasını indirmek;
2. açmadan önce sağlama toplamını doğrulamak;
3. `~/.gajae-app/releases/<version>` altında açmak;
4. `~/.gajae-app/current` yolunu bu sürüme yöneltmek;
5. `gajae-app.service` hizmetini kullanıcı hizmeti olarak çalıştırmak ve `http://127.0.0.1:3001/health` adresini doğrulamak.

Tam ilk kurulum komutları için [docs/INSTALL.md](docs/INSTALL.md), hizmet işlemleri, yükseltmeler, uzak erişim, geri alma ve kaldırma için [docs/SELF-HOST.md](docs/SELF-HOST.md) belgesini izleyin. Değiştirilebilir bir `latest` URL'sini, paket kayıt defteri kopyasını, kapsayıcı görüntüsünü veya doğrulanmamış kaynak derlemesini üretim sunucusu olarak dağıtmayın.

## Sorun giderme

| Belirti | Denetim |
|---|---|
| Bir sağlayıcı kullanılamıyor | CLI'ının kurulu, kimliği doğrulanmış ve Gajae App'i çalıştıran kullanıcı için `PATH` içinde görünür olduğunu doğrulayın; sonra **Settings → Agents** öğesini yeniden denetleyin. |
| Bir proje yolu reddediliyor | Sunucu hostunda var olan ve sunucu kullanıcısının erişebildiği mutlak bir yol girin. |
| Geliştirmede Electron boş veya başarısız bir sayfa açıyor | `npm run desktop:dev` çalıştırmadan önce `npm run dev` komutunu etkin tutun. |
| Hizmet başlamıyor | `systemctl --user status gajae-app.service` ve `journalctl --user -u gajae-app.service -f` komutlarını çalıştırın. |
| Uzak erişim başarısız oluyor | Önce yerel `/health` uç noktasını doğrulayın, ardından SSH/VPN rotasını veya kayıtlı HTTPS origin'ini denetleyin. |
| Eski kimlik bilgileri girişten sonra hâlâ geçersiz görünüyor | Sağlayıcıyı **Settings → Agents** altında yeniden bağlayın ve CLI'ı doğrudan hizmet kullanıcısı altında doğrulayın. |

## Geliştirme komutları

| Komut | Amaç |
|---|---|
| `npm run dev` | Vite istemcisini ve geliştirme arka ucunu başlat |
| `npm run server:dev` | Yalnızca geliştirme arka ucunu başlat |
| `npm run client` | Yalnızca Vite istemcisini başlat |
| `npm run desktop:dev` | Electron'u geliştirme istemcisine karşı başlat |
| `npm test` | Sunucu, istemci ve Electron testlerini çalıştır |
| `npm run typecheck` | İstemciyi ve sunucuyu tür denetiminden geçir |
| `npm run lint` | Ürün ve araç kodunda ESLint çalıştır |
| `npm run check:identity` | Ürün, yasal ve kaynak kimliği kurallarını doğrula |
| `npm run build` | Üretim istemcisini ve sunucusunu derle |
| `npm run verify` | Tam sürüm geçidini çalıştır |

Node.js 22.22.2+ (22.x serisi) veya 24.15.0+ (24.x serisi) kullanın ve değişiklikleri göndermeden önce tam geçidi çalıştırın:

```bash
npm run verify
```

Bu komut bağımlılık denetimini, tür denetimlerini, tüm test bölümlerini, lint'i, kimlik doğrulamasını ve üretim derlemelerini çalıştırır.

## Güvenlik ve veri sınırları

- Web kimlik doğrulaması, kalıcı çıkış iptali içeren bir `HttpOnly`, `SameSite=Strict` çerezi kullanır.
- Kimlik bilgileri URL sorgu parametrelerinden kabul edilmez. Harici ajan API anahtarları `X-API-Key` başlığını kullanır.
- Proje dosyaları kanonik yol ve sembolik bağlantı denetimleriyle çözümlenir; yazmalar aynı dizinde atomik değiştirme kullanır.
- Yüklemeler, tamamlanma veya hata sonrasında temizlenen istek başına özel geçici dizinler kullanır.
- Electron varsayılan olarak hedef izinlerini reddeder ve IPC'yi kayıtlı launcher frame'leriyle sınırlar.
- Yükseltmeler veya host geçişinden önce `~/.gajae-app/data` dizinini yedekleyin. Sürüm geçişleri bu dizini korumalıdır.

## Proje bilgileri

- [Üretim kurulumu](docs/INSTALL.md)
- [Kendi kendine barındırma ve geri alma](docs/SELF-HOST.md)
- [Upstream kaynak ve seçici alım](docs/UPSTREAM.md)
- [Katkıda bulunma](CONTRIBUTING.md)
- [Sorun takipçisi](https://github.com/devswha/gajae-app/issues)

<!-- upstream-lineage:start -->
Upstream lineage: Gajae App is derived from [CloudCLI UI](https://github.com/siteboon/claudecodeui). Required attribution and license terms are preserved in [LICENSE](LICENSE) and [NOTICE](NOTICE).
<!-- upstream-lineage:end -->

## Lisans

[GNU AGPL v3](LICENSE)
