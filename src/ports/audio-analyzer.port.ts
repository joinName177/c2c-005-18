import type { AudioFeatures, ChannelMode } from '../core/models';
export interface AudioAnalysis { features: AudioFeatures; duration: number; channelMode: ChannelMode; channelCount: number }
export interface AudioAnalyzerPort { analyze(blob: Blob, mode?: ChannelMode): Promise<AudioAnalysis> }
