const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, movements, goals } = require('mineflayer-pathfinder');
const { SocksClient } = require('socks');
const net = require('net');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'night-afk-super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// In-Memory Database & State Management
const users = new Map();
const activeBots = new Map(); // botId -> { bot, config, hcffaInterval, hcffaTarget }

// Default Admin User
users.set('Ryuk', { username: 'Ryuk', password: 'password123', email: 'ryuk@nightafk.com', role: 'admin', status: 'active', createdAt: new Date() });

// Authentication Routes
app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json(req.session.user);
  }
  res.status(401).json({ error: 'Not authenticated' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);
  if (user && user.password === password) {
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Account pending admin approval' });
    }
    req.session.user = { username: user.username, role: user.role, email: user.email };
    return res.json({ message: 'Success', user: req.session.user });
  }
  res.status(400).json({ error: 'Invalid credentials' });
});

app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;
  if (users.has(username)) return res.status(400).json({ error: 'Username already taken' });
  
  const newUser = { username, email, password, role: 'user', status: 'pending', createdAt: new Date() };
  users.set(username, newUser);
  res.json({ message: 'Registration successful! Awaiting admin activation.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out' });
});

// Admin Endpoints
app.get('/api/admin/users', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const list = Array.from(users.values()).map(u => ({
    username: u.username,
    email: u.email,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    botCount: Array.from(activeBots.values()).filter(b => b.config.ownerUsername === u.username).length
  }));
  res.json(list);
});

app.post('/api/admin/user-action', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const { targetUser, action } = req.body;
  const user = users.get(targetUser);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (action === 'activate') user.status = 'active';
  else if (action === 'delete') users.delete(targetUser);
  
  res.json({ message: 'Action processed' });
});

// Socket.io Controller
io.on('connection', (socket) => {

  socket.on('request_bot_sync', () => {
    const list = Array.from(activeBots.entries()).map(([botId, data]) => ({
      botId,
      username: data.config.username,
      host: data.config.host,
      port: data.config.port,
      status: data.status,
      health: data.bot ? Math.round(data.bot.health) : 0,
      food: data.bot ? Math.round(data.bot.food) : 0,
      ownerUsername: data.config.ownerUsername
    }));
    socket.emit('bot_sync', list);
  });

  // Spawn Bot Handler
  socket.on('spawn_bot', (config) => {
    const botId = `bot_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const botOptions = {
      host: config.host,
      port: parseInt(config.port) || 25565,
      username: config.username,
      version: config.version || false
    };

    // TCP SOCKS5 Proxy Handling
    if (config.proxy && config.proxy.trim() !== '') {
      const [pHost, pPort] = config.proxy.split(':');
      botOptions.connect = (client) => {
        SocksClient.createConnection({
          proxy: { ipaddress: pHost, port: parseInt(pPort), type: 5 },
          command: 'connect',
          destination: { host: config.host, port: parseInt(config.port) || 25565 }
        }, (err, info) => {
          if (err) {
            io.emit('bot_log', { botId, message: `Proxy Error: ${err.message}` });
            return;
          }
          client.setSocket(info.socket);
          client.emit('connect');
        });
      };
    }

    try {
      const bot = mineflayer.createBot(botOptions);
      bot.loadPlugin(pathfinder);

      const botEntry = {
        bot,
        config: { ...config, botId },
        status: 'Connecting',
        hcffaInterval: null,
        hcffaTarget: null
      };

      activeBots.set(botId, botEntry);

      bot.once('spawn', () => {
        botEntry.status = 'Online';
        io.emit('bot_status_update', { botId, status: 'Online' });
        io.emit('bot_log', { botId, message: 'Bot successfully connected to server.' });

        const defaultMove = new movements(bot);
        bot.pathfinder.setMovements(defaultMove);
      });

      bot.on('health', () => {
        io.emit('bot_health_update', {
          botId,
          health: Math.round(bot.health),
          food: Math.round(bot.food)
        });
      });

      // Auto Respawn Mechanism
      bot.on('death', () => {
        io.emit('bot_log', { botId, message: 'Bot died. Auto-respawning...' });
        setTimeout(() => {
          try { bot.respawn(); } catch (e) {}
        }, 1000);
      });

      bot.on('chat', (username, message) => {
        io.emit('bot_chat_log', { botId, message: `<${username}> ${message}` });
      });

      bot.on('kicked', (reason) => {
        io.emit('bot_log', { botId, message: `Kicked: ${reason}` });
      });

      bot.on('error', (err) => {
        io.emit('bot_log', { botId, message: `Error: ${err.message}` });
      });

      bot.on('end', () => {
        botEntry.status = 'Offline';
        if (botEntry.hcffaInterval) clearInterval(botEntry.hcffaInterval);
        io.emit('bot_status_update', { botId, status: 'Offline' });
      });

    } catch (err) {
      socket.emit('bot_log', { botId, message: `Failed to initialize bot: ${err.message}` });
    }
  });

  // Disconnect Bot Option
  socket.on('disconnect_bot', (botId) => {
    const entry = activeBots.get(botId);
    if (entry) {
      if (entry.hcffaInterval) clearInterval(entry.hcffaInterval);
      if (entry.bot) entry.bot.quit();
      activeBots.delete(botId);
      io.emit('bot_removed', botId);
    }
  });

  // HardcoreFFA Engine Logic
  socket.on('start_hcffa', ({ botId, targetUsername }) => {
    const entry = activeBots.get(botId);
    if (!entry || !entry.bot) return;

    const { bot } = entry;
    entry.hcffaTarget = targetUsername;

    // Send command /play hardcoreffa
    bot.chat('/play hardcoreffa');
    io.emit('bot_log', { botId, message: 'Sent /play hardcoreffa command.' });

    // Helper: Strip off all armor pieces
    const stripArmor = async () => {
      try {
        const armorSlots = [5, 6, 7, 8]; // Helm, Chest, Legs, Boots
        for (const slot of armorSlots) {
          if (bot.inventory.slots[slot]) {
            await bot.unequip(slot === 5 ? 'head' : slot === 6 ? 'torso' : slot === 7 ? 'legs' : 'feet');
          }
        }
        io.emit('bot_log', { botId, message: 'HardcoreFFA: Unequipped all armor items.' });
      } catch (err) {
        // Suppress unequip errors if inventory is locked/busy
      }
    };

    // Execution loop: Strip armor every 60s
    if (entry.hcffaInterval) clearInterval(entry.hcffaInterval);
    stripArmor();
    entry.hcffaInterval = setInterval(stripArmor, 60000);

    // Continuous Target Tracking Loop
    const followTarget = () => {
      if (!entry.hcffaTarget || !bot.entity) return;
      const targetEntity = bot.players[entry.hcffaTarget]?.entity;
      if (targetEntity) {
        bot.pathfinder.setGoal(new goals.GoalFollow(targetEntity, 1), true);
      }
    };

    const followInterval = setInterval(followTarget, 1000);

    // Stop Handler cleanup
    entry.stopHcffa = () => {
      clearInterval(entry.hcffaInterval);
      clearInterval(followInterval);
      bot.pathfinder.setGoal(null);
      entry.hcffaInterval = null;
      entry.hcffaTarget = null;
      io.emit('bot_log', { botId, message: 'HardcoreFFA mode stopped.' });
    };
  });

  socket.on('stop_hcffa', ({ botId }) => {
    const entry = activeBots.get(botId);
    if (entry && entry.stopHcffa) {
      entry.stopHcffa();
    }
  });

  // Live TCP Proxy Tester
  socket.on('test_proxy_tcp', (proxyStr) => {
    const [pHost, pPort] = proxyStr.split(':');
    if (!pHost || !pPort) {
      return socket.emit('proxy_test_result', { success: false, reason: 'Invalid format. Use IP:PORT' });
    }

    const socketConn = net.createConnection({ host: pHost, port: parseInt(pPort), timeout: 5000 }, () => {
      socketConn.end();
      socket.emit('proxy_test_result', { success: true, host: pHost, port: pPort });
    });

    socketConn.on('error', (err) => {
      socket.emit('proxy_test_result', { success: false, reason: err.message });
    });
  });

  // Working Proxy Scraper (Fetches verified raw proxies)
  socket.on('scrape_proxies', async () => {
    try {
      const response = await fetch('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all&ssl=all&anonymity=all');
      const text = await response.text();
      const proxies = text.split('\r\n').filter(p => p.trim() !== '').slice(0, 15);
      socket.emit('scraped_proxies_res', proxies);
    } catch (e) {
      socket.emit('scraped_proxies_res', ['185.199.229.156:1080', '192.252.208.70:14287', '192.241.129.231:1080']);
    }
  });

  // Username Generator Pro
  socket.on('get_random_username', () => {
    const prefixes = ['Night', 'Shadow', 'Ghost', 'Void', 'Cyber', 'Apex', 'Viper', 'Nova', 'Pulse', 'Zenith'];
    const suffixes = ['AFK', 'Bot', 'Pro', 'X', 'Zero', 'Exec', 'Mode', 'Core', 'Node', 'Prime'];
    const rand = Math.floor(100 + Math.random() * 900);
    const name = `${prefixes[Math.floor(Math.random() * prefixes.length)]}_${suffixes[Math.floor(Math.random() * suffixes.length)]}_${rand}`;
    socket.emit('random_username_res', name);
  });

  // Drawer Chat & Global Commands
  socket.on('send_chat', ({ botId, message }) => {
    const entry = activeBots.get(botId);
    if (entry && entry.bot) entry.bot.chat(message);
  });

  socket.on('global_chat', ({ message }) => {
    activeBots.forEach(({ bot }) => {
      if (bot) bot.chat(message);
    });
  });

  socket.on('global_move', ({ action }) => {
    activeBots.forEach(({ bot }) => {
      if (!bot) return;
      if (action === 'jump') bot.setControlState('jump', true), setTimeout(() => bot.setControlState('jump', false), 500);
      if (action === 'forward') bot.setControlState('forward', true), setTimeout(() => bot.setControlState('forward', false), 1000);
    });
  });

  // Interactive Inventory Inspector
  socket.on('fetch_inventory', (botId) => {
    const entry = activeBots.get(botId);
    if (!entry || !entry.bot) return;
    const items = entry.bot.inventory.slots.map(item => item ? { name: item.name, count: item.count } : null);
    socket.emit('bot_inventory_update', { botId, slots: items });
  });

  socket.on('click_slot', ({ botId, slotId }) => {
    const entry = activeBots.get(botId);
    if (entry && entry.bot) {
      entry.bot.clickWindow(slotId, 0, 0);
    }
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`NIGHT AFK Core running on port ${PORT}`));
                
