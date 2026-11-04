#!/usr/bin/env python3
"""Aggregate fixed CloudWatch windows without writing request contents or secrets."""
import collections
import datetime as dt
import json
import subprocess
import sys
import time

UTC = dt.timezone.utc
def ms(y, mo, day, h, minute, sec, milli):
    return int(dt.datetime(y, mo, day, h, minute, sec, milli * 1000, tzinfo=UTC).timestamp() * 1000)

roll_start = ms(2026, 11, 4, 15, 9, 40, 929)
roll_complete = ms(2026, 11, 4, 15, 18, 33, 96)
windows = [
    ("before_12m", roll_start - 720000, roll_start - 1),
    ("rollout", roll_start, roll_complete - 1),
    ("after_12m", roll_complete, roll_complete + 720000 - 1),
]
if time.time() * 1000 < windows[-1][2]:
    sys.exit("window incomplete: wait until 2026-11-04T15:30:33.095Z")

def iso(t):
    return dt.datetime.fromtimestamp(t / 1000, UTC).isoformat(timespec="milliseconds")

def category(path):
    if not isinstance(path, str): return "unattributed"
    if path == "/v1/web/blog" or path.startswith("/v1/web/blog/") or path == "/v1/admin/blog" or path.startswith("/v1/admin/blog/"): return "blog"
    if path == "/v1/slips/verify" or path.startswith("/v1/slips/verify/"): return "verify"
    if path == "/v1/slips/decode" or path.startswith("/v1/slips/decode/"): return "decode"
    return "other"

print("group=/ecs/slip-api-production filter=<none> streams=all; bounds inclusive, UTC; local time UTC+7")
print("blog=/v1/{web,admin}/blog[/...]; verify=/v1/slips/verify[/...]; decode separately; other/unattributed retained")
print("requests=JSON msg http request completed or http request panic recovered; ERROR=all JSON level ERROR; 5xx=logged request status 500..599")
print("scope=HTTP access logs; successful /health,/ready,/metrics omitted by middleware; does not include unlogged traffic, gRPC, edge WAF or other services")
for label, start, end in windows:
    stats = {k: {"requests": 0, "status_histogram": collections.Counter(), "5xx": 0, "error_lines": 0, "bad_status": 0} for k in ("blog", "verify", "decode", "other", "unattributed")}
    pages = events = non_json = non_json_error_text = duplicates = 0
    seen = set()
    token = None
    while True:
        args = ["aws", "logs", "filter-log-events", "--profile", "vestearth", "--region", "ap-southeast-1", "--log-group-name", "/ecs/slip-api-production", "--start-time", str(start), "--end-time", str(end), "--no-paginate", "--output", "json"]
        if token: args += ["--next-token", token]
        page = json.loads(subprocess.check_output(args))
        pages += 1
        for entry in page.get("events", []):
            event_id = entry.get("eventId")
            if event_id and event_id in seen:
                duplicates += 1
                continue
            if event_id: seen.add(event_id)
            events += 1
            message = entry.get("message", "")
            try:
                obj = json.loads(message)
                if not isinstance(obj, dict): raise ValueError("not object")
            except (ValueError, TypeError):
                non_json += 1
                if any(word in message.lower() for word in ("error", "fatal", "panic")): non_json_error_text += 1
                continue
            group = stats[category(obj.get("path"))]
            if str(obj.get("level", "")).upper() == "ERROR": group["error_lines"] += 1
            if obj.get("msg") in ("http request completed", "http request panic recovered"):
                group["requests"] += 1
                status = obj.get("status")
                if isinstance(status, int) and not isinstance(status, bool):
                    group["status_histogram"][str(status)] += 1
                    if 500 <= status <= 599: group["5xx"] += 1
                else: group["bad_status"] += 1
        next_token = page.get("nextToken")
        if not next_token: break
        if next_token == token or pages >= 5000: sys.exit("pagination incomplete or stuck: " + label)
        token = next_token
    print(json.dumps({"window": label, "start_utc": iso(start), "end_utc": iso(end), "pages": pages, "events": events, "duplicates_ignored": duplicates, "non_json": non_json, "non_json_error_text": non_json_error_text, "groups": stats}, ensure_ascii=False, sort_keys=True))
