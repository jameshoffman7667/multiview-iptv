# Pending changes

Requests logged here are not built yet. Say "build" to fold them into a new version
(version number goes up, CHANGELOG.md is updated, this list is cleared), and "push" to upload to GitHub.

Current released version: 0.1.0

1. Change the default port from 8080 to 1234 (app default, Dockerfile, docker-compose.yml, stack.yml, README).
2. Data folder as an environment variable. `DATA_DIR` already sets the folder inside the container (default `/data`); add a matching variable in docker-compose.yml and stack.yml so the host folder or volume is also set by an env variable (`DATA_PATH`, default the `iptv-data` named volume), and document both in the README.
