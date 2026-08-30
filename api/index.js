'use strict';

/**
 * Root + health endpoint.
 * Visiting the deployment URL no longer 404s.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  return res.status(200).json({
    ok: true,
    service: 'bookmarklet-receiver',
    version: '3',
    endpoints: {
      botWebhook: '/api/bot/webhook',
      data: '/data/:slug',
      register: 'POST /api/register',
      users: 'GET /api/users',
      health: '/',
    },
    hint: 'Talk to the Telegram bot with /start. This page is only a health check.',
  });
};
