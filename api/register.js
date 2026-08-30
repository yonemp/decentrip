'use strict';

const { registerUser } = require('../lib/users');

/**
 * POST /api/register
 * Body: { "telegramId": "123456789" }
 * Returns: { "token": "opaque-base64url", "bookmarkletHint": "..." }
 *
 * The token is what goes into the bookmarklet payload instead of the real Telegram ID.
 * Multiple users can each call this once and receive their own private token.
 */
module.exports = async function handler(req, res) {
  // CORS for simple browser / bot clients
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Optional simple lock: set REGISTER_KEY env and send X-Admin-Key header
  const requiredKey = process.env.REGISTER_KEY;
  if (requiredKey) {
    const given = req.headers['x-admin-key'] || req.headers['X-Admin-Key'];
    if (given !== requiredKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body must be JSON object with telegramId' });
  }

  const telegramId = body.telegramId || body.chatId || body.id;
  if (!telegramId) {
    return res.status(400).json({ error: 'telegramId required' });
  }

  try {
    const { token, chatId, created } = registerUser(telegramId);

    // Example payload shape the bookmarklet should produce (token instead of telegramId)
    const examplePayload = {
      token,
      site: 'https://axiom.trade',
      // bundle / sBundles / eBundles filled by the actual bookmarklet at runtime
    };
    const exampleSlug = Buffer.from(JSON.stringify(examplePayload))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    return res.status(200).json({
      ok: true,
      created,
      token,
      // never return the real chatId to the caller in production if you want max privacy
      // chatId is returned here only so the operator can verify registration
      chatId,
      message: created
        ? 'New token issued. Put this token in your bookmarklet payload as "token".'
        : 'Existing token returned for this telegramId.',
      examplePayload,
      exampleSlug,
      note: 'For durable multi-instance storage set USERS_JSON env or replace lib/users.js with Vercel KV / Redis.',
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};
