# 6 · Cloud-Dienste

Stack `cloud`: ein Postgres + Redis für alle, dazu Nextcloud, Paperless-ngx, CouchDB (Obsidian LiveSync), Guacamole und ein eigener Caddy.

```bash
cd stacks/cloud && docker compose up -d
```

Die Datenbanken legt `postgres-init/10-create-dbs.sh` beim **ersten** Start automatisch an (ein User + eine DB pro App, Passwörter aus `.env`).

## Nextcloud – `http://nextcloud.local`
- Admin: `ADMIN_USER` / `NEXTCLOUD_ADMIN_PASSWORD` aus `.env`
- Große Uploads (10 GB) sind in Caddy + PHP freigeschaltet
- Nach dem Start einmal: `docker exec -u www-data nextcloud php occ maintenance:repair --include-expensive`
- Hintergrundjobs per Cron: `*/5 * * * * docker exec -u www-data nextcloud php -f /var/www/html/cron.php`

## Paperless-ngx – `http://paperless.local`
- OCR auf Deutsch + Englisch
- **Trick:** Der Consume-Ordner ist der Nextcloud-Ordner `Paperless-Inbox`. Handy-Scan → in Nextcloud ablegen → Paperless liest es automatisch ein. Unterordner werden zu Tags.
- Läuft mit 1 Worker – reicht für ein Homelab und spart RAM

## Obsidian LiveSync – `http://obsidian.local`
1. CouchDB-Admin: `obsidian` / `COUCHDB_PASSWORD`
2. Beim ersten Start fehlen die System-DBs → einmal anlegen:
   ```bash
   for db in _users _replicator _global_changes; do curl -u obsidian:$COUCHDB_PASSWORD -X PUT http://<ip>/$db -H "Host: obsidian.local"; done
   ```
3. In Obsidian: Community-Plugin „Self-hosted LiveSync“ → URI `http://obsidian.local`, User/Passwort von oben, Datenbank z. B. `vault`
4. Unterwegs über Tailscale: URI `http://<cloud-ip>` mit Host-Header geht nicht in der App → dort die IP der Cloud-VM in Caddy zusätzlich eintragen

## Guacamole – `http://guacamole.local`
- Remote-Desktop/SSH im Browser, **TOTP (2FA) erzwungen**
- Erster Login: `guacadmin` / `guacadmin` → sofort eigenen Admin anlegen, `guacadmin` löschen
- `host/agent/guac-sync.py` legt automatisch SSH-Verbindungen für alle Proxmox-Knoten, VMs und LXCs an (Timer alle 5 min auf einem Proxmox-Knoten)

## Speicher

| Pfad | Inhalt |
|---|---|
| `${APPDATA}/postgres` | Datenbanken |
| `${APPDATA}/nextcloud` | Nextcloud-Programm + Config |
| `${CLOUD_DATA}/nextcloud` | Nutzerdateien (bei mir eine zweite VM-Platte auf der NAS) |
| `${CLOUD_DATA}/paperless` | Dokumente + Export |
