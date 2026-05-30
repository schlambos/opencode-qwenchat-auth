import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, copyFileSync, readdirSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

const QWEN_BASE = 'https://chat.qwen.ai';
const PROVIDER_ID = 'qwen-chat';

const MODELS = {
  'qwen3.6-plus':        { name: 'Qwen3.6 Plus',        context: 1_000_000, output: 65536 },
  'qwen3.7-max':         { name: 'Qwen3.7 Max',          context: 1_000_000, output: 65536 },
  'qwen3.6-max-preview': { name: 'Qwen3.6 Max Preview',  context:   262_144, output: 65536 },
  'qwen3.5-plus':        { name: 'Qwen3.5 Plus',         context: 1_000_000, output: 65536 },
  'qwen3.5-flash':       { name: 'Qwen3.5 Flash',        context: 1_000_000, output: 65536 },
  'qwen3.6-27b':         { name: 'Qwen3.6 27B',          context:   262_144, output: 65536 },
};

// ─── Firefox cookie reader ─────────────────────────────────────────────────────

function findFirefoxCookiesDb() {
  const profilesRoot = join(homedir(), 'Library/Application Support/Firefox/Profiles');
  if (!existsSync(profilesRoot)) return null;
  let dirs;
  try { dirs = readdirSync(profilesRoot); } catch { return null; }
  const preferred = dirs.find(d => d.endsWith('.default-release')) ?? dirs.find(d => d.includes('default')) ?? dirs[0];
  if (!preferred) return null;
  const dbPath = join(profilesRoot, preferred, 'cookies.sqlite');
  return existsSync(dbPath) ? dbPath : null;
}

function getTokenFromFirefox() {
  try {
    const dbPath = findFirefoxCookiesDb();
    if (!dbPath || !existsSync(dbPath)) return null;
    const tmp = join(tmpdir(), 'qwen-ff-cookies-snap.sqlite');
    copyFileSync(dbPath, tmp);
    const result = execSync(
      `sqlite3 "${tmp}" "SELECT value FROM moz_cookies WHERE host LIKE '%.qwen.ai' AND name='token' ORDER BY lastAccessed DESC LIMIT 1;"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

// ─── JWT helpers ───────────────────────────────────────────────────────────────

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

function tokenIsValid(token) {
  if (!token) return false;
  const exp = jwtExpiry(token);
  if (!exp) return true;
  return Date.now() < exp - 60_000;
}

let cachedToken = null;
let cacheExpiry = 0;

function getLiveToken(storedToken) {
  if (cachedToken && Date.now() < cacheExpiry && tokenIsValid(cachedToken)) return cachedToken;
  const ffToken = getTokenFromFirefox();
  if (ffToken && tokenIsValid(ffToken)) {
    cachedToken = ffToken;
    const exp = jwtExpiry(ffToken);
    cacheExpiry = exp ? exp - 5 * 60 * 1000 : Date.now() + 60 * 60 * 1000;
    return cachedToken;
  }
  if (storedToken && tokenIsValid(storedToken)) {
    cachedToken = storedToken;
    const exp = jwtExpiry(storedToken);
    cacheExpiry = exp ? exp - 5 * 60 * 1000 : Date.now() + 60 * 60 * 1000;
    return cachedToken;
  }
  return null;
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
      title: 'OpenCode',
      models: [model],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create chat session: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.data.id;
}

function contentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text ?? '').join('');
  return String(content ?? '');
}

// Qwen's /chat/completions hangs on multi-message threaded input.
// Flatten the entire OpenAI conversation into ONE user message per request.
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
    fid: randomUUID(),
    parentId: null,
    childrenIds: [],
    role: msg.role,
    content: contentToString(msg.content),
    user_action: 'chat',
    files: [],
    timestamp: Math.floor(Date.now() / 1000),
    models: [model],
    chat_type: 't2t',
    feature_config: {
      thinking_enabled: false,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: false,
      thinking_mode: 'no-thinking',
      thinking_format: 'summary',
      auto_search: false,
    },
    extra: { meta: { subChatType: 't2t' } },
    sub_chat_type: 't2t',
  };
}

// ─── SSE transformation ────────────────────────────────────────────────────────

function makeChunk(id, created, model, delta, finishReason) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
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

// ─── Main fetch interceptor ───────────────────────────────────────────────────

async function qwenFetch(storedToken, input, init) {
  const token = getLiveToken(storedToken);
  if (!token) {
    return new Response(
      JSON.stringify({ error: { message: 'No valid Qwen token. Log into chat.qwen.ai in Firefox.', type: 'auth_error' } }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    );
  }

  let bodyStr = '';
  if (init?.body) {
    bodyStr = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
  } else if (input instanceof Request) {
    bodyStr = await input.clone().text();
  }

  let body = {};
  try { body = bodyStr ? JSON.parse(bodyStr) : {}; } catch { /* ignore */ }

  const model = body.model ?? 'qwen3.6-plus';
  const messages = body.messages ?? [];

  let chatId;
  try {
    chatId = await createChatSession(token, model);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: err.message, type: 'api_error' } }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  const response = await fetch(`${QWEN_BASE}/api/v2/chat/completions?chat_id=${chatId}`, {
    method: 'POST',
    headers: buildHeaders(token, { 'accept': 'application/json', 'x-accel-buffering': 'no' }),
    body: JSON.stringify({
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model,
      parent_id: null,
      messages: [toQwenMessage({ role: 'user', content: flattenConversation(messages) }, model)],
      timestamp: Math.floor(Date.now() / 1000),
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    return new Response(
      JSON.stringify({ error: { message: `Qwen ${response.status}: ${errText.slice(0, 300)}`, type: 'api_error' } }),
      { status: response.status, headers: { 'content-type': 'application/json' } }
    );
  }

  return new Response(transformQwenSSE(response.body, model), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    },
  });
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default async function (_input) {
  return {
    auth: {
      provider: PROVIDER_ID,

      loader: async (getAuth) => {
        const auth = await getAuth();
        const ffToken = getTokenFromFirefox();
        const storedToken = (auth?.type === 'api' && auth?.key) ? auth.key : null;
        const token = (ffToken && tokenIsValid(ffToken)) ? ffToken : storedToken;
        if (!token) return null;
        return {
          apiKey: token,
          fetch: (input, init) => qwenFetch(storedToken, input, init),
        };
      },

      methods: [
        {
          type: 'oauth',
          label: 'Qwen Chat (reads session from Firefox)',
          authorize: async () => {
            const token = getTokenFromFirefox();
            return {
              url: 'https://chat.qwen.ai',
              instructions: token
                ? 'Firefox session found — authorizing automatically...'
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
