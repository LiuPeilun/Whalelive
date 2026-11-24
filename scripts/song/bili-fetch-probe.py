# -*- coding: utf-8 -*-
# Probe: B 站取歌全链路(免登录)——搜索(SSR 页)→择源→view→playurl→音频下载
# 用法: python bili-fetch-probe.py "歌名 歌手" [输出文件]
import json, re, sys, urllib.parse, urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
BUVID = "buvid3=0C3CB04F-B3BA-B3ED-8F20-1EBAF7BB864Cinfoc"  # 任意 buvid3 即可

def http_get(url, referer="https://www.bilibili.com/"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer, "Cookie": BUVID})
    return urllib.request.urlopen(req, timeout=25).read()

def clean_title(raw):
    # SSR 页面里 \uXXXX 是字面转义;逐个替换,不能用 unicode_escape(会破坏 UTF-8 多字节)
    t = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), raw)
    t = re.sub(r"<em[^>]*>|</em>", "", t)
    return t.strip()

def search(keyword):
    url = "https://search.bilibili.com/video?keyword=%s" % urllib.parse.quote(keyword)
    html = http_get(url, "https://www.bilibili.com/").decode("utf8", "ignore")
    pat = re.compile(r'"(BV[0-9A-Za-z]{10})","((?:[^"\\]|\\.)+?)"')
    items = []
    for m in pat.finditer(html):
        bvid, title = m.group(1), clean_title(m.group(2))
        if any(i["bvid"] == bvid for i in items):
            continue
        items.append({"bvid": bvid, "title": title})
    return items

BAD = ["现场", "饭拍", "翻唱", "reaction", "Reaction", "反应", "教唱", "伴奏", "纯伴奏", "倒放", "调音", "remix", "Remix", "合集"]
GOOD = ["MV", "官方", "原曲", "OST", "主题曲", "音源", "高清", "4K", "完整版"]

def rank(items, keyword):
    for it in items:
        score = 0.0
        t = it["title"]
        if any(b in t for b in BAD):
            score -= 3
        if any(g in t for g in GOOD):
            score += 2
        score -= abs(t.lower().find(keyword.split()[0].lower())) / 1000.0 if keyword.split()[0].lower() in t.lower() else 0.5
        it["score"] = score
    return sorted(items, key=lambda x: -x["score"])

def fetch_audio(bvid, out_path):
    j = json.loads(http_get("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid))
    if j["code"] != 0:
        raise RuntimeError("view: %s %s" % (j["code"], j["message"]))
    cid = j["data"]["cid"]
    title = j["data"]["title"]
    j = json.loads(http_get(
        "https://api.bilibili.com/x/player/playurl?bvid=%s&cid=%s&fnval=16" % (bvid, cid)))
    if j["code"] != 0:
        raise RuntimeError("playurl: %s %s" % (j["code"], j["message"]))
    auds = j["data"]["dash"]["audio"]
    best = max(auds, key=lambda a: a["bandwidth"])
    data = http_get(best["baseUrl"], "https://www.bilibili.com/video/" + bvid)
    open(out_path, "wb").write(data)
    return title, len(data), best["bandwidth"] // 1000

keyword = sys.argv[1] if len(sys.argv) > 1 else "篇章 张韶涵"
out = sys.argv[2] if len(sys.argv) > 2 else "bili-song.m4s"
items = search(keyword)
print("搜索命中 %d 条" % len(items))
ranked = rank(items, keyword)
for it in ranked[:5]:
    print("  [%.0f] %s | %s" % (it["score"], it["bvid"], it["title"][:55]))
best = ranked[0]
print("\n选用: %s %s" % (best["bvid"], best["title"][:60]))
title, size, kbps = fetch_audio(best["bvid"], out)
print("下载: %s | %d bytes | %d kb/s | -> %s" % (title[:50], size, kbps, out))
