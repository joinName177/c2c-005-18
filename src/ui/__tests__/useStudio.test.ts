import { describe, expect, it, vi } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { ChannelMode, VoiceMeme } from '../../core/models';

const stereoFeatures = { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 };

function dependencies(overrides: Partial<StudioDependencies> = {}, channels = 2): StudioDependencies {
  const saved: VoiceMeme[] = [];
  return {
    recorder: { isRecording: false, start: async () => {}, stop: async () => new Blob(['voice'], { type: 'audio/webm' }) },
    analyzer: { analyze: async (_blob: Blob, mode: ChannelMode) => ({ duration: 2, features: stereoFeatures, channelCount: channels, mode, perChannelRms: [.4,.1], energyShare: mode === 'both' ? [.9,.1] : [1], switchCount: 1 }) },
    cropper: { inspect: async () => ({duration:2,needsCrop:false,channelCount:channels}), crop: async (blob, range) => ({blob,duration:range.end-range.start}) },
    renderer: { render: async () => new Blob(['cover'], { type: 'image/png' }) },
    repository: { list: async()=>saved, save: async(m)=>{saved.push(m)}, rename:async()=>{}, delete:async()=>{} },
    share: { share: async () => 'shared' },
    ...overrides,
  };
}

describe('useStudio', () => {
  it('turns microphone denial into a recoverable error', async () => {
    const studio = useStudio(dependencies({ recorder: { isRecording:false, start:async()=>{throw new DOMException('denied','NotAllowedError')}, stop:async()=>new Blob() } }));
    await studio.startRecording();
    expect(studio.error.value).toContain('麦克风权限');
    expect(studio.stage.value).toBe('record');
  });
  it('moves recording through crop and emotion with manual override', async () => {
    const studio = useStudio(dependencies()); await studio.startRecording(); await studio.stopRecording();
    expect(studio.stage.value).toBe('crop'); await studio.analyze(); expect(studio.emotion.value?.label).toBe('元气满满');
    studio.selectEmotion('温柔姐姐'); expect(studio.cover.value.label).toBe('温柔姐姐'); expect(studio.stage.value).toBe('emotion');
  });
  it('keeps the draft when saving fails and can edit an existing work', async () => {
    const studio = useStudio(dependencies({ repository: { list:async()=>[], save:async()=>{throw new DOMException('full','QuotaExceededError')}, rename:async()=>{}, delete:async()=>{} } }));
    studio.draft.audio = new Blob(['a']); studio.draft.duration = 1; studio.cover.value = coverPresetFor('温柔姐姐'); studio.emotion.value = { label:'温柔姐姐',confidence:.8,explanation:'柔和',scores:{'暴躁老哥':0,'温柔姐姐':1,'阴阳怪气':0,'元气满满':0} };
    studio.features.value = { loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2 };
    studio.analyzedMode.value = 'left'; studio.channelMode.value = 'left';
    await studio.save(); expect(studio.error.value).toContain('保存失败'); expect(studio.draft.audio?.size).toBe(1);
    const existing = { id:'old',title:'旧作品',emotion:'温柔姐姐' as const,confidence:.8,features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(existing); expect(studio.draft.title).toBe('旧作品'); expect(studio.stage.value).toBe('cover');
    expect(studio.legacyAnalysis.value).toBe(true); expect(studio.analysisLabel.value).toContain('旧版单侧口径');
  });
  it('defaults stereo imports to dual fusion, and only offers left channel for mono', async () => {
    const stereo = useStudio(dependencies()); await stereo.startRecording(); await stereo.stopRecording();
    expect(stereo.channelMode.value).toBe('both'); expect(stereo.availableModes.value).toEqual(['left','right','both']);
    const mono = useStudio(dependencies({}, 1)); await mono.startRecording(); await mono.stopRecording();
    expect(mono.channelMode.value).toBe('left'); expect(mono.availableModes.value).toEqual(['left']);
    mono.setChannelMode('both'); expect(mono.channelMode.value).toBe('left');
  });
  it('marks previous analysis stale after caliber switch and requires re-analysis', async () => {
    const studio = useStudio(dependencies()); await studio.startRecording(); await studio.stopRecording(); await studio.analyze();
    expect(studio.analyzedMode.value).toBe('both');
    studio.setChannelMode('left');
    expect(studio.resultStale.value).toBe(true);
    studio.goCover(); expect(studio.stage.value).toBe('emotion');
    await studio.save(); expect(studio.error.value).toContain('重新分析');
    studio.selectEmotion('温柔姐姐'); expect(studio.emotion.value?.label).toBe('元气满满');
    await studio.analyze(); expect(studio.resultStale.value).toBe(false);
    expect(studio.emotion.value?.label).toBe('元气满满'); expect(studio.analyzedMode.value).toBe('left');
  });
  it('keeps the old result and an error banner when re-analysis fails, then recovers on retry', async () => {
    const analyze = vi.fn()
      .mockResolvedValueOnce({ duration: 2, features: stereoFeatures, channelCount: 2, mode: 'both', perChannelRms: [.4,.1], energyShare: [.9,.1], switchCount: 1 })
      .mockRejectedValueOnce(new DOMException('boom', 'OperationError'))
      .mockResolvedValueOnce({ duration: 2, features: stereoFeatures, channelCount: 2, mode: 'left', perChannelRms: [.4,.1], energyShare: [1], switchCount: 1 });
    const studio = useStudio(dependencies({ analyzer: { analyze: analyze as StudioDependencies['analyzer']['analyze'] } }));
    await studio.startRecording(); await studio.stopRecording(); await studio.analyze();
    studio.setChannelMode('left');
    await studio.analyze();
    expect(studio.analyzeError.value).toContain('情绪分析失败');
    expect(studio.resultStale.value).toBe(true);
    expect(studio.emotion.value?.label).toBe('元气满满');
    expect(studio.stage.value).toBe('emotion');
    await studio.analyze();
    expect(studio.analyzeError.value).toBe('');
    expect(studio.analyzedMode.value).toBe('left');
    expect(studio.resultStale.value).toBe(false);
  });
  it('persists the caliber with the work and forbids analyzing mono in dual mode', async () => {
    const saved: VoiceMeme[] = [];
    const repo = { list: async () => saved, save: async (m: VoiceMeme) => { saved.push(m); }, rename: async () => {}, delete: async () => {} };
    const studio = useStudio(dependencies({ repository: repo }));
    await studio.startRecording(); await studio.stopRecording(); await studio.analyze(); await studio.goCover(); await studio.save();
    expect(saved[0]?.analysisChannel).toBe('both');

    const mono = useStudio(dependencies({ repository: repo }, 1));
    await mono.startRecording(); await mono.stopRecording();
    mono.channelMode.value = 'both';
    await mono.analyze();
    expect(mono.analyzeError.value).toContain('单声道');
    expect(mono.analyzedMode.value).toBeUndefined();
  });
});
