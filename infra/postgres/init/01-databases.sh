#!/bin/bash
# Each service owns one database and logs in with its own role, so a leaked Keycloak password
# cannot read Mission Control's data, and Mission Control cannot read QuirkBooks' tables except
# through QuirkBooks' API. Postgres runs this on the first start of an empty volume; npm run
# setup runs it again on every setup, so a service added later gets its database too. Every
# step checks first, so a second run changes nothing.
set -euo pipefail
for service in keycloak openfga teammates lmail ldrive quirkbooks; do
  var="$(echo "$service" | tr '[:lower:]' '[:upper:]')_DB_PASSWORD"
  psql -v ON_ERROR_STOP=1 --username postgres -v role="$service" -v password="${!var}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role') \gexec
ALTER ROLE :"role" PASSWORD :'password';
SELECT format('CREATE DATABASE %I OWNER %I', :'role', :'role') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'role') \gexec
REVOKE ALL ON DATABASE :"role" FROM PUBLIC;
SQL
done
# The tests' own database: npm run check creates and deletes rows here, never in the app's.
psql -v ON_ERROR_STOP=1 --username postgres <<'SQL'
SELECT 'CREATE DATABASE teammates_test OWNER teammates' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'teammates_test') \gexec
REVOKE ALL ON DATABASE teammates_test FROM PUBLIC;
SQL
