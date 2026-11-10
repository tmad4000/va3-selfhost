# Run your own VA3 server on a cloud VM

This guide sets up a private **Voice Assistant 3 (VA3)** server on a small Linux VM that you own, for use with the **VA3 Drive** iPhone app. Everything runs under your accounts: your VM, your OpenAI API key and billing, and your data directory. Nothing is sent to the person who shared this kit, and the kit contains none of their keys, hosts or data.

The steps are provider-neutral and tested against **Ubuntu 24.04 LTS**. Any provider works (Hetzner, GCP, AWS Lightsail, DigitalOcean, a home server).

Kit version: **0.28.1-r2** · Release: https://github.com/tmad4000/va3-selfhost/releases/tag/v0.28.1-r2

---

## What you need

- A Linux VM: 1 vCPU and 1 GB RAM are enough (the server is a single Node.js process with no dependencies). Ubuntu 24.04 LTS.
- An **OpenAI API key** on your own account, with billing enabled and access to the speech and text models listed under [Costs](#costs).
- An iPhone with **VA3 Drive** (TestFlight invite from whoever shared this kit).
- One way to give the phone an HTTPS address:
  - **Option A, Tailscale Serve (recommended, private):** a free Tailscale account. Only devices in your tailnet can reach the server; no domain or open ports.
  - **Option B, Caddy + a domain (public HTTPS):** a domain or subdomain you control pointed at the VM, with ports 80 and 443 open. Anyone on the Internet can reach the endpoint, though every request still needs a device token.

### Example VM

Any of these is fine. Prices change; check the provider.

- **Hetzner Cloud:** CX22 (2 vCPU, 4 GB), Ubuntu 24.04, roughly €4–5/month.
- **Google Cloud:** `e2-small` (or `e2-micro`, which is free-tier eligible in some US regions), Ubuntu 24.04 LTS:

  ```sh
  gcloud compute instances create va3 \
    --zone=us-west1-b --machine-type=e2-small \
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud
  gcloud compute ssh va3 --zone=us-west1-b
  ```

  With Tailscale Serve you need no firewall rule. For Caddy, allow TCP 80 and 443 to the VM.

Everything below runs on the VM over SSH.

---

## 1. Install Node.js 20+ and tools

Ubuntu 24.04's own `nodejs` package is too old (v18). Install Node 22 LTS from NodeSource:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl unzip
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
less /tmp/nodesource_setup.sh          # review before running
sudo bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
node --version                          # must print v20 or later
```

## 2. Create a dedicated user and directories

The server runs as an unprivileged `va3` account. Code lives in `/opt/va3`, private data in `/var/lib/va3`, and the API key in `/etc/va3/va3.env`.

```sh
sudo useradd --system --home /var/lib/va3 --shell /usr/sbin/nologin va3
sudo install -d -o root -g root -m 0755 /opt/va3/releases
sudo install -d -o va3  -g va3  -m 0700 /var/lib/va3
sudo install -d -o root -g root -m 0700 /etc/va3
```

## 3. Download, verify and extract the kit

```sh
VA3_VERSION=0.28.1-r2
cd /tmp
curl -fLO https://github.com/tmad4000/va3-selfhost/releases/download/v0.28.1-r2/VA3Server-$VA3_VERSION.zip
curl -fLO https://github.com/tmad4000/va3-selfhost/releases/download/v0.28.1-r2/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS      # must print: VA3Server-...zip: OK

sudo unzip -q VA3Server-$VA3_VERSION.zip -d /opt/va3/releases/$VA3_VERSION
cd /opt/va3/releases/$VA3_VERSION && sudo sha256sum -c --quiet SHA256SUMS && echo "kit files OK"
sudo ln -sfn /opt/va3/releases/$VA3_VERSION /opt/va3/current
```

If you received the zip some other way (for example from the app's **How to set up a server → Export VA3 server kit**), copy it to `/tmp` with `scp` and skip the two `curl` lines. The checksum confirms the download is intact; it does not prove who published it, so get the zip from a source you trust.

## 4. Initialize the server and issue a phone token

```sh
sudo -u va3 env VA3_SELF_HOST=1 DATA_DIR=/var/lib/va3 \
  node /opt/va3/current/bin/va3-setup.mjs init --data-dir /var/lib/va3

sudo -u va3 env VA3_SELF_HOST=1 DATA_DIR=/var/lib/va3 \
  node /opt/va3/current/bin/va3-setup.mjs issue --data-dir /var/lib/va3 --label "My iPhone"
```

`issue` prints JSON with a `token`. **It is shown only once.** Move it to your phone privately (for example through your own password manager) and don't paste it into chats, screenshots or documents. If you lose it, issue another one. Each token is a full-access key to *this* server, so issue one per device.

## 5. Store your OpenAI key (EnvironmentFile, mode 0600)

```sh
sudo install -o root -g root -m 0600 /dev/null /etc/va3/va3.env
read -rsp "OpenAI API key: " KEY; echo
printf 'OPENAI_API_KEY=%s\n' "$KEY" | sudo tee /etc/va3/va3.env >/dev/null; unset KEY
sudo tee -a /etc/va3/va3.env >/dev/null <<'EOF'
VA3_SELF_HOST=1
DATA_DIR=/var/lib/va3
HOST=127.0.0.1
PORT=9471
EOF
sudo chmod 600 /etc/va3/va3.env
```

`read -s` keeps the key out of your shell history and off the screen. systemd reads this file as root before it starts the service, so the `va3` user never needs read access to it.

Optional: add `VA3_OWNER_NAME=YourName` so the assistant addresses you by name (default: neutral wording). Other overrides (see `docs/self-host-setup.md` inside the kit): `DRIVE_MODEL`, `DRIVE_TRANSCRIBE_MODEL`, `DRIVE_TTS_MODEL`, `DRIVE_TTS_VOICE`. Leave all other integrations unset; they are off unless configured.

## 6. Run it with systemd

```sh
sudo tee /etc/systemd/system/va3.service >/dev/null <<'EOF'
[Unit]
Description=VA3 owner-run server (VA3 Drive API)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=va3
Group=va3
EnvironmentFile=/etc/va3/va3.env
WorkingDirectory=/opt/va3/current
ExecStart=/usr/bin/node /opt/va3/current/server/self-host.js
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/va3
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now va3
journalctl -u va3 -n 20 --no-pager     # expect: listening at http://localhost:9471/
```

If the log shows a different port (9471 was busy), use that port below or change `PORT`.

The server listens on **loopback only**. Never expose port 9471 directly; put one of the HTTPS options in front.

## 7. Give it an HTTPS address

### Option A: Tailscale Serve (recommended)

```sh
curl -fsSL https://tailscale.com/install.sh -o /tmp/tailscale-install.sh
less /tmp/tailscale-install.sh          # review before running
sudo sh /tmp/tailscale-install.sh
sudo tailscale up                        # follow the login link once
sudo tailscale serve --bg 9471
tailscale serve status                   # shows https://<vm-name>.<your-tailnet>.ts.net
```

Enable HTTPS certificates for your tailnet if Tailscale asks (admin console → DNS → HTTPS Certificates). Install the **Tailscale** app on your iPhone, sign in to the same account and keep it connected. Your server URL is the `https://…ts.net` address that `tailscale serve status` prints. Do **not** use `tailscale funnel`; that would make it public.

### Option B: Caddy + your domain

Point a DNS `A`/`AAAA` record (e.g. `va3.example.com`) at the VM, open ports 80/443, then:

```sh
sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
va3.example.com {
	handle /api/drive/* {
		reverse_proxy 127.0.0.1:9471 {
			flush_interval -1
		}
	}
	handle {
		respond 404
	}
}
EOF
sudo systemctl reload caddy
```

Caddy obtains and renews the TLS certificate automatically. Only `/api/drive/` is forwarded, and the `Authorization` header passes through unchanged.

## 8. Verify

From the VM (or any device that can reach the URL):

```sh
read -rsp "Device token: " TOKEN; echo
curl -fsS -H "Authorization: Bearer $TOKEN" https://YOUR-SERVER/api/drive/hello; echo; unset TOKEN
```

Expected: JSON with `"ok": true`, `"protocol_version": 1`, `"server": {"mode": "selfhost", …}` and `"configuration": {"openai_key_configured": true}`. A `401` means the token is missing, wrong or revoked.

Then on the iPhone: open **VA3 Drive → Set up VA3 → Connect your server**, enter the HTTPS URL and token, and tap **Verify and connect**. Finish with a short spoken test turn; that is the first real (billed) OpenAI request.

---

## Costs

You pay your VM provider and OpenAI directly. Nobody else is billed and nobody else sees your usage.

- **VM:** about €4–15/month depending on the provider and size (free-tier VMs can work).
- **OpenAI:** each spoken turn makes three API calls: transcription (`gpt-transcribe` by default), a text reply (`gpt-5.5` by default) and speech synthesis (`gpt-4o-mini-tts`). Casual daily use typically costs a few dollars a month; long sessions cost more. Set a **monthly budget limit** in the OpenAI dashboard (Settings → Limits) before you start, and choose cheaper models with `DRIVE_MODEL` etc. if you like.
- **Tailscale:** the free personal plan is enough.

## Privacy model

- Audio, transcripts and memory are stored only in `/var/lib/va3` on your VM, and processed by OpenAI under your API account and its data policy.
- The kit has no telemetry and no connection to the person who shared it. Optional integrations in the source (feedback trackers, note apps, agent coordination) stay off unless you configure their keys yourself; the coordinator feature is unavailable in self-host mode.
- Device tokens are stored only as SHA-256 digests bound to a random server ID (`/var/lib/va3/auth`, mode 0600).

## Revoke a phone

```sh
sudo -u va3 env VA3_SELF_HOST=1 DATA_DIR=/var/lib/va3 node /opt/va3/current/bin/va3-setup.mjs list   --data-dir /var/lib/va3
sudo -u va3 env VA3_SELF_HOST=1 DATA_DIR=/var/lib/va3 node /opt/va3/current/bin/va3-setup.mjs revoke --data-dir /var/lib/va3 --id CREDENTIAL_ID
```

Revocation takes effect on the next request; no restart needed. If the **OpenAI key** leaks, revoke it in the OpenAI dashboard, update `/etc/va3/va3.env` and run `sudo systemctl restart va3`.

## Update to a new kit version

```sh
VA3_VERSION=NEW_VERSION
cd /tmp && curl -fLO https://github.com/tmad4000/va3-selfhost/releases/download/v$VA3_VERSION/VA3Server-$VA3_VERSION.zip \
  && curl -fLO https://github.com/tmad4000/va3-selfhost/releases/download/v$VA3_VERSION/SHA256SUMS \
  && sha256sum -c --ignore-missing SHA256SUMS
sudo unzip -q VA3Server-$VA3_VERSION.zip -d /opt/va3/releases/$VA3_VERSION
sudo ln -sfn /opt/va3/releases/$VA3_VERSION /opt/va3/current
sudo systemctl restart va3 && journalctl -u va3 -n 5 --no-pager
```

Data in `/var/lib/va3` and your tokens carry over. To roll back, point `/opt/va3/current` at the previous release directory and restart.

## Back up

`/var/lib/va3` holds everything (conversations, memory, token registry). Back it up privately, e.g. `sudo tar -C /var/lib -czf va3-backup.tgz va3`, and keep it as private as the conversations themselves.

## Uninstall

```sh
sudo systemctl disable --now va3
sudo rm /etc/systemd/system/va3.service && sudo systemctl daemon-reload
sudo tailscale serve reset                # if you used Option A
sudo rm -rf /opt/va3 /etc/va3
sudo rm -rf /var/lib/va3                  # deletes your conversations and tokens; back up first if needed
sudo userdel va3
```

Then revoke the OpenAI key in your OpenAI dashboard if you no longer need it, and delete the VM.

## Troubleshooting

- `journalctl -u va3 -f` shows server logs (never tokens or keys).
- `Set your own OPENAI_API_KEY…` at startup: `/etc/va3/va3.env` is missing the key.
- `VA3_SELF_HOST=1 requires an explicit absolute DATA_DIR`: set `DATA_DIR=/var/lib/va3`.
- The phone can't connect over Tailscale: make sure the iPhone's Tailscale app is connected and `tailscale serve status` lists port 9471.
- Spoken turns fail but `/hello` works: check OpenAI billing and model access for the default models, or override them.
