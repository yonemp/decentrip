'use strict';

const crypto = require('crypto');

const SECRET =
  process.env.TOKEN_SECRET ||
  process.env.REGISTER_KEY ||
  process.env.TELEGRAM_BOT_TOKEN ||
  'dev-insecure';

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(s) {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = p.length % 4 ? '='.repeat(4 - (p.length % 4)) : '';
  return Buffer.from(p + pad, 'base64');
}

/** Encrypt + sign a hit payload for URL buttons (no redis). */
function packHit(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const key = crypto.createHash('sha256').update(SECRET).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(body), c.final()]);
  const tag = c.getAuthTag();
  const packed = Buffer.concat([iv, tag, enc]);
  const sig = crypto.createHmac('sha256', SECRET).update(packed).digest().subarray(0, 16);
  return b64url(Buffer.concat([sig, packed]));
}

function unpackHit(token) {
  if (!token || typeof token !== 'string') throw new Error('missing token');
  const raw = fromB64url(token);
  if (raw.length < 12 + 16 + 16 + 1) throw new Error('token too short');
  const sig = raw.subarray(0, 16);
  const packed = raw.subarray(16);
  const expect = crypto.createHmac('sha256', SECRET).update(packed).digest().subarray(0, 16);
  if (!crypto.timingSafeEqual(sig, expect)) throw new Error('bad signature');
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const enc = packed.subarray(28);
  const key = crypto.createHash('sha256').update(SECRET).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  const json = Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  const obj = JSON.parse(json);
  if (obj.exp && Date.now() > obj.exp) throw new Error('log expired');
  return obj;
}

module.exports = { packHit, unpackHit };
