const app = document.querySelector('#app');
const terminalDialog = document.querySelector('#terminal-dialog');
const terminalTitle = document.querySelector('#terminal-title');
const terminalEyebrow = document.querySelector('#terminal-eyebrow');
const terminalContext = document.querySelector('#terminal-context');
const terminalNode = document.querySelector('#terminal');
const toastNode = document.querySelector('#toast');
let terminal;
let fitAddon;
let terminalSocket;
let sessionSocket;
let refreshTimer;
let overview;
let workspace;

start();

async function start() {
  try {
    overview = await api('/api/overview');
    renderDashboard(overview);
  } catch { renderLogin(); }
}

function renderLogin() {
  clearInterval(refreshTimer);
  app.innerHTML = `
    <section class="login-shell">
      <div class="login-brand"><div class="mark">AGENTWORKS</div><div class="hero"><h1>Own the host.<br>Isolate the work.</h1><p>각 테넌트의 Linux VM과 코딩 에이전트를 한 곳에서 제어하는 로컬 우선 control plane.</p></div><span class="eyebrow">SKELETAL MVP · LOCAL MAC</span></div>
      <form class="login-panel" id="login-form"><span class="eyebrow">CONTROL PLANE ACCESS</span><h2>Master 또는 tenant 계정으로 로그인</h2><label>이메일<input name="email" type="email" autocomplete="username" value="yuryueng@gmail.com" required></label><label>비밀번호<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">콘솔 열기</button><p class="hint">초기 비밀번호는 <code>./agentworks credentials</code>에서 확인할 수 있습니다.</p></form>`;
  document.querySelector('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/login', { method: 'POST', body: { email: form.get('email'), password: form.get('password') } });
      overview = await api('/api/overview');
      renderDashboard(overview);
    } catch (error) { toast(error.message); }
  });
}

function renderDashboard(data) {
  closeSessionStream();
  workspace = null;
  const admin = data.user.role === 'superadmin';
  app.innerHTML = `
    <section class="shell">
      <nav class="topbar"><div class="mark">AGENTWORKS</div><div class="identity"><span><strong>${escapeHtml(data.user.email)}</strong><br>${admin ? 'SUPERADMIN' : 'TENANT OWNER'}</span><button class="quiet-button" id="logout">로그아웃</button></div></nav>
      <section class="headline"><div><span class="eyebrow">${admin ? 'MASTER CONTROL PLANE' : 'PRIVATE TENANT SPACE'}</span><h1>${admin ? 'Tenant cells' : 'Your agent cell'}</h1></div><p>${admin ? '호스트 Worker를 통해 격리된 VM을 생성하고 각 VM의 workspace와 에이전트 세션을 관리합니다.' : '다른 테넌트와 분리된 Linux VM입니다. 인증 정보, 세션, workspace는 이 VM에 유지됩니다.'}</p></section>
      ${admin ? `<div class="worker-strip">${data.workers.length ? data.workers.map(workerPill).join('') : '<span class="worker-pill"><i class="dot"></i>Worker 연결 대기 중</span>'}</div>` : ''}
      ${admin ? `<section class="master-agent-card"><div><span class="eyebrow">SELF-SERVING CONTROL · SAME AGENT RULES</span><h2>Master Agent</h2><p>테넌트 에이전트와 동일한 세션·별칭·모델/추론·Goal·스트리밍·stop/steer·메시징 규칙을 사용하며, 감사 가능한 관리자 MCP로 VM을 제어합니다.</p></div><div class="actions"><button class="primary" data-workspace="cell-master">Master Agent 열기</button><button class="action-button" data-console="master-agent" data-name="Master Agent Login">CLI 로그인 터미널</button></div></section>` : ''}
      ${admin ? `<section class="master-agent-card tenant-create-card"><div><span class="eyebrow">NEW ISOLATED TENANT</span><h2>테넌트와 VM 생성</h2><p>owner 계정, 영속 workspace/CLI 인증 상태를 위한 독립 cell, vCPU·메모리 ceiling을 생성합니다. 초기 비밀번호는 생성 요청에만 사용되며 audit log에 저장되지 않습니다.</p></div><form id="tenant-create" class="tenant-create-form"><input name="displayName" placeholder="표시 이름" maxlength="120" required><input name="slug" placeholder="slug (예: gamma)" pattern="[a-z0-9][a-z0-9-]{1,47}" maxlength="48" required><input name="email" type="email" placeholder="owner@example.com" required><input name="password" type="password" placeholder="초기 비밀번호 (12자 이상)" minlength="12" maxlength="256" required><div class="form-row"><input name="desiredVcpus" type="number" min="1" value="2" required><input name="desiredMemoryMib" type="number" min="512" step="512" value="4096" required><button class="primary" type="submit">Tenant 생성</button></div></form></section>` : ''}
      <section class="cell-grid">${data.cells.length ? data.cells.map(cellCard).join('') : '<div class="empty">표시할 tenant cell이 없습니다.</div>'}</section>
      <aside class="backlog"><b>MESSAGING LIVE</b><span>Namespaced alias, stable UUID, durable queue, exact-session wake와 VM bridge MCP가 활성화되어 있습니다. 전달 불가능한 메시지는 대상 세션이 복구될 때까지 보존됩니다.</span></aside>
    </section>`;
  document.querySelector('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); renderLogin(); });
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', runAction));
  document.querySelectorAll('[data-console]').forEach(button => button.addEventListener('click', () => openTerminal(button.dataset.console, button.dataset.name)));
  document.querySelectorAll('[data-workspace]').forEach(button => button.addEventListener('click', () => openWorkspace(button.dataset.workspace)));
  document.querySelector('#tenant-create')?.addEventListener('submit', createTenant);
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshDashboard, 5000);
}

async function createTenant(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const values = new FormData(form);
  submit.disabled = true;
  try {
    const result = await api('/api/admin/tenants', {
      method: 'POST',
      body: {
        displayName: values.get('displayName'), slug: values.get('slug'), email: values.get('email'), password: values.get('password'),
        desiredVcpus: Number(values.get('desiredVcpus')), desiredMemoryMib: Number(values.get('desiredMemoryMib')),
      },
    });
    form.reset();
    toast(`${result.tenant.displayName} 생성됨 · VM provisioning ${result.provisioning.state}`);
    overview = await api('/api/overview');
    renderDashboard(overview);
  } catch (error) { toast(error.message); }
  finally { submit.disabled = false; }
}

async function refreshDashboard() {
  if (workspace || terminalDialog.open) return;
  try { overview = await api('/api/overview'); renderDashboard(overview); } catch {}
}

function workerPill(worker) {
  return `<span class="worker-pill"><i class="dot ${worker.status}"></i>${escapeHtml(worker.id)} · ${escapeHtml(worker.runtime || 'runtime')} · ${escapeHtml(worker.status)}</span>`;
}

function cellCard(cell) {
  const statusClass = ['running', 'online'].includes(cell.status) ? 'running' : cell.status === 'error' ? 'error' : '';
  const disabled = cell.status !== 'running' ? 'disabled' : '';
  return `<article class="cell-card"><header><div><span class="eyebrow">${escapeHtml(cell.tenant_slug)}</span><h2>${escapeHtml(cell.tenant_name)}</h2><span class="slug">${escapeHtml(cell.runtime_name)}</span></div><span class="status"><i class="dot ${statusClass}"></i>${escapeHtml(cell.status)}</span></header><div class="metrics"><div class="metric"><span>ACTIVE / MAX CPU</span><strong>${cell.desired_vcpus} / ${cell.max_vcpus} vCPU</strong></div><div class="metric"><span>ACTIVE / MAX RAM</span><strong>${formatGiB(cell.desired_memory_mib)} / ${formatGiB(cell.max_memory_mib)}</strong></div></div><div class="agent-status">Agent tools: <code>${escapeHtml(cell.agents_status)}</code>${cell.last_error ? `<br><span>${escapeHtml(cell.last_error)}</span>` : ''}</div><div class="actions"><button class="action-button workspace-button" data-workspace="${cell.id}" ${disabled}>Workspace 열기</button><button class="action-button" data-console="${cell.id}" data-name="${escapeHtml(cell.tenant_name)}" ${disabled}>터미널</button><button class="action-button" data-action="start" data-cell="${cell.id}">시작</button><button class="action-button" data-action="stop" data-cell="${cell.id}">정지</button><button class="action-button" data-action="install_agents" data-cell="${cell.id}">CLI 확인/설치</button></div></article>`;
}

async function openWorkspace(cellId) {
  clearInterval(refreshTimer);
  app.innerHTML = `<div class="workspace-loading"><span class="eyebrow">${cellId === 'cell-master' ? 'OPENING MASTER AGENT' : 'OPENING TENANT VM'}</span><h1>Workspace를 불러오는 중…</h1></div>`;
  try {
    const [description, sessionData, usage, directory, queue] = await Promise.all([
      api(`/api/cells/${cellId}/workspace`),
      api(`/api/cells/${cellId}/sessions`),
      api(`/api/cells/${cellId}/usage`).catch(error => ({ error: error.message, providers: {}, sessions: [], models: [] })),
      api('/api/inter-session/directory'),
      api('/api/inter-session/messages'),
    ]);
    workspace = { cellId, description, usage, sessions: sessionData.sessions, path: description.defaultPath, directory: null, activeSession: null, messages: [], interSession: { directory: directory.sessions, messages: queue.messages } };
    renderWorkspace();
    await browsePath(description.defaultPath);
    if (workspace.sessions[0]) await selectSession(workspace.sessions[0].session_uuid);
  } catch (error) { toast(error.message); workspace = null; renderDashboard(overview); }
}

function renderWorkspace() {
  const state = workspace;
  const desc = state.description;
  app.innerHTML = `
    <section class="workspace-shell">
      <nav class="workspace-topbar"><button class="quiet-button" id="back-dashboard">← Cells</button><div><span class="eyebrow">${escapeHtml(desc.cell.tenantSlug)} · ${escapeHtml(desc.cell.runtimeName)}</span><strong>${escapeHtml(desc.cell.tenantName)}</strong></div><div class="auth-badges">${authBadge('Codex', desc.auth.codex)}${authBadge('Claude', desc.auth.claude)}<button class="quiet-button" id="open-messaging">Messaging</button><button class="quiet-button" id="workspace-terminal">터미널 로그인</button></div></nav>
      <section id="usage-overview" class="usage-overview">${usageOverviewHtml(state.usage, state.activeSession)}</section>
      <main class="workspace-grid">
        <section class="browser-pane pane"><header><span class="eyebrow">FOLDER BROWSER</span><h2>작업 폴더</h2></header><div id="folder-path" class="folder-path"></div><div id="folder-list" class="folder-list"><div class="loading-row">불러오는 중…</div></div></section>
        <section class="session-pane pane"><header><span class="eyebrow">KNOWN SESSIONS</span><h2>에이전트 세션</h2></header><form id="new-session" class="new-session-form"><input name="alias" placeholder="고유 alias (예: planner)" value="new-agent" maxlength="64" pattern="[A-Za-z0-9._-]+" required><div class="form-row"><select name="harness" id="harness-select"><option value="codex">Codex</option><option value="claude">Claude Code</option></select><select name="model" id="model-select"></select></div><div class="form-row"><select name="effort" id="effort-select"></select><button class="primary" type="submit">세션 생성</button></div><div class="selected-folder" title="${escapeHtml(state.path)}">cwd <code id="selected-cwd">${escapeHtml(state.path)}</code></div></form><div id="session-list" class="session-list">${sessionListHtml(state.sessions, state.activeSession?.session_uuid)}</div></section>
        <section class="chat-pane pane"><div id="chat-header" class="chat-header">${chatHeaderHtml(state.activeSession)}</div><div id="chat-messages" class="chat-messages">${messagesHtml(state.messages, state.activeSession)}</div><form id="chat-form" class="chat-form"><textarea name="content" placeholder="선택한 세션에 메시지 보내기…" rows="3" ${state.activeSession ? '' : 'disabled'}></textarea><div class="chat-actions"><button id="session-stop" class="danger-button" type="button" hidden>중단</button><button id="chat-submit" class="primary" type="submit" ${state.activeSession ? '' : 'disabled'}>보내기</button></div></form></section>
      </main>
      ${messagingDialogHtml(state.interSession)}
    </section>`;
  document.querySelector('#back-dashboard').addEventListener('click', () => renderDashboard(overview));
  document.querySelector('#workspace-terminal').addEventListener('click', () => openTerminal(desc.cell.kind === 'master' ? 'master-agent' : state.cellId, desc.cell.tenantName));
  document.querySelector('#open-messaging').addEventListener('click', () => document.querySelector('#messaging-dialog').showModal());
  document.querySelector('#new-session').addEventListener('submit', createSession);
  document.querySelector('#harness-select').addEventListener('change', updateModelPicker);
  document.querySelector('#model-select').addEventListener('change', updateEffortPicker);
  document.querySelector('#chat-form').addEventListener('submit', sendChat);
  document.querySelector('#session-stop').addEventListener('click', stopSession);
  document.querySelector('#refresh-usage')?.addEventListener('click', refreshUsage);
  updateModelPicker();
  wireSessionButtons();
  wireSessionSettings();
  wireSessionControls();
  wireMessaging();
  updateComposerState();
}

async function browsePath(target) {
  try {
    const directory = await api(`/api/cells/${workspace.cellId}/files?path=${encodeURIComponent(target)}`);
    workspace.path = directory.path;
    workspace.directory = directory;
    document.querySelector('#selected-cwd').textContent = directory.path;
    renderDirectory(directory);
  } catch (error) { toast(error.message); }
}

function renderDirectory(directory) {
  const crumbs = directory.path === '/' ? ['/'] : ['/', ...directory.path.split('/').filter(Boolean)];
  let cursor = '';
  document.querySelector('#folder-path').innerHTML = crumbs.map((part, index) => {
    cursor = part === '/' ? '/' : `${cursor === '/' ? '' : cursor}/${part}`;
    return `<button data-path="${escapeHtml(cursor)}">${escapeHtml(part)}</button>${index < crumbs.length - 1 ? '<span>/</span>' : ''}`;
  }).join('');
  const dirs = directory.items.filter(item => item.type === 'directory');
  const files = directory.items.filter(item => item.type === 'file');
  document.querySelector('#folder-list').innerHTML = `${directory.parent ? `<button class="folder-row parent" data-path="${escapeHtml(directory.parent)}"><span>↰</span><b>상위 폴더</b></button>` : ''}${dirs.map(item => `<button class="folder-row" data-path="${escapeHtml(item.path)}"><span>▸</span><b>${escapeHtml(item.name)}</b></button>`).join('')}${files.slice(0, 120).map(item => `<div class="folder-row file"><span>·</span><span>${escapeHtml(item.name)}</span><small>${formatBytes(item.size)}</small></div>`).join('')}${!directory.items.length ? '<div class="empty-row">빈 폴더</div>' : ''}`;
  document.querySelectorAll('[data-path]').forEach(button => button.addEventListener('click', () => browsePath(button.dataset.path)));
}

function updateModelPicker() {
  const harness = document.querySelector('#harness-select').value;
  const models = workspace.description.models[harness] || [];
  const select = document.querySelector('#model-select');
  select.innerHTML = models.length ? models.map(model => `<option value="${escapeHtml(model.id)}" ${model.isDefault ? 'selected' : ''}>${escapeHtml(model.displayName)}</option>`).join('') : '<option value="default">default</option>';
  updateEffortPicker();
}

function updateEffortPicker() {
  const harness = document.querySelector('#harness-select').value;
  const modelId = document.querySelector('#model-select').value;
  const model = (workspace.description.models[harness] || []).find(item => item.id === modelId);
  const efforts = model?.efforts?.length ? model.efforts : ['low', 'medium', 'high'];
  document.querySelector('#effort-select').innerHTML = efforts.map(effort => `<option value="${escapeHtml(effort)}" ${effort === (model?.defaultEffort || 'medium') ? 'selected' : ''}>${escapeHtml(effort)} effort</option>`).join('');
}

async function createSession(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const form = new FormData(event.currentTarget);
  button.disabled = true;
  try {
    const alias = form.get('alias');
    const result = await api(`/api/cells/${workspace.cellId}/sessions`, { method: 'POST', body: { title: alias, alias, harness: form.get('harness'), model: form.get('model'), effort: form.get('effort'), cwd: workspace.path } });
    workspace.sessions.unshift(result.session);
    await selectSession(result.session.session_uuid);
    toast('세션을 생성했습니다. 이제 첫 메시지를 보내세요.');
    await refreshMessaging();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

async function selectSession(sessionUuid) {
  try {
    const data = await api(`/api/sessions/${sessionUuid}/messages`);
    workspace.activeSession = data.session;
    workspace.messages = data.messages;
    connectSessionStream(sessionUuid);
    const index = workspace.sessions.findIndex(item => item.session_uuid === sessionUuid);
    if (index >= 0) workspace.sessions[index] = { ...workspace.sessions[index], ...data.session };
    document.querySelector('#session-list').innerHTML = sessionListHtml(workspace.sessions, sessionUuid);
    document.querySelector('#chat-header').innerHTML = chatHeaderHtml(data.session);
    document.querySelector('#chat-messages').innerHTML = messagesHtml(data.messages, data.session);
    document.querySelector('#usage-overview').innerHTML = usageOverviewHtml(workspace.usage, data.session);
    const input = document.querySelector('#chat-form textarea');
    input.disabled = false;
    wireSessionButtons();
    wireSessionSettings();
    wireSessionControls();
    updateComposerState();
    document.querySelector('#refresh-usage')?.addEventListener('click', refreshUsage);
    scrollChat();
  } catch (error) { toast(error.message); }
}

function connectSessionStream(sessionUuid) {
  closeSessionStream();
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}/ws/session?session=${encodeURIComponent(sessionUuid)}`);
  sessionSocket = socket;
  socket.addEventListener('message', event => {
    if (sessionSocket !== socket || workspace?.activeSession?.session_uuid !== sessionUuid) return;
    try { applySessionPayload(JSON.parse(event.data)); } catch {}
  });
  socket.addEventListener('close', () => {
    if (sessionSocket !== socket || workspace?.activeSession?.session_uuid !== sessionUuid) return;
    sessionSocket = null;
    setTimeout(() => {
      if (workspace?.activeSession?.session_uuid === sessionUuid && !sessionSocket) connectSessionStream(sessionUuid);
    }, 1500);
  });
}

function closeSessionStream() {
  const socket = sessionSocket;
  sessionSocket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
}

function applySessionPayload(payload) {
  if (!workspace?.activeSession) return;
  if (payload.sessionStatus) {
    workspace.activeSession.status = payload.sessionStatus;
    const index = workspace.sessions.findIndex(item => item.session_uuid === workspace.activeSession.session_uuid);
    if (index >= 0) workspace.sessions[index] = { ...workspace.sessions[index], status: payload.sessionStatus };
  }
  for (const message of [payload.userMessage, payload.assistantMessage].filter(Boolean)) {
    const index = workspace.messages.findIndex(item => item.id === message.id);
    if (index >= 0) workspace.messages[index] = message;
    else workspace.messages.push(message);
  }
  const roleOrder = { user: 0, assistant: 1, system: 2 };
  workspace.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9));
  renderLiveSession();
  if (['turn.completed', 'turn.failed', 'turn.interrupted'].includes(payload.type)) {
    if (payload.type === 'turn.failed') toast(payload.error || '세션 실행이 실패했습니다.');
    if (payload.type === 'turn.interrupted') toast('현재 turn을 중단했습니다.');
    void refreshUsage();
  }
}

function renderLiveSession() {
  const messagesNode = document.querySelector('#chat-messages');
  if (!messagesNode || !workspace?.activeSession) return;
  const nearBottom = messagesNode.scrollHeight - messagesNode.scrollTop - messagesNode.clientHeight < 140;
  const openEvents = new Set([...messagesNode.querySelectorAll('details[open][data-event-id]')].map(node => node.dataset.eventId));
  messagesNode.innerHTML = messagesHtml(workspace.messages, workspace.activeSession);
  for (const id of openEvents) {
    const node = [...messagesNode.querySelectorAll('[data-event-id]')].find(item => item.dataset.eventId === id);
    if (node) node.open = true;
  }
  document.querySelector('#session-list').innerHTML = sessionListHtml(workspace.sessions, workspace.activeSession.session_uuid);
  wireSessionButtons();
  updateComposerState();
  if (nearBottom) scrollChat();
}

async function sendChat(event) {
  event.preventDefault();
  if (!workspace.activeSession) return;
  const form = event.currentTarget;
  const input = form.elements.content;
  const button = form.querySelector('#chat-submit');
  const content = input.value.trim();
  if (!content) return;
  const steering = workspace.activeSession.status === 'busy';
  input.value = ''; button.disabled = true;
  try {
    if (steering) {
      const result = await api(`/api/sessions/${workspace.activeSession.session_uuid}/steer`, { method: 'POST', body: { content } });
      toast(result.mode === 'restart' ? 'Claude turn을 중단하고 steering 메시지로 즉시 이어갑니다.' : '현재 turn에 steering 메시지를 전달했습니다.');
    } else {
      const accepted = await api(`/api/sessions/${workspace.activeSession.session_uuid}/messages`, { method: 'POST', body: { content } });
      applySessionPayload({ ...accepted, type: 'turn.accepted' });
    }
  } catch (error) {
    toast(error.message);
    input.value = content;
  } finally { button.disabled = false; updateComposerState(); input.focus(); }
}

function sessionListHtml(sessions, activeId) {
  return sessions.length ? sessions.map(session => `<button class="session-row ${session.session_uuid === activeId ? 'active' : ''}" data-session="${session.session_uuid}"><span class="provider ${session.harness}">${session.harness === 'codex' ? 'C' : 'A'}</span><span><b>@${escapeHtml(session.alias || session.title)}</b><small>${escapeHtml(session.model)} · ${escapeHtml(session.status)}</small></span></button>`).join('') : '<div class="empty-row">아직 세션이 없습니다.</div>';
}

function wireSessionButtons() { document.querySelectorAll('[data-session]').forEach(button => button.addEventListener('click', () => selectSession(button.dataset.session))); }
function chatHeaderHtml(session) {
  if (!session) return '<div><span class="eyebrow">AGENT CHAT</span><h2>세션을 선택하세요</h2></div>';
  const models = sessionModels(session);
  const currentModel = models.find(item => item.id === session.model) || { id: session.model, displayName: session.model, efforts: [session.effort || 'medium'] };
  const efforts = currentModel.efforts?.length ? currentModel.efforts : ['low', 'medium', 'high'];
  const goal = session.goal?.objective || '';
  return `<div class="chat-identity"><span class="eyebrow">${escapeHtml(session.harness)} SESSION · @${escapeHtml(session.alias || '')}</span><h2>${escapeHtml(session.title)}</h2><code>${escapeHtml(session.cwd)}</code><code class="session-address">${escapeHtml(session.address || session.session_uuid)}</code>${goal ? `<span class="goal-chip" title="${escapeHtml(goal)}">GOAL · ${escapeHtml(goal)}</span>` : ''}</div><div class="chat-header-tools"><div class="session-meta-actions"><span class="session-uuid" title="stable inter-agent target">UUID ${escapeHtml(session.session_uuid)}</span><button id="session-goal" class="quiet-button" type="button">Goal</button><button id="session-archive" class="quiet-button" type="button">Archive</button></div><form id="session-settings" class="session-settings"><input name="alias" aria-label="세션 alias" value="${escapeHtml(session.alias || '')}" pattern="[A-Za-z0-9._-]+" required><select name="model" id="active-model" aria-label="활성 세션 모델">${models.map(model => `<option value="${escapeHtml(model.id)}" ${model.id === session.model ? 'selected' : ''}>${escapeHtml(model.displayName)}</option>`).join('')}</select><select name="effort" id="active-effort" aria-label="활성 세션 reasoning">${efforts.map(effort => `<option value="${escapeHtml(effort)}" ${effort === session.effort ? 'selected' : ''}>${escapeHtml(effort)}</option>`).join('')}</select><button type="submit" class="action-button">다음 turn부터 적용</button></form></div>`;
}

function sessionModels(session) {
  const models = workspace?.description?.models?.[session.harness] || [];
  return models.some(item => item.id === session.model) ? models : [{ id: session.model, displayName: session.model, efforts: [session.effort || 'medium'] }, ...models];
}

function wireSessionSettings() {
  const form = document.querySelector('#session-settings');
  if (!form || !workspace?.activeSession) return;
  const modelSelect = form.querySelector('#active-model');
  const effortSelect = form.querySelector('#active-effort');
  modelSelect.addEventListener('change', () => {
    const model = sessionModels(workspace.activeSession).find(item => item.id === modelSelect.value);
    const efforts = model?.efforts?.length ? model.efforts : ['low', 'medium', 'high'];
    effortSelect.innerHTML = efforts.map(effort => `<option value="${escapeHtml(effort)}" ${effort === (model?.defaultEffort || workspace.activeSession.effort || 'medium') ? 'selected' : ''}>${escapeHtml(effort)}</option>`).join('');
  });
  form.addEventListener('submit', updateSessionSettings);
}

function wireSessionControls() {
  document.querySelector('#session-goal')?.addEventListener('click', updateSessionGoal);
  document.querySelector('#session-archive')?.addEventListener('click', archiveSession);
}

async function updateSessionGoal() {
  const session = workspace?.activeSession;
  if (!session) return;
  const objective = window.prompt('이 세션의 지속 목표를 입력하세요. 비우면 goal을 해제합니다.', session.goal?.objective || '');
  if (objective === null) return;
  try {
    const result = await api(`/api/sessions/${session.session_uuid}/goal`, { method: 'PUT', body: { objective } });
    session.goal = result.goal;
    const index = workspace.sessions.findIndex(item => item.session_uuid === session.session_uuid);
    if (index >= 0) workspace.sessions[index] = { ...workspace.sessions[index], goal: result.goal };
    document.querySelector('#chat-header').innerHTML = chatHeaderHtml(session);
    wireSessionSettings();
    wireSessionControls();
    toast(objective.trim() ? '지속 goal을 저장했습니다.' : 'goal을 해제했습니다.');
  } catch (error) { toast(error.message); }
}

async function archiveSession() {
  const session = workspace?.activeSession;
  if (!session || !window.confirm(`@${session.alias} 세션을 archive할까요? 대화와 native 세션은 삭제되지 않습니다.`)) return;
  try {
    await api(`/api/sessions/${session.session_uuid}/archive`, { method: 'POST' });
    closeSessionStream();
    workspace.sessions = workspace.sessions.filter(item => item.session_uuid !== session.session_uuid);
    workspace.activeSession = null;
    workspace.messages = [];
    if (workspace.sessions[0]) await selectSession(workspace.sessions[0].session_uuid);
    else renderWorkspace();
    toast('세션을 archive했습니다. 데이터는 보존됩니다.');
  } catch (error) { toast(error.message); }
}

async function stopSession() {
  const session = workspace?.activeSession;
  const button = document.querySelector('#session-stop');
  if (!session || session.status !== 'busy') return;
  button.disabled = true;
  button.textContent = '중단 중…';
  try { await api(`/api/sessions/${session.session_uuid}/stop`, { method: 'POST' }); }
  catch (error) { toast(error.message); button.disabled = false; button.textContent = '중단'; }
}

function updateComposerState() {
  const form = document.querySelector('#chat-form');
  if (!form) return;
  const session = workspace?.activeSession;
  const input = form.elements.content;
  const submit = form.querySelector('#chat-submit');
  const stop = form.querySelector('#session-stop');
  const busy = session?.status === 'busy';
  input.disabled = !session;
  submit.disabled = !session;
  submit.textContent = busy ? '스티어링' : '보내기';
  submit.classList.toggle('steer-button', busy);
  input.placeholder = busy ? '실행 중인 turn에 추가 지시(steering)…' : '선택한 세션에 메시지 보내기…';
  stop.hidden = !busy;
  if (!busy) { stop.disabled = false; stop.textContent = '중단'; }
}

async function updateSessionSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const formData = new FormData(form);
  button.disabled = true;
  button.textContent = '적용 중…';
  try {
    const result = await api(`/api/sessions/${workspace.activeSession.session_uuid}`, {
      method: 'PATCH', body: { alias: formData.get('alias'), model: formData.get('model'), effort: formData.get('effort') },
    });
    workspace.activeSession = result.session;
    const index = workspace.sessions.findIndex(item => item.session_uuid === result.session.session_uuid);
    if (index >= 0) workspace.sessions[index] = { ...workspace.sessions[index], ...result.session };
    document.querySelector('#session-list').innerHTML = sessionListHtml(workspace.sessions, result.session.session_uuid);
    document.querySelector('#chat-header').innerHTML = chatHeaderHtml(result.session);
    wireSessionButtons();
    wireSessionSettings();
    wireSessionControls();
    document.querySelector('#usage-overview').innerHTML = usageOverviewHtml(workspace.usage, result.session);
    document.querySelector('#refresh-usage')?.addEventListener('click', refreshUsage);
    await refreshMessaging();
    toast('모델과 reasoning이 저장되었습니다. 현재 작업 중인 turn은 유지되고 다음 turn부터 적용됩니다.');
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = '다음 turn부터 적용';
  }
}

async function refreshUsage() {
  const button = document.querySelector('#refresh-usage');
  if (button) { button.disabled = true; button.textContent = '갱신 중…'; }
  try {
    workspace.usage = await api(`/api/cells/${workspace.cellId}/usage`);
    const panel = document.querySelector('#usage-overview');
    if (panel) {
      panel.innerHTML = usageOverviewHtml(workspace.usage, workspace.activeSession);
      document.querySelector('#refresh-usage')?.addEventListener('click', refreshUsage);
    }
  } catch (error) { toast(`사용량 갱신 실패: ${error.message}`); }
}

function usageOverviewHtml(usage = {}, activeSession) {
  const telemetry = usage.sessions?.find(item => item.session_uuid === activeSession?.session_uuid)?.telemetry || activeSession?.telemetry || {};
  const context = telemetry.context || {};
  const usedPercent = finitePercent(context.usedPercent);
  const remainingPercent = finitePercent(context.remainingPercent);
  const codex = usage.providers?.codex?.data || {};
  const claude = usage.providers?.claude?.data || {};
  const codexLimits = codex.rateLimits || {};
  const claudeLimits = claude.rateLimits || {};
  const modelRows = usage.models || [];
  const updatedAt = usage.capturedAt ? new Date(usage.capturedAt).toLocaleTimeString() : '아직 없음';
  return `<div class="usage-toolbar"><span class="eyebrow">LIVE USAGE · ${escapeHtml(updatedAt)}</span><button id="refresh-usage" class="quiet-button" type="button">실제 사용량 갱신</button></div><div class="usage-cards">
    <article class="usage-card context-card"><header><b>현재 세션 context</b><span>${activeSession ? escapeHtml(activeSession.model) : '세션 미선택'}</span></header>${usedPercent === null ? '<p class="usage-unavailable">첫 응답 후 실제 context가 표시됩니다.</p>' : `${progressHtml(usedPercent, `${formatPercent(remainingPercent)} 남음`)}<small>${formatNumber(context.usedTokens)} / ${formatNumber(context.contextWindow)} tokens</small>`}</article>
    <article class="usage-card"><header><b>Codex 계정</b><span>CLI account</span></header>${providerLimitsHtml(codexLimits, 'codex')}${codex.accountUsage && !codex.accountUsage.unavailable ? `<small>최근 7일 ${formatNumber(recentTokens(codex.accountUsage.dailyUsageBuckets, 7))} tokens</small>` : ''}</article>
    <article class="usage-card"><header><b>Claude 계정</b><span>CLI subscriber</span></header>${providerLimitsHtml(claudeLimits, 'claude')}</article>
    <article class="usage-card model-usage"><header><b>모델별 누적</b><span>이 서버에서 수집</span></header>${modelRows.length ? `<div class="model-usage-list">${modelRows.slice(0, 6).map(model => `<div><span><i class="provider-dot ${escapeHtml(model.harness)}"></i>${escapeHtml(model.model)}</span><b>${formatNumber(model.processedTokens)} tok</b><small>${model.turns} turns${model.costUSD ? ` · $${Number(model.costUSD).toFixed(4)}` : ''}</small></div>`).join('')}</div>` : '<p class="usage-unavailable">수집된 turn 사용량이 없습니다.</p>'}</article>
  </div>`;
}

function providerLimitsHtml(raw, harness) {
  if (!raw || raw.unavailable) return `<p class="usage-unavailable">${escapeHtml(raw?.unavailable || 'CLI에서 아직 사용량을 받지 못했습니다.')}</p>`;
  const entries = limitEntries(raw);
  if (!entries.length) {
    const note = harness === 'claude' ? 'Claude headless CLI가 현재 주간 사용률 %를 제공하지 않습니다.' : '계정 한도 데이터가 아직 없습니다.';
    return `<p class="usage-unavailable">${escapeHtml(note)}</p>`;
  }
  const rendered = entries.slice(0, 3).map(([key, value]) => {
    const percent = finitePercent(value.usedPercent ?? value.used_percentage ?? value.utilization);
    const reset = value.resetsAt ?? value.resets_at;
    const label = limitLabel(key, value);
    if (percent === null) return `<div class="limit-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value.status || '실제 % 미제공')}</b>${reset ? `<small>${formatReset(reset)}</small>` : ''}</div>`;
    return `<div class="limit-block"><div><span>${escapeHtml(label)}</span><b>${formatPercent(percent)} 사용</b></div>${progressHtml(percent, reset ? formatReset(reset) : '')}</div>`;
  }).join('');
  const hasWeekly = entries.some(([key, value]) => /week|seven|secondary/i.test(key) || Number(value.windowDurationMins || value.window_duration_mins) >= 7 * 24 * 60);
  return `${rendered}${harness === 'claude' && !hasWeekly ? '<small class="usage-unavailable">주간 %: 현재 CLI stream 미제공</small>' : ''}`;
}

function limitEntries(raw) {
  if (Array.isArray(raw)) return raw.map((value, index) => [value.name || value.rateLimitType || `window-${index + 1}`, value]);
  if (raw.rateLimits) {
    const account = raw.rateLimits;
    const entries = [
      ['primary', account.primary],
      ['secondary', account.secondary],
    ];
    for (const limit of Object.values(raw.rateLimitsByLimitId || {})) {
      if (!limit || limit.limitId === account.limitId || !limit.primary) continue;
      entries.push([limit.limitName || limit.limitId, { ...limit.primary, label: limit.limitName || limit.limitId }]);
    }
    return entries.filter(([, value]) => isLimitValue(value));
  }
  const preferred = ['primary', 'secondary', 'five_hour', 'seven_day'];
  const entries = Object.entries(raw).filter(([, value]) => isLimitValue(value));
  return entries.sort(([a], [b]) => {
    const ai = preferred.indexOf(a); const bi = preferred.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

function isLimitValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && (
    value.usedPercent !== undefined || value.used_percentage !== undefined || value.utilization !== undefined ||
    value.resetsAt !== undefined || value.resets_at !== undefined || value.status !== undefined
  );
}

function limitLabel(key, value) {
  if (value.label) return value.label;
  const minutes = Number(value.windowDurationMins ?? value.window_duration_mins ?? 0);
  if (/secondary|seven|week/i.test(key) || minutes >= 7 * 24 * 60) return '주간';
  if (/primary|five/i.test(key) || minutes >= 4 * 60) return '5시간';
  return key.replaceAll('_', ' ');
}

function progressHtml(percent, label) {
  const safe = finitePercent(percent) ?? 0;
  return `<div class="usage-progress" title="${escapeHtml(label)}"><i style="width:${safe}%"></i><span>${escapeHtml(label)}</span></div>`;
}

function messagesHtml(messages, session) {
  if (!session) return '<div class="chat-empty">왼쪽에서 작업 폴더를 고르고 새 세션을 만드세요.</div>';
  if (!messages.length) return `<div class="chat-empty"><b>${escapeHtml(session.title)}</b><span>이 세션은 <code>${escapeHtml(session.cwd)}</code>에서 실행됩니다. 첫 메시지를 보내면 CLI native session이 생성됩니다.</span></div>`;
  return messages.map(message => {
    const label = message.role === 'user' ? 'YOU' : message.role === 'assistant' ? session.harness.toUpperCase() : 'SYSTEM';
    const content = message.role === 'assistant' && message.html
      ? `<div class="markdown-body">${message.html}</div>`
      : message.role === 'assistant' && message.detail?.streaming
        ? '<div class="streaming-answer"><i></i><span>응답을 생성하는 중…</span></div>'
        : `<pre class="plain-message">${escapeHtml(message.content)}</pre>`;
    const live = Boolean(message.detail?.streaming);
    return `<article class="message ${message.role} ${live ? 'streaming' : ''}" data-message-id="${escapeHtml(message.id)}"><header>${label}${live ? ' · LIVE' : ''}</header>${message.role === 'assistant' ? activityHtml(message.detail?.events || [], live) : ''}${content}${message.role === 'assistant' ? turnUsageHtml(message.detail || {}) : ''}</article>`;
  }).join('');
}

function activityHtml(events, streaming = false) {
  if (!events.length) return '';
  const ordered = [...events].sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
  const labels = { command: '명령', reasoning: '생각', steering: '스티어링', file_change: '파일 변경', subagent: '서브에이전트', subagent_message: '서브에이전트 응답', tool: '도구', web: '검색', plan: '계획', compact: '정리', model: '모델' };
  const counts = ordered.reduce((result, event) => {
    const type = event.type || 'tool';
    result[type] = (result[type] || 0) + 1;
    return result;
  }, {});
  const summary = Object.entries(counts).map(([type, count]) => `${labels[type] || type} ${count}`).join(' · ');
  const items = ordered.map((event, index) => {
    const type = event.type || 'tool';
    const icon = ({ command: '›_', file_change: 'Δ', subagent: '◎', subagent_message: '↳', tool: '◇', web: '⌕', plan: '☷', reasoning: '∴', steering: '↪', compact: '↺', model: 'M' })[type] || '·';
    const running = ['started', 'inProgress', 'running'].includes(event.status);
    const status = running ? 'running' : event.status || '';
    return `<details class="activity event-${escapeHtml(type)} ${running ? 'running' : ''}" data-event-id="${escapeHtml(event.id || `${type}:${index}`)}"><summary><i>${icon}</i><span>${escapeHtml(event.title || type)}</span><small>${escapeHtml(status)}</small></summary><div class="activity-body">${activityBody(event, index)}</div></details>`;
  }).join('');
  return `<section class="activity-timeline"><details class="activity-group" ${streaming ? 'open' : ''}><summary class="activity-heading"><span>${streaming ? 'LIVE ACTIVITY' : 'ACTIVITY'}</span><b>${ordered.length}</b><em>${escapeHtml(summary)}</em></summary><div class="activity-events">${items}</div></details></section>`;
}

function activityBody(event) {
  if (event.type === 'command') return `${event.cwd ? `<small>cwd ${escapeHtml(event.cwd)}</small>` : ''}<pre><code>${escapeHtml(event.command || '')}</code></pre>${event.output ? `<details class="nested-output"><summary>실행 출력${event.exitCode !== undefined && event.exitCode !== null ? ` · exit ${escapeHtml(event.exitCode)}` : ''}</summary><pre>${escapeHtml(event.output)}</pre></details>` : ''}`;
  if (event.type === 'file_change') {
    const changes = event.changes || [];
    const rendered = changes.map(change => `<div class="file-change"><b>${escapeHtml(typeof change.kind === 'object' ? change.kind?.type || 'update' : change.kind || 'update')} · ${escapeHtml(change.path || '')}</b>${change.diff ? `<pre class="diff"><code>${diffHtml(change.diff)}</code></pre>` : ''}</div>`).join('');
    return `${rendered}${event.diff ? `<pre class="diff"><code>${diffHtml(event.diff)}</code></pre>` : ''}`;
  }
  if (event.type === 'subagent') return `${event.model ? `<small>${escapeHtml(event.model)}${event.effort ? ` · ${escapeHtml(event.effort)}` : ''}</small>` : ''}${event.agentThreadId ? `<code class="agent-id">${escapeHtml(event.agentThreadId)}</code>` : ''}${event.prompt ? `<pre>${escapeHtml(event.prompt)}</pre>` : ''}${event.output ? `<pre>${escapeHtml(event.output)}</pre>` : ''}`;
  if (event.type === 'subagent_message' || event.type === 'plan') return `<pre>${escapeHtml(event.content || '')}</pre>`;
  if (event.type === 'reasoning') return event.content
    ? `<pre>${escapeHtml(event.content)}</pre>`
    : '<div class="activity-empty">이 과거 이벤트에는 reasoning summary text가 저장되지 않았습니다.</div>';
  if (event.type === 'steering') return `<pre>${escapeHtml(event.content || '')}</pre>`;
  if (event.type === 'web') return `<pre>${escapeHtml(toJson(event.action || event.results || event.query || ''))}</pre>`;
  if (event.type === 'tool') return `${event.input !== undefined ? `<b>Input</b><pre>${escapeHtml(toJson(event.input))}</pre>` : ''}${event.output ? `<b>Output</b><pre>${escapeHtml(event.output)}</pre>` : ''}`;
  return `<pre>${escapeHtml(toJson(event))}</pre>`;
}

function turnUsageHtml(detail) {
  const context = detail.telemetry?.context;
  const models = Object.entries(detail.usage?.modelUsage || {});
  if (!context && !models.length) return '';
  return `<details class="turn-usage"><summary>TURN USAGE</summary><div>${context?.contextWindow ? `<span>Context ${formatNumber(context.usedTokens)} / ${formatNumber(context.contextWindow)}</span>` : ''}${models.map(([model, usage]) => `<span>${escapeHtml(model)} · in ${formatNumber(usage.inputTokens ?? usage.input_tokens)} · out ${formatNumber(usage.outputTokens ?? usage.output_tokens)}</span>`).join('')}</div></details>`;
}

function messagingDialogHtml(state) {
  return `<dialog id="messaging-dialog" class="messaging-dialog"><header><div><span class="eyebrow">DURABLE INTER-SESSION LAYER</span><h2>Session messaging</h2></div><button id="messaging-close" class="icon-button" type="button">×</button></header><div id="messaging-content" class="messaging-content">${messagingContentHtml(state)}</div><footer>Master queue → Worker wake coordinator → VM bridge → exact Codex/Claude native session</footer></dialog>`;
}

function messagingContentHtml(state = { directory: [], messages: [] }) {
  const sessions = state.directory || [];
  const ownTenant = workspace?.description?.cell?.tenantSlug;
  const sourceSessions = overview.user.role === 'superadmin' ? sessions : sessions.filter(item => item.tenant === ownTenant);
  const options = list => list.map(item => `<option value="${escapeHtml(item.sessionUuid)}">${escapeHtml(item.address)} · ${escapeHtml(item.status)}</option>`).join('');
  return `<section class="messaging-grid"><form id="message-send-form" class="message-compose"><span class="eyebrow">SEND / AUTO-WAKE</span><label>Source<select name="source" required>${options(sourceSessions)}</select></label><label>Target<select name="target" required>${options(sessions)}</select></label><label>Message<textarea name="content" rows="5" maxlength="100000" placeholder="다른 세션에 전달할 내용" required></textarea></label><label class="check-row"><input name="expectReply" type="checkbox" checked> 응답을 source 세션으로 다시 auto-wake</label><button class="primary" type="submit">Durable queue에 전송</button></form>
  <section class="session-directory"><span class="eyebrow">NAMESPACED DIRECTORY</span>${sessions.length ? sessions.map(item => `<article><b>@${escapeHtml(item.alias)}</b><code>${escapeHtml(item.address)}</code><small>${escapeHtml(item.workspace)} · ${escapeHtml(item.status)}</small></article>`).join('') : '<p class="usage-unavailable">알려진 세션이 없습니다.</p>'}</section></section>
  ${overview.user.role === 'superadmin' ? `<form id="channel-create-form" class="channel-create"><span class="eyebrow">CROSS-TENANT GRANT</span><input name="name" placeholder="채널 이름" required><select name="first" required>${options(sessions)}</select><select name="second" required>${options(sessions)}</select><button class="action-button" type="submit">양방향 채널 생성</button></form>` : ''}
  <section class="queue-list"><div class="queue-heading"><span class="eyebrow">MESSAGE QUEUE</span><button id="queue-refresh" class="quiet-button" type="button">새로고침</button></div>${(state.messages || []).length ? state.messages.map(queueMessageHtml).join('') : '<p class="usage-unavailable">큐 이력이 없습니다.</p>'}</section>`;
}

function queueMessageHtml(message) {
  const stateClass = ['acknowledged', 'delivered'].includes(message.status) ? 'ready' : ['failed', 'expired'].includes(message.status) ? 'failed' : 'pending';
  return `<article class="queue-message ${stateClass}"><header><span>${escapeHtml(message.source)} → ${escapeHtml(message.target)}</span><b>${escapeHtml(message.status)}</b></header><p>${escapeHtml(message.content)}</p><small>${new Date(message.createdAt).toLocaleString()} · attempts ${message.attemptCount}${message.lastError ? ` · ${escapeHtml(message.lastError)}` : ''}</small>${message.result?.answer ? `<details><summary>응답</summary><div class="markdown-body">${escapeHtml(message.result.answer)}</div></details>` : ''}</article>`;
}

function wireMessaging() {
  const dialog = document.querySelector('#messaging-dialog');
  if (!dialog) return;
  document.querySelector('#messaging-close').addEventListener('click', () => dialog.close());
  wireMessagingContent();
}

function wireMessagingContent() {
  document.querySelector('#message-send-form')?.addEventListener('submit', sendInterSessionMessage);
  document.querySelector('#channel-create-form')?.addEventListener('submit', createInterSessionChannel);
  document.querySelector('#queue-refresh')?.addEventListener('click', refreshMessaging);
}

async function sendInterSessionMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const data = new FormData(form);
  button.disabled = true;
  try {
    await api('/api/inter-session/messages', { method: 'POST', body: {
      source: data.get('source'), target: data.get('target'), content: data.get('content'),
      expectReply: data.get('expectReply') === 'on', idempotencyKey: cryptoRandomId(),
    } });
    form.elements.content.value = '';
    toast('메시지가 durable queue에 들어갔습니다. 대상이 offline이면 복구 후 전달됩니다.');
    await refreshMessaging();
  } catch (error) { toast(error.message); button.disabled = false; }
}

async function createInterSessionChannel(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  if (data.get('first') === data.get('second')) return toast('서로 다른 두 세션을 선택하세요.');
  try {
    await api('/api/inter-session/channels', { method: 'POST', body: { name: data.get('name'), members: [data.get('first'), data.get('second')] } });
    toast('Cross-tenant 양방향 channel/grant를 생성했습니다.');
    await refreshMessaging();
  } catch (error) { toast(error.message); }
}

async function refreshMessaging() {
  if (!workspace) return;
  try {
    const [directory, queue] = await Promise.all([api('/api/inter-session/directory'), api('/api/inter-session/messages')]);
    workspace.interSession = { directory: directory.sessions, messages: queue.messages };
    const content = document.querySelector('#messaging-content');
    if (content) { content.innerHTML = messagingContentHtml(workspace.interSession); wireMessagingContent(); }
  } catch (error) { toast(`Messaging 갱신 실패: ${error.message}`); }
}

function cryptoRandomId() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`; }

function diffHtml(diff) {
  return escapeHtml(diff).split('\n').map(line => `<span class="${line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : line.startsWith('@@') ? 'hunk' : ''}">${line || ' '}</span>`).join('\n');
}

function toJson(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function recentTokens(buckets, days) { return (buckets || []).slice(-days).reduce((sum, bucket) => sum + Number(bucket.tokens || 0), 0); }
function finitePercent(value) { if (value === null || value === undefined || value === '') return null; const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null; }
function formatPercent(value) { return value === null || value === undefined ? '—' : `${Math.round(Number(value) * 10) / 10}%`; }
function formatNumber(value) { const number = Number(value); return Number.isFinite(number) && number ? new Intl.NumberFormat().format(Math.round(number)) : '0'; }
function formatReset(value) { const numericValue = Number(value); const date = Number.isFinite(numericValue) ? new Date(numericValue > 10_000_000_000 ? numericValue : numericValue * 1000) : new Date(value); return Number.isNaN(date.valueOf()) ? '' : `${date.toLocaleString()} 초기화`; }
function authBadge(name, ok) { return `<span class="auth-badge ${ok ? 'ready' : 'missing'}"><i></i>${escapeHtml(name)} ${ok ? '연결됨' : '로그인 필요'}</span>`; }
function scrollChat() { const node = document.querySelector('#chat-messages'); node.scrollTop = node.scrollHeight; }

async function runAction(event) {
  const button = event.currentTarget;
  const original = button.textContent;
  button.disabled = true; button.textContent = '처리 중…';
  try {
    await api(`/api/cells/${button.dataset.cell}/actions`, { method: 'POST', body: { action: button.dataset.action } });
    toast('작업이 완료되었습니다.'); overview = await api('/api/overview'); renderDashboard(overview);
  } catch (error) { toast(error.message); button.disabled = false; button.textContent = original; }
}

function openTerminal(cellId, name) {
  const isMaster = cellId === 'master-agent';
  terminalEyebrow.textContent = isMaster ? 'SUPERADMIN CONSOLE' : 'TENANT CONSOLE';
  terminalTitle.textContent = isMaster ? 'Master Agent · Control Container' : `${name} · Linux VM`;
  terminalContext.innerHTML = isMaster ? '영속화된 Master Agent 환경입니다. <code>codex</code> 또는 <code>claude</code>로 직접 로그인하세요.' : '로그인은 VM 사용자 홈에 저장되어 모든 작업 폴더와 웹 세션에서 재사용됩니다. <code>codex login</code> / <code>claude auth login</code>';
  terminalNode.innerHTML = '';
  terminal = new window.Terminal({ cursorBlink: true, fontSize: 14, fontFamily: 'SFMono-Regular, Menlo, Consolas, monospace', theme: { background: '#090b0a', foreground: '#f4f1e8', cursor: '#c7ff5e' } });
  fitAddon = new window.FitAddon.FitAddon(); terminal.loadAddon(fitAddon); terminal.open(terminalNode); terminalDialog.showModal(); fitAddon.fit();
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  terminalSocket = new WebSocket(`${protocol}://${location.host}/ws/terminal?cell=${encodeURIComponent(cellId)}`);
  terminalSocket.addEventListener('open', () => { fitAddon.fit(); terminalSocket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })); });
  terminalSocket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.type === 'output') terminal.write(message.data); if (message.type === 'exit') terminal.write(`\r\n[session exited: ${message.code}]\r\n`); });
  terminalSocket.addEventListener('close', event => terminal.write(`\r\n[connection closed: ${event.reason || event.code}]\r\n`));
  terminal.onData(data => { if (terminalSocket.readyState === WebSocket.OPEN) terminalSocket.send(JSON.stringify({ type: 'input', data })); });
  terminal.onResize(({ cols, rows }) => { if (terminalSocket.readyState === WebSocket.OPEN) terminalSocket.send(JSON.stringify({ type: 'resize', cols, rows })); });
}

document.querySelector('#terminal-close').addEventListener('click', closeTerminal);
terminalDialog.addEventListener('close', closeTerminal);
window.addEventListener('resize', () => { if (terminalDialog.open && fitAddon) fitAddon.fit(); });
function closeTerminal() { if (terminalSocket) terminalSocket.close(); if (terminal) terminal.dispose(); terminalSocket = null; terminal = null; if (terminalDialog.open) terminalDialog.close(); }

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function formatGiB(mib) { return `${Math.round((mib / 1024) * 10) / 10} GiB`; }
function formatBytes(bytes) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${Math.round(bytes / 102.4) / 10} KB`; return `${Math.round(bytes / 1024 / 102.4) / 10} MB`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
function toast(message) { toastNode.textContent = message; toastNode.classList.add('show'); setTimeout(() => toastNode.classList.remove('show'), 5200); }
