# VA3 self-host kit

Run your own private **Voice Assistant 3 (VA3)** server for the **VA3 Drive** iPhone app: your VM, your OpenAI API key, your data. Nothing is sent to the kit's author.

- **Landing page:** `index.html` (published with GitHub Pages)
- **Step-by-step cloud guide:** [cloud-setup.md](cloud-setup.md)
- **Server kit download (v0.28.1-r2):** https://github.com/tmad4000/va3-selfhost/releases/download/v0.28.1-r2/VA3Server-0.28.1-r2.zip, verify with `SHA256SUMS`
- **Server kit source, browsable:** [`server-kit/`](server-kit/) (identical to the zip contents; see `server-kit/SHA256SUMS`)
- **Reference docs inside the kit:** `server-kit/docs/self-host-setup.md`

This repository is generated from a reviewed allowlist and a leak check; it is not the development repository and does not accept pull requests. The source under `server-kit/` includes some legacy integration modules that stay disabled in self-host mode (`server/self-host.js` serves only `/api/drive/`).

License: personal use permitted, all other rights reserved. See [LICENSE](LICENSE).
