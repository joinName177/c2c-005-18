import { describe, expect, it } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { ChannelMode, VoiceMeme } from '../../core/models';

const FEATURES = { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 };

function dependencies(overrides: Partial<StudioDependencies> = {}): StudioDependencies {
  const saved: VoiceMeme[] = [];
  return {
    recorder: { isRecording: false, start: async () => {}, stop: async () => new Blob(['voice'], { type: 'audio/webm' }) },
    analyzer: { analyze: async (_blob: Blob, mode: ChannelMode = 'left') => ({ duration: 2, channelMode: mode, channelCount: 2, features: { ...FEATURES } }) },
    cropper: { inspect: async () => ({duration:2,needsCrop:false,channelCount:2}), crop: async (blob, range) => ({blob,duration:range.end-range.start}) },
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
    await studio.save(); expect(studio.error.value).toContain('保存失败'); expect(studio.draft.audio?.size).toBe(1);
    const existing = { id:'old',title:'旧作品',emotion:'温柔姐姐' as const,confidence:.8,features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(existing); expect(studio.draft.title).toBe('旧作品'); expect(studio.stage.value).toBe('cover');
  });
  it('invalidates the old analysis when the channel mode changes until re-analyzed', async () => {
    const studio = useStudio(dependencies());
    await studio.startRecording(); await studio.stopRecording(); await studio.analyze();
    expect(studio.emotionStale.value).toBe(false);
    studio.setChannelMode('dual');
    expect(studio.emotionStale.value).toBe(true);
    studio.goCover(); expect(studio.stage.value).toBe('emotion');
    await studio.save(); expect(studio.error.value).toContain('重新分析');
    await studio.analyze();
    expect(studio.emotionStale.value).toBe(false);
    studio.goCover(); expect(studio.stage.value).toBe('cover');
  });
  it('keeps a retryable state when analysis fails', async () => {
    let broken = true;
    const analyzer = { analyze: async (_blob: Blob, mode: ChannelMode = 'left') => { if (broken) throw new Error('解码失败'); return { duration: 2, channelMode: mode, channelCount: 2, features: { ...FEATURES } }; } };
    const studio = useStudio(dependencies({ analyzer }));
    await studio.startRecording(); await studio.stopRecording();
    await studio.analyze();
    expect(studio.error.value).toContain('分析失败');
    expect(studio.stage.value).toBe('crop');
    broken = false;
    await studio.analyze();
    expect(studio.stage.value).toBe('emotion');
  });
  it('keeps the flagged old result retryable when re-analysis fails', async () => {
    let broken = false;
    const analyzer = { analyze: async (_blob: Blob, mode: ChannelMode = 'left') => { if (broken) throw new Error('解码失败'); return { duration: 2, channelMode: mode, channelCount: 2, features: { ...FEATURES } }; } };
    const studio = useStudio(dependencies({ analyzer }));
    await studio.startRecording(); await studio.stopRecording(); await studio.analyze();
    studio.setChannelMode('right');
    broken = true;
    await studio.analyze();
    expect(studio.error.value).toContain('分析失败');
    expect(studio.emotionStale.value).toBe(true);
    expect(studio.stage.value).toBe('emotion');
    broken = false;
    await studio.analyze();
    expect(studio.emotionStale.value).toBe(false);
  });
  it('offers only the existing channel for mono audio', async () => {
    const studio = useStudio(dependencies({ cropper: { inspect: async () => ({duration:2,needsCrop:false,channelCount:1}), crop: async (blob, range) => ({blob,duration:range.end-range.start}) } }));
    await studio.startRecording(); await studio.stopRecording();
    expect(studio.availableModes.value).toEqual(['left']);
    studio.setChannelMode('dual');
    expect(studio.draft.channelMode).toBe('left');
  });
  it('saves the channel mode with the work and reads legacy works as left channel', async () => {
    const saved: VoiceMeme[] = [];
    const studio = useStudio(dependencies({ repository: { list:async()=>saved, save:async(m)=>{saved.push(m)}, rename:async()=>{}, delete:async()=>{} } }));
    await studio.startRecording(); await studio.stopRecording();
    studio.setChannelMode('dual');
    await studio.analyze();
    await studio.save();
    expect(saved[0].channelMode).toBe('dual');
    const legacy = { id:'old',title:'旧作品',emotion:'温柔姐姐' as const,confidence:.8,features:{...FEATURES},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(legacy);
    expect(studio.draft.channelMode).toBe('left');
    expect(studio.emotionStale.value).toBe(false);
  });
});
