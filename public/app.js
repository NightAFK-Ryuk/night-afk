let currentAuthMode = 'login';

function switchAuthTab(mode) {
  currentAuthMode = mode;
  document.getElementById('tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('tab-register').classList.toggle('active', mode === 'register');
  document.getElementById('auth-submit-btn').innerText = mode === 'login' ? 'Sign In' : 'Sign Up';
  document.getElementById('auth-error').innerText = '';
}

async function handleAuth(e) {
  e.preventDefault();
  const username = document.getElementById('auth-user').value;
  const password = document.getElementById('auth-pass').value;
  const endpoint = currentAuthMode === 'login' ? '/api/login' : '/api/register';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();
  if (data.error) {
    document.getElementById('auth-error').innerText = data.error;
  } else {
    checkSession();
  }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  checkSession();
}

async function checkSession() {
  const res = await fetch('/api/session');
  const data = await res.json();

  if (data.loggedIn) {
    document.getElementById('auth-container').classList.add('hidden');
    document.getElementById('dashboard-container').classList.remove('hidden');
    document.getElementById('logged-user-display').innerText = `@${data.user}`;
    fetchStatuses();
  } else {
    document.getElementById('auth-container').classList.remove('hidden');
    document.getElementById('dashboard-container').classList.add('hidden');
  }
}

async function spawnBot(e) {
  e.preventDefault();
  const server = document.getElementById('server').value;
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const proxy = document.getElementById('proxy').value;
  const version = document.getElementById('version').value;

  const res = await fetch('/api/spawn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server, username, password, proxy, version })
  });

  const data = await res.json();
  if (data.error) alert(data.error);
  else {
    alert(data.message);
    fetchStatuses();
  }
}

async function sendChat() {
  const username = document.getElementById('target-bot').value;
  const message = document.getElementById('chat-msg').value;
  if (!message) return;

  await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, message })
  });
  document.getElementById('chat-msg').value = '';
}

async function sendMove(direction) {
  const username = document.getElementById('target-bot').value;
  await fetch('/api/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, direction, duration: 1000 })
  });
}

async function disconnectBot() {
  const username = document.getElementById('target-bot').value;
  const res = await fetch('/api/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  });
  const data = await res.json();
  alert(data.message || data.error);
  fetchStatuses();
}

async function fetchStatuses() {
  try {
    const res = await fetch('/api/status');
    if (res.status === 401) return checkSession();
    const bots = await res.json();
    const container = document.getElementById('bots-container');

    if (bots.length === 0) {
      container.innerHTML = '<p class="muted">No bots currently online.</p>';
      return;
    }

    container.innerHTML = bots.map(b => `
      <div class="bot-card">
        <h3>🤖 ${b.username}</h3>
        <p>🌐 Server: <b>${b.host}</b></p>
        <p>⏱️ Uptime: <b>${b.uptime}</b></p>
        <p>❤️ Health: <b>${b.health}/20</b></p>
        <p>🍗 Food: <b>${b.food}/20</b></p>
        <p>📶 Ping: <b>${b.ping} ms</b></p>
        <p>🔒 Proxy: <b>${b.proxy}</b></p>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to fetch status', err);
  }
}

// Auto-refresh status every 3 seconds
setInterval(fetchStatuses, 3000);
checkSession();
