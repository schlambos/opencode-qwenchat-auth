# opencode-qwenchat-auth

Use **Qwen** models in [OpenCode](https://opencode.ai) for free by piggy-backing on your
existing **chat.qwen.ai** browser session — no API key, no OAuth, no DashScope billing.

This plugin reads your active `chat.qwen.ai` session token straight from your local
**Firefox** cookie store and translates between OpenCode's OpenAI-style requests and
Qwen's internal web chat API. It adds two things Qwen's web backend doesn't give you on
its own: **multi-account failover** and a **prompt-based tool-calling shim** so agentic
Build mode works.

> **Why this exists:** Qwen's official OAuth device-flow endpoint
> (`/api/v1/oauth2/token`) currently returns `504 Gateway Time-out` for many regions,
> which breaks the conventional OAuth plugins. The web chat backend
> (`/api/v2/chat/completions`), however, works fine — so this plugin uses that instead.

---

## How it works

```
┌────────────┐   OpenAI-style    ┌─────────────────┐   Qwen v2 web API   ┌──────────────┐
│  OpenCode  │ ───────────────▶  │  qwen-chat.js   │ ──────────────────▶ │ chat.qwen.ai │
│  (TUI/CLI) │ ◀───────────────  │   (this plugin) │ ◀────────────────── │   backend    │
└────────────┘   SSE deltas      └─────────────────┘   SSE (phase data)  └──────────────┘
                                          │
                                          │ reads session token
                                          ▼
                                 ~/Library/.../Firefox
                                   cookies.sqlite
```

1. **Auth** — On `opencode auth login`, the plugin reads the `token` cookie for
   `*.qwen.ai` from Firefox's `cookies.sqlite`. No token is ever typed or stored by you.
2. **Per request** — It re-reads the freshest token from Firefox (cached briefly, and
   treated as expired ~1 min before the JWT `exp`), so as long as you stay logged in to
   chat.qwen.ai in Firefox, it keeps working. Token expiry is parsed from the JWT itself.
   It replays the **full cookie jar** for the profile (`token`, `acw_tc`, `cna`, `tfstk`,
   `ssxmod_*`, …), matching the real browser client and preserving WAF/load-balancer
   affinity cookies.
3. **Request translation** — Qwen's web endpoint hangs on multi-message threaded input,
   so the plugin **collapses the OpenAI conversation into a single user message** per
   request — but it preserves structure by labeling each turn (`[System]`, `[User]`,
   `[Assistant]`, `[Tool Result]`). It then creates a fresh chat session
   (`/api/v2/chats/new`) and posts to `/api/v2/chat/completions`.
4. **Response translation** — Qwen streams custom SSE events with `thinking` and `answer`
   phases. The plugin drops the thinking phase and re-emits the `answer` phase as standard
   OpenAI `chat.completion.chunk` deltas, stopping as soon as Qwen signals `finished` and
   ending with `[DONE]`. Plain chat streams token-by-token; tool turns are buffered (see
   below).

### Security

- **No credentials are stored by the plugin or this repo.** The token lives only in your
  browser; the plugin reads it at runtime.
- The cookie DB is copied to a temp file before reading (Firefox locks the live DB).
- `.gitignore` blocks `*.har`, `*.sqlite`, `*token*`, `.env`, and similar from ever being
  committed. **Never commit a HAR capture or cookie file — they contain your live session.**
- Optional diagnostic logging is **off by default** and only writes when a flag file
  (`~/.config/opencode/qwen-chat-debug`) exists. When enabled it logs full prompts to
  `~/.config/opencode/qwen-chat-debug.log` (rotated at 1 MB) — delete the flag file to
  disable.

---

## Prerequisites

- [OpenCode](https://opencode.ai) installed
- **Firefox**, logged in to <https://chat.qwen.ai>
- `sqlite3` on your `PATH` (preinstalled on macOS)
- macOS (paths below are macOS; see notes for other OSes)

---

## How-to: install

1. **Drop the plugin** into your OpenCode plugins directory (auto-loaded at startup):

   ```sh
   mkdir -p ~/.config/opencode/plugins
   curl -fsSL https://raw.githubusercontent.com/schlambos/opencode-qwenchat-auth/main/qwen-chat.js \
     -o ~/.config/opencode/plugins/qwen-chat.js
   ```

2. **Register the provider** in `~/.config/opencode/opencode.jsonc` (add the `qwen-chat`
   block under `provider`):

   ```jsonc
   {
     "provider": {
       "qwen-chat": {
         "npm": "@ai-sdk/openai-compatible",
         "name": "Qwen Chat",
         "options": {
           "baseURL": "https://chat.qwen.ai/v1",
           "compatibility": "compatible"
         },
         "models": {
           "qwen3.6-plus":        { "name": "Qwen3.6 Plus",        "limit": { "context": 1000000, "output": 65536 }, "cost": { "input": 0, "output": 0 } },
           "qwen3.7-max":         { "name": "Qwen3.7 Max",         "limit": { "context": 1000000, "output": 65536 }, "cost": { "input": 0, "output": 0 } },
           "qwen3.6-max-preview": { "name": "Qwen3.6 Max Preview", "limit": { "context": 262144,  "output": 65536 }, "cost": { "input": 0, "output": 0 } },
           "qwen3.5-plus":        { "name": "Qwen3.5 Plus",        "limit": { "context": 1000000, "output": 65536 }, "cost": { "input": 0, "output": 0 } },
           "qwen3.5-flash":       { "name": "Qwen3.5 Flash",       "limit": { "context": 1000000, "output": 65536 }, "cost": { "input": 0, "output": 0 } },
           "qwen3.6-27b":         { "name": "Qwen3.6 27B",         "limit": { "context": 262144,  "output": 65536 }, "cost": { "input": 0, "output": 0 } }
         }
       }
     }
   }
   ```

3. **Log in to chat.qwen.ai in Firefox** (if you aren't already).

4. **Authenticate OpenCode:**

   ```sh
   opencode auth login
   ```

   - Select **Other**
   - Provider id: `qwen-chat`
   - Choose **Qwen Chat (multi-account, reads Firefox sessions)**
   - It authorizes automatically from your Firefox session(s).

5. **Use it:**

   ```sh
   opencode --provider qwen-chat --model qwen3.6-plus
   ```

   Or pick a Qwen model from the model switcher in the TUI.

> **Note:** plugin changes only take effect on a fresh OpenCode start. Restart the TUI
> after installing or updating `qwen-chat.js`.

---

## How-to: keep it working

- Stay logged in to chat.qwen.ai in Firefox. When Firefox's session token rotates, the
  plugin picks up the new one automatically on the next request.
- If you get a `401`/auth error, just reload chat.qwen.ai in Firefox and retry.

### Troubleshooting: WAF challenges

If requests start failing with a `waf_challenge` error (*"Qwen anti-bot (WAF) challenge…"*),
Qwen's Aliyun WAF has flagged the traffic. This is **not** a quota or account problem, and
switching accounts won't help (it's device/IP-level). Fix it by:

1. Open <https://chat.qwen.ai> in Firefox and send a message — solve any captcha.
2. Reload the page so fresh affinity cookies (`acw_tc`, `tfstk`, …) are written; the plugin
   picks them up automatically.
3. If it still fails, capture `bx-ua` and `bx-umidtoken` from a real browser request and add
   them to `qwen-accounts.json` (see [Optional: anti-bot headers](#optional-anti-bot-headers-bx-ua--bx-umidtoken)).

---

## Models

| Model ID | Context | Notes |
|---|---|---|
| `qwen3.6-plus` | 1M | Default, well-rounded |
| `qwen3.7-max` | 1M | Most capable — best for agentic/tool work |
| `qwen3.6-max-preview` | 256K | Preview flagship |
| `qwen3.5-plus` | 1M | Solid general model |
| `qwen3.5-flash` | 1M | Fastest |
| `qwen3.6-27b` | 256K | Open-weight dense |

Model IDs match chat.qwen.ai's internal names and may change as Qwen updates them.

> Models are addressed as `qwen-chat/<model>` (e.g. `qwen-chat/qwen3.6-plus`).

---

## Tool calling

Qwen's web API has **no native function/tool calling**, so agentic Build mode would
normally fail. This plugin adds a **prompt-based tool-call shim**:

1. When OpenCode sends a `tools` array, the plugin injects a forceful protocol into the
   prompt — the full tool list **with per-argument schemas**, a worked example, and a
   reminder — and instructs the model to reply with a fenced block using an
   **escaping-free `ARG` format**:

   ````
   ```tool_call
   TOOL: bash
   ARG command: find . -type f -name "*.js" | awk '{printf "%s\n", $0}'
   ARG description: list js files
   ```
   ````

   Values are written **verbatim** — no JSON string escaping. The plugin serializes them
   with `JSON.stringify`, so the `arguments` it emits to OpenCode are **always valid JSON**.
   (Raw JSON tool-call blocks are still accepted as a fallback.)
2. The parsed call is emitted as OpenAI `tool_calls` (`finish_reason: "tool_calls"`), so
   OpenCode executes the tool normally.
3. Prior `tool_calls` / `tool` result messages are rendered back into the prompt
   (`[Assistant]` / `[Tool Result]`) so the model sees the loop across turns.
4. Plain chat (no `tools`) streams normally; tool turns are buffered (needed to parse the
   call before emitting it).

The injected protocol shows exact argument names (e.g. `filePath`, not `path`) and a
concrete example, which is what makes smaller models actually emit tool calls instead of
narrating shell commands as plain text. The parser is forgiving — it scans every fenced
block **and** the raw text, and accepts the tool name as `TOOL: bash`, `name: bash`, or a
bare `bash` line.

**Model note:** `qwen3.7-max` follows the protocol cleanly. `qwen3.6-plus` works but is
weaker and may occasionally prepend stray text; prefer `qwen3.7-max` for heavy agentic use.

**Caveats:** tool turns lose token-by-token streaming (buffered to parse); one tool call
per block in `ARG` mode (multiple calls still supported via a JSON array, or multiple
blocks); deeply nested object args rely on the model writing valid JSON on the value line.

---

## Multi-account failover

When one Qwen account hits its free-usage limit, the plugin automatically fails over to
another account so you keep working.

### Where accounts come from

The plugin collects candidate accounts from **two** sources and de-duplicates them by the
account id embedded in each session JWT:

1. **Every Firefox profile** — log a different Qwen account into each Firefox profile
   (`about:profiles` → *Create a New Profile*), and each profile's `cookies.sqlite` is read.
2. **A manual accounts file** — `~/.config/opencode/qwen-accounts.json`. Accepts either a
   bare array or a `{ "tokens": [...] }` object, and each entry may be a raw token string
   or `{ "token": "...", "label": "...", "bxUa": "...", "bxUmidToken": "..." }`:

   ```json
   { "tokens": ["<token-cookie-account-1>", "<token-cookie-account-2>"] }
   ```

   Manual tokens are sent token-only (no jar), since the extra cookies live in the browser
   profile, not the file. See [`qwen-accounts.example.json`](./qwen-accounts.example.json).
   **Never commit this file** — it holds live session tokens (the `.gitignore` already
   blocks it).

### Optional: anti-bot headers (`bx-ua` / `bx-umidtoken`)

Qwen sits behind an Aliyun WAF. Today the cookie/`token` auth is enough, but if Qwen
starts enforcing its anti-bot layer you'll see WAF challenges (see [Troubleshooting]
(#troubleshooting-waf-challenges)). As a hedge you can capture those two request headers
from a real browser request (devtools → Network → a `chat.qwen.ai` request → Request
Headers) and add them top-level in `qwen-accounts.json`:

```json
{ "tokens": ["…"], "bxUa": "<bx-ua value>", "bxUmidToken": "<bx-umidtoken value>" }
```

When present they're attached to every request. They can also be set per-account on an
object-form entry.

### How rotation works

- Per-account rate-limit state is tracked in `~/.config/opencode/qwen-accounts-state.json`
  (account id + cooldown timestamp only — no tokens).
- On each request the plugin picks the **least-recently-used** account that isn't cooling
  down.
- A request fails over to the next account when it detects exhaustion via `classifyFailure`:
  - HTTP `429` with no quota wording → **transient rate limit** → 60-second cooldown.
  - HTTP `429/403/401` whose body mentions quota/limit/exceeded/insufficient/free → **quota**
    → cooldown until the next **UTC midnight** (matching Qwen's daily free-tier reset).
  - HTTP `401/403` without quota wording → treated as an **auth** error (no failover).
  - a quota/limit error in the first SSE chunk before any answer text → quota cooldown.
- If **all** accounts are cooling down, you get a `429` telling you when the soonest one
  resets.
- The response includes an `x-qwen-account` header showing which account served it.

### Toast notifications

The plugin shows OpenCode toast notifications so you always know which account is active:

- **info** — "Using Qwen account: `<label>`" the first time an account serves you (labels
  are the Firefox profile name, e.g. *Firefox: default-release*, or a name you set in the
  accounts file).
- **warning** — "`<label>` hit its limit — switching account…" on a failover.
- **success** — "Using Qwen account: `<label>`" after a successful failover to a new account.
- **error** — when all accounts are rate-limited or every account failed.

Notifications only fire when the active account *changes*, so normal back-to-back messages
stay quiet.

### Limitations of failover

- Detection heuristics are best-effort — Qwen's exact "out of free usage" response isn't
  publicly documented, so classification keys off HTTP status + body/SSE text scanning.
- Quota cooldown assumes a daily UTC reset; tune in `markRateLimited()` if Qwen differs.
- Firefox only stores one live session per profile, so multiple accounts require multiple
  profiles and/or the accounts file.

---

## Limitations

- **Single prompt per request:** the conversation is collapsed into one role-labeled prompt
  per request (Qwen's web API hangs on threaded multi-message input). Long histories cost
  more tokens but work fine.
- **Tool calling is prompt-based, not native:** reliability depends on the model following
  the injected protocol (see [Tool calling](#tool-calling)).
- **Text only:** image/audio passthrough is not implemented.
- **Token usage** is forwarded to OpenCode (mapped from Qwen's `usage` block), so token
  counts are reported; cost stays `0` since the web tier is free.
- **Firefox only:** reads from Firefox's cookie store. Chrome/Safari would need a
  different cookie path and decryption (PRs welcome).
- **Unofficial:** this uses Qwen's private web API. It can break if Qwen changes it, and
  you are responsible for complying with Qwen's terms of service.

---

## Other browsers / OSes

The cookie DB path is hard-coded for macOS Firefox:
`~/Library/Application Support/Firefox/Profiles/<profile>/cookies.sqlite`.

- **Linux:** `~/.mozilla/firefox/<profile>/cookies.sqlite`
- **Windows:** `%APPDATA%\Mozilla\Firefox\Profiles\<profile>\cookies.sqlite`

Edit `listFirefoxCookieDbs()` in `qwen-chat.js` for your platform.

---

<details>
<summary><b>🤖 Agent install instructions (click to expand)</b></summary>

If you are an AI coding agent installing this plugin on the user's machine, follow these
steps exactly. Do **not** print, log, or commit any token, cookie, or HAR file.

**1. Install the plugin file**

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/schlambos/opencode-qwenchat-auth/main/qwen-chat.js \
  -o ~/.config/opencode/plugins/qwen-chat.js
```

If `curl` is unavailable or offline, write the contents of `qwen-chat.js` from this repo
to `~/.config/opencode/plugins/qwen-chat.js` verbatim.

**2. Register the provider** in `~/.config/opencode/opencode.jsonc`

Merge (do not overwrite) a `qwen-chat` entry into the top-level `provider` object using
the JSON block from the "How-to: install" section above. Preserve all existing providers,
plugins, and config. The file may be JSONC (comments allowed).

**3. Verify the plugin loads (no secrets in output)**

```sh
node --input-type=module --eval "
import p from '$HOME/.config/opencode/plugins/qwen-chat.js';
const h = await p({});
console.log('provider:', h.auth.provider);
console.log('methods:', h.auth.methods.map(m => m.type + ' / ' + m.label));
"
```

Expect `provider: qwen-chat` and one `oauth` method. Do not print token values.

**4. Confirm prerequisites with the user**

- Firefox is installed and they are logged in to <https://chat.qwen.ai>.
- `sqlite3` is on PATH (`which sqlite3`).

**5. Tell the user to authenticate**

Instruct them to run `opencode auth login`, choose **Other**, enter `qwen-chat`, and
select **Qwen Chat (multi-account, reads Firefox sessions)**. It authorizes automatically.
Remind them to restart the TUI so the plugin loads.

**6. Safety checks**

- Before any `git add`/commit, run a secret scan and abort if it matches:
  `rg -i "eyJ|Bearer |token=ey|cookies\.sqlite" <staged files>`
- Ensure `.gitignore` blocks `*.har`, `*.sqlite`, `*token*`, `.env`.
- Never commit `~/.config/opencode/opencode.jsonc` (contains the user's full config).

</details>

---

## License

MIT
