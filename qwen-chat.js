import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, copyFileSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

const QWEN_BASE = 'https://chat.qwen.ai';
const PROVIDER_ID = 'qwen-chat';

const ACCOUNTS_FILE = join(homedir(), '.config', 'opencode', 'qwen-accounts.json');
const STATE_FILE = join(homedir(), '.config', 'opencode', 'qwen-accounts-state.json');

// Diagnostic logging with rotation at 1 MB.
const DEBUG_FLAG = join(homedir(), '.config', 'opencode', 'qwen-chat-debug');
const DEBUG_LOG = join(homedir(), '.config', 'opencode', 'qwen-chat-debug.log');
const MAX_LOG_BYTES = 1_048_576;
let debugEnabled = null;
function dbg(obj) {
  try {
    if (debugEnabled === null) debugEnabled = existsSync(DEBUG_FLAG);
    if (!debugEnabled) return;
    const line = JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n';
    appendFileSync(DEBUG_LOG, line);
    try { if (statSync(DEBUG_LOG).size > MAX_LOG_BYTES) writeFileSync(DEBUG_LOG, line); } catch {}
  } catch { /* ignore */ }
}

const REQUEST_TIMEOUT_MS = 120_000;

const MODELS = {
  'qwen3.6-plus':        { name: 'Qwen3.6 Plus',        context: 1_000_000, output: 65536 },
  'qwen3.7-max':         { name: 'Qwen3.7 Max',          context: 1_000_000, output: 65536 },
  'qwen3.6-max-preview': { name: 'Qwen3.6 Max Preview',  context:   262_144, output: 65536 },
  'qwen3.5-plus':        { name: 'Qwen3.5 Plus',         context: 1_000_000, output: 65536 },
  'qwen3.5-flash':       { name: 'Qwen3.5 Flash',        context: 1_000_000, output: 65536 },
  'qwen3.6-27b':         { name: 'Qwen3.6 27B',          context:   262_144, output: 65536 },
};

// ─── JWT helpers ───────────────────────────────────────────────────────────────

function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
  catch { return null; }
}
function jwtExpiry(token) {
  const c = jwtClaims(token);
  return c?.exp ? c.exp * 1000 : null;
}
function tokenIsValid(token) {
  if (!token) return false;
  const exp = jwtExpiry(token);
  if (!exp) return true;
  return Date.now() < exp - 60_000;
}
function accountIdOf(token) {
  const c = jwtClaims(token);
  return c?.id ?? `anon:${token.slice(-16)}`;
}
function shortId(id) {
  return String(id).split(':').pop().slice(0, 8);
}

// ─── Token sources ──────────────────────────────────────────────────────────────

function listFirefoxCookieDbs() {
  const root = join(homedir(), 'Library/Application Support/Firefox/Profiles');
  if (!existsSync(root)) return [];
  let dirs;
  try { dirs = readdirSync(root); } catch { return []; }
  return dirs
    .map(d => ({ path: join(root, d, 'cookies.sqlite'), label: d.split('.').slice(1).join('.') || d }))
    .filter(x => existsSync(x.path));
}

function readTokenFromCookieDb(dbPath, idx) {
  try {
    const tmp = join(tmpdir(), `qwen-ff-cookies-${idx}.sqlite`);
    copyFileSync(dbPath, tmp);
    const result = execSync(
      `sqlite3 "${tmp}" "SELECT value FROM moz_cookies WHERE host LIKE '%.qwen.ai' AND name='token' ORDER BY lastAccessed DESC LIMIT 1;"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return result || null;
  } catch { return null; }
}

function readFirefoxTokens() {
  const out = [];
  listFirefoxCookieDbs().forEach((db, i) => {
    const t = readTokenFromCookieDb(db.path, i);
    if (t) out.push({ token: t, label: `Firefox: ${db.label}` });
  });
  return out;
}

function readAccountsFileTokens() {
  try {
    if (!existsSync(ACCOUNTS_FILE)) return [];
    const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.tokens) ? raw.tokens : [];
    return list
      .map(t => (typeof t === 'string' ? { token: t } : { token: t?.token, label: t?.label }))
      .filter(x => x.token)
      .map(x => ({ token: x.token, label: x.label ? `File: ${x.label}` : 'File' }));
  } catch { return []; }
}

function getTokenFromFirefox() {
  const dbs = listFirefoxCookieDbs();
  for (let i = 0; i < dbs.length; i++) {
    const t = readTokenFromCookieDb(dbs[i].path, i);
    if (t && tokenIsValid(t)) return t;
  }
  return null;
}

let accountsCache = null;
let accountsCacheTime = 0;

function collectAccounts(storedToken) {
  if (accountsCache && Date.now() - accountsCacheTime < 10_000) return accountsCache;

  const raw = [
    ...readFirefoxTokens(),
    ...readAccountsFileTokens(),
    ...(storedToken ? [{ token: storedToken, label: 'Saved login' }] : []),
  ];

  const byId = new Map();
  for (const { token, label } of raw) {
    if (!tokenIsValid(token)) continue;
    const id = accountIdOf(token);
    const exp = jwtExpiry(token) ?? 0;
    const existing = byId.get(id);
    if (!existing || exp > existing.exp) {
      byId.set(id, { id, token, exp, label: label ?? `Account ${shortId(id)}` });
    }
  }

  accountsCache = [...byId.values()];
  accountsCacheTime = Date.now();
  return accountsCache;
}

function invalidateCache() {
  accountsCache = null;
  accountsCacheTime = 0;
}

// ─── Per-account rate-limit state ───────────────────────────────────────────────

function loadState() {
  try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {}; }
  catch { return {}; }
}
function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 }); }
  catch { /* best effort */ }
}
function nextUtcMidnight(now) {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}
function markRateLimited(state, id, kind, now) {
  const entry = state[id] ?? { failures: 0, lastUsed: 0 };
  entry.failures = (entry.failures ?? 0) + 1;
  entry.rateLimitedUntil = kind === 'quota' ? nextUtcMidnight(now) : now + 60_000;
  entry.lastKind = kind;
  state[id] = entry;
}
function markUsed(state, id, now) {
  const entry = state[id] ?? { failures: 0 };
  entry.lastUsed = now;
  entry.failures = 0;
  state[id] = entry;
}
function orderAccounts(accounts, state, now) {
  const usable = accounts.filter(a => !(state[a.id]?.rateLimitedUntil > now));
  usable.sort((x, y) => (state[x.id]?.lastUsed ?? 0) - (state[y.id]?.lastUsed ?? 0));
  let soonestReset = Infinity;
  for (const a of accounts) {
    const until = state[a.id]?.rateLimitedUntil ?? 0;
    if (until > now) soonestReset = Math.min(soonestReset, until);
  }
  return { usable, soonestReset };
}

// ─── Failure classification ──────────────────────────────────────────────────────

function classifyFailure(status, text) {
  const b = (text || '').toLowerCase();
  const quotaHint = b.includes('quota') || b.includes('exceed') || b.includes('insufficient') ||
                    b.includes('out of') || b.includes('daily limit') || b.includes('free');
  if (status === 429) return quotaHint ? 'quota' : 'rate_limit';
  if (status === 401 || status === 403) return quotaHint ? 'quota' : 'auth';
  if (quotaHint || b.includes('rate limit') || b.includes('too many')) return 'quota';
  return 'other';
}

// ─── Toast notifications ─────────────────────────────────────────────────────────

let toastClient = null;
let lastServedAccountId = null;

function notify(message, variant = 'info', title = 'Qwen Chat') {
  try {
    toastClient?.tui?.showToast({ body: { title, message, variant, duration: 4000 } })?.catch?.(() => {});
  } catch {}
}

// ─── Request helpers ───────────────────────────────────────────────────────────

function buildHeaders(token, extra = {}) {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0',
    'Accept': 'text/event-stream, application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'version': '0.2.60',
    'source': 'web',
    'x-request-id': randomUUID(),
    'timezone': new Date().toString(),
    'bx-v': '2.5.36',
    'Origin': QWEN_BASE,
    'Referer': `${QWEN_BASE}/`,
    'Cookie': `token=${token}`,
    ...extra,
  };
}

async function createChatSession(token, model, signal) {
  const res = await fetch(`${QWEN_BASE}/api/v2/chats/new`, {
    method: 'POST',
    headers: buildHeaders(token),
    signal,
    body: JSON.stringify({
      title: 'OpenCode', models: [model], chat_mode: 'normal',
      chat_type: 't2t', timestamp: Date.now(), project_id: '',
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`chats/new ${res.status}`);
    err.status = res.status; err.body = text;
    throw err;
  }
  try { return JSON.parse(text).data.id; }
  catch { const e = new Error('chats/new bad json'); e.status = res.status; e.body = text; throw e; }
}

function contentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text ?? '').join('');
  return String(content ?? '');
}

// ─── Message/context builder ────────────────────────────────────────────────────
// Preserves conversation structure for better Qwen comprehension.

function buildPrompt(messages) {
  const parts = [];
  for (const m of messages) {
    const text = contentToString(m.content).trim();
    if (!text) continue;
    if (m.role === 'system') {
      parts.push(`[System]\n${text}`);
    } else if (m.role === 'assistant') {
      parts.push(`[Assistant]\n${text}`);
    } else if (m.role === 'tool') {
      parts.push(`[Tool Result]\n${text}`);
    } else {
      parts.push(`[User]\n${text}`);
    }
  }
  return parts.join('\n\n---\n\n');
}

// ─── Tool-call shim ─────────────────────────────────────────────────────────────
// Qwen's web API has no native function calling. We inject a text protocol:
// the model emits fenced ```tool_call blocks, which we parse back into
// OpenAI tool_calls. The prompt is kept SHORT to avoid confusing Qwen into
// using other formats.

function renderToolsForPrompt(tools) {
  return tools.map(t => {
    const f = t.function ?? t;
    const desc = (f.description ?? '').split('\n')[0].slice(0, 120);
    const params = f.parameters?.properties ?? {};
    const required = new Set(f.parameters?.required ?? []);
    const argLines = Object.entries(params).map(([name, spec]) => {
      const type = spec?.type ?? 'string';
      const req = required.has(name) ? ' (required)' : '';
      const pdesc = (spec?.description ?? '').split('\n')[0].slice(0, 80);
      return `    ARG ${name}: ${type}${req}${pdesc ? ' — ' + pdesc : ''}`;
    });
    return `- ${f.name}: ${desc}\n${argLines.join('\n')}`;
  }).join('\n');
}

function exampleToolCall(tools) {
  // Build a concrete example from a tool the model is likely to use.
  const byName = {};
  for (const t of tools) { const f = t.function ?? t; byName[f.name] = f; }
  if (byName.bash) {
    return '```tool_call\nTOOL: bash\nARG command: ls -la\nARG description: List files in the current directory\n```';
  }
  const first = (tools[0]?.function ?? tools[0]);
  const firstArg = Object.keys(first?.parameters?.properties ?? {})[0] ?? 'arg';
  return `\`\`\`tool_call\nTOOL: ${first?.name ?? 'tool_name'}\nARG ${firstArg}: value\n\`\`\``;
}

function buildToolPrompt(messages, tools) {
  const sys = [];
  const convo = [];
  const idToName = {};
  const toolNames = new Set((tools ?? []).map(t => (t.function?.name ?? t.name)).filter(Boolean));
  for (const m of messages) {
    if (m.role === 'system') {
      const t = contentToString(m.content).trim();
      if (t) sys.push(t);
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name ?? tc.name ?? 'tool';
          const args = tc.function?.arguments ?? tc.arguments ?? '{}';
          if (tc.id) idToName[tc.id] = name;
          convo.push(`[Assistant called: ${name}]`);
        }
      }
      const c = contentToString(m.content).trim();
      if (c) convo.push(`[Assistant]\n${c}`);
    } else if (m.role === 'tool') {
      const name = idToName[m.tool_call_id] ?? 'tool';
      convo.push(`[Result of ${name}]\n${contentToString(m.content).trim()}`);
    } else {
      const t = contentToString(m.content).trim();
      if (t) convo.push(`[User]\n${t}`);
    }
  }

  let p = '';
  if (sys.length) p += sys.join('\n\n') + '\n\n';

  if (toolNames.size) {
    p += '═══════════════════════════════════════════════════\n';
    p += 'TOOL USE — MANDATORY PROTOCOL (read carefully)\n';
    p += '═══════════════════════════════════════════════════\n';
    p += 'You have NO terminal and NO file access of your own. You CANNOT run\n';
    p += 'commands. Writing a command such as `ls`, `$tree`, or `cat file` as\n';
    p += 'plain text does NOTHING — it is never executed. The ONLY way to take\n';
    p += 'any real action is to output a tool_call block.\n\n';
    p += 'When you need to act, output ONE OR MORE blocks in EXACTLY this format,\n';
    p += 'with no prose before or inside the block:\n\n';
    p += '```tool_call\nTOOL: <tool name from the list>\nARG <argname>: <value>\nARG <argname>: <value>\n```\n\n';
    p += 'Available tools and their arguments:\n';
    p += renderToolsForPrompt(tools) + '\n\n';
    p += 'Example — to list files in the current directory, output exactly:\n';
    p += exampleToolCall(tools) + '\n\n';
    p += 'Rules:\n';
    p += '1. Use the EXACT argument names shown above (e.g. filePath, not path).\n';
    p += '2. To inspect the project, run shell commands via the bash tool.\n';
    p += '3. Emit tool_call blocks directly — do not describe what you "would" run.\n';
    p += '4. After tool results come back, either call more tools or give your\n';
    p += '   final answer in plain text.\n';
    p += '═══════════════════════════════════════════════════\n\n';
  }

  if (convo.length > 1) p += '---\n\n';
  p += convo.join('\n\n');

  if (toolNames.size) {
    p += `\n\n[Reminder] To act, output a \`\`\`tool_call block now. Do NOT type commands as text — they will not run. Available tools: ${[...toolNames].join(', ')}.`;
  }
  return p;
}

// ─── Tool call parsing ──────────────────────────────────────────────────────────

function coerceArgValue(raw) {
  const t = raw.trim();
  if (t === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.parse(t); } catch {}
  }
  return raw.replace(/\s+$/, '');
}

function tryJsonToolCalls(text, toolNames) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  let parsed;
  try { parsed = JSON.parse(t); } catch { return null; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const calls = [];
  for (const c of arr) {
    const name = c?.name ?? c?.tool ?? c?.function;
    if (typeof name !== 'string') return null;
    if (toolNames.size && !toolNames.has(name)) return null;
    calls.push({ name, arguments: c.arguments ?? c.args ?? c.parameters ?? {} });
  }
  return calls.length ? calls : null;
}

const TOOL_LINE_RE = /^\s*(?:TOOL|tool|name)\s*[:=]\s*(.+?)\s*$/;
const ARG_LINE_RE = /^\s*ARG\s+([A-Za-z0-9_.-]+)\s*[:=]\s*(.*)$/;

function parseArgBlock(blockText, toolNames) {
  if (typeof blockText !== 'string') return null;
  const lines = blockText.replace(/\r/g, '').split('\n');

  let name = null;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const mTool = raw.match(TOOL_LINE_RE);
    if (mTool) {
      const n = mTool[1].trim().replace(/[`"',]/g, '');
      if (!toolNames.size || toolNames.has(n)) { name = n; startIdx = i; break; }
    }
    const bare = raw.replace(/[`"',]/g, '').trim();
    if (toolNames.has(bare)) { name = bare; startIdx = i; break; }
  }
  if (!name) return null;

  const args = {};
  let curKey = null;
  let curVal = [];
  const commit = () => {
    if (curKey !== null) args[curKey] = coerceArgValue(curVal.join('\n'));
    curKey = null; curVal = [];
  };
  for (let i = startIdx + 1; i < lines.length; i++) {
    const mArg = lines[i].match(ARG_LINE_RE);
    if (mArg) { commit(); curKey = mArg[1]; curVal = mArg[2] !== '' ? [mArg[2]] : []; continue; }
    if (curKey !== null) curVal.push(lines[i]);
  }
  commit();
  return [{ name, arguments: args }];
}

function extractToolCalls(text, toolNames) {
  if (!text) return null;

  const fenced = [];
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text))) fenced.push(m[1]);

  if (fenced.length) {
    const calls = [];
    for (const block of fenced) {
      const json = tryJsonToolCalls(block, toolNames);
      if (json) { calls.push(...json); continue; }
      const arg = parseArgBlock(block, toolNames);
      if (arg) calls.push(...arg);
    }
    if (calls.length) return calls;
  }

  const json = tryJsonToolCalls(text, toolNames);
  if (json) return json;
  const arg = parseArgBlock(text, toolNames);
  if (arg) return arg;

  return null;
}

// Not exported — included for use within the plugin only.

// ─── SSE transform (streaming pass-through) ─────────────────────────────────────
// Translates Qwen's phase-based SSE to OpenAI chunk format in real time.

function makeChunk(id, created, model, delta, finishReason) {
  return `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  })}\n\n`;
}

function transformQwenSSE(body, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';
  let sentRole = false;
  let sentDone = false;

  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw.startsWith('{"response.created"')) continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        const { phase, status, content } = delta;
        if (phase !== 'answer') continue;

        if (!sentRole) {
          controller.enqueue(encoder.encode(makeChunk(id, created, model, { role: 'assistant', content: '' }, null)));
          sentRole = true;
        }
        if (status === 'finished') {
          controller.enqueue(encoder.encode(makeChunk(id, created, model, {}, 'stop')));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          sentDone = true;
        } else if (content) {
          controller.enqueue(encoder.encode(makeChunk(id, created, model, { content }, null)));
        }
      }
    },
    flush(controller) {
      if (!sentDone) {
        if (!sentRole) {
          controller.enqueue(encoder.encode(makeChunk(id, created, model, { role: 'assistant', content: '' }, null)));
        }
        controller.enqueue(encoder.encode(makeChunk(id, created, model, {}, 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      }
    },
  }));
}

function restitchStream(firstValue, reader) {
  return new ReadableStream({
    start(c) { if (firstValue) c.enqueue(firstValue); },
    async pull(c) {
      const { value, done } = await reader.read();
      if (done) { c.close(); return; }
      c.enqueue(value);
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}); },
  });
}

// ─── Tool mode: stream answer text + detect tool calls at end ───────────────────
// For tool mode we still need the full text to parse tool calls. But we
// ALSO forward content chunks in real time so the user sees progress.
// If tool calls are detected at the end, we re-emit them as synthetic chunks.

function makeToolOrContentResponse(answer, toolNames, model) {
  const calls = extractToolCalls(answer, toolNames);
  if (calls) {
    return toolCallResponseChunks(calls, model);
  }
  return contentResponseChunks(answer, model);
}

// ─── Synthetic chunk builders ───────────────────────────────────────────────────

function sseStreamFrom(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
  });
}

function contentResponseChunks(text, model) {
  if (!text) {
    // Qwen sent empty content — still emit valid SSE so OpenCode doesn't hang
    text = '[empty response]';
  }
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  return [
    makeChunk(id, created, model, { role: 'assistant', content: '' }, null),
    makeChunk(id, created, model, { content: text }, null),
    makeChunk(id, created, model, {}, 'stop'),
    'data: [DONE]\n\n',
  ];
}

function toolCallResponseChunks(calls, model) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const tool_calls = calls.map((c, i) => ({
    index: i,
    id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: {
      name: c.name,
      arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
    },
  }));
  const mk = (delta, finish) => `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
  return [
    mk({ role: 'assistant', tool_calls }, null),
    mk({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ];
}

function toQwenMessage(msg, model) {
  return {
    fid: randomUUID(), parentId: null, childrenIds: [],
    role: msg.role, content: contentToString(msg.content),
    user_action: 'chat', files: [], timestamp: Math.floor(Date.now() / 1000),
    models: [model], chat_type: 't2t',
    feature_config: {
      thinking_enabled: false, output_schema: 'phase', research_mode: 'normal',
      auto_thinking: false, thinking_mode: 'no-thinking', thinking_format: 'summary', auto_search: false,
    },
    extra: { meta: { subChatType: 't2t' } }, sub_chat_type: 't2t',
  };
}

// ─── Main fetch interceptor with account rotation ───────────────────────────────

async function qwenFetch(storedToken, input, init) {
  const url = typeof input === 'string' ? input : input?.url ?? '';
  dbg({ phase: 'qwenFetch', url, hasInit: !!init, method: init?.method ?? 'GET' });
  if (url.endsWith('/models') || url.endsWith('/models/')) {
    dbg({ phase: 'models_list' });
    return new Response(JSON.stringify({
      object: 'list',
      data: Object.entries(MODELS).map(([id, cfg]) => ({
        id, object: 'model', created: 0,
        owned_by: 'qwen',
        name: cfg.name,
        context_length: cfg.context,
        max_output: cfg.output,
      })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  const accounts = collectAccounts(storedToken);
  if (accounts.length === 0) {
    notify('No valid Qwen accounts found. Log into chat.qwen.ai in Firefox.', 'error');
    return new Response(
      JSON.stringify({ error: { message: 'No valid Qwen accounts. Log into chat.qwen.ai in Firefox, or add tokens to ~/.config/opencode/qwen-accounts.json', type: 'auth_error' } }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    );
  }

  let bodyStr = '';
  if (init?.body) bodyStr = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
  else if (input instanceof Request) bodyStr = await input.clone().text();
  let body = {};
  try { body = bodyStr ? JSON.parse(bodyStr) : {}; } catch {} // graceful

  const model = body.model ?? 'qwen3.6-plus';
  const messages = body.messages ?? [];
  const tools = Array.isArray(body.tools) && body.tools.length ? body.tools : null;
  const wantTools = tools && body.tool_choice !== 'none';
  const toolNames = new Set((tools ?? []).map(t => t.function?.name ?? t.name).filter(Boolean));

  const promptText = wantTools ? buildToolPrompt(messages, tools) : buildPrompt(messages);

  dbg({
    phase: 'request', model,
    hasToolsField: Array.isArray(body.tools), nTools: (body.tools ?? []).length,
    toolNames: [...toolNames], tool_choice: body.tool_choice ?? null,
    nMessages: messages.length, lastRole: messages[messages.length - 1]?.role ?? null,
  });
  const userMessage = toQwenMessage({ role: 'user', content: promptText }, model);

  const now = Date.now();
  const state = loadState();
  const { usable, soonestReset } = orderAccounts(accounts, state, now);

  if (usable.length === 0) {
    const mins = Number.isFinite(soonestReset) ? Math.ceil((soonestReset - now) / 60000) : null;
    notify(`All ${accounts.length} account(s) rate-limited${mins != null ? `; reset in ~${mins} min` : ''}.`, 'error');
    return new Response(
      JSON.stringify({ error: { message: `All ${accounts.length} Qwen account(s) are rate-limited${mins != null ? `; next reset in ~${mins} min` : ''}.`, type: 'rate_limit_error' } }),
      { status: 429, headers: { 'content-type': 'application/json' } }
    );
  }

  let lastErr = null;
  for (const account of usable) {
    const { id, token, label } = account;
    const isFailover = lastServedAccountId !== null && lastServedAccountId !== id && lastErr !== null;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('Request timeout')), REQUEST_TIMEOUT_MS);
    let chatId;
    try {
      chatId = await createChatSession(token, model, abort.signal);
    } catch (err) {
      clearTimeout(timer);
      const kind = classifyFailure(err.status ?? 0, err.body ?? err.message);
      if (kind === 'quota' || kind === 'rate_limit') {
        markRateLimited(state, id, kind, now); saveState(state);
        invalidateCache();
        notify(`${label} hit its limit — switching account…`, 'warning');
        lastErr = err; continue;
      }
      lastErr = err; continue;
    }

    let response;
    try {
      response = await fetch(`${QWEN_BASE}/api/v2/chat/completions?chat_id=${chatId}`, {
        method: 'POST',
        signal: abort.signal,
        headers: buildHeaders(token),
        body: JSON.stringify({
          stream: true, version: '2.1', incremental_output: true, chat_id: chatId,
          chat_mode: 'normal', model, parent_id: null,
          messages: [userMessage], timestamp: Math.floor(Date.now() / 1000),
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err; continue;
    }
    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text();
      const kind = classifyFailure(response.status, text);
      if (kind === 'quota' || kind === 'rate_limit') {
        markRateLimited(state, id, kind, now); saveState(state);
        invalidateCache();
        notify(`${label} hit its limit — switching account…`, 'warning');
        lastErr = new Error(`Qwen ${response.status}`); continue;
      }
      return new Response(
        JSON.stringify({ error: { message: `Qwen ${response.status}: ${text.slice(0, 300)}`, type: 'api_error' } }),
        { status: response.status, headers: { 'content-type': 'application/json' } }
      );
    }

    const reader = response.body.getReader();
    const first = await reader.read();
    const firstText = first.value ? new TextDecoder().decode(first.value) : '';
    if (firstChunkLooksExhausted(firstText)) {
      markRateLimited(state, id, 'quota', now); saveState(state);
      invalidateCache();
      notify(`${label} hit its limit — switching account…`, 'warning');
      lastErr = new Error('quota error in stream');
      try { await reader.cancel(); } catch {}
      continue;
    }

    // success
    markUsed(state, id, now); saveState(state);
    if (lastServedAccountId !== id) {
      notify(`Using Qwen account: ${label}`, isFailover ? 'success' : 'info');
      lastServedAccountId = id;
    }

    const baseHeaders = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-qwen-account': id,
    };

    // Tool mode: stream answer text as it arrives, then at the end check for tool calls
    if (wantTools) {
      const answer = await collectAnswerText(first.value, reader);
      const calls = extractToolCalls(answer, toolNames);
      dbg({
        phase: 'tool_response', model,
        emitted: calls ? 'tool_calls' : 'content',
        parsed: calls?.map(c => ({ name: c.name, argKeys: Object.keys(c.arguments ?? {}) })) ?? null,
        answerFull: answer,
      });
      const chunks = calls
        ? toolCallResponseChunks(calls, model)
        : contentResponseChunks(answer, model);
      return new Response(sseStreamFrom(chunks), { status: 200, headers: baseHeaders });
    }

    // Plain chat: stream straight through.
    const stitched = restitchStream(first.value, reader);
    return new Response(transformQwenSSE(stitched, model), { status: 200, headers: baseHeaders });
  }

  notify(`All Qwen accounts failed: ${lastErr?.message ?? 'unknown'}`, 'error');
  return new Response(
    JSON.stringify({ error: { message: `All Qwen accounts failed. Last error: ${lastErr?.message ?? 'unknown'}`, type: 'api_error' } }),
    { status: 502, headers: { 'content-type': 'application/json' } }
  );
}

// ─── Collected answer reader (buffers for tool parsing) ──────────────────────────

async function collectAnswerText(firstValue, reader) {
  const decoder = new TextDecoder();
  let buffer = firstValue ? decoder.decode(firstValue, { stream: true }) : '';
  let answer = '';
  let finished = false;
  const drain = () => {
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw.startsWith('{"response.created"')) continue;
      try {
        const d = JSON.parse(raw).choices?.[0]?.delta;
        if (d?.phase === 'answer') {
          answer += d.content ?? '';
          if (d.status === 'finished') finished = true;
        }
      } catch {}
    }
  };
  drain();
  // Stop as soon as Qwen signals the answer is finished. Waiting for the
  // socket to fully close (the old behavior) caused multi-minute hangs
  // because Qwen frequently holds the connection open after the final token.
  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain();
  }
  // Release the connection so the request doesn't dangle until timeout.
  try { await reader.cancel(); } catch {}
  return answer;
}

function firstChunkLooksExhausted(text) {
  if (!text) return false;
  if (text.includes('"response.created"') || text.includes('"choices"')) return false;
  const b = text.toLowerCase();
  return b.includes('error') && (b.includes('quota') || b.includes('limit') ||
         b.includes('rate') || b.includes('exceed') || b.includes('forbidden'));
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default async function (input) {
  toastClient = input?.client ?? null;
  return {
    auth: {
      provider: PROVIDER_ID,

      loader: async (getAuth) => {
        const auth = await getAuth();
        const storedToken = (auth?.type === 'api' && auth?.key) ? auth.key : null;
        const accounts = collectAccounts(storedToken);
        dbg({ phase: 'loader', accountsFound: accounts.length, authType: auth?.type });
        if (accounts.length === 0) return null;
        return {
          apiKey: accounts[0].token,
          fetch: (input2, init) => qwenFetch(storedToken, input2, init),
        };
      },

      methods: [
        {
          type: 'oauth',
          label: 'Qwen Chat (multi-account, reads Firefox sessions)',
          authorize: async () => {
            const token = getTokenFromFirefox();
            const accounts = collectAccounts(token);
            return {
              url: 'https://chat.qwen.ai',
              instructions: accounts.length
                ? `Found ${accounts.length} Qwen account(s) — authorizing...`
                : 'Log into chat.qwen.ai in Firefox first, then retry',
              method: 'auto',
              callback: async () => {
                const t = getTokenFromFirefox();
                if (!t || !tokenIsValid(t)) return { type: 'failed' };
                return { type: 'success', key: t };
              },
            };
          },
        },
      ],
    },
  };
}
