import { describe, expect, it } from 'vitest';
import { analyzeChannels, availableChannelModes, ChannelUnavailableError, fusedFeaturesToRaw, resolveChannelMode, type ChannelMode } from '../channel-fusion';

// 25ms 帧 × 1000Hz 采样率 = 25 样本/帧；用 50Hz 正弦（每帧 1.25 个周期）生成“说话声”
const SAMPLE_RATE = 1000;
const FRAMES = 40; // 1 秒
const FRAME_SIZE = 25;
const TOTAL = FRAMES * FRAME_SIZE;

function tone(startFrame = 0, frameCount = FRAMES, amplitude = 0.4, phase = 0, freq = 50): Float32Array {
  const out = new Float32Array(TOTAL);
  for (let i = startFrame * FRAME_SIZE; i < Math.min(TOTAL, (startFrame + frameCount) * FRAME_SIZE); i += 1) {
    out[i] = amplitude * Math.sin(2 * Math.PI * freq * (i / SAMPLE_RATE) + phase);
  }
  return out;
}

function run(channels: Float32Array[], mode: ChannelMode = 'both') {
  return analyzeChannels(channels, SAMPLE_RATE, mode);
}

const globalRms = (channel: Float32Array) => Math.sqrt(channel.reduce((sum, value) => sum + value * value, 0) / channel.length);

describe('availableChannelModes / resolveChannelMode', () => {
  it('offers every existing choice for stereo but only left for mono', () => {
    expect(availableChannelModes(1)).toEqual(['left']);
    expect(availableChannelModes(2)).toEqual(['left', 'right', 'both']);
    expect(availableChannelModes(0)).toEqual([]);
    expect(resolveChannelMode('left', 1)).toBe('left');
    expect(() => resolveChannelMode('right', 1)).toThrow(ChannelUnavailableError);
    expect(() => resolveChannelMode('both', 1)).toThrow('单声道');
  });
});

describe('双声道按帧能量汇合', () => {
  it('双侧同声（同相）：汇合能量等于任一侧，不叠加增益', () => {
    const left = tone();
    const right = tone(); // 完全相同
    const expected = globalRms(left);
    const fused = run([left, right]);
    expect(fused.rms).toBeCloseTo(expected, 10);
    expect(fused.report.energyShare[0]).toBeCloseTo(0.5, 6);
    expect(fused.report.energyShare[1]).toBeCloseTo(0.5, 6);
    expect(fused.report.switchCount).toBe(0);
  });

  it('双侧反相同声：结果与同相一致，不发生抵消', () => {
    const left = tone();
    const right = Float32Array.from(tone(), (value) => -value);
    // 样本直接相加必然全零抵消……
    const summed = Float32Array.from(left, (value, index) => value + right[index]!);
    expect(globalRms(summed)).toBeCloseTo(0, 12);
    // ……但能量汇合对相位盲：与同相场景结果一致
    const inPhase = run([left, tone()]);
    const antiPhase = run([left, right]);
    expect(antiPhase.rms).toBeCloseTo(inPhase.rms, 10);
    expect(antiPhase.rms).toBeCloseTo(globalRms(left), 10);
    // 过零率仅在约每 25 个样本一次的帧边界上因反相符号取反而有 ≤1/帧长 量级差异，
    // 这里要求差异远小于一帧内过零贡献（< 1%）
    expect(Math.abs(antiPhase.zeroCrossingRate - inPhase.zeroCrossingRate)).toBeLessThan(1 / (FRAME_SIZE - 1));
    expect(antiPhase.pauseRatio).toBeCloseTo(inPhase.pauseRatio, 10);
  });

  it('单侧静音：静音侧不稀释有声侧，汇合结果等于有声侧', () => {
    const voiced = tone();
    const silent = new Float32Array(TOTAL);
    const expected = globalRms(voiced);
    const fused = run([voiced, silent]);
    expect(fused.rms).toBeCloseTo(expected, 10);
    // 固定 0.5/0.5 平均会把 RMS 压到 0.707 倍（3dB 稀释），这里必须避免
    expect(fused.rms).not.toBeCloseTo(expected * Math.SQRT1_2, 3);
    expect(fused.report.energyShare[0]).toBeCloseTo(1, 8);
    expect(fused.report.energyShare[1]).toBeCloseTo(0, 8);
    expect(fused.pauseRatio).toBeCloseTo(run([voiced, voiced]).pauseRatio, 10);
    // 左右镜像对称
    const mirrored = run([silent, voiced]);
    expect(mirrored.rms).toBeCloseTo(expected, 10);
    expect(mirrored.report.energyShare[1]).toBeCloseTo(1, 8);
  });

  it('左右交替说话：逐帧跟随当前说话侧，权重不落到静音侧，并统计切换次数', () => {
    // 左说前半段、右说后半段
    const left = tone(0, FRAMES / 2);
    const right = tone(FRAMES / 2, FRAMES / 2);
    const fused = run([left, right]);
    // 每一刻都恰有一侧在说话：汇合 RMS 等于单侧全程说话，静音半段不参与、也不补偿
    expect(fused.rms).toBeCloseTo(globalRms(tone()), 6);
    // 前半帧权重全在左、后半帧全在右
    expect(fused.report.energyShare[0]).toBeCloseTo(0.5, 6);
    expect(fused.report.energyShare[1]).toBeCloseTo(0.5, 6);
    expect(fused.report.switchCount).toBeGreaterThanOrEqual(1);
    // 停顿比例不应把“轮到另一侧说话”误判为停顿：与单侧整段说话相同
    const solo = run([tone(), new Float32Array(TOTAL)]);
    expect(fused.pauseRatio).toBeCloseTo(solo.pauseRatio, 6);
    // 过零率同样跟随有声侧
    expect(fused.zeroCrossingRate).toBeCloseTo(solo.zeroCrossingRate, 6);
  });

  it('短时段来回交替也能逐帧跟随，不产生固定半权', () => {
    // 每 5 帧（125ms）左右轮换
    const left = new Float32Array(TOTAL);
    const right = new Float32Array(TOTAL);
    for (let frame = 0; frame < FRAMES; frame += 1) {
      const channel = frame % 10 < 5 ? left : right;
      for (let i = frame * FRAME_SIZE; i < (frame + 1) * FRAME_SIZE; i += 1) {
        channel[i] = 0.4 * Math.sin(2 * Math.PI * 50 * (i / SAMPLE_RATE));
      }
    }
    const fused = run([left, right]);
    // 每一刻都恰有一侧在说话，汇合 RMS 应等于单侧全程说话
    expect(fused.rms).toBeCloseTo(globalRms(tone()), 6);
    expect(fused.report.energyShare[0]).toBeCloseTo(0.5, 6);
    expect(fused.report.switchCount).toBeGreaterThanOrEqual(3);
  });

  it('单声道各口径与旧全局统计逐项一致（情绪映射不漂移）', () => {
    const channel = Float32Array.from({ length: TOTAL }, (_, index) => (index % 5 ? 0.4 * Math.sin(2 * Math.PI * 50 * index / SAMPLE_RATE) : 0));
    const fused = run([channel], 'left');
    let crossings = 0;
    let silent = 0;
    // 与旧分析器完全一致的全局循环口径（i 从 1 开始，首个样本不计入静音）
    for (let i = 1; i < channel.length; i += 1) {
      if ((channel[i - 1]! < 0) !== (channel[i]! < 0)) crossings += 1;
      if (Math.abs(channel[i]!) < 0.02) silent += 1;
    }
    expect(fused.totalCrossings).toBe(crossings);
    expect(fused.pauseRatio).toBeCloseTo(silent / channel.length, 10);
    expect(fused.rms).toBeCloseTo(globalRms(channel), 10);
  });

  it('全静音不产生 NaN，且停顿比例为 1（与旧全局口径一致，首样本不计入）', () => {
    const fused = run([new Float32Array(TOTAL), new Float32Array(TOTAL)]);
    expect(fused.rms).toBe(0);
    expect(fused.pauseRatio).toBeCloseTo((TOTAL - 1) / TOTAL, 10);
    expect(fused.report.energyShare.every((value) => Number.isFinite(value))).toBe(true);
  });

  it('输出给归一化器的原始特征全部有限', () => {
    const raw = fusedFeaturesToRaw(run([tone(), new Float32Array(TOTAL)]));
    expect(Object.values(raw).every(Number.isFinite)).toBe(true);
  });

  it('右声道口径独立取第二路长度与内容，不依赖第一路', () => {
    const left = new Float32Array(TOTAL / 2).fill(0.1);
    const right = tone();
    const fused = analyzeChannels([left, right], SAMPLE_RATE, 'right');
    expect(fused.duration).toBeCloseTo(1, 8);
    expect(fused.rms).toBeCloseTo(globalRms(right), 8);
    expect(fused.report.energyShare).toEqual([1]);
  });

  it('参与声道短于另一路（异常素材）时汇合统计仍全部有限', () => {
    const long = tone();
    const short = new Float32Array(10);
    const fused = analyzeChannels([long, short], SAMPLE_RATE, 'both');
    expect([fused.rms, fused.zeroCrossingRate, fused.pauseRatio, fused.totalCrossings].every(Number.isFinite)).toBe(true);
    expect(fused.report.perChannelRms.every(Number.isFinite)).toBe(true);
    expect(fused.report.energyShare.every(Number.isFinite)).toBe(true);
  });
});
