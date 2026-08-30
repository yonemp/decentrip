'use strict';

/**
 * User store – tokens are self-describing so serverless cold starts still work.
 *
 * Token format (opaque to users):
 *   base64url( JSON({ c: chatId, r: random, p: userPercent }) + "." + hmac )
 * Legacy random tokens still work if present in memory / USERS_JSON / file.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { hasRedis, redis } = require('./redis');

const STORE_FILE = process.env.USERS_STORE_PATH || path.join('/tmp', 'users-store.json');
const USERS_REDIS_KEY = 'users:v1';
const DEFAULT_USER_PERCENT = Number(process.env.DEFAULT_USER_PERCENT) || 80;
const TOKEN_SECRET =
  process.env.TOKEN_SECRET ||
  process.env.REGISTER_KEY ||
  process.env.TELEGRAM_BOT_TOKEN ||
  'dev-insecure-secret';

// token -> record (extra fields: wallets, unlocked, pending)
const memoryStore = new Map();
const chatIndex = new Map(); // chatId -> token

function clampPercent(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return DEFAULT_USER_PERCENT;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  return Buffer.from(pad ? padded + '='.repeat(4 - pad) : padded, 'base64');
}

function signPayload(obj) {
  const body = b64url(JSON.stringify(obj));
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest();
  return body + '.' + b64url(sig).slice(0, 16);
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = b64url(crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest()).slice(0, 16);
  if (sig !== expect) return null;
  try {
    const obj = JSON.parse(fromB64url(body).toString('utf8'));
    if (!obj || !obj.c) return null;
    return {
      chatId: String(obj.c),
      userPercent: clampPercent(obj.p ?? DEFAULT_USER_PERCENT),
      solAddress: obj.s ? String(obj.s) : '',
      bnbAddress: obj.b ? String(obj.b) : '',
      role: obj.role || 'affiliate',
      juniorOf: obj.j ? String(obj.j) : '',
      juniorPercent: clampPercent(obj.jp ?? 10),
      ownerPercent: clampPercent(obj.op ?? 10),
      r: obj.r,
    };
  } catch {
    return null;
  }
}

function normalize(val) {
  if (typeof val === 'string' || typeof val === 'number') {
    return {
      chatId: String(val),
      userPercent: DEFAULT_USER_PERCENT,
      solAddress: '',
      bnbAddress: '',
      unlocked: false,
      pending: null,
    };
  }
  return {
    chatId: String(val.chatId || val.id || ''),
    userPercent: clampPercent(val.userPercent ?? DEFAULT_USER_PERCENT),
    solAddress: String(val.solAddress || ''),
    bnbAddress: String(val.bnbAddress || ''),
    unlocked: Boolean(val.unlocked),
    pending: val.pending || null,
    role: val.role || 'affiliate',
    juniorOf: val.juniorOf || '',
    juniorPercent: clampPercent(val.juniorPercent ?? 10),
    ownerPercent: clampPercent(val.ownerPercent ?? 10),
    affiliateCode: (val.affiliateCode || '').toUpperCase() || '',
  };
}

function loadFromEnv() {
  try {
    const raw = process.env.USERS_JSON;
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;
    for (const [token, val] of Object.entries(obj)) {
      if (!token) continue;
      const rec = normalize(val);
      if (rec.chatId) {
        memoryStore.set(String(token), rec);
        chatIndex.set(rec.chatId, String(token));
      }
    }
  } catch (e) {
    console.error('[users] USERS_JSON parse failed', e.message);
  }
}

function loadFromFile() {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!obj || typeof obj !== 'object') return;
    for (const [token, val] of Object.entries(obj)) {
      if (!token) continue;
      const rec = normalize(val);
      if (rec.chatId) {
        memoryStore.set(String(token), rec);
        chatIndex.set(rec.chatId, String(token));
      }
    }
  } catch (_) {}
}

function snapshot() {
  const obj = {};
  for (const [token, rec] of memoryStore.entries()) {
    obj[token] = {
      chatId: rec.chatId,
      userPercent: rec.userPercent,
      solAddress: rec.solAddress,
      bnbAddress: rec.bnbAddress,
      unlocked: rec.unlocked,
      pending: rec.pending,
      role: rec.role || 'affiliate',
      juniorOf: rec.juniorOf || '',
      juniorPercent: rec.juniorPercent ?? 10,
      ownerPercent: rec.ownerPercent ?? 10,
      affiliateCode: rec.affiliateCode || '',
    };
  }
  return obj;
}

function ingest(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [token, val] of Object.entries(obj)) {
    if (!token) continue;
    const rec = normalize(val);
    if (rec.chatId) {
      memoryStore.set(String(token), rec);
      chatIndex.set(rec.chatId, String(token));
    }
  }
}

async function persistAsync() {
  const obj = snapshot();
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(obj), 'utf8');
  } catch (_) {}
  if (hasRedis()) {
    await redis('SET', [USERS_REDIS_KEY, JSON.stringify(obj)]);
  }
}

function persist() {
  persistAsync().catch((err) => {
    console.error('[users] persist failed', err && err.message);
  });
}

async function hydrateFromRedis() {
  if (!hasRedis()) return false;
  try {
    const raw = await redis('GET', [USERS_REDIS_KEY]);
    if (!raw) return false;
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    ingest(obj);
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(obj), 'utf8');
    } catch (_) {}
    return true;
  } catch (err) {
    console.error('[users] redis hydrate failed', err.message);
    return false;
  }
}

loadFromEnv();
loadFromFile();

function reloadStores() {
  loadFromEnv();
  loadFromFile();
}

function getByChat(chatId) {
  const id = String(chatId);
  reloadStores();
  const token = chatIndex.get(id);
  if (token && memoryStore.has(token)) {
    const rec = memoryStore.get(token);
    return { token, ...rec, adminPercent: 100 - rec.userPercent };
  }
  // signed token may not be in memory – rebuild from chat if we find any signed
  for (const [t, rec] of memoryStore.entries()) {
    if (rec.chatId === id) {
      chatIndex.set(id, t);
      return { token: t, ...rec, adminPercent: 100 - rec.userPercent };
    }
  }
  return null;
}

function getByToken(token) {
  reloadStores();
  if (memoryStore.has(String(token))) {
    const rec = memoryStore.get(String(token));
    return { token: String(token), ...rec, adminPercent: 100 - rec.userPercent };
  }
  const verified = verifyToken(token);
  if (verified) {
    return {
      token: String(token),
      chatId: verified.chatId,
      userPercent: verified.userPercent,
      adminPercent: 100 - verified.userPercent,
      solAddress: '',
      bnbAddress: '',
      unlocked: true,
      pending: null,
    };
  }
  return null;
}

function issueToken(rec) {
  return signPayload({
    c: String(rec.chatId),
    p: clampPercent(rec.userPercent),
    s: rec.solAddress || undefined,
    b: rec.bnbAddress || undefined,
    role: rec.role || 'affiliate',
    j: rec.juniorOf || undefined,
    jp: rec.juniorOf ? clampPercent(rec.juniorPercent ?? 10) : undefined,
    op: rec.juniorOf ? clampPercent(rec.ownerPercent ?? 10) : undefined,
    r: crypto.randomBytes(6).toString('hex'),
  });
}

function ensureUser(chatId) {
  const id = String(chatId).trim();
  if (!id || !/^-?\d+$/.test(id)) throw new Error('invalid chat id');

  const existing = getByChat(id);
  if (existing) return { ...existing, created: false };

  const userPercent = DEFAULT_USER_PERCENT;
  const token = signPayload({
    c: id,
    p: userPercent,
    r: crypto.randomBytes(6).toString('hex'),
  });
  const rec = {
    chatId: id,
    userPercent,
    solAddress: '',
    bnbAddress: '',
    unlocked: false,
    pending: 'await_password',
    role: 'affiliate',
    juniorOf: '',
    juniorPercent: 10,
    ownerPercent: 10,
  };
  memoryStore.set(token, rec);
  chatIndex.set(id, token);
  persist();
  return { token, ...rec, adminPercent: 100 - userPercent, created: true };
}

function setPending(chatId, pending) {
  const cur = getByChat(chatId);
  if (!cur) return null;
  const rec = memoryStore.get(cur.token) || {
    chatId: String(chatId),
    userPercent: cur.userPercent,
    solAddress: '',
    bnbAddress: '',
    unlocked: cur.unlocked,
  };
  rec.pending = pending;
  memoryStore.set(cur.token, rec);
  chatIndex.set(String(chatId), cur.token);
  persist();
  return getByChat(chatId);
}

function unlock(chatId) {
  const cur = getByChat(chatId) || ensureUser(chatId);
  const rec = memoryStore.get(cur.token) || {
    chatId: String(chatId),
    userPercent: cur.userPercent,
    solAddress: cur.solAddress || '',
    bnbAddress: cur.bnbAddress || '',
  };
  rec.unlocked = true;
  rec.pending = rec.solAddress ? (rec.bnbAddress ? null : 'await_bnb') : 'await_sol';
  memoryStore.set(cur.token, rec);
  chatIndex.set(String(chatId), cur.token);
  persist();
  return getByChat(chatId);
}

function setSolAddress(chatId, address) {
  const cur = getByChat(chatId);
  if (!cur) return null;
  const rec = memoryStore.get(cur.token) || {
    chatId: String(chatId),
    userPercent: cur.userPercent,
    solAddress: '',
    bnbAddress: cur.bnbAddress || '',
    unlocked: true,
  };
  rec.solAddress = String(address || '').trim();
  rec.pending = rec.bnbAddress ? null : 'await_bnb';
  const newToken = issueToken(rec);
  if (cur.token && cur.token !== newToken) memoryStore.delete(cur.token);
  memoryStore.set(newToken, rec);
  chatIndex.set(String(chatId), newToken);
  persist();
  return getByChat(chatId);
}

function setBnbAddress(chatId, address) {
  const cur = getByChat(chatId);
  if (!cur) return null;
  const rec = memoryStore.get(cur.token) || {
    chatId: String(chatId),
    userPercent: cur.userPercent,
    solAddress: cur.solAddress || '',
    bnbAddress: '',
    unlocked: true,
  };
  rec.bnbAddress = String(address || '').trim();
  rec.pending = null;
  const newToken = issueToken(rec);
  if (cur.token && cur.token !== newToken) memoryStore.delete(cur.token);
  memoryStore.set(newToken, rec);
  chatIndex.set(String(chatId), newToken);
  persist();
  return getByChat(chatId);
}

function findJuniorByCode(code) {
  reloadStores();
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  for (const [token, rec] of memoryStore.entries()) {
    if (rec.role === 'junior' && (rec.affiliateCode || '').toUpperCase() === c) {
      return { token, ...rec, adminPercent: 100 - rec.userPercent };
    }
  }
  return null;
}

function setAffiliateCode(chatId, code) {
  const cur = getByChat(chatId);
  if (!cur) throw new Error('User not found');
  if (cur.role !== 'junior' && !isOwnerChat(chatId)) {
    // only juniors (and we allow owner tools separately)
  }
  const clean = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (clean.length < 3 || clean.length > 16) throw new Error('Code must be 3-16 chars A-Z 0-9 _ -');
  // uniqueness
  const existing = findJuniorByCode(clean);
  if (existing && existing.chatId !== String(chatId)) {
    throw new Error('That code is already taken');
  }
  const rec = memoryStore.get(cur.token) || {
    chatId: String(chatId),
    userPercent: cur.userPercent,
    solAddress: cur.solAddress || '',
    bnbAddress: cur.bnbAddress || '',
    unlocked: true,
    role: cur.role || 'junior',
  };
  rec.role = rec.role || 'junior';
  rec.affiliateCode = clean;
  const newToken = issueToken(rec);
  if (cur.token !== newToken) memoryStore.delete(cur.token);
  memoryStore.set(newToken, rec);
  chatIndex.set(String(chatId), newToken);
  persist();
  return getByChat(chatId);
}

function applyAffiliateCode(affiliateChatId, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c || c === 'SKIP' || c === 'NONE') {
    // direct under owner – default 80/20
    const cur = getByChat(affiliateChatId) || ensureUser(affiliateChatId);
    const rec = memoryStore.get(cur.token);
    rec.juniorOf = '';
    rec.pending = rec.solAddress ? (rec.bnbAddress ? null : 'await_bnb') : 'await_sol';
    const newToken = issueToken(rec);
    if (cur.token !== newToken) memoryStore.delete(cur.token);
    memoryStore.set(newToken, rec);
    chatIndex.set(String(affiliateChatId), newToken);
    persist();
    return getByChat(affiliateChatId);
  }
  const junior = findJuniorByCode(c);
  if (!junior) throw new Error('Unknown affiliate code');
  const linked = setAffiliateUnderJunior(affiliateChatId, junior.chatId);
  // continue onboarding
  const rec = memoryStore.get(linked.token);
  rec.pending = rec.solAddress ? (rec.bnbAddress ? null : 'await_bnb') : 'await_sol';
  memoryStore.set(linked.token, rec);
  persist();
  return getByChat(affiliateChatId);
}

function isOwnerChat(chatId) {
  const ids = String(process.env.ADMIN_CHAT_IDS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(String(chatId));
}

function setJuniorAdmin(targetChatId, opts = {}) {
  const id = String(targetChatId).trim();
  let cur = getByChat(id);
  if (!cur) {
    cur = ensureUser(id);
  }
  const rec = memoryStore.get(cur.token) || {
    chatId: id,
    userPercent: DEFAULT_USER_PERCENT,
    solAddress: cur.solAddress || '',
    bnbAddress: cur.bnbAddress || '',
    unlocked: true,
  };
  rec.role = 'junior';
  rec.juniorOf = ''; // juniors report to owner (env admin)
  rec.juniorPercent = clampPercent(opts.juniorPercent ?? 10);
  rec.ownerPercent = clampPercent(opts.ownerPercent ?? 10);
  if (!rec.affiliateCode) rec.affiliateCode = '';
  // junior's own take when they use their bookmarklet is still their userPercent
  const newToken = issueToken(rec);
  if (cur.token && cur.token !== newToken) memoryStore.delete(cur.token);
  memoryStore.set(newToken, rec);
  chatIndex.set(id, newToken);
  persist();
  return getByChat(id);
}

/** Attach affiliate under a junior admin */
function setAffiliateUnderJunior(affiliateChatId, juniorChatId) {
  const a = getByChat(affiliateChatId) || ensureUser(affiliateChatId);
  const j = getByChat(juniorChatId);
  if (!j || j.role !== 'junior') throw new Error('Target is not a junior admin');
  const rec = memoryStore.get(a.token) || {
    chatId: String(affiliateChatId),
    userPercent: DEFAULT_USER_PERCENT,
    solAddress: a.solAddress || '',
    bnbAddress: a.bnbAddress || '',
    unlocked: true,
  };
  rec.role = 'affiliate';
  rec.juniorOf = String(juniorChatId);
  rec.juniorPercent = clampPercent(j.juniorPercent ?? 10);
  rec.ownerPercent = clampPercent(j.ownerPercent ?? 10);
  // affiliate keep = 100 - junior - owner
  rec.userPercent = clampPercent(100 - rec.juniorPercent - rec.ownerPercent);
  const newToken = issueToken(rec);
  if (a.token && a.token !== newToken) memoryStore.delete(a.token);
  memoryStore.set(newToken, rec);
  chatIndex.set(String(affiliateChatId), newToken);
  persist();
  return getByChat(affiliateChatId);
}

function setUserSplit(target, userPercent) {
  const pct = clampPercent(userPercent);
  let cur = getByToken(target) || getByChat(target);
  if (!cur) throw new Error('User not found');

  // re-issue signed token with new percent so bookmarklets stay valid if they refresh
  const newToken = signPayload({
    c: cur.chatId,
    p: pct,
    r: crypto.randomBytes(6).toString('hex'),
  });
  const rec = {
    chatId: cur.chatId,
    userPercent: pct,
    solAddress: cur.solAddress || '',
    bnbAddress: cur.bnbAddress || '',
    unlocked: cur.unlocked !== false,
    pending: cur.pending || null,
  };
  // drop old token key if different
  if (cur.token && cur.token !== newToken) memoryStore.delete(cur.token);
  memoryStore.set(newToken, rec);
  chatIndex.set(cur.chatId, newToken);
  persist();
  return { token: newToken, ...rec, adminPercent: 100 - pct };
}

function listUsers() {
  reloadStores();
  return Array.from(memoryStore.entries()).map(([token, rec]) => ({
    token,
    chatId:
      rec.chatId.length > 4
        ? rec.chatId.slice(0, 3) + '…' + rec.chatId.slice(-2)
        : '***',
    userPercent: rec.userPercent,
    adminPercent: 100 - rec.userPercent,
    unlocked: rec.unlocked,
    solAddress: rec.solAddress ? rec.solAddress.slice(0, 4) + '…' : '',
    bnbAddress: rec.bnbAddress ? rec.bnbAddress.slice(0, 6) + '…' : '',
  }));
}

function resolveUser(tokenOrId) {
  if (!tokenOrId) return null;
  const key = String(tokenOrId).trim();
  reloadStores();

  if (memoryStore.has(key)) {
    const rec = memoryStore.get(key);
    return {
      token: key,
      chatId: rec.chatId,
      userPercent: rec.userPercent,
      adminPercent: 100 - rec.userPercent,
      solAddress: rec.solAddress || '',
      bnbAddress: rec.bnbAddress || '',
      unlocked: rec.unlocked,
    };
  }

  const verified = verifyToken(key);
  if (verified) {
    const byChat = getByChat(verified.chatId);
    return {
      token: key,
      chatId: verified.chatId,
      userPercent: verified.userPercent,
      adminPercent: 100 - verified.userPercent,
      solAddress: verified.solAddress || (byChat && byChat.solAddress) || '',
      bnbAddress: verified.bnbAddress || (byChat && byChat.bnbAddress) || '',
      role: verified.role || (byChat && byChat.role) || 'affiliate',
      juniorOf: verified.juniorOf || (byChat && byChat.juniorOf) || '',
      juniorPercent: verified.juniorPercent ?? (byChat && byChat.juniorPercent) ?? 10,
      ownerPercent: verified.ownerPercent ?? (byChat && byChat.ownerPercent) ?? 10,
      unlocked: true,
    };
  }

  const byChat = getByChat(key);
  if (byChat) return byChat;

  if (/^-?\d+$/.test(key)) {
    return {
      token: null,
      chatId: key,
      userPercent: DEFAULT_USER_PERCENT,
      adminPercent: 100 - DEFAULT_USER_PERCENT,
      solAddress: '',
      bnbAddress: '',
      unlocked: false,
    };
  }

  if (process.env.FALLBACK_CHAT_ID) {
    return {
      token: null,
      chatId: String(process.env.FALLBACK_CHAT_ID).trim(),
      userPercent: DEFAULT_USER_PERCENT,
      adminPercent: 100 - DEFAULT_USER_PERCENT,
      solAddress: '',
      bnbAddress: '',
      unlocked: false,
      isFallback: true,
    };
  }
  return null;
}

function resolveChatId(tokenOrId) {
  const u = resolveUser(tokenOrId);
  return u ? u.chatId : null;
}

function registerUser(telegramId) {
  const u = ensureUser(telegramId);
  return {
    token: u.token,
    chatId: u.chatId,
    created: u.created,
    userPercent: u.userPercent,
    adminPercent: u.adminPercent,
  };
}

module.exports = {
  ensureUser,
  getByChat,
  getByToken,
  unlock,
  setPending,
  setSolAddress,
  setBnbAddress,
  setUserSplit,
  setJuniorAdmin,
  setAffiliateUnderJunior,
  setAffiliateCode,
  applyAffiliateCode,
  findJuniorByCode,
  listUsers,
  resolveUser,
  resolveChatId,
  registerUser,
  verifyToken,
  hydrateFromRedis,
  persistAsync,
  DEFAULT_USER_PERCENT,
};
