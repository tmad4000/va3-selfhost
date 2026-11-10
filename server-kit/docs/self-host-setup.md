# Connect your own VA3 server

Each installation owns a dedicated VA3 server, data directory and OpenAI API key. An installation token grants full owner access to that server's drive API, including its conversations and any enabled automation. Tokens are device credentials, **not** separate users or tenant boundaries. Do not give access to an untrusted person. Use separate servers and data directories for independent owners.

## Initialize and start

Requirements: Node.js 20 or later, the server kit exported from the native app (or a checkout of this repository), your own OpenAI API key with access to the configured audio/realtime models, and a private HTTPS address reachable from your phone. No npm installation is needed. Run under a dedicated OS account on a host you control. Keep this checkout and data separate from any existing owner's installation.

In the native app, use **Share server kit** and transfer `VA3Server.zip` privately to your server. Extract it and open a terminal in the extracted directory. No private GitHub access or dependency installation is needed. The archive includes source, this guide, the setup CLI and a file-checksum manifest; it excludes API keys, local configuration, application data and the browser/admin frontend.

Choose a new absolute private data directory and an available port. The example paths are placeholders for your own host:

```sh
umask 077
export DATA_DIR="$HOME/va3-private-data"
export VA3_SELF_HOST=1
export HOST=127.0.0.1
export PORT=9471
node bin/va3-setup.mjs init --data-dir "$DATA_DIR"
node bin/va3-setup.mjs issue --data-dir "$DATA_DIR" --label "My iPhone"
```

`issue` prints JSON containing a new `token`, credential `id`, and stable `server_id`. Copy the token into the native app's connection settings along with **your server's HTTPS URL**. The token is shown once; it cannot be recovered from the registry. Keep that output out of logs, shell history, screenshots and shared documents. Issue another credential if lost. `init` preserves existing credentials; each `issue` creates a separate revocable credential.

Set `OPENAI_API_KEY` in the service's private environment (for an interactive test, `read -rs OPENAI_API_KEY; export OPENAI_API_KEY` reads without echoing). Do not put the key in a command argument or the native app. Then start:

```sh
node server/self-host.js
```

`VA3_SELF_HOST=1` must be in the process environment before startup. It requires an absolute `DATA_DIR`, ignores this checkout's `.env`, disables home-directory API-key fallbacks, and rejects legacy `DRIVE_TOKEN` / `DRIVE_TOKEN_FILE` authentication. Pass your own configuration explicitly through your service manager's environment. Never reuse another server's data directory. Back up the directory securely: its registry and application state belong to the server owner.

The default bind is loopback. Put a trusted HTTPS reverse proxy or private-network HTTPS service in front of this port; forward Authorization unchanged and allow streaming responses. Restrict access to your own devices, and expose only `/api/drive/` for native use. The standalone entry point serves only `/api/drive/`; browser/administration routes are unavailable. Do not expose the Node listener directly to the public Internet. Configure and verify the actual phone-reachable URL using your host's networking tools. This setup does not provision DNS, TLS, tunnels, or a public hosting account.

In the native app, save the HTTPS base URL and device token, then use its connection verification. It calls authenticated `GET /api/drive/hello`, which returns `ok`, `protocol_version: 1`, `server: {id, mode, access}`, `configuration.openai_key_configured`, `capabilities`, model names and server time. A 401 means the credential is absent, wrong, revoked, or belongs to another server. The key-configured flag confirms configuration presence; it does not make a paid model request or prove provider billing/model access. Test a short voice turn to verify those separately.

## Revoke or replace a device

```sh
node bin/va3-setup.mjs list --data-dir "$DATA_DIR"
node bin/va3-setup.mjs revoke --data-dir "$DATA_DIR" --id CREDENTIAL_ID
node bin/va3-setup.mjs issue --data-dir "$DATA_DIR" --label "Replacement iPhone"
```

Revocation is checked on every new request without a server restart. A request already in progress can finish. The list shows labels and IDs, never bearer tokens or hashes. Registry files are mode 0600 inside a mode 0700 `auth` directory. The server stores only SHA-256 digests bound to a random server ID; independent registries reject each other's generated tokens. Concurrent setup commands fail with a retry message rather than overwrite one another. A process crash while holding `.credentials.lock` requires the owner to confirm no setup process is running before removing that lock.

## Scope and compatibility

Standalone self-host mode provides the native drive conversation API and owner-supplied OpenAI access. Its portable default is `DRIVE_BRAIN=pipeline`: uploaded audio is sent directly as multipart audio to `/v1/audio/transcriptions`, text goes to `/v1/responses`, and speech is returned as MP3 from `/v1/audio/speech`. It needs no macOS audio-conversion tool. `/hello` reports `brain: "pipeline"` and `capabilities.realtime: false`. Model overrides are `DRIVE_TRANSCRIBE_MODEL`, `DRIVE_MODEL`, `DRIVE_TTS_MODEL` and `DRIVE_TTS_VOICE`; `/hello` reports the selected names. `DRIVE_OPENAI_API_BASE` optionally selects an owner-controlled OpenAI-compatible endpoint; its operator receives your configured API key and conversation content. Keep the official default unless you intend that. The legacy realtime path can be explicitly selected with `DRIVE_BRAIN=realtime` on macOS; it needs `/usr/bin/afconvert` and is not the portable Linux path. The existing Paseo coordinator relies on the original owner's local skill kit and operational environment, so it is unavailable in this mode and `/hello` reports `capabilities.coordinator: false`. Requests requiring it return an explicit unavailable error. Optional Ideaflow, Vision, feedback and agent integrations require their own configuration; no original owner's credentials are discovered. This is not a managed hosting or multi-tenant product.

Existing internal deployments without `VA3_SELF_HOST=1` retain their original environment loading and owner drive token. No live configuration is migrated by these commands. App signing/distribution and provider charges are separate from server setup. The standalone server kit does not serve app installation files.

Maintainers regenerate the native-bundled kit with `node bin/package-self-host.mjs` before building the app. The reviewed `bin/self-host-files.json` manifest is the source allowlist; newly added runtime dependencies must be reviewed and added explicitly. Archive names, metadata and content checksums are deterministic for the same source inputs. The generated `ios/Resources/VA3Server.zip` is gitignored; never package a raw checkout or working data directory. Packaging runs `bin/kit-leak-check.mjs` and fails on owner hostnames, paths, identities or credential shapes; owner-specific defaults belong in the never-packaged `config/owner-defaults.json`. The friend-facing cloud guide, landing page and release bundle are built by `bin/build-share-kit.mjs` (see `share/README.md`).
