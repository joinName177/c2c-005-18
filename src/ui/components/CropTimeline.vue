<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import type { ChannelMode } from '../../core/models';
import { CHANNEL_MODE_LABELS } from '../../core/channel-fusion';
const props=defineProps<{duration:number;start:number;end:number;audio?:Blob;modes:ChannelMode[];mode:ChannelMode;analyzing:boolean;error?:string}>();
const emit=defineEmits<{updateStart:[n:number];updateEnd:[n:number];analyze:[];updateMode:[m:ChannelMode]}>();
const modeHints: Record<ChannelMode,string> = { left:'只分析左声道', right:'只分析右声道', both:'左右分声道提取，按帧能量汇合，反相不抵消、静音不稀释' };
let objectUrl = '';
let player: HTMLAudioElement | undefined;
watch(() => props.audio, (audio) => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = audio && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(audio) : '';
}, { immediate: true });
function preview() {
  if (!objectUrl) return;
  if (!player) player = new Audio();
  player.src = objectUrl;
  // 直接播放原始 Blob，不做下混，左右声道与原文件一致
  void player.play();
}
onBeforeUnmount(() => { if (objectUrl) URL.revokeObjectURL(objectUrl); });
</script>
<template><section class="stage-card"><span class="kicker">02 / TRIM THE MOMENT</span><h2>留下最有表情的十秒</h2><div class="timeline"><div class="timeline-fill" :style="{left:`${start/duration*100||0}%`,right:`${100-(end/duration*100||0)}%`}"></div></div><div class="range-pair"><label>起点 {{ start.toFixed(1) }}s<input type="range" min="0" :max="Math.max(0,duration-.1)" step=".1" :value="start" @input="emit('updateStart',Number(($event.target as HTMLInputElement).value))"></label><label>终点 {{ end.toFixed(1) }}s<input type="range" :min="Math.min(duration,start+.1)" :max="duration" step=".1" :value="end" @input="emit('updateEnd',Number(($event.target as HTMLInputElement).value))"></label></div>
<div class="channel-pick" role="group" aria-label="情绪分析声道口径"><span class="channel-pick-label">分析口径</span><div v-for="option in modes" :key="option"><input type="radio" name="channel-mode" :id="`channel-mode-${option}`" :value="option" :checked="mode===option" @change="emit('updateMode',option)"><label :for="`channel-mode-${option}`"><b>{{ CHANNEL_MODE_LABELS[option] }}</b><i>{{ modeHints[option] }}</i></label></div><p v-if="modes.length===1" class="channel-single-hint">单声道音频仅提供左声道分析。</p></div>
<div class="crop-actions"><button type="button" class="ghost-button" data-testid="preview-original" @click="preview">▶ 试听原声（保留原始左右声道）</button><button data-testid="analyze" class="acid-button" type="button" :disabled="analyzing" @click="emit('analyze')">{{ analyzing ? '分析中…' : '分析这段声音 →' }}</button></div>
<div v-if="error" class="inline-error" data-testid="analyze-error">{{ error }}</div>
<p class="analysis-note">口径只影响情绪分析；试听与保存的音频始终保持原始声道，不会被下混或相加。</p>
</section></template>
