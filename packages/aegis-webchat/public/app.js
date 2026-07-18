import { createMessageDedupe } from './dedupe.js';

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const APPROVE_RE = /\/approve\s+(\S+)/;

const statusEl = document.getElementById('status');
const pairPanel = document.getElementById('pair-panel');
const chatPanel = document.getElementById('chat-panel');
const messagesEl = document.getElementById('messages');
const pairCodeInput = document.getElementById('pair-code');
const pairBtn = document.getElementById('pair-btn');
const sendForm = document.getElementById('send-form');
const messageInput = document.getElementById('message-input');
const quickActionsEl = document.getElementById('quick-actions');

let polling = false;
const dedupe = createMessageDedupe();

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function appendMessage(role, text, id) {
  if (dedupe.isDuplicate(role, text, id)) return;
  dedupe.remember(role, text, id);
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (id !== undefined) div.dataset.episodeId = String(id);
  div.innerHTML = escapeHtml(text);
  const approve = APPROVE_RE.exec(text);
  if (approve?.[1] && role === 'bot') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'approve-btn';
    btn.textContent = `Approve ${approve[1]}`;
    btn.addEventListener('click', () => {
      void sendMessage(`/approve ${approve[1]}`);
    });
    div.appendChild(document.createElement('br'));
    div.appendChild(btn);
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadHistory() {
  try {
    const data = await api('/api/history');
    messagesEl.replaceChildren();
    dedupe.clear();
    for (const msg of data.messages || []) {
      appendMessage(msg.role, msg.text, msg.id);
    }
  } catch {
    // keep empty thread on history failure
  }
}

async function syncTailFromHistory() {
  try {
    const data = await api('/api/history?limit=15');
    for (const msg of data.messages || []) {
      appendMessage(msg.role, msg.text, msg.id);
    }
  } catch {
    // poll remains primary; history is safety net
  }
}

let tailSyncTimers = [];

function scheduleTailSync() {
  for (const t of tailSyncTimers) clearTimeout(t);
  tailSyncTimers = [2000, 6000].map((ms) =>
    setTimeout(() => {
      void syncTailFromHistory();
    }, ms),
  );
}

async function sendMessage(text) {
  await api('/api/message', { method: 'POST', body: JSON.stringify({ text }) });
  if (!text.startsWith('/approve')) appendMessage('user', text);
  void pollLoop();
  scheduleTailSync();
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  while (polling) {
    try {
      const data = await api('/api/poll');
      for (const text of data.messages || []) appendMessage('bot', text);
    } catch (err) {
      if (String(err?.message ?? err) === '401') {
        polling = false;
        showPairPanel('Сессия истекла — введите pairing-код снова');
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function showPairPanel(message) {
  polling = false;
  statusEl.textContent = message;
  pairPanel.classList.remove('hidden');
  chatPanel.classList.add('hidden');
}

function showChatPanel() {
  statusEl.textContent = 'Paired — локальный канал активен';
  pairPanel.classList.add('hidden');
  chatPanel.classList.remove('hidden');
  void (async () => {
    await loadHistory();
    void pollLoop();
    void loadQuickActions();
  })();
}

function renderQuickActions(actions) {
  if (!quickActionsEl) return;
  quickActionsEl.replaceChildren();
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip ${action.kind}`;
    btn.textContent = action.label;
    if (action.description) btn.title = action.description;
    btn.addEventListener('click', () => {
      if (action.text.endsWith(' ')) {
        messageInput.value = action.text;
        messageInput.focus();
        return;
      }
      void (async () => {
        try {
          await sendMessage(action.text);
        } catch {
          statusEl.textContent = 'Не удалось отправить — введите pairing-код снова';
          showPairPanel('Сессия недействительна — введите pairing-код снова');
        }
      })();
    });
    quickActionsEl.appendChild(btn);
  }
}

async function loadQuickActions() {
  try {
    const data = await api('/api/actions');
    renderQuickActions(data.actions || []);
  } catch {
    if (quickActionsEl) quickActionsEl.replaceChildren();
  }
}

async function refreshStatus() {
  const data = await api('/api/status');
  if (data.paired && data.authed) {
    showChatPanel();
  } else if (data.paired) {
    showPairPanel('Сессия истекла — введите pairing-код снова');
  } else {
    showPairPanel('Введите pairing-код из aegis-setup init');
  }
}

pairBtn.addEventListener('click', async () => {
  const code = pairCodeInput.value.trim();
  if (!code) return;
  pairBtn.disabled = true;
  try {
    await api('/api/pair', { method: 'POST', body: JSON.stringify({ code }) });
    await refreshStatus();
  } catch {
    statusEl.textContent = 'Неверный код pairing';
  } finally {
    pairBtn.disabled = false;
  }
});

sendForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  void (async () => {
    try {
      await sendMessage(text);
      messageInput.value = '';
    } catch {
      statusEl.textContent = 'Не удалось отправить — введите pairing-код снова';
      showPairPanel('Сессия недействительна — введите pairing-код снова');
    }
  })();
});

void refreshStatus().catch(() => {
  statusEl.textContent = 'WebChat недоступен — запустите host';
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !chatPanel.classList.contains('hidden')) {
    void pollLoop();
    void syncTailFromHistory();
  }
});
