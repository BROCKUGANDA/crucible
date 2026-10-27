#!/bin/sh
# Configure the CDP CLI profile from the environment, then start the funder.
#
# The funder's `cdpApi` runs `cdp api ... -e <env>`, which reads the CLI's own profile. On a
# host where `cdp env` was run by hand that profile exists; in a fresh container it does not,
# so this configures it from the same variables the funder validates. With no credentials the
# profile is left alone and the funder starts in its honest unconfigured state.
set -eu
cd /repo

env_name="${CDP_ENV:-sandbox}"
if [ "$env_name" = "live" ]; then
  key_id="${CDP_LIVE_API_KEY_ID:-}"
  key_secret="${CDP_LIVE_API_KEY_SECRET:-}"
  key_file="${CDP_LIVE_API_KEY_FILE:-}"
  # Mirrors cdpConfig (apps/funder/src/cdp.ts): the CLI profile needs the base
  # URL registered or every `cdp api -e live` call fails with "no URL". Live
  # happens to be a CLI built-in; sandbox is not, so set both explicitly.
  base_url="${CDP_LIVE_BASE_URL:-https://api.cdp.coinbase.com/platform/v2}"
else
  key_id="${CDP_SANDBOX_API_KEY_ID:-}"
  key_secret="${CDP_SANDBOX_API_KEY_SECRET:-}"
  key_file="${CDP_SANDBOX_API_KEY_FILE:-}"
  base_url="${CDP_SANDBOX_BASE_URL:-https://sandbox.cdp.coinbase.com}"
fi

# `cdpConfig` (apps/funder/src/cdp.ts) accepts the generic CDP_API_KEY_FILE when the
# per-environment name is empty. The entrypoint has to read the same variables, or the
# process reports `configured:true` and then calls a CLI with no profile.
[ -n "$key_file" ] || key_file="${CDP_API_KEY_FILE:-}"

if [ -n "$key_file" ] && [ -f "$key_file" ]; then
  cdp env "$env_name" --key-file "$key_file" --url "$base_url" --plaintext >/dev/null 2>&1 \
    || echo "[funder] could not configure CDP from $key_file; money paths will refuse" >&2
elif [ -n "$key_id" ] && [ -n "$key_secret" ]; then
  cdp env "$env_name" --key-id "$key_id" --key-secret "$key_secret" --url "$base_url" --plaintext >/dev/null 2>&1 \
    || echo "[funder] could not configure the CDP profile; money paths will refuse" >&2
else
  echo "[funder] no CDP credentials in the environment; starting unconfigured" >&2
fi

exec node apps/funder/dist/server.js
