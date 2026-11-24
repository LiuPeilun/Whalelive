# -*- coding: utf-8 -*-
"""唱歌管线 [4/4] RVC 换声(晓伊模型)。cwd 必须为 RVC 包目录(模型/索引为包内相对路径)。
key 半音数由 Node 侧按输入 f0 中位计算传入(单一权威实现)。
stdout 最后一行输出 JSON: {wavPath, medianHz}
用法: convert.py <vocals.wav> <key> <indexRate> <protect> <rmsMixRate> <workdir>
"""
import glob, json, os, sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')  # Windows 重定向下默认 GBK(WT-P3-009)
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

MY_ARGV = sys.argv[1:]

def log(msg):
    print(msg, file=sys.stderr)

def main():
    (vocals, key, index_rate, protect, rms_mix, work_dir) = MY_ARGV
    # RVC configs 在 import 时 argparse 抢 sys.argv(老坑);先置空再导入,参数已存 MY_ARGV
    sys.argv = [sys.argv[0]]
    sys.path.insert(0, os.getcwd())
    os.environ["weight_root"] = "assets/weights"
    os.environ["rmvpe_root"] = "assets/rmvpe"

    import numpy as np
    import soundfile as sf
    from configs.config import Config
    from infer.vc.modules import VC

    key = int(key)
    log("f0_up_key=%+d index_rate=%s protect=%s rms=%s" % (key, index_rate, protect, rms_mix))

    config = Config()
    vc = VC(config)
    vc.get_vc("tidepost.pth", 0.5, 0.33)
    log("model loaded. tgt_sr=%s" % vc.tgt_sr)

    index_path = ""
    candidates = sorted(glob.glob(r"logs\tidepost\added_*tidepost_v2.index"))
    if candidates:
        index_path = candidates[0]
        log("index: %s" % index_path)
    info, (sr, audio) = vc.vc_single(
        0, vocals, key, "rmvpe", index_path,
        float(index_rate), 0, float(rms_mix), float(protect),
    )
    log(info)
    if audio is None:
        raise RuntimeError("no audio produced")
    audio = np.asarray(audio).reshape(-1)

    os.makedirs(work_dir, exist_ok=True)
    out_wav = os.path.join(work_dir, "song-converted.wav")
    with sf.SoundFile(out_wav, mode="w", samplerate=sr, channels=1, subtype="PCM_16") as f:
        f.write(np.clip(audio, -32768, 32767).astype(np.int16))
    print(json.dumps({"wavPath": out_wav, "medianHz": median_of(out_wav)}, ensure_ascii=False))

def median_of(path):
    """轻量 f0 中位(自相关法,仅作校验输出)。"""
    import numpy as np
    import soundfile as sf
    y, fs = sf.read(path, dtype="float32")
    if y.ndim > 1:
        y = y[:, 0]
    frame, hop = int(fs * 0.05), int(fs * 0.025)
    medians = []
    for start in range(0, max(1, len(y) - frame), hop * 4):
        seg = y[start:start + frame]
        if np.sqrt(np.mean(seg ** 2)) < 0.01:  # 静音帧跳过
            continue
        seg = seg - seg.mean()
        corr = np.correlate(seg, seg, mode="full")[frame - 1:]
        corr[: int(fs / 1000)] = 0  # 排除 <65Hz 伪峰区
        low = int(fs / 500)
        peak = int(np.argmax(corr[low:])) + low  # 基频 <500Hz
        if peak > 0:
            medians.append(fs / peak)
    return float(np.median(medians)) if medians else 0.0

if __name__ == "__main__":
    main()
