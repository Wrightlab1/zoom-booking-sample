/**
 * Encrypted at-rest storage for each connected host's OAuth tokens.
 *
 * A JSON file is deliberately simple — this is a sample app. In production use
 * a database with per-row encryption and proper key management. What the file
 * MUST NOT be is plaintext: a Zoom refresh token grants ongoing access to the
 * host's calendar and meetings.
 *
 * ── Critical Zoom behaviour ──
 * Zoom refresh tokens are SINGLE USE. Every refresh returns a NEW refresh token
 * and invalidates the old one. If you fail to persist the new value, that host
 * is disconnected permanently and must re-authorise. Every write path here
 * therefore saves the refresh token synchronously before the access token is
 * handed to a caller.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.js';

/**
 * Anchor the store to the repo root, never process.cwd().
 * `npm run smoke` (cwd=server/) and `node server/src/index.js` (cwd=repo root)
 * would otherwise read two different files, and a host connected under one
 * would look disconnected under the other.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const ALGORITHM = 'aes-256-gcm';

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, config.tokens.encryptionKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = String(payload).split(':');
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    config.tokens.encryptionKey,
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

function storeFile() {
  return path.isAbsolute(config.tokens.storePath)
    ? config.tokens.storePath
    : path.resolve(REPO_ROOT, config.tokens.storePath);
}

/** @returns {Record<string, object>} keyed by Zoom user id */
function readAll() {
  const file = storeFile();
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const [userId, record] of Object.entries(raw)) {
      out[userId] = {
        ...record,
        refreshToken: record.refreshToken ? decrypt(record.refreshToken) : null,
        accessToken: record.accessToken ? decrypt(record.accessToken) : null,
      };
    }
    return out;
  } catch (err) {
    // A key rotation or corrupt file should not crash the server; it should
    // surface as "nobody is connected" so hosts can simply re-authorise.
    console.error(`[tokenStore] could not read ${file}: ${err.message}`);
    return {};
  }
}

function writeAll(records) {
  const serialisable = {};
  for (const [userId, record] of Object.entries(records)) {
    serialisable[userId] = {
      ...record,
      refreshToken: record.refreshToken ? encrypt(record.refreshToken) : null,
      accessToken: record.accessToken ? encrypt(record.accessToken) : null,
    };
  }
  const file = storeFile();
  fs.writeFileSync(file, JSON.stringify(serialisable, null, 2), { mode: 0o600 });
}

export function getHostRecord(userId) {
  return readAll()[userId] ?? null;
}

export function listHostRecords() {
  return Object.values(readAll());
}

/** Public view — never leaks tokens to a caller or a response body. */
export function listConnectedHosts() {
  return listHostRecords().map(({ refreshToken, accessToken, ...safe }) => ({
    ...safe,
    connected: Boolean(refreshToken),
  }));
}

export function saveHostRecord(record) {
  const all = readAll();
  all[record.userId] = { ...(all[record.userId] ?? {}), ...record, updatedAt: new Date().toISOString() };
  writeAll(all);
  return all[record.userId];
}

export function deleteHostRecord(userId) {
  const all = readAll();
  const existed = Boolean(all[userId]);
  delete all[userId];
  writeAll(all);
  return existed;
}
