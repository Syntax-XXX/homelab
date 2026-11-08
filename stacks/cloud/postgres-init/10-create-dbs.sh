#!/bin/sh
# Runs once on first database init: one Postgres for all apps, one user + DB each.
# Passwörter kommen aus der Umgebung und werden von psql sicher gequotet (:'pw').
set -e
for app in nextcloud paperless guacamole; do
  pw_var=$(echo "${app}_DB_PASS" | tr a-z A-Z)
  pw=$(printenv "$pw_var")
  [ -n "$pw" ] || { echo "$pw_var ist leer" >&2; exit 1; }
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -v app="$app" -v pw="$pw" <<'SQL'
CREATE USER :"app" WITH PASSWORD :'pw';
CREATE DATABASE :"app" OWNER :"app";
SQL
done
