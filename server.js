const express = require('express');
const path = require('path');
const fs = require('fs');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = './bots_db.json';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const activeBots = new Map(); // username -> { bot, startTime, afkInterval, reconnectTimer, options }

// ==========================================
// DATABASE UTILITIES
// ==========================================
function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[Database] Load error:', err);
  }
  return {};
}

function saveDatabase(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[Database] Save error:', err);
  }
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
// BOT ENGINE
// ==========================================
function startBotInstance(options) {
  const { username, password, proxyStr, mcVersion, host, port } = options;

  const botOpts = {
    host,
    port,
    username,
    version: mcVersion || '1.8.9',
    checkTimeoutInterval: 120000
  };

  if (proxyStr) {
    const parsedProxy = parseProxy(proxyStr);
    if (parsedProxy) {
      botOpts.connect = createSocksConnect(parsedProxy, host, port);
    }
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
    options
  };

  instanceData.bot = bot;
  activeBots.set(username, instanceData);

  const db = loadDatabase();
  db[username] = { username, password, proxyStr, mcVersion, host, port };
  saveDatabase(db);

  bot.once('spawn', () => {
    console.log(`[Bot ${username}] Connected & Spawned.`);

    // Anti-AFK Loop
    if (instanceData.afkInterval) clearInterval(instanceData.afkInterval);
    instanceData.afkInterval = setInterval(() => {
      if (bot && bot.entity) {
        bot.swingArm('right');
        const yaw = (Math.random() - 0.5) * 0.4;
        const pitch = (Math.random() - 0.5) * 0.4;
        bot.look(bot.entity.yaw + yaw, bot.entity.pitch + pitch, false);
      }
    }, 40000);

    // Auto Login / Register
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
// API ROUTES
// ==========================================
app.post('/api/spawn', (req, res) => {
  const { server, username, password, proxy, version } = req.body;
  if (!server || !username) return res.status(400).json({ error: 'Server and username required' });

  if (activeBots.has(username)) {
    return res.status(400).json({ error: 'Bot already online' });
  }

  const [host, portRaw] = server.split(':');
  const port = parseInt(portRaw, 10) || 25565;

  const botOptions = { username, password, proxyStr: proxy, mcVersion: version || '1.8.9', host, port };
  startBotInstance(botOptions);
  res.json({ success: true, message: `Spawning ${username}...` });
});

app.post('/api/disconnect', (req, res) => {
  const { username } = req.body;
  if (username === 'all') {
    activeBots.forEach((data, name) => {
      if (data.reconnectTimer) clearTimeout(data.reconnectTimer);
      if (data.afkInterval) clearInterval(data.afkInterval);
      if (data.bot) data.bot.quit();
    });
    activeBots.clear();
    return res.json({ success: true, message: 'Disconnected all bots.' });
  }

  const botData = activeBots.get(username);
  if (!botData) return res.status(404).json({ error: 'Bot not found' });

  if (botData.reconnectTimer) clearTimeout(botData.reconnectTimer);
  if (botData.afkInterval) clearInterval(botData.afkInterval);
  if (botData.bot) botData.bot.quit();
  activeBots.delete(username);

  res.json({ success: true, message: `Disconnected ${username}` });
});

app.get('/api/status', (req, res) => {
  const statuses = [];
  activeBots.forEach((data, username) => {
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
  });
  res.json(statuses);
});

app.post('/api/chat', (req, res) => {
  const { username, message } = req.body;
  if (username === 'all') {
    activeBots.forEach((data) => { if (data.bot) data.bot.chat(message); });
    return res.json({ success: true });
  }
  const data = activeBots.get(username);
  if (!data || !data.bot) return res.status(404).json({ error: 'Bot offline' });
  data.bot.chat(message);
  res.json({ success: true });
});

app.post('/api/move', (req, res) => {
  const { username, direction, duration = 1000 } = req.body;
  const targets = username === 'all' ? Array.from(activeBots.values()) : [activeBots.get(username)];

  targets.forEach((data) => {
    if (data && data.bot) {
      data.bot.setControlState(direction, true);
      setTimeout(() => data.bot.setControlState(direction, false), duration);
    }
  });
  res.json({ success: true });
});

app.get('/api/inventory', (req, res) => {
  const { username } = req.query;
  const data = activeBots.get(username);
  if (!data || !data.bot) return res.status(404).json({ error: 'Bot offline' });

  const activeWindow = data.bot.currentWindow || data.bot.inventory;
  const items = activeWindow.items().map(i => ({ slot: i.slot, name: i.name, count: i.count }));
  res.json(items);
});

app.get('/api/admin/vault', (req, res) => {
  const db = loadDatabase();
  res.json(db);
});

app.listen(PORT, () => {
  console.log(`[Server] Night AFK Web Panel running at http://localhost:${PORT}`);
});
    
