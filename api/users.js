'use strict';

const { listUsers } = require('../lib/users');

/**
 * GET /api/users  (admin only)
 * Lists registered tokens (chat ids are masked).
 * Protect with REGISTER_KEY / X-Admin-Key.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const requiredKey = process.env.REGISTER_KEY;
  if (requiredKey) {
    const given = req.headers['x-admin-key'] || req.headers['X-Admin-Key'];
    if (given !== requiredKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  return res.status(200).json({
    users: listUsers(),
    count: listUsers().length,
  });
};
