const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const axios = require('axios');
const net = require('net');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Global Application State
const activeBots = new Map();
const hardcoreFFABots = new Set();
let globalTargetUser = '';

let rawScrapedProxies = [];
let workingProxies = [];
let isCheckingProxies = false;

// --- 1. PROXY SCRAPER & LIVE TCP CHECKER ---
function testProxyConnection(ip, port, timeout = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isWorking = false;

    socket.setTimeout(timeout);
    socket.on('connect', () => {
      isWorking = true;
      socket.destroy();
    });
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => resolve(isWorking));

    socket.connect(parseInt(port), ip);
  });
}

async function scrapeAndCheckProxies() {
  if (isCheckingProxies) return;
  isCheckingProxies = true;

  console.log('[NightAFK System] Scraping fresh SOCKS5 proxies...');
  broadcastSystemState();

  const sources = [
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all',
    'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt',
    'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt'
  ];

  const scrapedSet = new Set();

  for (const sourceUrl of sources) {
    try {
      const res = await axios.get(sourceUrl, { timeout: 6000 });
      const lines = res.data.split(/\r?\n/);
      lines.forEach(line => {
        const trimmed = line.trim();
        if (trimmed && trimmed.includes(':')) {
          scrapedSet.add(trimmed);
        }
      });
    } catch (e) {
      // Ignore individual endpoint errors
    }
  }

  rawScrapedProxies = Array.from(scrapedSet);
  console.log(`[NightAFK System] Found ${rawScrapedProxies.length} raw proxies. Testing batch...`);

  // Verify top 100 proxies for responsiveness
  const poolToTest = rawScrapedProxies.slice(0, 100);
  const verifiedList = [];

  await Promise.all(poolToTest.map(async (proxyStr) => {
    const [ip, port] = proxyStr.split(':');
    if (ip && port) {
      const alive = await testProxyConnection(ip, port, 2500);
      if (alive) verifiedList.push(proxyStr);
    }
  }));

  workingProxies = verifiedList;
  isCheckingProxies = false;

  console.log(`[NightAFK System] Verification complete. ${workingProxies.length} verified proxies active.`);
  broadcastSystemState();
}

// Initial Scrape on start + repeat every 12 minutes
scrapeAndCheckProxies();
setInterval(scrapeAndCheckProxies, 12 * 60 * 1000);

// --- 2. ARMOR STRIPPING HELPER ---
async function stripArmor(bot) {
  const armorSlots = [5, 6, 7, 8];
  for (const slot of armorSlots) {
    if (bot.inventory.slots[slot]) {
      try {
        const slotType = slot === 5 ? 'head' : slot === 6 ? 'torso' : slot === 7 ? 'legs' : 'feet';
        await bot.unequip(slotType);
      } catch (err) {
        // Suppress inventory full errors
      }
    }
  }
}

// --- 3. BOT INSTANTIATION ---
function createNightBot(username, host, port, proxyStr = '') {
  const [proxyIp, proxyPort] = proxyStr ? proxyStr.split(':') : ['Direct', 'N/A'];

  const bot = mineflayer.createBot({
    host: host || 'localhost',
    port: parseInt(port) || 25565,
    username: username
  });

  bot.loadPlugin(pathfinder);

  bot.customMeta = {
    username,
    host,
    port,
    proxyIp,
    proxyPort,
    startTime: Date.now(),
    hffaInterval: null,
    followInterval: null,
    afkInterval: null
  };

  bot.once('spawn', () => {
    console.log(`[Bot Spawned] ${username} connected.`);
    const movements = new Movements(bot);
    movements.canDig = false;
    bot.pathfinder.setMovements(movements);

    // DEFAULT MODE: Anti-idle routine (Swings arm every 30s)
    bot.customMeta.afkInterval = setInterval(() => {
      if (!hardcoreFFABots.has(username) && bot.entity) {
        bot.swing('arm');
      }
    }, 30000);

    broadcastSystemState();
  });

  // Track live status updates
  bot.on('health', () => broadcastSystemState());

  // HARDCORE FFA FEATURE
  bot.enableHardcoreFFA = () => {
    hardcoreFFABots.add(username);
    console.log(`[NightAFK] ${username} -> HardcoreFFA Enabled`);

    bot.chat('/play hardcoreffa');
    stripArmor(bot);

    if (bot.customMeta.hffaInterval) clearInterval(bot.customMeta.hffaInterval);
    bot.customMeta.hffaInterval = setInterval(() => {
      if (hardcoreFFABots.has(username)) {
        bot.chat('/play hardcoreffa');
        stripArmor(bot);
      }
    }, 60000);

    if (bot.customMeta.followInterval) clearInterval(bot.customMeta.followInterval);
    bot.customMeta.followInterval = setInterval(() => {
      if (!globalTargetUser || !hardcoreFFABots.has(username)) return;

      const targetPlayer = bot.players[globalTargetUser];
      if (targetPlayer && targetPlayer.entity) {
        bot.pathfinder.setGoal(new goals.GoalFollow(targetPlayer.entity, 1), true);
      }
    }, 1000);

    broadcastSystemState();
  };

  bot.disableHardcoreFFA = () => {
    hardcoreFFABots.delete(username);
    if (bot.customMeta.hffaInterval) clearInterval(bot.customMeta.hffaInterval);
    if (bot.customMeta.followInterval) clearInterval(bot.customMeta.followInterval);

    bot.pathfinder.setGoal(null);
    console.log(`[NightAFK] ${username} -> Returned to Pure AFK`);
    broadcastSystemState();
  };

  bot.on('end', () => {
    bot.disableHardcoreFFA();
    if (bot.customMeta.afkInterval) clearInterval(bot.customMeta.afkInterval);
    activeBots.delete(username);
    broadcastSystemState();
  });

  bot.on('error', (err) => console.error(`[${username} Error]`, err.message));

  activeBots.set(username, bot);
  return bot;
}

// Generate Dashboard Data Payload
function getBotPayload() {
  const list = [];
  activeBots.forEach((bot) => {
    const uptimeSec = Math.floor((Date.now() - bot.customMeta.startTime) / 1000);
    const hrs = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;

    list.push({
      username: bot.customMeta.username,
      proxyIp: bot.customMeta.proxyIp,
      proxyPort: bot.customMeta.proxyPort,
      uptime: `${hrs}h ${mins}m ${secs}s`,
      health: bot.health ? Math.round(bot.health) : 20,
      food: bot.food ? Math.round(bot.food) : 20,
      isHFFA: hardcoreFFABots.has(bot.customMeta.username)
    });
  });
  return list;
}

function broadcastSystemState() {
  io.emit('system_state_update', {
    bots: getBotPayload(),
    currentTarget: globalTargetUser,
    workingProxyCount: workingProxies.length,
    rawProxyCount: rawScrapedProxies.length,
    isCheckingProxies
  });
}

// Live timer tick
setInterval(() => {
  if (activeBots.size > 0) {
    io.emit('uptime_tick', getBotPayload());
  }
}, 1000);

// --- 4. SOCKET CONTROLLERS ---
io.on('connection', (socket) => {
  broadcastSystemState();

  socket.on('connect_bot', ({ username, host, port, useProxy }) => {
    let chosenProxy = '';
    if (useProxy && workingProxies.length > 0) {
      chosenProxy = workingProxies[Math.floor(Math.random() * workingProxies.length)];
    }
    createNightBot(username, host, port, chosenProxy);
  });

  socket.on('disconnect_bot', (username) => {
    const bot = activeBots.get(username);
    if (bot) bot.quit();
  });

  socket.on('send_chat', ({ username, message }) => {
    const bot = activeBots.get(username);
    if (bot && message) bot.chat(message);
  });

  socket.on('toggle_hffa', ({ username, enable }) => {
    const bot = activeBots.get(username);
    if (bot) {
      if (enable) bot.enableHardcoreFFA();
      else bot.disableHardcoreFFA();
    }
  });

  socket.on('set_global_target', (target) => {
    globalTargetUser = target;
    broadcastSystemState();
  });

  socket.on('force_proxy_check', () => {
    scrapeAndCheckProxies();
  });
});

server.listen(3000, () => {
  console.log('====================================================');
  console.log('  NightAFK Dashboard Ready: http://localhost:3000   ');
  console.log('====================================================');
});
      
