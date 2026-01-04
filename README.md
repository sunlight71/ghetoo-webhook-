# Deposit Webhook (Next.js)

Handles Tatum deposit notifications and sends to Telegram.

## Deploy to Vercel

### 1. Push to GitHub
```bash
cd deposit-webhook
git init
git add .
git commit -m "Deposit webhook"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/deposit-webhook.git
git push -u origin main
```

### 2. Import in Vercel
- Go to [vercel.com](https://vercel.com)
- Click "New Project" → Import your repo
- Framework: Next.js (auto-detected)
- Click Deploy

### 3. Set Environment Variables
In Vercel Dashboard → Settings → Environment Variables:

| Variable | Value |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | Your bot token from @BotFather |
| `DEPOSIT_CHATID` | Admin channel ID (e.g. -1003586283056) |
| `REDIS_HOST` | Your Redis host |
| `REDIS_PORT` | Redis port (usually 6379 or 11980) |
| `REDIS_PASSWORD` | Your Redis password |

### 4. Get Webhook URL
After deploy: `https://your-app.vercel.app/api/tatum`

### 5. Update Bot .env
```
TATUM_WEBHOOK_URL=https://your-app.vercel.app/api/tatum
```

### 6. Restart Bot
Bot subscribes addresses to Tatum with your webhook URL.

## Features

- ✅ Duplicate prevention (TX lock + processed check)
- ✅ USD conversion via CoinGecko
- ✅ Minimum deposit check
- ✅ User + Admin Telegram notifications
- ✅ Balance auto-update

## Test

Visit: `https://your-app.vercel.app/api/tatum`

Returns: `{"status":"ok","service":"deposit-webhook",...}`
