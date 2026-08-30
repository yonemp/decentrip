'use strict';

/**
 * Pending hits for Drain now / Save later.
 * Prefer Upstash Redis (works across serverless instances).
 * Falls back to memory+/tmp (same-instance only).
 *
 * Env:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.HITS_STORE_PATH || path.join('/tmp', 'hits-store.json');
const memory = new Map();
const TTL_SEC = 60 * 60 * 24; // 24h

const { hasRedis, redis } = require('./redis');

function loadFile() {
  try {
    if (!fs.existsSync(FILE)) return;
    const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (obj && typeof obj === 'object') {
      for (const [id, rec] of Object.entries(obj)) memory.set(id, rec);
    }
  } catch (_) {}
}

function persistFile() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(memory)), 'utf8');
  } catch (_) {}
}

loadFile();

async function saveHit(record) {
  const id = crypto.randomBytes(8).toString('hex');
  const rec = {
    ...record,
    id,
    createdAt: Date.now(),
    status: 'pending',
  };

  if (hasRedis()) {
    try {
      await redis('SET', [`hit:${id}`, JSON.stringify(rec), 'EX', String(TTL_SEC)]);
      return rec;
    } catch (err) {
      console.error('[hits] redis save failed', err.message);
    }
  }

  memory.set(id, rec);
  persistFile();
  return rec;
}

async function getHit(id) {
  const key = String(id);
  if (hasRedis()) {
    try {
      const raw = await redis('GET', [`hit:${key}`]);
      if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      console.error('[hits] redis get failed', err.message);
    }
  }
  loadFile();
  return memory.get(key) || null;
}

async function updateHit(id, patch) {
  const rec = await getHit(id);
  if (!rec) return null;
  Object.assign(rec, patch, { updatedAt: Date.now() });
  if (hasRedis()) {
    try {
      await redis('SET', [`hit:${id}`, JSON.stringify(rec), 'EX', String(TTL_SEC)]);
      return rec;
    } catch (err) {
      console.error('[hits] redis update failed', err.message);
    }
  }
  memory.set(String(id), rec);
  persistFile();
  return rec;
}

module.exports = { saveHit, getHit, updateHit, hasRedis };
