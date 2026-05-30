import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

const QWEN_BASE = 'https://chat.qwen.ai';
const PROVIDER_ID = 'qwen-chat';

const ACCOUNTS_FILE = join(homedir(), '.config', 'opencode', 'qwen-accounts.json');
const STATE_FILE = join(homedir(), '.config', 'opencode', 'qwen-accounts-state.json');

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

// All Firefox profiles (each profile can be a different Qwen account).
// Returns [{ path, label }] where label is a friendly profile name.
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

// Optional manual accounts file:
//   { "tokens": ["eyJ...", { "token": "eyJ...", "label": "work" }] }   (or a bare array)
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

// Single backwards-compatible Firefox token (used by the login flow)
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

// Gather all candidate accounts, dedup by account id, keep the freshest token per id.
function collectAccounts(storedToken) {
  if (accountsCache && Date.now() - accountsCacheTime < 30_000) return accountsCache;

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

// ─── Per-account rate-limit state (persisted) ───────────────────────────────────

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
  entry.rateLimitedUntil = kind === 'quota' ? nextUtcMidnight(now) : now + 15 * 60 * 1000;
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
function firstChunkLooksExhausted(text) {
  if (!text) return false;
  if (text.includes('"response.created"') || text.includes('"choices"')) return false;
  const b = text.toLowerCase();
  return b.includes('error') && (b.includes('quota') || b.includes('limit') ||
         b.includes('rate') || b.includes('exceed') || b.includes('forbidden'));
}

// ─── Toast notifications ─────────────────────────────────────────────────────────

let toastClient = null;        // set from plugin input
let lastServedAccountId = null; // only notify on change

function notify(message, variant = 'info', title = 'Qwen Chat') {
  try {
    toastClient?.tui?.showToast({ body: { title, message, variant, duration: 4000 } })?.catch?.(() => {});
  } catch { /* toasts are best-effort */ }
}

// ─── Request helpers ───────────────────────────────────────────────────────────

function buildHeaders(token, extra = {}) {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0',
    'Accept': 'application/json, text/plain, */*',
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

async function createChatSession(token, model) {
  const res = await fetch(`${QWEN_BASE}/api/v2/chats/new`, {
    method: 'POST',
    headers: buildHeaders(token),
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

function flattenConversation(messages) {
  const systemParts = [];
  const convoParts = [];
  for (const m of messages) {
    const text = contentToString(m.content).trim();
    if (!text) continue;
    if (m.role === 'system') systemParts.push(text);
    else if (m.role === 'assistant') convoParts.push(`Assistant: ${text}`);
    else if (m.role === 'tool') convoParts.push(`Tool result: ${text}`);
    else convoParts.push(`User: ${text}`);
  }
  let prompt = '';
  if (systemParts.length) prompt += systemParts.join('\n\n') + '\n\n';
  if (convoParts.length > 1) prompt += '--- Conversation so far ---\n\n';
  prompt += convoParts.join('\n\n');
  return prompt;
}

// ─── Tool-call shim (experimental) ──────────────────────────────────────────────
// Qwen's web API has no native function calling. We inject a text protocol: the model
// emits a fenced ```tool_call JSON block, which we parse back into OpenAI tool_calls.

function renderToolsForPrompt(tools) {
  return tools.map(t => {
    const f = t.function ?? t;
    const props = JSON.stringify(f.parameters?.properties ?? {});
    const required = (f.parameters?.required ?? []).join(', ');
    return `- ${f.name}: ${(f.description ?? '').split('\n')[0]}\n    parameters: ${props}${required ? `\n    required: [${required}]` : ''}`;
  }).join('\n');
}

// Build the flattened prompt, rendering tool_calls / tool results and the protocol.
function buildToolPrompt(messages, tools) {
  const sys = [];
  const convo = [];
  const idToName = {};
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
          convo.push(`Assistant called tool: ${name}(${typeof args === 'string' ? args : JSON.stringify(args)})`);
        }
      }
      const c = contentToString(m.content).trim();
      if (c) convo.push(`Assistant: ${c}`);
    } else if (m.role === 'tool') {
      const name = idToName[m.tool_call_id] ?? 'tool';
      convo.push(`Tool result from ${name}:\n${contentToString(m.content).trim()}`);
    } else {
      const t = contentToString(m.content).trim();
      if (t) convo.push(`User: ${t}`);
    }
  }

  let p = '';
  if (sys.length) p += sys.join('\n\n') + '\n\n';
  if (tools?.length) {
    p += '# Tool-calling protocol\n\n';
    p += 'You can call tools to complete the task. Available tools:\n\n';
    p += renderToolsForPrompt(tools) + '\n\n';
    p += 'To call a tool, reply with ONLY a fenced block, nothing before or after it:\n\n';
    p += '```tool_call\n';
    p += 'TOOL: <tool_name>\n';
    p += 'ARG <arg_name>: <value>\n';
    p += 'ARG <arg_name>: <value>\n';
    p += '```\n\n';
    p += 'Rules:\n';
    p += '- Each `ARG` line gives one argument. A value may span multiple lines; it continues until the next `ARG` line or the end of the block.\n';
    p += '- Write values LITERALLY. Do NOT escape quotes, backslashes, or newlines. Shell commands are written exactly as you would type them.\n';
    p += '- For numbers, booleans, arrays, or objects, write them as JSON on the value line (e.g. `ARG limit: 100` or `ARG paths: ["a","b"]`).\n\n';
    p += 'Example — read a file:\n';
    p += '```tool_call\nTOOL: read\nARG path: src/index.ts\n```\n\n';
    p += 'Example — run a shell command (note the quotes are written as-is, NOT escaped):\n';
    p += '```tool_call\nTOOL: bash\nARG command: find . -type f | awk \'{printf "%s\\n", $0}\'\nARG description: list files\n```\n\n';
    p += 'After each call you receive a "Tool result" message — continue calling tools as needed.\n';
    p += 'When the task is complete, reply normally with your final answer and NO tool_call block.\n\n';
  }
  if (convo.length > 1) p += '--- Conversation so far ---\n\n';
  p += convo.join('\n\n');
  if (tools?.length) p += '\n\nRespond now with either a tool_call block or your final answer.';
  return p;
}

// Coerce a raw value string into JSON when it looks structured, else keep as string.
function coerceArgValue(raw) {
  const t = raw.trim();
  if (t === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.parse(t); } catch { /* keep raw */ }
  }
  return raw.replace(/\s+$/, '');
}

// Try to parse a block as JSON tool call(s). Returns calls array or null.
function tryJsonToolCalls(text, toolNames) {
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

// Parse one block using the escaping-free ARG format, tolerating loose model output:
// the tool name may be `TOOL: name`, `name:`, or just a bare line equal to a known tool.
function parseArgBlock(blockText, toolNames) {
  const lines = blockText.replace(/\r/g, '').split('\n');

  // Locate the tool-name line.
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

// Extract tool call(s) from the model's output. Scans every fenced block plus the raw
// text, accepting JSON or the loose ARG format with/without fence and TOOL: prefix.
function extractToolCalls(text, toolNames) {
  if (!text) return null;
  const blocks = [];
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text))) blocks.push(m[1]);
  blocks.push(text); // whole-text fallback (model may omit the fence)

  for (const block of blocks) {
    const json = tryJsonToolCalls(block, toolNames);
    if (json) return json;
    const arg = parseArgBlock(block, toolNames);
    if (arg) return arg;
  }
  return null;
}

export { extractToolCalls };

// Read the entire Qwen SSE stream, returning the concatenated 'answer' phase text.
async function collectAnswerText(firstValue, reader) {
  const decoder = new TextDecoder();
  let buffer = firstValue ? decoder.decode(firstValue, { stream: true }) : '';
  let answer = '';
  const drain = () => {
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw.startsWith('{"response.created"')) continue;
      try {
        const d = JSON.parse(raw).choices?.[0]?.delta;
        if (d?.phase === 'answer' && d.content) answer += d.content;
      } catch {}
    }
  };
  drain();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain();
  }
  return answer;
}

function sseStreamFrom(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
  });
}

function contentResponseChunks(text, model) {
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

// ─── SSE transformation ────────────────────────────────────────────────────────

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
    cancel(reason) { reader.cancel(reason); },
  });
}

// ─── Main fetch interceptor with account rotation ───────────────────────────────

async function qwenFetch(storedToken, input, init) {
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
  try { body = bodyStr ? JSON.parse(bodyStr) : {}; } catch { /* ignore */ }

  const model = body.model ?? 'qwen3.6-plus';
  const messages = body.messages ?? [];
  const tools = Array.isArray(body.tools) && body.tools.length ? body.tools : null;
  const wantTools = tools && body.tool_choice !== 'none';
  const toolNames = new Set((tools ?? []).map(t => t.function?.name ?? t.name).filter(Boolean));
  const promptText = wantTools ? buildToolPrompt(messages, tools) : flattenConversation(messages);
  const userMessage = toQwenMessage({ role: 'user', content: promptText }, model);

  const now = Date.now();
  const state = loadState();
  const { usable, soonestReset } = orderAccounts(accounts, state, now);

  if (usable.length === 0) {
    const mins = Number.isFinite(soonestReset) ? Math.ceil((soonestReset - now) / 60000) : null;
    notify(`All ${accounts.length} account(s) rate-limited${mins != null ? `; reset in ~${mins} min` : ''}.`, 'error');
    return new Response(
      JSON.stringify({ error: { message: `All ${accounts.length} Qwen account(s) are rate-limited${mins != null ? `; next reset in ~${mins} min` : ''}. Add another account to ~/.config/opencode/qwen-accounts.json or log into another account in a separate Firefox profile.`, type: 'rate_limit_error' } }),
      { status: 429, headers: { 'content-type': 'application/json' } }
    );
  }

  let lastErr = null;
  for (const account of usable) {
    const { id, token, label } = account;
    const isFailover = lastServedAccountId !== null && lastServedAccountId !== id && lastErr !== null;

    let chatId;
    try {
      chatId = await createChatSession(token, model);
    } catch (err) {
      const kind = classifyFailure(err.status ?? 0, err.body ?? err.message);
      if (kind === 'quota' || kind === 'rate_limit') {
        markRateLimited(state, id, kind, now); saveState(state);
        notify(`${label} hit its limit — switching account…`, 'warning');
        lastErr = err; continue;
      }
      lastErr = err; continue;
    }

    let response;
    try {
      response = await fetch(`${QWEN_BASE}/api/v2/chat/completions?chat_id=${chatId}`, {
        method: 'POST',
        headers: buildHeaders(token, { 'accept': 'application/json', 'x-accel-buffering': 'no' }),
        body: JSON.stringify({
          stream: true, version: '2.1', incremental_output: true, chat_id: chatId,
          chat_mode: 'normal', model, parent_id: null,
          messages: [userMessage], timestamp: Math.floor(Date.now() / 1000),
        }),
      });
    } catch (err) { lastErr = err; continue; }

    if (!response.ok) {
      const text = await response.text();
      const kind = classifyFailure(response.status, text);
      if (kind === 'quota' || kind === 'rate_limit') {
        markRateLimited(state, id, kind, now); saveState(state);
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
      'x-accel-buffering': 'no',
      'x-qwen-account': id,
    };

    // Tool mode: buffer the full answer, parse for a tool_call, emit OpenAI tool_calls or content.
    if (wantTools) {
      const answer = await collectAnswerText(first.value, reader);
      const calls = extractToolCalls(answer, toolNames);
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
