import { analyzeChannels, fusedFeaturesToRaw } from '../core/channel-fusion';
import { normalizeFeatures } from '../core/feature-normalizer';
import type { ChannelMode } from '../core/models';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { DecodedAudio } from './web-audio-cropper.adapter';
interface Dependencies { decode(blob: Blob): Promise<DecodedAudio> }
async function decode(blob: Blob): Promise<DecodedAudio> {
  const context = new AudioContext();
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  // 保留全部声道供口径选择；试听与保存仍由裁剪器按原始声道数编码，不在这里下混
  const result = { sampleRate: buffer.sampleRate, duration: buffer.duration, channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).slice()) };
  await context.close();
  return result;
}
export class WebAudioAnalyzerAdapter implements AudioAnalyzerPort {
  constructor(private readonly deps: Dependencies = { decode }) {}
  async analyze(blob: Blob, mode: ChannelMode) {
    const audio = await this.deps.decode(blob);
    const stats = analyzeChannels(audio.channels.length ? audio.channels : [new Float32Array()], audio.sampleRate, mode);
    const features = normalizeFeatures(fusedFeaturesToRaw(stats));
    return {
      features,
      duration: audio.duration,
      channelCount: audio.channels.length,
      mode: stats.report.mode,
      perChannelRms: stats.report.perChannelRms,
      energyShare: stats.report.energyShare,
      switchCount: stats.report.switchCount,
    };
  }
}
