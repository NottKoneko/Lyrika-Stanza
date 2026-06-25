# Lyrika-Stanza

Lyrika-Stanza is a live time-synced lyrics stream bot for Discord. It listens for your music bot's "Now Playing" embeds, fetches time-synced lyrics from LRCLIB, and displays a rolling visualization of the lyrics synced perfectly to the playback.

## Features
- **Live Synchronized Lyrics:** Displays rolling lyrics with a highlighted focus frame.
- **Bot Integration:** Hooks into the embeds of your existing music bot (e.g., FredBoat, Jockie Music).
- **Docker Ready:** Built to run instantly in a lightweight container without complex setups.

## Requirements
- Docker and Docker Compose
- A Discord Bot Token
- The User ID of the target music bot you want this bot to follow

## Setup and Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/NottKoneko/Lyrika-Stanza.git
   cd Lyrika-Stanza
   ```

2. **Configure your tokens:**
   Create a `.env` file in the project root by copying or creating one:
   ```env
   YOUR_DISCORD_BOT_TOKEN=your_bot_token_here
   TARGET_BOT_USER_ID=target_music_bot_id_here
   ```

3. **Run the bot via Docker Compose:**
   ```bash
   docker-compose up -d
   ```
   This will build the image and run your bot in the background automatically. To check the logs, run:
   ```bash
   docker-compose logs -f
   ```

## How it Works
1. Invite the Lyrika-Stanza bot to your server.
2. Play a song using your target music bot.
3. Once the target music bot sends a "Now Playing" embed in a channel, Lyrika-Stanza will intercept the track and artist, fetch the lyrics, and provide a live-scrolling lyrics message underneath.

## Technical Notes
- It connects to `https://lrclib.net` to retrieve high-accuracy synced LRC files.
- The visualization frame updates every 400ms to balance timing accuracy with Discord's API rate limits. 
- It gracefully stops tracking when the song finishes.
