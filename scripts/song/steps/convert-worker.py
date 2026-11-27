# -*- coding: utf-8 -*-
"""唱歌管线换声工作进程(预热式)。启动即完成依赖导入与模型加载(实测 16-28 秒),
就绪后从 stdin 读一条 JSON 指令,推理一次、写出 wav、回 JSON 后退出——
保持「每进程只推理一次」的隔离语义(核显 DirectML 同进程连续推理第 2 次起
实测 DXGI_ERROR_DEVICE_REMOVED,见 ROADMAP 评估段)。
stdin 为关闭状态(EOF)时加载完成即退出——服务启动期缓存预热(W)复用同一脚本。
stdout 协议(每行一个 JSON,写后必须 flush):
  {"event":"ready","device":...} → 读指令 → {"event":"done",...} 或 {"event":"error","phase":...}
进度/诊断一律走 stderr。
用法: convert-worker.py (无位置参数;cwd 必须为 RVC 包目录)
"""
import glob
import json
import os
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')  # Windows 重定向下默认 GBK(WT-P3-009)
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')
if hasattr(sys.stdin, 'reconfigure'):
    sys.stdin.reconfigure(encoding='utf-8')   # 指令由 Node 以 UTF-8 写入(路径可能含中文)

# 嵌入式 runtime 的 ._pth 配置不把脚本目录放进 sys.path(实测 ModuleNotFoundError),显式加入
# 才能复用 convert.py 的实现
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from convert import median_of


def log(msg):
    print(msg, file=sys.stderr)


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def load_model():
    # RVC configs 在 import 时 argparse 抢 sys.argv(老坑);先置空再导入,参数已不存在
    sys.argv = [sys.argv[0]]
    sys.path.insert(0, os.getcwd())
    os.environ["weight_root"] = "assets/weights"
    os.environ["rmvpe_root"] = "assets/rmvpe"

    import numpy as np
    from configs.config import Config
    from infer.vc.modules import VC

    config = Config()
    # 预热(W)强制 CPU:磁盘与杀软预热与推理设备无关,避免与首个任务的 DML 初始化
    # 并发冲突(审核 001227 实测:预热与任务同时初始化 DirectML 时后者抛错逼入回退)
    if os.environ.get("WHALETALK_CONVERT_DEVICE") == "cpu":
        config.device = "cpu"
        log("convert device forced to cpu (warmup)")
    vc = VC(config)
    vc.get_vc("tidepost.pth", 0.5, 0.33)
    log("model loaded. tgt_sr=%s" % vc.tgt_sr)

    index_path = ""
    candidates = sorted(glob.glob(r"logs\tidepost\added_*tidepost_v2.index"))
    if candidates:
        index_path = candidates[0]
        log("index: %s" % index_path)
    return np, config, vc, index_path


def convert(np, vc, index_path, cmd):
    info, (sr, audio) = vc.vc_single(
        0, cmd["vocalsPath"], int(cmd["key"]), "rmvpe", index_path,
        float(cmd["indexRate"]), 0, float(cmd["rmsMixRate"]), float(cmd["protect"]),
    )
    log(info)
    if audio is None:
        raise RuntimeError("no audio produced")
    audio = np.asarray(audio).reshape(-1)

    out_wav = os.path.join(cmd["workDir"], "song-converted.wav")
    import soundfile as sf
    with sf.SoundFile(out_wav, mode="w", samplerate=sr, channels=1, subtype="PCM_16") as f:
        f.write(np.clip(audio, -32768, 32767).astype(np.int16))
    return out_wav


def main():
    try:
        np, config, vc, index_path = load_model()
    except Exception as err:  # noqa: BLE001
        emit({"event": "error", "phase": "load", "message": str(err)[:400]})
        raise
    emit({"event": "ready", "device": str(getattr(config, "device", "?"))})

    line = sys.stdin.readline()
    if line.strip() == "":
        log("no command on stdin (EOF); exiting after warm load")
        return
    try:
        cmd = json.loads(line)
        wav_path = convert(np, vc, index_path, cmd)
        emit({"event": "done", "wavPath": wav_path, "medianHz": median_of(wav_path)})
    except Exception as err:  # noqa: BLE001
        emit({"event": "error", "phase": "convert", "message": str(err)[:400]})
        raise


if __name__ == "__main__":
    main()
