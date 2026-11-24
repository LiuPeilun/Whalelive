# -*- coding: utf-8 -*-
"""唱歌管线 [2/4] Demucs 人声分离(片段)。whaletalk-song 环境运行,同进程跑 demucs(kill 树生效)。
stdout 最后一行输出 JSON: {vocalsPath}
TORCH_HOME 由 Node 传入(项目内 .tools/torch-home,写 C 盘用户缓存会被拒)。
用法: separate.py <clip.wav> <workdir>
"""
import json, os, sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')  # Windows 重定向下默认 GBK(WT-P3-009)
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

def log(msg):
    print(msg, file=sys.stderr)

def main():
    clip, work_dir = sys.argv[1], sys.argv[2]
    out_root = os.path.join(work_dir, "separated")
    os.makedirs(out_root, exist_ok=True)
    log("demucs separating: %s" % clip)
    import demucs.separate
    demucs.separate.main(["-n", "htdemucs", "-o", out_root, clip])
    base = os.path.splitext(os.path.basename(clip))[0]
    vocals = os.path.join(out_root, "htdemucs", base, "vocals.wav")
    if not os.path.exists(vocals):
        raise RuntimeError("vocals not found: " + vocals)
    print(json.dumps({"vocalsPath": vocals}, ensure_ascii=False))

if __name__ == "__main__":
    main()
