# -*- coding: utf-8 -*-
# Probe: 酷我搜索(r.s 老接口) → playUrl 拿直链 → 下载验证——唱歌管线搜歌源选型
import json, re, subprocess, sys, urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

def http_get(url, referer="https://www.kuwo.cn/"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
    return urllib.request.urlopen(req, timeout=20).read()

def search(keyword, rn=5):
    url = (
        "http://search.kuwo.cn/r.s?all=%s&ft=music&itemset=web_2013&client=kt"
        "&pn=0&rn=%d&rformat=json&encoding=utf8" % (urllib.parse.quote(keyword), rn)
    )
    raw = http_get(url).decode("utf8", "ignore")
    raw = raw[raw.index("{") : raw.rindex("}") + 1]  # 去 callback 包裹
    raw = raw.replace("'", '"')  # 单引号转双引号
    return json.loads(raw)["abslist"]

def get_play_url(musicrid):
    mid = str(musicrid).split("_")[-1]
    # 先访问首页拿服务端下发的 kw_token(csrf 校验配对)
    req = urllib.request.Request("https://www.kuwo.cn/", headers={"User-Agent": UA})
    resp = urllib.request.urlopen(req, timeout=20)
    set_cookies = resp.headers.get_all("Set-Cookie") or []
    token = None
    for c in set_cookies:
        m = re.match(r"kw_token=([^;]+)", c)
        if m:
            token = m.group(1)
            break
    if not token:
        return None, "no kw_token from homepage: %d cookies" % len(set_cookies)
    url = (
        "https://www.kuwo.cn/api/v1/www/music/playUrl?mid=%s&type=music"
        "&httpsStatus=1&reqId=probe" % mid
    )
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://www.kuwo.cn/",
        "csrf": token,
        "Cookie": "kw_token=" + token,
    })
    raw = urllib.request.urlopen(req, timeout=20).read().decode("utf8", "ignore")
    j = json.loads(raw)
    if j.get("code") != 200:
        return None, "%s %s" % (j.get("code"), j.get("message"))
    return j["data"].get("url"), j["data"].get("format")

import urllib.parse
keyword = sys.argv[1] if len(sys.argv) > 1 else "篇章 张韶涵"
songs = search(keyword)
print("搜索命中 %d 条:" % len(songs))
for s in songs:
    print("- %s | %s | rid=%s | 时长=%s" % (
        s.get("SONGNAME"), s.get("ARTIST"), s.get("MUSICRID"), s.get("DURATION")))

target = songs[0]
rid = target.get("MUSICRID")
url, fmt = get_play_url(rid)
print("\nplayUrl:", url, "| format:", fmt)
if url:
    data = http_get(url, "https://www.kuwo.cn/")
    out = "opt-kuwo-probe." + (fmt or "m4a")
    open(out, "wb").write(data)
    print("下载: %d bytes -> %s" % (len(data), out))
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                        "format=duration,format_name", "-of", "default=nw=1", out],
                       capture_output=True, text=True)
    print(p.stdout.strip() or p.stderr.strip()[:200])
