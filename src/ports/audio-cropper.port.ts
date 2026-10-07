import type { CropRange } from '../core/models';
export interface AudioCropperPort { inspect(blob: Blob): Promise<{ duration: number; needsCrop: boolean; channelCount: number }>; crop(blob: Blob, range: CropRange): Promise<{ blob: Blob; duration: number }> }
