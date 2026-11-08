<template>
  <div class="scene-illustration" :data-illustration="kind" aria-hidden="true">
    <div v-if="!loaded" class="scene-fallback"><component :is="scene.icon" /></div>
    <picture v-if="!failed" :key="kind">
      <source :media="`(min-width: ${minWidth}px)`" :srcset="`${scene.small} 400w, ${scene.large} 800w`" :sizes="sizes" type="image/webp" />
      <img :src="minWidth ? blank : scene.small" width="800" height="600" alt="" :loading="eager ? 'eager' : 'lazy'" decoding="async" draggable="false" :class="{ 'is-loaded': loaded }" @load="loaded = $event.target.naturalWidth > 1" @error="failed = true" />
    </picture>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { Archive, BellRing, Boxes, Clock3, Layers, Orbit, Radar } from 'lucide-vue-next';
import infrastructureSmall from '../../assets/scenes/infrastructure-400.webp?no-inline';
import infrastructureLarge from '../../assets/scenes/infrastructure-800.webp?no-inline';
import applicationsSmall from '../../assets/scenes/applications-400.webp?no-inline';
import applicationsLarge from '../../assets/scenes/applications-800.webp?no-inline';
import assistantSmall from '../../assets/scenes/assistant-400.webp?no-inline';
import assistantLarge from '../../assets/scenes/assistant-800.webp?no-inline';
import observabilitySmall from '../../assets/scenes/observability-400.webp?no-inline';
import observabilityLarge from '../../assets/scenes/observability-800.webp?no-inline';
import recoverySmall from '../../assets/scenes/recovery-400.webp?no-inline';
import recoveryLarge from '../../assets/scenes/recovery-800.webp?no-inline';
import eventsSmall from '../../assets/scenes/events-400.webp?no-inline';
import eventsLarge from '../../assets/scenes/events-800.webp?no-inline';
import scheduleSmall from '../../assets/scenes/schedule-400.webp?no-inline';
import scheduleLarge from '../../assets/scenes/schedule-800.webp?no-inline';

const scenes = {
  infrastructure: { small: infrastructureSmall, large: infrastructureLarge, icon: Boxes },
  applications: { small: applicationsSmall, large: applicationsLarge, icon: Layers },
  assistant: { small: assistantSmall, large: assistantLarge, icon: Orbit },
  observability: { small: observabilitySmall, large: observabilityLarge, icon: Radar },
  recovery: { small: recoverySmall, large: recoveryLarge, icon: Archive },
  events: { small: eventsSmall, large: eventsLarge, icon: BellRing },
  schedule: { small: scheduleSmall, large: scheduleLarge, icon: Clock3 },
};
const props = defineProps({
  kind: { type: String, required: true, validator: value => ['infrastructure', 'applications', 'assistant', 'observability', 'recovery', 'events', 'schedule'].includes(value) },
  minWidth: { type: Number, default: 0 },
  sizes: { type: String, default: '220px' },
  eager: Boolean,
});
const blank = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const scene = computed(() => scenes[props.kind] || scenes.infrastructure);
const loaded = ref(false);
const failed = ref(false);
watch(() => props.kind, () => { loaded.value = false; failed.value = false; });
</script>

<style scoped>
.scene-illustration { position: relative; width: 220px; max-width: 100%; aspect-ratio: 4 / 3; flex: none; pointer-events: none; isolation: isolate; }
.scene-illustration picture, .scene-illustration img { display: block; width: 100%; height: 100%; }
.scene-illustration picture { mask-image: radial-gradient(ellipse 63% 59% at 50% 50%, #000 48%, transparent 86%); }
.scene-illustration img { object-fit: contain; opacity: 0; transition: opacity 240ms ease; }
.scene-illustration img.is-loaded { opacity: 1; }
.scene-fallback { position: absolute; inset: 0; display: grid; place-items: center; color: var(--color-status-ok); background: radial-gradient(ellipse, rgba(110,231,183,.07), transparent 65%); }
.scene-fallback svg { width: 42px; height: 42px; stroke-width: 1.25; }
@media (prefers-reduced-motion: reduce) { .scene-illustration img { transition: none; } }
</style>
