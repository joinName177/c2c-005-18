import { normalizeFeatures, type RawAudioFeatures } from './feature-normalizer';
import type { AudioFeatures, ChannelMode } from './models';

/**
 * 双声道汇合策略：分声道提取特征，再按各声道能量占比加权汇合；
 * 停顿率单独采用“任一声道有声即非停顿”的联合判定。
 *
 * 为什么不混合原始波形：RMS、过零率、停顿都与符号无关，反相内容不会相互抵消；
 * 为什么用能量权重：静音声道能量趋零、权重趋零，不会稀释有声侧，
 * 双侧同声时权重各半但特征相同，结果与单侧一致；
 * 为什么停顿联合判定：单侧静音时退化为有声侧自身的停顿率，
 * 左右交替说话不会把“自己没说的那一半”误记为冷场。
 */

const SILENCE_THRESHOLD = .02;

/** 单声道音频只提供实际存在的选择；多于两声道时取前两声道作为左右。 */
export function availableChannelModes(channelCount: number): ChannelMode[] {
  return channelCount >= 2 ? ['left', 'right', 'dual'] : ['left'];
}

export function resolveChannelMode(mode: ChannelMode, channelCount: number): ChannelMode {
  return availableChannelModes(channelCount).includes(mode) ? mode : 'left';
}

type RawFeatures = Required<RawAudioFeatures>;

export function extractRawFeatures(samples: Float32Array, sampleRate: number, duration: number): RawFeatures {
  const rms = samples.length ? Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) : 0;
  let crossings = 0; let silent = 0;
  for (let i = 0; i < samples.length; i += 1) {
    if (i > 0 && (samples[i - 1] < 0) !== (samples[i] < 0)) crossings += 1;
    if (Math.abs(samples[i]) < SILENCE_THRESHOLD) silent += 1;
  }
  const zcr = samples.length ? crossings / samples.length : 0;
  return {
    rms,
    dynamicRange: Math.min(1, rms * 2),
    pitchHz: zcr * sampleRate / 2,
    zeroCrossingRate: Math.min(1, zcr * 10),
    pauseRatio: samples.length ? silent / samples.length : 1,
    tempoVariation: Math.min(1, crossings / Math.max(1, duration * 30)),
  };
}

function energy(samples: Float32Array): number {
  let total = 0;
  for (const value of samples) total += value * value;
  return total;
}

/** 任一通道在该采样点有声即非停顿：静音侧不会拉高停顿，交替说话不会误记冷场。 */
function jointPauseRatio(left: Float32Array, right: Float32Array): number {
  const length = Math.max(left.length, right.length);
  if (!length) return 1;
  let silent = 0;
  for (let i = 0; i < length; i += 1) {
    if (Math.abs(left[i] ?? 0) < SILENCE_THRESHOLD && Math.abs(right[i] ?? 0) < SILENCE_THRESHOLD) silent += 1;
  }
  return silent / length;
}

export function mergeDualChannels(left: Float32Array, right: Float32Array, sampleRate: number, duration: number): AudioFeatures {
  const leftRaw = extractRawFeatures(left, sampleRate, duration);
  const rightRaw = extractRawFeatures(right, sampleRate, duration);
  const leftEnergy = energy(left); const rightEnergy = energy(right);
  const total = leftEnergy + rightEnergy;
  const leftWeight = total > 1e-8 ? leftEnergy / total : .5;
  const rightWeight = 1 - leftWeight;
  const mix = (a: number, b: number) => leftWeight * a + rightWeight * b;
  return normalizeFeatures({
    rms: mix(leftRaw.rms, rightRaw.rms),
    dynamicRange: mix(leftRaw.dynamicRange, rightRaw.dynamicRange),
    pitchHz: mix(leftRaw.pitchHz, rightRaw.pitchHz),
    zeroCrossingRate: mix(leftRaw.zeroCrossingRate, rightRaw.zeroCrossingRate),
    pauseRatio: jointPauseRatio(left, right),
    tempoVariation: mix(leftRaw.tempoVariation, rightRaw.tempoVariation),
  });
}

export function analyzeChannels(channels: Float32Array[], sampleRate: number, duration: number, mode: ChannelMode): AudioFeatures {
  const resolved = resolveChannelMode(mode, channels.length);
  if (resolved === 'dual') return mergeDualChannels(channels[0] ?? new Float32Array(), channels[1] ?? new Float32Array(), sampleRate, duration);
  const index = resolved === 'right' ? 1 : 0;
  return normalizeFeatures(extractRawFeatures(channels[index] ?? new Float32Array(), sampleRate, duration));
}
