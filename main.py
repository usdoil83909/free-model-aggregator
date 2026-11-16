#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import ThreadingMixIn

# Deterministic RNG seeded from env
_seed = os.environ.get("MAKEFUN_TRIAL_SEED", "0")
try:
    _rng_state = int(_seed)
except Exception:
    _rng_state = sum(ord(c) for c in str(_seed))

def drand():
    global _rng_state
    _rng_state = (1103515245 * _rng_state + 12345) & 0x7fffffff
    return _rng_state / 0x7fffffff

def now_str():
    return os.environ.get("MAKEFUN_TRIAL_NOW", "")

def log_err(msg):
    try:
        sys.stderr.write(str(msg) + "\n")
        sys.stderr.flush()
    except Exception:
        pass

# ---------- Brief parsing ----------

def read_brief():
    path = os.environ.get("MAKEFUN_PROMPT_FILE")
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception as e:
        log_err(f"brief read error: {e}")
        return None

def parse_brief(text):
    providers = {}
    models = []
    if not text:
        return {"providers": providers, "models": models}
    lines = text.splitlines()
    # Generic tolerant parsing by scanning for blocks/lines with key=value or "key: value"
    # Providers: look for sections mentioning provider id/name/wire/auth/base/key
    # Try to detect provider entries
    cur_prov = None
    cur_model = None
    def flush_prov():
        nonlocal cur_prov
        if cur_prov and cur_prov.get("id"):
            providers[cur_prov["id"]] = cur_prov
        cur_prov = None
    def kv_pairs(s):
        pairs = {}
        for m in re.finditer(r"([A-Za-z0-9_.-]+)\s*[:=]\s*(\"[^\"]*\"|'[^']*'|[^\s,;]+)", s):
            k = m.group(1).strip().lower()
            v = m.group(2).strip().strip("\"'")
            pairs[k] = v
        return pairs

    # Parse providers
    i = 0
    n = len(lines)
    # First pass: providers
    prov_section = False
    model_section = False
    for idx, line in enumerate(lines):
        l = line.strip()
        if not l:
            continue
        ll = l.lower()
        if re.search(r"\bproviders?\b", ll):
            prov_section = True
            model_section = False
            flush_prov()
            continue
        if re.search(r"\bquality\b.*\btable\b|\bmodels?\b.*\btable\b|\bsealed\b", ll):
            flush_prov()
            prov_section = False
            model_section = True
            continue
        if re.search(r"\bworkload\b", ll):
            flush_prov()
            prov_section = False
            model_section = False
            continue
        pairs = kv_pairs(l)
        # provider line heuristics
        if prov_section or ("wire" in pairs and ("base" in pairs or "base_url" in pairs or "baseurl" in pairs)):
            # new provider if has id or provider id
            pid = pairs.get("id") or pairs.get("provider") or pairs.get("provider_id")
            if pid:
                if cur_prov and cur_prov.get("id") and cur_prov.get("id") != pid:
                    flush_prov()
                if not cur_prov:
                    cur_prov = {}
                cur_prov["id"] = pid
            if cur_prov is None and pid:
                cur_prov = {"id": pid}
            if cur_prov is not None:
                if "name" in pairs: cur_prov["name"] = pairs["name"]
                if "wire" in pairs: cur_prov["wire"] = pairs["wire"]
                if "auth" in pairs or "auth_scheme" in pairs: cur_prov["auth"] = pairs.get("auth") or pairs.get("auth_scheme")
                base = pairs.get("base") or pairs.get("base_url") or pairs.get("baseurl") or pairs.get("url")
                if base: cur_prov["base_url"] = base.rstrip("/")
                if "key_env" in pairs or "keyenv" in pairs or "key_var" in pairs or "env" in pairs:
                    cur_prov["key_env"] = pairs.get("key_env") or pairs.get("keyenv") or pairs.get("key_var") or pairs.get("env")
                if "key" in pairs and "key_env" not in pairs and "keyenv" not in pairs:
                    # could be key value or key env; try to distinguish
                    if pairs["key"].isupper() or "API_KEY" in pairs["key"]:
                        cur_prov["key_env"] = pairs["key"]
                    else:
                        cur_prov["key_value"] = pairs["key"]
                if "key_value" in pairs or "keyvalue" in pairs or "value" in pairs:
                    cur_prov["key_value"] = pairs.get("key_value") or pairs.get("keyvalue") or pairs.get("value")
        # model lines in quality table
        if model_section:
            # try parse model row: model/provider/rating/context/tools/images/json
            mid = pairs.get("model") or pairs.get("id") or pairs.get("model_id")
            prov = pairs.get("provider") or pairs.get("prov")
            if mid and prov:
                def bval(x):
                    if x is None: return False
                    return str(x).lower() in ("1","true","yes","y","on")
                try: rating = float(pairs.get("rating", pairs.get("score", "0")))
                except: rating = 0.0
                try: ctx = int(float(pairs.get("context", pairs.get("context_length", pairs.get("ctx", "0")))))
                except: ctx = 0
                models.append({
                    "id": mid,
                    "provider": prov,
                    "rating": rating,
                    "context_length": ctx,
                    "tools": bval(pairs.get("tools")),
                    "images": bval(pairs.get("images") or pairs.get("vision")),
                    "json": bval(pairs.get("json")),
                })
            else:
                # try pipe/comma/space table row
                parts = [p.strip() for p in re.split(r"[|,\t]+", l) if p.strip()]
                if len(parts) >= 4 and not re.search(r"^(model|provider|rating)", ll):
                    # heuristic: model, provider, rating, context, flags...
                    try:
                        rating = float(parts[2])
                        ctx = int(re.sub(r"[^0-9]", "", parts[3]) or "0")
                        flags = " ".join(parts[4:]).lower() if len(parts) > 4 else ""
                        models.append({
                            "id": parts[0],
                            "provider": parts[1],
                            "rating": rating,
                            "context_length": ctx,
                            "tools": "tool" in flags,
                            "images": "image" in flags or "vision" in flags,
                            "json": "json" in flags,
                        })
                    except Exception:
                        pass
    flush_prov()

    # Second pass fallback: regex search for provider blocks in freeform
    if not providers:
        # look for patterns like id: foo ... wire: openai ... base: http...
        blocks = re.split(r"\n\s*\n", text)
        for b in blocks:
            pairs = kv_pairs(b.replace("\n", " "))
            pid = pairs.get("id") or pairs.get("provider")
            base = pairs.get("base") or pairs.get("base_url") or pairs.get("baseurl")
            wire = pairs.get("wire")
            if pid and (base or wire):
                providers[pid] = {
                    "id": pid,
                    "name": pairs.get("name", pid),
                    "wire": wire or "openai",
                    "auth": pairs.get("auth") or pairs.get("auth_scheme") or "bearer",
                    "base_url": (base or "").rstrip("/"),
                    "key_env": pairs.get("key_env") or pairs.get("keyenv") or "",
                    "key_value": pairs.get("key_value") or pairs.get("keyvalue") or pairs.get("key") or "",
                }
    return {"providers": providers, "models": models}

# ---------- Catalog ----------

def build_catalog(parsed):
    provs = []
    # group models by provider
    by_prov = {}
    for m in parsed.get("models", []):
        by_prov.setdefault(m.get("provider"), []).append(m)
    for pid, p in parsed.get("providers", {}).items():
        mlist = []
        for m in by_prov.get(pid, []):
            mlist.append({"id": m["id"], "free": True, "context_length": int(m.get("context_length", 0))})
        provs.append({
            "id": pid,
            "base_url": p.get("base_url", ""),
            "key_env": p.get("key_env", ""),
            "wire": p.get("wire", "openai"),
            "models": mlist,
        })
    # include providers that might only appear in models
    seen = {p["id"] for p in provs}
    for pid, ms in by_prov.items():
        if pid not in seen:
            provs.append({
                "id": pid, "base_url": "", "key_env": "", "wire": "openai",
                "models": [{"id": m["id"], "free": True, "context_length": int(m.get("context_length", 0))} for m in ms]
            })
    return {"providers": provs}

# ---------- HTTP helpers ----------

def http_json(method, url, body=None, headers=None, timeout=30):
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            ct = resp.headers.get("Content-Type", "")
            return resp.status, ct, raw
    except urllib.error.HTTPError as e:
        try:
            raw = e.read()
        except Exception:
            raw = b""
        return e.code, e.headers.get("Content-Type", "") if e.headers else "", raw
    except Exception as e:
        return 0, "", str(e).encode("utf-8", errors="replace")

# ---------- Provider calling & translation ----------

def get_provider_key(p):
    # prefer env var named, else key value from brief
    envn = p.get("key_env")
    if envn:
        v = os.environ.get(envn)
        if v:
            return v
    return p.get("key_value") or ""

def auth_headers(p):
    auth = (p.get("auth") or "bearer").lower()
    key = get_provider_key(p)
    h = {}
    if not key or auth == "none":
        return h
    if auth == "bearer":
        h["Authorization"] = f"Bearer {key}"
    elif auth == "x-api-key":
        h["x-api-key"] = key
    elif auth in ("x-goog-api-key", "goog", "google"):
        h["x-goog-api-key"] = key
    else:
        h["Authorization"] = f"Bearer {key}"
    return h

# Basic OpenAI<->Anthropic<->Gemini translation (best-effort)

def openai_to_anthropic_messages(messages):
    sys_parts = []
    out = []
    for m in messages or []:
        role = m.get("role")
        content = m.get("content")
        if role == "system":
            if isinstance(content, list):
                sys_parts.append("".join([c.get("text","") for c in content if c.get("type")=="text"]))
            else:
                sys_parts.append(content or "")
            continue
        if role == "tool":
            out.append({"role":"user","content":[{"type":"tool_result","tool_use_id":m.get("tool_call_id"),"content":m.get("content","")}]})
            continue
        if role == "assistant" and m.get("tool_calls"):
            blocks = []
            if content:
                if isinstance(content, str): blocks.append({"type":"text","text":content})
                elif isinstance(content, list): blocks.extend(content)
            for tc in m.get("tool_calls",[]):
                fn = tc.get("function",{})
                args = fn.get("arguments","{}")
                try: inp = json.loads(args) if isinstance(args,str) else args
                except: inp = {"_raw": args}
                blocks.append({"type":"tool_use","id":tc.get("id"),"name":fn.get("name"),"input":inp})
            out.append({"role":"assistant","content":blocks})
            continue
        # user/assistant normal
        arole = "user" if role == "user" else "assistant"
        if isinstance(content, list):
            blocks = []
            for c in content:
                if c.get("type") == "text":
                    blocks.append({"type":"text","text":c.get("text","")})
                elif c.get("type") == "image_url":
                    url = (c.get("image_url") or {}).get("url","")
                    # best-effort: pass as image with source if data url
                    m = re.match(r"data:([^;]+);base64,(.+)", url)
                    if m:
                        blocks.append({"type":"image","source":{"type":"base64","media_type":m.group(1),"data":m.group(2)}})
                    else:
                        blocks.append({"type":"image","source":{"type":"url","url":url}})
                else:
                    blocks.append(c)
            out.append({"role":arole,"content":blocks})
        else:
            out.append({"role":arole,"content":content or ""})
    system = "\n".join([s for s in sys_parts if s])
    return system, out

def anthropic_to_openai_response(aresp, model):
    content_blocks = aresp.get("content") or []
    text = "".join([b.get("text","") for b in content_blocks if b.get("type")=="text"])
    tool_calls = []
    for b in content_blocks:
        if b.get("type") == "tool_use":
            tool_calls.append({"id": b.get("id"), "type":"function", "function":{"name": b.get("name"), "arguments": json.dumps(b.get("input",{}))}})
    msg = {"role":"assistant","content": text if text else (None if tool_calls else "")}
    if tool_calls: msg["tool_calls"] = tool_calls
    stop = aresp.get("stop_reason")
    finish = {"end_turn":"stop","max_tokens":"length","tool_use":"tool_calls"}.get(stop, "stop")
    usage = aresp.get("usage") or {}
    return {
        "id": aresp.get("id","chatcmpl-x"),
        "object":"chat.completion",
        "created": 0,
        "model": model,
        "choices":[{"index":0,"message":msg,"finish_reason":finish}],
        "usage":{"prompt_tokens":usage.get("input_tokens",0),"completion_tokens":usage.get("output_tokens",0),"total_tokens":usage.get("input_tokens",0)+usage.get("output_tokens",0)}
    }

def openai_to_anthropic_response(oresp, model):
    choice = (oresp.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    finish = choice.get("finish_reason")
    stop = {"stop":"end_turn","length":"max_tokens","tool_calls":"tool_use"}.get(finish, "end_turn")
    blocks = []
    if msg.get("content"):
        blocks.append({"type":"text","text":msg.get("content")})
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function",{})
        args = fn.get("arguments","{}")
        try: inp = json.loads(args) if isinstance(args,str) else args
        except: inp = {"_raw": args}
        blocks.append({"type":"tool_use","id":tc.get("id"),"name":fn.get("name"),"input":inp})
    usage = oresp.get("usage") or {}
    return {
        "id": oresp.get("id","msg_x"),
        "type":"message",
        "role":"assistant",
        "model": model,
        "content": blocks,
        "stop_reason": stop,
        "stop_sequence": None,
        "usage":{"input_tokens":usage.get("prompt_tokens",0),"output_tokens":usage.get("completion_tokens",0)}
    }

def gemini_to_openai_response(gresp, model):
    cands = gresp.get("candidates") or [{}]
    cand = cands[0] if cands else {}
    parts = ((cand.get("content") or {}).get("parts") or [])
    text = "".join([p.get("text","") for p in parts if "text" in p])
    msg = {"role":"assistant","content":text}
    um = gresp.get("usageMetadata") or {}
    pt = um.get("promptTokenCount",0); ct = um.get("candidatesTokenCount",0)
    return {
        "id":"chatcmpl-gem","object":"chat.completion","created":0,"model":model,
        "choices":[{"index":0,"message":msg,"finish_reason":"stop"}],
        "usage":{"prompt_tokens":pt,"completion_tokens":ct,"total_tokens":pt+ct}
    }

def gemini_to_anthropic_response(gresp, model):
    o = gemini_to_openai_response(gresp, model)
    return openai_to_anthropic_response(o, model)

def openai_msgs_to_gemini(messages):
    contents = []
    sys_instr = None
    for m in messages or []:
        role = m.get("role")
        content = m.get("content")
        if role == "system":
            sys_instr = content if isinstance(content,str) else "".join([c.get("text","") for c in content if c.get("type")=="text"])
            continue
        grole = "user" if role in ("user","tool") else "model"
        parts = []
        if isinstance(content, str):
            parts.append({"text": content})
        elif isinstance(content, list):
            for c in content:
                if c.get("type") == "text":
                    parts.append({"text": c.get("text","")})
                elif c.get("type") == "image_url":
                    url = (c.get("image_url") or {}).get("url","")
                    m = re.match(r"data:([^;]+);base64,(.+)", url)
                    if m:
                        parts.append({"inline_data":{"mime_type":m.group(1),"data":m.group(2)}})
        if parts:
            contents.append({"role": grole, "parts": parts})
    return sys_instr, contents

# ---------- Model selection ----------

def request_requirements(body, api):
    req = {"tools": False, "vision": False, "json": False}
    if api == "openai":
        if body.get("tools") or body.get("tool_choice") or body.get("functions"):
            req["tools"] = True
        rf = body.get("response_format") or {}
        if isinstance(rf, dict) and rf.get("type") in ("json_object","json_schema"):
            req["json"] = True
        for m in body.get("messages") or []:
            c = m.get("content")
            if isinstance(c, list):
                for p in c:
                    if p.get("type") in ("image_url","image","input_image"):
                        req["vision"] = True
    else: # anthropic
        if body.get("tools"):
            req["tools"] = True
        # anthropic has no standard json mode flag universally; check metadata-ish
        for m in body.get("messages") or []:
            c = m.get("content")
            if isinstance(c, list):
                for p in c:
                    if p.get("type") == "image":
                        req["vision"] = True
    return req

def select_models(parsed, reqs):
    cands = []
    providers = parsed.get("providers", {})
    for m in parsed.get("models", []):
        if reqs.get("tools") and not m.get("tools"): continue
        if reqs.get("vision") and not m.get("images"): continue
        if reqs.get("json") and not m.get("json"): continue
        p = providers.get(m.get("provider"))
        if not p: continue
        cands.append((m, p))
    cands.sort(key=lambda x: (-float(x[0].get("rating",0)), x[0].get("id","")))
    return cands

# ---------- Provider call ----------

def call_provider(p, model_id, req_api, req_body, stream=False):
    wire = (p.get("wire") or "openai").lower()
    base = (p.get("base_url") or "").rstrip("/")
    headers = auth_headers(p)
    timeout = 60
    if wire == "anthropic":
        url = base + "/v1/messages"
        if req_api == "openai":
            system, msgs = openai_to_anthropic_messages(req_body.get("messages") or [])
            body = {"model": model_id, "messages": msgs, "max_tokens": req_body.get("max_tokens") or 1024, "stream": bool(stream)}
            if system: body["system"] = system
            if req_body.get("tools"):
                # convert openai tools to anthropic
                tools = []
                for t in req_body.get("tools") or []:
                    fn = t.get("function", t)
                    tools.append({"name": fn.get("name"), "description": fn.get("description",""), "input_schema": fn.get("parameters", {"type":"object","properties":{}})})
                body["tools"] = tools
        else:
            body = dict(req_body); body["model"] = model_id; body["stream"] = bool(stream)
            body.setdefault("max_tokens", 1024)
        headers.setdefault("anthropic-version", "2023-06-01")
        return "anthropic", http_json("POST", url, body, headers, timeout)
    elif wire == "gemini":
        if stream:
            url = f"{base}/v1beta/models/{urllib.parse.quote(model_id)}:streamGenerateContent?alt=sse"
        else:
            url = f"{base}/v1beta/models/{urllib.parse.quote(model_id)}:generateContent"
        if req_api == "openai":
            sys_instr, contents = openai_msgs_to_gemini(req_body.get("messages") or [])
            body = {"contents": contents}
            if sys_instr: body["systemInstruction"] = {"parts":[{"text":sys_instr}]}
        else:
            # anthropic to gemini rough
            msgs = []
            for m in req_body.get("messages") or []:
                role = "user" if m.get("role")=="user" else "model"
                c = m.get("content")
                txt = c if isinstance(c,str) else "".join([b.get("text","") for b in c if isinstance(b,dict) and b.get("type")=="text"])
                msgs.append({"role":role,"parts":[{"text":txt}]})
            body = {"contents": msgs}
        return "gemini", http_json("POST", url, body, headers, timeout)
    else: # openai
        url = base + "/v1/chat/completions"
        if req_api == "openai":
            body = dict(req_body); body["model"] = model_id; body["stream"] = bool(stream)
        else:
            # anthropic to openai
            msgs = []
            sys = req_body.get("system")
            if sys:
                msgs.append({"role":"system","content": sys if isinstance(sys,str) else ""})
            for m in req_body.get("messages") or []:
                role = m.get("role")
                c = m.get("content")
                if isinstance(c, str):
                    msgs.append({"role":role,"content":c})
                else:
                    parts = []
                    for b in c or []:
                        if b.get("type")=="text": parts.append({"type":"text","text":b.get("text","")})
                        elif b.get("type")=="image":
                            src = b.get("source") or {}
                            if src.get("type")=="base64":
                                parts.append({"type":"image_url","image_url":{"url":f"data:{src.get('media_type','image/png')};base64,{src.get('data','')}"}})
                        elif b.get("type")=="tool_result":
                            msgs.append({"role":"tool","tool_call_id":b.get("tool_use_id"),"content":b.get("content","")})
                            parts = None; break
                        elif b.get("type")=="tool_use":
                            pass
                    if parts is not None:
                        msgs.append({"role":role,"content":parts if parts else ""})
            body = {"model": model_id, "messages": msgs, "stream": bool(stream), "max_tokens": req_body.get("max_tokens") or 1024}
            if req_body.get("tools"):
                tools=[]
                for t in req_body.get("tools") or []:
                    tools.append({"type":"function","function":{"name":t.get("name"),"description":t.get("description",""),"parameters":t.get("input_schema",{"type":"object","properties":{}})}})
                body["tools"]=tools
        return "openai", http_json("POST", url, body, headers, timeout)

def normalize_response(wire, status, ct, raw, target_api, model_id):
    if status < 200 or status >= 300:
        return None, f"status {status}: {raw[:200]!r}"
    try:
        text = raw.decode("utf-8", errors="replace")
        data = json.loads(text)
    except Exception as e:
        return None, f"decode error: {e}"
    # wire -> target_api
    if wire == "openai":
        if target_api == "openai": return data, None
        else: return openai_to_anthropic_response(data, model_id), None
    elif wire == "anthropic":
        if target_api == "anthropic": return data, None
        else: return anthropic_to_openai_response(data, model_id), None
    elif wire == "gemini":
        if target_api == "openai": return gemini_to_openai_response(data, model_id), None
        else: return gemini_to_anthropic_response(data, model_id), None
    return None, "unknown wire"

# ---------- SSE helpers (non-stream fallback/simple) ----------

def sse_openai_from_response(resp, model):
    rid = resp.get("id", "chatcmpl-x")
    created = resp.get("created", 0)
    choice = (resp.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    fin = choice.get("finish_reason") or "stop"
    # 1) role chunk
    chunk_role = {"id": rid, "object": "chat.completion.chunk", "created": created, "model": model,
                  "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]}
    yield f"data: {json.dumps(chunk_role, separators=(',', ':'))}\n\n".encode()
    # 2) content and/or tool_calls deltas
    if msg.get("content") is not None and msg.get("content") != "":
        chunk_c = {"id": rid, "object": "chat.completion.chunk", "created": created, "model": model,
                   "choices": [{"index": 0, "delta": {"content": msg.get("content")}, "finish_reason": None}]}
        yield f"data: {json.dumps(chunk_c, separators=(',', ':'))}\n\n".encode()
    tool_calls = msg.get("tool_calls") or []
    for i, tc in enumerate(tool_calls):
        tc_delta = {
            "index": i,
            "id": tc.get("id"),
            "type": tc.get("type", "function"),
            "function": tc.get("function", {})
        }
        chunk_t = {"id": rid, "object": "chat.completion.chunk", "created": created, "model": model,
                   "choices": [{"index": 0, "delta": {"tool_calls": [tc_delta]}, "finish_reason": None}]}
        yield f"data: {json.dumps(chunk_t, separators=(',', ':'))}\n\n".encode()
    # 3) finish chunk
    chunk_fin = {"id": rid, "object": "chat.completion.chunk", "created": created, "model": model,
                 "choices": [{"index": 0, "delta": {}, "finish_reason": fin}]}
    if resp.get("usage"):
        chunk_fin["usage"] = resp.get("usage")
    yield f"data: {json.dumps(chunk_fin, separators=(',', ':'))}\n\n".encode()
    yield b"data: [DONE]\n\n"

def sse_anthropic_from_response(resp, model):
    rid = resp.get("id","msg_x")
    usage_in = (resp.get("usage") or {}).get("input_tokens",0)
    usage_out = (resp.get("usage") or {}).get("output_tokens",0)
    msg = {"id":rid,"type":"message","role":"assistant","content":[],"model":model,"stop_reason":None,"stop_sequence":None,"usage":{"input_tokens":usage_in,"output_tokens":0}}
    yield f"event: message_start\ndata: {json.dumps({'type':'message_start','message':msg}, separators=(',',':'))}\n\n".encode()
    blocks = resp.get("content") or []
    if not blocks:
        blocks = [{"type":"text","text":""}]
    for i,b in enumerate(blocks):
        if b.get("type")=="text":
            yield f"event: content_block_start\ndata: {json.dumps({'type':'content_block_start','index':i,'content_block':{'type':'text','text':''}}, separators=(',',':'))}\n\n".encode()
            text = b.get("text","")
            if text:
                yield f"event: content_block_delta\ndata: {json.dumps({'type':'content_block_delta','index':i,'delta':{'type':'text_delta','text':text}}, separators=(',',':'))}\n\n".encode()
            yield f"event: content_block_stop\ndata: {json.dumps({'type':'content_block_stop','index':i}, separators=(',',':'))}\n\n".encode()
        elif b.get("type")=="tool_use":
            yield f"event: content_block_start\ndata: {json.dumps({'type':'content_block_start','index':i,'content_block':{'type':'tool_use','id':b.get('id'),'name':b.get('name'),'input':{}}}, separators=(',',':'))}\n\n".encode()
            jin = json.dumps(b.get("input",{}), separators=(',',':'))
            yield f"event: content_block_delta\ndata: {json.dumps({'type':'content_block_delta','index':i,'delta':{'type':'input_json_delta','partial_json':jin}}, separators=(',',':'))}\n\n".encode()
            yield f"event: content_block_stop\ndata: {json.dumps({'type':'content_block_stop','index':i}, separators=(',',':'))}\n\n".encode()
    stop = resp.get("stop_reason") or "end_turn"
    yield f"event: message_delta\ndata: {json.dumps({'type':'message_delta','delta':{'stop_reason':stop,'stop_sequence':None},'usage':{'output_tokens':usage_out}}, separators=(',',':'))}\n\n".encode()
    yield f"event: message_stop\ndata: {json.dumps({'type':'message_stop'}, separators=(',',':'))}\n\n".encode()

# ---------- Server ----------

STATE = {"parsed": {"providers": {}, "models": []}, "catalog": {"providers": []}, "done": False}

class Handler(BaseHTTPRequestHandler):
    server_version = "agg/0.1"
    def log_message(self, fmt, *args):
        try:
            sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], now_str(), fmt%args))
        except Exception:
            pass

    def _send_json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self):
        try:
            ln = int(self.headers.get("Content-Length","0"))
        except: ln = 0
        raw = self.rfile.read(ln) if ln>0 else b""
        if not raw: return {}
        try: return json.loads(raw.decode("utf-8", errors="replace"))
        except: return {}

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            if self.headers.get("x-api-key"):
                # anthropic style list
                models = []
                for p in STATE["catalog"].get("providers",[]):
                    for m in p.get("models",[]):
                        models.append({"id": m["id"], "type":"model", "display_name": m["id"]})
                self._send_json(200, {"data": models, "has_more": False})
            elif self.headers.get("Authorization"):
                data = []
                for p in STATE["catalog"].get("providers",[]):
                    for m in p.get("models",[]):
                        data.append({"id": m["id"], "object":"model", "owned_by": p.get("id","")})
                self._send_json(200, {"object":"list","data": data})
            else:
                self._send_json(401, {"error":{"message":"missing auth header","type":"auth_error"}})
            return
        self._send_json(404, {"error":"not found"})

    def do_POST(self):
        if self.path.startswith("/v1/chat/completions"):
            body = self._read_json()
            self.handle_completion(body, target_api="openai")
            return
        if self.path.startswith("/v1/messages"):
            body = self._read_json()
            self.handle_completion(body, target_api="anthropic")
            return
        self._send_json(404, {"error":"not found"})

    def handle_completion(self, body, target_api):
        reqs = request_requirements(body, target_api)
        cands = select_models(STATE["parsed"], reqs)
        stream = bool(body.get("stream"))
        last_err = "no candidate models"
        # failover retry loop: sequential, one provider call at a time
        for m, p in cands:
            provider_id = p.get("id")
            model_id = m.get("id")
            try:
                wire, (status, ct, raw) = call_provider(p, model_id, target_api, body, stream=False)
                if status == 0 or status in (402, 429) or status >= 500 or (400 <= status < 500 and status != 400):
                    last_err = f"provider {provider_id} model {model_id} failed status {status}"
                    log_err(last_err)
                    continue
                norm, err = normalize_response(wire, status, ct, raw, target_api, model_id)
                if err:
                    last_err = f"provider {provider_id} model {model_id} normalize error: {err}"
                    log_err(last_err)
                    continue
                if stream:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "keep-alive")
                    self.end_headers()
                    try:
                        if target_api == "openai":
                            for chunk in sse_openai_from_response(norm, model_id):
                                self.wfile.write(chunk)
                                self.wfile.flush()
                        else:
                            for chunk in sse_anthropic_from_response(norm, model_id):
                                self.wfile.write(chunk)
                                self.wfile.flush()
                    except Exception as e:
                        log_err(f"sse write error: {e}")
                    return
                else:
                    self._send_json(200, norm)
                    return
            except Exception as e:
                last_err = f"provider {provider_id} model {model_id} exception: {e}"
                log_err(last_err)
                continue
        # all failed
        err_obj = {"error": {"message": str(last_err), "type": "upstream_error"}}
        self._send_json(502, err_obj)

class Server(ThreadingHTTPServer):
    daemon_threads = True

def register_self(port, catalog):
    env_url = os.environ.get("MAKEFUN_ENV_URL")
    if not env_url:
        return
    url = env_url.rstrip("/") + "/register"
    payload = {"protocol_version": 1, "port": port, "catalog": catalog}
    try:
        status, ct, raw = http_json("POST", url, payload, {}, timeout=10)
        if status < 200 or status >= 300:
            log_err(f"register failed: {status} {raw[:200]!r}")
    except Exception as e:
        log_err(f"register error: {e}")

def poll_work(stop_event):
    env_url = os.environ.get("MAKEFUN_ENV_URL")
    if not env_url:
        return
    url = env_url.rstrip("/") + "/work"
    while not stop_event.is_set():
        try:
            status, ct, raw = http_json("GET", url, None, {}, timeout=10)
            if status >= 200 and status < 300:
                try:
                    data = json.loads(raw.decode("utf-8", errors="replace"))
                    if isinstance(data, dict) and data.get("done") is True:
                        os._exit(0)
                except Exception:
                    pass
        except Exception:
            pass
        # deterministic-ish small wait; avoid busy loop
        stop_event.wait(0.5)

def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--list", action="store_true")
    args, _ = ap.parse_known_args()

    brief = read_brief()
    if args.list:
        if not brief:
            print(json.dumps({"providers": []}, separators=(",", ":")))
            return 0
        parsed = parse_brief(brief)
        cat = build_catalog(parsed)
        print(json.dumps(cat, separators=(",", ":")))
        return 0

    parsed = parse_brief(brief or "")
    catalog = build_catalog(parsed)
    STATE["parsed"] = parsed
    STATE["catalog"] = catalog

    # bind port 0
    httpd = Server(("0.0.0.0", 0), Handler)
    port = httpd.server_address[1]

    # register
    try:
        register_self(port, catalog)
    except Exception as e:
        log_err(f"register exception: {e}")

    # poll /work
    stop_event = threading.Event()
    t = threading.Thread(target=poll_work, args=(stop_event,), daemon=True)
    t.start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        try: httpd.server_close()
        except: pass
    return 0

if __name__ == "__main__":
    sys.exit(main())
