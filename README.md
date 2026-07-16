<div align="center">

# 🎬 Telegram Downloader Bot

**Download media from Instagram, TikTok, Pinterest, and YouTube — straight into any Telegram chat.**

Runs entirely on a [Cloudflare Worker](https://workers.dev). No server to rent, no container to keep alive, free for most personal use.

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES%20Modules-F7DF1E?logo=javascript&logoColor=black)
![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot%20API-26A5E4?logo=telegram&logoColor=white)

</div>

---

## ✨ Features

| Platform | What you get |
|----------|--------------|
| 📷 **Instagram** | Reels and photo posts, including multi-image albums |
| 🎵 **TikTok** | Videos without the watermark |
| 📌 **Pinterest** | Images and videos |
| ▶️ **YouTube** | Pick a quality (360p / 720p / 1080p) or grab audio only |

- 💬 Works in **private chats and groups**
- ⚡ Optional **file cache** — anything sent once is re-sent instantly
- 🔒 Webhook secured with a secret token
- 🪶 Zero dependencies at runtime, deploys in seconds

---

## 🚀 Quick start

You'll need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and [Node.js 18+](https://nodejs.org).

### 1. Get a bot token

Message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token it gives you.

### 2. Install and log in

```bash
git clone https://github.com/mahanshafaei/telegram-downloader-bot.git
cd telegram-downloader-bot
npm install
npx wrangler login
```

### 3. Add your secrets

```bash
npx wrangler secret put BOT_TOKEN        # paste the BotFather token
npx wrangler secret put WEBHOOK_SECRET   # any random string, e.g. a password
```

`WEBHOOK_SECRET` is optional but recommended — it stops anyone else from POSTing fake updates to your worker. Keep it to letters and numbers (Telegram rejects characters like `*` or `!`).

### 4. Deploy

```bash
npx wrangler deploy
```

Copy the URL it prints, e.g. `https://telegram-downloader-bot.YOUR-NAME.workers.dev`.

### 5. Point Telegram at your worker

Register the webhook, filling in your token, URL, and secret:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<WEBHOOK_SECRET>"
```

A `{"ok":true}` response means you're live. Send your bot a link and it'll reply with the media.

---

## 👥 Using it in groups

By default Telegram only shows bots messages that mention them or reply to them, so the bot can't see links in normal group chatter. To fix that, turn off privacy mode:

1. Open [@BotFather](https://t.me/BotFather) → `/mybots` → your bot
2. **Bot Settings → Group Privacy → Turn off**
3. Remove and re-add the bot to the group (the setting only applies on next join)

The bot needs **no admin rights** — it just reads links and replies.

---

## ⚙️ Configuration

Secrets are set with `wrangler secret put`. Non-secret settings live in `wrangler.toml`.

| Name | Kind | Required | Purpose |
|------|------|----------|---------|
| `BOT_TOKEN` | secret | yes | Your BotFather token |
| `WEBHOOK_SECRET` | secret | no | Verifies incoming webhook calls |
| `COBALT_API_URL` | var | no | Cobalt instance(s) for resolving media |
| `COBALT_API_KEY` | secret | no | Only if your cobalt instance needs a key |

### Media resolving

Instagram, Pinterest, and YouTube are resolved through [cobalt](https://github.com/imputnet/cobalt), an open-source downloader API. The bot ships with a couple of public instances as a default, but they rate-limit and go down from time to time. For anything beyond casual use, run your own — set `COBALT_API_URL` to one URL, or several comma-separated ones tried in order:

```toml
COBALT_API_URL = "https://your-cobalt.example.com,https://co.otomir23.me"
```

> **Note on Instagram:** some posts are served only to logged-in users, and a public instance on a datacenter IP can't fetch those — you'll get a "login required" message. Public reels, photos, and albums work fine.

### Optional: instant re-sends with a file cache

When Telegram sends a file, it hands back a `file_id` that can be re-sent to anyone, instantly and with no size limit. Wire up a [Cloudflare KV](https://developers.cloudflare.com/kv/) namespace and the bot will remember what it has sent, so a repeated link comes back immediately instead of being downloaded again.

```bash
npx wrangler kv namespace create MEDIA_CACHE
```

Paste the printed `id` into `wrangler.toml` (uncomment the `[[kv_namespaces]]` block), then redeploy. It's entirely optional — without it the bot works the same, just without the shortcut.

---

## 🛠️ Local development

```bash
cp .dev.vars.example .dev.vars   # fill in your values
npm run dev                      # runs the worker locally
```

`npm run tail` streams live logs from the deployed worker, which is the fastest way to see what's happening when something misbehaves. Opening the worker's URL in a browser shows a small status page with the running version and current config.

---

## 🧩 How it works

```
Telegram  ──webhook──▶  Cloudflare Worker
                             │
                             ├─ detect platform from the link
                             ├─ resolve a direct media URL (cobalt / tikwm)
                             └─ send to Telegram, preferring to hand it the URL
                                so Telegram fetches the bytes itself
```

Handing Telegram the URL keeps the worker well inside its CPU and memory limits. If a URL send is refused (some CDNs block Telegram's fetcher), the bot falls back to streaming the file through itself, capped at Telegram's 50 MB bot-upload limit.

| File | Responsibility |
|------|----------------|
| `src/index.js` | Webhook routing, commands, delivery |
| `src/telegram.js` | Bot API wrapper and media sending |
| `src/resolvers.js` | Platform detection and media resolving |
| `src/cache.js` | Optional file_id cache (KV) |
| `src/util.js` | Shared helpers |

---

## 🩺 Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Bot silent, `getWebhookInfo` shows `403` | `WEBHOOK_SECRET` doesn't match the one in `setWebhook` |
| `500` right after deploy | `BOT_TOKEN` not set, or a moment of propagation — check `npm run tail` |
| Instagram "login required" | Post is login-walled by Instagram; only public posts can be fetched |
| A platform stops working | Public cobalt instance is down — set `COBALT_API_URL` to your own |
| Nothing in groups | Group Privacy still on, or bot needs re-adding |

Check `getWebhookInfo` any time to see the last error Telegram recorded:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

---

## 📄 License

MIT. Do what you like with it.
