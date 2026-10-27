<template>
  <div class="settings-provider-wrap">
    <section class="provider-profiles" aria-label="已保存的服务地址">
      <div class="provider-profiles-head">
        <div><strong>已保存的服务地址</strong><p>保存或设为默认都不会清除历史地址；不需要时可在这里手动删除。</p></div>
        <button type="button" class="button-quiet" @click="startNew">添加新地址</button>
      </div>
      <p v-if="!store.providerProfiles.length" class="muted">还没有保存过服务地址。在下方填写连接并保存。</p>
      <article v-for="p in store.providerProfiles" :key="p.id" class="provider-profile-item" :class="{ editing: editingId === p.id }">
        <div class="provider-profile-info">
          <strong>{{ p.name }}<span v-if="isActive(p)" class="provider-profile-badge">使用中</span></strong>
          <small>{{ backendLabel(p.backend) }} · {{ p.model }} · {{ p.baseUrl }}</small>
        </div>
        <div class="row-btns">
          <button v-if="!isActive(p)" type="button" :disabled="busy" @click="onApply(p)">设为默认</button>
          <button type="button" :disabled="busy" @click="startEdit(p)">{{ editingId === p.id ? "收起" : "编辑" }}</button>
          <button type="button" class="danger" :disabled="busy" @click="onRemove(p)">删除</button>
        </div>
      </article>
    </section>

    <form class="settings-provider-form" @submit.prevent="onSave(true)">
      <div class="settings-provider-fields">
        <div class="settings-provider-intro"><strong>{{ editingId ? "编辑已保存的服务" : "连接模型服务" }}</strong><p>通过服务地址连接模型。API、Ollama 和 vLLM 服务可以运行在本机，也可以运行在其他电脑或云端。</p></div>
        <label>
          <span>服务类型</span>
          <select v-model="backend">
            <option value="openai_compat">兼容 OpenAI 的 API</option>
            <option value="openai_responses">OpenAI Responses API</option>
            <option value="ollama">Ollama 服务</option>
            <option value="vllm">vLLM 服务</option>
          </select>
        </label>
        <label><span>服务地址</span><input v-model.trim="baseUrl" :placeholder="urlPlaceholder" /><small>填写接口根地址，无需附加 /chat/completions。</small></label>
        <label><span>模型名称</span><input v-model.trim="model" placeholder="服务提供的模型 ID" /></label>
        <label><span>显示名称<small>选填，用于在列表和对话窗口里辨认这条服务；留空用模型名称。</small></span><input v-model.trim="name" :placeholder="model || '例如：公司网关 · gpt-4o'" /></label>
        <div class="settings-provider-key">
          <label for="provider-api-key">API 密钥 <span class="settings-provider-key-optional">选填</span></label>
          <div class="settings-provider-key-control">
            <input v-if="revealedSavedKey !== null" id="provider-api-key" :value="revealedSavedKey" type="text" readonly autocomplete="off" spellcheck="false" aria-label="已保存的 API 密钥" />
            <input v-else id="provider-api-key" v-model="apiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" spellcheck="false" :placeholder="hasSavedKey ? '已保存；留空保持不变' : '不需要密钥可留空'" />
            <button type="button" class="button-quiet" :disabled="revealingKey" :aria-label="showApiKey ? '隐藏 API 密钥' : '显示 API 密钥'" @click="toggleApiKey">{{ revealingKey ? '读取中…' : showApiKey ? '隐藏' : '显示' }}</button>
          </div>
          <small>{{ keyHint }}</small>
          <button v-if="hasSavedKey && editingId" type="button" class="provider-profile-keyclear" :disabled="busy" @click="onClearKey">清除已存密钥</button>
        </div>
      </div>
      <div class="settings-provider-actions">
        <button type="button" class="button-quiet" :disabled="probing || !baseUrl.trim()" @click="onProbe">测试连接</button>
        <button type="button" class="button-quiet" :disabled="!canSave || busy" @click="onSave(false)">保存</button>
        <button type="submit" class="button-primary" :disabled="!canSave || busy">保存并设为新任务默认</button>
      </div>
      <p v-if="probeMsg" :class="probeOk ? 'ok' : 'err'">{{ probeMsg }}</p>
      <p v-if="probeModels.length" class="muted">可用模型：{{ probeModels.slice(0, 8).join(", ") }}</p>
      <button type="button" class="settings-provider-advanced-link" @click="store.openSettings('network')">连接问题排查与重试设置 ↗</button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { providerKeyForget, providerKeyPut, providerKeyReveal } from "../lib/ipc";
import { providerBackendLabel } from "../stores/session";
import type { ProviderProfile } from "../lib/types";
import { useSessionStore } from "../stores/session";

const store = useSessionStore();
const baseUrl = ref("");
const model = ref("");
const name = ref("");
const apiKey = ref("");
const showApiKey = ref(false);
const revealedSavedKey = ref<string | null>(null);
const revealingKey = ref(false);
const hasSavedKey = ref(false);
const editingId = ref<string | null>(null);
const backend = ref("openai_compat");
const probing = ref(false);
const busy = ref(false);
const probeMsg = ref("");
const probeOk = ref(false);
const probeModels = ref<string[]>([]);

onMounted(() => {
  // 老版本单服务地址 → profile 的一次性引导（boot 已尝试过，这里兜底）。
  void store.ensureProviderProfilesSeeded().catch(() => undefined);
});

function backendLabel(value: string) {
  return providerBackendLabel(value);
}
function isActive(p: ProviderProfile) {
  return store.activeProviderProfile?.id === p.id;
}

function blankForm() {
  return { backend: "openai_compat", baseUrl: "", model: "", name: "" };
}

function loadForm(p: ProviderProfile | null) {
  hideApiKey();
  apiKey.value = "";
  const base = p ?? blankForm();
  backend.value = base.backend;
  baseUrl.value = base.baseUrl;
  model.value = base.model;
  name.value = p && p.name !== p.model ? p.name : "";
  editingId.value = p?.id ?? null;
  hasSavedKey.value = false;
  probeMsg.value = "";
  probeModels.value = [];
  if (p) {
    // 是否已存密钥只查标志位需要 IPC；这里用 reveal 一次并立即丢弃明文以外的信息。
    void providerKeyReveal(p.id).then((key) => {
      if (editingId.value === p.id) hasSavedKey.value = !!key;
    }).catch(() => undefined);
  }
}

// 默认展示当前生效的服务（若有 profile 与之匹配），否则给一张空白新连接表单。
watch(
  () => [store.settings, store.providerProfiles.map((p) => p.id).join("|")] as const,
  () => {
    if (editingId.value !== null) {
      // 正在编辑的那条被外部改动（保存/删除）后跟随最新值，避免表单停留在旧数据。
      const current = store.providerProfiles.find((p) => p.id === editingId.value);
      if (!current) { loadForm(null); return; }
      const unchanged = current.baseUrl === baseUrl.value.trim() && current.model === model.value.trim() && current.backend === backend.value;
      if (!unchanged) loadForm(current);
      return;
    }
    loadForm(store.activeProviderProfile);
  },
  { immediate: true },
);

function hideApiKey() {
  revealedSavedKey.value = null;
  showApiKey.value = false;
}

async function toggleApiKey() {
  if (showApiKey.value) {
    hideApiKey();
    return;
  }
  if (apiKey.value || !hasSavedKey.value) {
    showApiKey.value = true;
    return;
  }
  if (!editingId.value) return;
  revealingKey.value = true;
  try {
    const savedKey = await providerKeyReveal(editingId.value);
    if (savedKey) {
      revealedSavedKey.value = savedKey;
      showApiKey.value = true;
      hasSavedKey.value = true;
    } else {
      hasSavedKey.value = false;
      probeOk.value = false;
      probeMsg.value = "未找到已保存的密钥，请重新输入并保存。";
    }
  } catch (err) {
    probeOk.value = false;
    probeMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    revealingKey.value = false;
  }
}

const keyHint = computed(() => {
  if (revealedSavedKey.value !== null) return "当前显示已保存的密钥；隐藏后可输入新密钥。";
  if (hasSavedKey.value) return "密钥已加密保存在本机，与此地址绑定；切换到这条服务时自动带上。";
  return "尚未保存密钥。调用模型服务时会发送给上方填写的服务地址；每条服务地址各自保存自己的密钥。";
});

const canSave = computed(() => !!model.value.trim() && !!baseUrl.value.trim());
const urlPlaceholder = computed(() => backend.value === "ollama" ? "http://127.0.0.1:11434/v1" : backend.value === "vllm" ? "http://127.0.0.1:8000/v1" : "https://api.example.com/v1");

function newProfileId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function currentProfile(): ProviderProfile {
  const modelId = model.value.trim();
  return {
    id: editingId.value ?? newProfileId(),
    name: name.value.trim() || modelId,
    backend: backend.value,
    baseUrl: baseUrl.value.trim(),
    model: modelId,
  };
}

/** 表单此刻生效的密钥：优先本次输入，其次该 profile 已保存的密钥。 */
async function effectiveKey(profileId: string): Promise<string | null> {
  const typed = apiKey.value.trim();
  if (typed) return typed;
  if (editingId.value) {
    try {
      return await providerKeyReveal(editingId.value);
    } catch {
      return null;
    }
  }
  return null;
}

async function onProbe() {
  probing.value = true;
  probeMsg.value = "";
  probeModels.value = [];
  try {
    const key = await effectiveKey(editingId.value ?? "");
    const r = await store.probeProvider(baseUrl.value, key ?? undefined);
    probeOk.value = r.ok;
    probeMsg.value = r.ok ? `HTTP ${r.status} ${r.message}` : `失败 HTTP ${r.status} ${r.message}`;
    probeModels.value = r.models;
  } catch (err) {
    probeOk.value = false;
    probeMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    probing.value = false;
  }
}

async function onSave(activate: boolean) {
  busy.value = true;
  probeMsg.value = "";
  try {
    const profile = currentProfile();
    const typed = apiKey.value.trim();
    if (typed) {
      try {
        await providerKeyPut(profile.id, typed);
        hasSavedKey.value = true;
      } catch (err) {
        probeOk.value = false;
        probeMsg.value = `密钥保存失败：${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    }
    if (!(await store.upsertProviderProfile(profile))) {
      probeOk.value = false;
      probeMsg.value = store.panelError || "服务地址保存失败。";
      return;
    }
    if (activate) {
      const key = typed || (await effectiveKey(profile.id)) || "";
      await store.patchSettings({
        "dandelion.defaultBackend": profile.backend,
        "dandelion.defaultModel": profile.model,
        "dandelion.baseUrl": profile.baseUrl,
        "dandelion.service.backend": profile.backend,
        "dandelion.service.model": profile.model,
        "dandelion.apiKey": key || null,
      });
      if (store.panelError) {
        probeOk.value = false;
        probeMsg.value = store.panelError;
        return;
      }
    }
    editingId.value = profile.id;
    hideApiKey();
    apiKey.value = "";
    probeOk.value = true;
    probeMsg.value = activate ? "已保存，并设为新任务默认模型。" : "已保存到服务地址列表；当前默认模型未更改。";
  } finally {
    busy.value = false;
  }
}

async function onApply(p: ProviderProfile) {
  busy.value = true;
  const ok = await store.applyProviderProfile(p.id);
  busy.value = false;
  probeOk.value = ok;
  probeMsg.value = ok ? `已切换到「${p.name}」，新任务将使用这条服务。` : store.panelError || "切换失败。";
}

async function onRemove(p: ProviderProfile) {
  busy.value = true;
  const ok = await store.removeProviderProfile(p.id);
  busy.value = false;
  probeOk.value = false;
  probeMsg.value = ok ? `已删除「${p.name}」。` : store.panelError || "删除失败。";
  if (ok && editingId.value === p.id) loadForm(null);
}

function startNew() {
  loadForm(null);
}

function startEdit(p: ProviderProfile) {
  if (editingId.value === p.id) {
    loadForm(store.activeProviderProfile);
    return;
  }
  loadForm(p);
}

async function onClearKey() {
  if (!editingId.value) return;
  busy.value = true;
  try {
    await providerKeyForget(editingId.value);
    hasSavedKey.value = false;
    hideApiKey();
    apiKey.value = "";
    probeOk.value = true;
    probeMsg.value = "该服务地址保存的密钥已清除。";
  } catch (err) {
    probeOk.value = false;
    probeMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.settings-provider-wrap { display: grid; gap: 18px; }
.provider-profiles { display: grid; gap: 10px; padding: 16px 18px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--panel); }
.provider-profiles-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.provider-profiles-head p { margin: 5px 0 0; color: var(--muted); font-size: var(--fs-xs); line-height: 1.5; }
.provider-profiles-head button { flex: 0 0 auto; }
.provider-profile-item { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); }
.provider-profile-item.editing { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--panel)); }
.provider-profile-info { min-width: 0; }
.provider-profile-info strong { display: block; font-size: var(--fs-sm); overflow-wrap: anywhere; }
.provider-profile-info small { display: block; margin-top: 3px; color: var(--muted); font-size: var(--fs-xs); overflow-wrap: anywhere; }
.provider-profile-badge { margin-left: 8px; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); font-size: var(--fs-xs); font-weight: 500; }
.provider-profile-item .row-btns { flex: 0 0 auto; }
.provider-profile-keyclear { margin-top: 6px; border: 0; background: none; padding: 0; color: var(--muted); font-size: var(--fs-xs); text-decoration: underline; cursor: pointer; }
@media (max-width: 700px) { .provider-profile-item { flex-direction: column; align-items: flex-start; } }
</style>
