<template>
  <div class="local-models-panel">
    <section class="local-model-run">
      <div><span class="local-model-label">本机运行状态</span><strong>{{ store.sidecar?.kind === 'ready' ? '正在运行' : store.sidecar?.kind === 'starting' ? '正在启动' : '未启动' }}</strong><small>{{ activeName || '先导入并选择 GGUF 或 MLX 模型' }}{{ activeName ? ` · ${isDefaultLocal ? '新任务默认使用' : '尚未设为新任务默认'}` : '' }}</small></div>
      <div class="local-model-run-actions">
        <button v-if="store.sidecar?.kind === 'ready' && !isDefaultLocal && activeModel" type="button" class="button-primary" :disabled="busy" @click="makeDefault">设为新任务默认</button>
        <button v-if="store.sidecar?.kind === 'ready'" type="button" class="button-quiet" :disabled="busy" @click="store.stopSidecar()">停止</button>
        <button v-else type="button" class="button-primary" :disabled="busy || store.sidecar?.kind === 'starting' || !activeName" @click="onStart">{{ store.sidecar?.kind === 'starting' ? '正在启动…' : '启动并设为默认' }}</button>
      </div>
    </section>

    <section v-if="isMac && activeFormat === 'mlx' && !store.sidecar?.binary" class="local-model-library">
      <div class="local-model-heading"><div><h2>安装 MLX 运行器</h2><p>在蒲公英的数据目录中安装本机推理组件。不会下载模型权重。</p></div><button type="button" class="button-primary" :disabled="installBusy" @click="onInstall">{{ installBusy ? '正在安装…' : '安装运行器' }}</button></div>
    </section>

    <section class="local-model-library">
      <div class="local-model-heading"><div><h2>本机模型</h2><p>已导入 {{ store.localModels.length }} 个模型。选择后可在此电脑启动。</p></div><button type="button" class="button-quiet" :aria-expanded="showImport" @click="showImport = !showImport">{{ showImport ? '收起添加方式' : '添加模型' }}</button></div>
      <div v-if="showImport" class="local-model-import-choices"><button type="button" class="button-quiet" @click="store.importGguf()">选择 GGUF 文件</button><button v-if="isMac" type="button" class="button-quiet" @click="store.importMlx()">选择 MLX 文件夹</button><button v-if="isMac" type="button" class="button-quiet" :aria-expanded="showPathImport" @click="showPathImport = !showPathImport">{{ showPathImport ? '收起路径输入' : '粘贴文件夹路径' }}</button><button type="button" class="button-quiet" :aria-expanded="showDownload" @click="showDownload = !showDownload">{{ showDownload ? '收起魔搭下载' : '从魔搭下载 GGUF' }}</button></div>
      <small v-if="showImport && isMac">MLX 选择窗口会显示 .lmstudio、.cache 等隐藏目录。也可粘贴模型文件夹的完整路径；请选择包含 config.json 和模型权重的文件夹。</small>
      <form v-if="showImport && isMac && showPathImport" class="local-model-download" @submit.prevent="onImportPath">
        <label for="mlx-folder-path">MLX 模型文件夹的完整路径<input id="mlx-folder-path" v-model.trim="mlxFolderPath" type="text" placeholder="/Users/用户名/.lmstudio/models/模型文件夹" autocomplete="off" spellcheck="false" required /></label>
        <small>选择窗口找不到以 . 开头的隐藏目录时，可在这里粘贴模型文件夹路径。文件夹需包含 config.json 和模型权重。</small>
        <button type="submit" class="button-primary" :disabled="pathImportBusy || !mlxFolderPath">{{ pathImportBusy ? '正在导入…' : '导入此文件夹' }}</button>
      </form>
      <form v-if="showImport && showDownload" class="local-model-download" @submit.prevent="onDownload">
        <label>仓库 ID<input v-model.trim="repoId" placeholder="组织/模型-GGUF" required /></label>
        <label>GGUF 文件路径<input v-model.trim="filePath" placeholder="模型文件名-Q4_K_M.gguf" required /></label>
        <small>填写魔搭公开仓库中的文件路径；下载中断后可再次点击续传。</small>
        <button type="submit" class="button-primary" :disabled="downloadBusy || downloadStatus?.running || !repoId || !filePath">下载并导入</button>
      </form>
      <p v-if="downloadStatus?.running" class="local-model-progress">正在下载 {{ downloadStatus.filePath }}：{{ size(downloadStatus.downloadedBytes) }}<template v-if="downloadStatus.totalBytes"> / {{ size(downloadStatus.totalBytes) }}</template></p>
      <p v-if="store.panelError" class="err">{{ store.panelError }}</p>
      <div v-if="!store.localModels.length" class="local-model-empty">还没有本机模型。点击“添加模型”开始。</div>
      <article v-for="m in store.localModels" :key="m.id" class="local-model-item">
        <div><strong>{{ m.name }}</strong><small>{{ m.format.toUpperCase() }} · {{ m.quant }} · {{ size(m.bytes) }} · {{ m.sha256Ok ? (m.format === 'mlx' ? '文件已检查' : '已校验') : '校验失败' }}<template v-if="m.active"> · 本机已选</template></small></div>
        <div class="row-btns"><button v-if="!m.active || !isDefaultLocal" type="button" :disabled="busy" @click="m.active ? makeDefault() : onActivate(m.id)">{{ m.active ? '设为新任务默认' : store.sidecar?.kind === 'ready' ? '切换并重新启动' : '选用此模型' }}</button><button type="button" :disabled="busy" @click="store.verifyModel(m.id)">校验</button><button type="button" class="danger" :disabled="busy" @click="store.deleteModel(m.id)">删除</button></div>
      </article>
    </section>

    <details class="local-model-technical">
      <summary>运行详情与诊断</summary>
      <p>推理服务仅监听本机地址。停止对话不会结束服务；退出应用时按设置处理。</p>
      <small>服务：{{ store.sidecar?.bind || '未运行' }} · 程序：{{ store.sidecar?.binary || '未找到本地推理程序' }}</small>
      <small>并发 {{ store.sidecar?.queue.running ?? 0 }}/{{ store.sidecar?.queue.max ?? 2 }} · 排队 {{ store.sidecar?.queue.waiting ?? 0 }}</small>
      <small v-if="store.hardware">GPU {{ store.hardware.gpuName || '未探测' }} · 显存 {{ mb(store.hardware.vramMb) }} · 内存 {{ mb(store.hardware.ramMb) }} · 磁盘 {{ mb(store.hardware.diskFreeMb) }}</small>
      <small v-for="n in store.hardware?.notes ?? []" :key="n">{{ n }}</small>
      <div class="row-btns"><button type="button" @click="store.refreshHardware()">重新探测</button><button type="button" :disabled="busy" @click="store.restartSidecar()">重启服务</button><button type="button" @click="showLogs = !showLogs">{{ showLogs ? '收起日志' : '查看日志' }}</button></div>
      <pre v-if="showLogs" class="json logs">{{ store.sidecarLogs || '（空）' }}</pre>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useSessionStore } from "../stores/session";
import * as ipc from "../lib/ipc";
import type { ModelDownloadStatus } from "../lib/types";

const store = useSessionStore();
const isMac = navigator.userAgent.includes("Mac");
const showLogs = ref(false);
const busy = ref(false);
const showImport = ref(false);
const showDownload = ref(false);
const showPathImport = ref(false);
const pathImportBusy = ref(false);
const mlxFolderPath = ref("");
const downloadBusy = ref(false);
const installBusy = ref(false);
const downloadStatus = ref<ModelDownloadStatus | null>(null);
const repoId = ref("");
const filePath = ref("");
const activeModel = computed(() => store.localModels.find((m) => m.active));
const activeName = computed(() => activeModel.value?.name ?? "");
const activeFormat = computed(() => store.localModels.find((m) => m.active)?.format ?? "");
const isDefaultLocal = computed(() => !!activeModel.value && store.settings?.values["dandelion.defaultBackend"] === "sidecar" && store.settings?.values["dandelion.defaultModel"] === activeModel.value.id);
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  void store.refreshSidecar();
  void store.refreshHardware();
  void refreshDownload();
  timer = setInterval(() => {
    void store.refreshSidecar();
    void refreshDownload();
  }, 3000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});

function mb(n?: number | null) {
  if (n == null) return "—";
  return `${n} MiB`;
}

function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${bytes} B`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function onStart() {
  busy.value = true;
  try {
    await store.startSidecar();
  } finally {
    busy.value = false;
  }
}

async function makeDefault() {
  if (!activeModel.value) return;
  await store.patchSettings({ "dandelion.defaultBackend": "sidecar", "dandelion.defaultModel": activeModel.value.id });
}

async function onActivate(id: string) {
  busy.value = true;
  const wasRunning = store.sidecar?.kind === "ready";
  try {
    await store.activateModel(id);
    if (store.panelError) return;
    await store.patchSettings({ "dandelion.defaultBackend": "sidecar" });
    if (wasRunning && !store.panelError) await store.startSidecar();
  } finally { busy.value = false; }
}

async function onInstall() {
  installBusy.value = true;
  try { await store.installMlxRunner(); }
  finally { installBusy.value = false; }
}

async function refreshDownload() {
  try {
    downloadStatus.value = await ipc.modelDownloadStatus();
  } catch {
    downloadStatus.value = null;
  }
}

async function onDownload() {
  downloadBusy.value = true;
  try {
    const work = store.downloadModelscope(repoId.value, filePath.value);
    await refreshDownload();
    await work;
    await refreshDownload();
  } finally {
    downloadBusy.value = false;
  }
}

async function onImportPath() {
  pathImportBusy.value = true;
  try {
    const imported = await store.importMlxPath(mlxFolderPath.value);
    if (imported) {
      mlxFolderPath.value = "";
      showPathImport.value = false;
    }
  } finally {
    pathImportBusy.value = false;
  }
}
</script>
