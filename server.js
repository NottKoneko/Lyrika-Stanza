const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

// Load environment variables (.env fallback)
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
} catch (e) {}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || process.env.CLIENT_SECRET || '';

// --- Health & Status Endpoint ---
app.get(['/health', '/status'], (req, res) => {
    res.json({
        status: 'online',
        bot: 'Lyrika-Stanza',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// --- Discord OAuth2 Code Exchange Endpoint for Embedded App SDK ---
app.post('/api/token', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ error: 'Missing code in request body' });
        }

        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
        });

        const response = await axios.post('https://discord.com/api/oauth2/token', params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        res.json({ access_token: response.data.access_token });
    } catch (error) {
        console.error('[OAUTH ERROR]', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to exchange authorization code' });
    }
});

// --- HTTP Sync & Polling Endpoint for Discord Activity iframe ---
let syncLogCounter = 0;
app.get('/api/sync', (req, res) => {
    const guildId = req.query.guild_id || req.query.guildId || 'default';
    const session = getOrCreateSession(guildId);
    
    let activeIndex = -1;
    let elapsedMs = 0;

    if (session && session.lyrics && session.lyrics.length > 0) {
        elapsedMs = (Date.now() - session.startTime) + session.syncOffsetMs;
        for (let i = 0; i < session.lyrics.length; i++) {
            if (elapsedMs >= session.lyrics[i].timeMs) {
                activeIndex = i;
            } else {
                break;
            }
        }
    }

    syncLogCounter++;
    if (syncLogCounter % 15 === 0 || (session && session.track)) {
        console.log(`[ACTIVITY API /api/sync] Guild: ${guildId} | Track: "${session ? session.track : 'None'}" | Lines: ${session ? session.lyrics.length : 0} | Active Line: ${activeIndex}`);
    }

    res.json({
        session: session,
        elapsedMs: elapsedMs,
        activeIndex: activeIndex
    });
});

app.post('/api/offset', (req, res) => {
    const { guild_id, deltaMs } = req.body;
    console.log(`[ACTIVITY API /api/offset] Guild: ${guild_id} | Delta: ${deltaMs}ms`);
    updateOffset(guild_id, deltaMs || 0);
    res.json({ success: true });
});

app.post('/api/session', (req, res) => {
    const { guild_id, session } = req.body;
    console.log(`[ACTIVITY API /api/session] Guild: ${guild_id} | Manual track set: "${session ? session.track : 'none'}"`);
    updateSession(guild_id || 'default', session);
    res.json({ success: true });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Guild Session Map: guildId -> session object
const guildSessions = new Map();
let lastActiveSession = null;

function getOrCreateSession(guildId) {
    const key = guildId || 'default';
    if (guildSessions.has(key)) {
        const s = guildSessions.get(key);
        if (s.lyrics && s.lyrics.length > 0) return s;
    }
    if (lastActiveSession && lastActiveSession.lyrics && lastActiveSession.lyrics.length > 0) {
        return lastActiveSession;
    }
    if (!guildSessions.has(key)) {
        guildSessions.set(key, {
            guildId: key,
            track: null,
            artist: null,
            albumArt: null,
            lyrics: [],
            startTime: Date.now(),
            syncOffsetMs: 0,
            isPlaying: false
        });
    }
    return guildSessions.get(key);
}

function broadcastToGuild(guildId, data) {
    const targetKey = guildId || 'default';
    const payload = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            // Broadcast if matching guild, default scope, or single client connected
            if (!client.guildId || client.guildId === 'default' || client.guildId === targetKey || wss.clients.size === 1) {
                client.send(payload);
            }
        }
    });
}

function updateSession(guildId, newSessionData) {
    const key = guildId || 'default';
    const current = getOrCreateSession(key);
    const updated = {
        ...current,
        ...newSessionData,
        guildId: key,
        startTime: newSessionData.startTime || Date.now()
    };
    guildSessions.set(key, updated);
    if (updated.lyrics && updated.lyrics.length > 0) {
        lastActiveSession = updated;
    }
    console.log(`[ACTIVITY SESSION UPDATE] Guild: ${key} | Track: "${updated.track}" | Artist: "${updated.artist}" | Lines: ${updated.lyrics ? updated.lyrics.length : 0} | IsPlaying: ${updated.isPlaying}`);
    broadcastToGuild(key, { type: 'SESSION_UPDATE', session: updated });
}

function updateOffset(guildId, deltaMs) {
    const key = guildId || 'default';
    const current = getOrCreateSession(key);
    current.syncOffsetMs += deltaMs;
    broadcastToGuild(key, { type: 'OFFSET_UPDATE', syncOffsetMs: current.syncOffsetMs });
}

wss.on('connection', (ws) => {
    console.log('[WS] Client connected to Activity WebSocket server.');
    ws.guildId = 'default';

    // Send default/fallback session on initial connect
    ws.send(JSON.stringify({ type: 'SESSION_UPDATE', session: getOrCreateSession('default') }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'JOIN_GUILD') {
                ws.guildId = data.guildId || 'default';
                console.log(`[WS] Client joined guild scope: ${ws.guildId}`);
                ws.send(JSON.stringify({ type: 'SESSION_UPDATE', session: getOrCreateSession(ws.guildId) }));
            } else if (data.type === 'ADJUST_OFFSET') {
                updateOffset(ws.guildId, data.deltaMs || 0);
            } else if (data.type === 'SET_SESSION') {
                updateSession(ws.guildId, data.session);
            }
        } catch (e) {
            console.error('[WS ERROR] Failed to parse message:', e.message);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Client disconnected.');
    });
});

// Periodic sync tick loop (every 300ms) per guild session
setInterval(() => {
    guildSessions.forEach((session, guildId) => {
        if (!session.isPlaying || !session.lyrics || session.lyrics.length === 0) return;
        
        const elapsedMs = (Date.now() - session.startTime) + session.syncOffsetMs;
        
        let activeIndex = -1;
        for (let i = 0; i < session.lyrics.length; i++) {
            if (elapsedMs >= session.lyrics[i].timeMs) {
                activeIndex = i;
            } else {
                break;
            }
        }

        broadcastToGuild(guildId, {
            type: 'TICK',
            elapsedMs: elapsedMs,
            activeIndex: activeIndex
        });
    });
}, 300);

module.exports = {
    app,
    server,
    wss,
    PORT,
    updateSession,
    updateOffset,
    getCurrentSession: () => currentSession,
    startServer: () => {
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.warn(`[HTTP/WS] Port ${PORT} is already in use by host environment. Continuing execution cleanly.`);
            } else {
                console.error('[HTTP/WS Server Error]', err.message);
            }
        });
        try {
            server.listen(PORT, () => {
                console.log(`[HTTP/WS] Discord Activity Server listening on http://localhost:${PORT}`);
            });
        } catch (e) {
            console.warn(`[HTTP/WS] Could not bind port ${PORT}: ${e.message}`);
        }
    }
};
