import type { AudioFeatures, ChannelMode } from '../core/models';
export interface ChannelAnalysis {
  features: AudioFeatures;
  duration: number;
  channelCount: number;
  mode: ChannelMode;
  perChannelRms: number[];
  energyShare: number[];
  switchCount: number;
}
export interface AudioAnalyzerPort { analyze(blob: Blob, mode: ChannelMode): Promise<ChannelAnalysis> }
