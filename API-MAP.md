# Qwen Web API — usage map & live validation

This document maps every call `qwen-chat.js` makes against the **real captured traffic**
from `chat.qwen.ai` (HAR captures, 2026-05-30). Use it to confirm the plugin stays
compatible with the live web API and to understand the (small) ways it deliberately
diverges.

Legend: ✅ matches live · 🟡 intentional/benign difference · ⚠️ potential risk

---

## Endpoints the plugin touches

| # | Method | Endpoint | Purpose | Source |
|---|--------|----------|---------|--------|
| 1 | POST | `/api/v2/chats/new` | Create a fresh chat session, get a `chat_id` | `createChatSession()` |
| 2 | POST | `/api/v2/chat/completions?chat_id=<id>` | Stream the model response (SSE) | `qwenFetch()` |

The plugin **only** calls these two real endpoints. It also *intercepts* OpenCode's
OpenAI-style calls locally and never forwards them verbatim:

| Intercepted (OpenAI-style) | Handling |
|---|---|
| `GET .../v1/models` | Answered locally from the `MODELS` table — no network call |
| `POST .../v1/chat/completions` | Translated into endpoints 1 + 2 above |

The live web app also calls `/api/v2/chats/`, `/api/v2/users/status`,
`/api/v2/notifications/latest`, `/api/v2/configs/setting-config`,
`/api/v2/library/list`. **The plugin uses none of these** — they are UI bookkeeping and
are not required to drive a completion.

---

## 1. `POST /api/v2/chats/new`

### Request body

```jsonc
// Plugin (createChatSession)
{ "title": "OpenCode", "models": ["qwen3.6-plus"], "chat_mode": "normal",
  "chat_type": "t2t", "timestamp": 1780171342480, "project_id": "" }

// Live capture
{ "title": "New Chat", "models": ["qwen3.6-plus"], "chat_mode": "normal",
  "chat_type": "t2t", "timestamp": 1780171342480, "project_id": "" }
```

| Field | Plugin | Live | Status |
|---|---|---|---|
| `title` | `"OpenCode"` | `"New Chat"` | 🟡 cosmetic — server stores it, no behavioral effect |
| `models` | `[model]` | `[model]` | ✅ |
| `chat_mode` | `"normal"` | `"normal"` | ✅ |
| `chat_type` | `"t2t"` | `"t2t"` | ✅ |
| `timestamp` | `Date.now()` (ms) | ms | ✅ |
| `project_id` | `""` | `""` | ✅ |

### Response

```json
{ "success": true, "request_id": "…", "data": { "id": "845c4a8e-…" } }
```

Plugin reads `JSON.parse(text).data.id`. ✅ correct path.

---

## 2. `POST /api/v2/chat/completions?chat_id=<id>`

### Request — top level

```jsonc
// Plugin
{ "stream": true, "version": "2.1", "incremental_output": true,
  "chat_id": "<id>", "chat_mode": "normal", "model": "qwen3.6-plus",
  "parent_id": null, "messages": [ <message> ], "timestamp": 1780171343 }

// Live
{ "stream": true, "version": "2.1", "incremental_output": true,
  "chat_id": "<id>", "chat_mode": "normal", "model": "qwen3.6-plus",
  "parent_id": null, "messages": [ <message> ], "timestamp": 1780171343 }
```

Every top-level field matches. ✅ (`timestamp` is seconds here, while `chats/new` uses
milliseconds — the plugin matches the live app on both, which use the same mix.)

### Request — the message object (`toQwenMessage`)

```jsonc
{
  "fid": "<uuid>",
  "parentId": null,
  "childrenIds": [],            // 🟡 live pre-seeds the next assistant id; [] works fine
  "role": "user",
  "content": "<flattened prompt>",
  "user_action": "chat",
  "files": [],
  "timestamp": 1780171342,      // seconds
  "models": ["<model>"],
  "chat_type": "t2t",
  "feature_config": {
    "thinking_enabled": false,  // 🟡 live=true  — plugin disables thinking on purpose
    "output_schema": "phase",   // ✅
    "research_mode": "normal",  // ✅
    "auto_thinking": false,     // 🟡 live=true
    "thinking_mode": "no-thinking", // 🟡 live="Auto"
    "thinking_format": "summary",   // ✅
    "auto_search": false        // 🟡 live=true — plugin disables web search on purpose
  },
  "extra": { "meta": { "subChatType": "t2t" } },
  "sub_chat_type": "t2t"
}
```

The structure is identical to the live web client. The only differences are the
`feature_config` toggles, which are **deliberate**: the plugin turns off thinking and
auto-search to get straight answer tokens with less latency and token cost. Verified that
the server honors these (no thinking phase appears when disabled).

> Note: the plugin collapses the entire OpenAI conversation into the single `content`
> string (with `[System]`/`[User]`/`[Assistant]`/`[Tool Result]` labels) because the web
> endpoint hangs on threaded multi-message input. This is by design, not an API mismatch.

### Response — SSE stream (`text/event-stream`)

Phases and statuses observed live:

| Marker | Values seen | Plugin handling |
|---|---|---|
| `phase` | `thinking_summary`, `answer` | keeps only `phase === "answer"`; drops thinking ✅ |
| `status` | `typing`, `finished` | accumulates `typing`; **stops on `finished`** ✅ |

First event is metadata and is skipped:

```
data: {"response.created":{"chat_id":"…","parent_id":"…","response_id":"…","response_index":"0"}}
```

Plugin skips any line starting with `{"response.created"`. ✅

Content events:

```
data: {"choices":[{"delta":{"role":"assistant","content":"…","phase":"answer","status":"typing"}}],
       "response_id":"…","usage":{…},"timestamp":…}
```

Terminal event (the important one):

```
data: {"choices":[{"delta":{"content":"","role":"assistant","status":"finished","phase":"answer"}}],
       "response_id":"…"}
```

**Qwen never emits `data: [DONE]`.** The stream ends with the `finished` event, and the
underlying socket can stay open afterward. This is exactly why `collectAnswerText` /
`transformQwenSSE` must terminate on `status === "finished"` rather than waiting for the
socket to close — waiting is what caused the multi-minute tool-mode hangs. The plugin
synthesizes its own `[DONE]` for OpenCode. ✅

---

## Headers

`buildHeaders()` vs the live capture for both POSTs:

| Header | Plugin | Live | Status |
|---|---|---|---|
| `User-Agent` | Firefox 151 macOS | identical | ✅ |
| `Accept` | `text/event-stream, application/json, text/plain, */*` | `application/json, text/plain, */*` | 🟡 superset, harmless |
| `Accept-Language` | `en-US,en;q=0.9` | same | ✅ |
| `Content-Type` | `application/json` | same | ✅ |
| `version` | `0.2.60` | `0.2.60` | ✅ (header names are case-insensitive) |
| `source` | `web` | `web` | ✅ |
| `x-request-id` | fresh UUID per call | fresh UUID | ✅ |
| `timezone` | `new Date().toString()` | same format | ✅ |
| `bx-v` | `2.5.36` | `2.5.36` | ✅ |
| `Origin` / `Referer` | `https://chat.qwen.ai` | same host | ✅ |
| `Cookie` | **full jar** replayed from the profile (`token`, `acw_tc`, `cna`, `tfstk`, `ssxmod_*`, …) | same jar | ✅ now matches (manual-file tokens are token-only) |
| `bx-ua` | sent **only if** set in `qwen-accounts.json` | long anti-bot fingerprint blob | 🟡 optional override; see below |
| `bx-umidtoken` | sent **only if** set in `qwen-accounts.json` | `T2gA3…` | 🟡 optional override; see below |

---

## Risk assessment — status

1. ✅ **Full cookie jar now sent.** The plugin replays every `chat.qwen.ai` cookie from the
   profile (`token`, `acw_tc`, `cna`, `tfstk`, `ssxmod_*`, …), so it matches the live client
   and keeps WAF/load-balancer affinity cookies. (Manual tokens from `qwen-accounts.json`
   are token-only, since their jar isn't available.) *Closes the former "minimal cookie
   set" risk.*

2. ✅ **WAF challenges are detected.** `looksLikeWaf()` flags HTML/captcha/`punish`/`x5sec`
   bodies (and 200s that are actually challenge pages); `classifyFailure` returns `waf` and
   the plugin surfaces a distinct `waf_challenge` error instead of misreading it as
   auth/quota — and does **not** fail over (WAF is device/IP-level). *Closes the
   "non-JSON 403 misclassified" risk.*

3. 🟡 **`bx-ua` / `bx-umidtoken` still can't be generated.** They're JS-derived and absent
   from the cookie store. Requests succeed without them **today**. If Qwen starts enforcing
   the anti-bot layer, paste fresh values into `qwen-accounts.json` (top-level `bxUa` /
   `bxUmidToken`) and the plugin attaches them to every request. This is the remaining
   "could break someday" item, now with a built-in mitigation path.

4. ✅ **`usage` is forwarded.** The last Qwen `usage` block is mapped to OpenAI
   `{prompt_tokens, completion_tokens, total_tokens}` and attached to the final chunk
   (streaming, tool, and content paths). OpenCode now shows real token counts. Live-verified
   (`prompt_tokens: 5206, completion_tokens: 1`). Cost stays `0` (free tier).

5. ⚠️ **Rate-limit shape still unverified.** These captures contain only `200`s. The
   failover classifier (`classifyFailure`) keys off HTTP status + body wording
   (`quota`/`exceed`/`limit`/`free`…). If you can capture a real "out of free usage"
   response, validate that the status code and body text match those heuristics and tune
   `markRateLimited()` if not. **(Needs a live 429 capture.)**

6. ℹ️ **`token` is a JWT with a real `exp`** (~7-day life, account `id` claim). The plugin
   parses `exp` and treats the token as dead ~60 s early. A logged-out / rotated Firefox
   session invalidates it immediately — just reload chat.qwen.ai.

---

## What's solid (no action needed)

- Both request bodies match the live web client field-for-field (modulo the deliberate
  `feature_config` and `title` choices).
- Response parsing matches the real phase/status protocol, including the no-`[DONE]`,
  end-on-`finished` behavior.
- Auth via the `token` cookie works exactly as the browser uses it.
- Timestamp units (ms for `chats/new`, seconds inside the completion message) match the
  live app.

---

## Quick re-validation recipe

To re-check after a Qwen update, capture a fresh HAR from chat.qwen.ai (one message),
then compare:

```sh
# list the API calls in a HAR
jq -r '.log.entries[].request | "\(.method) \(.url)"' capture.har | grep /api/

# dump the completions request body + a slice of the SSE response
jq -r '.log.entries[] | select(.request.url|test("chat/completions")) | .request.postData.text' capture.har
jq -r '.log.entries[] | select(.request.url|test("chat/completions")) | .response.content.text' capture.har | head -c 1500
```

Confirm: top-level fields, the message `feature_config`, and that the stream still ends on
`{"status":"finished","phase":"answer"}` with no `[DONE]`.
