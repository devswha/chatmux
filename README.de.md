<div align="center">
  <img src="public/logo.png" alt="Gajae App" width="96" height="96">
  <h1>Gajae App</h1>
  <p>Führen Sie Gajae Code (GJC), Claude Code, Cursor, Codex und OpenCode in einem selbst gehosteten Web- und Desktop-Arbeitsbereich aus.</p>
</div>

<p align="center">
  <a href="#quick-start">Schnellstart</a> ·
  <a href="#first-run">Erste Schritte</a> ·
  <a href="#daily-workflow">Täglicher Arbeitsablauf</a> ·
  <a href="docs/INSTALL.md">Produktionsinstallation</a> ·
  <a href="https://github.com/devswha/gajae-app/issues">Probleme</a>
</p>

<div align="right"><i><a href="./README.md">English</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.ja.md">日本語</a> · <b>Deutsch</b> · <a href="./README.ru.md">Русский</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a></i></div>

## Was Gajae App macht

Gajae App ist eine Einzelbenutzer-Steueroberfläche für Coding-Agenten, die auf Ihrem eigenen Rechner oder Server laufen. Sie kombiniert Projekt- und Sitzungserkennung, Streaming-Chat, Freigabeverarbeitung, einen Dateibrowser und -editor, Live-CLI-Ansicht, Benachrichtigungen, Skills, MCP-Konfiguration und entfernte Desktop-Ziele.

Die App enthält kein Modell-Abonnement. Installieren und authentifizieren Sie jede Agent-CLI, die Sie verwenden möchten, auf demselben Host und unter demselben Betriebssystembenutzer, der Gajae App ausführt.

### Unterstützte Agenten

- **Gajae Code (GJC)**
- **Claude Code**
- **Cursor**
- **Codex**
- **OpenCode**

Anbieterspezifische Modelle, Aufwandssteuerungen, Berechtigungsmodi, Sitzungsverlauf, Skills und MCP-Funktionen erscheinen nur, wenn der jeweilige Anbieter sie unterstützt.

<a id="quick-start"></a>
## Schnellstart

### Anforderungen

- Node.js 22.22.2+ (22.x) oder 24.15.0+ (24.x)
- Rust 1.85.1 über rustup für die Entwicklung aus dem Quellcode; Release-Artefakte enthalten den nativen Core
- npm und Git
- Mindestens eine unterstützte, bereits installierte und authentifizierte Agent-CLI

### Die Web-App aus dem Quellcode starten

```bash
git clone https://github.com/devswha/gajae-app.git
cd gajae-app
npm ci
npm run dev
```

Öffnen Sie <http://127.0.0.1:5173>. Das Entwicklungs-Backend lauscht auf `127.0.0.1:3001`.

### Die Desktop-App in der Entwicklung starten

Lassen Sie den Web-Stack weiterlaufen und starten Sie Electron in einem zweiten Terminal.

Terminal 1:

```bash
npm run dev
```

Terminal 2:

```bash
npm run desktop:dev
```

<a id="first-run"></a>
## Erste Schritte

1. **Erstellen Sie das Inhaberkonto.** Öffnen Sie Gajae App und erstellen Sie das einzige lokale Anwendungskonto. Der Benutzername muss mindestens 3 Zeichen, das Passwort mindestens 6 Zeichen enthalten.
2. **Legen Sie die Git-Identität fest.** Geben Sie den Namen und die E-Mail-Adresse für Commits auf diesem Host ein. Dadurch werden global `user.name` und `user.email` von Git geschrieben; eine GitHub-Anmeldung ist nicht erforderlich.
3. **Verbinden Sie Coding-Agenten.** Schließen Sie während des Onboardings verfügbare Anbieter-Anmeldeabläufe ab, oder überspringen Sie sie und verwenden Sie später **Settings → Agents**. Die CLI-Authentifizierung auf Hostebene bleibt maßgeblich.
4. **Fügen Sie ein Projekt hinzu.** Verwenden Sie die Projektaktion in der Seitenleiste, um ein bestehendes Verzeichnis auszuwählen oder einen Arbeitsbereich zu erstellen bzw. zu klonen. Pfade beziehen sich auf den Rechner, auf dem der Server läuft, nicht zwingend auf das Gerät, das den Browser anzeigt.
5. **Starten Sie eine Sitzung.** Wählen Sie das Projekt, einen verfügbaren Anbieter sowie die vom Anbieter unterstützten Modell- und Berechtigungssteuerungen und senden Sie dann den ersten Prompt.

<a id="daily-workflow"></a>
## Täglicher Arbeitsablauf

### Projekte und Sitzungen

- Fügen Sie einen lokalen Arbeitsbereich über einen absoluten Pfad hinzu oder klonen Sie ein Git-Repository über den Projektassistenten.
- Speichern Sie ein GitHub-Token unter **Settings → API & Credentials** nur, wenn es für einen HTTPS-Klon erforderlich ist; SSH-URLs verwenden die SSH-Konfiguration des Serverbenutzers.
- Klappen Sie ein Projekt in der Seitenleiste auf, um indizierte Sitzungen fortzusetzen. Gajae App liest Sitzungsspeicher unterstützter Anbieter und hält Anbieteridentitäten getrennt.
- Starten Sie einen neuen Chat aus dem ausgewählten Projekt. Das Anhalten eines Laufs beendet den aktiven Agent-Prozess, löscht jedoch weder das Projekt noch seinen Verlauf.

### Chat und Freigaben

- Senden Sie Text, Bildanhänge, Dateierwähnungen und vom Anbieter unterstützte Slash-Befehle.
- Prüfen Sie Tool-Aufrufe und beantworten Sie Berechtigungsanfragen im Chat, statt uneingeschränkte Ausführung blind zu aktivieren.
- Verwenden Sie Modell-, Aufwands-, Denk- und Berechtigungssteuerungen nur, wenn der ausgewählte Anbieter sie bereitstellt.
- Setzen Sie frühere Sitzungen über die Seitenleiste fort. Sitzungsnamen können bearbeitet werden, ohne die anbietereigenen Sitzungskennungen zu ändern.

### Dateien

Öffnen Sie das Dateifenster, um den konfigurierten Arbeitsbereichsstamm zu durchsuchen, Bilder und Markdown in der Vorschau zu betrachten, Textdateien zu bearbeiten, Ordner zu erstellen und Dateien hochzuladen. Der Dateizugriff ist auf validierte Projektpfade beschränkt; Symlink- und Traversal-Ausbrüche werden abgewiesen.

### Live-CLI-Sitzungen

Gajae App kann unterstützte Agent-Sitzungen anzeigen, die bereits unter `tmux` laufen. Live-Zeilen verwenden den Namen der tmux-Sitzung, öffnen sich als terminalgestützte Ansichten und verbleiben im Besitz von tmux statt des Webservers. Ein Serverneustart darf diese externen Sitzungen nicht beenden.

### Benachrichtigungen

Aktivieren Sie Browser- oder Desktop-Benachrichtigungen unter **Settings → Notifications**. Ereignisse für abgeschlossene Läufe, Fehler, erforderliche Berechtigungen und unterstützte Live-Turns haben separate Steuerelemente, sodass laute Kanäle unabhängig deaktiviert werden können.

## Remote-Nutzung

Der Server bindet standardmäßig an Loopback. Behalten Sie für ein anderes Gerät diese Bindung bei und verwenden Sie ein vertrauenswürdiges VPN oder einen SSH-Tunnel:

```bash
ssh -N -L 3001:127.0.0.1:3001 user@server
```

Öffnen Sie dann lokal <http://127.0.0.1:3001>. Setzen Sie Port 3001 nicht direkt dem öffentlichen Internet aus.

Die Electron-App kann entfernte Gajae-App-Server registrieren. Entfernte Ziele erfordern HTTPS; reines HTTP wird nur für exakte Loopback-Ursprünge akzeptiert. Jedes lokale oder entfernte Ziel verwendet eine isolierte Electron-Sitzungspartition, sodass Cookies und Speicher nicht geteilt werden.

## Produktionsinstallation

Die Produktion wird unter Linux x86_64 mit glibc 2.35 oder neuer, Node.js 22.22.2 oder neuer innerhalb der 22.x-Reihe und einem systemd-Dienst auf Benutzerebene unterstützt.

Verwenden Sie ein unveränderliches Artefakt `gajae-app-server-<version>-linux-x64-node22.tar.gz` aus [GitHub Releases](https://github.com/devswha/gajae-app/releases). Eine unterstützte Installation muss:

1. eine festgelegte Version und die passende `.sha256`-Datei herunterladen;
2. die Prüfsumme vor dem Entpacken verifizieren;
3. sie unter `~/.gajae-app/releases/<version>` entpacken;
4. `~/.gajae-app/current` auf dieses Release zeigen lassen;
5. `gajae-app.service` als Benutzerdienst ausführen und `http://127.0.0.1:3001/health` verifizieren.

Folgen Sie [docs/INSTALL.md](docs/INSTALL.md) für die genauen Befehle zur Erstinstallation und [docs/SELF-HOST.md](docs/SELF-HOST.md) für Dienstbetrieb, Upgrades, Fernzugriff, Rollback und Entfernung. Stellen Sie keinen veränderlichen `latest`-URL, keine Kopie aus einer Paketregistrierung, kein Container-Image und keinen ungeprüften Quell-Build als Produktionsserver bereit.

## Fehlerbehebung

| Symptom | Prüfen |
|---|---|
| Ein Anbieter ist nicht verfügbar | Bestätigen Sie, dass seine CLI installiert, authentifiziert und im `PATH` für den Benutzer sichtbar ist, der Gajae App ausführt; prüfen Sie dann erneut **Settings → Agents**. |
| Ein Projektpfad wird abgewiesen | Geben Sie einen absoluten Pfad ein, der auf dem Serverhost existiert und für den Serverbenutzer zugänglich ist. |
| Electron in der Entwicklung öffnet eine leere oder fehlgeschlagene Seite | Lassen Sie `npm run dev` aktiv, bevor Sie `npm run desktop:dev` ausführen. |
| Der Dienst startet nicht | Führen Sie `systemctl --user status gajae-app.service` und `journalctl --user -u gajae-app.service -f` aus. |
| Fernzugriff schlägt fehl | Bestätigen Sie zuerst den lokalen Endpunkt `/health`, prüfen Sie dann die SSH/VPN-Route oder den registrierten HTTPS-Ursprung. |
| Alte Zugangsdaten erscheinen nach der Anmeldung weiter ungültig | Verbinden Sie den Anbieter unter **Settings → Agents** erneut und prüfen Sie die CLI direkt unter dem Dienstbenutzer. |

## Entwicklungsbefehle

| Befehl | Zweck |
|---|---|
| `npm run dev` | Vite-Client und Entwicklungs-Backend starten |
| `npm run server:dev` | Nur das Entwicklungs-Backend starten |
| `npm run client` | Nur den Vite-Client starten |
| `npm run desktop:dev` | Electron gegen den Entwicklungs-Client starten |
| `npm test` | Server-, Client- und Electron-Tests ausführen |
| `npm run typecheck` | Client und Server typprüfen |
| `npm run lint` | ESLint für Produkt- und Tooling-Code ausführen |
| `npm run check:identity` | Produkt-, Rechts- und Herkunftsregeln prüfen |
| `npm run build` | Produktions-Client und -Server bauen |
| `npm run verify` | Das vollständige Release-Gate ausführen |

Verwenden Sie Node.js 22.22.2+ (22.x) oder 24.15.0+ (24.x) und führen Sie vor dem Einreichen von Änderungen das vollständige Gate aus:

```bash
npm run verify
```

Dieses führt die Abhängigkeitsprüfung, Typprüfungen, alle Testpartitionen, Linting, Identitätsvalidierung und Produktions-Builds aus.

## Sicherheits- und Datengrenzen

- Die Web-Authentifizierung verwendet ein `HttpOnly`-, `SameSite=Strict`-Cookie mit dauerhaftem Logout-Widerruf.
- Zugangsdaten werden nicht aus URL-Abfrageparametern akzeptiert. Externe Agent-API-Schlüssel verwenden den Header `X-API-Key`.
- Projektdateien werden über Prüfungen kanonischer Pfade und Symlinks aufgelöst; Schreibvorgänge verwenden atomaren Ersatz im selben Verzeichnis.
- Uploads verwenden private temporäre Verzeichnisse pro Anfrage, die nach Abschluss oder Fehler bereinigt werden.
- Electron verweigert Zielberechtigungen standardmäßig und beschränkt IPC auf registrierte Launcher-Frames.
- Sichern Sie `~/.gajae-app/data` vor Upgrades oder einer Host-Migration. Release-Wechsel müssen dieses Verzeichnis erhalten.

## Projektinformationen

- [Produktionsinstallation](docs/INSTALL.md)
- [Selbsthosting und Rollback](docs/SELF-HOST.md)
- [Upstream-Herkunft und selektive Übernahme](docs/UPSTREAM.md)
- [Mitwirken](CONTRIBUTING.md)
- [Issue-Tracker](https://github.com/devswha/gajae-app/issues)

<!-- upstream-lineage:start -->
Upstream lineage: Gajae App is derived from [CloudCLI UI](https://github.com/siteboon/claudecodeui). Required attribution and license terms are preserved in [LICENSE](LICENSE) and [NOTICE](NOTICE).
<!-- upstream-lineage:end -->

## Lizenz

[GNU AGPL v3](LICENSE)
