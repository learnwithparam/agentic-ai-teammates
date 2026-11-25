#!/usr/bin/env bash
# CI runs the tests against the real services, started from the same compose file as the
# workshop, with throwaway secrets. Keycloak is not needed: tests that need tokens sign their own.
set -euo pipefail
umask 077
settings=.env
for name in POSTGRES_PASSWORD KEYCLOAK_DB_PASSWORD OPENFGA_DB_PASSWORD TEAMMATES_DB_PASSWORD LMAIL_DB_PASSWORD LDRIVE_DB_PASSWORD QUIRKBOOKS_DB_PASSWORD KEYCLOAK_ADMIN_PASSWORD FGA_API_TOKEN S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  value="$(openssl rand -hex 24)"
  echo "::add-mask::$value"
  echo "$name=$value" >> "$settings"
done
teammates="$(grep '^TEAMMATES_DB_PASSWORD=' "$settings" | cut -d= -f2)"
echo "TEST_DATABASE_URL=postgresql://teammates:$teammates@localhost:5452/teammates_test" >> "$settings"
docker compose --env-file "$settings" -f infra/docker-compose.yml up -d --wait postgres openfga minio
