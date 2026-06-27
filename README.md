# 🎤 Lyrika-Stanza (Technical Showcase)

A robust, time-synchronized lyrics visualization service designed for Discord, featuring a custom track parser, seamless LRCLIB integration, and a multi-server SQLite backend.

## 🛠️ Architecture & Technical Overview

Lyrika-Stanza intercepts playing events from other music bots, queries the LRCLIB API for synchronized `.lrc` timestamps, and renders a live, scrolling UI updated dynamically via Discord's message editing endpoints.

### Key Components:
- **Event Interceptor**: Listens to `messageCreate` and `messageUpdate` to track embeds from target bots.
- **Query Sanitizer**: A sophisticated Regex pipeline strips emojis, URLs, and markdown from embed titles/descriptions to form high-confidence artist/track search queries.
- **Live Sync Engine**: Uses a non-blocking `setInterval` tick (400ms) to track playback time. Only fires API requests to edit Discord messages when the active lyric line changes, ensuring strict compliance with Discord rate limits.
- **Data Persistence**: Uses `sqlite3` to store guild-specific configurations, including the target music bot ID, designated listening/output channels, and timing offsets.

---

## 🚀 Local Deployment Guide

### Prerequisites
- [Node.js](https://nodejs.org/) (v16.11.0 or higher recommended)
- A Discord Bot Application with the **Message Content Intent** enabled.

### 1. Environment Setup
Clone the repository and create a `.env` file in the project root:
```env
YOUR_DISCORD_BOT_TOKEN=your_bot_token_here
```
*(The application gracefully falls back to `DISCORD_TOKEN`, `BOT_TOKEN`, or `TOKEN`).*

### 2. Dependency Installation
Install the required packages using NPM:
```bash
npm install
```

### 3. Execution
Start the service:
```bash
node index.js
```
Upon startup, the SQLite database is automatically initialized, and global slash commands are synced with the Discord API.

---

## 📡 Slash Commands API

| Command | Parameters | Description |
| :--- | :--- | :--- |
| `/setup-lyrics` | `listen-channel`, `output-channel` | Initializes the DB entry for the guild, routing intercept/output. |
| `/set-targetbot` | `bot` | Updates the DB with the target Snowflake ID of the music bot. |
| `/setoffset` | `offset-ms` | Stores a user-defined latency offset integer (positive/negative) for the guild. |
| `/status` | *None* | Queries the DB and returns the current active configuration for the guild. |

---

## 🐳 Docker Support

To run the service inside an isolated container with persistent DB volume:
```bash
docker build -t lyrika-stanza .
docker run -d --name lyrika-stanza -v $(pwd)/database.sqlite:/usr/src/app/database.sqlite -e YOUR_DISCORD_BOT_TOKEN="your_token" lyrika-stanza
```
