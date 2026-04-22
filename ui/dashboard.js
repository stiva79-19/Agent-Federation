// ============================================================
// Agent Federation Dashboard - WebSocket Client
// ============================================================

const WS_URL = 'ws://localhost:18790/dashboard';
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_DELAY = 30000;

// --- State ---
let ws = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_DELAY;
let sessionActive = false;
let sessionStartTime = null;
let timerInterval = null;
let currentTorrentKey = '';
let streamBuffers = {}; // agentId -> accumulated text
let approvalQueue = [];

// --- DOM refs ---
const $ = (id) => document.getElementById(id);

// ============================================================
// WebSocket Connection
// ============================================================

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  setConnectionStatus('connecting');
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setConnectionStatus('connected');
    reconnectDelay = RECONNECT_DELAY;
    console.log('[WS] Connected');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.error('[WS] Parse error:', e);
    }
  };

  ws.onclose = () => {
    setConnectionStatus('disconnected');
    console.log('[WS] Disconnected');
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
    ws.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log('[WS] Reconnecting...');
    connect();
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
  }, reconnectDelay);
}

function send(type, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[WS] Not connected');
    return;
  }
  ws.send(JSON.stringify({ type, ...payload }));
}

function setConnectionStatus(state) {
  const dot = $('statusDot');
  const text = $('statusText');
  dot.className = 'status-dot';
  if (state === 'connected') {
    dot.classList.add('connected');
    text.textContent = 'Connected';
  } else if (state === 'connecting') {
    dot.classList.add('connecting');
    text.textContent = 'Connecting...';
  } else {
    text.textContent = 'Disconnected';
  }
}

// ============================================================
// Message Handler
// ============================================================

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      handleWelcome(msg);
      break;
    case 'swarm_session_created':
      handleSessionCreated(msg);
      break;
    case 'swarm_session_joined':
      handleSessionJoined(msg);
      break;
    case 'swarm_peer_joined':
      handlePeerJoined(msg);
      break;
    case 'swarm_peer_left':
      handlePeerLeft(msg);
      break;
    case 'agent_message':
      handleAgentMessage(msg);
      break;
    case 'agent_stream_chunk':
      handleStreamChunk(msg);
      break;
    case 'agent_thinking':
      handleAgentThinking(msg);
      break;
    case 'sandbox_approval_request':
      handleApprovalRequest(msg);
      break;
    case 'sandbox_action_result':
      handleActionResult(msg);
      break;
    case 'connection_status':
      handleConnectionStatus(msg);
      break;
    case 'error':
      handleError(msg);
      break;
    default:
      console.log('[WS] Unknown message type:', msg.type, msg);
  }
}

// --- Welcome ---
function handleWelcome(msg) {
  const agent = msg.agent || {};
  $('agentNameBadge').textContent = agent.name || 'agent';
  $('infoAgentName').textContent = agent.name || '—';
  $('infoAgentModel').textContent = agent.model || '—';
  $('infoAgentProvider').textContent = agent.provider || '—';
  $('settingsAgentName').value = agent.name || '';
  $('settingsLlmModel').value = agent.model || '';
  addSystemMessage('Connected to relay server');
}

// --- Session Created ---
function handleSessionCreated(msg) {
  sessionActive = true;
  currentTorrentKey = msg.sessionKey || msg.torrentKey || msg.sessionId || '';
  showTorrentKey(currentTorrentKey);
  $('infoSessionId').textContent = currentTorrentKey ? currentTorrentKey.substring(0, 12) + '...' : '—';
  $('btnCreateSession').style.display = 'none';
  $('btnJoinSession').style.display = 'none';
  $('btnLeaveSession').style.display = 'block';
  startTimer();
  updatePeerList(msg.peers || []);
  addSystemMessage('Session created — key: ' + currentTorrentKey.substring(0, 16) + '...');
}

// --- Session Joined ---
function handleSessionJoined(msg) {
  sessionActive = true;
  currentTorrentKey = msg.sessionKey || msg.torrentKey || msg.sessionId || '';
  showTorrentKey(currentTorrentKey);
  $('infoSessionId').textContent = currentTorrentKey ? currentTorrentKey.substring(0, 12) + '...' : '—';
  $('btnCreateSession').style.display = 'none';
  $('btnJoinSession').style.display = 'none';
  $('btnLeaveSession').style.display = 'block';
  startTimer();
  updatePeerList(msg.peers || []);
  addSystemMessage('Joined session — key: ' + currentTorrentKey.substring(0, 16) + '...');
}

// --- Peer Events ---
function handlePeerJoined(msg) {
  addSystemMessage(`Peer joined: ${msg.peerId || msg.agentName || 'unknown'}`);
  if (msg.peers) updatePeerList(msg.peers);
  updateAgentCounter(msg.peerCount);
}

function handlePeerLeft(msg) {
  addSystemMessage(`Peer left: ${msg.peerId || msg.agentName || 'unknown'}`);
  if (msg.peers) updatePeerList(msg.peers);
  updateAgentCounter(msg.peerCount);
}

// --- Agent Messages ---
function handleAgentMessage(msg) {
  const sender = msg.agentName || msg.from || 'Agent';
  addChatMessage(sender, msg.content || msg.text || '', 'agent');
}

function handleStreamChunk(msg) {
  const agentId = msg.agentId || msg.from || 'stream';
  if (!streamBuffers[agentId]) {
    streamBuffers[agentId] = '';
    addStreamingMessage(agentId);
  }
  streamBuffers[agentId] += msg.chunk || msg.content || '';
  updateStreamingMessage(agentId, streamBuffers[agentId]);
}

function handleAgentThinking(msg) {
  const sender = msg.agentName || msg.from || 'Agent';
  const el = document.createElement('div');
  el.className = 'chat-msg agent';
  el.innerHTML = `<div class="msg-sender">${escapeHtml(sender)}</div><div class="thinking">Thinking...</div>`;
  $('chatMessages').appendChild(el);
  scrollChat();
}

// --- Sandbox ---
function handleApprovalRequest(msg) {
  const approval = {
    id: msg.approvalId || Date.now().toString(),
    action: msg.action || 'unknown',
    detail: msg.detail || msg.command || '',
    agentName: msg.agentName || 'Agent',
  };
  approvalQueue.push(approval);
  renderApprovalQueue();
  renderSandboxApprovals();
}

function handleActionResult(msg) {
  const action = msg.action || 'Action';
  const success = msg.success !== false;
  addSystemMessage(`Sandbox: ${action} — ${success ? 'OK' : 'Failed'}`);
  if (msg.files) renderFileTree(msg.files);
}

// --- Connection Status ---
function handleConnectionStatus(msg) {
  setConnectionStatus(msg.status || 'disconnected');
}

// --- Error ---
function handleError(msg) {
  addSystemMessage(`Error: ${msg.message || msg.error || 'Unknown error'}`);
}

// ============================================================
// Send Messages
// ============================================================

function createSession() {
  send('swarm_create_session');
}

function joinSession() {
  const key = prompt('Enter torrent key or session ID:');
  if (key && key.trim()) {
    send('swarm_join_session', { sessionKey: key.trim() });
  }
}

function leaveSession() {
  send('swarm_leave_session');
  sessionActive = false;
  currentTorrentKey = '';
  $('torrentKeyBox').style.display = 'none';
  $('btnCreateSession').style.display = 'block';
  $('btnJoinSession').style.display = 'block';
  $('btnLeaveSession').style.display = 'none';
  $('infoSessionId').textContent = '—';
  stopTimer();
  clearPeerList();
  addSystemMessage('Left session');
}

function sendMessage() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  addChatMessage('You', text, 'user');
  send('start_conversation', { message: text });
}

function stopConversation() {
  send('stop_conversation');
}

function approveAction(approvalId, approved) {
  send('sandbox_approval_response', { approvalId, approved });
  approvalQueue = approvalQueue.filter(a => a.id !== approvalId);
  renderApprovalQueue();
  renderSandboxApprovals();
}

function updateAgent() {
  const name = $('settingsAgentName').value.trim();
  if (name) {
    send('update_agent', { name });
    $('agentNameBadge').textContent = name;
    $('infoAgentName').textContent = name;
  }
}

function updateLlm() {
  const model = $('settingsLlmModel').value.trim();
  if (model) {
    send('update_llm', { model });
    $('infoAgentModel').textContent = model;
  }
}

function toggleAllowAll(enabled) {
  send('set_approval_mode', { allowAll: enabled });
  addSystemMessage(`Allow All: ${enabled ? 'ON' : 'OFF'}`);
}

function broadcastMessage(text) {
  send('swarm_broadcast', { message: text });
}

// ============================================================
// UI Helpers
// ============================================================

function switchTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  if (tabId === 'chat') $('tabChat').classList.add('active');
  else $('tabSandbox').classList.add('active');
}

function addChatMessage(sender, text, type) {
  removeEmptyState('chatMessages');
  const el = document.createElement('div');
  el.className = `chat-msg ${type}`;
  if (type === 'agent') {
    el.innerHTML = `<div class="msg-sender">${escapeHtml(sender)}</div><div class="msg-text">${escapeHtml(text)}</div>`;
  } else {
    el.innerHTML = `<div class="msg-text">${escapeHtml(text)}</div>`;
  }
  $('chatMessages').appendChild(el);
  scrollChat();
}

function addSystemMessage(text) {
  removeEmptyState('chatMessages');
  const el = document.createElement('div');
  el.className = 'chat-msg system';
  el.innerHTML = `<div class="msg-text">${escapeHtml(text)}</div>`;
  $('chatMessages').appendChild(el);
  scrollChat();
}

function addStreamingMessage(agentId) {
  removeEmptyState('chatMessages');
  const el = document.createElement('div');
  el.className = 'chat-msg agent';
  el.id = `stream-${agentId}`;
  el.innerHTML = `<div class="msg-sender">${escapeHtml(agentId)}</div><div class="msg-text"></div>`;
  $('chatMessages').appendChild(el);
  scrollChat();
}

function updateStreamingMessage(agentId, text) {
  const el = document.getElementById(`stream-${agentId}`);
  if (el) {
    el.querySelector('.msg-text').textContent = text;
    scrollChat();
  }
}

function scrollChat() {
  const c = $('chatMessages');
  c.scrollTop = c.scrollHeight;
}

function updatePeerList(peers) {
  const list = $('peerList');
  if (!peers || peers.length === 0) {
    list.innerHTML = '<li class="empty-state">No peers connected</li>';
  } else {
    list.innerHTML = peers.map(p => {
      const name = typeof p === 'string' ? p : (p.name || p.agentName || p.peerId || 'peer');
      return `<li class="peer-item"><span class="peer-dot"></span><span class="peer-name">${escapeHtml(name)}</span></li>`;
    }).join('');
  }
  updateAgentCounter(peers ? peers.length : 0);
  $('infoSessionPeers').textContent = peers ? peers.length : 0;
}

function clearPeerList() {
  $('peerList').innerHTML = '<li class="empty-state">No peers connected</li>';
  updateAgentCounter(0);
  $('infoSessionPeers').textContent = '0';
}

function updateAgentCounter(count) {
  // We don't know the max, so show count as "count/?"
  const total = count || 0;
  $('agentCounter').textContent = `${total}/7`;
}

function renderApprovalQueue() {
  const container = $('approvalQueue');
  if (approvalQueue.length === 0) {
    container.innerHTML = '<div class="empty-state">No pending approvals</div>';
    return;
  }
  container.innerHTML = approvalQueue.map(a => `
    <div class="approval-card">
      <div class="approval-card-title">${escapeHtml(a.action)} — ${escapeHtml(a.agentName)}</div>
      <div class="approval-card-detail">${escapeHtml(a.detail)}</div>
      <div class="approval-actions">
        <button class="btn btn-primary" onclick="approveAction('${a.id}', true)">Approve</button>
        <button class="btn btn-danger" onclick="approveAction('${a.id}', false)">Deny</button>
      </div>
    </div>
  `).join('');
}

function renderSandboxApprovals() {
  const container = $('sandboxApprovals');
  if (approvalQueue.length === 0) {
    container.innerHTML = '<div class="empty-state">No pending approvals.</div>';
    return;
  }
  container.innerHTML = approvalQueue.map(a => `
    <div class="approval-card">
      <div class="approval-card-title">${escapeHtml(a.action)} — ${escapeHtml(a.agentName)}</div>
      <div class="approval-card-detail">${escapeHtml(a.detail)}</div>
      <div class="approval-actions">
        <button class="btn btn-primary" onclick="approveAction('${a.id}', true)">Approve</button>
        <button class="btn btn-danger" onclick="approveAction('${a.id}', false)">Deny</button>
      </div>
    </div>
  `).join('');
}

function renderFileTree(files) {
  const container = $('fileTree');
  if (!files || files.length === 0) {
    container.innerHTML = '<div class="empty-state">No sandbox files yet.</div>';
    return;
  }
  container.innerHTML = files.map(f => {
    const name = typeof f === 'string' ? f : (f.path || f.name || 'file');
    return `<div class="file-tree-item">${escapeHtml(name)}</div>`;
  }).join('');
}

// --- Torrent Key Display ---
function showTorrentKey(key) {
  const box = $('torrentKeyBox');
  const value = $('torrentKeyValue');
  if (key) {
    box.style.display = 'flex';
    value.textContent = key;
    // Auto-select for quick copy
    if (window.getSelection) {
      const range = document.createRange();
      range.selectNodeContents(value);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } else {
    box.style.display = 'none';
    value.textContent = '—';
  }
}

// --- Torrent Key Copy ---
function copyTorrentKey() {
  if (!currentTorrentKey) return;
  navigator.clipboard.writeText(currentTorrentKey).then(() => {
    const btn = document.querySelector('.copy-btn');
    const orig = btn.textContent;
    btn.textContent = 'Kopyalandı!';
    btn.style.background = 'var(--success)';
    btn.style.borderColor = 'var(--success)';
    btn.style.color = '#fff';
    setTimeout(() => {
      btn.textContent = orig;
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '';
    }, 1500);
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = currentTorrentKey;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

// --- Session Timer ---
function startTimer() {
  sessionStartTime = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 1000);
  updateTimer();
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  sessionStartTime = null;
  $('sessionTimer').textContent = '00:00:00';
}

function updateTimer() {
  if (!sessionStartTime) return;
  const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  $('sessionTimer').textContent = `${h}:${m}:${s}`;
}

// --- Utilities ---
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function removeEmptyState(containerId) {
  const container = $(containerId);
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();
}

// ============================================================
// Init
// ============================================================

connect();
