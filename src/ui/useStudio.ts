import { computed, reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import { CHANNEL_MODE_LABELS, availableChannelModes, resolveChannelMode, analysisChannelLabel, type ChannelMode } from '../core/channel-fusion';
import type { AudioFeatures, CoverConfig, EmotionLabel, EmotionResult, StudioStage, VoiceMeme } from '../core/models';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }

export interface ChannelDiagnostics { perChannelRms: number[]; energyShare: number[]; switchCount: number }

export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const draft = reactive<{ id?: string; title: string; audio?: Blob; duration: number; cropStart: number; cropEnd: number }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  const emotion = ref<EmotionResult>(); const features = ref<AudioFeatures>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);

  // —— 声道口径状态 ——
  const channelCount = ref(1);
  const channelMode = ref<ChannelMode>('left');           // 用户当前选择的口径
  const analyzedMode = ref<ChannelMode | undefined>();   // 当前结果实际采用的口径；与 channelMode 不同即结果过期
  const analyzing = ref(false);
  const analyzeError = ref('');
  const diagnostics = ref<ChannelDiagnostics>({ perChannelRms: [], energyShare: [], switchCount: 0 });
  const legacyAnalysis = ref(false);                      // 正在编辑的旧作品是否沿用历史单侧口径
  const availableModes = computed<ChannelMode[]>(() => availableChannelModes(channelCount.value));
  const resultStale = computed(() => analyzedMode.value !== undefined && channelMode.value !== analyzedMode.value);

  function adoptInspectInfo(info: { channelCount: number }) {
    channelCount.value = info.channelCount;
    analyzedMode.value = undefined;
    legacyAnalysis.value = false;
    // 立体声默认双声道汇合（这是本次新增的能力）；单声道只能落到左声道
    channelMode.value = info.channelCount >= 2 ? 'both' : 'left';
  }

  async function startRecording() { error.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }
  async function stopRecording() { try { draft.audio = await deps.recorder.stop(); const info = await deps.cropper.inspect(draft.audio); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); adoptInspectInfo(info); stage.value = 'crop'; notice.value = info.needsCrop ? '音频超过 10 秒，请选择保留片段' : '录音完成，可以试听并分析'; } catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; } }
  async function importAudio(blob: Blob) { draft.audio = blob; const info = await deps.cropper.inspect(blob); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); adoptInspectInfo(info); stage.value = 'crop'; }

  async function analyze() {
    if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; }
    analyzing.value = true; analyzeError.value = '';
    try {
      // 口径不可用（例如对单声道选了右声道/双声道）直接拒绝，不产出误导结果
      resolveChannelMode(channelMode.value, channelCount.value);
      const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd });
      draft.audio = cropped.blob; draft.duration = cropped.duration;
      const result = await deps.analyzer.analyze(cropped.blob, channelMode.value);
      channelCount.value = result.channelCount;
      features.value = result.features;
      emotion.value = classifyEmotion(result.features);
      cover.value = coverPresetFor(emotion.value.label);
      analyzedMode.value = result.mode;
      diagnostics.value = { perChannelRms: result.perChannelRms, energyShare: result.energyShare, switchCount: result.switchCount };
      stage.value = 'emotion';
    } catch (cause) {
      // 失败不清空旧结果、不跳转，留在可重试状态
      analyzeError.value = cause instanceof Error && cause.name === 'ChannelUnavailableError'
        ? cause.message
        : '情绪分析失败，裁剪后的声音仍保留，请切换声道口径或稍后重试。';
    } finally {
      analyzing.value = false;
    }
  }
  function setChannelMode(mode: ChannelMode) {
    if (mode === channelMode.value) return;
    if (!availableModes.value.includes(mode)) return;
    channelMode.value = mode;
    if (analyzedMode.value) notice.value = `口径已切换为「${CHANNEL_MODE_LABELS[mode]}」，下方是旧口径结果，请重新分析后再继续。`;
  }
  function selectEmotion(label: EmotionLabel) { if (resultStale.value) return; const current = emotion.value ?? classifyEmotion({ loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 }); emotion.value = { ...current, label, explanation: `已手动选择「${label}」标签。` }; cover.value = { ...coverPresetFor(label), title: cover.value.title || label }; }
  function goCover() { if (resultStale.value) return; stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) {
    if (!draft.audio || !emotion.value || !features.value || analyzedMode.value === undefined) { error.value = '作品信息尚未完整，请先完成声音分析'; return; }
    if (resultStale.value) { error.value = '声道口径已切换，请用新口径重新分析后再保存。'; return; }
    try {
      const coverBlob = await deps.renderer.render(cover.value, target);
      const meme: VoiceMeme = { id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音', emotion: emotion.value.label, confidence: emotion.value.confidence, features: features.value, audio: draft.audio, duration: draft.duration, cover: coverBlob, coverConfig: { ...cover.value }, analysisChannel: analyzedMode.value, createdAt: new Date().toISOString() };
      await deps.repository.save(meme);
      await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地';
    } catch { error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。'; }
  }
  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) {
    Object.assign(draft, { id:meme.id,title:meme.title,audio:meme.audio,duration:meme.duration,cropStart:0,cropEnd:meme.duration });
    features.value = meme.features;
    emotion.value = { label:meme.emotion,confidence:meme.confidence,explanation:'编辑已保存作品',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':0} };
    cover.value = { ...meme.coverConfig };
    // 旧作品没有口径记录：沿用历史单侧（左声道）口径并明确标注，不冒充新的汇合结果
    legacyAnalysis.value = meme.analysisChannel === undefined;
    channelMode.value = meme.analysisChannel ?? 'left';
    analyzedMode.value = meme.analysisChannel ?? 'left';
    channelCount.value = meme.analysisChannel === 'right' ? 2 : 1;
    analyzeError.value = '';
    // 以实际解码结果校正声道数与可选项，失败不阻塞编辑
    void deps.cropper.inspect(meme.audio).then((info) => { channelCount.value = info.channelCount; }).catch(() => {});
    stage.value = 'cover';
  }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  async function shareMeme(meme: VoiceMeme) { const result = await deps.share.share(meme); notice.value = result === 'shared' ? '已打开系统分享' : '浏览器不支持文件分享，已下载音频和封面'; }
  function newRecording() { draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; emotion.value = undefined; features.value = undefined; channelMode.value = 'left'; channelCount.value = 1; analyzedMode.value = undefined; legacyAnalysis.value = false; analyzeError.value = ''; diagnostics.value = { perChannelRms: [], energyShare: [], switchCount: 0 }; stage.value = 'record'; error.value = ''; }
  return {
    stage, error, notice, level, draft, emotion, features, cover, collection,
    channelCount, channelMode, analyzedMode, availableModes, analyzing, analyzeError, diagnostics, resultStale, legacyAnalysis,
    analysisLabel: computed(() => (legacyAnalysis.value ? analysisChannelLabel(undefined) : analyzedMode.value ? CHANNEL_MODE_LABELS[analyzedMode.value] : '')),
    startRecording, stopRecording, importAudio, analyze, setChannelMode, selectEmotion, goCover, save,
    loadCollection, editMeme, deleteMeme, shareMeme, newRecording,
  };
}
