import { DiscordSDK } from "https://cdn.jsdelivr.net/npm/@discord/embedded-app-sdk@2.5.0/+esm";

let discordSdk = null;
let ws = null;
let currentSession = null;
let activeLyricIndex = -1;

// DOM Elements
const userAvatarEl = document.getElementById('userAvatar');
const userNameEl = document.getElementById('userName');
const songTitleEl = document.getElementById('songTitle');
const songArtistEl = document.getElementById('songArtist');
const statusTextEl = document.getElementById('statusText');
const lyricsCanvasEl = document.getElementById('lyricsCanvas');
const lyricsListEl = document.getElementById('lyricsList');
const emptyStateEl = document.getElementById('emptyState');
const offsetDisplayEl = document.getElementById('offsetDisplay');
const progressBarEl = document.getElementById('progressBar');
const timeElapsedEl = document.getElementById('timeElapsed');
const timeTotalEl = document.getElementById('timeTotal');
const searchInputEl = document.getElementById('searchInput');
const searchBtnEl = document.getElementById('searchBtn');
const btnSlowEl = document.getElementById('btnSlow');
const btnFastEl = document.getElementById('btnFast');

// Initialize Discord SDK & OAuth2 Auth
async function initDiscordSDK() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const clientId = urlParams.get('client_id') || '1519789441143537784'; // Application Client ID

    discordSdk = new DiscordSDK(clientId);
    await discordSdk.ready();
    console.log('[SDK] Discord Activity SDK Ready!');

    // Re-sync guild scope with SDK resolved guild ID
    const activeGuildId = discordSdk.guildId || urlParams.get('guild_id') || 'default';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'JOIN_GUILD', guildId: activeGuildId }));
    }

    // Request OAuth2 code from Discord SDK
    const { code } = await discordSdk.commands.authorize({
      client_id: clientId,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify", "guilds"]
    });

    // Exchange auth code for access token via backend /api/token
    const tokenRes = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });

    if (tokenRes.ok) {
      const { access_token } = await tokenRes.json();
      const auth = await discordSdk.commands.authenticate({ access_token });
      if (auth && auth.user) {
        userNameEl.textContent = `${auth.user.username}`;
        const avatarUrl = auth.user.avatar 
          ? `https://cdn.discordapp.com/avatars/${auth.user.id}/${auth.user.avatar}.png`
          : `https://cdn.discordapp.com/embed/avatars/0.png`;
        userAvatarEl.src = avatarUrl;
      }
    } else {
      userNameEl.textContent = 'Guest Activity User';
    }
  } catch (err) {
    console.warn('[SDK NOTICE] Running outside Discord client or in preview mode:', err.message);
    userNameEl.textContent = 'Web Client Preview';
  }
}

// Connect to WebSocket Server for Real-Time Sync
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[WS] Connected to Lyrika Activity Sync Server');
    statusTextEl.textContent = 'Connected & Synced';
    
    // Join guild scope from Discord SDK or URL params
    const urlParams = new URLSearchParams(window.location.search);
    const currentGuildId = (discordSdk && discordSdk.guildId) || urlParams.get('guild_id') || 'default';
    ws.send(JSON.stringify({ type: 'JOIN_GUILD', guildId: currentGuildId }));
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'SESSION_UPDATE') {
        handleSessionUpdate(data.session);
      } else if (data.type === 'TICK') {
        handleTick(data.elapsedMs, data.activeIndex);
      } else if (data.type === 'OFFSET_UPDATE') {
        handleOffsetUpdate(data.syncOffsetMs);
      }
    } catch (e) {
      console.error('[WS ERROR]', e.message);
    }
  };

  ws.onclose = () => {
    console.warn('[WS] Connection closed. Reconnecting in 3s...');
    statusTextEl.textContent = 'Reconnecting...';
    setTimeout(initWebSocket, 3000);
  };
}

function handleSessionUpdate(session) {
  currentSession = session;
  if (!session || !session.lyrics || session.lyrics.length === 0) {
    emptyStateEl.style.display = 'flex';
    lyricsListEl.innerHTML = '';
    songTitleEl.textContent = session?.track || 'Waiting for Music...';
    songArtistEl.textContent = session?.artist || 'Play a song in Discord or search above';
    return;
  }

  emptyStateEl.style.display = 'none';
  songTitleEl.textContent = session.track || 'Unknown Title';
  songArtistEl.textContent = session.artist || 'Unknown Artist';
  offsetDisplayEl.textContent = `${session.syncOffsetMs || 0}ms`;

  // Render Lyrics Lines
  lyricsListEl.innerHTML = '';
  session.lyrics.forEach((line, index) => {
    const el = document.createElement('div');
    el.className = 'lyric-line';
    el.dataset.index = index;
    el.textContent = line.text;
    el.onclick = () => seekToLine(index);
    lyricsListEl.appendChild(el);
  });

  const lastMs = session.lyrics[session.lyrics.length - 1].timeMs;
  timeTotalEl.textContent = formatTime(lastMs);
}

function handleTick(elapsedMs, activeIndex) {
  if (!currentSession || !currentSession.lyrics) return;

  // Update time elapsed & progress bar
  const totalMs = currentSession.lyrics[currentSession.lyrics.length - 1]?.timeMs || 1;
  const clampedMs = Math.max(0, Math.min(elapsedMs, totalMs));
  timeElapsedEl.textContent = formatTime(clampedMs);
  const percent = Math.min(100, (clampedMs / totalMs) * 100);
  progressBarEl.style.width = `${percent}%`;

  if (activeIndex === activeLyricIndex) return;
  activeLyricIndex = activeIndex;

  // Update active CSS class
  const lines = lyricsListEl.querySelectorAll('.lyric-line');
  lines.forEach((lineEl, idx) => {
    if (idx === activeIndex) {
      lineEl.classList.add('active');
      // Scroll into center view smoothly
      lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      lineEl.classList.remove('active');
    }
  });
}

function handleOffsetUpdate(offsetMs) {
  offsetDisplayEl.textContent = `${offsetMs}ms`;
}

function seekToLine(index) {
  if (!currentSession || !currentSession.lyrics[index]) return;
  const targetMs = currentSession.lyrics[index].timeMs;
  const currentElapsed = (Date.now() - currentSession.startTime) + currentSession.syncOffsetMs;
  const deltaMs = targetMs - currentElapsed;
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ADJUST_OFFSET', deltaMs }));
  }
}

// User Interaction Listeners
btnSlowEl.addEventListener('click', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const guildId = (discordSdk && discordSdk.guildId) || urlParams.get('guild_id') || 'default';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ADJUST_OFFSET', deltaMs: -500 }));
  }
  await fetch('/api/offset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guild_id: guildId, deltaMs: -500 })
  }).catch(() => {});
});

btnFastEl.addEventListener('click', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const guildId = (discordSdk && discordSdk.guildId) || urlParams.get('guild_id') || 'default';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ADJUST_OFFSET', deltaMs: 500 }));
  }
  await fetch('/api/offset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guild_id: guildId, deltaMs: 500 })
  }).catch(() => {});
});

searchBtnEl.addEventListener('click', () => performSearch());
searchInputEl.addEventListener('keyup', (e) => {
  if (e.key === 'Enter') performSearch();
});

async function performSearch() {
  const query = searchInputEl.value.trim();
  if (!query) return;

  try {
    statusTextEl.textContent = `Searching "${query}"...`;
    const res = await fetch(`/api/lyrics/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (Array.isArray(data) && data.length > 0) {
      const match = data.find(t => t.syncedLyrics && t.syncedLyrics.trim() !== '');
      if (match) {
        const parsedLyrics = parseLRC(match.syncedLyrics);
        const newSession = {
          track: match.trackName || query,
          artist: match.artistName || 'LRCLIB Result',
          lyrics: parsedLyrics,
          startTime: Date.now(),
          syncOffsetMs: 0,
          isPlaying: true
        };
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'SET_SESSION', session: newSession }));
        }
        handleSessionUpdate(newSession);
        statusTextEl.textContent = 'Track Loaded';
        return;
      }
    }
    alert(`No synchronized lyrics found for "${query}".`);
    statusTextEl.textContent = 'Connected & Synced';
  } catch (e) {
    console.error('Search error:', e);
    alert('Failed to search lyrics.');
  }
}

function initHttpSyncPolling() {
  setInterval(async () => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const guildId = (discordSdk && discordSdk.guildId) || urlParams.get('guild_id') || 'default';
      const res = await fetch(`/api/sync?guild_id=${encodeURIComponent(guildId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.session && data.session.lyrics && data.session.lyrics.length > 0) {
          if (!currentSession || currentSession.track !== data.session.track || lyricsListEl.children.length === 0) {
            handleSessionUpdate(data.session);
          }
          handleTick(data.elapsedMs, data.activeIndex);
          statusTextEl.textContent = 'Connected & Synced';
        }
      }
    } catch (e) {
      // Ignore polling fetch errors
    }
  }, 400);
}

function parseLRC(lrcText) {
  const lines = lrcText.split('\n');
  const lyrics = [];
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

  for (const line of lines) {
    const match = timeRegex.exec(line);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = parseInt(match[3], 10);
      const factor = match[3].length === 2 ? 10 : 1;
      const totalMs = (min * 60 * 1000) + (sec * 1000) + (ms * factor);
      const text = line.replace(timeRegex, '').trim();
      if (text) {
        lyrics.push({ timeMs: totalMs, text });
      }
    }
  }
  return lyrics.sort((a, b) => a.timeMs - b.timeMs);
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Boot Client App
initDiscordSDK();
initWebSocket();
initHttpSyncPolling();
