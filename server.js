const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = './users_db.json';
const BOTS_FILE = './bots_db.json';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'night-afk-super-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days session
}));

// Global active bot instances (keeps running in background even if web user logs out)
const activeBots = new Map(); // username -> { bot, startTime, afkInterval, reconnectTimer, options, owner }

// ==========================================
// DATABASE UTILITIES
// ==========================================
function loadJson(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) { console.error(`Error loading ${file}:`, err); }
  return {};
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) { console.error(`Error saving ${file}:`, err); }
}

// ==========================================
// PROXY & HELPER UTILITIES
// ==========================================
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  const parts = proxyStr.trim().split(':');
  if (parts.length >= 4) {
    return { host: parts[0], port: parseInt(parts[1], 10), userId: parts[2], password: parts.slice(3).join(':') };
  } else if (parts.length === 2) {
    return { host: parts[0], port: parseInt(parts[1], 10) };
  }
  return null;
}

function extractProxyIp(proxyStr) {
  if (!proxyStr) return 'Direct Connection';
  const parsed = parseProxy(proxyStr);
  return parsed ? parsed.host : 'Unknown Proxy';
}

function createSocksConnect(proxyConfig, targetHost, targetPort) {
  return (clientInstance) => {
    const options = {
      proxy: { host: proxyConfig.host, port: proxyConfig.port, type: 5 },
      command: 'connect',
      destination: { host: targetHost, port: targetPort },
      timeout: 15000
    };
    if (proxyConfig.userId && proxyConfig.password) {
      options.proxy.userId = proxyConfig.userId;
      options.proxy.password = proxyConfig.password;
    }
    SocksClient.createConnection(options)
      .then((info) => {
        clientInstance.setSocket(info.socket);
        clientInstance.emit('connect');
      })
      .catch((err) => {
        clientInstance.emit('error', new Error(`SOCKS5 Error: ${err.message}`));
      });
  };
}

function formatUptime(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  return `${hours}h ${minutes}m ${seconds}s`;
}

// ==========================================
// BOT ENGINE (Background Persistent)
// ==========================================
function startBotInstance(options) {
  const { username, password, proxyStr, mcVersion, host, port, owner } = options;

  const botOpts = {
    host,
    port,
    username,
    version: mcVersion || '1.8.9',
    checkTimeoutInterval: 120000
  };

  if (proxyStr) {
    const parsedProxy = parseProxy(proxyStr);
    if (parsedProxy) botOpts.connect = createSocksConnect(parsedProxy, host, port);
  }

  let bot;
  try {
    bot = mineflayer.createBot(botOpts);
  } catch (err) {
    console.error(`[${username}] Init error:`, err.message);
    return;
  }

  let instanceData = activeBots.get(username) || {
    bot: null,
    startTime: Date.now(),
    afkInterval: null,
    reconnectTimer: null,
    options,
    owner
  };

  instanceData.bot = bot;
  activeBots.set(username, instanceData);

  // Save to user's persistent database
  const allBots = loadJson(BOTS_FILE);
  if (!allBots[owner]) allBots[owner] = {};
  allBots[owner][username] = { username, password, proxyStr, mcVersion, host, port };
  saveJson(BOTS_FILE, allBots);

  bot.once('spawn', () => {
    console.log(`[Bot ${username}] Connected & Spawned in background.`);

    if (instanceData.afkInterval) clearInterval(instanceData.afkInterval);
    instanceData.afkInterval = setInterval(() => {
      if (bot && bot.entity) {
        bot.swingArm('right');
        const yaw = (Math.random() - 0.5) * 0.4;
        const pitch = (Math.random() - 0.5) * 0.4;
        bot.look(bot.entity.yaw + yaw, bot.entity.pitch + pitch, false);
      }
    }, 40000);

    if (password) {
      setTimeout(() => {
        bot.chat(`/register ${password} ${password}`);
        setTimeout(() => bot.chat(`/login ${password}`), 1500);
      }, 3000);
    }
  });

  bot.on('messagestr', (msg) => {
    const text = msg.trim();
    if (!text) return;
    const lower = text.toLowerCase();
    if (password && (lower.includes('/login') || lower.includes('please login'))) {
      bot.chat(`/login ${password}`);
    } else if (password && (lower.includes('/register') || lower.includes('please register'))) {
      bot.chat(`/register ${password} ${password}`);
    }
  });

  const handleDisconnect = () => {
    if (instanceData.afkInterval) clearInterval(instanceData.afkInterval);
    if (activeBots.has(username)) {
      instanceData.reconnectTimer = setTimeout(() => {
        if (activeBots.has(username)) startBotInstance(options);
      }, 10000);
    }
  };

  bot.on('kicked', handleDisconnect);
  bot.on('error', handleDisconnect);
  bot.on('end', handleDisconnect);
}

// ==========================================
// AUTH & API ROUTES
// ==========================================
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = loadJson(USERS_FILE);
  if (users[username]) return res.status(400).json({ error: 'Username already exists' });

  users[username] = password;
  saveJson(USERS_FILE, users);
  req.session.user = username;
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = loadJson(USERS_FILE);

  if (!users[username] || users[username] !== password) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.user = username;
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/session', (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// Middleware for authenticated routes
function requireAuth(req, res, next) {
  if (req.session.user) next();
  else res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/spawn', requireAuth, (req, res) => {
  const { server, username, password, proxy, version } = req.body;
  if (!server || !username) return res.status(400).json({ error: 'Server and username required' });

  if (activeBots.has(username)) {
    return res.status(400).json({ error: 'Bot already online' });
  }

  const [host, portRaw] = server.split(':');
  const port = parseInt(portRaw, 10) || 25565;

  const botOptions = { username, password, proxyStr: proxy, mcVersion: version || '1.8.9', host, port, owner: req.session.user };
  startBotInstance(botOptions);
  res.json({ success: true, message: `Spawning ${username} in background...` });
});

app.post('/api/disconnect', requireAuth, (req, res) => {
  const { username } = req.body;
  const currentUser = req.session.user;

  if (username === 'all') {
    activeBots.forEach((data, name) => {
      if (data.owner === currentUser) {
        if (data.reconnectTimer) clearTimeout(data.reconnectTimer);
        if (data.afkInterval) clearInterval(data.afkInterval);
        if (data.bot) data.bot.quit();
        activeBots.delete(name);
      }
    });
    return res.json({ success: true, message: 'Disconnected all your bots.' });
  }

  const botData = activeBots.get(username);
  if (!botData || botData.owner !== currentUser) return res.status(404).json({ error: 'Bot not found' });

  if (botData.reconnectTimer) clearTimeout(botData.reconnectTimer);
  if (botData.afkInterval) clearInterval(botData.afkInterval);
  if (botData.bot) botData.bot.quit();
  activeBots.delete(username);

  res.json({ success: true, message: `Disconnected ${username}` });
});

app.get('/api/status', requireAuth, (req, res) => {
  const currentUser = req.session.user;
  const statuses = [];

  activeBots.forEach((data, username) => {
    if (data.owner === currentUser) {
      const { bot, startTime, options } = data;
      statuses.push({
        username,
        host: `${options.host}:${options.port}`,
        uptime: formatUptime(Date.now() - startTime),
        health: bot && bot.health ? bot.health.toFixed(1) : 'N/A',
        food: bot && bot.food ? bot.food.toFixed(1) : 'N/A',
        ping: bot && bot.player ? bot.player.ping : 'N/A',
        proxy: extractProxyIp(options.proxyStr)
      });
    }
  });
  res.json(statuses);
});

app.post('/api/chat', requireAuth, (req, res) => {
  const { username, message } = req.body;
  const currentUser = req.session.user;

  if (username === 'all') {
    activeBots.forEach((data) => {
      if (data.owner === currentUser && data.bot) data.bot.chat(message);
    });
    return res.json({ success: true });
  }
  const data = activeBots.get(username);
  if (!data || data.owner !== currentUser || !data.bot) return res.status(404).json({ error: 'Bot offline' });
  data.bot.chat(message);
  res.json({ success: true });
});

app.post('/api/move', requireAuth, (req, res) => {
  const { username, direction, duration = 1000 } = req.body;
  const currentUser = req.session.user;

  const targets = username === 'all' 
    ? Array.from(activeBots.values()).filter(d => d.owner === currentUser) 
    : [activeBots.get(username)].filter(d => d && d.owner === currentUser);

  targets.forEach((data) => {
    if (data && data.bot) {
      data.bot.setControlState(direction, true);
      setTimeout(() => data.bot.setControlState(direction, false), duration);
    }
  });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`[Night AFK] Server running at http://localhost:${PORT}`);
});
         
