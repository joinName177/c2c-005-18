import { computed, reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import { availableChannelModes, resolveChannelMode } from '../core/channel-mix';
import { CHANNEL_MODE_LABELS, memeChannelMode, type AudioFeatures, type ChannelMode, type CoverConfig, type EmotionLabel, type EmotionResult, type StudioStage, type VoiceMeme } from '../core/models';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }
export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const draft = reactive<{ id?: string; title: string; audio?: Blob; duration: number; cropStart: number; cropEnd: number; channelMode: ChannelMode; channelCount: number }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0, channelMode: 'left', channelCount: 1 });
  const emotion = ref<EmotionResult>(); const emotionMode = ref<ChannelMode>(); const features = ref<AudioFeatures>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);
  const availableModes = computed(() => availableChannelModes(draft.channelCount));
  const emotionStale = computed(() => !!emotion.value && !!emotionMode.value && emotionMode.value !== draft.channelMode);

  async function startRecording() { error.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }
  function prepareDraft(info: { duration: number; channelCount: number }) { draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); draft.channelCount = info.channelCount; draft.channelMode = resolveChannelMode(draft.channelMode, info.channelCount); emotion.value = undefined; emotionMode.value = undefined; features.value = undefined; }
  async function stopRecording() { try { draft.audio = await deps.recorder.stop(); const info = await deps.cropper.inspect(draft.audio); prepareDraft(info); stage.value = 'crop'; notice.value = info.needsCrop ? '音频超过 10 秒，请选择保留片段' : '录音完成，可以试听并分析'; } catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; } }
  async function importAudio(blob: Blob) { draft.audio = blob; const info = await deps.cropper.inspect(blob); prepareDraft(info); stage.value = 'crop'; }
  async function analyze() {
    if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; }
    error.value = '';
    try {
      const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd });
      draft.audio = cropped.blob; draft.duration = cropped.duration; draft.cropStart = 0; draft.cropEnd = cropped.duration;
      const result = await deps.analyzer.analyze(cropped.blob, draft.channelMode);
      draft.channelCount = result.channelCount; draft.channelMode = result.channelMode;
      features.value = result.features; emotion.value = classifyEmotion(result.features); emotionMode.value = result.channelMode;
      cover.value = coverPresetFor(emotion.value.label); stage.value = 'emotion';
    } catch (cause) { error.value = `分析失败：${cause instanceof Error ? cause.message : '未知原因'}，可调整片段或声道口径后重试`; }
  }
  function setChannelMode(mode: ChannelMode) { if (!availableModes.value.includes(mode) || mode === draft.channelMode) return; draft.channelMode = mode; if (emotionMode.value && emotionMode.value !== mode) notice.value = `已切换为「${CHANNEL_MODE_LABELS[mode]}」口径，重新分析后结果才会更新`; }
  function selectEmotion(label: EmotionLabel) { if (emotionStale.value) { error.value = '声道口径已切换，请先重新分析'; return; } const current = emotion.value ?? classifyEmotion({ loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 }); emotion.value = { ...current, label, explanation: `已手动选择「${label}」标签。` }; cover.value = { ...coverPresetFor(label), title: cover.value.title || label }; }
  function goCover() { if (emotionStale.value) { error.value = '声道口径已切换，请先重新分析'; return; } stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) { if (!draft.audio || !emotion.value || !features.value) { error.value = '作品信息尚未完整，请先完成声音分析'; return; } if (emotionStale.value) { error.value = '声道口径已切换，请重新分析后再保存'; return; } try { const coverBlob = await deps.renderer.render(cover.value, target); const meme: VoiceMeme = { id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音', emotion: emotion.value.label, confidence: emotion.value.confidence, features: features.value, audio: draft.audio, duration: draft.duration, channelMode: emotionMode.value ?? 'left', cover: coverBlob, coverConfig: { ...cover.value }, createdAt: new Date().toISOString() }; await deps.repository.save(meme); await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地'; } catch { error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。'; } }
  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) { const mode = memeChannelMode(meme); Object.assign(draft, { id:meme.id,title:meme.title,audio:meme.audio,duration:meme.duration,cropStart:0,cropEnd:meme.duration,channelMode:mode,channelCount:mode==='left'?1:2 }); features.value = meme.features; emotionMode.value = mode; emotion.value = { label:meme.emotion,confidence:meme.confidence,explanation:'编辑已保存作品',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':0} }; cover.value = { ...meme.coverConfig }; stage.value = 'cover'; }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  async function shareMeme(meme: VoiceMeme) { const result = await deps.share.share(meme); notice.value = result === 'shared' ? '已打开系统分享' : '浏览器不支持文件分享，已下载音频和封面'; }
  function newRecording() { draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; draft.channelMode = 'left'; draft.channelCount = 1; emotion.value = undefined; emotionMode.value = undefined; features.value = undefined; stage.value = 'record'; error.value = ''; }
  return { stage,error,notice,level,draft,emotion,emotionMode,emotionStale,availableModes,features,cover,collection,startRecording,stopRecording,importAudio,analyze,setChannelMode,selectEmotion,goCover,save,loadCollection,editMeme,deleteMeme,shareMeme,newRecording };
}
