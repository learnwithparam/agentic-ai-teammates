#!/bin/bash
# Runs once, on the first start of an empty volume. Each service owns one database and logs in
# with its own role, so a leaked Keycloak password cannot read Mission Control's data, and
# Mission Control cannot read QuirkBooks' tables except through QuirkBooks' API.
set -euo pipefail
for service in keycloak openfga teammates; do
  var="$(echo "$service" | tr '[:lower:]' '[:upper:]')_DB_PASSWORD"
  psql -v ON_ERROR_STOP=1 --username postgres \
    -v role="$service" -v password="${!var}" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'password';
CREATE DATABASE :"role" OWNER :"role";
REVOKE ALL ON DATABASE :"role" FROM PUBLIC;
SQL
done
# The tests' own database: npm run check creates and deletes rows here, never in the app's.
psql -v ON_ERROR_STOP=1 --username postgres <<'SQL'
CREATE DATABASE teammates_test OWNER teammates;
REVOKE ALL ON DATABASE teammates_test FROM PUBLIC;
SQL
