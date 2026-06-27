# Lyrika-Stanza

[![Discord.js](https://img.shields.io/badge/discord.js-v14.15-blue.svg?logo=discord&logoColor=white)](https://discord.js.org/)

A Discord bot that provides synchronized, real-time scrolling lyrics for the music playing in your voice channels. Lyrika-Stanza detects songs being played by other music bots and streams the lyrics directly into your text chat.

## Features

- **Live Scrolling Lyrics:** Displays a sliding window of lyrics with a focus frame (`👉`) indicating the current line.
- **Interactive Sync:** Users can manually adjust lyric latency on the fly using inline Discord buttons (`⏪ -0.5s` and `⏩ +0.5s`).
- **Bot Agnostic:** Automatically parses "now playing" messages from most major Discord music bots (Jockie Music, FredBoat, etc.) by stripping emojis and markdown to identify the current track.
- **Zero Config Files:** Fully configurable within Discord using slash commands. No local files to edit.

## Quick Start

1. **Invite the bot** to your Discord server.
2. **Configure channels:** Run `/setup-lyrics` to assign where the bot listens for music updates and where it should post the lyrics.
3. **Target your music bot:** Run `/set-targetbot` and tag your server's music bot so Lyrika-Stanza knows who to track.

## Commands

| Command | Description |
| :--- | :--- |
| `/setup-lyrics` | Configure the listening and output channels. |
| `/set-targetbot` | Set the target music bot you want to track. |
| `/setoffset` | Fine-tune the lyric timing offset for the server. |
| `/status` | View the current configuration status. |

## Contributing

Bug reports, feature requests, and pull requests are welcome. Feel free to open an issue if you find a bug or want to suggest an improvement.
