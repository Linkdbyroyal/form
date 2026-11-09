#!/bin/bash
# Creates the test database next to the dev database on first container start.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE sbos_test OWNER sbos;
EOSQL
