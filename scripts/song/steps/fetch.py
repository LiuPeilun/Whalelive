# -*- coding: utf-8 -*-
"""唱歌管线 [1/4] B站取歌+切片:搜索(SSR)→择源→view→playurl→下载→ffmpeg 切片。
stdout 最后一行输出 JSON: {chosenTitle, clipPath, durationSec}
进度/诊断一律走 stderr。
用法: fetch.py <title> <workdir> <clipStartRatio> <clipSeconds> <ffmpegPath>
"""
import json, os, re, subprocess, sys, urllib.parse, urllib.request

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')  # Windows 重定向下默认 GBK(WT-P3-009)
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
BUVID = "buvid3=0C3CB04F-B3BA-B3ED-8F20-1EBAF7BB864Cinfoc"  # 任意 buvid3 即可

def log(msg):
    print(msg, file=sys.stderr)

def http_get(url, referer="https://www.bilibili.com/"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer, "Cookie": BUVID})
    return urllib.request.urlopen(req, timeout=25).read()

def clean_title(raw):
    # SSR 页面里 \\uXXXX 是字面转义;逐个替换,不能用 unicode_escape(会破坏 UTF-8 多字节)
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

BAD = ["现场", "饭拍", "翻唱", "reaction", "Reaction", "反应", "教唱", "伴奏", "纯伴奏", "倒放", "调音", "remix", "Remix", "合集", "cover", "Cover"]
GOOD = ["MV", "官方", "原曲", "OST", "主题曲", "音源", "高清", "4K", "完整版"]

def rank(items, keyword):
    # WT-P3-004:查询词(歌名+歌手)命中优先于任何 GOOD 加分——缺查询词的无关项
    # 不得凭"官方MV"字样压过精确匹配;BAD 降权防同名错版(现场/翻唱)。
    words = [w.lower() for w in keyword.split() if w]
    for it in items:
        t = it["title"]
        tl = t.lower()
        hit = sum(1 for w in words if w in tl)
        miss = len(words) - hit
        score = hit * 2.0 - miss * 3.0
        score -= sum(1 for b in BAD if b in tl) * 3.0
        score += sum(1 for g in GOOD if g in tl) * 0.5
        it["score"] = score
    return sorted(items, key=lambda x: -x["score"])

def fetch_audio(bvid, out_path):
    j = json.loads(http_get("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid))
    if j["code"] != 0:
        raise RuntimeError("view: %s %s" % (j["code"], j["message"]))
    cid = j["data"]["cid"]
    title = j["data"]["title"]
    duration = float(j["data"]["duration"])
    j = json.loads(http_get("https://api.bilibili.com/x/player/playurl?bvid=%s&cid=%s&fnval=16" % (bvid, cid)))
    if j["code"] != 0:
        raise RuntimeError("playurl: %s %s" % (j["code"], j["message"]))
    auds = j["data"]["dash"]["audio"]
    best = max(auds, key=lambda a: a["bandwidth"])
    data = http_get(best["baseUrl"], "https://www.bilibili.com/video/" + bvid)
    open(out_path, "wb").write(data)
    return title, duration

def main():
    title, work_dir, start_ratio, clip_seconds, ffmpeg = (
        sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5])
    os.makedirs(work_dir, exist_ok=True)
    log("searching: %s" % title)
    items = search(title)
    if not items:
        raise RuntimeError("search: no results")
    ranked = rank(items, title)
    best = ranked[0]
    if best["score"] < 1.0:
        # 需至少命中一个查询词(词命中 +2)且未被 BAD 显著降权;否则宁可不唱不唱错版
        raise RuntimeError("search: no reliable match for %r (best=%r score=%.1f)" % (title, best["title"][:40], best["score"]))
    log("chosen: %s %s" % (best["bvid"], best["title"][:60]))

    raw_path = os.path.join(work_dir, "song.m4s")
    chosen_title, duration = fetch_audio(best["bvid"], raw_path)
    log("downloaded %d bytes, duration=%.1fs" % (os.path.getsize(raw_path), duration))

    # 切片:混音上直接切(分离只需处理片段,省时);clamp 不越界
    start = max(0.0, min(duration - 3.0, duration * start_ratio))
    clip_path = os.path.join(work_dir, "clip.wav")
    subprocess.run([ffmpeg, "-y", "-v", "error", "-i", raw_path,
                    "-ss", "%.2f" % start, "-t", "%.2f" % clip_seconds,
                    "-ar", "44100", "-ac", "2", clip_path], check=True)
    os.remove(raw_path)
    print(json.dumps({"chosenTitle": chosen_title, "clipPath": clip_path, "durationSec": duration}, ensure_ascii=False))

if __name__ == "__main__":
    main()
