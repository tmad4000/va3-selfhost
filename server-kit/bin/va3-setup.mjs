#!/usr/bin/env node
// Secrets are printed only for the explicit local `issue` command.
import { initCredentials, issueCredential, listCredentials, revokeCredential } from '../server/drive/credentials.js';
const args = process.argv.slice(2);
const command = args.shift();
function option(name) { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) throw new Error(`Missing ${name}`); args.splice(i, 2); return v; }
try {
  const dataDir = option('--data-dir');
  const label = option('--label');
  const id = option('--id');
  if (args.length || !['init', 'issue', 'list', 'revoke'].includes(command) || !dataDir) throw new Error('Usage: node bin/va3-setup.mjs init|issue|list|revoke --data-dir /absolute/private/data [--label "My iPhone"] [--id ID]');
  if (command === 'revoke' && !id) throw new Error('revoke requires --id');
  const result = command === 'init' ? initCredentials(dataDir) : command === 'issue' ? issueCredential(dataDir, label) : command === 'list' ? listCredentials(dataDir) : revokeCredential(dataDir, id);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (e) { process.stderr.write(`Setup failed: ${e.message}\n`); process.exitCode = 1; }
