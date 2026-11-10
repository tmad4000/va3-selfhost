// Dedicated-server owner credentials. No plaintext bearer is persisted here.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

function paths(dataDir) {
  if (!isAbsolute(dataDir || '')) throw new Error('An absolute --data-dir is required');
  const dir = join(dataDir, 'auth');
  return { dir, file: join(dir, 'devices.json'), lock: join(dir, '.credentials.lock') };
}
function read(dataDir) {
  const { file } = paths(dataDir);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data.version !== 1 || !/^[a-f0-9]{24}$/.test(data.server_id) || !Array.isArray(data.devices)) throw new Error('Invalid credential registry');
  return data;
}
function mutate(dataDir, fn) {
  const p = paths(dataDir);
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  chmodSync(p.dir, 0o700);
  let fd;
  try { fd = openSync(p.lock, 'wx', 0o600); }
  catch { throw new Error('Credential registry busy; retry after the other setup command finishes'); }
  const tmp = `${p.file}.${process.pid}.tmp`;
  try {
    let data;
    try { data = read(dataDir); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      data = { version: 1, server_id: randomBytes(12).toString('hex'), devices: [] };
    }
    const result = fn(data);
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, p.file);
    chmodSync(p.file, 0o600);
    return result;
  } finally {
    try { unlinkSync(tmp); } catch {}
    closeSync(fd); unlinkSync(p.lock);
  }
}
const digest = (server, token) => createHash('sha256').update(`${server}\0${token}`).digest('hex');
export function initCredentials(dataDir) {
  return mutate(dataDir, data => ({ server_id: data.server_id }));
}
export function issueCredential(dataDir, label = 'Native install') {
  if (typeof label !== 'string' || !label.trim() || label.length > 120 || /[\r\n\x00-\x1f]/.test(label)) throw new Error('Label must be 1–120 printable characters');
  return mutate(dataDir, data => {
    const id = randomBytes(12).toString('hex');
    const token = `va3_${data.server_id}_${randomBytes(32).toString('base64url')}`;
    const created_at = new Date().toISOString();
    data.devices.push({ id, label: label.trim(), created_at, hash: digest(data.server_id, token) });
    return { id, label: label.trim(), server_id: data.server_id, token, access: 'owner' };
  });
}
export function listCredentials(dataDir) {
  const data = read(dataDir);
  return { server_id: data.server_id, devices: data.devices.map(({ hash, ...device }) => device) };
}
export function revokeCredential(dataDir, id) {
  return mutate(dataDir, data => {
    const device = data.devices.find(d => d.id === id);
    if (!device) throw new Error('Unknown credential id');
    device.revoked_at ||= new Date().toISOString();
    return { id, revoked: true };
  });
}
export function credentialIdentity(dataDir, token) {
  if (typeof token !== 'string' || token.length > 200) return null;
  try {
    const data = read(dataDir);
    if (!token.startsWith(`va3_${data.server_id}_`)) return null;
    const given = Buffer.from(digest(data.server_id, token), 'hex');
    const device = data.devices.find(d => !d.revoked_at && /^[a-f0-9]{64}$/.test(d.hash) && timingSafeEqual(given, Buffer.from(d.hash, 'hex')));
    return device ? { id: device.id, server_id: data.server_id, access: 'owner' } : null;
  } catch { return null; } // missing/malformed registry never grants access
}
