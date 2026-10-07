import { analyzeChannels, resolveChannelMode } from '../core/channel-mix';
import type { ChannelMode } from '../core/models';
import type { AudioAnalysis, AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { DecodedAudio } from './web-audio-cropper.adapter';
interface Dependencies { decode(blob: Blob): Promise<DecodedAudio> }
async function decode(blob: Blob): Promise<DecodedAudio> { const context = new AudioContext(); const buffer = await context.decodeAudioData(await blob.arrayBuffer()); const result = { sampleRate: buffer.sampleRate, duration: buffer.duration, channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).slice()) }; await context.close(); return result; }
export class WebAudioAnalyzerAdapter implements AudioAnalyzerPort {
  constructor(private readonly deps: Dependencies = { decode }) {}
  async analyze(blob: Blob, mode: ChannelMode = 'left'): Promise<AudioAnalysis> {
    const audio = await this.deps.decode(blob);
    const channelMode = resolveChannelMode(mode, audio.channels.length);
    const features = analyzeChannels(audio.channels, audio.sampleRate, audio.duration, channelMode);
    return { features, duration: audio.duration, channelMode, channelCount: audio.channels.length };
  }
}
