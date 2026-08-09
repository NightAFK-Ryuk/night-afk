const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const { pathfinder, movements } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const https = require('https');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: 'night_afk_glowing_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// In-Memory Database
const users = new Map();
const botInstances = new Map();

// Default Admin
users.set('Ryuk', {
  username: 'Ryuk',
  email: 'ryuk@nightafk.com',
  password: 'Ryuk#13',
  role: 'admin',
  createdAt: new Date().toISOString()
});

// --- HTTP Auth Routes ---
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (users.has(username)) {
    return res.status(400).json({ error: 'Username already taken.' });
  }
  const user = { username, email, password, role: 'user', createdAt: new Date().toISOString() };
  users.set(username, user);
  req.session.user = user;
  res.json({ success: true, user: { username, role: user.role } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  req.session.user = user;
  res.json({ success: true, user: { username: user.username, role: user.role } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (req.session.user) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

// --- TCP Proxy Scraper & Real-Time Verifier ---
const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
  'https://raw.githubusercontent.com/prxck/proxy-list/main/socks5.txt'
];

function fetchProxiesFromUrl(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const lines = data.split('\n').map(l => l.trim()).filter(l => l.includes(':'));
        resolve(lines);
      });
    }).on('error', () => resolve([]));
  });
}

async function scrapeAndVerifyProxies(socket) {
  socket.emit('proxy_log', '🔍 Initializing multi-source proxy aggregation...');
  let rawProxies = [];

  for (const src of PROXY_SOURCES) {
    const list = await fetchProxiesFromUrl(src);
    rawProxies = rawProxies.concat(list);
  }

  const uniqueProxies = [...new Set(rawProxies)].slice(0, 50);
  socket.emit('proxy_log', `📦 Aggregated ${uniqueProxies.length} candidates. Initiating TCP handshakes...`);

  let verifiedCount = 0;
  for (const proxyStr of uniqueProxies) {
    const parts = proxyStr.split(':');
    const host = parts[0];
    const port = parseInt(parts[1], 10);

    if (!host || isNaN(port)) continue;

    const startTime = Date.now();
    try {
      const { socket: proxyConn } = await SocksClient.createConnection({
        proxy: { host, port, type: 5 },
        command: 'connect',
        destination: { host: '1.1.1.1', port: 80 },
        timeout: 2500
      });
      proxyConn.destroy();
      const latency = Date.now() - startTime;
      const formatted = `${host}:${port}`;
      verifiedCount++;
      
      socket.emit('proxy_log', `✅ [OPERATIONAL] ${formatted} - Latency: ${latency}ms`);
      socket.emit('proxy_verified_single', formatted);
    } catch (err) {
      socket.emit('proxy_log', `❌ [FAILED] ${host}:${port}`);
    }
  }

  socket.emit('proxy_log', `🎉 Verification complete! ${verifiedCount} operational SOCKS5 proxies ready.`);
}

// --- WebBot Deployment Engine ---
function createWebBot(config, ownerUsername, existingBotId = null) {
  const botId = existingBotId || `bot_${config.username}_${Date.now()}`;

  const botOpts = {
    host: config.host,
    port: parseInt(config.port, 10) || 25565,
    username: config.username,
    version: config.version || '1.8.9',
    checkTimeoutInterval: 120000,
    viewDistance: 'far'
  };

  if (config.proxy) {
    const parts = config.proxy.trim().split(':');
    botOpts.connect = (client) => {
      SocksClient.createConnection({
        proxy: { host: parts[0], port: parseInt(parts[1], 10), type: 5, userId: parts[2], password: parts[3] },
        command: 'connect',
        destination: { host: config.host, port: botOpts.port }
      }).then(({ socket }) => {
        client.setSocket(socket);
        client.emit('connect');
      }).catch(err => {
        emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, message: `Proxy TCP Error: ${err.message}` });
      });
    };
  }

  const bot = mineflayer.createBot(botOpts);
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);

  const instance = {
    botId,
    bot,
    config,
    ownerUsername,
    startTime: Date.now(),
    pvpTarget: null,
    pvpActive: false,
    hardcoreFFA: {
      enabled: config.hardcoreFFA || false,
      kitCommand: config.ffaKit || '/kit ffa',
      autoAttackNearest: config.ffaAutoAttack || false
    },
    manualDisconnect: false
  };

  botInstances.set(botId, instance);

  bot.once('spawn', () => {
    const defaultMove = new movements(bot);
    bot.pathfinder.setMovements(defaultMove);

    emitToUserOrAdmin(ownerUsername, 'bot_status_update', {
      botId,
      username: config.username,
      ownerUsername,
      host: config.host,
      port: config.port,
      status: 'Online',
      health: bot.health,
      food: bot.food
    });

    if (config.password) {
      setTimeout(() => {
        bot.chat(`/register ${config.password} ${config.password}`);
        setTimeout(() => bot.chat(`/login ${config.password}`), 1000);
      }, 1500);
    }

    if (instance.hardcoreFFA.enabled) {
      setTimeout(() => executeFFAKit(instance), 3000);
    }
  });

  // Hardcore FFA Auto-Respawn & Re-kit Engine
  bot.on('death', () => {
    emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, message: '☠️ Bot died! Hardcore FFA Auto-Respawn sequence triggered...' });
    
    if (instance.hardcoreFFA.enabled) {
      setTimeout(() => {
        bot.respawn();
        emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, message: '🔄 Respawned. Requesting Hardcore FFA Kit...' });
        setTimeout(() => executeFFAKit(instance), 2000);
      }, 1000);
    }
  });

  // Continuous Hardcore FFA Engagement Loop
  setInterval(() => {
    if (!bot.entity || !instance.hardcoreFFA.enabled || !instance.hardcoreFFA.autoAttackNearest) return;

    if (!instance.pvpActive || !instance.pvpTarget) {
      const nearestPlayer = bot.nearestEntity(e => e.type === 'player' && e.username !== bot.username);
      if (nearestPlayer) {
        instance.pvpTarget = nearestPlayer.username;
        instance.pvpActive = true;
        bot.pvp.attack(nearestPlayer);
        emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, message: `⚔️ Hardcore FFA: Engaging target ${nearestPlayer.username}` });
      }
    }
  }, 2500);

  function executeFFAKit(inst) {
    if (inst.hardcoreFFA.kitCommand) {
      inst.bot.chat(inst.hardcoreFFA.kitCommand);
      emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, message: `🎒 Executed Kit Command: ${inst.hardcoreFFA.kitCommand}` });
    }
  }

  bot.on('health', () => {
    emitToUserOrAdmin(ownerUsername, 'bot_health_update', { botId, health: bot.health, food: bot.food });
  });

  bot.on('messagestr', (msg) => {
    emitToUserOrAdmin(ownerUsername, 'bot_chat_log', { botId, message: msg });
  });

  bot.on('end', (reason) => {
    emitToUserOrAdmin(ownerUsername, 'bot_status_update', {
      botId, username: config.username, ownerUsername, status: `Offline (${reason})`
    });

    if (!instance.manualDisconnect) {
      setTimeout(() => {
        if (botInstances.has(botId) && !botInstances.get(botId).manualDisconnect) {
          createWebBot(config, ownerUsername, botId);
        }
      }, 10000);
    }
  });

  return botId;
}

function emitToUserOrAdmin(ownerUsername, event, data) {
  io.sockets.sockets.forEach((socket) => {
    const user = socket.request.session?.user;
    if (user && (user.username === ownerUsername || user.role === 'admin')) {
      socket.emit(event, data);
    }
  });
}

// --- Socket Connection Router ---
io.on('connection', (socket) => {
  const sessionUser = socket.request.session?.user;
  if (!sessionUser) return;

  socket.on('request_scrape_and_verify', () => {
    scrapeAndVerifyProxies(socket);
  });

  socket.on('toggle_ffa_mode', ({ botId, enabled, kitCommand, autoAttack }) => {
    const inst = botInstances.get(botId);
    if (inst) {
      inst.hardcoreFFA.enabled = enabled;
      inst.hardcoreFFA.kitCommand = kitCommand || '/kit ffa';
      inst.hardcoreFFA.autoAttackNearest = autoAttack;
      emitToUserOrAdmin(inst.ownerUsername, 'bot_log', { botId, message: `⚙️ Hardcore FFA Mode updated: ${enabled ? 'ENABLED' : 'DISABLED'}` });
    }
  });

  socket.on('spawn_bot', (config) => {
    const botId = createWebBot(config, sessionUser.username);
    socket.emit('bot_spawned', { botId, username: config.username });
  });

  socket.on('disconnect_bot', ({ botId }) => {
    const inst = botInstances.get(botId);
    if (inst) {
      inst.manualDisconnect = true;
      inst.bot.quit();
      botInstances.delete(botId);
      socket.emit('bot_log', { botId, message: '🛑 Bot manually disconnected.' });
    }
  });

  socket.on('send_chat', ({ botId, text }) => {
    const inst = botInstances.get(botId);
    if (inst && inst.bot) {
      inst.bot.chat(text);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Night AFK] Platform online on port ${PORT}`);
});
        
