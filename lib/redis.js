'use strict';

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

function hasRedis() {
  return Boolean(UPSTASH_URL && UPSTASH_TOKEN);
}

async function redis(command, args = []) {
  if (!hasRedis()) return null;
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`upstash ${r.status}: ${t}`);
  }
  const data = await r.json();
  return data.result;
}

module.exports = { hasRedis, redis };
