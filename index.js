const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ApplicationCommandOptionType } = require('discord.js');
const axios = require('axios');
const util = require('util');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose(); // Using pure JS sqlite3
const { startServer, updateSession, updateOffset } = require('./server');

// Initialize Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});
// Fallback for generic hosts like Wispbyte that don't inject custom env vars: manually parse .env if it exists
try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const envFile = fs.readFileSync(envPath, 'utf8');
        envFile.split('\n').forEach(line => {
            const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
            if (match) {
                const key = match[1];
                let value = match[2] || '';
                if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
                else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
                process.env[key] = value.trim();
            }
        });
    }
} catch (e) {
    // Ignore if no .env file
}

// Load configuration
const CONFIG = {
    TOKEN: (process.env.YOUR_DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || process.env.TOKEN || '').trim(),
    USER_AGENT: 'DiscordLyricsLiveVisualizer/2.0 (contact@yourdomain.com)'
};

// Initialize SQLite Database
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('[DB ERROR] Failed to connect:', err.message);
});

// Create table asynchronously if it doesn't exist, and add new columns if needed
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS server_configs (
            guild_id TEXT PRIMARY KEY,
            listen_channel_id TEXT NOT NULL,
            output_channel_id TEXT NOT NULL,
            target_bot_id TEXT,
            sync_offset_ms INTEGER DEFAULT 0
        )
    `, (err) => {
        if (err) console.error('[DB ERROR] Failed to create table:', err.message);
    });

    // Migrations for Wispbyte optimizations
    db.run('ALTER TABLE server_configs ADD COLUMN target_bot_id TEXT', (err) => {});
    db.run('ALTER TABLE server_configs ADD COLUMN sync_offset_ms INTEGER DEFAULT 0', (err) => {});
});

// Map to hold active song sessions per guild
const activeSessions = new Map();
const startingSessions = new Set();

client.once('ready', async () => {
    console.log(`[BOOT] Logged in as ${client.user.tag}`);
    client.user.setActivity('Meow Miau Meow', { type: ActivityType.Listening });
    console.log(`[BOOT] Multi-server SQLite database initialized for Wispbyte.`);
    
    // Log the intents requested by the client to verify
    const requestedIntents = client.options.intents.toArray();
    console.log(`[BOOT] Requested Intents in Code: [${requestedIntents.join(', ')}]`);

    // Register slash commands globally
    const commands = [
        {
            name: 'setup-lyrics',
            description: 'Setup the channels for the lyrics bot',
            options: [
                {
                    name: 'listen-channel',
                    description: 'The channel to listen for music bot messages',
                    type: ApplicationCommandOptionType.Channel,
                    required: true
                },
                {
                    name: 'output-channel',
                    description: 'The channel to post the live lyrics visualizer',
                    type: ApplicationCommandOptionType.Channel,
                    required: true
                }
            ],
            defaultMemberPermissions: PermissionFlagsBits.ManageChannels
        },
        {
            name: 'set-targetbot',
            description: 'Set the music bot user to listen to',
            options: [
                {
                    name: 'bot',
                    description: 'The music bot user',
                    type: ApplicationCommandOptionType.User,
                    required: true
                }
            ],
            defaultMemberPermissions: PermissionFlagsBits.ManageChannels
        },
        {
            name: 'setoffset',
            description: 'Set synchronization speed offset in milliseconds',
            options: [
                {
                    name: 'offset-ms',
                    description: 'Offset in milliseconds (positive = speed up, negative = slow down)',
                    type: ApplicationCommandOptionType.Integer,
                    required: true
                }
            ],
            defaultMemberPermissions: PermissionFlagsBits.ManageChannels
        },
        {
            name: 'status',
            description: 'Check the current configuration for this server',
            defaultMemberPermissions: PermissionFlagsBits.ManageChannels
        }
    ];

    try {
        for (const cmd of commands) {
            await client.application.commands.create(cmd).catch(err => console.error(`[BOOT] Command create error (${cmd.name}):`, err.message));
        }
        console.log('[BOOT] Successfully registered slash commands.');
    } catch (error) {
        console.error('[BOOT] Error registering slash commands:', error);
    }
});

// Event hook for new messages (strictly for live lyric detection now)
client.on('messageCreate', async (message) => {
    await handleIncomingMessage(message, "CREATE");
});

// Event hook for updated messages
client.on('messageUpdate', async (oldMessage, newMessage) => {
    await handleIncomingMessage(newMessage, "UPDATE");
});

// Event hook for slash commands and buttons
client.on('interactionCreate', async interaction => {
    const guildId = interaction.guildId;
    if (!guildId) return;

    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        // Permissions check: restrict to users with ManageChannels or Administrator permissions
        const member = interaction.member;
        if (!member || (!member.permissions.has(PermissionFlagsBits.ManageChannels) && !member.permissions.has(PermissionFlagsBits.Administrator))) {
            await interaction.reply({ content: '❌ You do not have permission (`Manage Channels` or `Administrator`) to run this command.', ephemeral: true }).catch(console.error);
            return;
        }

        if (commandName === 'setup-lyrics') {
            const listenChannel = interaction.options.getChannel('listen-channel');
            const outputChannel = interaction.options.getChannel('output-channel');

            if (!listenChannel || !outputChannel) {
                await interaction.reply({ content: '❌ One or both channels were not resolved properly.', ephemeral: true }).catch(console.error);
                return;
            }

            db.run(
                'INSERT INTO server_configs (guild_id, listen_channel_id, output_channel_id, target_bot_id, sync_offset_ms) VALUES (?, ?, ?, NULL, 0) ON CONFLICT(guild_id) DO UPDATE SET listen_channel_id=excluded.listen_channel_id, output_channel_id=excluded.output_channel_id',
                [guildId, listenChannel.id, outputChannel.id],
                async function(err) {
                    if (err) {
                        console.error(err.message);
                        return interaction.reply({ content: '❌ Database error saving configuration.', ephemeral: true }).catch(console.error);
                    }
                    await interaction.reply(`✅ **Lyrics Configuration Setup Complete!**\n📥 **Listen Channel:** <#${listenChannel.id}> (ID: \`${listenChannel.id}\`)\n📤 **Output Channel:** <#${outputChannel.id}> (ID: \`${outputChannel.id}\`)`).catch(console.error);
                }
            );
            return;
        }

        if (commandName === 'set-targetbot') {
            const targetBot = interaction.options.getUser('bot');
            if (!targetBot) {
                await interaction.reply({ content: '❌ Bot user not resolved.', ephemeral: true }).catch(console.error);
                return;
            }

            db.run(
                'INSERT INTO server_configs (guild_id, listen_channel_id, output_channel_id, target_bot_id, sync_offset_ms) VALUES (?, "UNSET", "UNSET", ?, 0) ON CONFLICT(guild_id) DO UPDATE SET target_bot_id=excluded.target_bot_id',
                [guildId, targetBot.id],
                async (err) => {
                    if (err) {
                        console.error(err.message);
                        return interaction.reply({ content: '❌ Database error saving configuration.', ephemeral: true }).catch(console.error);
                    }
                    await interaction.reply(`✅ **Target Bot ID** updated to <@${targetBot.id}> (ID: \`${targetBot.id}\`).`).catch(console.error);
                }
            );
            return;
        }

        if (commandName === 'setoffset') {
            const newOffset = interaction.options.getInteger('offset-ms');
            if (newOffset === null) {
                await interaction.reply({ content: '❌ Invalid offset value.', ephemeral: true }).catch(console.error);
                return;
            }

            db.run(
                'INSERT INTO server_configs (guild_id, listen_channel_id, output_channel_id, target_bot_id, sync_offset_ms) VALUES (?, "UNSET", "UNSET", NULL, ?) ON CONFLICT(guild_id) DO UPDATE SET sync_offset_ms=excluded.sync_offset_ms',
                [guildId, newOffset],
                async (err) => {
                    if (err) {
                        console.error(err.message);
                        return interaction.reply({ content: '❌ Database error saving configuration.', ephemeral: true }).catch(console.error);
                    }
                    if (activeSessions.has(guildId)) {
                        activeSessions.get(guildId).syncOffsetMs = newOffset;
                    }
                    await interaction.reply(`✅ **Sync Offset** updated to **${newOffset}ms** for this server.`).catch(console.error);
                }
            );
            return;
        }

        if (commandName === 'status') {
            db.get('SELECT * FROM server_configs WHERE guild_id = ?', [guildId], async (err, config) => {
                if (err) {
                    console.error(err.message);
                    return interaction.reply({ content: '❌ Database error retrieving configuration.', ephemeral: true }).catch(console.error);
                }
                const listenVal = (config && config.listen_channel_id !== 'UNSET') ? `<#${config.listen_channel_id}> (ID: \`${config.listen_channel_id}\`)` : '❌ *Not Configured* (Use `/setup-lyrics`)';
                const outputVal = (config && config.output_channel_id !== 'UNSET') ? `<#${config.output_channel_id}> (ID: \`${config.output_channel_id}\`)` : '❌ *Not Configured* (Use `/setup-lyrics`)';
                const targetBotVal = (config && config.target_bot_id) ? `<@${config.target_bot_id}> (ID: \`${config.target_bot_id}\`)` : '❌ *Not Configured* (Use `/set-targetbot`)';
                const offsetVal = config ? `\`${config.sync_offset_ms}ms\`` : '`0ms`';

                const statusEmbed = new EmbedBuilder()
                    .setColor(0x3498db)
                    .setTitle('📊 Lyrika Bot Status & Config')
                    .setDescription('Current database configuration details for this server:')
                    .addFields(
                        { name: '📥 Listen Channel', value: listenVal, inline: true },
                        { name: '📤 Output Channel', value: outputVal, inline: true },
                        { name: '🎵 Target Bot ID', value: targetBotVal, inline: true },
                        { name: '⏱ Sync Offset', value: offsetVal, inline: true }
                    )
                    .setTimestamp();
                await interaction.reply({ embeds: [statusEmbed] }).catch(console.error);
            });
            return;
        }
    }

    if (interaction.isButton()) {
        if (interaction.customId === 'sync_back' || interaction.customId === 'sync_forward') {
            db.get('SELECT sync_offset_ms FROM server_configs WHERE guild_id = ?', [guildId], (err, config) => {
                let currentOffset = config ? config.sync_offset_ms : 0;

                if (interaction.customId === 'sync_back') {
                    currentOffset -= 500;
                } else {
                    currentOffset += 500;
                }

                db.run(
                    'INSERT INTO server_configs (guild_id, listen_channel_id, output_channel_id, target_bot_id, sync_offset_ms) VALUES (?, "UNSET", "UNSET", NULL, ?) ON CONFLICT(guild_id) DO UPDATE SET sync_offset_ms=excluded.sync_offset_ms',
                    [guildId, currentOffset],
                    async (err) => {
                        if (err) return console.error(err.message);
                        if (activeSessions.has(guildId)) {
                            activeSessions.get(guildId).syncOffsetMs = currentOffset;
                        }
                        const actionText = interaction.customId === 'sync_back' ? '⏪ Lyrics slowed down.' : '⏩ Lyrics jumped forward.';
                        await interaction.reply({ content: `${actionText} Current Offset: **${currentOffset}ms**`, ephemeral: true });
                    }
                );
            });
        }
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
    
    if (message.embeds?.length > 0) {
        message.embeds.forEach(embed => {
            if (embed.author?.name) fullText += "\n" + embed.author.name;
            if (embed.title) fullText += "\n" + embed.title;
            if (embed.description) fullText += "\n" + embed.description;
        });
    }

    if (message.components?.length > 0) {
        fullText += "\n" + extractTextFromComponents(message.components);
    }
    
    return fullText;
}

function getMessageText(message) {
    return extractSongInfo(message);
}

function isMessagePaused(message) {
    if (!message) return false;

    // Strategy 1: Check button customIds in components.
    // Chipbot uses _resume when paused, _pause when playing.
    let hasResumeButton = false;
    let hasPauseButton = false;
    if (message.components?.length > 0) {
        const allText = extractTextFromComponents(message.components);
        const lower = allText.toLowerCase();
        if (lower.includes('_resume')) hasResumeButton = true;
        if (lower.includes('_pause')) hasPauseButton = true;
        // Also check component text display for chipbot_pause emoji name
        if (lower.includes('chipbot_pause')) {
            console.log(`[DEBUG PAUSE CHECK] Found chipbot_pause in components text. isPaused: true`);
            return true;
        }
    }

    // If resume button exists and no pause button → currently paused
    if (hasResumeButton && !hasPauseButton) {
        console.log(`[DEBUG PAUSE CHECK] Found _resume button (no _pause). isPaused: true`);
        return true;
    }

    // Strategy 2: Check message content and embeds
    let bodyText = message.content || "";
    if (message.embeds?.length > 0) {
        message.embeds.forEach(embed => {
            if (embed.author?.name) bodyText += "\n" + embed.author.name;
            if (embed.title) bodyText += "\n" + embed.title;
            if (embed.description) bodyText += "\n" + embed.description;
            if (embed.footer?.text) bodyText += "\n" + embed.footer.text;
        });
    }
    const lower = bodyText.toLowerCase();
    const isPausedResult = lower.includes('chipbot_pause') || lower.includes('⏸') || lower.includes('playback paused') || lower.includes('currently paused');
    console.log(`[DEBUG PAUSE CHECK] bodyText: "${bodyText.trim()}" | resumeBtn: ${hasResumeButton} | pauseBtn: ${hasPauseButton} | isPaused: ${isPausedResult}`);
    return isPausedResult;
}

// Helper to bridge sqlite callback into async/await logic
function getGuildConfig(guildId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM server_configs WHERE guild_id = ?', [guildId], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

/**
 * Gatekeeper and Orchestrator for incoming messages
 */
async function handleIncomingMessage(message, eventType) {
    const guildId = message.guildId;
    if (!guildId) return;

    // Check 1: Extract message text
    const messageText = getMessageText(message);
    if (!messageText || messageText.trim() === '') return;
    const lowerText = messageText.toLowerCase();

    // Must be a bot message or contain playing keywords
    if (!activeSessions.has(guildId) && !lowerText.includes('now playing') && !lowerText.includes('playing')) return;

    // Parse the message content into searchable query and display names
    const parsed = extractSearchString(messageText);
    if (!parsed) return;
    const { query: searchString, track: displayTrack, artist: displayArtist } = parsed;
    if (!searchString) return;

    console.log(`\n======================================================`);
    console.log(`[EVENT ${eventType}] Target Bot Message Received (Guild: ${guildId}, Message ID: ${message.id})`);
    console.log(`[PARSER DEBUG] Full Extracted Message Text:\n${messageText}`);
    console.log(`[PARSER] Cleaned Search Query: "${searchString}" | Track: "${displayTrack}" | Artist: "${displayArtist}"`);

    // Optional DB config checks for filtering target bot / listen channel if set
    const config = await getGuildConfig(guildId).catch(() => null);
    if (config && config.target_bot_id && config.target_bot_id !== 'UNSET') {
        if (message.author?.id !== config.target_bot_id) return;
    }
    if (config && config.listen_channel_id && config.listen_channel_id !== 'UNSET') {
        if (message.channelId !== config.listen_channel_id) return;
    }

    // Handle existing session & pause/resume state
    if (activeSessions.has(guildId)) {
        const currentSession = activeSessions.get(guildId);
        if (currentSession.searchString === searchString) {
            const paused = isMessagePaused(message);
            if (paused && !currentSession.isPaused) {
                console.log(`[STATE] Playback PAUSED for guild ${guildId}`);
                currentSession.isPaused = true;
                currentSession.pauseStartTime = message.editedTimestamp || Date.now();
                updateSession(guildId, { isPlaying: false });
                if (currentSession.displayMessage) {
                    try {
                        const pausedEmbed = EmbedBuilder.from(currentSession.displayMessage.embeds[0])
                            .setDescription('⏸️ **Playback Paused**\n\n*Lyrics sync frozen until resumed.*');
                        currentSession.displayMessage.edit({ embeds: [pausedEmbed] }).catch(() => {});
                    } catch (e) {}
                }
            } else if (!paused && currentSession.isPaused) {
                const resumeTimestamp = message.editedTimestamp || Date.now();
                const pauseDuration = resumeTimestamp - currentSession.pauseStartTime;
                currentSession.startTime += pauseDuration;
                currentSession.isPaused = false;
                currentSession.lastLineIndex = -2;
                updateSession(guildId, { isPlaying: true, startTime: currentSession.startTime });
            }
            return;
        }
        // Song changed: clear previous session
        console.log(`[STATE] Track change detected. Clearing previous session.`);
        clearInterval(currentSession.intervalId);
        updateSession(guildId, { isPlaying: false, track: 'Waiting for Music...', artist: '', lyrics: [] });
        if (currentSession.displayMessage) {
            try {
                const buttonRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder().setCustomId('sync_back').setLabel('⏪ -0.5s').setStyle(ButtonStyle.Primary).setDisabled(true),
                        new ButtonBuilder().setCustomId('sync_forward').setLabel('⏩ +0.5s').setStyle(ButtonStyle.Primary).setDisabled(true)
                    );
                const finalEmbed = EmbedBuilder.from(currentSession.displayMessage.embeds[0])
                    .setDescription('🎵 *Track playback finished or skipped.*');
                await currentSession.displayMessage.edit({ embeds: [finalEmbed], components: [buttonRow] }).catch(() => {});
            } catch(e) {}
        }
        activeSessions.delete(guildId);
    }

    if (startingSessions.has(guildId)) return;
    startingSessions.add(guildId);

    try {
        // Fetch synced lyrics from LRCLIB
        const lyricsData = await fetchLyricsFromLRCLIB(searchString);
        if (!lyricsData || lyricsData.length === 0) {
            console.log(`[API] No synced lyrics found for "${searchString}".`);
            updateSession(guildId, { track: displayTrack, artist: `${displayArtist} (No Synced Lyrics)`, lyrics: [], isPlaying: false });
            return;
        }

        console.log(`[API] Synced lyrics parsed (${lyricsData.length} lines) for "${displayTrack}".`);
        const activityLyrics = lyricsData.map(l => ({ timeMs: Math.round(l.time * 1000), text: l.text }));
        const initialPaused = isMessagePaused(message);
        const startTimeMs = message.editedTimestamp || message.createdTimestamp || Date.now();

        // IMMEDIATELY UPDATE DISCORD ACTIVITY SESSION
        console.log(`[BOT -> ACTIVITY] Forwarding track to Activity for Guild ${guildId}: Track="${displayTrack}", Artist="${displayArtist}", LyricsCount=${activityLyrics.length}`);
        updateSession(guildId, {
            track: displayTrack,
            artist: displayArtist,
            lyrics: activityLyrics,
            startTime: startTimeMs,
            syncOffsetMs: config ? (config.sync_offset_ms || 0) : 0,
            isPlaying: !initialPaused
        });

        // Optional text channel visualizer embed update
        if (config && config.output_channel_id && config.output_channel_id !== 'UNSET') {
            const outputChannel = client.channels.cache.get(config.output_channel_id) || await client.channels.fetch(config.output_channel_id).catch(() => null);
            if (outputChannel) {
                const displayEmbed = new EmbedBuilder()
                    .setColor(0x00ff00)
                    .setTitle(`🎤 Live Lyrics Visualizer`)
                    .setDescription('Preparing sync track...\n\n*Waiting for playback...*')
                    .setFooter({ text: `Query: ${searchString} | Synced via LRCLIB` });

                const buttonRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder().setCustomId('sync_back').setLabel('⏪ -0.5s').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('sync_forward').setLabel('⏩ +0.5s').setStyle(ButtonStyle.Primary)
                    );

                const displayMessage = await outputChannel.send({ embeds: [displayEmbed], components: [buttonRow] }).catch(() => null);
                if (displayMessage) {
                    const session = {
                        searchString,
                        lyrics: lyricsData,
                        displayMessage,
                        startTime: startTimeMs,
                        lastLineIndex: -2,
                        intervalId: null,
                        syncOffsetMs: config ? (config.sync_offset_ms || 0) : 0,
                        isPaused: initialPaused,
                        pauseStartTime: initialPaused ? (message.editedTimestamp || Date.now()) : 0,
                        lastEditTimestamp: 0,
                        pendingRender: false
                    };
                    activeSessions.set(guildId, session);
                    session.intervalId = setInterval(() => runSyncLoop(guildId), 400);
                }
            }
        }
    } finally {
        startingSessions.delete(guildId);
    }
}

function extractSearchString(content) {
    const lines = content.split('\n');
    let targetLine = '';

    for (let line of lines) {
        line = line.trim();
        if (
            (line.toLowerCase().includes(' by ') || line.includes(' - ')) &&
            !line.toLowerCase().includes('now playing') &&
            !line.toLowerCase().includes('requested by')
        ) {
            targetLine = line;
            break;
        }
    }

    if (!targetLine) {
        targetLine = content;
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
    
    // 5. Strip common Markdown structural characters (###, *, _, #)
    cleaned = cleaned.replace(/[#*_]/g, '');
    
    // 6. Clean up excessive whitespace and trim
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();

    // 7. Isolate Track and Artist, preserving both for display and search
    let track = '';
    let artist = '';

    if (cleaned.toLowerCase().includes(' by ')) {
        const parts = cleaned.split(/ by /i);
        track = parts[0].trim().replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
        artist = parts.slice(1).join(' by ').trim().replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
    } else if (cleaned.includes(' - ')) {
        const parts = cleaned.split(/ - /);
        track = parts[0].trim().replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
        artist = parts.slice(1).join(' - ').trim().replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
    } else {
        // No separator found — use full cleaned string as query, no artist
        return { query: cleaned, track: cleaned, artist: 'Synced Audio' };
    }

    if (!track) return null;

    // Return structured result: query for LRCLIB, track+artist for display
    return {
        query: `${track} ${artist}`,   // LRCLIB search string (no separator needed)
        track,
        artist: artist || 'Synced Audio'
    };
}

const lyricsCache = new Map();

async function fetchLyricsFromLRCLIB(searchQuery) {
    if (lyricsCache.has(searchQuery)) {
        console.log(`[API] Returning cached lyrics for "${searchQuery}".`);
        return lyricsCache.get(searchQuery);
    }
    try {
        const response = await axios.get('https://lrclib.net/api/search', {
            params: { q: searchQuery },
            headers: { 'User-Agent': CONFIG.USER_AGENT }
        });

        const results = response.data;
        if (!Array.isArray(results) || results.length === 0) {
            lyricsCache.set(searchQuery, null);
            return null;
        }

        const match = results.find(track => track.syncedLyrics && track.syncedLyrics.trim() !== '');
        
        if (!match) {
            lyricsCache.set(searchQuery, null);
            return null;
        }

        const parsed = parseLRC(match.syncedLyrics);
        // Cache parsed lyrics (keep cache size <= 50)
        if (lyricsCache.size > 50) lyricsCache.clear();
        lyricsCache.set(searchQuery, parsed);
        return parsed;

    } catch (error) {
        console.error(`[API] Request Error: ${error.message}`);
        return null;
    }
}

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

async function runSyncLoop(guildId) {
    const session = activeSessions.get(guildId);
    if (!session || session.isPaused) return;

    const elapsedTime = ((Date.now() - session.startTime) + session.syncOffsetMs) / 1000;
    
    let currentLineIndex = -1;
    for (let i = 0; i < session.lyrics.length; i++) {
        if (elapsedTime >= session.lyrics[i].time) {
            currentLineIndex = i;
        } else {
            break;
        }
    }

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

    if (currentLineIndex !== session.lastLineIndex) {
        session.lastLineIndex = currentLineIndex;
        session.pendingRender = true;
    }

    if (session.pendingRender) {
        const now = Date.now();
        if (now - session.lastEditTimestamp >= 900) {
            session.lastEditTimestamp = now;
            session.pendingRender = false;

            const activeIndex = session.lastLineIndex;
            let dynamicDisplayBuffer = '';
            if (activeIndex === -1) {
                dynamicDisplayBuffer += `🎶 *[Instrumental Intro]*\n\n`;
                const endWindow = Math.min(session.lyrics.length - 1, 2);
                for (let j = 0; j <= endWindow; j++) {
                    dynamicDisplayBuffer += `🔹 *${session.lyrics[j].text}*\n`;
                }
            } else {
                const startWindow = Math.max(0, activeIndex - 2);
                const endWindow = Math.min(session.lyrics.length - 1, activeIndex + 2);

                for (let j = startWindow; j <= endWindow; j++) {
                    if (j === activeIndex) {
                        dynamicDisplayBuffer += `👉 **${session.lyrics[j].text}**\n`;
                    } else {
                        dynamicDisplayBuffer += `🔹 *${session.lyrics[j].text}*\n`;
                    }
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
}

// Global unhandled promise rejection catching to keep bot alive
process.on('unhandledRejection', error => {
    console.error(`[FATAL] Unhandled promise rejection:`, error);
});

// Boot
console.log(`[BOOT] Attempting login...`);
console.log(`[BOOT] Environment variable check:`);
console.log(`  - YOUR_DISCORD_BOT_TOKEN: ${process.env.YOUR_DISCORD_BOT_TOKEN ? `defined (length: ${process.env.YOUR_DISCORD_BOT_TOKEN.length})` : 'undefined'}`);
console.log(`  - DISCORD_TOKEN: ${process.env.DISCORD_TOKEN ? `defined (length: ${process.env.DISCORD_TOKEN.length})` : 'undefined'}`);
console.log(`  - BOT_TOKEN: ${process.env.BOT_TOKEN ? `defined (length: ${process.env.BOT_TOKEN.length})` : 'undefined'}`);
console.log(`  - TOKEN: ${process.env.TOKEN ? `defined (length: ${process.env.TOKEN.length})` : 'undefined'}`);
console.log(`[BOOT] All environment keys present: [${Object.keys(process.env).join(', ')}]`);
console.log(`[BOOT] Resolved CONFIG.TOKEN length: ${CONFIG.TOKEN.length}`);

// Start Discord Embedded App Activity Server
startServer();

if (CONFIG.TOKEN.length > 0) {
    client.login(CONFIG.TOKEN);
}
