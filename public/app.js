const socket = io();
let currentUser = null;
let activeBots = new Map();
let selectedBotId = null;

// Screen Router
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) target.classList.add('active');

  if (screenId === 'admin-screen') loadAdminUsers();
}

// Session Sync
async function checkAuth() {
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      currentUser = await res.json();
      updateNav(true);
      showScreen('dashboard-screen');
      socket.emit('request_bot_sync');
    } else {
      updateNav(false);
      showScreen('hero-screen');
    }
  } catch (err) {
    updateNav(false);
  }
}

function updateNav(authenticated) {
  document.getElementById('nav-login-btn').classList.toggle('hidden', authenticated);
  document.getElementById('nav-register-btn').classList.toggle('hidden', authenticated);
  document.getElementById('nav-dash-btn').classList.toggle('hidden', !authenticated);
  document.getElementById('nav-logout-btn').classList.toggle('hidden', !authenticated);
  
  if (currentUser && currentUser.role === 'admin') {
    document.getElementById('nav-admin-btn').classList.remove('hidden');
  } else {
    document.getElementById('nav-admin-btn').classList.add('hidden');
  }
}

// Authentication
async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-user').value;
  const password = document.getElementById('login-pass').value;

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();
  if (res.ok) {
    currentUser = data.user;
    updateNav(true);
    showScreen('dashboard-screen');
    socket.emit('request_bot_sync');
  } else {
    const errBox = document.getElementById('login-err');
    errBox.textContent = data.error;
    errBox.classList.remove('hidden');
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('reg-user').value;
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-pass').value;

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password })
  });

  const data = await res.json();
  const msgBox = document.getElementById('reg-msg');
  msgBox.textContent = data.message || data.error;
  msgBox.classList.remove('hidden');
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  currentUser = null;
  updateNav(false);
  showScreen('hero-screen');
}

// Bot Instance Rendering
socket.on('bot_sync', (list) => {
  activeBots.clear();
  list.forEach(bot => activeBots.set(bot.botId, bot));
  renderBotGrid();
});

socket.on('bot_status_update', (data) => {
  const existing = activeBots.get(data.botId) || {};
  activeBots.set(data.botId, { ...existing, ...data });
  renderBotGrid();
  if (selectedBotId === data.botId) updateDrawerHeader();
});

socket.on('bot_health_update', ({ botId, health, food }) => {
  const bot = activeBots.get(botId);
  if (bot) {
    bot.health = health;
    bot.food = food;
    renderBotGrid();
  }
});

socket.on('bot_log', ({ botId, message }) => {
  if (selectedBotId === botId) {
    appendLog(message);
  }
});

socket.on('bot_chat_log', ({ botId, message }) => {
  if (selectedBotId === botId) {
    appendLog(message);
  }
});

socket.on('bot_removed', (botId) => {
  activeBots.delete(botId);
  renderBotGrid();
  if (selectedBotId === botId) closeDrawer();
});

function renderBotGrid() {
  const grid = document.getElementById('bot-grid');
  grid.innerHTML = '';

  activeBots.forEach((bot) => {
    const isOnline = bot.status === 'Online';
    const card = document.createElement('div');
    card.className = 'bot-card';
    card.onclick = () => openBotDrawer(bot.botId);

    card.innerHTML = `
      <div class="bot-card-header">
        <strong>${bot.username}</strong>
        <span class="status-indicator ${isOnline ? 'online' : ''}"></span>
      </div>
      <p class="subtitle">${bot.host}:${bot.port}</p>
      <div class="stat-bar">
        <span>HP: ${bot.health || 0} / 20</span>
        <span>Food: ${bot.food || 0} / 20</span>
      </div>
    `;
    grid.appendChild(card);
  });
}

// Drawer Inspection & Controls
function openBotDrawer(botId) {
  selectedBotId = botId;
  const bot = activeBots.get(botId);
  if (!bot) return;

  document.getElementById('drawer-bot-title').textContent = bot.username;
  document.getElementById('drawer-bot-status').textContent = bot.status;
  document.getElementById('meta-host').textContent = bot.host;
  document.getElementById('meta-port').textContent = bot.port;
  document.getElementById('meta-owner').textContent = bot.ownerUsername;

  if (bot.eatSettings) {
    document.getElementById('eat-min-hp').value = bot.eatSettings.minHp;
    document.getElementById('eat-max-hp').value = bot.eatSettings.maxHp;
    document.getElementById('gapple-only').checked = bot.eatSettings.gappleOnly;
  }

  document.getElementById('bot-drawer').classList.add('open');
}

function closeDrawer() {
  document.getElementById('bot-drawer').classList.remove('open');
  selectedBotId = null;
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  
  event.target.classList.add('active');
  document.getElementById(tabId).classList.add('active');
}

function appendLog(msg) {
  const box = document.getElementById('drawer-chat-log');
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function sendDrawerChat() {
  const input = document.getElementById('drawer-chat-input');
  if (input.value && selectedBotId) {
    socket.emit('send_chat', { botId: selectedBotId, message: input.value });
    input.value = '';
  }
}

function saveEatSettings() {
  if (!selectedBotId) return;
  const minHp = document.getElementById('eat-min-hp').value;
  const maxHp = document.getElementById('eat-max-hp').value;
  const gappleOnly = document.getElementById('gapple-only').checked;

  socket.emit('update_eat_settings', { botId: selectedBotId, minHp, maxHp, gappleOnly });
}

function startPvP() {
  const target = document.getElementById('pvp-target').value;
  if (selectedBotId && target) {
    socket.emit('start_pvp', { botId: selectedBotId, targetUsername: target });
  }
}

function stopPvP() {
  if (selectedBotId) socket.emit('stop_pvp', { botId: selectedBotId });
}

// Inventory Visualization
function requestInventory() {
  if (selectedBotId) socket.emit('fetch_inventory', selectedBotId);
}

socket.on('bot_inventory_update', ({ botId, slots }) => {
  if (selectedBotId !== botId) return;
  const grid = document.getElementById('inventory-grid');
  grid.innerHTML = '';

  slots.slice(0, 36).forEach((item, index) => {
    const slot = document.createElement('div');
    slot.className = 'inv-slot';
    slot.onclick = () => socket.emit('click_slot', { botId: selectedBotId, slotId: index });

    if (item) {
      slot.innerHTML = `<span>${item.name.replace('_', ' ')}</span><span class="inv-count">${item.count}</span>`;
    }
    grid.appendChild(slot);
  });
});

// Global Hub Actions
function sendGlobalChat() {
  const input = document.getElementById('global-chat-input');
  if (input.value) {
    socket.emit('global_chat', { message: input.value });
    input.value = '';
  }
}

function triggerGlobalMove(action) {
  socket.emit('global_move', { action });
}

// Modal Handlers
function openSpawnModal() { document.getElementById('spawn-modal').classList.add('open'); }
function closeSpawnModal() { document.getElementById('spawn-modal').classList.remove('open'); }

function handleSpawnBot(e) {
  e.preventDefault();
  const config = {
    username: document.getElementById('bot-user').value,
    host: document.getElementById('bot-host').value,
    port: document.getElementById('bot-port').value,
    version: document.getElementById('bot-version').value,
    password: document.getElementById('bot-pass').value,
    proxy: document.getElementById('bot-proxy').value
  };

  socket.emit('spawn_bot', config);
  closeSpawnModal();
}

// Admin Portal APIs
async function loadAdminUsers() {
  const res = await fetch('/api/admin/users');
  if (!res.ok) return;
  const users = await res.json();
  const tbody = document.getElementById('admin-user-table');
  tbody.innerHTML = '';

  users.forEach(u => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${u.username}</strong></td>
      <td>${u.email}</td>
      <td>${u.role}</td>
      <td><span class="badge">${u.status}</span></td>
      <td>${u.activeBots}</td>
      <td>${new Date(u.createdAt).toLocaleDateString()}</td>
      <td>
        ${u.status === 'pending' ? `<button class="btn-primary" onclick="adminUserAction('${u.username}', 'activate')">Approve</button>` : ''}
        ${u.username !== 'Ryuk' ? `<button class="btn-border" onclick="adminUserAction('${u.username}', 'delete')">Remove</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function adminUserAction(targetUser, action) {
  await fetch('/api/admin/user-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetUser, action })
  });
  loadAdminUsers();
}

// Initialize Application
checkAuth();
  
