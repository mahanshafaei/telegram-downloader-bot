# Telegram Downloader Bot — Node + yt-dlp + ffmpeg
FROM node:20-slim

# ffmpeg (stream merging + mp3 extraction) and ca-certificates for HTTPS fetches.
# python3 is not required — we use the standalone yt-dlp binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Bake in the standalone yt-dlp binary so the first request doesn't wait on a
# download. It self-resolves at runtime too (see src/ytdlp.js), but shipping it
# here means the container is ready immediately.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# No runtime npm dependencies, but copy the manifest first for layer caching
# and install anything that might appear later.
COPY package.json ./
RUN npm install --omit=dev || true

COPY src ./src

# yt-dlp writes to a temp dir; keep it on the writable layer.
ENV DOWNLOAD_DIR=/tmp/tgdl

CMD ["node", "src/bot.js"]
