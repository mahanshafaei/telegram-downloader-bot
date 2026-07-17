<div align="center">

# 🎬 Telegram Downloader Bot

**Send a link, get the video or audio back — right in your Telegram chat.**

Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp), so it handles YouTube, X/Twitter, Instagram, TikTok, Reddit and [1,800+ other sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md). Runs as a small Node process — deploy it to [Railway](https://railway.app) in a couple of minutes.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![yt-dlp](https://img.shields.io/badge/yt--dlp-powered-red?logo=youtube&logoColor=white)
![ffmpeg](https://img.shields.io/badge/ffmpeg-merging%20%2B%20mp3-007808?logo=ffmpeg&logoColor=white)
![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot%20API-26A5E4?logo=telegram&logoColor=white)
![Railway](https://img.shields.io/badge/Deploy-Railway-0B0D0E?logo=railway&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

</div>

---

## ✨ Features

- 🌍 **1,800+ sites** via yt-dlp — YouTube, X/Twitter, Instagram, TikTok, Threads, Reddit, Vimeo, Twitch, Facebook and more
- 🎚️ **Quality picker** — every link comes back with a list of resolutions (each showing its estimated size) plus an audio-only MP3 option
- 🎵 **Audio extraction** — grab just the sound as an MP3, ffmpeg does the conversion
- 💬 Works in **private chats and groups**
- 🔔 **Live progress** — the bot edits its message as the download runs
- 🪶 **Zero runtime npm dependencies** — just Node, yt-dlp, and ffmpeg

> **Heads up on file size:** the bot downloads the file and uploads it to Telegram itself, so it's bound by **Telegram's 50 MB bot-upload limit**. The quality picker marks any option that's over the limit with ⚠️. Lifting this requires running your own [Telegram Bot API server](https://github.com/tdlib/telegram-bot-api) (raises it to 2 GB) — not set up here, but the bot is structured so you could point it at one later.

---

## 🚀 Deploy to Railway

You'll need a [Railway account](https://railway.app) and a bot token.

### 1. Get a bot token

Message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token it gives you.

### 2. Push this repo to GitHub

Railway deploys from a Git repo. If you haven't already:

```bash
git init && git add . && git commit -m "Telegram downloader bot"
git branch -M main
git remote add origin https://github.com/mahanshafaei/telegram-downloader-bot.git
git push -u origin main
```

### 3. Create the Railway service

1. On [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
2. Pick your repo. Railway detects the `Dockerfile` and builds it (this installs ffmpeg and yt-dlp for you).
3. Open the service → **Variables** → add:

   | Variable | Value |
   |----------|-------|
   | `BOT_TOKEN` | the token from BotFather |

4. That's it. Railway builds and starts the bot. Watch **Deploy Logs** — you'll see `Logged in as @yourbot. Polling…`

The bot uses **long polling**, so there's no webhook, no public URL, and no domain to configure. Send it a link and it replies.

---

## 👥 Using it in groups

By default Telegram only shows bots messages that mention them or reply to them, so the bot can't see links in normal group chatter. To fix that, turn off privacy mode:

1. Open [@BotFather](https://t.me/BotFather) → `/mybots` → your bot
2. **Bot Settings → Group Privacy → Turn off**
3. Remove and re-add the bot to the group (the setting only applies on next join)

The bot needs **no admin rights** — it just reads links and replies.

---

## ⚙️ Configuration

All configuration is via environment variables. Only `BOT_TOKEN` is required.

| Name | Required | Purpose |
|------|----------|---------|
| `BOT_TOKEN` | yes | Your BotFather token |
| `DOWNLOAD_DIR` | no | Where files are staged before upload (defaults to a temp dir) |
| `MAX_FILESIZE_MB` | no | Cap on file size in MB. Clamped to 50 (Telegram's limit) |

See [`.env.example`](.env.example) for a template.

---

## 🛠️ Local development

You need [Node 18+](https://nodejs.org). yt-dlp and ffmpeg are resolved automatically — if they're not on your `PATH`, the bot downloads a standalone yt-dlp binary to `~/.telegram-downloader/bin` on first run. (ffmpeg is only needed for merging high-res video and MP3 extraction; install it from [ffmpeg.org](https://ffmpeg.org/download.html) if you want those.)

```bash
cp .env.example .env    # add your BOT_TOKEN
npm start               # runs the bot with long polling
```

`npm run check` syntax-checks every module.

---

## 🧩 How it works

```
Telegram ──getUpdates (long poll)──▶  Node process (src/bot.js)
                                          │
   link ──▶  yt-dlp -J (probe formats) ──▶ quality picker (inline keyboard)
                                          │
   tap a quality ──▶  yt-dlp download ──▶ ffmpeg merge/mp3 ──▶ file on disk
                                          │
                                          └─▶ upload to Telegram, delete temp file
```

The download engine is a port of [yoink](https://github.com/)'s yt-dlp wrapper: it resolves a yt-dlp binary, probes a link with `yt-dlp -J`, builds a list of format choices from the result, and spawns yt-dlp to download the chosen one. Downloads run in per-request temp directories that are removed afterward.

| File | Responsibility |
|------|----------------|
| `src/bot.js` | Long-poll loop, commands, quality picker, download orchestration |
| `src/telegram.js` | Bot API wrapper and file uploads |
| `src/ytdlp.js` | yt-dlp engine — resolve, probe, build choices, download |
| `src/platforms.js` | Friendly platform names for links |
| `src/util.js` | Shared helpers |

---

## 🩺 Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `BOT_TOKEN is not set` on startup | Add the `BOT_TOKEN` variable in Railway → Variables |
| `File is … over Telegram's 50 MB … limit` | Pick a lower quality; the ⚠️ options are over the limit |
| YouTube: `content is not available on this app` | YouTube is bot-blocking the host IP — common on datacenter IPs; often resolves on retry or with cookies |
| `Sign in to confirm you're not a bot` | Same as above — the site wants a logged-in session |
| A specific site fails | yt-dlp may need updating for that site — the Docker image pulls the latest on each build; redeploy |
| Nothing in groups | Group Privacy still on, or the bot needs re-adding |

Deploy logs (Railway → your service → **Deploy Logs**) show exactly what the bot is doing and any yt-dlp errors.

---

## 📄 License

MIT. Do what you like with it.
