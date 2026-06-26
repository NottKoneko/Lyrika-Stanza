const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const util = require('util');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose(); // Using pure JS sqlite3

// Initialize Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Load configuration with defensive trimming
const CONFIG = {
    TOKEN: (process.env.YOUR_DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || '').trim(),
    TARGET_BOT_ID: (process.env.TARGET_BOT_USER_ID || process.env.TARGET_BOT_ID || '').trim(),
    SYNC_OFFSET_MS: parseInt(process.env.SYNC_OFFSET_MS) || 0, // Fallback to 0 if not provided by the panel
    USER_AGENT: 'DiscordLyricsLiveVisualizer/2.0 (contact@yourdomain.com)'
};

// Initialize SQLite Database
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('[DB ERROR] Failed to connect:', err.message);
});

// Create table asynchronously if it doesn't exist
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS server_configs (
            guild_id TEXT PRIMARY KEY,
            listen_channel_id TEXT NOT NULL,
            output_channel_id TEXT NOT NULL
        )
    `, (err) => {
        if (err) console.error('[DB ERROR] Failed to create table:', err.message);
    });
});

// Map to hold active song sessions per guild
const activeSessions = new Map();

// Helper to persist updated configuration to .env file (only for SYNC_OFFSET_MS)
// Local file saving deprecated - timing offset configurations persist in-memory on the host
function saveConfigToEnv() {
    console.log(`[CONFIG] Runtime timing offset updated in-memory - SYNC_OFFSET_MS: ${CONFIG.SYNC_OFFSET_MS}`);
    return true;
}


client.once('ready', () => {
    console.log(`[BOOT] Logged in as ${client.user.tag}`);
    client.user.setActivity('Meow Miau Meow', { type: ActivityType.Listening });
    console.log(`[BOOT] Configuration loaded. Tracking Bot ID: ${CONFIG.TARGET_BOT_ID}`);
    console.log(`[BOOT] Multi-server SQLite database initialized.`);
    console.log(`[BOOT] Loaded Sync Offset: ${CONFIG.SYNC_OFFSET_MS}ms`);
    
    // Log the intents requested by the client to verify
    const requestedIntents = client.options.intents.toArray();
    console.log(`[BOOT] Requested Intents in Code: [${requestedIntents.join(', ')}]`);
});

// Event hook for new messages
client.on('messageCreate', async (message) => {
    console.log(`[RAW messageCreate] Event fired. Msg ID: ${message.id} | Author: ${message.author?.tag} (${message.author?.id}) | Channel: ${message.channelId} | Content Length: ${message.content?.length || 0} | Embeds: ${message.embeds?.length || 0} | Type: ${message.type} | IsInteraction: ${!!message.interaction}`);
    
    // Command Handler for Admin Configuration Commands
    if (message.content && message.content.startsWith('!')) {
        const parts = message.content.trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const arg = parts.slice(1).join(' ');
        const guildId = message.guildId;

        const targetCommands = ['!setup-lyrics', '!setlisten', '!setoutput', '!setoffset', '!status', '!lyrikastatus'];
        if (targetCommands.includes(command) && guildId) {
            // Check permissions: restrict to users with ManageChannels or Administrator permissions
            const member = message.member;
            if (!member || (!member.permissions.has(PermissionFlagsBits.ManageChannels) && !member.permissions.has(PermissionFlagsBits.Administrator))) {
                await message.reply('❌ You do not have permission (`Manage Channels` or `Administrator`) to run this command.').catch(console.error);
                return;
            }

            if (command === '!setup-lyrics') {
                const args = parts.slice(1);
                if (args.length < 2) {
                    await message.reply('❌ Usage: `!setup-lyrics <listen_channel_id_or_mention> <output_channel_id_or_mention>`').catch(console.error);
                    return;
                }
                const listenMatch = args[0].match(/^(?:<#)?(\d+)>?$/);
                const outputMatch = args[1].match(/^(?:<#)?(\d+)>?$/);
                if (!listenMatch || !outputMatch) {
                    await message.reply('❌ Invalid channel format. Please specify valid channel IDs or mentions.').catch(console.error);
                    return;
                }
                const listenId = listenMatch[1];
                const outputId = outputMatch[1];

                const listenChannel = message.guild.channels.cache.get(listenId) || await message.guild.channels.fetch(listenId).catch(() => null);
                const outputChannel = message.guild.channels.cache.get(outputId) || await message.guild.channels.fetch(outputId).catch(() => null);
                if (!listenChannel || !outputChannel) {
                    await message.reply('❌ One or both channels were not found in this server.').catch(console.error);
                    return;
                }

                db.run(
                    'INSERT OR REPLACE INTO server_configs (guild_id, listen_channel_id, output_channel_id) VALUES (?, ?, ?)',
                    [guildId, listenId, outputId],
                    async function(err) {
                        if (err) return console.error(err.message);
                        await message.reply(`✅ **Lyrics Configuration Setup Complete!**\n📥 **Listen Channel:** <#${listenId}> (ID: \`${listenId}\`)\n📤 **Output Channel:** <#${outputId}> (ID: \`${outputId}\`)`).catch(console.error);
                    }
                );
                return;
            }

            if (command === '!setlisten') {
                let targetChannelId = message.channelId;
                if (arg) {
                    const match = arg.match(/^(?:<#)?(\d+)>?$/);
                    if (match) {
                        targetChannelId = match[1];
                    } else {
                        await message.reply('❌ Invalid channel format. Please specify a valid channel ID or mention (e.g. #channel).').catch(console.error);
                        return;
                    }
                }
                
                // Verify the channel exists and is readable
                const targetChannel = message.guild.channels.cache.get(targetChannelId) || await message.guild.channels.fetch(targetChannelId).catch(() => null);
                if (!targetChannel) {
                    await message.reply('❌ Channel not found in this server.').catch(console.error);
                    return;
                }

                db.get('SELECT output_channel_id FROM server_configs WHERE guild_id = ?', [guildId], (err, row) => {
                    const currentOutputId = row ? row.output_channel_id : targetChannelId;
                    db.run(
                        'INSERT OR REPLACE INTO server_configs (guild_id, listen_channel_id, output_channel_id) VALUES (?, ?, ?)',
                        [guildId, targetChannelId, currentOutputId],
                        async (err) => {
                            if (err) return console.error(err.message);
                            await message.reply(`✅ **Listen Channel** updated to <#${targetChannelId}> (ID: \`${targetChannelId}\`).`).catch(console.error);
                        }
                    );
                });
                return;
            }

            if (command === '!setoutput') {
                let targetChannelId = message.channelId;
                if (arg) {
                    const match = arg.match(/^(?:<#)?(\d+)>?$/);
                    if (match) {
                        targetChannelId = match[1];
                    } else {
                        await message.reply('❌ Invalid channel format. Please specify a valid channel ID or mention (e.g. #channel).').catch(console.error);
                        return;
                    }
                }
                
                // Verify the channel exists and is readable
                const targetChannel = message.guild.channels.cache.get(targetChannelId) || await message.guild.channels.fetch(targetChannelId).catch(() => null);
                if (!targetChannel) {
                    await message.reply('❌ Channel not found in this server.').catch(console.error);
                    return;
                }

                db.get('SELECT listen_channel_id FROM server_configs WHERE guild_id = ?', [guildId], (err, row) => {
                    const currentListenId = row ? row.listen_channel_id : targetChannelId;
                    db.run(
                        'INSERT OR REPLACE INTO server_configs (guild_id, listen_channel_id, output_channel_id) VALUES (?, ?, ?)',
                        [guildId, currentListenId, targetChannelId],
                        async (err) => {
                            if (err) return console.error(err.message);
                            await message.reply(`✅ **Output Channel** updated to <#${targetChannelId}> (ID: \`${targetChannelId}\`).`).catch(console.error);
                        }
                    );
                });
                return;
            }

            if (command === '!setoffset') {
                if (!arg) {
                    await message.reply(`ℹ️ Current Sync Offset is **${CONFIG.SYNC_OFFSET_MS}ms**. Use \`!setoffset <ms>\` to change it.`).catch(console.error);
                    return;
                }
                const newOffset = parseInt(arg, 10);
                if (isNaN(newOffset)) {
                    await message.reply('❌ Invalid offset value. Please specify a valid integer in milliseconds.').catch(console.error);
                    return;
                }
                CONFIG.SYNC_OFFSET_MS = newOffset;
                saveConfigToEnv();
                await message.reply(`✅ **Sync Offset** updated to **${CONFIG.SYNC_OFFSET_MS}ms**.`).catch(console.error);
                return;
            }

            if (command === '!status' || command === '!lyrikastatus') {
                db.get('SELECT listen_channel_id, output_channel_id FROM server_configs WHERE guild_id = ?', [guildId], async (err, config) => {
                    const listenVal = config ? `<#${config.listen_channel_id}> (ID: \`${config.listen_channel_id}\`)` : '❌ *Not Configured* (Use `!setup-lyrics`)';
                    const outputVal = config ? `<#${config.output_channel_id}> (ID: \`${config.output_channel_id}\`)` : '❌ *Not Configured* (Use `!setup-lyrics`)';

                    const statusEmbed = new EmbedBuilder()
                        .setColor(0x3498db)
                        .setTitle('📊 Lyrika Bot Status & Config')
                        .setDescription('Current database configuration details for this server:')
                        .addFields(
                            { name: '📥 Listen Channel', value: listenVal, inline: true },
                            { name: '📤 Output Channel', value: outputVal, inline: true },
                            { name: '🎵 Target Bot ID', value: `\`${CONFIG.TARGET_BOT_ID}\``, inline: true },
                            { name: '⏱ Sync Offset', value: `\`${CONFIG.SYNC_OFFSET_MS}ms\``, inline: true }
                        )
                        .setTimestamp();
                    await message.reply({ embeds: [statusEmbed] }).catch(console.error);
                });
                return;
            }
        }
    }

    if (message.author?.id === process.env.TARGET_BOT_USER_ID) {
        console.log(`[DUMP] Raw Message Data:`);
        console.log(util.inspect(message, { depth: 1, colors: false }));
    }

    if (message.embeds?.length > 0) {
        console.log(`[DEBUG messageCreate] Embed 0 - Title: "${message.embeds[0].title || ''}" | Description: "${message.embeds[0].description || ''}"`);
    }
    await handleIncomingMessage(message, "CREATE");
});


// Event hook for updated messages
client.on('messageUpdate', async (oldMessage, newMessage) => {
    console.log(`[RAW messageUpdate] Event fired. Msg ID: ${newMessage.id} | Author: ${newMessage.author?.tag} (${newMessage.author?.id}) | Channel: ${newMessage.channelId} | Content Length: ${newMessage.content?.length || 0} | Embeds: ${newMessage.embeds?.length || 0} | Type: ${newMessage.type} | IsInteraction: ${!!newMessage.interaction}`);
    if (newMessage.embeds?.length > 0) {
        console.log(`[DEBUG messageUpdate] Embed 0 - Title: "${newMessage.embeds[0].title || ''}" | Description: "${newMessage.embeds[0].description || ''}"`);
    }
    await handleIncomingMessage(newMessage, "UPDATE");
});

// Event hook for buttons
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    
    if (interaction.customId === 'sync_back') {
        CONFIG.SYNC_OFFSET_MS -= 500;
        saveConfigToEnv();
        await interaction.reply({ content: `⏪ Lyrics slowed down. Current Offset: **${CONFIG.SYNC_OFFSET_MS}ms**`, ephemeral: true });
    } else if (interaction.customId === 'sync_forward') {
        CONFIG.SYNC_OFFSET_MS += 500;
        saveConfigToEnv();
        await interaction.reply({ content: `⏩ Lyrics jumped forward. Current Offset: **${CONFIG.SYNC_OFFSET_MS}ms**`, ephemeral: true });
    }
});


// ==========================================
// 4. PARSING ENGINE (V2 Component Support)
// ==========================================
function extractTextFromComponents(components) {
    let extracted = "";
    function traverse(obj) {
        if (!obj) return;
        if (typeof obj === 'object') {
            if (obj.label) extracted += obj.label + "\n";
            if (obj.value) extracted += obj.value + "\n";
            if (obj.text) extracted += obj.text + "\n";
            if (obj.content) extracted += obj.content + "\n";
            if (obj.description) extracted += obj.description + "\n";
            if (obj.customId) extracted += obj.customId + "\n";
            
            for (const key in obj) {
                if (typeof obj[key] === 'object' || Array.isArray(obj[key])) {
                    traverse(obj[key]);
                }
            }
        }
    }
    traverse(components);
    return extracted;
}

function extractSongInfo(message) {
    let fullText = message.content || "";
    
    // Add embed text
    if (message.embeds?.length > 0) {
        message.embeds.forEach(embed => {
            if (embed.title) fullText += "\n" + embed.title;
            if (embed.description) fullText += "\n" + embed.description;
        });
    }

    // Add V2 Component text
    if (message.components?.length > 0) {
        fullText += "\n" + extractTextFromComponents(message.components);
    }
    
    console.log(`[PARSE] Raw Combined Text to Parse: \n${fullText}`);
    return fullText;
}

/**
 * Extracts payload text from message content, embeds, or V2 Components
 */
function getMessageText(message) {
    return extractSongInfo(message);
}

// Helper to bridge sqlite callback into async/await logic
function getGuildConfig(guildId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT listen_channel_id, output_channel_id FROM server_configs WHERE guild_id = ?', [guildId], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

/**
 * Gatekeeper and Orchestrator for incoming messages
 */
async function handleIncomingMessage(message, eventType) {
    console.log(`[GATEKEEPER - ${eventType}] Checking message ${message.id}...`);
    
    const guildId = message.guildId;
    if (!guildId) return;

    // Fetch config for this guild using the promise helper
    const config = await getGuildConfig(guildId).catch(() => null);
    if (!config) return;

    // Check 1: Channel ID Check
    const channelMatch = message.channelId === config.listen_channel_id;
    console.log(`[GATEKEEPER - ${eventType}] Channel check: Msg Channel=${message.channelId} vs Config Listen=${config.listen_channel_id} | Match=${channelMatch}`);
    if (!channelMatch) return;

    // Check 2: Author ID Check
    const authorMatch = message.author?.id === CONFIG.TARGET_BOT_ID;
    console.log(`[GATEKEEPER - ${eventType}] Author check: Msg Author=${message.author?.id} vs Config Target=${CONFIG.TARGET_BOT_ID} | Match=${authorMatch}`);
    if (!authorMatch) return;

    // Check 3: Content Check
    const messageText = getMessageText(message);
    const textExists = messageText && messageText.trim() !== '';
    console.log(`[GATEKEEPER - ${eventType}] Content check: Text Exists=${!!textExists} | Text length=${messageText?.length || 0}`);
    if (!textExists) return;

    if (!messageText.toLowerCase().includes('now playing')) {
        console.log(`[GATEKEEPER - ${eventType}] Ignored message because it is not a "Now Playing" message.`);
        return;
    }

    console.log(`\n======================================================`);
    console.log(`[EVENT] Target Bot Message Received in Listen Channel`);
    console.log(`[DEBUG] Raw Payload Text: ${messageText.replace(/\n/g, '\\n')}`);

    // Clean and parse the message content
    const searchString = extractSearchString(messageText);
    if (!searchString) {
        console.log(`[PARSER] Could not extract track/artist data. Ignoring.`);
        return;
    }
    
    console.log(`[PARSER] Cleaned Search Query Generated: "${searchString}"`);

    // Prevent duplicate triggers for the same song query
    if (activeSessions.has(guildId)) {
        const currentSession = activeSessions.get(guildId);
        if (currentSession.searchString === searchString) {
            console.log(`[STATE] Already tracking this song. Ignoring duplicate event.`);
            return;
        }
        // Song changed: clear previous loop
        console.log(`[STATE] Track change detected. Clearing previous session.`);
        clearInterval(currentSession.intervalId);
        if (currentSession.displayMessage) {
            try {
                const buttonRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('sync_back')
                            .setLabel('⏪ -0.5s')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId('sync_forward')
                            .setLabel('⏩ +0.5s')
                            .setStyle(ButtonStyle.Primary)
                    );
                const finalEmbed = EmbedBuilder.from(currentSession.displayMessage.embeds[0])
                    .setDescription('🎵 *Track playback finished or skipped.*');
                await currentSession.displayMessage.edit({ embeds: [finalEmbed], components: [buttonRow] });
            } catch(e) { /* ignore */ }
        }
        activeSessions.delete(guildId);
    }

    // Fetch synced tracking data using LRCLIB search API
    const lyricsData = await fetchLyricsFromLRCLIB(searchString);
    if (!lyricsData || lyricsData.length === 0) {
        console.log(`[API] No synced lyrics found for "${searchString}".`);
        return;
    }

    console.log(`[API] Synced lyrics successfully parsed (${lyricsData.length} lines).`);

    // Fetch the designated output channel
    const outputChannel = client.channels.cache.get(config.output_channel_id) || await client.channels.fetch(config.output_channel_id).catch(() => null);
    
    if (!outputChannel) {
        console.error(`[ERROR] Could not resolve Output Channel ID: ${config.output_channel_id}`);
        return;
    }

    // Initialize display canvas message
    const displayEmbed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle(`🎤 Live Lyrics Visualizer`)
        .setDescription('Preparing sync track...\n\n*Waiting for playback...*')
        .setFooter({ text: `Query: ${searchString} | Synced via LRCLIB` });

    const buttonRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('sync_back')
                .setLabel('⏪ -0.5s')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('sync_forward')
                .setLabel('⏩ +0.5s')
                .setStyle(ButtonStyle.Primary)
        );

    const displayMessage = await outputChannel.send({ embeds: [displayEmbed], components: [buttonRow] });
    console.log(`[RENDER] Initial embed posted to Output Channel.`);

    // Build Execution State Context
    const session = {
        searchString,
        lyrics: lyricsData,
        displayMessage,
        startTime: message.createdTimestamp,
        lastLineIndex: -1,
        intervalId: null
    };

    activeSessions.set(guildId, session);

    // Start the interval loop (400ms ticks)
    session.intervalId = setInterval(() => runSyncLoop(guildId), 400);
    console.log(`[ENGINE] Sync loop started.`);
}

/**
 * Aggressive cleaning function for dirty markdown bot payloads
 */
function extractSearchString(content) {
    console.log(`[PARSER] Starting parse on raw content.`);
    const lines = content.split('\n');
    let targetLine = '';

    for (let line of lines) {
        line = line.trim();
        // The song line typically contains "by" or "-" and doesn't contain metadata keywords
        if (
            (line.toLowerCase().includes(' by ') || line.includes(' - ')) && 
            !line.toLowerCase().includes('now playing') && 
            !line.toLowerCase().includes('requested by')
        ) {
            targetLine = line;
            break;
        }
    }

    // Fallback to the whole content if we couldn't isolate a line
    if (!targetLine) {
        console.log(`[PARSER] Could not isolate song line. Using full content fallback.`);
        targetLine = content;
    } else {
        console.log(`[PARSER] Isolated song line: "${targetLine}"`);
    }

    let cleaned = targetLine;

    // 1. Strip markdown links but keep text: [Payphone](https://...) -> Payphone
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    
    // 2. Strip custom Discord emojis: <:chipbot_play:12345> -> ""
    cleaned = cleaned.replace(/<a?:\w+:\d+>/g, '');
    
    // 3. Strip pings: <@885360> -> ""
    cleaned = cleaned.replace(/<@!?\d+>/g, '');
    
    // 4. Strip timestamps like [03:51] or (03:51)
    cleaned = cleaned.replace(/\[\d{2}:\d{2}(:\d{2})?\]/g, '');
    cleaned = cleaned.replace(/\(\d{2}:\d{2}(:\d{2})?\)/g, '');
    
    // 5. Strip common Markdown structural characters (###, *, _, #, -)
    cleaned = cleaned.replace(/[#*_]/g, '');
    
    // 6. Clean up excessive whitespace and trim
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // Remove any trailing or leading hyphens/dashes that might remain
    cleaned = cleaned.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();

    console.log(`[PARSER] Intermediary Cleaned Text: "${cleaned}"`);

    // 7. Attempt to isolate Track and Artist
    let track = '';
    let artist = '';

    if (cleaned.toLowerCase().includes(' by ')) {
        const parts = cleaned.split(/ by /i);
        track = parts[0].trim();
        artist = parts.slice(1).join(' ').trim();
    } else if (cleaned.includes(' - ')) {
        const parts = cleaned.split(/ - /);
        track = parts[0].trim();
        artist = parts.slice(1).join(' ').trim();
    } else {
        return cleaned;
    }

    // Clean up track/artist from remaining brackets (like timestamps if any left)
    track = track.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
    artist = artist.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();

    return `${track} ${artist}`;
}

/**
 * Uses LRCLIB search endpoint and finds the first synced result
 */
async function fetchLyricsFromLRCLIB(searchQuery) {
    console.log(`[API] Searching LRCLIB for: "${searchQuery}"`);
    try {
        const response = await axios.get('https://lrclib.net/api/search', {
            params: { q: searchQuery },
            headers: { 'User-Agent': CONFIG.USER_AGENT }
        });

        const results = response.data;
        if (!Array.isArray(results) || results.length === 0) {
            console.log(`[API] LRCLIB returned 0 results.`);
            return null;
        }

        // Find the first result that contains synced lyrics
        const match = results.find(track => track.syncedLyrics && track.syncedLyrics.trim() !== '');
        
        if (!match) {
            console.log(`[API] Results found, but none contained synced lyrics.`);
            return null;
        }

        console.log(`[API] LRCLIB Match Found! Track ID: ${match.id} | ${match.trackName} by ${match.artistName}`);
        return parseLRC(match.syncedLyrics);

    } catch (error) {
        console.error(`[API] Request Error: ${error.message}`);
        return null;
    }
}

/**
 * Converts standard LRC formatting into a timing array
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
            
            // Normalize MS (LRCLIB uses 2 digits for 10s of MS, but standard allows 3)
            const msFactor = match[3].length === 2 ? 10 : 1;
            const absoluteSeconds = (minutes * 60) + seconds + ((milliseconds * msFactor) / 1000);
            
            const lyricText = line.replace(timeRegex, '').trim();
            if (lyricText) {
                lyricsTimeline.push({ time: absoluteSeconds, text: lyricText });
            }
        }
    }
    // Ensure chronological order
    return lyricsTimeline.sort((a, b) => a.time - b.time);
}

/**
 * 400ms tick engine for visual frame calculation
 */
async function runSyncLoop(guildId) {
    const session = activeSessions.get(guildId);
    if (!session) return;

    // Apply offset (e.g. +2000ms will make the lyrics jump 2 seconds forward)
    const elapsedTime = ((Date.now() - session.startTime) + CONFIG.SYNC_OFFSET_MS) / 1000;
    
    let currentLineIndex = -1;
    // Iterate to find the highest line whose timestamp has passed
    for (let i = 0; i < session.lyrics.length; i++) {
        if (elapsedTime >= session.lyrics[i].time) {
            currentLineIndex = i;
        } else {
            break;
        }
    }

    // Check if the song has ended
    const lastLyric = session.lyrics[session.lyrics.length - 1];
    if (currentLineIndex >= session.lyrics.length - 1 && elapsedTime > lastLyric.time + 5) {
        console.log(`[ENGINE] Track timeline complete.`);
        clearInterval(session.intervalId);
        try {
            const finalEmbed = EmbedBuilder.from(session.displayMessage.embeds[0])
                .setDescription('🎵 *Track playback finished.*');
            await session.displayMessage.edit({ embeds: [finalEmbed] });
        } catch(e) { console.error(`[ERROR] Failed to edit final embed: ${e.message}`); }
        
        activeSessions.delete(guildId);
        return;
    }

    // Rate Limit Protection: Only hit Discord API if the active line moved
    if (currentLineIndex !== session.lastLineIndex && currentLineIndex !== -1) {
        session.lastLineIndex = currentLineIndex;
        
        let dynamicDisplayBuffer = '';
        const startWindow = Math.max(0, currentLineIndex - 2);
        const endWindow = Math.min(session.lyrics.length - 1, currentLineIndex + 2);

        for (let j = startWindow; j <= endWindow; j++) {
            if (j === currentLineIndex) {
                dynamicDisplayBuffer += `👉 **${session.lyrics[j].text}**\n`; // Current line
            } else {
                dynamicDisplayBuffer += `🔹 *${session.lyrics[j].text}*\n`;   // Surrounding lines
            }
        }

        try {
            const buttonRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('sync_back')
                        .setLabel('⏪ -0.5s')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('sync_forward')
                        .setLabel('⏩ +0.5s')
                        .setStyle(ButtonStyle.Primary)
                );
            const updateEmbed = EmbedBuilder.from(session.displayMessage.embeds[0])
                .setDescription(dynamicDisplayBuffer);
            await session.displayMessage.edit({ embeds: [updateEmbed], components: [buttonRow] });
        } catch (apiError) {
            console.error(`[ERROR] Discord API Edit Drop: ${apiError.message}`);
        }
    }
}

// Global unhandled promise rejection catching to keep bot alive
process.on('unhandledRejection', error => {
    console.error(`[FATAL] Unhandled promise rejection:`, error);
});

// Boot
client.login(CONFIG.TOKEN);
