# 4 · Media-Stack einrichten

Stacks: `media-server` (Jellyfin, Seerr), `media-management` (Prowlarr, Sonarr, Radarr, Bazarr), `downloaders` (qBittorrent, MediathekArr). Alle hängen im Docker-Netz `media` und erreichen sich **per Containername** (`http://sonarr:8989`).

```bash
docker network create media   # macht setup.sh
for s in media-server media-management downloaders; do (cd stacks/$s && docker compose up -d); done
```

## Schritt für Schritt

### 1. qBittorrent – `http://qbittorrent.local`
- Startpasswort: `docker logs qbittorrent | grep -i password`
- **Tools → Optionen → WebUI**: eigenes Passwort setzen
- **Downloads**: Standardpfad `/data/downloads/complete`, unvollständige in `/data/downloads/incomplete`
- **Verbindung**: Port 6881 (TCP+UDP)

### 2. Automatische Einrichtung der *arr-Apps

Nach dem ersten Start von Sonarr/Radarr/Prowlarr (einmal Webseite öffnen, Login „Forms“ + Passwort setzen):

```bash
QBIT_USER=admin QBIT_PASS='dein-qbit-passwort' ./presets/arr-bootstrap.sh
```

Das Skript setzt:

| App | Einstellung |
|---|---|
| Sonarr | Root-Ordner `/data/library/tv`, qBittorrent (Kategorie `tv-sonarr`) |
| Radarr | Root-Ordner `/data/library/movies`, qBittorrent (Kategorie `radarr`) |
| Prowlarr | Sonarr + Radarr als Apps → Indexer werden automatisch verteilt |

### 3. Prowlarr – `http://prowlarr.local`
- **Indexers → Add**: öffentliche Indexer (z. B. YTS, The Pirate Bay, Nyaa, LimeTorrents, Knaben) oder deine privaten Tracker
- Nach dem Speichern landen sie automatisch in Sonarr/Radarr

### 4. Sonarr / Radarr – Empfehlungen
- **Settings → Media Management**: „Rename Episodes/Movies“ an, **Use Hardlinks** an
- **Profiles**: Für Deutsch ein eigenes Profil mit Sprache „German“ (Radarr) bzw. Custom Format „German DL“
- **Anime**: In Sonarr Serien-Typ „Anime“ und Root-Ordner `/data/library/anime`

### 5. Jellyfin – `http://jellyfin.local`
- Setup-Assistent: Admin anlegen, Sprache Deutsch
- **Bibliotheken**:

  | Name | Typ | Ordner |
  |---|---|---|
  | Filme | Filme | `/data/library/movies` |
  | Serien | Serien | `/data/library/tv` |
  | Anime | Serien | `/data/library/anime` |
  | Dokus | Gemischt | `/data/library/docs` |
- **Dashboard → Wiedergabe**: Hardware-Beschleunigung, wenn eine GPU/iGPU durchgereicht ist (VAAPI für AMD/Intel)
- Jellyfin-API-Header für Skripte: `Authorization: MediaBrowser Token="<api-key>"` (nicht `X-Emby-Token`)

### 6. Seerr – `http://seerr.local`
- „Use Jellyfin“ → `http://jellyfin:8096` → mit Jellyfin-Admin anmelden
- Sonarr: `http://sonarr:8989` + API-Key (Sonarr → Settings → General), Root `/data/library/tv`
- Radarr: `http://radarr:7878` + API-Key, Root `/data/library/movies`
- Ab jetzt: Wunsch in Seerr → Sonarr/Radarr sucht → qBittorrent lädt → Jellyfin zeigt es an

### 7. Bazarr – `http://bazarr.local`
- Sonarr/Radarr verbinden (gleiche URLs + API-Keys)
- Sprachen: Deutsch, Englisch · Anbieter: OpenSubtitles.com (kostenloser Account), Subscene, Addic7ed

### 8. MediathekArr – `http://mediathekarr.local`
Holt Sendungen aus ARD/ZDF-Mediatheken als „Indexer + Download-Client“ in Sonarr. In Sonarr als Torznab-Indexer `http://mediathekarr:5007/api` und als SABnzbd-Downloader eintragen (siehe Projekt-Readme).

## Typische Fehler

| Problem | Lösung |
|---|---|
| Container starten nicht: `open /srv/media/data: no such file` | Datenplatte war beim Docker-Start nicht eingehängt → `RequiresMountsFor=` (siehe [Proxmox](03-proxmox.md)) |
| Sonarr findet Downloads nicht | Pfade müssen in qBittorrent **und** Sonarr `/data/...` heißen |
| Kopieren statt Hardlink | Downloads und Bibliothek liegen auf verschiedenen Dateisystemen |
| Healthcheck „unhealthy“ ohne echten Fehler | Healthcheck fragt etwas ab, das Internet braucht (z. B. GitHub-Versionscheck) → lokalen Endpunkt nehmen |
