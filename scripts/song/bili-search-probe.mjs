// Probe: B 站音频区搜索(wbi 签名,无登录)——唱歌管线搜歌源验证
// 签名逻辑对齐 bilibili-api-dev 18.0.0a2 network.py:_get_mixin_key/_enc_wbi
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const OE = Array.from(
  Buffer.from(
    "Li8SAjUIFyAPMgofOgMtIxsrBTEhCSoTHRwOJwwmKQ0lMAcQGDcoPRoRAAE8Mx4EFhk2FTg7Bj85PgskFCIsNA==",
    "base64",
  ),
);

async function getBuvid() {
  const r = await fetch("https://www.bilibili.com/", {
    headers: { "User-Agent": UA },
  });
  const cookies = r.headers.getSetCookie();
  const joined = cookies
    .map((c) => c.split(";")[0])
    .filter((c) => /^(buvid3|buvid4|b_nut|b_lsid|_uuid)=/.test(c))
    .join("; ");
  if (!joined.includes("buvid3"))
    throw new Error("no buvid3 in set-cookie: " + cookies.length);
  return joined;
}

async function getMixinKey(cookie) {
  const r = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/", Cookie: cookie },
  });
  const j = await r.json();
  const wbi = j.data?.wbi_img;
  if (!wbi) throw new Error("nav no wbi_img: " + JSON.stringify(j).slice(0, 200));
  const keyOf = (u) => u.split("/").pop().split(".")[0];
  const ae = keyOf(wbi.img_url) + keyOf(wbi.sub_url);
  return OE.map((i) => ae[i] ?? "")
    .join("")
    .slice(0, 32);
}

function sign(params, mixinKey) {
  const p = { ...params, wts: Math.round(Date.now() / 1000) };
  const q = new URLSearchParams(Object.entries(p).sort(([a], [b]) => (a < b ? -1 : 1)));
  p.w_rid = crypto.createHash("md5").update(q.toString() + mixinKey).digest("hex");
  return p;
}

const keyword = process.argv[2] ?? "篇章 张韶涵";
const cookie = await getBuvid();
console.log("buvid3 ok");
const mixinKey = await getMixinKey(cookie);
console.log("mixinKey ok:", mixinKey.slice(0, 8) + "…");
const p = sign({ keyword, search_type: "audio", page: 1 }, mixinKey);
const url = new URL("https://api.bilibili.com/x/web-interface/search/type");
for (const [k, v] of Object.entries(p)) url.searchParams.set(k, String(v));
const r = await fetch(url, {
  headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/", Cookie: cookie },
});
const j = await r.json();
if (j.code !== 0) {
  console.error("SEARCH FAILED:", j.code, j.message);
  process.exit(1);
}
const results = j.data?.result ?? [];
console.log(`SEARCH OK: ${results.length} results`);
for (const item of results.slice(0, 5)) {
  console.log(
    `- [${item.id}] ${item.title?.replace(/<[^>]+>/g, "")} | 上传:${item.author ?? item.owner?.name} | 时长:${item.duration}s | 播放:${item.play}`,
  );
}
