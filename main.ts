import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as url from "node:url";

let _rng_state: number = 0;
(function initRng() {
  const seed = process.env.MAKEFUN_TRIAL_SEED ?? "0";
  const n = parseInt(seed, 10);
  if (!Number.isNaN(n)) _rng_state = n;
  else {
    let s = 0;
    for (let i = 0; i < seed.length; i++) s += seed.charCodeAt(i);
    _rng_state = s;
  }
})();
function drand(): number {
  _rng_state = (1103515245 * _rng_state + 12345) & 0x7fffffff;
  return _rng_state / 0x7fffffff;
}
function nowStr(): string {
  return process.env.MAKEFUN_TRIAL_NOW ?? "";
}
function logErr(msg: any): void {
  try { process.stderr.write(String(msg) + "\n"); } catch {}
}

// ---------- Brief parsing ----------
function readBrief(): string | null {
  const p = process.env.MAKEFUN_PROMPT_FILE;
  if (!p) return null;
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    logErr(`brief read error: ${e}`);
    return null;
  }
}

function kvPairs(s: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  const re = /([A-Za-z0-9_.-]+)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const k = m[1].trim().toLowerCase();
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    pairs[k] = v;
  }
  return pairs;
}


function extractSchemaJson(text: string, schema: string): any {
  const marker = '{"schema":"' + schema + '"';
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  let depth = 0;
  for (let i = idx; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(idx, i + 1)); } catch { return null; } } }
  }
  return null;
}

function parseBrief(text: string | null): any {
  const parsedObj: any = {};
  const providers: Record<string, any> = {};
  const models: any[] = [];
  if (!text) return { providers, models };
  const lines = text.split(/\r?\n/);
  let curProv: any = null;
  function flushProv() {
    if (curProv && curProv.id) providers[curProv.id] = curProv;
    curProv = null;
  }
  let provSection = false;
  let modelSection = false;
  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx].trim();
    if (!l) continue;
    const ll = l.toLowerCase();
    if (/\bproviders?\b/.test(ll)) { provSection = true; modelSection = false; flushProv(); continue; }
    if (/\bquality\b.*\btable\b|\bmodels?\b.*\btable\b|\bsealed\b/.test(ll)) { flushProv(); provSection = false; modelSection = true; continue; }
    if (/\bworkload\b/.test(ll)) { flushProv(); provSection = false; modelSection = false; continue; }
    const pairs = kvPairs(l);
    if (provSection || ("wire" in pairs && ("base" in pairs || "base_url" in pairs || "baseurl" in pairs))) {
      const pid = pairs["id"] || pairs["provider"] || pairs["provider_id"];
      if (pid) {
        if (curProv && curProv.id && curProv.id !== pid) flushProv();
        if (!curProv) curProv = {};
        curProv.id = pid;
      }
      if (curProv === null && pid) curProv = { id: pid };
      if (curProv !== null) {
        if ("name" in pairs) curProv.name = pairs["name"];
        if ("wire" in pairs) curProv.wire = pairs["wire"];
        if ("auth" in pairs || "auth_scheme" in pairs) curProv.auth = pairs["auth"] || pairs["auth_scheme"];
        const base = pairs["base"] || pairs["base_url"] || pairs["baseurl"] || pairs["url"];
        if (base) curProv.base_url = base.replace(/\/+$/, "");
        if ("key_env" in pairs || "keyenv" in pairs || "key_var" in pairs || "env" in pairs) {
          curProv.key_env = pairs["key_env"] || pairs["keyenv"] || pairs["key_var"] || pairs["env"];
        }
        if ("key" in pairs && !("key_env" in pairs) && !("keyenv" in pairs)) {
          if (pairs["key"] === pairs["key"].toUpperCase() || pairs["key"].includes("API_KEY")) curProv.key_env = pairs["key"];
          else curProv.key_value = pairs["key"];
        }
        if ("key_value" in pairs || "keyvalue" in pairs || "value" in pairs) {
          curProv.key_value = pairs["key_value"] || pairs["keyvalue"] || pairs["value"];
        }
      }
    }
    if (modelSection) {
      const mid = pairs["model"] || pairs["id"] || pairs["model_id"];
      const prov = pairs["provider"] || pairs["prov"];
      if (mid && prov) {
        const bval = (x: any) => x != null && ["1","true","yes","y","on"].includes(String(x).toLowerCase());
        let rating = 0; try { rating = parseFloat(pairs["rating"] || pairs["score"] || "0"); } catch {}
        let ctx = 0; try { ctx = parseInt(pairs["context"] || pairs["context_length"] || pairs["ctx"] || "0", 10) || 0; } catch {}
        models.push({
          id: mid, provider: prov, rating, context_length: ctx,
          tools: bval(pairs["tools"]),
          images: bval(pairs["images"] || pairs["vision"]),
          json: bval(pairs["json"]),
        });
      } else {
        const parts = l.split(/[|,\t]+/).map(p => p.trim()).filter(Boolean);
        if (parts.length >= 4 && !/^(model|provider|rating)/.test(ll)) {
          try {
            const rating = parseFloat(parts[2]);
            const ctx = parseInt(parts[3].replace(/[^0-9]/g, "") || "0", 10);
            const flags = (parts.slice(4).join(" ")).toLowerCase();
            models.push({
              id: parts[0], provider: parts[1], rating, context_length: ctx,
              tools: flags.includes("tool"),
              images: flags.includes("image") || flags.includes("vision"),
              json: flags.includes("json"),
            });
          } catch {}
        }
      }
    }
  }
  flushProv();
  if (Object.keys(providers).length === 0) {
    const blocks = text.split(/\n\s*\n/);
    for (const b of blocks) {
      const pairs = kvPairs(b.replace(/\n/g, " "));
      const pid = pairs["id"] || pairs["provider"];
      const base = pairs["base"] || pairs["base_url"] || pairs["baseurl"];
      const wire = pairs["wire"];
      if (pid && (base || wire)) {
        providers[pid] = {
          id: pid, name: pairs["name"] || pid, wire: wire || "openai",
          auth: pairs["auth"] || pairs["auth_scheme"] || "bearer",
          base_url: (base || "").replace(/\/+$/, ""),
          key_env: pairs["key_env"] || pairs["keyenv"] || "",
          key_value: pairs["key_value"] || pairs["keyvalue"] || pairs["key"] || "",
        };
      }
    }
  }
  const pj = extractSchemaJson(text, "free-model-aggregator-01/providers/v1");
  if (pj && Array.isArray(pj.providers)) {
    for (const p of pj.providers) {
      providers[p.id] = { id: p.id, name: p.name, wire: p.wire, auth: p.auth, key_env: p.key_env, key: p.key, base_url: p.path || p.base_url || "" };
    }
  }
  const rj = extractSchemaJson(text, "free-model-aggregator-01/ratings/v1");
  if (rj && Array.isArray(rj.ratings)) {
    models.length = 0;
    for (const m of rj.ratings) {
      models.push({ id: m.model, provider: m.provider, rating_milli: m.rating_milli, context_length: m.context_length, tools: !!m.tools, vision: !!m.vision, json: !!m.json, free: m.free !== false });
    }
  }
  const wj = extractSchemaJson(text, "free-model-aggregator-01/workload/v1");
  if (wj && Array.isArray(wj.manifest)) {
    (parsedObj as any).manifest = wj.manifest;
  }


  return { providers, models };
}

function buildCatalog(parsed: any): any {
  const provs: any[] = [];
  const byProv: Record<string, any[]> = {};
  for (const m of (parsed.models || [])) {
    const pid = m.provider;
    if (!byProv[pid]) byProv[pid] = [];
    byProv[pid].push(m);
  }
  for (const pid of Object.keys(parsed.providers || {})) {
    const p = parsed.providers[pid];
    const mlist: any[] = [];
    for (const m of (byProv[pid] || [])) {
      mlist.push({ id: m.id, free: true, context_length: Math.trunc(m.context_length || 0) });
    }
    provs.push({ id: pid, base_url: p.base_url || "", key_env: p.key_env || "", wire: p.wire || "openai", models: mlist });
  }
  const seen = new Set(provs.map(p => p.id));
  for (const pid of Object.keys(byProv)) {
    if (!seen.has(pid)) {
      provs.push({
        id: pid, base_url: "", key_env: "", wire: "openai",
        models: byProv[pid].map(m => ({ id: m.id, free: true, context_length: Math.trunc(m.context_length || 0) }))
      });
    }
  }
  return { providers: provs };
}

// ---------- HTTP helpers ----------
function httpJson(method: string, targetUrl: string, body: any, headers: any, timeoutMs: number): Promise<{status:number, ct:string, raw:Buffer}> {
  return new Promise((resolve) => {
    try {
      const u = new url.URL(targetUrl);
      const isHttps = u.protocol === "https:";
      const lib = isHttps ? https : http;
      const hdrs: any = Object.assign({}, headers || {});
      let data: Buffer | null = null;
      if (body !== null && body !== undefined) {
        data = Buffer.from(JSON.stringify(body), "utf8");
        if (!hdrs["Content-Type"] && !hdrs["content-type"]) hdrs["Content-Type"] = "application/json";
      }
      const opts: any = { method, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, headers: hdrs };
      const req = lib.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => resolve({ status: res.statusCode || 0, ct: String(res.headers["content-type"] || ""), raw: Buffer.concat(chunks) }));
      });
      req.on("error", (e) => resolve({ status: 0, ct: "", raw: Buffer.from(String(e), "utf8") }));
      req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} resolve({ status: 0, ct: "", raw: Buffer.from("timeout", "utf8") }); });
      if (data) req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, ct: "", raw: Buffer.from(String(e), "utf8") });
    }
  });
}

// ---------- Provider helpers ----------
function getProviderKey(p: any): string {
  const envn = p.key_env;
  if (envn) {
    const v = process.env[envn];
    if (v) return v;
  }
  if (p.key_value) return String(p.key_value);
  if (p.key) return String(p.key);
  return "";
}
function authHeaders(p: any): any {
  const auth = String(p.auth || "bearer").toLowerCase();
  const key = getProviderKey(p);
  const h: any = {};
  if (!key || auth === "none") return h;
  if (auth === "bearer") h["Authorization"] = `Bearer ${key}`;
  else if (auth === "x-api-key") h["x-api-key"] = key;
  else if (auth === "x-goog-api-key" || auth === "goog" || auth === "google") h["x-goog-api-key"] = key;
  else h["Authorization"] = `Bearer ${key}`;
  return h;
}

// ---------- Translations ----------
function openaiToAnthropicMessages(messages: any[]): {system: string, out: any[]} {
  const sysParts: string[] = [];
  const out: any[] = [];
  for (const m of (messages || [])) {
    const role = m.role;
    const content = m.content;
    if (role === "system") {
      if (Array.isArray(content)) sysParts.push(content.filter((c:any)=>c.type==="text").map((c:any)=>c.text||"").join(""));
      else sysParts.push(content || "");
      continue;
    }
    if (role === "tool") {
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content ?? "" }] });
      continue;
    }
    if (role === "assistant" && m.tool_calls) {
      const blocks: any[] = [];
      if (content) {
        if (typeof content === "string") blocks.push({ type: "text", text: content });
        else if (Array.isArray(content)) blocks.push(...content);
      }
      for (const tc of (m.tool_calls || [])) {
        const fn = tc.function || {};
        let args = fn.arguments ?? "{}";
        let inp: any;
        try { inp = typeof args === "string" ? JSON.parse(args) : args; } catch { inp = { _raw: args }; }
        blocks.push({ type: "tool_use", id: tc.id, name: fn.name, input: inp });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    const arole = role === "user" ? "user" : "assistant";
    if (Array.isArray(content)) {
      const blocks: any[] = [];
      for (const c of content) {
        if (c.type === "text") blocks.push({ type: "text", text: c.text || "" });
        else if (c.type === "image_url") {
          const u = (c.image_url || {}).url || "";
          const dm = /^data:([^;]+);base64,(.+)$/.exec(u);
          if (dm) blocks.push({ type: "image", source: { type: "base64", media_type: dm[1], data: dm[2] } });
          else blocks.push({ type: "image", source: { type: "url", url: u } });
        } else blocks.push(c);
      }
      out.push({ role: arole, content: blocks });
    } else {
      out.push({ role: arole, content: content ?? "" });
    }
  }
  return { system: sysParts.filter(Boolean).join("\n"), out };
}

function anthropicToOpenaiResponse(aresp: any, model: string): any {
  const contentBlocks = aresp.content || [];
  let text = "";
  const toolCalls: any[] = [];
  for (const b of contentBlocks) {
    if (b.type === "text") text += b.text || "";
    if (b.type === "tool_use") {
      toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
    }
  }
  const msg: any = { role: "assistant", content: text ? text : (toolCalls.length ? null : "") };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  const stop = aresp.stop_reason;
  const finish = stop === "end_turn" ? "stop" : stop === "max_tokens" ? "length" : stop === "tool_use" ? "tool_calls" : "stop";
  const usage = aresp.usage || {};
  const pt = usage.input_tokens || 0, ct = usage.output_tokens || 0;
  return {
    id: aresp.id || "chatcmpl-x", object: "chat.completion", created: 0, model,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct }
  };
}

function openaiToAnthropicResponse(oresp: any, model: string): any {
  const choice = (oresp.choices || [{}])[0];
  const msg = choice.message || {};
  const finish = choice.finish_reason;
  const stop = finish === "stop" ? "end_turn" : finish === "length" ? "max_tokens" : finish === "tool_calls" ? "tool_use" : "end_turn";
  const blocks: any[] = [];
  if (msg.content) blocks.push({ type: "text", text: msg.content });
  for (const tc of (msg.tool_calls || [])) {
    const fn = tc.function || {};
    let args = fn.arguments ?? "{}";
    let inp: any;
    try { inp = typeof args === "string" ? JSON.parse(args) : args; } catch { inp = { _raw: args }; }
    blocks.push({ type: "tool_use", id: tc.id, name: fn.name, input: inp });
  }
  const usage = oresp.usage || {};
  return {
    id: oresp.id || "msg_x", type: "message", role: "assistant", model, content: blocks,
    stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 }
  };
}

function openaiMsgsToGemini(messages: any[]): {sysInstr: string | null, contents: any[]} {
  const contents: any[] = [];
  let sysInstr: string | null = null;
  for (const m of (messages || [])) {
    const role = m.role;
    const content = m.content;
    if (role === "system") {
      if (typeof content === "string") sysInstr = content;
      else if (Array.isArray(content)) sysInstr = content.filter((c:any)=>c.type==="text").map((c:any)=>c.text||"").join("");
      else sysInstr = String(content || "");
      continue;
    }
    const grole = (role === "user" || role === "tool") ? "user" : "model";
    const parts: any[] = [];
    if (typeof content === "string") parts.push({ text: content });
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === "text") parts.push({ text: c.text || "" });
        else if (c.type === "image_url") {
          const u = (c.image_url || {}).url || "";
          const dm = /^data:([^;]+);base64,(.+)$/.exec(u);
          if (dm) parts.push({ inlineData: { mimeType: dm[1], data: dm[2] } });
        }
      }
    }
    if ((m as any).tool_calls) {
      for (const tc of ((m as any).tool_calls || [])) {
        const fn = tc.function || {};
        let args: any = {};
        try { args = JSON.parse(fn.arguments || "{}"); } catch {}
        parts.push({ functionCall: { name: fn.name, args } });
      }
    }
    if (role === "tool") {
      // convert tool message into functionResponse part
      parts.length = 0;
      let data: any = content;
      try { data = typeof content === "string" ? JSON.parse(content) : content; } catch {}
      parts.push({ functionResponse: { name: String((m as any).name || (m as any).tool_call_id || "tool"), response: { result: data } } });
    }
    if (parts.length) contents.push({ role: grole, parts });
  }
  return { sysInstr, contents };
}

function geminiToOpenaiResponse(gresp: any, model: string): any {
  const cands = gresp.candidates || [{}];
  const cand = cands[0] || {};
  const parts = ((cand.content || {}).parts || []);
  let text = "";
  for (const p of parts) { if (typeof p.text === "string") text += p.text; }
  const msg = { role: "assistant", content: text };
  const um = gresp.usageMetadata || {};
  const pt = um.promptTokenCount || 0, ct = um.candidatesTokenCount || 0;
  return {
    id: "chatcmpl-gem", object: "chat.completion", created: 0, model,
    choices: [{ index: 0, message: msg, finish_reason: "stop" }],
    usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct }
  };
}
function geminiToAnthropicResponse(gresp: any, model: string): any {
  return openaiToAnthropicResponse(geminiToOpenaiResponse(gresp, model), model);
}

// ---------- Selection ----------
function requestRequirements(body: any, api: string): any {
  const req = { tools: false, vision: false, json: false };
  if (api === "openai") {
    if (body.tools || body.tool_choice || body.functions) req.tools = true;
    const rf = body.response_format || {};
    if (rf && typeof rf === "object" && (rf.type === "json_object" || rf.type === "json_schema")) req.json = true;
    for (const m of (body.messages || [])) {
      const c = m.content;
      if (Array.isArray(c)) {
        for (const p of c) {
          if (p.type === "image_url" || p.type === "image" || p.type === "input_image") req.vision = true;
        }
      }
    }
  } else {
    if (body.tools) req.tools = true;
    for (const m of (body.messages || [])) {
      const c = m.content;
      if (Array.isArray(c)) {
        for (const p of c) if (p.type === "image") req.vision = true;
      }
    }
  }
  return req;
}

function selectModels(parsed: any, reqs: any): any[] {
  const strict: any[] = [];
  const loose: any[] = [];
  const providers = parsed.providers || {};
  for (const m of (parsed.models || [])) {
    if (m.free === false) continue;
    const p = providers[m.provider];
    if (!p) continue;
    const meets = (!reqs.tools || m.tools) && (!reqs.vision || m.vision) && (!reqs.json || m.json);
    const arr = meets ? strict : loose;
    if (REFUSED_PROVIDERS.has(String(p.id)) && arr === strict) continue;
    arr.push([m, p]);
  }
  const cmp = (a: any, b: any) => {
    const ra = Number(a[0].rating_milli || a[0].rating || 0), rb = Number(b[0].rating_milli || b[0].rating || 0);
    if (rb !== ra) return rb - ra;
    return String(a[0].id || "").localeCompare(String(b[0].id || ""));
  };
  strict.sort(cmp); loose.sort(cmp);
  return strict.length ? strict : loose;
}

// ---------- Provider call ----------
async function callProvider(p: any, modelId: string, reqApi: string, reqBody: any, stream: boolean): Promise<{wire:string, resp:{status:number,ct:string,raw:Buffer}}> {
  const wire = String(p.wire || "openai").toLowerCase();
  const rawBase = String(p.base_url || "").replace(/\/+$/, "");
  const envBase = String(process.env.MAKEFUN_ENV_URL || "").replace(/\/+$/, "");
  const base = rawBase.startsWith("/") ? envBase + rawBase : rawBase;
  const headers = authHeaders(p);
  const timeout = 60000;
  if (wire === "anthropic") {
    const target = base + "/v1/messages";
    let body: any;
    if (reqApi === "openai") {
      const { system, out } = openaiToAnthropicMessages(reqBody.messages || []);
      body = { model: modelId, messages: out, max_tokens: reqBody.max_tokens || 1024, stream: !!stream };
      const astops: any = reqBody.stop_sequences || (Array.isArray(reqBody.stop) ? reqBody.stop : (reqBody.stop ? [reqBody.stop] : null));
      if (astops) body.stop_sequences = astops;
      if (system) body.system = system;
      if (reqBody.tools) {
        const tools: any[] = [];
        for (const t of (reqBody.tools || [])) {
          const fn = t.function || t;
          tools.push({ name: fn.name, description: fn.description || "", input_schema: fn.parameters || { type: "object", properties: {} } });
        }
        body.tools = tools;
      }
    } else {
      body = Object.assign({}, reqBody); body.model = modelId; body.stream = !!stream;
      if (body.max_tokens == null) body.max_tokens = 1024;
    }
    headers["anthropic-version"] = "2023-06-01";
    return { wire: "anthropic", resp: await httpJson("POST", target, body, headers, timeout) };
  } else if (wire === "gemini") {
    const mEnc = encodeURIComponent(modelId);
    const target = stream
      ? `${base}/v1beta/models/${mEnc}:streamGenerateContent?alt=sse`
      : `${base}/v1beta/models/${mEnc}:generateContent`;
    let body: any;
    const body_tools_gemini: any[] = [];
    const gcfg: any = {};
    if (reqBody.max_tokens != null) gcfg.maxOutputTokens = reqBody.max_tokens;
    const stops: any = reqBody.stop_sequences || (Array.isArray(reqBody.stop) ? reqBody.stop : (reqBody.stop ? [reqBody.stop] : null));
    if (stops) gcfg.stopSequences = stops;
    const gdecls: any[] = [];
    for (const t of (reqBody.tools || [])) {
      const fn = t.function || t;
      gdecls.push({ name: fn.name, description: fn.description || "", parameters: fn.parameters || fn.input_schema || { type: "object", properties: {} } });
    }
    for (const gd of gdecls) body_tools_gemini.push(gd);
    if (reqApi === "openai") {
      const conv = openaiMsgsToGemini(reqBody.messages || [], true);
      body = { contents: conv.contents };
      if (conv.sysInstr) body.systemInstruction = { parts: [{ text: conv.sysInstr }] };
    } else {
      const msgs: any[] = [];
      for (const m of (reqBody.messages || [])) {
        const role = m.role === "user" ? "user" : "model";
        const c = m.content;
        const parts: any[] = [];
        if (typeof c === "string") parts.push({ text: c });
        else if (Array.isArray(c)) for (const b of (c || [])) {
          if (b.type === "text") parts.push({ text: b.text || "" });
          else if (b.type === "image") {
            const src = b.source || {};
            if (src.type === "base64") parts.push({ inlineData: { mimeType: src.media_type || "image/png", data: src.data || "" } });
          } else if (b.type === "tool_result") {
            parts.push({ functionResponse: { name: String(b.tool_use_id || "tool"), response: { result: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "") } } });
          }
        }
        if (m.role === "assistant" && Array.isArray(m.content) === false && (m as any).tool_calls) {
          for (const tc of ((m as any).tool_calls || [])) {
            const fn = tc.function || {};
            let args: any = {};
            try { args = JSON.parse(fn.arguments || "{}"); } catch {}
            parts.push({ functionCall: { name: fn.name, args } });
          }
        }
        if (parts.length) msgs.push({ role, parts });
      }
      body = { contents: msgs };
      const sys = (reqBody.system || "");
      if (sys) body.systemInstruction = { parts: [{ text: typeof sys === "string" ? sys : JSON.stringify(sys) }] };
    }
    if (body_tools_gemini.length) body.tools = body_tools_gemini;
    if (Object.keys(gcfg).length) body.generationConfig = gcfg;
    return { wire: "gemini", resp: await httpJson("POST", target, body, headers, timeout) };
  } else {
    const target = base + "/v1/chat/completions";
    let body: any;
    if (reqApi === "openai") {
      body = Object.assign({}, reqBody); body.model = modelId; body.stream = !!stream;
    } else {
      const msgs: any[] = [];
      const sys = reqBody.system;
      if (sys) msgs.push({ role: "system", content: typeof sys === "string" ? sys : "" });
      for (const m of (reqBody.messages || [])) {
        const role = m.role;
        const c = m.content;
        if (typeof c === "string") {
          msgs.push({ role, content: c });
        } else {
          let parts: any[] | null = [];
          for (const b of (c || [])) {
            if (b.type === "text") parts!.push({ type: "text", text: b.text || "" });
            else if (b.type === "image") {
              const src = b.source || {};
              if (src.type === "base64") parts!.push({ type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data || ""}` } });
            } else if (b.type === "tool_result") {
              msgs.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content ?? "" });
              parts = null; break;
            }
          }
          if (parts !== null) msgs.push({ role, content: parts.length ? parts : "" });
        }
      }
      body = { model: modelId, messages: msgs, stream: !!stream, max_tokens: reqBody.max_tokens || 1024 };
      if (reqBody.stop_sequences) body.stop = reqBody.stop_sequences;
      if (reqBody.tools) {
        const tools: any[] = [];
        for (const t of (reqBody.tools || [])) {
          tools.push({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } });
        }
        body.tools = tools;
      }
    }
    return { wire: "openai", resp: await httpJson("POST", target, body, headers, timeout) };
  }
}

function sseToJson(wire: string, raw: Buffer): any | null {
  const txt = raw.toString("utf8");
  const objs: any[] = [];
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { objs.push(JSON.parse(payload)); } catch {}
  }
  if (!objs.length) return null;
  if (wire === "gemini") {
    const merged: any = { candidates: [], usageMetadata: {} };
    for (const o of objs) {
      for (const c of (o.candidates || [])) {
        let target = merged.candidates[c.index || 0];
        if (!target) { target = { index: c.index || 0, content: { parts: [], role: c.content && c.content.role }, finishReason: c.finishReason }; merged.candidates[c.index || 0] = target; }
        for (const p of ((c.content || {}).parts || [])) target.content.parts.push(p);
        if (c.finishReason) target.finishReason = c.finishReason;
      }
      const um = o.usageMetadata || {};
      for (const k of Object.keys(um)) {
        if (typeof um[k] === "number") merged.usageMetadata[k] = (merged.usageMetadata[k] || 0) + um[k];
        else merged.usageMetadata[k] = um[k];
      }
    }
    merged.candidates = merged.candidates.filter(Boolean);
    return merged;
  }
  if (wire === "openai") {
    const first = objs[0];
    const out: any = { id: first.id, object: "chat.completion", model: first.model, choices: [], usage: first.usage || {} };
    for (const o of objs) {
      for (const ch of (o.choices || [])) {
        const i = ch.index || 0;
        let c = out.choices[i];
        if (!c) { c = { index: i, message: { role: "assistant", content: "", tool_calls: [] }, finish_reason: null }; out.choices[i] = c; }
        const d = ch.delta || {};
        if (d.content) c.message.content += d.content;
        if (d.reasoning_content) c.message.reasoning_content = String(c.message.reasoning_content || "") + d.reasoning_content;
        for (const tc of (d.tool_calls || [])) {
          const ti = tc.index != null ? tc.index : c.message.tool_calls.length;
          let t2 = c.message.tool_calls[ti];
          if (!t2) { t2 = { id: tc.id || "", type: tc.type || "function", function: { name: "", arguments: "" } }; c.message.tool_calls[ti] = t2; }
          if (tc.id) t2.id = tc.id;
          if (tc.function && tc.function.name) t2.function.name += tc.function.name;
          if (tc.function && tc.function.arguments) t2.function.arguments += tc.function.arguments;
        }
        if (ch.finish_reason) c.finish_reason = ch.finish_reason;
      }
      if (o.usage) out.usage = o.usage;
    }
    out.choices = out.choices.filter(Boolean);
    for (const c of out.choices) if (!c.message.tool_calls.length) delete c.message.tool_calls;
    return out;
  }
  if (wire === "anthropic") {
    const out: any = { id: "", type: "message", role: "assistant", model: "", content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } };
    const blocks: any = {};
    for (const o of objs) {
      if (o.type === "message_start" && o.message) { out.id = o.message.id || ""; out.model = o.message.model || ""; if (o.message.usage) out.usage.input_tokens = o.message.usage.input_tokens || 0; }
      if (o.type === "content_block_start") { blocks[o.index] = { type: o.content_block && o.content_block.type, text: "", name: o.content_block && o.content_block.name, id: o.content_block && o.content_block.id, input: "" }; }
      if (o.type === "content_block_delta") { const b = blocks[o.index]; if (b) { if (o.delta && o.delta.type === "text_delta") b.text += o.delta.text || ""; else if (o.delta && o.delta.type === "input_json_delta") b.input += o.delta.partial_json || ""; } }
      if (o.type === "message_delta" && o.delta) { out.stop_reason = o.delta.stop_reason || out.stop_reason; if (o.usage) out.usage.output_tokens = o.usage.output_tokens || 0; }
    }
    for (const k of Object.keys(blocks).sort((a, b) => Number(a) - Number(b))) {
      const b = blocks[k];
      if (b.type === "text" || b.type === "thinking") out.content.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") { let inp: any = {}; try { inp = JSON.parse(b.input || "{}"); } catch {} out.content.push({ type: "tool_use", id: b.id, name: b.name, input: inp }); }
    }
    return out;
  }
  return null;
}

function normalizeResponse(wire: string, status: number, ct: string, raw: Buffer, targetApi: string, modelId: string): {norm:any|null, err:string|null} {
  if (status < 200 || status >= 300) return { norm: null, err: `status ${status}: ${raw.toString("utf8").slice(0,200)}` };
  let data: any;
  if (String(ct || "").includes("text/event-stream")) {
    data = sseToJson(wire, raw);
    if (!data) return { norm: null, err: "empty SSE" };
  } else {
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch (e) {
      data = sseToJson(wire, raw);
      if (!data) return { norm: null, err: `decode error: ${e}` };
    }
  }
  if (wire === "openai") {
    if (targetApi === "openai") return { norm: data, err: null };
    else return { norm: openaiToAnthropicResponse(data, modelId), err: null };
  } else if (wire === "anthropic") {
    if (targetApi === "anthropic") return { norm: data, err: null };
    else return { norm: anthropicToOpenaiResponse(data, modelId), err: null };
  } else if (wire === "gemini") {
    if (targetApi === "openai") return { norm: geminiToOpenaiResponse(data, modelId), err: null };
    else return { norm: geminiToAnthropicResponse(data, modelId), err: null };
  }
  return { norm: null, err: "unknown wire" };
}

// ---------- SSE synthesis ----------
function* sseOpenaiFromResponse(resp: any, model: string): Generator<string> {
  const rid = resp.id || "chatcmpl-x";
  const created = resp.created ?? 0;
  const choice = (resp.choices || [{}])[0];
  const msg = choice.message || {};
  const fin = choice.finish_reason || "stop";
  const roleChunk = { id: rid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] };
  yield `data: ${JSON.stringify(roleChunk)}\n\n`;
  if (msg.content != null && msg.content !== "") {
    const cChunk = { id: rid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] };
    yield `data: ${JSON.stringify(cChunk)}\n\n`;
  }
  const toolCalls = msg.tool_calls || [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const tcDelta = { index: i, id: tc.id, type: tc.type || "function", function: tc.function || {} };
    const tChunk = { id: rid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [tcDelta] }, finish_reason: null }] };
    yield `data: ${JSON.stringify(tChunk)}\n\n`;
  }
  const finChunk: any = { id: rid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: fin }] };
  if (resp.usage) finChunk.usage = resp.usage;
  yield `data: ${JSON.stringify(finChunk)}\n\n`;
  yield "data: [DONE]\n\n";
}

function* sseAnthropicFromResponse(resp: any, model: string): Generator<string> {
  const rid = resp.id || "msg_x";
  const usageIn = (resp.usage || {}).input_tokens || 0;
  const usageOut = (resp.usage || {}).output_tokens || 0;
  const startMsg = { id: rid, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: usageIn, output_tokens: 0 } };
  yield `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: startMsg })}\n\n`;
  let blocks = resp.content || [];
  if (!blocks.length) blocks = [{ type: "text", text: "" }];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "text") {
      yield `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } })}\n\n`;
      const text = b.text || "";
      if (text) yield `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: i, delta: { type: "text_delta", text } })}\n\n`;
      yield `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`;
    } else if (b.type === "tool_use") {
      yield `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } })}\n\n`;
      const jin = JSON.stringify(b.input || {});
      yield `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: jin } })}\n\n`;
      yield `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`;
    }
  }
  const stop = resp.stop_reason || "end_turn";
  yield `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usageOut } })}\n\n`;
  yield `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
}

// ---------- State & server ----------
const STATE: any = { parsed: { providers: {}, models: [] }, catalog: { providers: [] } };
const REFUSED_PROVIDERS: Set<string> = new Set();
const REFUSE_COUNT: Record<string, number> = {};

function sendJson(res: http.ServerResponse, code: number, obj: any) {
  const data = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": data.length });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

async function handleCompletion(req: http.IncomingMessage, res: http.ServerResponse, targetApi: string) {
  const body = await readBody(req);
  const reqs = requestRequirements(body, targetApi);
  const cands = selectModels(STATE.parsed, reqs);
  const stream = !!body.stream;
  let lastErr = "no candidate models";
  for (const pair of cands) {
    const m = pair[0], p = pair[1];
    const providerId = p.id;
    const modelId = m.id;
    try {
      const { wire, resp } = await callProvider(p, modelId, targetApi, body, false);
      const status = resp.status;
      // failover on 402/429/5xx to next best model one call at a time
      if (status === 0 || status === 402 || status === 429 || status >= 500) {
        lastErr = `provider ${providerId} model ${modelId} failed status ${status}`;
        if (status === 429 || status === 402) { const n = (REFUSE_COUNT[String(providerId)] = (REFUSE_COUNT[String(providerId)] || 0) + 1); if (n >= 2) { REFUSED_PROVIDERS.add(String(providerId)); logErr(`refusing provider ${providerId} from now on`); } }
        try { fs.appendFileSync("prov_err.log", status + " " + providerId + " " + modelId + " " + String((resp as any).raw || "").slice(0, 300) + "\n"); } catch {}
        logErr(lastErr);
        continue;
      }
      const { norm, err } = normalizeResponse(wire, status, resp.ct, resp.raw, targetApi, modelId);
      if (err) {
        lastErr = `provider ${providerId} model ${modelId} normalize error: ${err}`;
        logErr(lastErr);
        continue;
      }
      if (stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        try {
          if (targetApi === "openai") {
            for (const chunk of sseOpenaiFromResponse(norm, modelId)) res.write(chunk);
          } else {
            for (const chunk of sseAnthropicFromResponse(norm, modelId)) res.write(chunk);
          }
        } catch (e) { logErr(`sse write error: ${e}`); }
        res.end();
        return;
      } else {
        sendJson(res, 200, norm);
        return;
      }
    } catch (e) {
      lastErr = `provider ${providerId} model ${modelId} exception: ${e}`;
      logErr(lastErr);
      continue;
    }
  }
  sendJson(res, 502, { error: { message: String(lastErr), type: "upstream_error" } });
  try { fs.appendFileSync("prov_err.log", "502 final: " + String(lastErr).slice(0, 400) + "\n"); } catch {}
}

async function requestHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const method = req.method || "GET";
    const pth = (req.url || "/").split("?")[0];
    if (method === "GET" && pth.startsWith("/v1/models")) {
      if (req.headers["x-api-key"]) {
        const models: any[] = [];
        for (const p of (STATE.catalog.providers || [])) for (const m of (p.models || [])) models.push({ id: m.id, type: "model", display_name: m.id });
        sendJson(res, 200, { data: models, has_more: false });
      } else if (req.headers["authorization"]) {
        const data: any[] = [];
        for (const p of (STATE.catalog.providers || [])) for (const m of (p.models || [])) data.push({ id: m.id, object: "model", owned_by: p.id || "" });
        sendJson(res, 200, { object: "list", data });
      } else {
        sendJson(res, 401, { error: { message: "missing auth header", type: "auth_error" } });
      }
      return;
    }
    if (method === "POST" && pth.startsWith("/v1/chat/completions")) { await handleCompletion(req, res, "openai"); return; }
    if (method === "POST" && pth.startsWith("/v1/messages")) { await handleCompletion(req, res, "anthropic"); return; }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    logErr(`handler error: ${e}`);
    try { sendJson(res, 500, { error: { message: String(e) } }); } catch {}
  }
}

async function registerSelf(port: number, catalog: any) {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) return;
  const target = envUrl.replace(/\/+$/, "") + "/register";
  const payload = { protocol_version: 1, port, catalog };
  try {
    const r = await httpJson("POST", target, payload, {}, 10000);
    if (r.status < 200 || r.status >= 300) logErr(`register failed: ${r.status} ${r.raw.toString("utf8").slice(0,200)}`);
  } catch (e) { logErr(`register error: ${e}`); }
}

function pollWork() {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) return;
  const target = envUrl.replace(/\/+$/, "") + "/work";
  const tick = async () => {
    try {
      const r = await httpJson("GET", target, null, {}, 10000);
      if (r.status >= 200 && r.status < 300) {
        try {
          const data = JSON.parse(r.raw.toString("utf8"));
          if (data && data.done === true) process.exit(0);
        } catch {}
      }
    } catch {}
    setTimeout(tick, 500);
  };
  setTimeout(tick, 500);
}

async function main() {
  const args = process.argv.slice(2);
  const isList = args.includes("--list");
  const brief = readBrief();
  if (isList) {
    if (!brief) {
      process.stdout.write(JSON.stringify({ providers: [] }) + "\n");
      return;
    }
    const parsed = parseBrief(brief);
    const cat = buildCatalog(parsed);
    process.stdout.write(JSON.stringify(cat) + "\n");
    return;
  }

  const parsed = parseBrief(brief || "");
  const catalog = buildCatalog(parsed);
  STATE.parsed = parsed;
  STATE.catalog = catalog;

  const server = http.createServer((req, res) => { requestHandler(req, res); });
  server.listen(0, "0.0.0.0", async () => {
    const addr = server.address();
    const port = addr && addr.port ? addr.port : 0;
    console.error("MFPORT=" + port);
    await registerSelf(port, catalog);
    pollWork();
  });
}

main().catch((e) => { logErr(e); process.exit(1); });
