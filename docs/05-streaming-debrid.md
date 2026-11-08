# 5 · Streaming mit Debrid („Stremio, aber in Jellyfin“)

> ⚖️ **Rechtlicher Hinweis:** Debrid-Dienste laden Torrents auf ihre Server und geben dir einen Direktlink. Ob das Streamen bestimmter Inhalte in deinem Land erlaubt ist, musst du selbst prüfen. Diese Anleitung erklärt nur die Technik.

## Idee

Statt alles herunterzuladen, zeigt Jellyfin ganze Kataloge (Netflix, Disney+, Prime, Trending …) als normale Bibliotheken an. Beim Abspielen holt Jellyfin den Stream direkt vom Debrid-Dienst – **gestartet in Sekunden**, ohne Download auf deinen Server.

| Baustein | Aufgabe |
|---|---|
| **AllDebrid** (oder Real-Debrid, TorBox …) | Premium-Account, cached Torrents |
| **Comet** | sucht Torrents (Torrentio, Zilean, Prowlarr), prüft Cache beim Debrid-Dienst |
| **StremThru** | eigener Proxy zum Debrid-Dienst (öffentliche Instanzen werden von manchen Diensten gesperrt) |
| **AIOStreams** | bündelt viele Stremio-Addons zu einem, sortiert/formatiert Ergebnisse |
| **Streamfilter** | kleiner Proxy (dieses Repo): reicht nur ⚡-Streams (sofort abspielbar) an Jellyfin weiter |
| **Gelato** (Jellyfin-Plugin) | macht aus Stremio-Katalogen Jellyfin-Bibliotheken und spielt Streams ab |

## Einrichtung

### 1. Stack starten
```bash
cd stacks/streaming
# comet.env: PROWLARR_API_KEY eintragen (Prowlarr → Settings → General)
docker compose up -d
```

### 2. AIOStreams – `http://aiostreams.local/stremio/configure`
1. **Services**: AllDebrid aktivieren, API-Key eintragen (alldebrid.com → API-Keys).
   - AllDebrid verlangt bei neuen IPs eine Bestätigung per Mail („new location“) – einmal klicken.
2. **Addons**: Comet (eigene Instanz `http://comet:8000` ist per `COMET_URL` vorkonfiguriert), Torrentio, MediaFusion, Meteor … nach Geschmack
3. **Filters**: „Exclude uncached“ – optional, der Streamfilter macht das ohnehin
4. **Catalogs**: Cinemeta (Popular/Featured), Streaming-Kataloge (Netflix, Disney+, Prime, Apple TV+, HBO)
5. **Speichern** → Passwort vergeben → du bekommst eine Manifest-URL:
   `http://<ip>:3100/stremio/<uuid>/<token>/manifest.json`

### 3. Gelato in Jellyfin
1. Jellyfin → Dashboard → Plugins → Repositories → Gelato-Repo hinzufügen → Plugin installieren → Jellyfin neu starten
2. Plugin-Einstellungen:
   - **URL**: die Manifest-URL, aber mit Port **3101** (Streamfilter) statt 3100
   - Pfade: `/config/gelato/movies` und `/config/gelato/series`
   - **Playback Failover**: an (springt zum nächsten Stream, wenn einer nicht startet)
3. Zwei Bibliotheken anlegen: „Streams Filme“ → `/config/gelato/movies`, „Streams Serien“ → `/config/gelato/series`
4. Plugin → Catalogs → gewünschte Kataloge aktivieren → „Import all“
5. Geplante Aufgabe **„Import Catalogs“** bekommt standardmäßig keinen Trigger → täglich (z. B. 05:00) einstellen, sonst kommen keine neuen Titel dazu

> Der erste Import (hunderte Filme, zehntausende Folgen) braucht viel CPU. `JELLYFIN_CPUS` in `.env` begrenzt Jellyfin, damit der Rest flüssig bleibt.

## Streamfilter

`stacks/streaming/streamfilter/server.js` – 30 Zeilen Node, keine Abhängigkeiten. Er reicht alle Anfragen an AIOStreams durch, filtert aber bei `/stream/…` alle Einträge ohne ⚡ im Namen heraus. Ergebnis z. B. South Park S01E01: **118 → 31 Streams, alle sofort abspielbar**.

Anderes Kriterium? `KEEP` als Regex setzen, z. B. `KEEP="⚡.*(1080p|2160p)"`.

## Fehlersuche

| Symptom | Ursache / Lösung |
|---|---|
| „Invalid API key“ in Comet | Debrid-Dienst blockt öffentliche StremThru-IP → eigener StremThru (ist im Stack) |
| Nur ⏳-Ergebnisse, nichts startet | Container haben kein DNS (Docker vor dem Netzwerk gestartet) → `daemon.json` mit festen DNS-Servern |
| `ffprobe failed` / FFmpeg 251 | Debrid-Link nicht erreichbar → DNS im Jellyfin-Container prüfen: `docker exec jellyfin getent hosts google.com` |
| StremThru wird OOM-gekillt | Hintergrund-Features abschalten (`STREMTHRU_FEATURE`, siehe compose) + `GOMEMLIMIT` |
| Neue Addons tauchen nicht auf | Gelato cached das Manifest 12 h → Jellyfin neu starten |
