#!/usr/bin/env bash
# Richtet die *arr-Apps nach dem ersten Start automatisch ein:
#   - Sonarr:  Root-Ordner /data/library/tv      + qBittorrent (Kategorie tv-sonarr)
#   - Radarr:  Root-Ordner /data/library/movies  + qBittorrent (Kategorie radarr)
#   - Prowlarr: Sonarr + Radarr als "Apps" -> Indexer werden automatisch synchronisiert
# Voraussetzung: Stacks media-management + downloaders laufen, qBittorrent-Login ist gesetzt.
#   QBIT_USER=admin QBIT_PASS=... ./presets/arr-bootstrap.sh
# Das qBittorrent-Startpasswort steht im Log: docker logs qbittorrent | grep -i password
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
: "${QBIT_USER:?QBIT_USER setzen}" "${QBIT_PASS:?QBIT_PASS setzen}"
H=${HOST_IP:-127.0.0.1}

key() { sudo sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' "$APPDATA/$1/config.xml"; }
api() { # api <port> <apikey> <method> <path> [json]
  curl -fsS -X "$3" "http://$H:$1/api/$4" -H "X-Api-Key: $2" -H 'Content-Type: application/json' ${5:+-d "$5"}
}
has() { python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if any($1 for x in d) else 1)"; }

SONARR=$(key sonarr); RADARR=$(key radarr); PROWLARR=$(key prowlarr)
[ -n "$SONARR" ] && [ -n "$RADARR" ] && [ -n "$PROWLARR" ] || { echo "API-Keys nicht gefunden – laufen die Apps schon einmal?"; exit 1; }

qbit() { # $1 = category field name, $2 = category
  cat <<JSON
{"enable":true,"protocol":"torrent","priority":1,"name":"qBittorrent","implementation":"QBittorrent","configContract":"QBittorrentSettings",
 "fields":[{"name":"host","value":"qbittorrent"},{"name":"port","value":8080},{"name":"useSsl","value":false},
           {"name":"username","value":"$QBIT_USER"},{"name":"password","value":"$QBIT_PASS"},{"name":"$1","value":"$2"}]}
JSON
}

echo "== Sonarr"
api 8989 "$SONARR" GET v3/rootfolder | has 'x["path"]=="/data/library/tv"' || api 8989 "$SONARR" POST v3/rootfolder '{"path":"/data/library/tv"}' >/dev/null && echo "  Root-Ordner ok"
api 8989 "$SONARR" GET v3/downloadclient | has 'x["implementation"]=="QBittorrent"' || api 8989 "$SONARR" POST v3/downloadclient "$(qbit tvCategory tv-sonarr)" >/dev/null && echo "  qBittorrent ok"

echo "== Radarr"
api 7878 "$RADARR" GET v3/rootfolder | has 'x["path"]=="/data/library/movies"' || api 7878 "$RADARR" POST v3/rootfolder '{"path":"/data/library/movies"}' >/dev/null && echo "  Root-Ordner ok"
api 7878 "$RADARR" GET v3/downloadclient | has 'x["implementation"]=="QBittorrent"' || api 7878 "$RADARR" POST v3/downloadclient "$(qbit movieCategory radarr)" >/dev/null && echo "  qBittorrent ok"

echo "== Prowlarr -> Apps"
app() { # name impl port key
  cat <<JSON
{"name":"$1","syncLevel":"fullSync","implementation":"$2","configContract":"${2}Settings",
 "fields":[{"name":"prowlarrUrl","value":"http://prowlarr:9696"},{"name":"baseUrl","value":"http://$(echo "$1" | tr A-Z a-z):$3"},{"name":"apiKey","value":"$4"}]}
JSON
}
api 9696 "$PROWLARR" GET v1/applications | has 'x["implementation"]=="Sonarr"' || api 9696 "$PROWLARR" POST v1/applications "$(app Sonarr Sonarr 8989 "$SONARR")" >/dev/null && echo "  Sonarr verknüpft"
api 9696 "$PROWLARR" GET v1/applications | has 'x["implementation"]=="Radarr"' || api 9696 "$PROWLARR" POST v1/applications "$(app Radarr Radarr 7878 "$RADARR")" >/dev/null && echo "  Radarr verknüpft"

echo
echo "Fertig. Jetzt noch in Prowlarr Indexer hinzufügen (Indexers -> Add) – sie landen automatisch in Sonarr/Radarr."
echo "Seerr: http://$H:5055 -> mit Jellyfin anmelden -> Sonarr/Radarr mit den API-Keys oben verbinden."
