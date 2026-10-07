import { describe, expect, it } from 'vitest';
import { WebAudioCropperAdapter, type DecodedAudio } from '../web-audio-cropper.adapter';
import { WebAudioAnalyzerAdapter } from '../web-audio-analyzer.adapter';

const decoded = (duration = 12): DecodedAudio => ({ sampleRate: 10, duration, channels: [Float32Array.from({ length: duration * 10 }, (_, index) => index % 5 ? .4 : 0)] });

describe('WebAudioCropperAdapter', () => {
  it('marks imports over ten seconds as requiring crop', async () => {
    const adapter = new WebAudioCropperAdapter({ decode: async () => decoded(12) });
    expect(await adapter.inspect(new Blob())).toEqual({ duration: 12, needsCrop: true, channelCount: 1 });
  });
  it('caps encoded output range at ten seconds', async () => {
    const adapter = new WebAudioCropperAdapter({ decode: async () => decoded(12) });
    const result = await adapter.crop(new Blob(), { start: 1, end: 11 });
    expect(result.duration).toBe(10);
    expect(result.blob.type).toBe('audio/wav');
  });
});

describe('WebAudioAnalyzerAdapter', () => {
  it('extracts finite normalized features and duration', async () => {
    const result = await new WebAudioAnalyzerAdapter({ decode: async () => decoded(2) }).analyze(new Blob());
    expect(result.duration).toBe(2);
    expect(result.channelMode).toBe('left');
    expect(result.channelCount).toBe(1);
    expect(Object.values(result.features).every(Number.isFinite)).toBe(true);
  });
  it('falls back to the existing channel when dual is requested for mono audio', async () => {
    const result = await new WebAudioAnalyzerAdapter({ decode: async () => decoded(2) }).analyze(new Blob(), 'dual');
    expect(result.channelMode).toBe('left');
    expect(result.channelCount).toBe(1);
  });
  it('reads the requested stereo side and merges dual without phase cancellation', async () => {
    const left = Float32Array.from({ length: 20 }, (_, index) => index % 2 ? .4 : -.4);
    const right = Float32Array.from(left, (value) => -value);
    const stereo: DecodedAudio = { sampleRate: 10, duration: 2, channels: [left, right] };
    const adapter = new WebAudioAnalyzerAdapter({ decode: async () => stereo });
    const dual = await adapter.analyze(new Blob(), 'dual');
    const leftOnly = await adapter.analyze(new Blob(), 'left');
    const rightOnly = await adapter.analyze(new Blob(), 'right');
    expect(dual.channelMode).toBe('dual');
    expect(rightOnly.features.loudness).toBeCloseTo(leftOnly.features.loudness, 10);
    expect(dual.features.loudness).toBeCloseTo(leftOnly.features.loudness, 10);
    expect(dual.features.loudness).toBeGreaterThan(.4);
    expect(dual.features.pauseRatio).toBe(0);
  });
});
