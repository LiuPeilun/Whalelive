# -*- coding: utf-8 -*-
# 音色差异定量分析:基频分布 + 谱质心 + MFCC 距离
# 对比四方:张韶涵分离人声(唱歌输入) / 晓伊TTS语料(训练分布) / 说话换声成功样本 / 唱歌换声失败样本
import warnings

warnings.filterwarnings("ignore")
import glob

import librosa
import numpy as np

def stats(path, label, offset=0, duration=None):
    y, sr = librosa.load(path, sr=22050, offset=offset, duration=duration)
    # f0 (pyin, 人声范围 65-1000Hz)
    f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=1000, sr=sr)
    f0v = f0[~np.isnan(f0)]
    # 谱质心(亮度) 与 MFCC 均值(音色指纹)
    cent = np.mean(librosa.feature.spectral_centroid(y=y, sr=sr))
    mfcc = np.mean(librosa.feature.mfcc(y=y, sr=sr, n_mfcc=20), axis=1)
    rolloff = np.mean(librosa.feature.spectral_rolloff(y=y, sr=sr))
    voiced_ratio = np.mean(~np.isnan(f0)) if len(f0) else 0
    s = {
        "label": label,
        "f0_med": float(np.median(f0v)) if len(f0v) else 0,
        "f0_p10": float(np.percentile(f0v, 10)) if len(f0v) else 0,
        "f0_p90": float(np.percentile(f0v, 90)) if len(f0v) else 0,
        "centroid": float(cent),
        "rolloff": float(rolloff),
        "voiced": float(voiced_ratio),
        "mfcc": mfcc,
    }
    print("%-14s f0中位=%3.0fHz 区间[%.0f-%.0f] 谱质心=%4.0fHz 滚降=%5.0fHz 有声占比=%.0f%%"
          % (label, s["f0_med"], s["f0_p10"], s["f0_p90"], s["centroid"], s["rolloff"], s["voiced"] * 100))
    return s

BASE = r"D:\Project\dsh-workspace\WhaleTalk"
samples = [
    (BASE + r"\data\song\test-output\separated\htdemucs\pianzhang-clip40s\vocals.wav",
     "张韶涵分离人声", 0, 24),
    (glob.glob(BASE + r"\data\song\corpus\00*.mp3")[0], "晓伊训练语料", 0, 10),
    (glob.glob(BASE + r"\data\song\corpus\01*.mp3")[0], "晓伊训练语料2", 0, 10),
    (BASE + r"\data\song\auditions\晓伊-音调加可爱.mp3", "晓伊TTS说话", 0, 10),
    (BASE + r"\data\song\auditions\换声冒烟-晓晓输入→晓伊模型.mp3", "说话换声(满意)", 0, None),
    (BASE + r"\.tools\rvc\RVC20260718DML\opt\pianzhang-xiaoyi-24s.wav", "唱歌换声(失败)", 0, None),
]
print("=== 单样本特征 ===")
S = [stats(*a) for a in samples]

ref = S[2]["mfcc"]  # 基准=晓伊训练语料
print("\n=== MFCC 音色距离(越小越像,基准=晓伊训练语料) ===")
for s in S:
    d = float(np.linalg.norm(s["mfcc"] - ref))
    print("%-14s dist=%.1f" % (s["label"], d))
