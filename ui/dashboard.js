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
    case 'swarm_message':
      handleSwarmMessage(msg);
      break;
    case 'openclaw_home_status':
      handleOpenClawHomeStatus(msg);
      break;
    case 'gateway_status':
      handleGatewayStatus(msg);
      break;
    case 'gateway_log':
      handleGatewayLog(msg);
      break;
    case 'gateway_start_initiated':
      addSystemMessage('Gateway start requested — streaming logs…');
      break;
    case 'gateway_start_failed':
      handleGatewayStartFailed(msg);
      break;
    case 'gateway_exited':
      addSystemMessage(`Gateway exited (code=${msg.code ?? '-'}${msg.signal ? `, signal=${msg.signal}` : ''})`);
      break;
    case 'swarm_peer_llm_offline':
      handleSwarmPeerLlmOffline(msg);
      break;
    case 'swarm_peer_llm_online':
      handleSwarmPeerLlmOnline(msg);
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

  // OpenClaw home / gateway / LLM offline — initial snapshot
  if (msg.openclawHome) handleOpenClawHomeStatus({ home: msg.openclawHome });
  if (msg.gatewayStatus) handleGatewayStatus({ status: msg.gatewayStatus });
  if (msg.llmOffline?.offline) {
    handleSwarmPeerLlmOffline({ self: true, reason: msg.llmOffline.reason, detail: msg.llmOffline.detail });
  }

  // LLM autoconfig'den baseUrl/model'i info panelinde de göster
  if (msg.llmAutoConfig) {
    $('infoAgentModel').textContent = msg.llmAutoConfig.model || '—';
    $('infoAgentProvider').textContent = msg.llmAutoConfig.providerName || '—';
  }
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

// --- Swarm Messages (peer-to-peer broadcasts) ---
function handleSwarmMessage(msg) {
  const swarmMsg = msg.swarmMessage || {};
  if (swarmMsg.type === 'agent_message') {
    const payload = swarmMsg.payload || {};
    const sender = (payload.from && payload.from.agentName)
      || swarmMsg.from?.agentName
      || msg.peerId
      || 'Peer';
    const content = payload.content || payload.text || '';
    if (content) {
      addChatMessage(sender, content, 'agent');
    }
  } else {
    console.log('[WS] Unhandled swarm message type:', swarmMsg.type, swarmMsg);
  }
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
// OpenClaw Home + Gateway Status Handlers
// ============================================================

// --- Runtime state for status chips ---
let openclawHomeState = null;
let gatewayStatusState = null;

function handleOpenClawHomeStatus(msg) {
  openclawHomeState = msg.home || null;
  const chip = $('chipOpenClawHome');
  const valueEl = $('chipOpenClawHomeValue');
  if (!openclawHomeState || !openclawHomeState.resolved) {
    chip.classList.remove('status-ok', 'status-warn', 'status-bad');
    chip.classList.add('status-bad');
    valueEl.textContent = 'not set';
    // Hata mesajı varsa modal input'una koy
    if (msg.error) {
      const err = $('modalOpenClawHomeError');
      err.textContent = msg.error;
      err.classList.add('show');
    }
    // İlk bağlantıda otomatik wizard aç
    if (!window.__openclawWizardShown) {
      window.__openclawWizardShown = true;
      openOpenClawHomeModal();
    }
    return;
  }
  chip.classList.remove('status-warn', 'status-bad', 'status-unknown');
  chip.classList.add('status-ok');
  const shortPath = truncatePath(openclawHomeState.path, 32);
  valueEl.textContent = shortPath;
  chip.title = `${openclawHomeState.path} (source: ${openclawHomeState.source})`;
  // Wizard açıksa ve artık resolved ise kapat
  if ($('modalOpenClawHome').classList.contains('show')) {
    closeOpenClawHomeModal();
  }
}

function handleGatewayStatus(msg) {
  gatewayStatusState = msg.status || null;
  const chip = $('chipGateway');
  const valueEl = $('chipGatewayValue');
  const actionBtn = $('chipGatewayAction');

  chip.classList.remove('status-ok', 'status-warn', 'status-bad', 'status-unknown');
  if (!gatewayStatusState) {
    chip.classList.add('status-unknown');
    valueEl.textContent = 'checking…';
    actionBtn.style.display = 'none';
    return;
  }

  const h = gatewayStatusState.health;
  if (h === 'running') {
    chip.classList.add('status-ok');
    valueEl.textContent = `${gatewayStatusState.host}:${gatewayStatusState.port}`;
    actionBtn.style.display = 'none';
  } else if (h === 'tcp-only') {
    chip.classList.add('status-warn');
    valueEl.textContent = 'TCP open, HTTP not responding';
    actionBtn.textContent = 'Info';
    actionBtn.style.display = 'inline-block';
  } else {
    chip.classList.add('status-bad');
    valueEl.textContent = gatewayStatusState.summary || 'offline';
    actionBtn.textContent = 'Setup';
    actionBtn.style.display = 'inline-block';
  }
  chip.title = gatewayStatusState.summary || '';
}

function handleGatewayLog(msg) {
  const prefix = msg.stream === 'stderr' ? '[gateway!] ' : '[gateway] ';
  console.log(prefix + (msg.line || '').trimEnd());
}

function handleGatewayStartFailed(msg) {
  addSystemMessage(`Gateway start failed: ${msg.error || 'unknown'}`);
  // Setup modal'ını aç — kullanıcı platforma özel talimatları görsün
  openGatewaySetupModal();
}

function handleSwarmPeerLlmOffline(msg) {
  const chip = $('chipLlm');
  const valueEl = $('chipLlmValue');
  chip.classList.remove('status-ok', 'status-warn', 'status-unknown');
  chip.classList.add('status-bad');
  if (msg.self) {
    valueEl.textContent = `offline (${msg.reason || 'unknown'})`;
    chip.title = msg.detail || 'LLM offline — listener-only mode';
    addSystemMessage(`This peer is now in listener-only mode (${msg.reason || 'unknown'}) — incoming messages still shown, but no auto-responses.`);
  } else {
    valueEl.textContent = `peer offline: ${msg.agentName || msg.peerId || 'unknown'}`;
    chip.title = `${msg.agentName || msg.peerId} is in listener-only mode: ${msg.detail}`;
    addSystemMessage(`Peer ${msg.agentName || msg.peerId || 'unknown'} is in listener-only mode (${msg.reason || 'unknown'}).`);
  }
}

function handleSwarmPeerLlmOnline(msg) {
  if (!msg.self) return;  // Şimdilik self recovery'yi yansıtıyoruz
  const chip = $('chipLlm');
  const valueEl = $('chipLlmValue');
  chip.classList.remove('status-bad', 'status-warn', 'status-unknown');
  chip.classList.add('status-ok');
  valueEl.textContent = 'ready';
  chip.title = 'LLM reachable';
  addSystemMessage('LLM back online — auto-responses enabled.');
}

// --- Modal + action helpers ---

function openOpenClawHomeModal() {
  const overlay = $('modalOpenClawHome');
  const input = $('modalOpenClawHomeInput');
  const err = $('modalOpenClawHomeError');
  const subtitle = $('modalOpenClawHomeSubtitle');

  // Mevcut path varsa placeholder olarak göster
  if (openclawHomeState?.path) {
    input.value = openclawHomeState.path;
    subtitle.innerHTML = 'Change your OpenClaw home folder. Path must contain <code>openclaw.json</code> or a <code>workspace/</code> directory.';
    $('modalOpenClawHomeTitle').textContent = 'Change OpenClaw Folder';
  } else {
    input.value = '';
    subtitle.innerHTML = 'OpenClaw home couldn\'t be detected. Enter the full path to your OpenClaw folder (contains <code>openclaw.json</code> or a <code>workspace/</code> directory). Typical location: <code>~/.openclaw</code>';
    $('modalOpenClawHomeTitle').textContent = 'Select OpenClaw Folder';
  }
  err.classList.remove('show');
  overlay.classList.add('show');
  setTimeout(() => input.focus(), 50);
}

function closeOpenClawHomeModal() {
  $('modalOpenClawHome').classList.remove('show');
}

function submitOpenClawHome() {
  const input = $('modalOpenClawHomeInput');
  const value = input.value.trim();
  if (!value) return;
  $('modalOpenClawHomeError').classList.remove('show');
  send('set_openclaw_home', { path: value });
}

function autoDetectOpenClawHome() {
  // Server tarafında zaten bir sonraki probe'da çözecek — biz sadece mevcut
  // seçimi temizlemek istersek persist clear yapmamız gerek. Basit yol:
  // set_openclaw_home'a ~/.openclaw gönder.
  send('set_openclaw_home', { path: '~/.openclaw' });
}

function openGatewaySetupModal() {
  const overlay = $('modalGatewaySetup');
  const primary = $('hintListPrimary');
  const alts = $('hintListAlternatives');
  primary.innerHTML = '';
  alts.innerHTML = '';

  const hints = gatewayStatusState?.hints || { primary: [], alternatives: [] };
  for (const hint of hints.primary) {
    primary.appendChild(buildHintItem(hint));
  }
  for (const hint of hints.alternatives) {
    alts.appendChild(buildHintItem(hint));
  }
  if (gatewayStatusState?.summary) {
    $('modalGatewaySubtitle').textContent = gatewayStatusState.summary + ' — peer is in listener-only mode.';
  }
  overlay.classList.add('show');
}

function closeGatewaySetupModal() {
  $('modalGatewaySetup').classList.remove('show');
}

function buildHintItem(hint) {
  const li = document.createElement('li');
  li.className = 'hint-item';
  if (hint.label && !hint.command) {
    li.classList.add('hint-divider-line');
    const label = document.createElement('div');
    label.className = 'hint-label';
    label.textContent = hint.label;
    li.appendChild(label);
  } else {
    const label = document.createElement('span');
    label.className = 'hint-label';
    label.textContent = hint.label;
    li.appendChild(label);
    if (hint.command) {
      const cmd = document.createElement('code');
      cmd.className = 'hint-command';
      cmd.textContent = hint.command;
      cmd.title = 'Click to copy';
      cmd.onclick = () => {
        navigator.clipboard?.writeText(hint.command);
      };
      li.appendChild(cmd);
    }
  }
  return li;
}

function retryGateway() {
  send('retry_gateway');
  addSystemMessage('Re-probing gateway…');
}

function requestStartGateway() {
  send('start_gateway');
}

function handleGatewayAction() {
  openGatewaySetupModal();
}

function truncatePath(p, max) {
  if (!p || p.length <= max) return p || '';
  return '…' + p.slice(p.length - max + 1);
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

  if (sessionActive) {
    // Swarm session aktifse → peer-to-peer broadcast gönder
    const agentName = $('agentNameBadge').textContent || 'agent';
    send('swarm_broadcast', {
      swarmMessage: {
        type: 'agent_message',
        payload: {
          content: text,
          from: { agentName },
          role: 'user',
        },
      },
    });
  } else {
    // Swarm yoksa → LLM agent konuşma döngüsü başlat
    // Server `task` alanı bekliyor (ws-server.ts:1141), `message` değil.
    send('start_conversation', { task: text });
  }
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
  const agentName = $('agentNameBadge').textContent || 'agent';
  send('swarm_broadcast', {
    swarmMessage: {
      type: 'agent_message',
      payload: {
        content: text,
        from: { agentName },
        role: 'user',
      },
    },
  });
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
