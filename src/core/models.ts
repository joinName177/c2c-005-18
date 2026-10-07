export type EmotionLabel = '暴躁老哥' | '温柔姐姐' | '阴阳怪气' | '元气满满';
export type StudioStage = 'record' | 'crop' | 'emotion' | 'cover' | 'collection';
export type ChannelMode = 'left' | 'right' | 'dual';
export const CHANNEL_MODE_LABELS: Record<ChannelMode, string> = { left: '左声道', right: '右声道', dual: '双声道' };
export interface CropRange { start: number; end: number }
export interface AudioFeatures { loudness: number; dynamics: number; pitch: number; zeroCrossing: number; pauseRatio: number; tempoVariation: number }
export interface EmotionResult { label: EmotionLabel; confidence: number; explanation: string; scores: Record<EmotionLabel, number> }
export interface CoverConfig {
  label: EmotionLabel;
  title: string;
  bubbleText: string;
  bubbleX: number;
  bubbleY: number;
  palette: [string, string, string];
  filter: 'none' | 'mono' | 'saturate' | 'warm' | 'cool';
  ratio: 'square' | 'portrait';
}
export interface VoiceMeme {
  id: string;
  title: string;
  emotion: EmotionLabel;
  confidence: number;
  features: AudioFeatures;
  audio: Blob;
  duration: number;
  channelMode?: ChannelMode;
  cover: Blob;
  coverConfig: CoverConfig;
  createdAt: string;
}

/** 旧作品没有记录口径，沿用最初的单侧（左声道）分析结果。 */
export function memeChannelMode(meme: Pick<VoiceMeme, 'channelMode'>): ChannelMode { return meme.channelMode ?? 'left'; }

export function validateCropRange(range: CropRange, duration: number): string | undefined {
  if (range.start < 0) return '裁剪起点不能小于 0';
  if (range.end <= range.start) return '裁剪终点必须晚于起点';
  if (range.end > duration) return '裁剪终点超出音频时长';
  if (range.end - range.start > 10) return '裁剪片段不能超过 10 秒';
  return undefined;
}
