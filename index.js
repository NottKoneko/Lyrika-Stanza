const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');
const axios = require('axios');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// CONFIGURATION
const CONFIG = {
    TOKEN: process.env.YOUR_DISCORD_BOT_TOKEN,
    TARGET_BOT_ID: process.env.TARGET_BOT_USER_ID,
    USER_AGENT: 'DiscordLyricsSyncBot/1.0 (contact@yourdomain.com)' 
};

// Global session tracking map (Key: Guild ID, Value: Session Object)
const activeSessions = new Map();

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity('for song updates...', { type: ActivityType.Watching });
});

// Event hook for incoming bot embeds
client.on('messageCreate', async (message) => {
    if (message.author.id !== CONFIG.TARGET_BOT_ID) return;
    if (message.embeds.length === 0) return;

    await handleMusicBotEmbed(message);
});

// Event hook for updated bot embeds (e.g. tracks changing inside the same message)
client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (newMessage.author.id !== CONFIG.TARGET_BOT_ID) return;
    if (newMessage.embeds.length === 0) return;

    await handleMusicBotEmbed(newMessage);
});

/**
 * Parses embed metadata and initializes/updates lyric tracking state.
 */
async function handleMusicBotEmbed(message) {
    const embed = message.embeds[0];
    const guildId = message.guildId;

    // Extract Track and Artist info (Adjust indexing based on your specific music bot's embed schema)
    // Most bots place track names in the Title field or Author field
    const embedTitle = embed.title || '';
    const embedDescription = embed.description || '';

    // Simple Regex pattern to extract metadata. Customize based on target bot output format.
    // Example format matched: "Now Playing: Blinding Lights - The Weeknd"
    const trackMatch = embedTitle.match(/(?:Now Playing:\s*)?(.+?)\s*-\s*(.+)/i) || 
                       embedDescription.match(/(?:Now Playing:\s*)?(.+?)\s*-\s*(.+)/i);

    if (!trackMatch) return;

    const trackName = trackMatch[1].trim();
    const artistName = trackMatch[2].trim();

    // Prevent duplicate triggers if the song hasn't actually changed
    if (activeSessions.has(guildId)) {
        const currentSession = activeSessions.get(guildId);
        if (currentSession.trackName === trackName && currentSession.artistName === artistName) {
            return;
        }
        // Clean up previous active loop before starting a new one
        clearInterval(currentSession.intervalId);
        activeSessions.delete(guildId);
    }

    console.log(`Detected Track Change in [Guild: ${guildId}]: ${trackName} by ${artistName}`);

    // Fetch synced tracking data
    const lyricsData = await fetchSyncedLyrics(trackName, artistName);
    if (!lyricsData) {
        return sendErrorEmbed(message.channel, trackName, artistName);
    }

    // Initialize display canvas message
    const displayEmbed = new EmbedBuilder()
        .setTitle(`🎤 Live Lyrics: ${trackName}`)
        .setDescription('Preparing sync track...')
        .setFooter({ text: `Artist: ${artistName} | Synced via LRCLIB` });

    const displayMessage = await message.channel.send({ embeds: [displayEmbed] });

    // Build Execution State Context
    const session = {
        trackName,
        artistName,
        lyrics: lyricsData,
        displayMessage,
        startTime: Date.now(),
        lastLineIndex: -1,
        intervalId: null
    };

    activeSessions.set(guildId, session);

    // Run the high-resolution execution cycle loop (Every 400ms to balance accuracy and rate limits)
    session.intervalId = setInterval(() => runSyncLoop(guildId), 400);
}

/**
 * Hits the LRCLIB open engine to retrieve accurate time-sync strings.
 */
async function fetchSyncedLyrics(trackName, artistName) {
    try {
        const response = await axios.get('https://lrclib.net/api/get', {
            params: {
                track_name: trackName,
                artist_name: artistName
            },
            headers: { 'User-Agent': CONFIG.USER_AGENT }
        });

        if (response.data && response.data.syncedLyrics) {
            return parseLRC(response.data.syncedLyrics);
        }
        return null;
    } catch (error) {
        console.error(`LRCLIB Fetch Error: ${error.message}`);
        return null;
    }
}

/**
 * Transforms raw LRC timing strings into structural timeline arrays.
 */
function parseLRC(lrcText) {
    const lines = lrcText.split('\n');
    const lyricsTimeline = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

    for (const line of lines) {
        const match = timeRegex.exec(line);
        if (match) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const milliseconds = parseInt(match[3], 10);
            
            // Handle 2-digit vs 3-digit millisecond representations
            const msFactor = match[3].length === 2 ? 10 : 1;
            const absoluteSeconds = (minutes * 60) + seconds + ((milliseconds * msFactor) / 1000);
            
            const lyricText = line.replace(timeRegex, '').trim();
            if (lyricText) {
                lyricsTimeline.push({ time: absoluteSeconds, text: lyricText });
            }
        }
    }
    return lyricsTimeline.sort((a, b) => a.time - b.time);
}

/**
 * The core frame rendering processing logic.
 */
async function runSyncLoop(guildId) {
    const session = activeSessions.get(guildId);
    if (!session) return;

    const elapsedTime = (Date.now() - session.startTime) / 1000;
    
    // Find matching current timeline window index
    let currentLineIndex = -1;
    for (let i = 0; i < session.lyrics.length; i++) {
        if (elapsedTime >= session.lyrics[i].time) {
            currentLineIndex = i;
        } else {
            break;
        }
    }

    // End loop if track timeline has passed the last index boundary
    if (currentLineIndex >= session.lyrics.length - 1 && elapsedTime > session.lyrics[session.lyrics.length - 1].time + 5) {
        clearInterval(session.intervalId);
        const finalEmbed = EmbedBuilder.from(session.displayMessage.embeds[0])
            .setDescription('🎵 *Track playback finished.*');
        await session.displayMessage.edit({ embeds: [finalEmbed] });
        activeSessions.delete(guildId);
        return;
    }

    // ONLY execute a network mutation if the tracking frame steps onto a brand new line
    if (currentLineIndex !== session.lastLineIndex && currentLineIndex !== -1) {
        session.lastLineIndex = currentLineIndex;
        
        // Render a 5-line rolling visualization window
        let dynamicDisplayBuffer = '';
        const startWindow = Math.max(0, currentLineIndex - 2);
        const endWindow = Math.min(session.lyrics.length - 1, currentLineIndex + 2);

        for (let j = startWindow; j <= endWindow; j++) {
            if (j === currentLineIndex) {
                dynamicDisplayBuffer += `👉 **${session.lyrics[j].text}**\n`; // Focus frame highlight
            } else {
                dynamicDisplayBuffer += `🔹 *${session.lyrics[j].text}*\n`;
            }
        }

        try {
            const updateEmbed = EmbedBuilder.from(session.displayMessage.embeds[0])
                .setDescription(dynamicDisplayBuffer);
            await session.displayMessage.edit({ embeds: [updateEmbed] });
        } catch (apiError) {
            console.error(`Discord API Write Failure (Rate Limit Drop): ${apiError.message}`);
        }
    }
}

function sendErrorEmbed(channel, track, artist) {
    const errorEmbed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('❌ Sync Failure')
        .setDescription(`Could not obtain high-accuracy synced tracking information for:\n**${track}** by *${artist}*`);
    channel.send({ embeds: [errorEmbed] });
}

client.login(CONFIG.TOKEN);