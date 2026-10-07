import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import App from '../App.vue';
import type { StudioDependencies } from '../useStudio';
import type { VoiceMeme } from '../../core/models';
import type { ChannelMode } from '../../core/models';

function deps(options: { denied?: boolean; channels?: number } = {}): StudioDependencies {
  const works: VoiceMeme[] = [];
  const channels = options.channels ?? 2;
  return {
    recorder:{isRecording:false,start:async()=>{if(options.denied)throw new DOMException('denied','NotAllowedError')},stop:async()=>new Blob(['voice'],{type:'audio/webm'})},
    analyzer:{analyze:async(_blob:Blob,mode:ChannelMode)=>({duration:2,features:{loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6},channelCount:channels,mode,perChannelRms:[.4,.1],energyShare:mode==='both'?[.9,.1]:[1],switchCount:1})},
    cropper:{inspect:async()=>({duration:2,needsCrop:false,channelCount:channels}),crop:async(blob,range)=>({blob,duration:range.end-range.start})},
    renderer:{render:async()=>new Blob(['cover'],{type:'image/png'})},
    repository:{list:async()=>works,save:async(m)=>{works.push(m)},rename:async()=>{},delete:async(id)=>{const i=works.findIndex(w=>w.id===id);if(i>=0)works.splice(i,1)}},
    share:{share:async()=> 'shared'},
  };
}

describe('Voice meme App', () => {
  it('shows the studio stages, time limit and sharing disclosure', () => {
    const wrapper = mount(App,{props:{dependencies:deps()}});
    expect(wrapper.text()).toContain('声音表情包工坊');
    expect(wrapper.text()).toContain('00:10 MAX');
    expect(wrapper.text()).toContain('分享链接不包含原始声音');
  });
  it('shows a recoverable microphone permission error', async () => {
    const wrapper=mount(App,{props:{dependencies:deps({denied:true})}}); await wrapper.get('[data-testid="record"]').trigger('click'); await Promise.resolve();
    expect(wrapper.text()).toContain('麦克风权限');
  });
  it('creates, labels, edits and saves a work to the gallery', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}}); await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve();
    await wrapper.get('[data-testid="analyze"]').trigger('click'); await Promise.resolve(); await wrapper.get('[data-emotion="温柔姐姐"]').trigger('click'); expect(wrapper.text()).toContain('已手动选择');
    await wrapper.get('[data-testid="to-cover"]').trigger('click'); await wrapper.get('[aria-label="气泡文字"]').setValue('轻轻说一句'); await wrapper.get('[data-testid="save-work"]').trigger('click'); await Promise.resolve(); await Promise.resolve();
    expect(wrapper.text()).toContain('作品集'); expect(wrapper.text()).toContain('我的声音表情');
  });
  it('offers left/right/dual calibers, flags old results stale after switching and restores on re-analysis', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}});
    await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve();
    expect(wrapper.get('[data-testid="analyze"]').text()).toBeTruthy();
    expect(['左声道','右声道','双声道汇合'].every((label)=>wrapper.text().includes(label))).toBe(true);
    await wrapper.get('#channel-mode-both').setValue();
    await wrapper.get('[data-testid="analyze"]').trigger('click'); await Promise.resolve();
    expect(wrapper.get('[data-testid="fusion-readout"]').text()).toContain('主导声道切换');
    await wrapper.get('#channel-mode-emotion-left').setValue();
    expect(wrapper.get('[data-testid="stale-banner"]').text()).toContain('旧口径结果');
    expect((wrapper.get('[data-testid="to-cover"]').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.get('[data-testid="reanalyze"]').trigger('click'); await Promise.resolve();
    expect(wrapper.find('[data-testid="stale-banner"]').exists()).toBe(false);
  });
  it('exposes only the left channel choice for mono audio', async () => {
    const wrapper=mount(App,{props:{dependencies:deps({channels:1})}});
    await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve();
    expect(wrapper.text()).toContain('单声道音频仅提供左声道分析');
    expect(wrapper.find('#channel-mode-both').exists()).toBe(false);
    expect(wrapper.find('#channel-mode-right').exists()).toBe(false);
  });
});
