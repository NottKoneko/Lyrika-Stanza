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

// --- LRCLIB Search Endpoint for Activity Manual Search ---
app.get('/api/lyrics/search', async (req, res) => {
    try {
        const { q, track_name, artist_name } = req.query;
        let url = 'https://lrclib.net/api/search?q=' + encodeURIComponent(q || '');
        if (track_name && artist_name) {
            url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(track_name)}&artist_name=${encodeURIComponent(artist_name)}`;
        }
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'DiscordLyricsActivity/2.0' }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to search lyrics' });
    }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Current Active Session state across connected Activity frames
let currentSession = {
    track: null,
    artist: null,
    albumArt: null,
    lyrics: [], // [{ timeMs: 12000, text: "Lyric line" }]
    startTime: Date.now(),
    syncOffsetMs: 0,
    isPlaying: false
};

function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

function updateSession(newSessionData) {
    currentSession = {
        ...currentSession,
        ...newSessionData,
        startTime: newSessionData.startTime || Date.now()
    };
    broadcast({ type: 'SESSION_UPDATE', session: currentSession });
}

function updateOffset(deltaMs) {
    currentSession.syncOffsetMs += deltaMs;
    broadcast({ type: 'OFFSET_UPDATE', syncOffsetMs: currentSession.syncOffsetMs });
}

wss.on('connection', (ws) => {
    console.log('[WS] Client connected to Activity WebSocket server.');
    
    // Send current session state on connection
    ws.send(JSON.stringify({ type: 'SESSION_UPDATE', session: currentSession }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'ADJUST_OFFSET') {
                updateOffset(data.deltaMs || 0);
            } else if (data.type === 'SET_SESSION') {
                updateSession(data.session);
            }
        } catch (e) {
            console.error('[WS ERROR] Failed to parse message:', e.message);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Client disconnected.');
    });
});

// Periodic sync tick loop (every 300ms) to sync all connected clients
setInterval(() => {
    if (!currentSession.isPlaying || !currentSession.lyrics || currentSession.lyrics.length === 0) return;
    
    const elapsedMs = (Date.now() - currentSession.startTime) + currentSession.syncOffsetMs;
    
    let activeIndex = -1;
    for (let i = 0; i < currentSession.lyrics.length; i++) {
        if (elapsedMs >= currentSession.lyrics[i].timeMs) {
            activeIndex = i;
        } else {
            break;
        }
    }

    broadcast({
        type: 'TICK',
        elapsedMs: elapsedMs,
        activeIndex: activeIndex
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
        server.listen(PORT, () => {
            console.log(`[HTTP/WS] Discord Activity Server listening on http://localhost:${PORT}`);
        });
    }
};
