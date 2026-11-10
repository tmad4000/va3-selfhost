# VA3 owner-run server

This kit contains the server source needed to connect VA3 Drive to your own dedicated server. No repository account or npm installation is needed. You need Node.js 20+, your own OpenAI API key and private HTTPS hosting reachable by your phone.

Read docs/self-host-setup.md for the complete setup, credential issuance and revocation instructions. Run from this extracted directory. Start with npm start (or node server/self-host.js); that entry point forces isolated self-host mode. DATA_DIR must be an explicit absolute private directory.

Do not use another person's server URL, API key or device token. A device credential grants owner access to this dedicated server, not a separate tenant. Coordinator automation is unavailable in standalone mode. Legacy integration source is included as a runtime dependency; its original operational defaults are not self-host configuration.

SHA256SUMS lists the packaged files so you can verify extraction with sha256sum -c SHA256SUMS (Linux) or shasum -a 256 -c SHA256SUMS (macOS). This verifies integrity, not publisher identity.
