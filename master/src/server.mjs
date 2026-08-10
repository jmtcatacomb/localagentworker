import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import cookie from 'cookie';
import express from 'express';
import jwt from 'jsonwebtoken';
import { marked } from 'marked';
import pty from 'node-pty';
import pg from 'pg';
import sanitizeHtml from 'sanitize-html';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8080);
const jwtSecret = required('JWT_SECRET');
const workerToken = required('WORKER_TOKEN');
const masterAgentToken = required('MASTER_AGENT_TOKEN');
const portPoolStart = Number(process.env.PORT_POOL_START || 20000);
const portPoolEnd = Number(process.env.PORT_POOL_END || 29999);
const pool = new pg.Pool({ connectionString: required('DATABASE_URL') });
// An idle PostgreSQL socket can be reset while Docker/WSL networking settles.
// Without an error listener node-postgres emits an unhandled EventEmitter
// error and kills the Master even after it has begun listening.
pool.on('error', error => console.error(`postgres idle connection error: ${error.message}`));
const app = express();
const server = http.createServer(app);
const workerWss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });
const sessionWss = new WebSocketServer({ noServer: true });

const workers = new Map();
const pendingCommands = new Map();
const terminalBrowsers = new Map();
const masterTerminals = new Map();
const sessionBrowsers = new Map();
const activeTurns = new Map();
let interSessionDrainActive = false;
let interSessionTimer;
const activeInterSessionDeliveries = new Set();

marked.setOptions({ gfm: true, breaks: true });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve(__dirname, '../public')));
app.use('/vendor/xterm', express.static(path.resolve(__dirname, '../node_modules/@xterm/xterm')));
app.use('/vendor/xterm-fit', express.static(path.resolve(__dirname, '../node_modules/@xterm/addon-fit')));

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, workers: workers.size });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

// Windows runs the native Worker as SYSTEM (for Hyper-V privileges), while
// its WSL Docker distribution belongs to the installing user.  Let that
// Worker request a narrow, capability-authenticated Master-Agent Claude turn
// inside this container instead of attempting to cross the user-owned WSL
// boundary.  This endpoint is deliberately not a general command executor.
app.post('/api/internal/master-agent/claude-turn', requireUser, async (req, res) => {
  if (!req.user.agentCapability) return res.status(403).json({ error: 'Master Agent capability is required.' });
  const prompt = String(req.body?.prompt || '').trim();
  const systemPrompt = String(req.body?.systemPrompt || '').slice(0, 100_000);
  const model = String(req.body?.model || 'haiku').trim();
  const effort = String(req.body?.effort || '').trim();
  const sessionId = String(req.body?.sessionId || '').trim();
  const resume = Boolean(req.body?.resume);
  if (!prompt || prompt.length > 100_000 || !/^[a-z0-9._-]{1,120}$/i.test(model) || !/^[0-9a-f-]{36}$/i.test(sessionId)) return res.status(400).json({ error: 'Invalid master Claude turn.' });
  const credentialPath = path.join(process.env.MASTER_AGENT_HOME || '/master-agent-home', '.agentworks/secrets/claude-oauth-token');
  let oauthToken = '';
  try { oauthToken = (await fs.readFile(credentialPath, 'utf8')).trim(); } catch {}
  if (!oauthToken) return res.status(503).json({ error: 'Master Claude credential is not configured.' });
  // Claude Code refuses --dangerously-skip-permissions under root.  The
  // Master container is root-owned but has no Docker socket or host mount, so
  // retain Claude's normal CLI permission policy here; privileged VM actions
  // still go through audited typed Master APIs.
  const execute = (nativeId, shouldResume) => new Promise(resolve => {
    const args = ['-p', prompt, '--append-system-prompt', systemPrompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model];
    if (effort) args.push('--effort', effort);
    args.push(shouldResume ? '--resume' : '--session-id', nativeId);
    let stdout = ''; let stderr = '';
    const child = spawn('claude', args, { cwd: process.env.MASTER_AGENT_WORKSPACE || '/workspace/agentworks', env: { ...process.env, HOME: process.env.MASTER_AGENT_HOME || '/master-agent-home', CLAUDE_CODE_OAUTH_TOKEN: oauthToken }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.on('error', error => resolve({ code: -1, stdout, stderr: error.message }));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  let nativeSessionId = sessionId;
  let result = await execute(nativeSessionId, resume);
  if (result.code !== 0 && resume && /no conversation found with session id/i.test(result.stderr)) {
    nativeSessionId = crypto.randomUUID();
    result = await execute(nativeSessionId, false);
  }
  if (result.code !== 0) return res.status(502).json({ error: `Master Claude exited ${result.code}: ${result.stderr.trim().slice(-1200)}` });
  let answer = '';
  for (const line of result.stdout.split('\n')) { try { const event = JSON.parse(line); if (event.type === 'result' && typeof event.result === 'string') answer = event.result; } catch {} }
  res.json({ answer, nativeSessionId, telemetry: {}, usage: {} });
});

app.post('/api/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const result = await pool.query('SELECT id, email, password_hash, role FROM users WHERE email=$1', [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }

  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, jwtSecret, { expiresIn: '12h' });
  res.cookie('aw_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });
  await audit(user.id, 'auth.login', 'user', user.id, {});
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', requireUser, async (req, res) => {
  res.clearCookie('aw_session', { path: '/' });
  await audit(req.user.sub, 'auth.logout', 'user', req.user.sub, {});
  res.status(204).end();
});

app.get('/api/overview', requireUser, async (req, res) => {
  const cells = await visibleCells(req.user);
  const workerRows = req.user.role === 'superadmin'
    ? (await pool.query('SELECT id, platform, runtime, status, capabilities, last_seen_at FROM workers ORDER BY id')).rows
    : [];
  res.json({
    user: publicUser(req.user),
    workers: workerRows,
    cells,
    interSession: {
      phase: 'mvp',
      reservedSchema: true,
      deliveryEnabled: true,
      description: 'Namespaced alias, durable queue, VM bridge MCP, offline recovery delivery 활성화',
    },
  });
});

app.post('/api/cells/:cellId/actions', requireUser, async (req, res) => {
  const action = String(req.body?.action || '');
  if (!['ensure', 'start', 'stop', 'install_agents'].includes(action)) {
    return res.status(400).json({ error: '지원하지 않는 작업입니다.' });
  }
  const cell = await authorizedCell(req.user, req.params.cellId);
  if (!cell) return res.status(404).json({ error: '셀을 찾을 수 없습니다.' });
  if (cell.kind === 'master') return res.status(400).json({ error: 'Master Agent cell은 VM lifecycle 작업 대상이 아닙니다.' });
  const worker = workers.get(cell.worker_id);
  if (!worker || worker.readyState !== 1) {
    return res.status(503).json({ error: `Worker ${cell.worker_id}가 연결되어 있지 않습니다.` });
  }

  await audit(req.user.sub, `cell.${action}`, 'cell', cell.id, { runtimeName: cell.runtime_name });
  try {
    const result = await sendCommand(worker, action, cell);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/cells', requireUser, requireSuperadmin, async (_req, res) => {
  const cells = (await pool.query(
    `SELECT c.*,t.slug AS tenant_slug,t.display_name AS tenant_name,w.status AS worker_status
     FROM cells c JOIN tenants t ON t.id=c.tenant_id LEFT JOIN workers w ON w.id=c.worker_id
     ORDER BY c.kind,t.slug`,
  )).rows;
  res.json({ cells: cells.map(publicCell) });
});

app.get('/api/admin/tenants', requireUser, requireSuperadmin, async (_req, res) => {
  const tenants = (await pool.query(
    `SELECT t.id,t.slug,t.display_name,t.created_at,u.id AS owner_id,u.email AS owner_email,c.id AS cell_id,c.runtime_name,c.status,c.worker_id
     FROM tenants t
     LEFT JOIN memberships m ON m.tenant_id=t.id AND m.role='owner'
     LEFT JOIN users u ON u.id=m.user_id
     LEFT JOIN cells c ON c.tenant_id=t.id
     WHERE t.id<>'tenant-system'
     ORDER BY t.created_at,t.slug`,
  )).rows;
  res.json({ tenants: tenants.map(publicTenant) });
});

app.post('/api/admin/tenants', requireUser, requireSuperadmin, async (req, res) => {
  const slug = normalizeTenantSlug(req.body?.slug);
  const displayName = String(req.body?.displayName || '').trim().slice(0, 120);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const desiredVcpus = Number(req.body?.desiredVcpus || 2);
  const desiredMemoryMib = Number(req.body?.desiredMemoryMib || 4096);
  const maxVcpus = Number(req.body?.maxVcpus || 4);
  const maxMemoryMib = Number(req.body?.maxMemoryMib || 16384);
  if (!slug || !displayName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'slug, displayName, email 형식이 올바르지 않습니다.' });
  if (password.length < 12 || password.length > 256) return res.status(400).json({ error: '초기 비밀번호는 12~256자여야 합니다.' });
  if (!Number.isInteger(desiredVcpus) || !Number.isInteger(maxVcpus) || desiredVcpus < 1 || maxVcpus < desiredVcpus || maxVcpus > 64) return res.status(400).json({ error: 'vCPU 정책이 올바르지 않습니다.' });
  if (!Number.isInteger(desiredMemoryMib) || !Number.isInteger(maxMemoryMib) || desiredMemoryMib < 512 || maxMemoryMib < desiredMemoryMib || maxMemoryMib > 1_048_576) return res.status(400).json({ error: '메모리 정책이 올바르지 않습니다.' });

  const ids = { tenant: `tenant-${slug}`, user: `user-${slug}`, cell: `cell-${slug}`, runtime: `aw-${slug}` };
  const workerId = await preferredWorkerId();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT 1 FROM tenants WHERE slug=$1 UNION ALL SELECT 1 FROM users WHERE email=$2 UNION ALL SELECT 1 FROM cells WHERE runtime_name=$3', [slug, email, ids.runtime]);
    if (exists.rowCount) throw statusError(409, '같은 slug, 이메일 또는 runtime 이름이 이미 존재합니다.');
    const hash = await bcrypt.hash(password, 12);
    await client.query('INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,\'tenant\')', [ids.user, email, hash]);
    await client.query('INSERT INTO tenants(id,slug,display_name) VALUES($1,$2,$3)', [ids.tenant, slug, displayName]);
    await client.query('INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,\'owner\')', [ids.user, ids.tenant]);
    await client.query(
      `INSERT INTO cells(id,tenant_id,worker_id,runtime_name,status,desired_vcpus,max_vcpus,desired_memory_mib,max_memory_mib,agents_status)
       VALUES($1,$2,$3,$4,'missing',$5,$6,$7,$8,'pending')`,
      [ids.cell, ids.tenant, workerId, ids.runtime, desiredVcpus, maxVcpus, desiredMemoryMib, maxMemoryMib],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(error.status || (error.code === '23505' ? 409 : 500)).json({ error: error.message || 'Tenant 생성에 실패했습니다.' });
  } finally { client.release(); }

  const cell = await cellById(ids.cell);
  await audit(req.user.sub, 'tenant.create', 'tenant', ids.tenant, {
    slug, displayName, ownerEmail: email, cellId: ids.cell, runtimeName: ids.runtime, workerId,
    desiredVcpus, maxVcpus, desiredMemoryMib, maxMemoryMib,
  });
  const worker = onlineWorker(cell);
  let provisioning = { requested: false, state: 'pending-worker' };
  if (worker) {
    provisioning = { requested: true, state: 'queued' };
    void sendCommand(worker, 'ensure', cell, {}, 35 * 60 * 1000).catch(async error => {
      await pool.query("UPDATE cells SET status='error',last_error=$2,updated_at=now() WHERE id=$1", [cell.id, error.message]).catch(() => {});
      await audit(null, 'tenant.provision.failed', 'tenant', ids.tenant, { cellId: cell.id, error: error.message.slice(0, 2000) }).catch(() => {});
    });
  }
  res.status(201).json({ tenant: publicTenant({ id: ids.tenant, slug, display_name: displayName, owner_id: ids.user, owner_email: email, cell_id: cell.id, runtime_name: cell.runtime_name, status: cell.status, worker_id: workerId }), provisioning });
});

app.patch('/api/admin/cells/:cellId/resources', requireUser, requireSuperadmin, async (req, res) => {
  const cell = await authorizedCell(req.user, req.params.cellId);
  if (!cell || cell.kind !== 'tenant') return res.status(404).json({ error: 'Tenant VM cell을 찾을 수 없습니다.' });
  const desiredVcpus = Number(req.body?.desiredVcpus);
  const desiredMemoryMib = Number(req.body?.desiredMemoryMib);
  if (!Number.isInteger(desiredVcpus) || desiredVcpus < 1 || desiredVcpus > cell.max_vcpus) {
    return res.status(400).json({ error: `vCPU는 1~${cell.max_vcpus} 범위여야 합니다.` });
  }
  if (!Number.isInteger(desiredMemoryMib) || desiredMemoryMib < 512 || desiredMemoryMib > cell.max_memory_mib) {
    return res.status(400).json({ error: `메모리는 512~${cell.max_memory_mib} MiB 범위여야 합니다.` });
  }
  const worker = onlineWorker(cell);
  if (!worker) return res.status(503).json({ error: `Worker ${cell.worker_id}가 연결되어 있지 않습니다.` });
  await audit(req.user.sub, 'cell.resources.update', 'cell', cell.id, {
    previous: { vcpus: cell.desired_vcpus, memoryMib: cell.desired_memory_mib },
    next: { vcpus: desiredVcpus, memoryMib: desiredMemoryMib }, restartRequired: true,
  });
  try {
    const result = await sendCommand(worker, 'resource.apply', cell, { desiredVcpus, desiredMemoryMib }, 20 * 60 * 1000);
    await pool.query('UPDATE cells SET desired_vcpus=$2,desired_memory_mib=$3,status=$4,last_error=NULL,updated_at=now() WHERE id=$1', [cell.id, desiredVcpus, desiredMemoryMib, result.status || cell.status]);
    res.json({ ok: true, result });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/admin/cells/:cellId/exec', requireUser, requireSuperadmin, async (req, res) => {
  const cell = await authorizedCell(req.user, req.params.cellId);
  if (!cell || cell.kind !== 'tenant') return res.status(404).json({ error: 'Tenant VM cell을 찾을 수 없습니다.' });
  const command = String(req.body?.command || '').trim();
  const cwd = String(req.body?.cwd || '').trim() || null;
  const timeoutSeconds = Math.min(600, Math.max(1, Number(req.body?.timeoutSeconds || 120)));
  const asRoot = Boolean(req.body?.asRoot);
  if (!command || command.length > 20_000) return res.status(400).json({ error: '1~20,000자의 VM 명령이 필요합니다.' });
  if (cwd && (!path.posix.isAbsolute(cwd) || cwd.length > 2000)) return res.status(400).json({ error: 'cwd는 VM 내부 절대 경로여야 합니다.' });
  if (!Number.isFinite(timeoutSeconds)) return res.status(400).json({ error: 'timeoutSeconds가 올바르지 않습니다.' });
  const worker = onlineWorker(cell);
  if (!worker) return res.status(503).json({ error: `Worker ${cell.worker_id}가 연결되어 있지 않습니다.` });
  const commandSha256 = crypto.createHash('sha256').update(command).digest('hex');
  await audit(req.user.sub, 'vm.exec.requested', 'cell', cell.id, { commandSha256, commandLength: command.length, cwd, timeoutSeconds, asRoot });
  try {
    const result = await sendCommand(worker, 'vm.exec', cell, { command, cwd, timeoutSeconds, asRoot }, (timeoutSeconds + 30) * 1000);
    await audit(req.user.sub, 'vm.exec.completed', 'cell', cell.id, {
      commandSha256, exitCode: result.exitCode, durationMs: result.durationMs,
      stdoutBytes: Buffer.byteLength(result.stdout || ''), stderrBytes: Buffer.byteLength(result.stderr || ''),
    });
    res.json({ ok: result.exitCode === 0, result });
  } catch (error) {
    await audit(req.user.sub, 'vm.exec.failed', 'cell', cell.id, { commandSha256, error: error.message.slice(0, 2000) });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/cells/:cellId/diagnostics', requireUser, requireSuperadmin, async (req, res) => {
  const cell = await authorizedCell(req.user, req.params.cellId);
  if (!cell || cell.kind !== 'tenant') return res.status(404).json({ error: 'Tenant VM cell을 찾을 수 없습니다.' });
  const worker = onlineWorker(cell);
  if (!worker) return res.status(503).json({ error: `Worker ${cell.worker_id}가 연결되어 있지 않습니다.` });
  await audit(req.user.sub, 'vm.diagnostics', 'cell', cell.id, {});
  try { res.json({ diagnostics: await sendCommand(worker, 'vm.diagnostics', cell, {}, 180_000) }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/admin/cells/:cellId/repair-bridge', requireUser, requireSuperadmin, async (req, res) => {
  const cell = await authorizedCell(req.user, req.params.cellId);
  if (!cell || cell.kind !== 'tenant') return res.status(404).json({ error: 'Tenant VM cell을 찾을 수 없습니다.' });
  const worker = onlineWorker(cell);
  if (!worker) return res.status(503).json({ error: `Worker ${cell.worker_id}가 연결되어 있지 않습니다.` });
  await audit(req.user.sub, 'vm.bridge.repair', 'cell', cell.id, {});
  try {
    const result = await sendCommand(worker, 'bridge.repair', cell, {}, 5 * 60 * 1000);
    void syncBridgeDirectories(cell.worker_id);
    res.json({ ok: true, result });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/ports', requireUser, requireSuperadmin, async (_req, res) => {
  res.json({ routes: await listPortRoutes() });
});

app.post('/api/admin/ports', requireUser, requireSuperadmin, async (req, res) => {
  const cell = await authorizedCell(req.user, String(req.body?.cellId || ''));
  if (!cell || cell.kind !== 'tenant') return res.status(404).json({ error: 'Tenant VM cell을 찾을 수 없습니다.' });
  const guestPort = validPort(req.body?.guestPort);
  const bindAddress = String(req.body?.bindAddress || '127.0.0.1');
  if (!guestPort || !['127.0.0.1', '0.0.0.0'].includes(bindAddress)) return res.status(400).json({ error: 'guestPort/bindAddress가 올바르지 않습니다.' });
  const hostPort = req.body?.hostPort ? validPort(req.body.hostPort) : await allocateHostPort(bindAddress);
  if (!hostPort || hostPort < portPoolStart || hostPort > portPoolEnd) return res.status(400).json({ error: `hostPort는 ${portPoolStart}~${portPoolEnd} 범위여야 합니다.` });
  const worker = onlineWorker(cell);
  if (!worker) return res.status(503).json({ error: `Worker ${cell.worker_id}가 연결되어 있지 않습니다.` });
  const route = { id: crypto.randomUUID(), cell_id: cell.id, runtime_name: cell.runtime_name, guest_port: guestPort, host_port: hostPort, bind_address: bindAddress, protocol: 'tcp' };
  try {
    await pool.query(
      `INSERT INTO port_routes(id,cell_id,requested_by,guest_port,host_port,bind_address,status) VALUES($1,$2,$3,$4,$5,$6,'requested')`,
      [route.id, cell.id, req.user.sub, guestPort, hostPort, bindAddress],
    );
    const result = await sendCommand(worker, 'port.apply', cell, { route }, 60_000);
    await pool.query("UPDATE port_routes SET status='active',last_error=NULL,updated_at=now() WHERE id=$1", [route.id]);
    await audit(req.user.sub, 'port.open', 'port_route', route.id, { cellId: cell.id, guestPort, hostPort, bindAddress });
    res.status(201).json({ route: { ...route, status: 'active' }, result });
  } catch (error) {
    await pool.query("UPDATE port_routes SET status='error',last_error=$2,updated_at=now() WHERE id=$1", [route.id, error.message]).catch(() => {});
    res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? '이미 사용 중인 host port입니다.' : error.message });
  }
});

app.delete('/api/admin/ports/:routeId', requireUser, requireSuperadmin, async (req, res) => {
  const route = (await pool.query(
    `SELECT p.*,c.runtime_name,c.worker_id FROM port_routes p JOIN cells c ON c.id=p.cell_id WHERE p.id=$1`,
    [req.params.routeId],
  )).rows[0];
  if (!route) return res.status(404).json({ error: '포트 route를 찾을 수 없습니다.' });
  const worker = onlineWorker(route);
  if (worker) await sendCommand(worker, 'port.revoke', route, { route }, 60_000).catch(() => {});
  await pool.query("UPDATE port_routes SET status='revoked',updated_at=now() WHERE id=$1", [route.id]);
  await audit(req.user.sub, 'port.revoke', 'port_route', route.id, { cellId: route.cell_id, hostPort: route.host_port });
  res.json({ ok: true });
});

app.get('/api/cells/:cellId/workspace', requireUser, async (req, res) => {
  const cell = await authorizedCell(req.user, req.params.cellId);
  if (!cell) return res.status(404).json({ error: '셀을 찾을 수 없습니다.' });
  const worker = onlineWorker(cell);
  if (!worker) return res.status(503).json({ error: `Worker ${cell.worker_id}가 연결되어 있지 않습니다.` });
  try {
    const description = await sendCommand(worker, 'workspace.describe', cell, {}, 60_000);
    res.json({ cell: publicCell(cell), ...description });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/cells/:cellId/files', requireUser, async (req, res) => {
  const cell = await authorizedCell(req.user, req.params.cellId);
  if (!cell) return res.status(404).json({ error: '셀을 찾을 수 없습니다.' });
  const worker = onlineWorker(cell);
  if (!worker) return res.status(503).json({ error: `Worker ${cell.worker_id}가 연결되어 있지 않습니다.` });
  try {
    res.json(await sendCommand(worker, 'fs.list', cell, { path: String(req.query.path || '') }, 60_000));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/cells/:cellId/usage', requireUser, async (req, res) => {
  const cell = await authorizedCell(req.user, req.params.cellId);
  if (!cell) return res.status(404).json({ error: '셀을 찾을 수 없습니다.' });
  const worker = onlineWorker(cell);
  if (!worker) return res.status(503).json({ error: `Worker ${cell.worker_id}가 연결되어 있지 않습니다.` });
  try {
    const live = await sendCommand(worker, 'usage.describe', cell, {}, 60_000);
    if (live.codex) await saveUsageSnapshot(cell, 'codex', live.codex);
    res.json(await usageOverview(cell, live));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/cells/:cellId/sessions', requireUser, async (req, res) => {
  const cell = await authorizedCell(req.user, req.params.cellId);
  if (!cell) return res.status(404).json({ error: '셀을 찾을 수 없습니다.' });
  const result = await pool.query(
    `SELECT s.session_uuid,s.title,s.alias,s.harness,s.native_session_id,s.status,s.cwd,s.model,s.effort,s.telemetry,s.goal,s.archived_at,s.last_seen_at,s.created_at,s.updated_at,
            t.slug AS tenant_slug,t.display_name AS tenant_name
     FROM agent_sessions s JOIN tenants t ON t.id=s.tenant_id WHERE s.cell_id=$1 AND s.archived_at IS NULL ORDER BY s.updated_at DESC`, [cell.id],
  );
  res.json({ sessions: result.rows.map(publicSession) });
});

app.post('/api/cells/:cellId/sessions', requireUser, async (req, res) => {
  const cell = await authorizedCell(req.user, req.params.cellId);
  if (!cell) return res.status(404).json({ error: '셀을 찾을 수 없습니다.' });
  const harness = String(req.body?.harness || '');
  const title = String(req.body?.title || '').trim().slice(0, 120);
  const alias = normalizeAlias(req.body?.alias || title);
  const cwd = String(req.body?.cwd || '').trim();
  const model = String(req.body?.model || '').trim().slice(0, 120);
  const effort = String(req.body?.effort || '').trim().slice(0, 30) || null;
  if (!['codex', 'claude'].includes(harness)) return res.status(400).json({ error: 'Codex 또는 Claude를 선택하세요.' });
  if (!title || !alias || !cwd || !model || !path.posix.isAbsolute(cwd)) return res.status(400).json({ error: '세션 이름/alias, 절대 작업 경로, 모델이 필요합니다.' });
  const worker = onlineWorker(cell);
  if (!worker) return res.status(503).json({ error: `Worker ${cell.worker_id}가 연결되어 있지 않습니다.` });
  try { await sendCommand(worker, 'fs.list', cell, { path: cwd }, 60_000); }
  catch (error) { return res.status(400).json({ error: `작업 폴더를 열 수 없습니다: ${error.message}` }); }
  const sessionUuid = crypto.randomUUID();
  let result;
  try {
    result = await pool.query(
      `INSERT INTO agent_sessions (session_uuid,tenant_id,cell_id,harness,status,wake_capability,title,alias,cwd,model,effort,created_by,last_seen_at)
       VALUES ($1,$2,$3,$4,'ready',true,$5,$6,$7,$8,$9,$10,now())
       RETURNING session_uuid,title,alias,harness,native_session_id,status,cwd,model,effort,telemetry,goal,archived_at,last_seen_at,created_at,updated_at`,
      [sessionUuid, cell.tenant_id, cell.id, harness, title, alias, cwd, model, effort, req.user.sub],
    );
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: '같은 tenant/model/workspace namespace에 이미 존재하는 alias입니다.' });
    throw error;
  }
  await audit(req.user.sub, 'session.create', 'agent_session', sessionUuid, { cellId: cell.id, harness, cwd, model, alias });
  const created = publicSession({ ...result.rows[0], tenant_slug: cell.tenant_slug, tenant_name: cell.tenant_name });
  res.status(201).json({ session: created });
  void syncBridgeDirectories();
});

app.get('/api/sessions/:sessionUuid/messages', requireUser, async (req, res) => {
  const session = await authorizedSession(req.user, req.params.sessionUuid);
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  const messages = (await pool.query(
    'SELECT id,role,content,detail,created_at FROM chat_messages WHERE session_uuid=$1 ORDER BY created_at,id',
    [session.session_uuid],
  )).rows.map(publicChatMessage);
  res.json({ session: publicSession(session), messages });
});

app.patch('/api/sessions/:sessionUuid', requireUser, async (req, res) => {
  const session = await authorizedSession(req.user, req.params.sessionUuid);
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  const model = String(req.body?.model || '').trim().slice(0, 120);
  const effort = String(req.body?.effort || '').trim().slice(0, 30) || null;
  const alias = normalizeAlias(req.body?.alias || session.alias);
  if (!model) return res.status(400).json({ error: '모델을 선택하세요.' });
  const worker = onlineWorker(session);
  if (!worker) return res.status(503).json({ error: `Worker ${session.worker_id}가 연결되어 있지 않습니다.` });
  try {
    const description = await sendCommand(worker, 'workspace.describe', session, {}, 60_000);
    const available = description.models?.[session.harness] || [];
    const selected = available.find(item => item.id === model);
    if (!selected && model !== session.model) return res.status(400).json({ error: `${session.harness}에서 사용할 수 없는 모델입니다.` });
    if (effort && selected?.efforts?.length && !selected.efforts.includes(effort)) {
      return res.status(400).json({ error: `${model}에서 지원하지 않는 reasoning/effort입니다.` });
    }
    const result = await pool.query(
      `UPDATE agent_sessions SET model=$2,effort=$3,alias=$4,title=$4,updated_at=now() WHERE session_uuid=$1
       RETURNING session_uuid,title,alias,harness,native_session_id,status,cwd,model,effort,telemetry,goal,archived_at,last_seen_at,created_at,updated_at`,
      [session.session_uuid, model, effort, alias],
    );
    await audit(req.user.sub, 'session.settings.update', 'agent_session', session.session_uuid, {
      harness: session.harness, previousModel: session.model, model, previousEffort: session.effort, effort,
      appliesTo: 'next_turn',
    });
    res.json({ session: publicSession({ ...result.rows[0], tenant_slug: session.tenant_slug, tenant_name: session.tenant_name }), appliesTo: 'next_turn', providerLocked: true });
    void syncBridgeDirectories();
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: '변경할 namespace에 같은 alias가 이미 존재합니다.' });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions/:sessionUuid/messages', requireUser, async (req, res) => {
  const prompt = String(req.body?.content || '').trim();
  if (!prompt || prompt.length > 100_000) return res.status(400).json({ error: '1~100,000자의 메시지가 필요합니다.' });
  const session = await authorizedSession(req.user, req.params.sessionUuid);
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  const worker = onlineWorker(session);
  if (!worker) return res.status(503).json({ error: `Worker ${session.worker_id}가 연결되어 있지 않습니다.` });
  try {
    const accepted = await beginSessionTurn(session, prompt, req.user.sub);
    res.status(202).json(accepted);
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.post('/api/sessions/:sessionUuid/steer', requireUser, async (req, res) => {
  const content = String(req.body?.content || '').trim();
  if (!content || content.length > 100_000) return res.status(400).json({ error: 'steering 메시지가 필요합니다.' });
  const session = await authorizedSession(req.user, req.params.sessionUuid);
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  const turn = activeTurns.get(session.session_uuid);
  if (!turn) return res.status(409).json({ error: '진행 중인 turn이 없습니다.' });
  try {
    await queueTurnEvent(turn, { type: 'activity.upsert', event: { id: `steer:${crypto.randomUUID()}`, type: 'steering', title: 'Steering', content, status: 'accepted', sequence: turn.nextSequence++ } });
    if (session.harness === 'claude') turn.followup = { content, actor: req.user.sub };
    const result = await sendCommand(onlineWorker(session), 'session.control', session, { sessionUuid: session.session_uuid, kind: 'steer', content }, 60_000);
    await audit(req.user.sub, 'session.steer', 'agent_session', session.session_uuid, { contentLength: content.length, mode: result.mode });
    res.json({ ok: true, mode: result.mode || 'native' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/sessions/:sessionUuid/stop', requireUser, async (req, res) => {
  const session = await authorizedSession(req.user, req.params.sessionUuid);
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  if (!activeTurns.has(session.session_uuid)) return res.status(409).json({ error: '진행 중인 turn이 없습니다.' });
  try {
    const result = await sendCommand(onlineWorker(session), 'session.control', session, { sessionUuid: session.session_uuid, kind: 'stop' }, 60_000);
    await audit(req.user.sub, 'session.stop', 'agent_session', session.session_uuid, {});
    res.json({ ok: true, result });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/sessions/:sessionUuid/goal', requireUser, async (req, res) => {
  const session = await authorizedSession(req.user, req.params.sessionUuid);
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  const objective = String(req.body?.objective || '').trim().slice(0, 20_000);
  const goal = objective ? { objective, status: 'active', tokenBudget: req.body?.tokenBudget || null, updatedAt: new Date().toISOString() } : {};
  await pool.query('UPDATE agent_sessions SET goal=$2,updated_at=now() WHERE session_uuid=$1', [session.session_uuid, goal]);
  if (session.native_session_id && session.harness === 'codex' && onlineWorker(session)) {
    await sendCommand(onlineWorker(session), 'session.goal', session, { nativeSessionId: session.native_session_id, goal }, 60_000).catch(() => {});
  }
  await audit(req.user.sub, 'session.goal', 'agent_session', session.session_uuid, { objectiveLength: objective.length });
  res.json({ goal });
});

app.post('/api/sessions/:sessionUuid/archive', requireUser, async (req, res) => {
  const session = await authorizedSession(req.user, req.params.sessionUuid);
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  if (session.status === 'busy' || activeTurns.has(session.session_uuid)) return res.status(409).json({ error: '진행 중인 세션은 먼저 중단하세요.' });
  if (session.native_session_id && session.harness === 'codex' && onlineWorker(session)) {
    await sendCommand(onlineWorker(session), 'session.archive', session, { nativeSessionId: session.native_session_id }, 60_000).catch(() => {});
  }
  await pool.query("UPDATE agent_sessions SET archived_at=now(),status='archived',updated_at=now() WHERE session_uuid=$1", [session.session_uuid]);
  await audit(req.user.sub, 'session.archive', 'agent_session', session.session_uuid, {});
  res.status(204).end();
});

app.get('/api/inter-session/status', requireUser, async (req, res) => {
  const sessions = await knownSessions(req.user);
  const counts = await visibleMessageCounts(req.user);
  res.json({ enabled: true, phase: 'mvp', knownSessions: sessions.length, queue: counts, bridge: 'vm-mcp-outbox' });
});

app.get('/api/inter-session/directory', requireUser, async (req, res) => {
  res.json({ sessions: (await knownSessions(req.user)).map(publicDirectorySession) });
});

app.get('/api/inter-session/messages', requireUser, async (req, res) => {
  const rows = await visibleSessionMessages(req.user, 100);
  res.json({ messages: rows.map(publicSessionMessage) });
});

app.post('/api/inter-session/messages', requireUser, async (req, res) => {
  try {
    const source = req.body?.source ? await resolveSessionTarget(String(req.body.source)) : null;
    const target = await resolveSessionTarget(String(req.body?.target || ''));
    const content = String(req.body?.content || '').trim();
    if (!target || !content || content.length > 100_000) return res.status(400).json({ error: '유효한 target과 1~100,000자 메시지가 필요합니다.' });
    if (req.user.role !== 'superadmin' && !source) return res.status(400).json({ error: 'Tenant 발신에는 source 세션이 필요합니다.' });
    if (source && !(await canActAsSession(req.user, source))) return res.status(403).json({ error: 'source 세션 권한이 없습니다.' });
    const channelId = await authorizeInterSessionPair(req.user, source, target, req.body?.channelId || null);
    const message = await enqueueSessionMessage({
      source, target, content, channelId, expectReply: req.body?.expectReply !== false,
      idempotencyKey: String(req.body?.idempotencyKey || crypto.randomUUID()), createdBy: req.user.sub,
      replyTo: req.body?.replyTo || null,
    });
    await audit(req.user.sub, 'inter_session.send', 'session_message', message.id, {
      source: source?.session_uuid || null, target: target.session_uuid, channelId,
    });
    res.status(message.created ? 202 : 200).json({ message: publicSessionMessage(message) });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post('/api/inter-session/channels', requireUser, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  const members = [...new Set((req.body?.members || []).map(String))];
  if (!name || members.length < 2 || members.length > 50) return res.status(400).json({ error: '채널 이름과 2~50개 member 세션이 필요합니다.' });
  const sessions = [];
  for (const target of members) {
    const session = await resolveSessionTarget(target);
    if (!session) return res.status(400).json({ error: `세션을 찾을 수 없습니다: ${target}` });
    sessions.push(session);
  }
  const crossTenant = new Set(sessions.map(item => item.tenant_id)).size > 1;
  if (crossTenant && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Cross-tenant 채널은 superadmin만 생성할 수 있습니다.' });
  if (req.user.role !== 'superadmin' && !(await Promise.all(sessions.map(item => canActAsSession(req.user, item)))).every(Boolean)) {
    return res.status(403).json({ error: '소유하지 않은 세션을 채널에 추가할 수 없습니다.' });
  }
  const channelId = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO session_channels (id,name,created_by) VALUES ($1,$2,$3)', [channelId, name, req.user.sub]);
    for (const session of sessions) await client.query('INSERT INTO session_channel_members (channel_id,session_uuid) VALUES ($1,$2)', [channelId, session.session_uuid]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  await audit(req.user.sub, 'inter_session.channel.create', 'session_channel', channelId, { name, members, crossTenant });
  void syncBridgeDirectories();
  res.status(201).json({ channel: { id: channelId, name, members: sessions.map(publicDirectorySession), active: true } });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/ws/worker') {
    const supplied = bearerToken(req) || url.searchParams.get('token') || '';
    if (!safeEqual(supplied, workerToken)) return rejectUpgrade(socket, 401);
    return workerWss.handleUpgrade(req, socket, head, ws => workerWss.emit('connection', ws, req));
  }
  if (url.pathname === '/ws/terminal') {
    const user = websocketUser(req);
    if (!user) return rejectUpgrade(socket, 401);
    req.awUser = user;
    req.awCellId = url.searchParams.get('cell') || '';
    return terminalWss.handleUpgrade(req, socket, head, ws => terminalWss.emit('connection', ws, req));
  }
  if (url.pathname === '/ws/session') {
    const user = websocketUser(req);
    if (!user) return rejectUpgrade(socket, 401);
    req.awUser = user;
    req.awSessionId = url.searchParams.get('session') || '';
    return sessionWss.handleUpgrade(req, socket, head, ws => sessionWss.emit('connection', ws, req));
  }
  rejectUpgrade(socket, 404);
});

sessionWss.on('connection', async (browser, req) => {
  const session = await authorizedSession(req.awUser, req.awSessionId);
  if (!session) return browser.close(4404, 'Session not found');
  const key = String(session.session_uuid);
  if (!sessionBrowsers.has(key)) sessionBrowsers.set(key, new Set());
  sessionBrowsers.get(key).add(browser);
  browser.send(JSON.stringify({ type: 'session.connected', sessionStatus: session.status }));
  browser.on('close', () => {
    const browsers = sessionBrowsers.get(key);
    browsers?.delete(browser);
    if (!browsers?.size) sessionBrowsers.delete(key);
  });
});

workerWss.on('connection', ws => {
  let workerId = null;
  ws.on('message', async raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'register') {
        workerId = String(message.workerId);
        workers.set(workerId, ws);
        ws.workerId = workerId;
        await pool.query(
          `INSERT INTO workers (id, platform, runtime, status, capabilities, last_seen_at)
           VALUES ($1,$2,$3,'online',$4,now())
           ON CONFLICT (id) DO UPDATE SET platform=$2,runtime=$3,status='online',capabilities=$4,last_seen_at=now()`,
          [workerId, message.platform, message.runtime, message.capabilities || {}],
        );
        await applyCellStatuses(message.cells || [], workerId);
        // The system Master cell is seeded before a concrete host Worker has
        // registered, so legacy installs carry the historical `mac-local`
        // placeholder.  Bind that orphaned cell to the registering local host
        // (or recover it when its former Worker is offline).  Tenant cells stay
        // untouched: they are explicitly scheduled when created.
        await pool.query(
          `UPDATE cells master SET worker_id=$1,updated_at=now()
           WHERE master.kind='master' AND (
             master.worker_id='mac-local' OR NOT EXISTS (
               SELECT 1 FROM workers current WHERE current.id=master.worker_id AND current.status='online'
             )
           )`,
          [workerId],
        );
        ws.send(JSON.stringify({ type: 'registered', workerId }));
        void syncBridgeDirectories(workerId);
        void restorePortRoutes(workerId);
        return;
      }

      if (message.type === 'heartbeat' && workerId) {
        await pool.query("UPDATE workers SET status='online', last_seen_at=now(), capabilities=$2 WHERE id=$1", [workerId, message.capabilities || {}]);
        await applyCellStatuses(message.cells || [], workerId);
        return;
      }

      if (message.type === 'cell.progress') {
        await pool.query(
          'UPDATE cells SET status=$2, agents_status=COALESCE($3,agents_status), last_error=$4, updated_at=now() WHERE runtime_name=$1',
          [message.runtimeName, message.status, message.agentsStatus || null, message.error || null],
        );
        return;
      }

      if (message.type === 'bridge.outbox' && workerId) {
        try {
          const queued = await ingestBridgeOutbox(workerId, message.runtimeName, message.payload || {});
          ws.send(JSON.stringify({
            type: 'bridge.outbox.ack', runtimeName: message.runtimeName,
            outboxId: message.payload?.outboxId, messageId: queued.id,
          }));
        } catch (error) {
          console.error('bridge outbox rejected', error.message);
        }
        return;
      }

      if (message.type === 'agentslack.delivery' && workerId) {
        await ingestAgentSlackDelivery(ws, workerId, message);
        return;
      }

      if (message.type === 'agentslack.delivery.ack.result' && workerId) {
        await pool.query(
          `UPDATE agentslack_delivery_links SET status=CASE WHEN $4 THEN 'acknowledged' ELSE 'ack_failed' END,
             acknowledged_at=CASE WHEN $4 THEN now() ELSE acknowledged_at END,
             last_error=CASE WHEN $4 THEN NULL ELSE $5 END
           WHERE worker_id=$1 AND binding_id=$2 AND delivery_id=$3`,
          [workerId, String(message.bindingId || ''), Number(message.externalDeliveryId || 0), Boolean(message.ok), String(message.error || '').slice(0, 4000)],
        );
        return;
      }

      if (message.type === 'command.result') {
        const pending = pendingCommands.get(message.requestId);
        if (!pending) return;
        pendingCommands.delete(message.requestId);
        clearTimeout(pending.timeout);
        if (message.ok) pending.resolve(message.data || {});
        else pending.reject(new Error(message.error || 'Worker 명령 실패'));
        return;
      }

      if (message.type === 'command.event') {
        const pending = pendingCommands.get(message.requestId);
        if (pending?.onEvent) void Promise.resolve(pending.onEvent(message.event || {})).catch(error => console.error('turn event:', error.message));
        return;
      }

      if (message.type === 'terminal.output') {
        const browser = terminalBrowsers.get(message.streamId);
        if (browser?.readyState === 1) browser.send(JSON.stringify({ type: 'output', data: message.data }));
        return;
      }

      if (message.type === 'terminal.exit') {
        const browser = terminalBrowsers.get(message.streamId);
        if (browser?.readyState === 1) browser.send(JSON.stringify({ type: 'exit', code: message.code }));
        terminalBrowsers.delete(message.streamId);
      }
    } catch (error) {
      console.error('worker message error', error);
    }
  });

  ws.on('close', async () => {
    if (!workerId) return;
    if (workers.get(workerId) === ws) workers.delete(workerId);
    await pool.query("UPDATE workers SET status='offline' WHERE id=$1", [workerId]).catch(() => {});
  });
});

terminalWss.on('connection', async (browser, req) => {
  if (req.awCellId === 'master-agent') {
    if (req.awUser.role !== 'superadmin') return browser.close(4403, 'Superadmin only');
    return openMasterTerminal(browser, req.awUser);
  }
  const cell = await authorizedCell(req.awUser, req.awCellId);
  if (!cell) return browser.close(4404, 'Cell not found');
  const worker = workers.get(cell.worker_id);
  if (!worker || worker.readyState !== 1) return browser.close(4503, 'Worker offline');

  const streamId = crypto.randomUUID();
  terminalBrowsers.set(streamId, browser);
  worker.send(JSON.stringify({ type: 'terminal.open', streamId, cell }));
  await audit(req.awUser.sub, 'terminal.open', 'cell', cell.id, { streamId });

  browser.on('message', raw => {
    if (worker.readyState !== 1) return;
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'input') worker.send(JSON.stringify({ type: 'terminal.input', streamId, data: message.data }));
      if (message.type === 'resize') worker.send(JSON.stringify({ type: 'terminal.resize', streamId, cols: message.cols, rows: message.rows }));
    } catch {}
  });
  browser.on('close', () => {
    terminalBrowsers.delete(streamId);
    if (worker.readyState === 1) worker.send(JSON.stringify({ type: 'terminal.close', streamId }));
  });
});

async function openMasterTerminal(browser, user) {
  const streamId = crypto.randomUUID();
  const home = process.env.MASTER_AGENT_HOME || '/master-agent-home';
  const workspace = process.env.MASTER_AGENT_WORKSPACE || '/workspace/agentworks';
  const env = {
    ...process.env,
    HOME: home,
    USER: 'master-agent',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    PATH: `${home}/.local/bin:${process.env.PATH || ''}`,
    AGENTWORKS_ROLE: 'superadmin-agent',
    AGENTWORKS_MASTER_URL: `http://127.0.0.1:${port}`,
    AGENTWORKS_MASTER_TOKEN: masterAgentToken,
  };
  const terminal = pty.spawn('/bin/bash', ['--login'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: workspace, env });
  masterTerminals.set(streamId, terminal);
  terminal.onData(data => {
    if (browser.readyState === 1) browser.send(JSON.stringify({ type: 'output', data }));
  });
  terminal.onExit(({ exitCode }) => {
    masterTerminals.delete(streamId);
    if (browser.readyState === 1) browser.send(JSON.stringify({ type: 'exit', code: exitCode }));
  });
  browser.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'input') terminal.write(message.data);
      if (message.type === 'resize') terminal.resize(Math.max(20, message.cols || 80), Math.max(5, message.rows || 24));
    } catch {}
  });
  browser.on('close', () => {
    masterTerminals.delete(streamId);
    terminal.kill();
  });
  terminal.write("printf '\\033[1;32mAgentworks Master Agent\\033[0m\\nRun \\033[1mcodex\\033[0m or \\033[1mclaude\\033[0m to authenticate.\\nSystem instruction: docs/MASTER_AGENT.md\\n\\n'\r");
  await audit(user.sub, 'terminal.open', 'master-agent', 'master-agent', { streamId });
}

async function initialize() {
  const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  // Docker Compose's health gate prevents normal PostgreSQL races, but a
  // fresh Windows WSL2 Docker network can briefly return EAI_AGAIN while its
  // embedded DNS endpoint attaches. Retrying keeps Master available instead
  // of entering a restart loop during that bounded network convergence.
  let lastError;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try { await pool.query(schema); lastError = null; break; }
    catch (error) {
      lastError = error;
      if (!['EAI_AGAIN', 'ECONNREFUSED', 'ENOTFOUND'].includes(error.code) || attempt === 30) throw error;
      console.warn(`database unavailable during startup (${error.code}); retry ${attempt}/30`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  if (lastError) throw lastError;
  await seed();
  await pool.query("UPDATE session_messages SET status='queued',lease_owner=NULL,lease_expires_at=NULL WHERE status='waking' AND (lease_expires_at IS NULL OR lease_expires_at<now())");
  server.listen(port, '0.0.0.0', () => console.log(`Agentworks master listening on :${port}`));
  clearInterval(interSessionTimer);
  interSessionTimer = setInterval(() => drainInterSessionQueue().catch(error => console.error('inter-session drain:', error)), 1500);
  interSessionTimer.unref?.();
}

async function seed() {
  const definitions = [
    { id: 'user-master', email: required('MASTER_EMAIL'), password: required('MASTER_PASSWORD'), role: 'superadmin' },
    { id: 'user-alpha', email: required('TENANT_ALPHA_EMAIL'), password: required('TENANT_ALPHA_PASSWORD'), role: 'tenant' },
    { id: 'user-beta', email: required('TENANT_BETA_EMAIL'), password: required('TENANT_BETA_PASSWORD'), role: 'tenant' },
  ];
  for (const user of definitions) {
    const hash = await bcrypt.hash(user.password, 12);
    await pool.query(
      `INSERT INTO users (id,email,password_hash,role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET email=$2,password_hash=$3,role=$4`,
      [user.id, user.email.toLowerCase(), hash, user.role],
    );
  }
  for (const tenant of [
    { id: 'tenant-system', slug: 'system', name: 'Master Control Plane', user: 'user-master', cell: 'cell-master', runtime: 'master-agent', kind: 'master' },
    { id: 'tenant-alpha', slug: 'alpha', name: 'Tenant Alpha', user: 'user-alpha', cell: 'cell-alpha', runtime: 'aw-a1' },
    { id: 'tenant-beta', slug: 'beta', name: 'Tenant Beta', user: 'user-beta', cell: 'cell-beta', runtime: 'aw-b1' },
  ]) {
    await pool.query('INSERT INTO tenants (id,slug,display_name) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET display_name=$3', [tenant.id, tenant.slug, tenant.name]);
    await pool.query('INSERT INTO memberships (user_id,tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [tenant.user, tenant.id]);
    await pool.query(
      `INSERT INTO cells (id,tenant_id,runtime_name,kind,status,agents_status) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET tenant_id=$2,runtime_name=$3,kind=$4,status=$5,agents_status=$6`,
      [tenant.cell, tenant.id, tenant.runtime, tenant.kind || 'tenant', tenant.kind === 'master' ? 'running' : 'missing', tenant.kind === 'master' ? 'ready' : 'pending'],
    );
  }
}

async function visibleCells(user) {
  const params = [];
  let where = "WHERE c.kind='tenant'";
  if (user.role !== 'superadmin') {
    params.push(user.sub || user.id);
    where += ' AND c.tenant_id IN (SELECT tenant_id FROM memberships WHERE user_id=$1)';
  }
  return (await pool.query(
    `SELECT c.*,t.slug AS tenant_slug,t.display_name AS tenant_name,w.status AS worker_status
     FROM cells c JOIN tenants t ON t.id=c.tenant_id LEFT JOIN workers w ON w.id=c.worker_id
     ${where} ORDER BY t.slug`, params,
  )).rows;
}

async function authorizedCell(user, cellId) {
  if (user.role === 'superadmin' && cellId === 'cell-master') {
    return (await pool.query(
      `SELECT c.*,t.slug AS tenant_slug,t.display_name AS tenant_name,w.status AS worker_status
       FROM cells c JOIN tenants t ON t.id=c.tenant_id LEFT JOIN workers w ON w.id=c.worker_id WHERE c.id=$1`,
      [cellId],
    )).rows[0] || null;
  }
  const cells = await visibleCells(user);
  return cells.find(cell => cell.id === cellId) || null;
}

async function beginSessionTurn(session, prompt, actorUserId = null) {
  const worker = onlineWorker(session);
  if (!worker) throw statusError(503, `Worker ${session.worker_id}가 연결되어 있지 않습니다.`);
  const locked = await pool.query(
    `UPDATE agent_sessions SET status='busy',updated_at=now() WHERE session_uuid=$1 AND status<>'busy' AND archived_at IS NULL RETURNING session_uuid`,
    [session.session_uuid],
  );
  if (!locked.rowCount) throw statusError(409, '이 세션은 이미 응답을 생성하고 있습니다. steering 또는 stop을 사용하세요.');
  const controlId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const createdAt = new Date();
  const detail = { streaming: true, controlId, events: [], startedAt: createdAt.toISOString() };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO chat_messages (id,session_uuid,role,content,detail) VALUES ($1,$2,\'user\',$3,$4)', [userMessageId, session.session_uuid, prompt, { controlId }]);
    await client.query('INSERT INTO chat_messages (id,session_uuid,role,content,detail) VALUES ($1,$2,\'assistant\',\'\',$3)', [assistantMessageId, session.session_uuid, detail]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const turn = {
    controlId, session, prompt, actorUserId, assistantMessageId, content: '', detail,
    createdAt, nextSequence: 1, eventQueue: Promise.resolve(), followup: null,
  };
  activeTurns.set(session.session_uuid, turn);
  await audit(actorUserId, 'session.turn', 'agent_session', session.session_uuid, { harness: session.harness, contentLength: prompt.length, controlId });
  const userMessage = publicChatMessage({ id: userMessageId, role: 'user', content: prompt, detail: { controlId }, created_at: createdAt });
  const assistantMessage = turnPublicMessage(turn);
  broadcastSession(session.session_uuid, { type: 'turn.accepted', controlId, userMessage, assistantMessage, sessionStatus: 'busy' });
  setImmediate(() => runSessionTurnBackground(turn).catch(error => console.error('session turn background:', error)));
  return { controlId, userMessage, assistantMessage, sessionStatus: 'busy' };
}

async function runSessionTurnBackground(turn) {
  const { session } = turn;
  try {
    const result = await sendCommand(onlineWorker(session), 'session.turn', session, {
      sessionUuid: session.session_uuid, nativeSessionId: session.native_session_id, harness: session.harness,
      title: session.title, cwd: session.cwd, model: session.model, effort: session.effort,
      alias: session.alias, address: sessionAddress(session), goal: session.goal || {}, prompt: turn.prompt,
    }, 50 * 60 * 1000, event => queueTurnEvent(turn, event));
    await turn.eventQueue;
    turn.content = String(result.answer || turn.content || '');
    turn.detail = {
      ...turn.detail, streaming: false, completedAt: new Date().toISOString(), nativeSessionId: result.nativeSessionId || null,
      events: mergeTurnEvents(turn.detail.events || [], result.events || []), telemetry: result.telemetry || {}, usage: result.usage || {},
    };
    await pool.query('UPDATE chat_messages SET content=$2,detail=$3,updated_at=now() WHERE id=$1', [turn.assistantMessageId, turn.content, turn.detail]);
    await pool.query(
      `UPDATE agent_sessions SET native_session_id=$2,status='ready',telemetry=$3,last_seen_at=now(),updated_at=now() WHERE session_uuid=$1`,
      [session.session_uuid, result.nativeSessionId || session.native_session_id, result.telemetry || {}],
    );
    if (result.providerAccount) await saveUsageSnapshot(session, session.harness, result.providerAccount);
    broadcastSession(session.session_uuid, { type: 'turn.completed', controlId: turn.controlId, assistantMessage: turnPublicMessage(turn), sessionStatus: 'ready' });
  } catch (error) {
    await turn.eventQueue.catch(() => {});
    const interrupted = /TURN_INTERRUPTED|interrupted/i.test(error.message);
    turn.detail = { ...turn.detail, streaming: false, interrupted, failed: !interrupted, error: error.message, completedAt: new Date().toISOString() };
    await pool.query('UPDATE chat_messages SET content=$2,detail=$3,updated_at=now() WHERE id=$1', [turn.assistantMessageId, turn.content, turn.detail]);
    await pool.query(`UPDATE agent_sessions SET status=$2,updated_at=now() WHERE session_uuid=$1`, [session.session_uuid, interrupted ? 'ready' : 'error']);
    broadcastSession(session.session_uuid, { type: interrupted ? 'turn.interrupted' : 'turn.failed', controlId: turn.controlId, assistantMessage: turnPublicMessage(turn), sessionStatus: interrupted ? 'ready' : 'error', error: error.message });
  } finally {
    activeTurns.delete(session.session_uuid);
    if (turn.followup) {
      const followup = turn.followup;
      setTimeout(async () => {
        try {
          const refreshed = await resolveSessionTarget(session.session_uuid);
          if (refreshed) await beginSessionTurn(refreshed, followup.content, followup.actor);
        } catch (error) { console.error('claude steering followup:', error.message); }
      }, 250);
    }
  }
}

function queueTurnEvent(turn, event) {
  turn.eventQueue = turn.eventQueue.then(async () => {
    if (event.type === 'turn.started') {
      turn.detail.providerTurnId = event.turnId || null;
      turn.detail.nativeSessionId = event.nativeSessionId || turn.detail.nativeSessionId || null;
    } else if (event.type === 'activity.upsert' && event.event) {
      turn.detail.events = mergeTurnEvents(turn.detail.events || [], [event.event]);
      turn.nextSequence = Math.max(turn.nextSequence, Number(event.event.sequence || 0) + 1);
    } else if (event.type === 'answer.delta') {
      turn.content += String(event.delta || '');
    }
    await pool.query('UPDATE chat_messages SET content=$2,detail=$3,updated_at=now() WHERE id=$1', [turn.assistantMessageId, turn.content, turn.detail]);
    broadcastSession(turn.session.session_uuid, { type: 'turn.event', controlId: turn.controlId, event, assistantMessage: turnPublicMessage(turn), sessionStatus: 'busy' });
  });
  return turn.eventQueue;
}

function mergeTurnEvents(existing, incoming) {
  const result = [...existing];
  for (const event of incoming) {
    const index = result.findIndex(item => item.id && item.id === event.id);
    if (index >= 0) result[index] = { ...result[index], ...event, sequence: result[index].sequence || event.sequence };
    else result.push(event);
  }
  return result.sort((a, b) => {
    const left = a.sequence === undefined || a.sequence === null ? Number.MAX_SAFE_INTEGER : Number(a.sequence);
    const right = b.sequence === undefined || b.sequence === null ? Number.MAX_SAFE_INTEGER : Number(b.sequence);
    return left - right;
  });
}

function turnPublicMessage(turn) {
  return publicChatMessage({ id: turn.assistantMessageId, role: 'assistant', content: turn.content, detail: turn.detail, created_at: turn.createdAt });
}

function broadcastSession(sessionUuid, payload) {
  for (const browser of sessionBrowsers.get(String(sessionUuid)) || []) {
    if (browser.readyState === 1) browser.send(JSON.stringify(payload));
  }
}

function sendCommand(worker, action, cell, payload = {}, timeoutMs = 15 * 60 * 1000, onEvent = null) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pendingCommands.delete(requestId);
      reject(new Error('Worker 응답 시간이 초과되었습니다. 작업은 백그라운드에서 계속될 수 있습니다.'));
    }, timeoutMs);
    pendingCommands.set(requestId, { resolve, reject, timeout, onEvent });
    worker.send(JSON.stringify({ type: 'command', requestId, action, cell, payload }));
  });
}

function onlineWorker(cell) {
  const worker = workers.get(cell.worker_id);
  return worker?.readyState === 1 ? worker : null;
}

async function authorizedSession(user, sessionUuid) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionUuid)) return null;
  const params = [sessionUuid];
  let tenantWhere = '';
  if (user.role !== 'superadmin') {
    params.push(user.sub);
    tenantWhere = 'AND s.tenant_id IN (SELECT tenant_id FROM memberships WHERE user_id=$2)';
  }
  return (await pool.query(
    `SELECT s.*,c.runtime_name,c.worker_id,c.status AS cell_status,t.slug AS tenant_slug,t.display_name AS tenant_name
     FROM agent_sessions s JOIN cells c ON c.id=s.cell_id JOIN tenants t ON t.id=s.tenant_id
     WHERE s.session_uuid=$1 ${tenantWhere}`,
    params,
  )).rows[0] || null;
}

function publicCell(cell) {
  return {
    id: cell.id, kind: cell.kind || 'tenant', tenantSlug: cell.tenant_slug, tenantName: cell.tenant_name,
    runtimeName: cell.runtime_name, workerId: cell.worker_id, workerStatus: cell.worker_status,
    status: cell.status, agentsStatus: cell.agents_status,
    desiredVcpus: cell.desired_vcpus, maxVcpus: cell.max_vcpus,
    desiredMemoryMib: cell.desired_memory_mib, maxMemoryMib: cell.max_memory_mib,
  };
}
function publicTenant(tenant) {
  return {
    id: tenant.id,
    slug: tenant.slug,
    displayName: tenant.display_name,
    owner: tenant.owner_id ? { id: tenant.owner_id, email: tenant.owner_email } : null,
    cell: tenant.cell_id ? {
      id: tenant.cell_id, runtimeName: tenant.runtime_name, status: tenant.status, workerId: tenant.worker_id,
    } : null,
    createdAt: tenant.created_at || null,
  };
}

function normalizeTenantSlug(value) {
  const slug = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return /^[a-z0-9][a-z0-9-]{1,47}$/.test(slug) && !['system', 'alpha', 'beta'].includes(slug) ? slug : '';
}

async function preferredWorkerId() {
  const online = (await pool.query("SELECT id FROM workers WHERE status='online' ORDER BY last_seen_at DESC LIMIT 1")).rows[0];
  return online?.id || process.env.DEFAULT_WORKER_ID || 'mac-local';
}

async function cellById(cellId) {
  return (await pool.query(
    `SELECT c.*,t.slug AS tenant_slug,t.display_name AS tenant_name,w.status AS worker_status
     FROM cells c JOIN tenants t ON t.id=c.tenant_id LEFT JOIN workers w ON w.id=c.worker_id WHERE c.id=$1`, [cellId],
  )).rows[0] || null;
}

function publicSession(session) {
  return {
    session_uuid: session.session_uuid, title: session.title, alias: session.alias, address: sessionAddress(session), harness: session.harness,
    status: session.status, cwd: session.cwd, model: session.model, effort: session.effort,
    native_session_id: session.native_session_id, telemetry: session.telemetry || {},
    goal: session.goal || {}, archived_at: session.archived_at || null,
    created_at: session.created_at, updated_at: session.updated_at,
  };
}

function normalizeAlias(value) {
  const alias = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return alias && /^[a-z0-9][a-z0-9._-]*$/.test(alias) ? alias : '';
}

function workspaceNamespace(cwd) {
  return crypto.createHash('sha256').update(String(cwd || '')).digest('hex').slice(0, 12);
}

function sessionAddress(session) {
  if (!session?.alias) return session?.session_uuid || '';
  return `${session.tenant_slug || session.tenant_id}:${session.harness}:${session.model}:${workspaceNamespace(session.cwd)}:${session.alias}`;
}

async function knownSessions(user) {
  const params = [];
  let where = '';
  if (user.role !== 'superadmin') {
    params.push(user.sub || user.id);
    where = `WHERE s.tenant_id IN (SELECT tenant_id FROM memberships WHERE user_id=$1)
      OR EXISTS (
        SELECT 1 FROM session_channel_members visible
        JOIN session_channel_members mine ON mine.channel_id=visible.channel_id
        JOIN session_channels ch ON ch.id=visible.channel_id AND ch.active=true
        JOIN agent_sessions owned ON owned.session_uuid=mine.session_uuid
        WHERE visible.session_uuid=s.session_uuid
          AND owned.tenant_id IN (SELECT tenant_id FROM memberships WHERE user_id=$1)
      )`;
  }
  return (await pool.query(
    `SELECT s.*,t.slug AS tenant_slug,t.display_name AS tenant_name,c.runtime_name,c.worker_id,c.status AS cell_status
     FROM agent_sessions s JOIN tenants t ON t.id=s.tenant_id JOIN cells c ON c.id=s.cell_id
     ${where} ORDER BY t.slug,s.harness,s.model,s.cwd,s.alias`, params,
  )).rows;
}

function publicDirectorySession(session) {
  return {
    sessionUuid: session.session_uuid,
    alias: session.alias,
    address: sessionAddress(session),
    tenant: session.tenant_slug,
    tenantName: session.tenant_name,
    harness: session.harness,
    model: session.model,
    effort: session.effort,
    workspace: session.cwd,
    workspaceNamespace: workspaceNamespace(session.cwd),
    status: session.status,
    wakeCapability: Boolean(session.wake_capability),
  };
}

async function resolveSessionTarget(value) {
  const target = String(value || '').trim();
  if (!target) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target)) {
    return (await pool.query(
      `SELECT s.*,t.slug AS tenant_slug,t.display_name AS tenant_name,c.runtime_name,c.worker_id,c.status AS cell_status
       FROM agent_sessions s JOIN tenants t ON t.id=s.tenant_id JOIN cells c ON c.id=s.cell_id WHERE s.session_uuid=$1`,
      [target],
    )).rows[0] || null;
  }
  const candidates = (await pool.query(
    `SELECT s.*,t.slug AS tenant_slug,t.display_name AS tenant_name,c.runtime_name,c.worker_id,c.status AS cell_status
     FROM agent_sessions s JOIN tenants t ON t.id=s.tenant_id JOIN cells c ON c.id=s.cell_id
     WHERE lower(s.alias)=lower($1) OR $1 LIKE '%:%'`, [target],
  )).rows.filter(row => sessionAddress(row) === target || row.alias.toLowerCase() === target.toLowerCase());
  return candidates.length === 1 ? candidates[0] : null;
}

async function canActAsSession(user, session) {
  if (user.role === 'superadmin') return true;
  return Boolean((await pool.query(
    'SELECT 1 FROM memberships WHERE user_id=$1 AND tenant_id=$2', [user.sub || user.id, session.tenant_id],
  )).rowCount);
}

async function authorizeInterSessionPair(user, source, target, requestedChannelId = null) {
  if (user.role === 'superadmin') return requestedChannelId || null;
  if (!source) throw statusError(403, 'source 세션이 필요합니다.');
  if (source.tenant_id === target.tenant_id) return null;
  const params = [source.session_uuid, target.session_uuid];
  let channelFilter = '';
  if (requestedChannelId) { params.push(requestedChannelId); channelFilter = 'AND ch.id=$3'; }
  const row = (await pool.query(
    `SELECT ch.id FROM session_channels ch
     JOIN session_channel_members sender ON sender.channel_id=ch.id AND sender.session_uuid=$1 AND sender.permission IN ('send','both')
     JOIN session_channel_members receiver ON receiver.channel_id=ch.id AND receiver.session_uuid=$2 AND receiver.permission IN ('receive','both')
     WHERE ch.active=true ${channelFilter} ORDER BY ch.created_at LIMIT 1`, params,
  )).rows[0];
  if (!row) throw statusError(403, 'Cross-tenant 메시지에는 양쪽 세션이 포함된 활성 channel/grant가 필요합니다.');
  return row.id;
}

async function enqueueSessionMessage({ source, target, content, channelId = null, expectReply = true, idempotencyKey, createdBy = null, replyTo = null }) {
  const messageId = crypto.randomUUID();
  const scopedKey = `${source?.session_uuid || 'master'}:${String(idempotencyKey || messageId)}`.slice(0, 300);
  const body = {
    content,
    expectReply: Boolean(expectReply),
    replyTo: replyTo || null,
    sourceAddress: source ? sessionAddress(source) : 'master',
    targetAddress: sessionAddress(target),
  };
  const inserted = await pool.query(
    `INSERT INTO session_messages (id,source_session_uuid,target_session_uuid,idempotency_key,body,status,channel_id,created_by)
     VALUES ($1,$2,$3,$4,$5,'queued',$6,$7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [messageId, source?.session_uuid || null, target.session_uuid, scopedKey, body, channelId, createdBy],
  );
  let row = inserted.rows[0];
  const created = Boolean(row);
  if (!row) row = (await pool.query('SELECT * FROM session_messages WHERE idempotency_key=$1', [scopedKey])).rows[0];
  if (created) await recordSessionMessageEvent(row.id, 'queued', { source: source?.session_uuid || null, target: target.session_uuid });
  return { ...row, created };
}

async function ingestBridgeOutbox(workerId, runtimeName, payload) {
  if (!/^[0-9a-f-]{36}$/i.test(String(payload.outboxId || ''))) throw new Error('invalid bridge outbox id');
  const cell = (await pool.query(
    `SELECT c.*,t.slug AS tenant_slug,t.display_name AS tenant_name FROM cells c JOIN tenants t ON t.id=c.tenant_id
     WHERE c.worker_id=$1 AND c.runtime_name=$2`, [workerId, runtimeName],
  )).rows[0];
  if (!cell) throw new Error('bridge cell not owned by worker');
  const source = await resolveSessionTarget(String(payload.source || ''));
  const target = await resolveSessionTarget(String(payload.target || ''));
  if (!source || source.cell_id !== cell.id) throw new Error('bridge source does not belong to emitting cell');
  if (!target) throw new Error('bridge target not found or ambiguous');
  const channelId = source.tenant_id === target.tenant_id
    ? null
    : await authorizedChannelForPair(source, target, null);
  const message = await enqueueSessionMessage({
    source, target, content: String(payload.content || '').trim(), channelId,
    expectReply: payload.expectReply !== false,
    idempotencyKey: `bridge:${payload.outboxId}:${payload.idempotencyKey || ''}`,
    replyTo: payload.replyTo || null,
  });
  await audit(null, 'bridge.outbox.ingest', 'session_message', message.id, { workerId, runtimeName, outboxId: payload.outboxId });
  return message;
}

/**
 * The Worker is the only component that possesses an AgentSlack agent token.
 * Keep the Master payload intentionally narrow: a Worker may only bind an
 * AgentSlack delivery to a target session on that same Worker, and the durable
 * queue idempotency key is namespaced by Worker+binding+delivery id.
 */
async function ingestAgentSlackDelivery(ws, workerId, payload) {
  const requestId = String(payload.requestId || '');
  const bindingId = String(payload.bindingId || '');
  const targetUuid = String(payload.targetSessionUuid || '');
  const deliveryId = Number(payload.externalDeliveryId);
  const externalMessageId = String(payload.externalMessageId || '');
  const content = String(payload.content || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !/^[A-Za-z0-9._-]{2,120}$/.test(bindingId)
    || !/^[0-9a-f-]{36}$/i.test(targetUuid) || !Number.isSafeInteger(deliveryId) || deliveryId < 1
    || !externalMessageId || !content || content.length > 100_000) {
    ws.send(JSON.stringify({ type: 'agentslack.delivery.rejected', requestId, bindingId, error: 'invalid AgentSlack delivery envelope' }));
    return;
  }
  const target = await resolveSessionTarget(targetUuid);
  if (!target || target.worker_id !== workerId) {
    ws.send(JSON.stringify({ type: 'agentslack.delivery.rejected', requestId, bindingId, error: 'target session is not owned by this Worker' }));
    return;
  }
  const message = await enqueueSessionMessage({
    source: null, target, content, expectReply: false,
    idempotencyKey: `agentslack:${workerId}:${bindingId}:${deliveryId}:${externalMessageId}`,
  });
  await pool.query(
    `INSERT INTO agentslack_delivery_links(agentworks_message_id,worker_id,binding_id,delivery_id,external_message_id,status,accepted_at)
     VALUES ($1,$2,$3,$4,$5,'accepted',now())
     ON CONFLICT (worker_id,binding_id,delivery_id) DO UPDATE
       SET agentworks_message_id=EXCLUDED.agentworks_message_id, accepted_at=COALESCE(agentslack_delivery_links.accepted_at,now()), last_error=NULL`,
    [message.id, workerId, bindingId, deliveryId, externalMessageId],
  );
  await audit(null, 'agentslack.delivery.accepted', 'session_message', message.id, { workerId, bindingId, deliveryId });
  ws.send(JSON.stringify({ type: 'agentslack.delivery.accepted', requestId, bindingId, agentworksMessageId: message.id, deduplicated: !message.created }));
}

async function authorizedChannelForPair(source, target, requestedChannelId = null) {
  if (source.tenant_id === target.tenant_id) return null;
  const params = [source.session_uuid, target.session_uuid];
  let filter = '';
  if (requestedChannelId) { params.push(requestedChannelId); filter = 'AND ch.id=$3'; }
  const row = (await pool.query(
    `SELECT ch.id FROM session_channels ch
     JOIN session_channel_members sender ON sender.channel_id=ch.id AND sender.session_uuid=$1 AND sender.permission IN ('send','both')
     JOIN session_channel_members receiver ON receiver.channel_id=ch.id AND receiver.session_uuid=$2 AND receiver.permission IN ('receive','both')
     WHERE ch.active=true ${filter} ORDER BY ch.created_at LIMIT 1`, params,
  )).rows[0];
  if (!row) throw new Error('cross-tenant bridge send requires an active channel/grant');
  return row.id;
}

async function recordSessionMessageEvent(messageId, state, detail = {}) {
  await pool.query('INSERT INTO session_message_events (message_id,state,detail) VALUES ($1,$2,$3)', [messageId, state, detail]);
}

async function visibleSessionMessages(user, limit = 100) {
  const params = [];
  let where = '';
  if (user.role !== 'superadmin') {
    params.push(user.sub || user.id);
    where = `WHERE src.tenant_id IN (SELECT tenant_id FROM memberships WHERE user_id=$1)
      OR dst.tenant_id IN (SELECT tenant_id FROM memberships WHERE user_id=$1)`;
  }
  params.push(Math.min(500, Math.max(1, limit)));
  return (await pool.query(
    `SELECT m.*,
       src.alias AS source_alias,st.slug AS source_tenant,src.harness AS source_harness,src.model AS source_model,src.cwd AS source_cwd,
       dst.alias AS target_alias,tt.slug AS target_tenant,dst.harness AS target_harness,dst.model AS target_model,dst.cwd AS target_cwd
     FROM session_messages m
     LEFT JOIN agent_sessions src ON src.session_uuid=m.source_session_uuid LEFT JOIN tenants st ON st.id=src.tenant_id
     JOIN agent_sessions dst ON dst.session_uuid=m.target_session_uuid JOIN tenants tt ON tt.id=dst.tenant_id
     ${where} ORDER BY m.created_at DESC LIMIT $${params.length}`, params,
  )).rows;
}

async function visibleMessageCounts(user) {
  const rows = await visibleSessionMessages(user, 500);
  return rows.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] || 0) + 1 }), {});
}

function publicSessionMessage(row) {
  const source = row.source_alias ? `${row.source_tenant}:${row.source_harness}:${row.source_model}:${workspaceNamespace(row.source_cwd)}:${row.source_alias}` : row.body?.sourceAddress || 'master';
  const target = row.target_alias ? `${row.target_tenant}:${row.target_harness}:${row.target_model}:${workspaceNamespace(row.target_cwd)}:${row.target_alias}` : row.body?.targetAddress;
  return {
    id: row.id,
    source,
    target,
    status: row.status,
    content: row.body?.content || '',
    expectReply: Boolean(row.body?.expectReply),
    replyTo: row.body?.replyTo || null,
    attemptCount: row.attempt_count || 0,
    lastError: row.last_error || null,
    result: row.result || {},
    channelId: row.channel_id || null,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    acknowledgedAt: row.acknowledged_at,
    created: row.created,
  };
}

function statusError(status, message) { const error = new Error(message); error.status = status; return error; }

async function drainInterSessionQueue() {
  if (interSessionDrainActive) return;
  interSessionDrainActive = true;
  try {
    await pool.query("UPDATE session_messages SET status='expired',last_error='message expired' WHERE status IN ('queued','waking') AND expires_at<=now()");
    for (let index = 0; index < 8; index += 1) {
      const message = await claimSessionMessage();
      if (!message) break;
      if (activeInterSessionDeliveries.has(message.id)) continue;
      activeInterSessionDeliveries.add(message.id);
      void deliverSessionMessage(message).catch(error => console.error('inter-session delivery:', error)).finally(() => activeInterSessionDeliveries.delete(message.id));
    }
  } finally { interSessionDrainActive = false; }
}

async function claimSessionMessage() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidate = (await client.query(
      `SELECT m.id,m.target_session_uuid FROM session_messages m
       JOIN agent_sessions target ON target.session_uuid=m.target_session_uuid
       WHERE m.status='queued' AND m.available_at<=now() AND m.expires_at>now()
         AND m.attempt_count<m.max_attempts AND target.status<>'busy' AND target.archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM session_messages earlier
           WHERE earlier.target_session_uuid=m.target_session_uuid AND earlier.created_at<m.created_at
             AND earlier.status NOT IN ('acknowledged','failed','expired')
         )
       ORDER BY m.created_at,m.id FOR UPDATE OF m,target SKIP LOCKED LIMIT 1`,
    )).rows[0];
    if (!candidate) { await client.query('ROLLBACK'); return null; }
    const row = (await client.query(
      `UPDATE session_messages SET status='waking',attempt_count=attempt_count+1,
         lease_owner=$2,lease_expires_at=now()+interval '55 minutes',last_error=NULL
       WHERE id=$1 RETURNING *`,
      [candidate.id, `master:${process.pid}`],
    )).rows[0];
    await client.query("UPDATE agent_sessions SET status='busy',updated_at=now() WHERE session_uuid=$1", [candidate.target_session_uuid]);
    await client.query('COMMIT');
    await recordSessionMessageEvent(row.id, 'waking', { attempt: row.attempt_count });
    return row;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function deliverSessionMessage(message) {
  const target = await resolveSessionTarget(message.target_session_uuid);
  const source = message.source_session_uuid ? await resolveSessionTarget(message.source_session_uuid) : null;
  if (!target) return failSessionMessage(message, new Error('target session missing'), true);
  const worker = onlineWorker(target);
  if (!worker) return failSessionMessage(message, new Error(`Worker ${target.worker_id} offline`), false);
  try {
    const result = await sendCommand(worker, 'session.wake', target, {
      sessionUuid: target.session_uuid,
      nativeSessionId: target.native_session_id,
      harness: target.harness,
      title: target.title,
      alias: target.alias,
      address: sessionAddress(target),
      cwd: target.cwd,
      model: target.model,
      effort: target.effort,
      envelope: {
        messageId: message.id,
        sourceAddress: source ? sessionAddress(source) : message.body?.sourceAddress || 'master',
        content: message.body?.content || '',
        expectReply: Boolean(message.body?.expectReply),
        replyTo: message.body?.replyTo || null,
      },
    }, 50 * 60 * 1000);
    await acknowledgeSessionMessage(message, target, source, result);
  } catch (error) { await failSessionMessage(message, error, false); }
}

async function acknowledgeSessionMessage(message, target, source, result) {
  const assistant = String(result.answer || '');
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO chat_messages (id,session_uuid,role,content,detail,inter_session_message_id)
       VALUES ($1,$2,'user',$3,$4,$5) ON CONFLICT (inter_session_message_id,role) WHERE inter_session_message_id IS NOT NULL DO NOTHING`,
      [userMessageId, target.session_uuid, message.body?.content || '', {
        interSession: true, sourceAddress: source ? sessionAddress(source) : message.body?.sourceAddress || 'master', messageId: message.id,
      }, message.id],
    );
    await client.query(
      `INSERT INTO chat_messages (id,session_uuid,role,content,detail,inter_session_message_id)
       VALUES ($1,$2,'assistant',$3,$4,$5) ON CONFLICT (inter_session_message_id,role) WHERE inter_session_message_id IS NOT NULL DO NOTHING`,
      [assistantMessageId, target.session_uuid, assistant, {
        interSession: true, messageId: message.id, nativeSessionId: result.nativeSessionId || null,
        events: result.events || [], telemetry: result.telemetry || {}, usage: result.usage || {},
      }, message.id],
    );
    await client.query(
      `UPDATE agent_sessions SET native_session_id=$2,status='ready',telemetry=$3,last_seen_at=now(),updated_at=now() WHERE session_uuid=$1`,
      [target.session_uuid, result.nativeSessionId || target.native_session_id, result.telemetry || {}],
    );
    await client.query(
      `UPDATE session_messages SET status='acknowledged',delivered_at=COALESCE(delivered_at,now()),accepted_at=COALESCE(accepted_at,now()),
         acknowledged_at=now(),lease_owner=NULL,lease_expires_at=NULL,result=$2,last_error=NULL WHERE id=$1`,
      [message.id, { answer: assistant, assistantMessageId, deduplicated: Boolean(result.deduplicated) }],
    );
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  await recordSessionMessageEvent(message.id, 'acknowledged', { target: target.session_uuid, deduplicated: Boolean(result.deduplicated) });
  await notifyAgentSlackAcknowledged(message.id);
  if (result.providerAccount) await saveUsageSnapshot(target, target.harness, result.providerAccount).catch(() => {});
  if (source) void sendBridgeReceipt(source, {
    messageId: message.id, status: 'acknowledged', source: sessionAddress(source), target: sessionAddress(target),
    answer: assistant, acknowledgedAt: new Date().toISOString(), attemptCount: message.attempt_count,
  });
  if (source && message.body?.expectReply && assistant) {
    const channelId = source.tenant_id === target.tenant_id ? null : message.channel_id;
    await enqueueSessionMessage({
      source: target, target: source, content: assistant, channelId, expectReply: false,
      idempotencyKey: `reply:${message.id}`, replyTo: message.id,
    });
  }
}

async function notifyAgentSlackAcknowledged(agentworksMessageId) {
  const link = (await pool.query(
    `SELECT * FROM agentslack_delivery_links WHERE agentworks_message_id=$1 AND status='accepted'`, [agentworksMessageId],
  )).rows[0];
  if (!link) return;
  const worker = workers.get(link.worker_id);
  if (!worker || worker.readyState !== 1) return;
  worker.send(JSON.stringify({
    type: 'agentslack.delivery.ack', bindingId: link.binding_id,
    externalDeliveryId: Number(link.delivery_id), agentworksMessageId,
  }));
  await pool.query(`UPDATE agentslack_delivery_links SET status='ack_pending' WHERE agentworks_message_id=$1`, [agentworksMessageId]);
}

async function failSessionMessage(message, error, terminal) {
  const text = String(error?.message || error).slice(0, 4000);
  const infrastructureUnavailable = /Worker .* offline/i.test(text);
  const exhausted = terminal || (!infrastructureUnavailable && message.attempt_count >= message.max_attempts);
  const retrySeconds = Math.min(300, Math.max(3, 2 ** Math.min(8, message.attempt_count || 1)));
  await pool.query(
    `UPDATE session_messages SET status=$2,last_error=$3,lease_owner=NULL,lease_expires_at=NULL,
       attempt_count=CASE WHEN $5 THEN GREATEST(attempt_count-1,0) ELSE attempt_count END,
       available_at=CASE WHEN $2='queued' THEN now()+($4::text || ' seconds')::interval ELSE available_at END
     WHERE id=$1`,
    [message.id, exhausted ? 'failed' : 'queued', text, retrySeconds, infrastructureUnavailable],
  );
  await pool.query("UPDATE agent_sessions SET status='ready',updated_at=now() WHERE session_uuid=$1", [message.target_session_uuid]);
  await recordSessionMessageEvent(message.id, exhausted ? 'failed' : 'retry_scheduled', { error: text, retrySeconds });
}

async function sendBridgeReceipt(session, receipt) {
  const worker = onlineWorker(session);
  if (!worker) return;
  await sendCommand(worker, 'bridge.receipt', session, { ...receipt, messageId: receipt.messageId }, 120_000).catch(() => {});
}

async function syncBridgeDirectories(onlyWorkerId = null) {
  const cells = (await pool.query(
    `SELECT c.*,t.slug AS tenant_slug,t.display_name AS tenant_name FROM cells c JOIN tenants t ON t.id=c.tenant_id
     WHERE c.kind='tenant' ${onlyWorkerId ? 'AND c.worker_id=$1' : ''} ORDER BY c.id`, onlyWorkerId ? [onlyWorkerId] : [],
  )).rows;
  for (const cell of cells) {
    const worker = onlineWorker(cell);
    if (!worker) continue;
    const rows = (await pool.query(
      `SELECT DISTINCT s.*,t.slug AS tenant_slug,t.display_name AS tenant_name
       FROM agent_sessions s JOIN tenants t ON t.id=s.tenant_id
       WHERE s.tenant_id=$1 OR EXISTS (
         SELECT 1 FROM session_channel_members visible
         JOIN session_channel_members owned_member ON owned_member.channel_id=visible.channel_id
         JOIN session_channels ch ON ch.id=visible.channel_id AND ch.active=true
         JOIN agent_sessions owned ON owned.session_uuid=owned_member.session_uuid AND owned.tenant_id=$1
         WHERE visible.session_uuid=s.session_uuid
       ) ORDER BY t.slug,s.alias`, [cell.tenant_id],
    )).rows;
    const directory = {
      scope: { tenant: cell.tenant_slug, tenantName: cell.tenant_name, runtimeName: cell.runtime_name },
      sessions: rows.map(publicDirectorySession),
    };
    void sendCommand(worker, 'bridge.sync', cell, { directory }, 180_000).catch(error => console.error(`bridge directory ${cell.id}:`, error.message));
  }
}

function renderMarkdown(content) {
  const source = String(content || '').replace(
    /(?<!!)\[([^\]]*)\]\((https?:\/\/[^\s)]+\.(?:gif|png|jpe?g|webp|svg)(?:\?[^\s)]*)?)\)/gi,
    '![$1]($2)',
  );
  const dirty = marked.parse(source);
  return sanitizeHtml(dirty, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'details', 'summary', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      code: ['class'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding', 'referrerpolicy'],
      th: ['align'],
      td: ['align'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: 'a',
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
      }),
      img: (_tagName, attribs) => ({
        tagName: 'img',
        attribs: { ...attribs, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' },
      }),
    },
  });
}

function publicChatMessage(message) {
  return {
    ...message,
    detail: message.detail || {},
    html: message.role === 'assistant' ? renderMarkdown(message.content) : null,
  };
}

async function saveUsageSnapshot(cell, harness, data) {
  const cellId = cell.cell_id || cell.id;
  if (!cellId || !cell.tenant_id || !data) return;
  await pool.query(
    `INSERT INTO provider_usage_snapshots (tenant_id,cell_id,harness,data,captured_at)
     VALUES ($1,$2,$3,$4::jsonb,COALESCE((($4::jsonb)->>'capturedAt')::timestamptz,now()))`,
    [cell.tenant_id, cellId, harness, data],
  );
}

async function usageOverview(cell, live = {}) {
  const [sessionRows, snapshotRows, messageRows] = await Promise.all([
    pool.query(
      `SELECT session_uuid,title,harness,status,model,effort,telemetry,updated_at
       FROM agent_sessions WHERE cell_id=$1 ORDER BY updated_at DESC`,
      [cell.id],
    ),
    pool.query(
      `SELECT DISTINCT ON (harness) harness,data,captured_at
       FROM provider_usage_snapshots WHERE cell_id=$1
       ORDER BY harness,captured_at DESC`,
      [cell.id],
    ),
    pool.query(
      `SELECT s.harness,s.model,m.detail,m.created_at
       FROM chat_messages m JOIN agent_sessions s ON s.session_uuid=m.session_uuid
       WHERE s.cell_id=$1 AND m.role='assistant' ORDER BY m.created_at`,
      [cell.id],
    ),
  ]);

  const providers = {};
  for (const row of snapshotRows.rows) providers[row.harness] = { data: row.data || {}, capturedAt: row.captured_at };
  for (const [harness, data] of Object.entries(live)) {
    if (data) providers[harness] = { data, capturedAt: data.capturedAt || new Date().toISOString(), live: true };
  }

  const models = {};
  for (const row of messageRows.rows) {
    const detail = row.detail || {};
    const entries = Object.entries(detail.usage?.modelUsage || {});
    if (!entries.length && detail.telemetry?.tokenUsage?.last) {
      entries.push([row.model || detail.telemetry.model || 'unknown', detail.telemetry.tokenUsage.last]);
    }
    for (const [model, raw] of entries) {
      const target = models[model] ||= {
        model, harness: row.harness, turns: 0, inputTokens: 0, outputTokens: 0,
        cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
        totalTokens: 0, costUSD: 0,
      };
      target.turns += 1;
      target.inputTokens += numeric(raw.inputTokens ?? raw.input_tokens);
      target.outputTokens += numeric(raw.outputTokens ?? raw.output_tokens);
      target.cacheReadInputTokens += numeric(raw.cacheReadInputTokens ?? raw.cache_read_input_tokens ?? raw.cachedInputTokens);
      target.cacheCreationInputTokens += numeric(raw.cacheCreationInputTokens ?? raw.cache_creation_input_tokens ?? raw.cacheWriteInputTokens);
      target.reasoningOutputTokens += numeric(raw.reasoningOutputTokens ?? raw.reasoning_output_tokens);
      target.totalTokens += numeric(raw.totalTokens ?? raw.total_tokens);
      target.costUSD += numeric(raw.costUSD ?? raw.cost_usd);
    }
  }
  for (const model of Object.values(models)) {
    model.processedTokens = model.totalTokens || (
      model.inputTokens + model.outputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens
    );
  }

  return {
    capturedAt: new Date().toISOString(),
    providers,
    sessions: sessionRows.rows.map(row => ({
      session_uuid: row.session_uuid,
      title: row.title,
      harness: row.harness,
      status: row.status,
      model: row.model,
      effort: row.effort,
      telemetry: row.telemetry || {},
      updated_at: row.updated_at,
    })),
    models: Object.values(models).sort((a, b) => b.processedTokens - a.processedTokens),
  };
}

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

async function applyCellStatuses(cells, workerId) {
  for (const cell of cells) {
    await pool.query(
      `UPDATE cells SET worker_id=$2,status=$3,agents_status=COALESCE($4,agents_status),last_error=$5,updated_at=now()
       WHERE runtime_name=$1`,
      [cell.runtimeName, workerId, cell.status, cell.agentsStatus || null, cell.error || null],
    );
  }
}

async function listPortRoutes() {
  return (await pool.query(
    `SELECT p.*,c.runtime_name,c.worker_id,t.slug AS tenant_slug,t.display_name AS tenant_name
     FROM port_routes p JOIN cells c ON c.id=p.cell_id JOIN tenants t ON t.id=c.tenant_id
     ORDER BY p.updated_at DESC`,
  )).rows;
}

async function allocateHostPort(bindAddress) {
  const used = new Set((await pool.query(
    "SELECT host_port FROM port_routes WHERE status IN ('requested','active')",
  )).rows.map(row => Number(row.host_port)));
  for (let candidate = portPoolStart; candidate <= portPoolEnd; candidate += 1) if (!used.has(candidate)) return candidate;
  throw statusError(409, '사용 가능한 host port가 없습니다.');
}

async function restorePortRoutes(workerId) {
  const rows = (await pool.query(
    `SELECT p.*,c.runtime_name,c.worker_id FROM port_routes p JOIN cells c ON c.id=p.cell_id
     WHERE c.worker_id=$1 AND p.status='active' ORDER BY p.created_at`,
    [workerId],
  )).rows;
  for (const route of rows) {
    const worker = onlineWorker(route);
    if (!worker) return;
    void sendCommand(worker, 'port.apply', route, { route }, 60_000).catch(async error => {
      await pool.query("UPDATE port_routes SET status='error',last_error=$2,updated_at=now() WHERE id=$1", [route.id, error.message]).catch(() => {});
    });
  }
}

function validPort(value) {
  const portValue = Number(value);
  return Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535 ? portValue : null;
}

async function audit(actor, action, targetType, targetId, detail) {
  await pool.query('INSERT INTO audit_events (actor_user_id,action,target_type,target_id,detail) VALUES ($1,$2,$3,$4,$5)', [actor, action, targetType, targetId, detail]);
}

function requireUser(req, res, next) {
  const user = requestUser(req);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  req.user = user;
  next();
}

function requireSuperadmin(req, res, next) {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: '수퍼어드민 권한이 필요합니다.' });
  next();
}

function requestUser(req) {
  const capability = String(req.headers['x-agentworks-master-token'] || '');
  if (capability && safeEqual(capability, masterAgentToken)) {
    return { sub: 'user-master', id: 'user-master', email: process.env.MASTER_EMAIL, role: 'superadmin', agentCapability: true };
  }
  const cookies = cookie.parse(req.headers.cookie || '');
  if (!cookies.aw_session) return null;
  try { return jwt.verify(cookies.aw_session, jwtSecret); } catch { return null; }
}

function websocketUser(req) { return requestUser(req); }
function publicUser(user) { return { id: user.sub || user.id, email: user.email, role: user.role }; }
function bearerToken(req) { return req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] || null; }
function safeEqual(a, b) {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function rejectUpgrade(socket, status) { socket.write(`HTTP/1.1 ${status} Error\r\nConnection: close\r\n\r\n`); socket.destroy(); }
function required(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }

initialize().catch(error => {
  console.error(error);
  process.exit(1);
});
