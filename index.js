const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const util = require('util');
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

client.once('ready', () => {
    console.log(`[BOOT] Logged in as ${client.user.tag}`);
    client.user.setActivity('Meow Miau Meow', { type: ActivityType.Listening });
    console.log(`[BOOT] Multi-server SQLite database initialized for Wispbyte.`);
    
    // Log the intents requested by the client to verify
    const requestedIntents = client.options.intents.toArray();
    console.log(`[BOOT] Requested Intents in Code: [${requestedIntents.join(', ')}]`);
});

// Event hook for new messages
client.on('messageCreate', async (message) => {
    
    // Command Handler for Admin Configuration Commands
    if (message.content && message.content.startsWith('!')) {
        const parts = message.content.trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const arg = parts.slice(1).join(' ');
        const guildId = message.guildId;

        const targetCommands = ['!setup-lyrics', '!setlisten', '!setoutput', '!setoffset', '!set-targetbot', '!status', '!lyrikastatus'];
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
                    'INSERT INTO server_configs (guild_id, listen_channel_id, output_channel_id, target_bot_id, sync_offset_ms) VALUES (?, ?, ?, NULL, 0) ON CONFLICT(guild_id) DO UPDATE SET listen_channel_id=excluded.listen_channel_id, output_channel_id=excluded.output_channel_id',
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
                
                const targetChannel = message.guild.channels.cache.get(targetChannelId) || await message.guild.channels.fetch(targetChannelId).catch(() => null);
                if (!targetChannel) {
                    await message.reply('❌ Channel not found in this server.').catch(console.error);
                    return;
                }

                db.run(
                    'INSERT INTO server_configs (guild_id, listen_channel_id, output_channel_id, target_bot_id, sync_offset_ms) VALUES (?, ?, "UNSET", NULL, 0) ON CONFLICT(guild_id) DO UPDATE SET listen_channel_id=excluded.listen_channel_id',
                    [guildId, targetChannelId],
                    async (err) => {
                        if (err) return console.error(err.message);
                        await message.reply(`✅ **Listen Channel** updated to <#${targetChannelId}> (ID: \`${targetChannelId}\`).`).catch(console.error);
                    }
                );
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
                
                const targetChannel = message.guild.channels.cache.get(targetChannelId) || await message.guild.channels.fetch(targetChannelId).catch(() => null);
                if (!targetChannel) {
                    await message.reply('❌ Channel not found in this server.').catch(console.error);
                    return;
                }

                db.run(
                    'INSERT INTO server_configs (guild_id, listen_channel_id, output_channel_id, target_bot_id, sync_offset_ms) VALUES (?, "UNSET", ?, NULL, 0) ON CONFLICT(guild_id) DO UPDATE SET output_channel_id=excluded.output_channel_id',
                    [guildId, targetChannelId],
                    async (err) => {
                        if (err) return console.error(err.message);
                        await message.reply(`✅ **Output Channel** updated to <#${targetChannelId}> (ID: \`${targetChannelId}\`).`).catch(console.error);
                    }
                );
                return;
            }

            if (command === '!set-targetbot') {
                if (!arg) {
                    await message.reply('❌ Usage: `!set-targetbot <bot_id_or_mention>`').catch(console.error);
                    return;
                }
                const match = arg.match(/^(?:<@!?)?(\d+)>?$/);
                if (!match) {
                    await message.reply('❌ Invalid ID format. Please specify a valid user ID or mention.').catch(console.error);
                    return;
                }
                const targetBotId = match[1];
                
                db.run(
                    'INSERT INTO server_configs (guild_id, listen_channel_id, output_channel_id, target_bot_id, sync_offset_ms) VALUES (?, "UNSET", "UNSET", ?, 0) ON CONFLICT(guild_id) DO UPDATE SET target_bot_id=excluded.target_bot_id',
                    [guildId, targetBotId],
                    async (err) => {
                        if (err) return console.error(err.message);
                        await message.reply(`✅ **Target Bot ID** updated to \`${targetBotId}\`.`).catch(console.error);
                    }
                );
                return;
            }

            if (command === '!setoffset') {
                db.get('SELECT sync_offset_ms FROM server_configs WHERE guild_id = ?', [guildId], (err, config) => {
                    const currentOffset = config ? config.sync_offset_ms : 0;
                    
                    if (!arg) {
                        message.reply(`ℹ️ Current Sync Offset for this server is **${currentOffset}ms**. Use \`!setoffset <ms>\` to change it.`).catch(console.error);
                        return;
                    }
                    const newOffset = parseInt(arg, 10);
                    if (isNaN(newOffset)) {
                        message.reply('❌ Invalid offset value. Please specify a valid integer in milliseconds.').catch(console.error);
                        return;
                    }
                    
                    db.run(
                        'INSERT INTO server_configs (guild_id, listen_channel_id, output_channel_id, target_bot_id, sync_offset_ms) VALUES (?, "UNSET", "UNSET", NULL, ?) ON CONFLICT(guild_id) DO UPDATE SET sync_offset_ms=excluded.sync_offset_ms',
                        [guildId, newOffset],
                        async (err) => {
                            if (err) return console.error(err.message);
                            if (activeSessions.has(guildId)) {
                                activeSessions.get(guildId).syncOffsetMs = newOffset;
                            }
                            await message.reply(`✅ **Sync Offset** updated to **${newOffset}ms**.`).catch(console.error);
                        }
                    );
                });
                return;
            }

            if (command === '!status' || command === '!lyrikastatus') {
                db.get('SELECT * FROM server_configs WHERE guild_id = ?', [guildId], async (err, config) => {
                    const listenVal = (config && config.listen_channel_id !== 'UNSET') ? `<#${config.listen_channel_id}> (ID: \`${config.listen_channel_id}\`)` : '❌ *Not Configured* (Use `!setup-lyrics`)';
                    const outputVal = (config && config.output_channel_id !== 'UNSET') ? `<#${config.output_channel_id}> (ID: \`${config.output_channel_id}\`)` : '❌ *Not Configured* (Use `!setup-lyrics`)';
                    const targetBotVal = (config && config.target_bot_id) ? `\`${config.target_bot_id}\`` : '❌ *Not Configured* (Use `!set-targetbot`)';
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
                    await message.reply({ embeds: [statusEmbed] }).catch(console.error);
                });
                return;
            }
        }
    }

    await handleIncomingMessage(message, "CREATE");
});

// Event hook for updated messages
client.on('messageUpdate', async (oldMessage, newMessage) => {
    await handleIncomingMessage(newMessage, "UPDATE");
});

// Event hook for buttons
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    
    const guildId = interaction.guildId;
    if (!guildId) return;

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

    // Fetch config for this guild using the promise helper
    const config = await getGuildConfig(guildId).catch(() => null);
    if (!config || !config.target_bot_id || config.listen_channel_id === 'UNSET' || config.output_channel_id === 'UNSET') return;

    // Check 1: Channel ID Check
    if (message.channelId !== config.listen_channel_id) return;

    // Check 2: Author ID Check
    if (message.author?.id !== config.target_bot_id) return;

    // Check 3: Content Check
    const messageText = getMessageText(message);
    if (!messageText || messageText.trim() === '') return;
    if (!messageText.toLowerCase().includes('now playing')) return;

    console.log(`\n======================================================`);
    console.log(`[EVENT] Target Bot Message Received in Listen Channel`);

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
                            .setStyle(ButtonStyle.Primary)
                            .setDisabled(true),
                        new ButtonBuilder()
                            .setCustomId('sync_forward')
                            .setLabel('⏩ +0.5s')
                            .setStyle(ButtonStyle.Primary)
                            .setDisabled(true)
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
        intervalId: null,
        syncOffsetMs: config.sync_offset_ms || 0
    };

    activeSessions.set(guildId, session);

    // Start the interval loop (400ms ticks)
    session.intervalId = setInterval(() => runSyncLoop(guildId), 400);
    console.log(`[ENGINE] Sync loop started.`);
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
    
    // 5. Strip common Markdown structural characters (###, *, _, #, -)
    cleaned = cleaned.replace(/[#*_]/g, '');
    
    // 6. Clean up excessive whitespace and trim
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    cleaned = cleaned.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();

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

    track = track.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
    artist = artist.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();

    return `${track} ${artist}`;
}

async function fetchLyricsFromLRCLIB(searchQuery) {
    try {
        const response = await axios.get('https://lrclib.net/api/search', {
            params: { q: searchQuery },
            headers: { 'User-Agent': CONFIG.USER_AGENT }
        });

        const results = response.data;
        if (!Array.isArray(results) || results.length === 0) {
            return null;
        }

        const match = results.find(track => track.syncedLyrics && track.syncedLyrics.trim() !== '');
        
        if (!match) {
            return null;
        }

        return parseLRC(match.syncedLyrics);

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
    if (!session) return;

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

    if (currentLineIndex !== session.lastLineIndex && currentLineIndex !== -1) {
        session.lastLineIndex = currentLineIndex;
        
        let dynamicDisplayBuffer = '';
        const startWindow = Math.max(0, currentLineIndex - 2);
        const endWindow = Math.min(session.lyrics.length - 1, currentLineIndex + 2);

        for (let j = startWindow; j <= endWindow; j++) {
            if (j === currentLineIndex) {
                dynamicDisplayBuffer += `👉 **${session.lyrics[j].text}**\n`;
            } else {
                dynamicDisplayBuffer += `🔹 *${session.lyrics[j].text}*\n`;
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
console.log(`[BOOT] Attempting login...`);
console.log(`[BOOT] Environment variable check:`);
console.log(`  - YOUR_DISCORD_BOT_TOKEN: ${process.env.YOUR_DISCORD_BOT_TOKEN ? `defined (length: ${process.env.YOUR_DISCORD_BOT_TOKEN.length})` : 'undefined'}`);
console.log(`  - DISCORD_TOKEN: ${process.env.DISCORD_TOKEN ? `defined (length: ${process.env.DISCORD_TOKEN.length})` : 'undefined'}`);
console.log(`  - BOT_TOKEN: ${process.env.BOT_TOKEN ? `defined (length: ${process.env.BOT_TOKEN.length})` : 'undefined'}`);
console.log(`  - TOKEN: ${process.env.TOKEN ? `defined (length: ${process.env.TOKEN.length})` : 'undefined'}`);
console.log(`[BOOT] All environment keys present: [${Object.keys(process.env).join(', ')}]`);
console.log(`[BOOT] Resolved CONFIG.TOKEN length: ${CONFIG.TOKEN.length}`);

if (CONFIG.TOKEN.length === 0) {
    console.error(`[FATAL] No Discord bot token found! Please set YOUR_DISCORD_BOT_TOKEN in your Wispbyte Startup settings.`);
} else {
    if (CONFIG.TOKEN.startsWith('"') || CONFIG.TOKEN.endsWith('"') || CONFIG.TOKEN.startsWith("'") || CONFIG.TOKEN.endsWith("'")) {
        console.warn(`[WARNING] The resolved token starts or ends with quote characters. This will cause Discord to reject it. Please remove any quotes around the value in the Wispbyte panel.`);
    }
}

client.login(CONFIG.TOKEN);
