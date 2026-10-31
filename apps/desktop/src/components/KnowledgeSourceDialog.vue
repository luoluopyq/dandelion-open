<template>
  <n-modal :show="!!locator" preset="card" title="资料出处" style="width: 760px; max-width: calc(100vw - 32px)" :auto-focus="false" @close="emit('close')" @update:show="value => { if (!value) emit('close'); }">
    <p v-if="loading" role="status">正在读取引用的原文版本…</p>
    <p v-else-if="error" class="corpus-error" role="alert">{{ error }}</p>
    <template v-else-if="article">
      <div class="source-meta"><strong>{{ currentLocator && 'page' in currentLocator ? currentLocator.page : '知识文章' }}</strong><span>当前文章版本</span></div>
      <div class="source-article" v-html="articleHtml" @click="onArticleClick" @auxclick="onArticleClick"></div>
      <p class="source-note">此处展示知识文章的当前版本。核对具体事实时，请继续查看文章标明的原始资料出处。</p>
    </template>
    <template v-else-if="source">
      <div class="source-meta"><strong>{{ fileName(source.sourceId) }}</strong><span>版本 {{ source.versionNo }} · 片段 {{ source.ordinal + 1 }}</span></div>
      <p class="source-path">{{ source.sourceId }}</p>
      <pre class="source-content">{{ source.content }}</pre>
      <p class="source-note">这里展示的是该引用对应的原文片段。资料更新后仍可核对旧版本；来源撤回、删除或权限变更后将不可读取。</p>
    </template>
  </n-modal>
</template>
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NModal } from "naive-ui";
import { spaceChunkSource, spaceShow, wikiShow } from "../lib/ipc";
import { renderMarkdown } from "../lib/markdown";
import type { KnowledgeChunkHit } from "../lib/types";
import type { SourceLocator } from "../lib/knowledge-citations";
import { relativeWikiPage } from "../lib/links";
const props = defineProps<{ locator: SourceLocator | null }>();
const emit = defineEmits<{ close: [] }>();
const source = ref<KnowledgeChunkHit | null>(null), loading = ref(false), error = ref("");
const article = ref("");
const currentLocator = ref<SourceLocator | null>(null);
function onArticleClick(event: MouseEvent) {
  if (event.type === "auxclick" && event.button !== 1) return;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  const page = link && relativeWikiPage(link.getAttribute("href") ?? "");
  const locator = currentLocator.value;
  if (!page || !locator || !("page" in locator)) return;
  event.preventDefault();
  void load("workspace" in locator ? { workspace: locator.workspace, page } : { spaceId: locator.spaceId, page });
}
const articleHtml = computed(() => renderMarkdown(article.value));
let generation = 0;
const fileName = (path: string) => path.replace(/\\/g, "/").split("/").pop() || path;
async function load(locator: SourceLocator | null) {
  const current = ++generation;
  currentLocator.value = locator;
  source.value = null; article.value = ""; error.value = ""; loading.value = !!locator;
  if (!locator) return;
  try {
    if ('chunkId' in locator) {
      const result = await spaceChunkSource("local-user", locator.spaceId, locator.chunkId);
      if (current === generation) source.value = result;
    } else {
      const pages = "workspace" in locator
        ? await wikiShow(locator.page, locator.workspace)
        : await spaceShow("local-user", locator.spaceId, locator.page);
      if (current === generation) {
        article.value = pages[0]?.body || "";
        if (!article.value) error.value = "文章不存在或已被移除。";
      }
    }
  }
  catch (err) { if (current === generation) error.value = String(err); }
  finally { if (current === generation) loading.value = false; }
}
watch(() => props.locator, locator => { void load(locator); }, { immediate: true });
</script>
<style scoped>
.source-meta { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px; }
.source-meta span, .source-path, .source-note { color: var(--muted); font-size: var(--fs-xs); line-height: 1.7; }
.source-article { max-height: 55vh; overflow: auto; overflow-wrap: anywhere; font-size: var(--fs-sm); line-height: 1.85; }
.source-path { overflow-wrap: anywhere; }
.source-content { max-height: 55vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: var(--fs-sm); line-height: 1.85; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 18px; }
.source-note { margin-bottom: 0; }
</style>
