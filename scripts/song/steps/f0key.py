# -*- coding: utf-8 -*-
"""唱歌管线 [3/4] 测人声 f0 中位(librosa pyin,RVC runtime 带 librosa)。
stdout 最后一行输出 JSON: {medianHz}
用法: f0key.py <vocals.wav>
"""
import json, sys

import numpy as np

def log(msg):
    print(msg, file=sys.stderr)

def main():
    vocals = sys.argv[1]
    import librosa
    y, sr = librosa.load(vocals, sr=22050)
    f0, _, _ = librosa.pyin(y, fmin=65, fmax=1000, sr=sr)
    f0v = f0[~np.isnan(f0)]
    if len(f0v) == 0:
        raise RuntimeError("no voiced frames detected")
    median = float(np.median(f0v))
    log("f0 median=%.1fHz voiced=%d" % (median, len(f0v)))
    print(json.dumps({"medianHz": median}))

if __name__ == "__main__":
    main()
