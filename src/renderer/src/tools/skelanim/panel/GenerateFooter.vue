<script setup lang="ts">
// Control-panel footer, pinned under the scrolling sections: "N frames · ≈X generations" (red outside 3–15), the
// pending job / estimate status, and the Generate New Animation button (disabled while the doc is busy).
import { computed } from 'vue';
import { Sparkles } from '@lucide/vue';
import { MAX_FRAMES, MIN_FRAMES, generationCost } from '@shared/pixellab';
import Spinner from '../../../components/common/Spinner.vue';
import { useJobsStore } from '../../../stores/jobs';
import type { DocHandle } from '../../../stores/types';
import { estimatingDocs, generateAnimation, jobStatusText, submittingDocs } from './panelActions';

const props = defineProps<{ doc: DocHandle }>();

const jobs = useJobsStore();

const frameCount = computed(() => props.doc.state.value.frames.length);
const cost = computed(() => generationCost(frameCount.value));
const countText = computed(() => {
  const n = frameCount.value;
  const frames = `${n} frame${n === 1 ? '' : 's'}`;
  return cost.value === null ? `${frames} · needs ${MIN_FRAMES}–${MAX_FRAMES}` : `${frames} · ≈${cost.value} generations`;
});
const busy = computed(() => jobs.busy(props.doc.id));
const job = computed(() => jobs.activeJob(props.doc.id));
const submitting = computed(() => submittingDocs.has(props.doc.id));
const generating = computed(() => submitting.value || job.value !== null);
const statusText = computed(() => {
  if (job.value)
    return jobStatusText(job.value);
  if (submitting.value)
    return 'Submitting…';
  if (estimatingDocs.has(props.doc.id))
    return 'Estimating skeleton…';
  return busy.value ? 'Waiting for PixelLab…' : '';
});

function onGenerate(): void {
  void generateAnimation(props.doc);
}
</script>

<template>
  <footer class="generate-footer col gap-2">
    <div class="row gap-2 text-sm">
      <span
        class="tabular"
        :class="cost === null ? 'text-danger' : 'text-dim'"
      >{{ countText }}</span>
    </div>
    <div
      v-if="statusText"
      class="generate-status row gap-2 text-xs text-dim"
      aria-live="polite"
    >
      <Spinner :size="10" />
      <span
        v-tooltip="statusText"
        class="truncate"
      >{{ statusText }}</span>
    </div>
    <button
      type="button"
      class="btn btn-primary btn-lg w-full"
      :disabled="busy || submitting"
      :aria-busy="generating || undefined"
      @click="onGenerate"
    >
      <Spinner
        v-if="generating"
        :size="14"
      />
      <Sparkles
        v-else
        :size="15"
      />
      <span>{{ generating ? 'Generating…' : 'Generate New Animation' }}</span>
    </button>
  </footer>
</template>

<style scoped>
.generate-footer {
  flex: 0 0 auto;
  padding: var(--space-3);
  border-top: 1px solid var(--border);
  background: var(--bg-2);
}
</style>
