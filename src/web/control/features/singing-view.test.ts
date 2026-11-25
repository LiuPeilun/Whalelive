import { describe, expect, it } from 'vitest';
import { describeFailure, elapsedLabel, failureDetail, keyLabel } from './singing-view.js';

// 点歌面板文案纯函数(面板其余部分依赖 DOM,渲染在真实浏览器实测中验证)。

describe('describeFailure(失败原因 → 操作者说明)', () => {
  it('管线步骤失败:中文说明 + 异常信息行(不整段展示 traceback)', () => {
    expect(describeFailure('fetch: RuntimeError: search: no reliable match for \'xxx\'')).toBe(
      '取歌失败(B站搜歌、下载或切片):RuntimeError: search: no reliable match for \'xxx\'',
    );
    expect(describeFailure('convert: aborted')).toBe('换声失败:aborted');
    expect(describeFailure('separate: timeout after 180000ms')).toBe('人声分离失败:timeout after 180000ms');
    // 真实冒烟采得的 traceback 尾部:只留最后一行的异常信息
    const trace = 'fetch: space\\WhaleTalk\\scripts\\song\\steps\\fetch.py", line 106, in main\n    raise RuntimeError("search: no reliable match for %r" % title)\nRuntimeError: search: no reliable match for \'查无此歌\'';
    expect(describeFailure(trace)).toBe('取歌失败(B站搜歌、下载或切片):RuntimeError: search: no reliable match for \'查无此歌\'');
  });

  it('取消与待播队列满有专门说明', () => {
    expect(describeFailure('cancelled')).toBe('已取消(紧急停止中止了制作)');
    expect(describeFailure('queue-full: queue-full')).toBe('成片已做好,但待播队列已满,没能排入播放(queue-full)');
    expect(describeFailure('queue-full: ')).toBe('成片已做好,但待播队列已满,没能排入播放');
  });

  it('未知形态取首行原样展示,不吞错', () => {
    expect(describeFailure('encode aborted')).toBe('encode aborted');
    expect(describeFailure('Error: ffmpeg exit=1: boom\n第二行')).toBe('Error: ffmpeg exit=1: boom');
    // 无中文说明的步骤名:仍取最后一行(异常信息所在行)
    expect(describeFailure('mystery: boom\n  at some frame')).toBe('at some frame');
  });

  it('failureDetail 保留完整原文供悬停查看', () => {
    expect(failureDetail('fetch: a\nb')).toBe('a\nb');
    expect(failureDetail('encode aborted')).toBe('encode aborted');
  });
});

describe('elapsedLabel / keyLabel', () => {
  it('在途任务按当前时间累计,已结束任务取服务端记录的总耗时', () => {
    expect(elapsedLabel({ stage: 'separating', startedAt: 1000, updatedAt: 5000 }, 13_500)).toBe('已用 12 秒');
    expect(elapsedLabel({ stage: 'ready', startedAt: 1000, updatedAt: 96_000 }, 9_999_999)).toBe('耗时 95 秒');
    expect(elapsedLabel({ stage: 'failed', startedAt: 5000, updatedAt: 2000 }, 0)).toBe('耗时 0 秒');
  });

  it('移调:升 / 降 / 原调', () => {
    expect(keyLabel(7)).toBe('升调 7 半音');
    expect(keyLabel(-3)).toBe('降调 3 半音');
    expect(keyLabel(0)).toBe('原调');
  });
});
