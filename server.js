const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const https = require('https');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Railway Persistent Volume Path mapping for sessions
const sessionStorePath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'sessions') 
  : './sessions';

const sessionMiddleware = session({
  store: new FileStore({
    path: sessionStorePath,
    secret: 'night_afk_glowing_key_2026',
    resave: true,
    saveUninitialized: true,
    retries: 0
  }),
  secret: 'night_afk_glowing_key_2026',
  resave: true,
  saveUninitialized: true,
  cookie: { maxAge: 365 * 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// User Storage & Bot Registry
const users = new Map();
const botInstances = new Map();

// Default Admin User
users.set('Ryuk', {
  username: 'Ryuk',
  email: 'ryuk@nightafk.com',
  password: 'Ryuk#13',
  role: 'admin',
  status: 'active',
  createdAt: new Date().toISOString()
});

// TCP SOCKS5 Real Connection Verification
function testSocks5Proxy(proxyStr) {
  return new Promise((resolve) => {
    if (!proxyStr) return resolve({ success: false, reason: 'No proxy provided.' });
    const parts = proxyStr.trim().split(':');
    if (parts.length < 2) return resolve({ success: false, reason: 'Format must be Host:Port' });

    const host = parts[0];
    const port = parseInt(parts[1], 10);
    const userId = parts[2] || undefined;
    const password = parts[3] || undefined;

    SocksClient.createConnection({
      proxy: { host, port, type: 5, userId, password },
      command: 'connect',
      destination: { host: '1.1.1.1', port: 80 },
      timeout: 6000
    })
    .then(({ socket }) => {
      socket.destroy();
      resolve({ success: true, host, port });
    })
    .catch(err => resolve({ success: false, reason: err.message }));
  });
}

// Scrape Public SOCKS5 Proxy List
function scrapeSocks5Proxies() {
  return new Promise((resolve) => {
    const url = 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt';
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const lines = data.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        resolve(lines.slice(0, 50));
      });
    }).on('error', () => resolve([]));
  });
}

function generateRandomUsername() {
  const prefixes = ['Vortex', 'Shadow', 'Phantom', 'Ghost', 'Spectre', 'Cipher', 'Apex', 'Titan'];
  const suffixes = ['X', '01', 'Void', 'AFK', 'Bot', 'Pro', 'Core', 'Prime'];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  const s = suffixes[Math.floor(Math.random() * suffixes.length)];
  const num = Math.floor(Math.random() * 899) + 100;
  return `${p}_${s}${num}`.slice(0, 16);
}

// Authentication Routes
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required.' });
  if (users.has(username)) return res.status(400).json({ error: 'Username already registered.' });

  users.set(username, {
    username, email, password, role: 'user', status: 'pending', createdAt: new Date().toISOString()
  });
  res.json({ success: true, message: 'Registration submitted! Awaiting activation from Ryuk.' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);

  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials.' });
  if (user.status === 'pending') return res.status(403).json({ error: 'Account pending activation by Admin (Ryuk).' });

  req.session.user = { username: user.username, role: user.role };
  res.json({ success: true, user: req.session.user });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthenticated' });
  res.json(req.session.user);
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Admin Panel APIs
app.get('/api/admin/users', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const list = Array.from(users.values()).map(u => ({
    username: u.username,
    email: u.email,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    botCount: Array.from(botInstances.values()).filter(b => b.ownerUsername === u.username).length
  }));
  res.json(list);
});

app.post('/api/admin/user-action', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { targetUser, action } = req.body;
  const u = users.get(targetUser);
  if (!u) return res.status(404).json({ error: 'User not found' });

  if (action === 'activate') u.status = 'active';
  if (action === 'delete' && targetUser !== 'Ryuk') users.delete(targetUser);

  res.json({ success: true });
});

// Mineflayer Instance Manager (Stationary AFK, Auto Register/Login & Reconnect)
function createWebBot(config, ownerUsername, existingBotId = null) {
  const botId = existingBotId || `bot_${config.username}_${Date.now()}`;

  const botOpts = {
    host: config.host,
    port: parseInt(config.port, 10) || 25565,
    username: config.username,
    version: config.version || '1.8.9',
    checkTimeoutInterval: 120000
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

  const instance = {
    botId,
    bot,
    config,
    ownerUsername,
    startTime: Date.now(),
    reconnectTimer: null,
    manualDisconnect: false
  };

  botInstances.set(botId, instance);

  bot.once('spawn', () => {
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

    const defaultMove = new Movements(bot);
    bot.pathfinder.setMovements(defaultMove);

    // Guaranteed Authentication Sequence on Join & Reconnect
    if (config.password) {
      setTimeout(() => {
        bot.chat(`/register ${config.password} ${config.password}`);
        setTimeout(() => {
          bot.chat(`/login ${config.password}`);
        }, 1500);
      }, 2500);
    }
  });

  bot.on('health', () => {
    emitToUserOrAdmin(ownerUsername, 'bot_health_update', { botId, health: bot.health, food: bot.food });
  });

  bot.on('windowOpen', (window) => {
    const slots = window.slots.map((item, index) => item ? { slot: index, name: item.name, count: item.count } : null);
    emitToUserOrAdmin(ownerUsername, 'bot_inventory_update', { botId, title: window.title, slots });
  });

  bot.on('messagestr', (msg) => {
    emitToUserOrAdmin(ownerUsername, 'bot_chat_log', { botId, message: msg });
  });

  bot.on('end', (reason) => {
    emitToUserOrAdmin(ownerUsername, 'bot_status_update', {
      botId, username: config.username, ownerUsername, status: `Offline (${reason})`
    });

    if (!instance.manualDisconnect) {
      emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, message: 'Disconnected. Auto-reconnecting in 8s...' });
      instance.reconnectTimer = setTimeout(() => {
        if (botInstances.has(botId) && !botInstances.get(botId).manualDisconnect) {
          createWebBot(config, ownerUsername, botId);
        }
      }, 8000);
    } else {
      botInstances.delete(botId);
    }
  });

  bot.on('error', (err) => {
    emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, message: `System Error: ${err.message}` });
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

// Socket Router
io.on('connection', (socket) => {
  const sessionUser = socket.request.session?.user;
  if (!sessionUser) return;

  function isAllowed(botId) {
    const inst = botInstances.get(botId);
    if (!inst) return false;
    return sessionUser.role === 'admin' || inst.ownerUsername === sessionUser.username;
  }

  socket.on('request_bot_sync', () => {
    const list = [];
    botInstances.forEach((inst, id) => {
      if (sessionUser.role === 'admin' || inst.ownerUsername === sessionUser.username) {
        list.push({
          botId: id,
          username: inst.config.username,
          ownerUsername: inst.ownerUsername,
          host: inst.config.host,
          port: inst.config.port,
          status: inst.bot?.entity ? 'Online' : 'Connecting',
          health: inst.bot?.health || 0,
          food: inst.bot?.food || 0,
          uptime: Math.floor((Date.now() - inst.startTime) / 1000)
        });
      }
    });
    socket.emit('bot_sync', list);
  });

  socket.on('get_random_username', () => {
    socket.emit('random_username_res', generateRandomUsername());
  });

  socket.on('test_proxy_tcp', async (proxyStr) => {
    const res = await testSocks5Proxy(proxyStr);
    socket.emit('proxy_test_result', res);
  });

  socket.on('scrape_proxies', async () => {
    const proxies = await scrapeSocks5Proxies();
    socket.emit('scraped_proxies_res', proxies);
  });

  socket.on('spawn_bot', (config) => {
    const botId = createWebBot(config, sessionUser.username);
    socket.emit('bot_spawned', { botId, username: config.username });
  });

  socket.on('disconnect_bot', (botId) => {
    if (!isAllowed(botId)) return;
    const inst = botInstances.get(botId);
    if (inst) {
      inst.manualDisconnect = true;
      if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
      if (inst.bot) inst.bot.quit();
      botInstances.delete(botId);
      emitToUserOrAdmin(inst.ownerUsername, 'bot_removed', botId);
    }
  });

  socket.on('send_chat', ({ botId, message }) => {
    if (isAllowed(botId)) {
      const inst = botInstances.get(botId);
      if (inst && inst.bot) inst.bot.chat(message);
    }
  });

  socket.on('global_chat', ({ message }) => {
    botInstances.forEach(inst => {
      if (sessionUser.role === 'admin' || inst.ownerUsername === sessionUser.username) {
        if (inst.bot) inst.bot.chat(message);
      }
    });
  });

  socket.on('global_move', ({ action }) => {
    botInstances.forEach(inst => {
      if (sessionUser.role === 'admin' || inst.ownerUsername === sessionUser.username) {
        if (inst.bot) {
          if (action === 'jump') {
            inst.bot.setControlState('jump', true);
            setTimeout(() => inst.bot.setControlState('jump', false), 500);
          } else if (action === 'forward') {
            inst.bot.setControlState('forward', true);
            setTimeout(() => inst.bot.setControlState('forward', false), 1000);
          }
        }
      }
    });
  });

  socket.on('fetch_inventory', (botId) => {
    if (!isAllowed(botId)) return;
    const inst = botInstances.get(botId);
    if (!inst || !inst.bot) return;

    const win = inst.bot.currentWindow || inst.bot.inventory;
    const slots = win.slots.map((item, index) => item ? { slot: index, name: item.name, count: item.count } : null);
    socket.emit('bot_inventory_update', { botId, title: win.title || 'Inventory', slots });
  });

  socket.on('click_slot', ({ botId, slotId }) => {
    if (!isAllowed(botId)) return;
    const inst = botInstances.get(botId);
    if (!inst || !inst.bot) return;

    inst.bot.clickWindow(slotId, 0, 0).catch(err => {
      emitToUserOrAdmin(inst.ownerUsername, 'bot_log', { botId, message: `Click error: ${err.message}` });
    });
  });
});

server.listen(PORT, () => {
  console.log(`[Night AFK] Live on port ${PORT}`);
});
            
