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

// ─── Token sources ──────────────────────────────────────────────────────────────

// All Firefox profiles (each profile can be a different Qwen account)
function listFirefoxCookieDbs() {
  const root = join(homedir(), 'Library/Application Support/Firefox/Profiles');
  if (!existsSync(root)) return [];
  let dirs;
  try { dirs = readdirSync(root); } catch { return []; }
  return dirs
    .map(d => join(root, d, 'cookies.sqlite'))
    .filter(p => existsSync(p));
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
    const t = readTokenFromCookieDb(db, i);
    if (t) out.push({ token: t, source: `firefox:${i}` });
  });
  return out;
}

// Optional manual accounts file: { "tokens": ["eyJ...", "eyJ..."] }  (or a bare array)
function readAccountsFileTokens() {
  try {
    if (!existsSync(ACCOUNTS_FILE)) return [];
    const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.tokens) ? raw.tokens : [];
    return list
      .map(t => (typeof t === 'string' ? t : t?.token))
      .filter(Boolean)
      .map(token => ({ token, source: 'file' }));
  } catch { return []; }
}

// Single backwards-compatible Firefox token (used by the login flow)
function getTokenFromFirefox() {
  const dbs = listFirefoxCookieDbs();
  for (let i = 0; i < dbs.length; i++) {
    const t = readTokenFromCookieDb(dbs[i], i);
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
    ...(storedToken ? [{ token: storedToken, source: 'stored' }] : []),
  ];

  const byId = new Map();
  for (const { token, source } of raw) {
    if (!tokenIsValid(token)) continue;
    const id = accountIdOf(token);
    const exp = jwtExpiry(token) ?? 0;
    const existing = byId.get(id);
    if (!existing || exp > existing.exp) byId.set(id, { id, token, exp, source });
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
  // Quota exhaustion → assume daily reset (UTC midnight). Transient 429 → short cooldown.
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

// Usable accounts, least-recently-used first; plus soonest reset if none usable.
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

// Inspect the first SSE chunk for an embedded quota/limit error (no answer yet).
function firstChunkLooksExhausted(text) {
  if (!text) return false;
  if (text.includes('"response.created"') || text.includes('"choices"')) return false; // normal start
  const b = text.toLowerCase();
  return b.includes('error') && (b.includes('quota') || b.includes('limit') ||
         b.includes('rate') || b.includes('exceed') || b.includes('forbidden'));
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

// Re-prepend an already-read first chunk to the rest of the reader's stream.
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
  const userMessage = toQwenMessage({ role: 'user', content: flattenConversation(messages) }, model);

  const now = Date.now();
  const state = loadState();
  const { usable, soonestReset } = orderAccounts(accounts, state, now);

  if (usable.length === 0) {
    const mins = Number.isFinite(soonestReset) ? Math.ceil((soonestReset - now) / 60000) : null;
    return new Response(
      JSON.stringify({ error: { message: `All ${accounts.length} Qwen account(s) are rate-limited${mins != null ? `; next reset in ~${mins} min` : ''}. Add another account to ~/.config/opencode/qwen-accounts.json or log into another account in a separate Firefox profile.`, type: 'rate_limit_error' } }),
      { status: 429, headers: { 'content-type': 'application/json' } }
    );
  }

  let lastErr = null;
  for (const account of usable) {
    const { id, token } = account;

    // 1) create chat session
    let chatId;
    try {
      chatId = await createChatSession(token, model);
    } catch (err) {
      const kind = classifyFailure(err.status ?? 0, err.body ?? err.message);
      if (kind === 'quota' || kind === 'rate_limit') {
        markRateLimited(state, id, kind, now); saveState(state);
        lastErr = err; continue; // rotate
      }
      lastErr = err; continue; // transient — try next account too
    }

    // 2) completions (streaming)
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
        lastErr = new Error(`Qwen ${response.status}`); continue; // rotate
      }
      return new Response(
        JSON.stringify({ error: { message: `Qwen ${response.status}: ${text.slice(0, 300)}`, type: 'api_error' } }),
        { status: response.status, headers: { 'content-type': 'application/json' } }
      );
    }

    // 3) peek first chunk for an embedded quota/limit error
    const reader = response.body.getReader();
    const first = await reader.read();
    const firstText = first.value ? new TextDecoder().decode(first.value) : '';
    if (firstChunkLooksExhausted(firstText)) {
      markRateLimited(state, id, 'quota', now); saveState(state);
      lastErr = new Error('quota error in stream'); 
      try { await reader.cancel(); } catch {}
      continue; // rotate
    }

    // success — record usage and stream
    markUsed(state, id, now); saveState(state);
    const stitched = restitchStream(first.value, reader);
    return new Response(transformQwenSSE(stitched, model), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
        'x-qwen-account': id, // debugging: which account served the request
      },
    });
  }

  return new Response(
    JSON.stringify({ error: { message: `All Qwen accounts failed. Last error: ${lastErr?.message ?? 'unknown'}`, type: 'api_error' } }),
    { status: 502, headers: { 'content-type': 'application/json' } }
  );
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default async function (_input) {
  return {
    auth: {
      provider: PROVIDER_ID,

      loader: async (getAuth) => {
        const auth = await getAuth();
        const storedToken = (auth?.type === 'api' && auth?.key) ? auth.key : null;
        const accounts = collectAccounts(storedToken);
        if (accounts.length === 0) return null;
        return {
          apiKey: accounts[0].token, // primary; rotation happens inside fetch
          fetch: (input, init) => qwenFetch(storedToken, input, init),
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
