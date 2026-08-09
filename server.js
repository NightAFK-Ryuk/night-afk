const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const { pathfinder } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const autoEat = require('mineflayer-auto-eat').plugin;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: 'night_afk_private_key_99',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(express.static('public'));

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

const users = new Map();
const botInstances = new Map();

// Default Admin User
users.set('Ryuk', {
  username: 'Ryuk',
  email: 'admin@nightafk.local',
  password: 'Ryuk#13',
  role: 'admin',
  status: 'active'
});

function generateRandomUsername() {
  const prefixes = ['cast', 'mist', 'shadow', 'void', 'frost', 'ember', 'dark', 'storm'];
  const suffixes = ['spell', 'death', 'blade', 'soul', 'walker', 'rider', 'strike'];
  let name = prefixes[Math.floor(Math.random() * prefixes.length)] + suffixes[Math.floor(Math.random() * suffixes.length)];
  if (name.length < 5) name += Math.floor(Math.random() * 100);
  return name.slice(0, 12);
}

function verifyProxy(proxyStr) {
  return new Promise((resolve) => {
    if (!proxyStr) return resolve({ success: false, reason: 'No proxy string provided.' });
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

app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required.' });
  if (users.has(username)) return res.status(400).json({ error: 'Username already exists.' });

  users.set(username, { username, email, password, role: 'user', status: 'pending' });
  res.json({ message: 'Registration submitted! Awaiting admin approval from Ryuk.' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);

  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials.' });
  if (user.status === 'pending') return res.status(403).json({ error: 'Account pending admin activation by Ryuk.' });

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

app.get('/api/admin/users', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  res.json(Array.from(users.values()).map(u => ({ username: u.username, email: u.email, status: u.status, role: u.role })));
});

app.post('/api/admin/activate', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { targetUser } = req.body;
  if (users.has(targetUser)) {
    users.get(targetUser).status = 'active';
    return res.json({ success: true, message: `Account ${targetUser} activated.` });
  }
  res.status(404).json({ error: 'User not found' });
});

function createWebBot(config, ownerUsername, existingBotId = null) {
  const botId = existingBotId || `${config.username}_${Date.now()}`;

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
        emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, log: `Proxy Error: ${err.message}` });
      });
    };
  }

  const bot = mineflayer.createBot(botOpts);
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);
  bot.loadPlugin(autoEat);

  const instance = { 
    bot, 
    config, 
    autoEatHp: config.autoEatHp || 10, 
    autoMessengerInterval: null, 
    reconnectTimer: null,
    manualDisconnect: false,
    ownerUsername 
  };
  
  botInstances.set(botId, instance);

  bot.once('spawn', () => {
    emitToUserOrAdmin(ownerUsername, 'bot_status', {
      botId, username: config.username, ownerUsername, status: 'Online', health: bot.health, food: bot.food
    });

    bot.autoEat.options = { priority: 'foodPoints', startHTML: instance.autoEatHp * 2, eatingTimeout: 3000 };

    if (config.password) {
      setTimeout(() => {
        bot.chat(`/register ${config.password} ${config.password}`);
        setTimeout(() => bot.chat(`/login ${config.password}`), 1000);
      }, 2000);
    }
  });

  bot.on('health', () => {
    emitToUserOrAdmin(ownerUsername, 'bot_health_update', { botId, health: bot.health, food: bot.food });
    if (bot.health <= instance.autoEatHp) bot.autoEat.eat().catch(() => {});
  });

  bot.on('windowOpen', (window) => {
    const items = window.slots.map((item, index) => item ? { slot: index, name: item.name, count: item.count } : null);
    emitToUserOrAdmin(ownerUsername, 'bot_window_open', { botId, title: window.title, slots: items });
  });

  bot.on('messagestr', (msg) => {
    emitToUserOrAdmin(ownerUsername, 'bot_chat_log', { botId, username: config.username, message: msg });
  });

  bot.on('end', (reason) => {
    if (instance.autoMessengerInterval) clearInterval(instance.autoMessengerInterval);

    emitToUserOrAdmin(ownerUsername, 'bot_status', { botId, username: config.username, ownerUsername, status: `Offline (${reason})` });

    // --- AUTO-RECONNECT SYSTEM ---
    if (!instance.manualDisconnect) {
      emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, log: 'Disconnected. Auto-reconnecting in 15 seconds...' });
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
    emitToUserOrAdmin(ownerUsername, 'bot_log', { botId, log: `Error: ${err.message}` });
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

io.on('connection', (socket) => {
  const sessionUser = socket.request.session?.user;
  if (!sessionUser) return;

  socket.on('request_bot_sync', () => {
    const list = [];
    botInstances.forEach((inst, id) => {
      if (sessionUser.role === 'admin' || inst.ownerUsername === sessionUser.username) {
        list.push({
          botId: id,
          username: inst.config.username,
          ownerUsername: inst.ownerUsername,
          host: inst.config.host,
          status: inst.bot?.entity ? 'Online' : 'Connecting',
          health: inst.bot?.health || 0,
          food: inst.bot?.food || 0
        });
      }
    });
    socket.emit('bot_sync', list);
  });

  socket.on('generate_username', () => socket.emit('username_generated', generateRandomUsername()));

  socket.on('test_proxy', async (proxyStr) => {
    const res = await verifyProxy(proxyStr);
    socket.emit('proxy_test_result', res);
  });

  socket.on('spawn_bot', (config) => {
    const botId = createWebBot(config, sessionUser.username);
    socket.emit('bot_spawned', { botId, username: config.username });
  });

  function isAllowed(botId) {
    const inst = botInstances.get(botId);
    if (!inst) return false;
    return sessionUser.role === 'admin' || inst.ownerUsername === sessionUser.username;
  }

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

  socket.on('send_chat', ({ botIds, message }) => {
    botIds.forEach(id => {
      if (isAllowed(id)) {
        const inst = botInstances.get(id);
        if (inst && inst.bot) inst.bot.chat(message);
      }
    });
  });

  socket.on('toggle_messenger', ({ botId, enabled, message }) => {
    if (!isAllowed(botId)) return;
    const inst = botInstances.get(botId);
    if (!inst) return;

    if (inst.autoMessengerInterval) clearInterval(inst.autoMessengerInterval);

    if (enabled && message) {
      inst.bot.chat(message);
      inst.autoMessengerInterval = setInterval(() => {
        if (inst.bot) inst.bot.chat(message);
      }, 60000);
      emitToUserOrAdmin(inst.ownerUsername, 'bot_log', { botId, log: 'Auto-messenger activated (60s loop).' });
    } else {
      emitToUserOrAdmin(inst.ownerUsername, 'bot_log', { botId, log: 'Auto-messenger stopped.' });
    }
  });

  socket.on('start_pvp', ({ botId, targetUsername }) => {
    if (!isAllowed(botId)) return;
    const inst = botInstances.get(botId);
    if (!inst) return;
    const player = inst.bot.players[targetUsername]?.entity;
    if (player) {
      inst.bot.pvp.attack(player);
      emitToUserOrAdmin(inst.ownerUsername, 'bot_log', { botId, log: `PVP engaged against ${targetUsername}` });
    } else {
      emitToUserOrAdmin(inst.ownerUsername, 'bot_log', { botId, log: `Target ${targetUsername} out of view range.` });
    }
  });

  socket.on('fetch_inventory', (botId) => {
    if (!isAllowed(botId)) return;
    const inst = botInstances.get(botId);
    if (!inst || !inst.bot) return;

    const win = inst.bot.currentWindow || inst.bot.inventory;
    const items = win.slots.map((item, index) => item ? { slot: index, name: item.name, count: item.count } : null);
    socket.emit('bot_window_open', { botId, title: win.title || 'Inventory', slots: items });
  });

  socket.on('click_slot', ({ botId, slotId }) => {
    if (!isAllowed(botId)) return;
    const inst = botInstances.get(botId);
    if (!inst || !inst.bot) return;

    inst.bot.clickWindow(slotId, 0, 0).catch(err => {
      emitToUserOrAdmin(inst.ownerUsername, 'bot_log', { botId, log: `Click Error: ${err.message}` });
    });
  });
});

server.listen(PORT, () => {
  console.log(`[Night AFK] Website running on port ${PORT}`);
});
    
