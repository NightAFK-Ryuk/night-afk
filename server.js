const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const { pathfinder, movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const autoEat = require('mineflayer-auto-eat').plugin;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: 'night_afk_ultra_secure_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(express.static('public'));

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// User Database (In-Memory; extendable to SQLite/MongoDB)
const users = new Map();
const botInstances = new Map();

// Admin Setup
users.set('Ryuk', {
  username: 'Ryuk',
  email: 'admin@nightafk.local',
  password: 'Ryuk#13',
  role: 'admin',
  status: 'active',
  createdAt: new Date().toISOString()
});

function verifyProxy(proxyStr) {
  return new Promise((resolve) => {
    if (!proxyStr) return resolve({ success: false, reason: 'No proxy provided.' });
    const parts = proxyStr.trim().split(':');
    if (parts.length < 2) return resolve({ success: false, reason: 'Format must be Host:Port' });

    SocksClient.createConnection({
      proxy: {
        host: parts[0],
        port: parseInt(parts[1], 10),
        type: 5,
        userId: parts[2] || undefined,
        password: parts[3] || undefined
      },
      command: 'connect',
      destination: { host: '1.1.1.1', port: 80 },
      timeout: 5000
    })
    .then(({ socket }) => {
      socket.destroy();
      resolve({ success: true });
    })
    .catch(err => resolve({ success: false, reason: err.message }));
  });
}

// Authentication & Account Routes
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields are required.' });
  if (users.has(username)) return res.status(400).json({ error: 'Username already taken.' });

  users.set(username, {
    username,
    email,
    password,
    role: 'user',
    status: 'pending',
    createdAt: new Date().toISOString()
  });

  res.json({ success: true, message: 'Registration submitted. Awaiting approval by Ryuk.' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);

  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials.' });
  if (user.status === 'pending') return res.status(403).json({ error: 'Account pending admin activation.' });

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
  const userList = Array.from(users.values()).map(u => ({
    username: u.username,
    email: u.email,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    activeBots: Array.from(botInstances.values()).filter(b => b.ownerUsername === u.username).length
  }));
  res.json(userList);
});

app.post('/api/admin/user-action', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { targetUser, action } = req.body;
  const user = users.get(targetUser);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (action === 'activate') user.status = 'active';
  if (action === 'suspend') user.status = 'suspended';
  if (action === 'delete') users.delete(targetUser);

  res.json({ success: true });
});

// Mineflayer Bot Instantiation
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
        emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, message: `Proxy Error: ${err.message}` });
      });
    };
  }

  const bot = mineflayer.createBot(botOpts);
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);
  bot.loadPlugin(autoEat);

  const instance = {
    botId,
    bot,
    config,
    ownerUsername,
    startTime: Date.now(),
    eatSettings: {
      minHp: config.minHp !== undefined ? parseInt(config.minHp, 10) : 1,
      maxHp: config.maxHp !== undefined ? parseInt(config.maxHp, 10) : 6,
      gappleOnly: config.gappleOnly || false,
      lastEatTime: 0
    },
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
      food: bot.food,
      uptime: 0
    });

    if (config.password) {
      setTimeout(() => {
        bot.chat(`/register ${config.password} ${config.password}`);
        setTimeout(() => bot.chat(`/login ${config.password}`), 1000);
      }, 2000);
    }
  });

  // Custom Auto-Eat & Golden Apple System with 5s Cooldown
  bot.on('health', () => {
    emitToUserOrAdmin(ownerUsername, 'bot_health_update', {
      botId,
      health: bot.health,
      food: bot.food
    });

    const now = Date.now();
    const { minHp, maxHp, gappleOnly, lastEatTime } = instance.eatSettings;

    // Trigger eating within configured bounds (1 to 20 HP)
    if (bot.health <= maxHp && bot.health >= minHp && (now - lastEatTime >= 5000)) {
      instance.eatSettings.lastEatTime = now;

      if (gappleOnly) {
        const gapple = bot.inventory.items().find(item => item.name.includes('golden_apple'));
        if (gapple) {
          bot.equip(gapple, 'hand')
            .then(() => bot.consume())
            .then(() => {
              emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, message: `Ate Golden Apple at ${bot.health} HP.` });
            })
            .catch(err => {
              emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, message: `Gapple consume fail: ${err.message}` });
            });
        } else {
          emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, message: `Low health (${bot.health} HP), but no Golden Apples found.` });
        }
      } else {
        bot.autoEat.eat().catch(() => {});
      }
    }
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
      emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, message: 'Disconnected. Auto-reconnecting in 15 seconds...' });
      instance.reconnectTimer = setTimeout(() => {
        if (botInstances.has(botId) && !botInstances.get(botId).manualDisconnect) {
          createWebBot(config, ownerUsername, botId);
        }
      }, 15000);
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

// Socket Communication Router
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
          uptime: Math.floor((Date.now() - inst.startTime) / 1000),
          eatSettings: inst.eatSettings
        });
      }
    });
    socket.emit('bot_sync', list);
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

  socket.on('update_eat_settings', ({ botId, minHp, maxHp, gappleOnly }) => {
    if (!isAllowed(botId)) return;
    const inst = botInstances.get(botId);
    if (inst) {
      inst.eatSettings.minHp = parseInt(minHp, 10);
      inst.eatSettings.maxHp = parseInt(maxHp, 10);
      inst.eatSettings.gappleOnly = !!gappleOnly;
      emitToUserOrAdmin(inst.ownerUsername, 'bot_log', { botId, message: `Updated Eat Settings: Min ${minHp} HP, Max ${maxHp} HP, Gapple Only: ${gappleOnly}` });
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

  socket.on('start_pvp', ({ botId, targetUsername }) => {
    if (!isAllowed(botId)) return;
    const inst = botInstances.get(botId);
    if (!inst) return;
    const player = inst.bot.players[targetUsername]?.entity;
    if (player) {
      inst.bot.pvp.attack(player);
      emitToUserOrAdmin(inst.ownerUsername, 'bot_log', { botId, message: `PVP engaged against ${targetUsername}` });
    } else {
      emitToUserOrAdmin(inst.ownerUsername, 'bot_log', { botId, message: `Target ${targetUsername} out of render distance.` });
    }
  });

  socket.on('stop_pvp', ({ botId }) => {
    if (!isAllowed(botId)) return;
    const inst = botInstances.get(botId);
    if (inst && inst.bot?.pvp) {
      inst.bot.pvp.stop();
      emitToUserOrAdmin(inst.ownerUsername, 'bot_log', { botId, message: 'PVP disengaged.' });
    }
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
      emitToUserOrAdmin(inst.ownerUsername, 'bot_log', { botId, message: `Click Error: ${err.message}` });
    });
  });
});

server.listen(PORT, () => {
  console.log(`[Night AFK] Production Dashboard active on port ${PORT}`);
});
                      
