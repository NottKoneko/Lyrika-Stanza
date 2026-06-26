# Lyrika-Stanza

Lyrika-Stanza is a live time-synced lyrics stream bot for Discord. It intercepts "Now Playing" messages from specific music bots (even those using dirty markdown embeds), fetches time-synced lyrics via LRCLIB's search API, and displays a rolling visualization of the lyrics synced perfectly to the playback in a dedicated text channel.

## Features
- **Live Synchronized Lyrics:** Displays rolling lyrics with a highlighted focus frame (`👉`).
- **Aggressive Parsing:** Cleans raw markdown, strips Discord custom emojis, pings, timestamps, and links from the music bot payload.
- **API Search Engine:** Hits `lrclib.net/api/search` using the cleaned track/artist query.
- **Rate-Limited Engine:** Refreshes the display embed strictly when the lyric line changes to avoid Discord rate limits.
- **Docker Ready:** Built to run instantly in a lightweight container.

## Requirements
- Docker and Docker Compose
- A Discord Bot Token (Ensure the bot has `Message Content` intent enabled in the Developer Portal)
- The User ID of the target music bot you want this bot to follow
- The IDs of the input and output text channels

## Setup and Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/NottKoneko/Lyrika-Stanza.git
   cd Lyrika-Stanza
   ```

2. **Configure your tokens:**
   Create a `.env` file in the project root:
   ```env
   YOUR_DISCORD_BOT_TOKEN=your_bot_token_here
   TARGET_BOT_USER_ID=target_music_bot_id_here
   LISTEN_CHANNEL_ID=channel_id_where_music_bot_posts
   OUTPUT_CHANNEL_ID=channel_id_where_lyrics_will_display
   SYNC_OFFSET_MS=1500 (Optional: Adjust sync timing in milliseconds. Positive jumps lyrics forward, negative slows them down. Default is 0)
   ```

3. **Run the bot via Docker Compose:**
   ```bash
   docker-compose up -d --build
   ```
   This will build the image and run your bot in the background automatically. To view the debug pipeline (message received -> cleaned string -> LRCLIB match), run:
   ```bash
   docker-compose logs -f
   ```

## Technical Notes
- The bot utilizes the `messageCreate` and `messageUpdate` hooks to track song progression.
- The visualization frame polls every 400ms internally, but only sends `message.edit()` requests to the Discord API when the visual frame shifts, ensuring stability.
