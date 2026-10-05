#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
git diff --quiet && git diff --cached --quiet || { echo 'Commit changes before deploying.' >&2; exit 1; }
revision=$(git rev-parse --short HEAD)
build=$(mktemp -d /tmp/batty2-build.XXXXXX)
trap 'rm -rf "$build"' EXIT
git archive HEAD | tar -x -C "$build"
(
  cd "$build"
  pnpm install --frozen-lockfile
  pnpm check
  pnpm test
  BATTY_BUILD_ID="$revision" pnpm build
)
release="/opt/batty2/releases/${revision}.$(date +%s)"
mkdir -p "$release"
cp -a "$build"/{dist,package.json,pnpm-lock.yaml,pnpm-workspace.yaml,README.md} "$release/"
# Editing clients may keep the previous JS after the new worker activates.
# Retain immutable chunks so their lazy imports continue to work.
if [[ -d /opt/batty2/current/dist/client/assets ]]; then
  cp -an /opt/batty2/current/dist/client/assets/. "$release/dist/client/assets/"
fi
printf '%s\n' "$revision" > "$release/BUILD_ID"
(cd "$release" && pnpm install --prod --frozen-lockfile)
ln -sfn "$release" /opt/batty2/next
mv -Tf /opt/batty2/next /opt/batty2/current
install -m 755 scripts/batty2 /usr/local/bin/batty2
systemctl restart batty2.service
for attempt in {1..60}; do
  if curl --fail --silent http://127.0.0.1:3148/healthz; then exit 0; fi
  sleep 1
done
journalctl -u batty2.service -n 50 --no-pager
exit 1
