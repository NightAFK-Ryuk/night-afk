const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
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

// Railway Persistent Volume Path mapping for sessions so logouts never happen
const sessionStorePath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'sessions') 
  : './sessions';

app.use(session({
  store: new FileStore({
    path: sessionStorePath,
    secret: 'night-afk-permanent-secret-key',
    resave: true,
    saveUninitialized: true,
    retries: 0
  }),
  secret: 'night-afk-permanent-secret-key',
  resave: true,
  saveUninitialized: true,
  cookie: { 
    secure: false, 
    maxAge: 365 * 24 * 60 * 60 * 1000 // 1 Year persistence
  }
}));

const users = new Map();
const activeBots = new Map();

users.set('Ryuk', { username: 'Ryuk', password: 'Ryuk#13', email: 'ryuk@nightafk.com', role: 'admin', status: 'active', createdAt: new Date() });

app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) return res.json(req.session.user);
  res.status(401).json({ error: 'Not authenticated' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);
  if (user && user.password === password) {
    if (user.status !== 'active') return res.status(403).json({ error: 'Account pending admin approval' });
    req.session.user = { username: user.username, role: user.role, email: user.email };
    return res.json({ message: 'Success', user: req.session.user });
  }
  res.status(400).json({ error: 'Invalid credentials' });
});

app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;
  if (users.has(username)) return res.status(400).json({ error: 'Username already taken' });
  users.set(username, { username, email, password, role: 'user', status: 'pending', createdAt: new Date() });
  res.json({ message: 'Registration successful! Awaiting admin activation.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out' });
});

app.get('/api/admin/users', (req, res) => {
  if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const list = [];
  users.forEach((u, username) => {
    let botCount = 0;
    activeBots.forEach((b) => {
      if (b.config.ownerUsername === username) botCount++;
    });
    list.push({
      username: u.username,
      email: u.email,
      role: u.role,
      status: u.status,
      botCount,
      createdAt: u.createdAt
    });
  });
  res.json(list);
});

app.post('/api/admin/user-action', (req, res) => {
  if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const { targetUser, action } = req.body;
  const user = users.get(targetUser);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (action === 'activate') {
    user.status = 'active';
    res.json({ message: 'User activated successfully' });
  } else if (action === 'delete') {
    if (targetUser === 'Ryuk') return res.status(400).json({ error: 'Cannot delete master admin' });
    users.delete(targetUser);
    res.json({ message: 'User deleted' });
  } else {
    res.status(400).json({ error: 'Invalid action' });
  }
});

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
      uptime: data.startTime ? Math.floor((Date.now() - data.startTime) / 1000) : 0,
      ownerUsername: data.config.ownerUsername
    }));
    socket.emit('bot_sync', list);
  });

  socket.on('spawn_bot', (config) => {
    const botId = `bot_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const ownerName = config.ownerUsername || 'Ryuk';

    const botOptions = {
      host: config.host,
      port: parseInt(config.port) || 25565,
      username: config.username,
      version: config.version || '1.8.9',
      skipValidation: true,
      keepAlive: true
    };

    if (config.proxy && config.proxy.trim() !== '') {
      const parts = config.proxy.trim().split(':');
      const pHost = parts[0];
      const pPort = parseInt(parts[1]);
      const pUser = parts[2];
      const pPass = parts[3];

      const proxyOptions = {
        host: pHost,
        port: pPort,
        type: 5
      };

      if (pUser && pPass) {
        proxyOptions.userId = pUser;
        proxyOptions.password = pPass;
      }

      botOptions.connect = (client) => {
        SocksClient.createConnection({
          proxy: proxyOptions,
          command: 'connect',
          destination: { host: config.host, port: parseInt(config.port) || 25565 },
          timeout: 20000
        }, (err, info) => {
          if (err) {
            io.emit('bot_log', { botId, message: `SOCKS5 Connection Failed: ${err.message}` });
            client.emit('error', err);
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
        config: { ...config, botId, ownerUsername: ownerName },
        status: 'Connecting',
        hcffaInterval: null,
        armorCheckInterval: null,
        followInterval: null,
        hcffaTarget: null,
        startTime: null,
        isFirstJoin: true
      };

      activeBots.set(botId, botEntry);

      bot.once('spawn', () => {
        botEntry.status = 'Online';
        botEntry.startTime = Date.now();
        io.emit('bot_status_update', { botId, status: 'Online', uptime: 0 });
        io.emit('bot_log', { botId, message: 'Successfully authenticated, connected via SOCKS5, and spawned!' });

        const defaultMove = new movements(bot);
        bot.pathfinder.setMovements(defaultMove);

        if (config.botPassword) {
          setTimeout(() => {
            if (botEntry.isFirstJoin) {
              bot.chat(`/register ${config.botPassword} ${config.botPassword}`);
              io.emit('bot_log', { botId, message: 'Sent initial /register command.' });
              botEntry.isFirstJoin = false;
            } else {
              bot.chat(`/login ${config.botPassword}`);
              io.emit('bot_log', { botId, message: 'Sent /login command.' });
            }
          }, 2500);
        }
      });

      bot.on('health', () => {
        io.emit('bot_health_update', {
          botId,
          health: Math.round(bot.health),
          food: Math.round(bot.food)
        });
      });

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
        io.emit('bot_log', { botId, message: `Kicked from server: ${reason}` });
      });

      bot.on('error', (err) => {
        io.emit('bot_log', { botId, message: `Client Error: ${err.message}` });
      });

      bot.on('end', (reason) => {
        botEntry.status = 'Offline';
        botEntry.startTime = null;
        if (botEntry.hcffaInterval) clearInterval(botEntry.hcffaInterval);
        if (botEntry.armorCheckInterval) clearInterval(botEntry.armorCheckInterval);
        if (botEntry.followInterval) clearInterval(botEntry.followInterval);
        io.emit('bot_status_update', { botId, status: 'Offline', uptime: 0 });
        io.emit('bot_log', { botId, message: `Disconnected. Reason: ${reason || 'Unknown'}` });
      });

    } catch (err) {
      socket.emit('bot_log', { botId, message: `Fatal Setup Error: ${err.message}` });
    }
  });

  socket.on('disconnect_bot', (botId) => {
    const entry = activeBots.get(botId);
    if (entry) {
      if (entry.hcffaInterval) clearInterval(entry.hcffaInterval);
      if (entry.armorCheckInterval) clearInterval(entry.armorCheckInterval);
      if (entry.followInterval) clearInterval(entry.followInterval);
      if (entry.bot) entry.bot.quit();
      activeBots.delete(botId);
      io.emit('bot_removed', botId);
    }
  });

  socket.on('start_hcffa', ({ botId, targetUsername }) => {
    const entry = activeBots.get(botId);
    if (!entry || !entry.bot) return;

    const { bot } = entry;
    entry.hcffaTarget = targetUsername;

    bot.chat('/play hardcoreffa');
    io.emit('bot_log', { botId, message: 'HardcoreFFA: Sent initial /play hardcoreffa command.' });

    if (entry.hcffaInterval) clearInterval(entry.hcffaInterval);
    entry.hcffaInterval = setInterval(() => {
      if (bot && bot.entity) {
        bot.chat('/play hardcoreffa');
        io.emit('bot_log', { botId, message: 'HardcoreFFA: Executed /play hardcoreffa (60s interval).' });
      }
    }, 60000);

    const stripArmorNow = async () => {
      try {
        const armorSlots = [5, 6, 7, 8];
        for (const slot of armorSlots) {
          if (bot.inventory.slots[slot]) {
            await bot.unequip(slot === 5 ? 'head' : slot === 6 ? 'torso' : slot === 7 ? 'legs' : 'feet');
            io.emit('bot_log', { botId, message: 'HardcoreFFA: Stripped an armor piece.' });
          }
        }
      } catch (err) {}
    };

    if (entry.armorCheckInterval) clearInterval(entry.armorCheckInterval);
    stripArmorNow();
    entry.armorCheckInterval = setInterval(stripArmorNow, 2000);

    if (entry.followInterval) clearInterval(entry.followInterval);
    entry.followInterval = setInterval(() => {
      if (!entry.hcffaTarget || !bot.entity) return;
      const targetEntity = bot.players[entry.hcffaTarget]?.entity;
      if (targetEntity) {
        bot.pathfinder.setGoal(new goals.GoalFollow(targetEntity, 1), true);
      }
    }, 1000);

    entry.stopHcffa = () => {
      clearInterval(entry.hcffaInterval);
      clearInterval(entry.armorCheckInterval);
      clearInterval(entry.followInterval);
      bot.pathfinder.setGoal(null);
      entry.hcffaInterval = null;
      entry.armorCheckInterval = null;
      entry.followInterval = null;
      entry.hcffaTarget = null;
      io.emit('bot_log', { botId, message: 'HardcoreFFA mode stopped.' });
    };
  });

  socket.on('stop_hcffa', ({ botId }) => {
    const entry = activeBots.get(botId);
    if (entry && entry.stopHcffa) entry.stopHcffa();
  });

  socket.on('get_random_username', () => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const length = Math.floor(Math.random() * 8) + 5;
    let name = '';
    for (let i = 0; i < length; i++) {
      name += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    socket.emit('random_username_res', name);
  });

  socket.on('test_proxy_tcp', (proxyStr) => {
    const parts = proxyStr.trim().split(':');
    const pHost = parts[0];
    const pPort = parseInt(parts[1]);
    if (!pHost || !pPort) return socket.emit('proxy_test_result', { success: false, reason: 'Invalid format. Use IP:PORT or IP:PORT:USER:PASS' });

    const socketConn = net.createConnection({ host: pHost, port: pPort, timeout: 5000 }, () => {
      socketConn.end();
      socket.emit('proxy_test_result', { success: true, host: pHost, port: pPort });
    });

    socketConn.on('error', (err) => {
      socket.emit('proxy_test_result', { success: false, reason: err.message });
    });
  });

  socket.on('scrape_proxies', async () => {
    try {
      const response = await fetch('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all&ssl=all&anonymity=all');
      const text = await response.text();
      const proxies = text.split('\r\n').filter(p => p.trim() !== '').slice(0, 15);
      socket.emit('scraped_proxies_res', proxies);
    } catch (e) {
      socket.emit('scraped_proxies_res', ['185.199.229.156:1080', '192.252.208.70:14287']);
    }
  });

  socket.on('send_chat', ({ botId, message }) => {
    const entry = activeBots.get(botId);
    if (entry && entry.bot) entry.bot.chat(message);
  });

  socket.on('global_chat', ({ message }) => {
    activeBots.forEach(({ bot }) => { if (bot) bot.chat(message); });
  });

  socket.on('global_move', ({ action }) => {
    activeBots.forEach(({ bot }) => {
      if (!bot) return;
      if (action === 'jump') bot.setControlState('jump', true), setTimeout(() => bot.setControlState('jump', false), 500);
      if (action === 'forward') bot.setControlState('forward', true), setTimeout(() => bot.setControlState('forward', false), 1000);
    });
  });

  socket.on('fetch_inventory', (botId) => {
    const entry = activeBots.get(botId);
    if (!entry || !entry.bot) return;
    const items = entry.bot.inventory.slots.map(item => item ? { name: item.name, count: item.count } : null);
    socket.emit('bot_inventory_update', { botId, slots: items });
  });

  socket.on('click_slot', ({ botId, slotId }) => {
    const entry = activeBots.get(botId);
    if (entry && entry.bot) entry.bot.clickWindow(slotId, 0, 0);
  });

});

setInterval(() => {
  activeBots.forEach((data, botId) => {
    if (data.status === 'Online' && data.startTime) {
      const uptime = Math.floor((Date.now() - data.startTime) / 1000);
      io.emit('bot_uptime_update', { botId, uptime });
    }
  });
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`NIGHT AFK Core running on port ${PORT}`));
          
