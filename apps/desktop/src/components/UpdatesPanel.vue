<!-- Dandelion Open：关于与更新。开源版不分发更新签名私钥，因此不做
     in-app 自动更新；这里只做诚实的版本比对，并在系统浏览器打开
     GitHub Releases 下载页，由用户自行下载安装。 -->
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { checkUpdate, openDownload } from "../lib/ipc";
import type { UpdateInfo } from "../lib/types";

const info = ref<UpdateInfo | null>(null);
const checking = ref(false);
const error = ref("");

async function refresh(force = false) {
  checking.value = true;
  error.value = "";
  try {
    info.value = await checkUpdate(force);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    checking.value = false;
  }
}
async function download() {
  error.value = "";
  try {
    await openDownload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
onMounted(() => { void refresh(false); });
</script>

<template>
  <section class="updates-card">
    <header>
      <strong>关于与更新</strong>
      <p>Dandelion Open 是免登录的开源版本。新版本发布在 GitHub Releases 上，检查后按需下载。</p>
    </header>
    <dl>
      <dt>当前版本</dt>
      <dd>{{ info ? info.current : "…" }}</dd>
      <dt>最新版本</dt>
      <dd>
        <template v-if="info">
          {{ info.latest }}
          <span v-if="info.available" class="updates-badge">有新版本</span>
          <span v-else class="updates-ok">已是最新</span>
        </template>
        <template v-else>…</template>
      </dd>
      <dt v-if="info?.available && info.name">更新内容</dt>
      <dd v-if="info?.available && info.name">{{ info.name }}</dd>
    </dl>
    <p v-if="error" class="updates-error">{{ error }}</p>
    <div class="updates-actions">
      <button type="button" :disabled="checking" @click="refresh(true)">{{ checking ? "检查中…" : "检查更新" }}</button>
      <button type="button" @click="download">前往下载页 ↗</button>
    </div>
  </section>
</template>

<style scoped>
.updates-card { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-2); padding: 16px; display: grid; gap: 12px; }
.updates-card header strong { font-size: 14px; }
.updates-card header p { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.updates-card dl { display: grid; grid-template-columns: 88px 1fr; gap: 6px 12px; margin: 0; font-size: 13px; }
.updates-card dt { color: var(--muted); }
.updates-card dd { margin: 0; }
.updates-badge { margin-left: 8px; padding: 1px 8px; border-radius: 999px; background: var(--accent); color: var(--bg-1); font-size: 11px; }
.updates-ok { margin-left: 8px; color: var(--muted); font-size: 12px; }
.updates-error { margin: 0; font-size: 12px; color: #d33; }
.updates-actions { display: flex; gap: 8px; }
.updates-actions button { padding: 5px 14px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-1); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
.updates-actions button:hover:not(:disabled) { border-color: var(--accent); }
.updates-actions button:disabled { opacity: .6; cursor: default; }
</style>
