#!/bin/sh
# Runs once on first database init: one Postgres for all apps, one user + DB each.
set -e
for app in nextcloud paperless guacamole; do
  pw_var=$(echo "${app}_DB_PASS" | tr a-z A-Z); pw=$(eval echo "\$$pw_var")
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" <<SQL
CREATE USER $app WITH PASSWORD '$pw';
CREATE DATABASE $app OWNER $app;
SQL
done
