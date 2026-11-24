#!/usr/bin/env python3
"""JOB 1: does Cognee return data on search WITHOUT cognify? Isolated dataset."""
import json, os, sys, time, uuid, urllib.request, urllib.error
sys.stdout.reconfigure(line_buffering=True)

BASE = "http://10.20.10.15:8000"
TOK = os.environ["COGNEE_API_KEY"]
HDR = {"X-Api-Key": TOK}

def req(method, path, body=None, form=None, ctype=None, timeout=120):
    url = BASE + path
    data = None
    hdrs = dict(HDR)
    if form is not None:
        b = "----exp" + uuid.uuid4().hex
        parts = []
        for k, v in form.items():
            parts.append(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
        parts.append(f"--{b}--\r\n")
        data = "".join(parts).encode()
        hdrs["Content-Type"] = f"multipart/form-data; boundary={b}"
    elif body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode()
            code = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        code = e.code
    ms = round((time.time() - t0) * 1000)
    try:
        parsed = json.loads(raw)
    except Exception:
        parsed = raw[:400]
    return code, parsed, ms

def texts(payload):
    """Flatten a /search payload into (chunks, all_text)."""
    out = []
    groups = payload if isinstance(payload, list) else [payload]
    for g in groups:
        if not isinstance(g, dict):
            continue
        for item in (g.get("search_result") or []):
            out.append(item)
    return out

def probe(label, ds, query):
    res = {}
    for st in ("CHUNKS", "CHUNKS_LEXICAL", "GRAPH_COMPLETION"):
        code, payload, ms = req("POST", "/api/v1/search",
                                {"query": query, "searchType": st, "datasetIds": [ds], "topK": 5})
        blob = json.dumps(payload)
        hits = texts(payload)
        res[st] = {"http": code, "ms": ms, "n": len(hits),
                   "has_token": "ZQX-4417" in blob, "has_text": "quarterly" in blob.lower()}
        # keep a tiny excerpt for the report
        s = blob
        idx = s.find("ZQX-4417")
        res[st]["excerpt"] = (s[max(0, idx - 60):idx + 40].replace("\\n", " ")[:150]) if idx >= 0 else s[:120]
    print(f"[{label}] " + json.dumps(res, indent=None)[:1200])
    return res

DOC = ("Ops note 2026-11-24: the ZQX-4417 quarterly capacity review concluded that "
       "storage pressure on cluster B is driven by retained embeddings. "
       "Owner: Dana Whitfield. Action: rotate the archival tier before December.")

name = "exp-nocog-" + time.strftime("%Y%m%d-%H%M%S")
code, ds_obj, ms = req("POST", "/api/v1/datasets", {"name": name})
ds = ds_obj.get("id") if isinstance(ds_obj, dict) else None
if not ds:
    print("BLOCKED dataset create", code, ds_obj); sys.exit(2)
print(f"dataset {ds} name={name}")

# --- 1. ingest only (no cognify) ---
code, add_obj, add_ms = req("POST", "/api/v1/add", form={"raw_data": DOC, "datasetId": ds})
print(f"ADD http={code} {add_ms}ms keys={list(add_obj)[:6] if isinstance(add_obj,dict) else add_obj}")

mem = req("GET", f"/api/v1/datasets/status/memory?dataset={ds}")[1]
print("STATUS/MEMORY", json.dumps(mem)[:300])

no_cog = probe("NO-COGNIFY", ds, "ZQX-4417 quarterly capacity review")

# --- 2. cognify ---
cog_code, cog_obj, cog_ms = req("POST", "/api/v1/cognify", {"datasetIds": [ds], "runInBackground": False})
print(f"COGNIFY http={cog_code} {cog_ms}ms obj={json.dumps(cog_obj)[:200]}")
deadline = time.time() + 600
final = None
while time.time() < deadline:
    code, st, _ = req("GET", f"/api/v1/datasets/status?dataset={ds}&pipeline=cognify_pipeline")
    vals = [v for v in (st.values() if isinstance(st, dict) else []) if isinstance(v, str)]
    final = vals[0] if vals else json.dumps(st)[:80]
    if vals and any("COMPLETED" in v or "ERROR" in v for v in vals):
        break
    time.sleep(3)
cog_total = round((time.time() - (time.time() - cog_ms / 1000)) * 1000)
print(f"COGNIFY_STATE {final} (endpoint returned in {cog_ms}ms; polled to terminal)")

mem2 = req("GET", f"/api/v1/datasets/status/memory?dataset={ds}")[1]
print("STATUS/MEMORY after", json.dumps(mem2)[:300])

after = probe("POST-COGNIFY", ds, "ZQX-4417 quarterly capacity review")

# --- 3. delete / prune ---
code, data, _ = req("GET", f"/api/v1/datasets/{ds}/data")
ditems = data if isinstance(data, list) else (data.get("data") if isinstance(data, dict) else [])
did = ditems[0].get("id") if ditems and isinstance(ditems[0], dict) else None
print(f"DATA items={len(ditems)} id={did}")
if did:
    fc, fo, fms = req("POST", "/api/v1/forget", {"datasetId": ds, "dataId": did})
    print(f"FORGET http={fc} {fms}ms {json.dumps(fo)[:200]}")
    post = probe("POST-FORGET", ds, "ZQX-4417 quarterly capacity review")

dc, dbody, dms = req("DELETE", f"/api/v1/datasets/{ds}")
print(f"DELETE dataset http={dc} {dms}ms {json.dumps(dbody)[:150]}")
print("SUMMARY " + json.dumps({"add_ms": add_ms, "nocognify": {k: (v["http"], v["ms"], v["has_token"], v["n"]) for k, v in no_cog.items()},
                               "cognify_ms": cog_ms, "after": {k: (v["http"], v["ms"], v["has_token"], v["n"]) for k, v in after.items()}}))
