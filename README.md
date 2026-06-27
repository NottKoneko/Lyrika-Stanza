# 🎤 Lyrika-Stanza

[![Discord.js](https://img.shields.io/badge/discord.js-v14.15-blue.svg?logo=discord&logoColor=white)](https://discord.js.org/)
[![SQLite](https://img.shields.io/badge/database-SQLite3-sqlite.svg?logo=sqlite&logoColor=white)](https://sqlite.org/)
[![LRCLIB](https://img.shields.io/badge/API-LRCLIB-green.svg)](https://lrclib.net/)

**Lyrika-Stanza** is a live, time-synced lyrics visualization bot for Discord. It intercepts "Now Playing" embeds or messages from music bots (even those with cluttered markdown, links, or custom emojis), fetches synchronized lyrics in real-time using the **LRCLIB** API, and displays a rolling visualization of the lyrics synced perfectly to the playback in a dedicated text channel.

Powered by a multi-server SQLite backend, Lyrika-Stanza is fully configurable via Discord Slash Commands—no hardcoded channels or static environment configs required.

---

## 🌟 Key Features

*   **Real-time Synced Stream:** Displays a sliding window of lyrics with a highlighted focus frame (`👉`) pointing at the current line.
*   **Slash Command Configurable:** Easy dynamic setup per server. No hardcoded configuration files.
*   **Multi-Guild Support:** An SQLite database stores configurations independently for each server.
*   **Interactive Sync Buttons:** Live buttons (`⏪ -0.5s` and `⏩ +0.5s`) allow users to adjust latency offsets in real-time directly on the lyrics message.
*   **Robust Track Parser:** Strips custom emojis, mentions/pings, Discord markdown links, headers, and time indicators to generate clean search queries.
*   **Rate-Limit Friendly:** Checks state every 400ms but only makes Discord API edits when the active lyric line actually changes.
*   **Error Resilient:** Prevents crashes using global promise rejection catches, designed to run 24/7.

---

## ⚙️ Discord Slash Commands

Setup and customize the bot directly inside Discord. Admin permissions (`Manage Channels` or `Administrator`) are required.

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/setup-lyrics` | `listen-channel`, `output-channel` | Designate where to listen for music bot messages and where to post the live lyrics. |
| `/set-targetbot` | `bot` | Set the specific music bot user to track (e.g., Jockie Music, FredBoat, etc.). |
| `/setoffset` | `offset-ms` | Set the baseline lyric timing offset in milliseconds (positive = faster, negative = slower). |
| `/status` | *None* | View the current channel configurations, target bot, and sync offset for the server. |

---

## 🛠️ Installation & Setup

### Prerequisites
*   [Node.js](https://nodejs.org/) (v16.11.0 or higher recommended)
*   A Discord Bot Account with **Message Content Intent** enabled.

### 1. Discord Bot Configuration
1.  Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2.  Create an application and navigate to the **Bot** tab.
3.  Ensure the following **Privileged Gateway Intents** are turned ON:
    *   **Message Content Intent** (⚠️ **Required** to parse music bot messages)
4.  Invite the bot to your server with permissions to manage channels, view channels, send messages, and embed links.

### 2. Environment Variables Setup
Create a `.env` file in the root directory:
```env
YOUR_DISCORD_BOT_TOKEN=your_discord_bot_token_here
```
*(Note: The bot also recognizes `DISCORD_TOKEN`, `BOT_TOKEN`, and `TOKEN` for hosting flexibility).*

### 3. Run the Bot Locally
Install dependencies and start the application:
```bash
# Install dependencies
npm install

# Start the bot
node index.js
```

Upon boot, the bot will automatically register the global slash commands to Discord.

---

## 🐳 Running with Docker (Optional)

If you'd like to containerize your deployment, you can use the included `.dockerignore` file.

1.  **Build the Docker Image:**
    ```bash
    docker build -t lyrika-stanza .
    ```
2.  **Run the Container:**
    ```bash
    docker run -d \
      --name lyrika-stanza \
      -v $(pwd)/database.sqlite:/usr/src/app/database.sqlite \
      -e YOUR_DISCORD_BOT_TOKEN="your_token_here" \
      lyrika-stanza
    ```

---

## 🔍 How it Works (Under the Hood)

1.  **Interception:** The bot listens for `messageCreate` and `messageUpdate` events from the target music bot in the configured channel.
2.  **Cleaning:** The message text (including embeds and components) is passed through a regex-heavy cleaning parser to isolate clean track name and artist query values.
3.  **Fetching:** Query is submitted to LRCLIB search API. If a synced lyrics response is found, it parses timestamps into seconds.
4.  **Ticking:** An internal `setInterval` runs every 400ms tracking the elapsed playback time, applying the server's specific millisecond offset.
5.  **Rendering:** Every time a new line is reached, it updates the visualizer message with a beautiful sliding embed and live buttons.
