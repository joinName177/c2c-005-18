/**
 * 情绪分析的声道口径与双声道按帧能量汇合。
 * 纯数值逻辑，不触碰任何浏览器 API（AudioContext 解码留在适配器层）。
 */

/** 情绪分析采用的声道口径：左声道、右声道，或双声道按帧能量汇合 */
export type ChannelMode = 'left' | 'right' | 'both';

export const CHANNEL_MODE_LABELS: Record<ChannelMode, string> = {
  left: '左声道',
  right: '右声道',
  both: '双声道汇合',
};

/** 旧作品没有保存口径字段，历史实现固定读取第一个声道，沿用该口径展示 */
export function analysisChannelLabel(mode: ChannelMode | undefined): string {
  if (!mode) return '左声道（旧版单侧口径）';
  return CHANNEL_MODE_LABELS[mode];
}

export class ChannelUnavailableError extends Error {
  constructor(public readonly requested: ChannelMode, public readonly channelCount: number) {
    super(channelCount <= 1
      ? '当前音频为单声道，仅支持左声道分析，请选择左声道口径。'
      : `该音频不存在「${CHANNEL_MODE_LABELS[requested]}」，请改用可用声道。`);
    this.name = 'ChannelUnavailableError';
  }
}

/** 单声道只允许实际存在的选择；立体声三种口径都开放，多于两声道时仅取前两路 */
export function availableChannelModes(channelCount: number): ChannelMode[] {
  return channelCount >= 2 ? ['left', 'right', 'both'] : channelCount === 1 ? ['left'] : [];
}

export function resolveChannelMode(mode: ChannelMode, channelCount: number): ChannelMode {
  if (!availableChannelModes(channelCount).includes(mode)) throw new ChannelUnavailableError(mode, channelCount);
  return mode;
}

export interface ChannelFusionReport {
  mode: ChannelMode;
  channelCount: number;
  /** 各路原始 RMS，便于界面说明两侧内容差异 */
  perChannelRms: number[];
  /** 各路“有声帧”占比（帧 RMS 达到静音阈值） */
  perChannelActiveRatio: number[];
  /** 汇合时各路实际分到的能量权重份额，单声道口径下选中侧为 1 */
  energyShare: number[];
  /** 双声道口径下逐帧主导声道的切换次数，用于验证左右交替说话能否被跟随 */
  switchCount: number;
}

export interface FusedAudioStats {
  sampleRate: number;
  duration: number;
  rms: number;
  zeroCrossingRate: number;
  pauseRatio: number;
  totalCrossings: number;
  report: ChannelFusionReport;
}

/** 与旧分析器一致的逐样本静音阈值 */
const SILENCE_LEVEL = 0.02;
/** 25ms 一帧：足以按语句/说话人切换，又比逐样本平滑，契合 10 秒内的短语音片段 */
const FRAME_SECONDS = 0.025;
/** 两侧能量相差不到 3dB 时视为同声，不计主导切换，避免边界抖动 */
const SWITCH_RATIO = 0.5;

interface FrameStats {
  length: number;
  rms2: number;
  crossings: number;
  silent: number;
}

/** 帧内统计：过零只统计帧内部相邻样本（start+1 .. end-1），帧边界在循环外按权重单独处理；
 *  首样本不计入静音统计，与旧全局实现的 i=1 起始口径严格一致（单声道结果不漂移） */
function frameStats(channel: Float32Array, start: number, end: number): FrameStats {
  let energy = 0;
  let crossings = 0;
  let silent = 0;
  for (let i = start; i < end; i += 1) {
    const value = channel[i] ?? 0;
    energy += value * value;
    if (i > start && (channel[i - 1]! < 0) !== (value < 0)) crossings += 1;
    if (i > 0 && Math.abs(value) < SILENCE_LEVEL) silent += 1;
  }
  return { length: end - start, rms2: energy / (end - start || 1), crossings, silent };
}

/**
 * 分声道提取后按帧汇合，而非样本相加或固定平均：
 * w_c = E_c / ΣE（帧内能量份额），帧汇合 RMS² = Σ w_c·RMS²_c。
 * - 反相/同相只改变波形符号、不改变能量，两种情况结果一致，不会互相抵消；
 * - 仅一侧有声时该侧权重为 1，静音侧不参与，不会把有声侧稀释出 3dB 落差；
 * - 左右交替说话时权重逐帧跟随当前说话侧，等效分时段选择且无硬切换抖动。
 */
export function analyzeChannels(rawChannels: Float32Array[], sampleRate: number, mode: ChannelMode): FusedAudioStats {
  const channelCount = rawChannels.length;
  resolveChannelMode(mode, channelCount);
  // 超过两声道的素材（罕见）只分析前两路
  const channels = rawChannels.slice(0, 2);
  const sourceIndexes = mode === 'left' ? [0] : mode === 'right' ? [1] : channels.map((_, index) => index);
  const sourceChannels = sourceIndexes.map((index) => channels[index]!);
  // 以参与分析的声道长度为准（右声道口径时不能误用第一声道的长度）
  const length = sourceChannels[0]?.length ?? 0;
  const frameSize = Math.max(1, Math.floor(sampleRate * FRAME_SECONDS));

  let sumEnergy = 0;
  let sumLength = 0;
  let fusedCrossings = 0;
  let fusedSilent = 0;
  let switchCount = 0;
  let previousDominant = -1;
  let frameCount = 0;
  let previousWeights: number[] | undefined;
  let previousEnd = 0;
  const channelRms2 = channels.map(() => 0);
  const channelLengths = channels.map((channel) => channel.length);
  const activeFrames = channels.map(() => 0);
  const shareSum = sourceIndexes.map(() => 0);

  for (let start = 0; start < length; start += frameSize) {
    const end = Math.min(length, start + frameSize);
    const all = channels.map((channel) => frameStats(channel, start, Math.min(channel.length, end)));
    const selected = sourceIndexes.map((index) => all[index]!);
    const sourceEnergy = selected.reduce((sum, frame) => sum + frame.rms2, 0);
    // 全静音帧按帧长回退为均匀权重（所有源帧等长时即 1/N）：汇合结果仍是静音，权重和严格归一
    const totalLength = selected.reduce((sum, frame) => sum + frame.length, 0) || 1;
    const weights = selected.map((frame) => (sourceEnergy > 0 ? frame.rms2 / sourceEnergy : frame.length / totalLength));

    if (previousWeights && start === previousEnd && start > 0) {
      // 帧边界过零：采用两帧权重的逐源最大值（即“该侧在任一侧相邻帧有声时”归属该侧）。
      // 单声道下权重恒为 1，严格等于全局边界计数；交替说话时边界归属相邻的有声侧。
      sourceIndexes.forEach((channelIndex, k) => {
        const prev = previousWeights ? previousWeights[k]! : 0;
        const channel = channels[channelIndex]!;
        if ((channel[start - 1]! < 0) !== ((channel[start] ?? 0) < 0)) {
          fusedCrossings += Math.max(prev, weights[k]!);
        }
      });
    }

    let frameEnergy = 0;
    selected.forEach((frame, index) => {
      frameEnergy += weights[index]! * frame.rms2;
      fusedCrossings += weights[index]! * frame.crossings;
      fusedSilent += weights[index]! * frame.silent;
      shareSum[index]! += weights[index]! * frame.length;
    });

    sumEnergy += frameEnergy * (end - start);
    sumLength += end - start;

    all.forEach((frame, channelIndex) => {
      channelRms2[channelIndex]! += frame.rms2 * frame.length;
      if (frame.rms2 >= SILENCE_LEVEL * SILENCE_LEVEL) activeFrames[channelIndex] += 1;
    });

    if (mode === 'both' && all.length > 1) {
      const louder = Math.max(all[0]!.rms2, all[1]!.rms2);
      const quieter = Math.min(all[0]!.rms2, all[1]!.rms2);
      const distinct = louder > 0 && quieter / louder < SWITCH_RATIO;
      if (distinct) {
        const dominant = all[0]!.rms2 >= all[1]!.rms2 ? 0 : 1;
        // 同声段（能量接近）不更新主导侧，避免在双人同说边界来回跳变
        if (previousDominant >= 0 && dominant !== previousDominant) switchCount += 1;
        previousDominant = dominant;
      }
    }
    previousWeights = weights;
    previousEnd = end;
    frameCount += 1;
  }

  const duration = sampleRate > 0 ? length / sampleRate : 0;
  const rms = sumLength ? Math.sqrt(sumEnergy / sumLength) : 0;
  // 过零的有效前驱数为 length-1；静音统计首样本已排除，分母为帧长和，均与旧全局口径一致
  const zeroCrossingRate = length > 1 ? fusedCrossings / (length - 1) : 0;
  const pauseRatio = sumLength ? fusedSilent / sumLength : 1;
  return {
    sampleRate,
    duration,
    rms,
    zeroCrossingRate,
    pauseRatio,
    totalCrossings: fusedCrossings,
    report: {
      mode,
      channelCount,
      perChannelRms: channelRms2.map((energy, index) => Math.sqrt(energy / (channelLengths[index] || 1))),
      perChannelActiveRatio: channels.map((_, index) => (frameCount ? activeFrames[index]! / frameCount : 0)),
      energyShare: sourceIndexes.map((_, index) => (sumLength ? shareSum[index]! / sumLength : sourceChannels[index] ? 1 / sourceIndexes.length : 0)),
      switchCount,
    },
  };
}

/** 汇合统计量转成情绪引擎消费的原始特征，再由归一化器统一映射（保持旧校准） */
export function fusedFeaturesToRaw(stats: FusedAudioStats) {
  return {
    rms: stats.rms,
    dynamicRange: Math.min(1, stats.rms * 2),
    pitchHz: stats.zeroCrossingRate * stats.sampleRate / 2,
    zeroCrossingRate: Math.min(1, stats.zeroCrossingRate * 10),
    pauseRatio: stats.pauseRatio,
    tempoVariation: Math.min(1, stats.totalCrossings / Math.max(1, stats.duration * 30)),
  };
}
