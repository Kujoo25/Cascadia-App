#!/bin/sh
# Container entrypoint for the app and jobs-worker images.
#
# The server resolves its static root as `dist/$APP`, and both images' default
# commands name `.output/$APP/…`, so the process needs the name of the app the
# image was built for. The builder stage records it in `.edition` (see the
# Dockerfiles); this exports it unless the caller already set APP, and then
# hands off to dumb-init so signals are still forwarded properly. Every
# command runs through here — the default CMD and a compose `command:` alike —
# so a custom command gets the same APP the default one would.
set -e
if [ -z "$APP" ] && [ -f /app/.edition ]; then
  APP="$(cat /app/.edition)"
  export APP
fi
exec dumb-init -- "$@"
