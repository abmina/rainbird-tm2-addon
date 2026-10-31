#!/usr/bin/with-contenv sh
# with-contenv restores the container environment (SUPERVISOR_TOKEN, TZ) that
# s6-overlay strips from the CMD process on Home Assistant base images.
set -e
export DATA_DIR=/data
export HTTP_PORT=8099
cd /app
exec node src/main.js
