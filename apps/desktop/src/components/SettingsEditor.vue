<template>
  <section class="settings-page">
    <header class="settings-bar">
      <button type="button" class="settings-back" @click="store.closeSettings()">← <span>返回</span></button>
      <span class="settings-bar-title">设置</span>
      <label class="settings-search"><span>⌕</span><input v-model="query" aria-label="搜索设置" placeholder="搜索设置和参数" /></label>
      <span v-if="store.jsonDirty" class="settings-state">有未保存的 JSON 修改</span>
    </header>
    <div class="settings-body">
      <nav class="toc" aria-label="设置目录">
        <p class="settings-nav-label">日常使用</p>
        <button
          v-for="g in primaryGroups"
          :key="g.id"
          type="button"
          :class="{ on: store.settingsSection === g.id || (g.id === 'models' && store.settingsSection === 'providers') }"
          @click="store.openSettings(g.id)"
        ><span>{{ iconFor(g.id) }}</span>{{ g.title }}</button>
        <button type="button" class="settings-advanced-toggle" :aria-expanded="showAdvanced" @click="toggleAdvanced">
          高级设置 <span>{{ showAdvanced ? '⌃' : '⌄' }}</span>
        </button>
        <template v-if="showAdvanced">
          <template v-for="section in advancedSections" :key="section.title">
            <p v-if="section.groups.length" class="settings-nav-subheading">{{ section.title }}</p>
            <button v-for="g in section.groups" :key="g.id" type="button" :class="{ on: store.settingsSection === g.id }" @click="store.openSettings(g.id)">
              <span>{{ iconFor(g.id) }}</span>{{ g.title }}
            </button>
          </template>
        </template>
        <p v-if="query && !primaryGroups.length && !advancedGroups.length" class="settings-nav-empty">没有匹配的设置</p>
      </nav>
      <div class="settings-main">
        <template v-if="group">
          <header class="settings-content-header">
            <span class="settings-kicker">设置 · {{ isPrimary(group.id) ? '日常使用' : '高级设置' }}</span>
            <h1>{{ group.title }}</h1>
            <p>{{ group.hint || '更改会自动保存，并用于后续任务。' }}</p>
          </header>
          <template v-if="group.id === 'common'">
            <div class="settings-overview-grid">
              <button type="button" class="settings-overview-card" @click="store.openSettings('updates')">
                <span class="settings-overview-symbol">↻</span><strong>关于与更新</strong><small>查看当前版本，检查 GitHub 上的新版本。</small><span class="settings-overview-action">打开更新页面 ↗</span>
              </button>
              <button type="button" class="settings-overview-card" @click="store.openSettings('models')">
                <span class="settings-overview-symbol">◇</span><strong>模型</strong><small>{{ modelSummary }}</small><span class="settings-overview-action">选择或配置模型 ↗</span>
              </button>
              <button type="button" class="settings-overview-card settings-overview-security" @click="store.openSettings('security')">
                <span class="settings-overview-symbol">⊙</span><strong>权限与安全</strong><small>{{ permissionSummary }}</small><span class="settings-overview-action">查看权限 ↗</span>
              </button>
            </div>
            <div class="settings-guidance"><strong>哪些需要设置？</strong><p>开始使用只需选好模型和连接方式。需要运行本机命令时，再检查权限。子代理和定时任务会使用默认运行参数；钩子默认关闭。</p></div>
          </template>
          <template v-else>
          <button v-if="group.jump" type="button" class="settings-link-action" @click="onJump(group)">{{ group.jump.label }} →</button>
          <UpdatesPanel v-if="group.id === 'updates'" />
          <SecurityPanel v-else-if="group.id === 'security'" />
          <template v-else-if="group.id === 'json'">
            <section class="settings-card"><textarea v-model="store.jsonDraft" class="json" rows="22" aria-label="settings.json 内容" @input="store.jsonDirty = true" />
            <p v-if="store.jsonError" class="err">{{ store.jsonError }}</p>
            <div class="settings-card-footer"><span>适合需要精确修改完整配置的用户</span><button type="button" class="settings-save-json" @click="store.saveSettingsJson()">保存 JSON</button></div></section>
          </template>
          <template v-else>
            <ModelManagerPanel v-if="group.id === 'providers' || group.id === 'models'" />
            <section v-if="visibleFields(group).length" class="settings-card">
              <label v-for="f in visibleFields(group)" :key="f.key" class="setting-row">
                <span class="setting-copy"><strong>{{ f.label }}</strong><small v-if="f.note">{{ f.note }}</small></span>
                <span class="setting-control">
                <input
                v-if="f.kind === 'string'"
                :value="strVal(f.key)"
                @change="onString(f.key, $event)"
              />
              <input
                v-else-if="f.kind === 'number'"
                type="number"
                :step="f.step ?? 1"
                :value="numVal(f.key)"
                @change="onNumber(f.key, $event)"
              />
              <select
                v-else-if="f.kind === 'select'"
                :value="strVal(f.key)"
                @change="onString(f.key, $event)"
              >
                <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
              <span v-else-if="f.kind === 'bool'" class="chk">
                <input
                  type="checkbox"
                  :checked="boolVal(f.key)"
                  @change="onBool(f.key, $event)"
                />
              </span>
              <textarea
                v-else-if="f.kind === 'lines'"
                rows="3"
                :value="linesVal(f.key)"
                @change="onLines(f.key, $event)"
              />
                </span>
              </label>
            </section>
            <button v-if="group.fields.some((f) => f.advanced) && !query" type="button" class="settings-details-toggle" :aria-expanded="showDetails" @click="showDetails = !showDetails">
              {{ showDetails ? '收起高级参数' : `显示高级参数（${group.fields.filter((f) => f.advanced).length}）` }} <span>{{ showDetails ? '⌃' : '⌄' }}</span>
            </button>
            <MemoryPanel v-if="group.id === 'memory'" />
            <SpecPanel v-if="group.id === 'spec'" />
            <ServePanel v-if="group.id === 'host'" />
            <p v-if="group.id !== 'models' && store.panelError && store.mainView === 'settings'" class="err">{{ store.panelError }}</p>
          </template>
          </template>
        </template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useSessionStore } from "../stores/session";
import { SETTINGS_GROUPS, type SettingsGroup } from "../lib/settings-catalog";
import ModelManagerPanel from "./ModelManagerPanel.vue";
import UpdatesPanel from "./UpdatesPanel.vue";
import SecurityPanel from "./SecurityPanel.vue";
import MemoryPanel from "./MemoryPanel.vue";
import SpecPanel from "./SpecPanel.vue";
import ServePanel from "./ServePanel.vue";

const store = useSessionStore();
const advancedOpen = ref(false);
const showDetails = ref(false);
const PRIMARY_GROUP_IDS = new Set(["common", "providers", "models", "security", "updates"]);
const isPrimary = (id: string) => PRIMARY_GROUP_IDS.has(id);
const query = computed({
  get: () => store.settingsQuery,
  set: (v: string) => {
    store.settingsQuery = v;
  },
});

const group = computed(() => SETTINGS_GROUPS.find((g) => g.id === store.settingsSection));
const vals = computed(() => store.settings?.values ?? {});
const matchingGroups = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return SETTINGS_GROUPS;
  return SETTINGS_GROUPS.filter((g) => [g.title, g.hint, ...g.fields.flatMap((f) => [f.label, f.key, f.note])]
    .some((text) => text?.toLowerCase().includes(q)));
});
const primaryOrder = ["common", "models", "security", "updates"];
const primaryGroups = computed(() => matchingGroups.value.filter((g) => isPrimary(g.id) && g.id !== "providers").sort((a, b) => primaryOrder.indexOf(a.id) - primaryOrder.indexOf(b.id)));
const advancedGroups = computed(() => matchingGroups.value.filter((g) => !isPrimary(g.id) && g.id !== "providers"));
const advancedSections = computed(() => [
  { title: "模型与运行", ids: ["generation", "network", "loop", "spec", "files", "web", "todo"] },
  { title: "功能扩展", ids: ["memory", "corpus", "skills", "mcp"] },
  { title: "系统", ids: ["storage", "host", "json"] },
].map((section) => ({ title: section.title, groups: section.ids.flatMap((id) => advancedGroups.value.filter((g) => g.id === id)) })));
const showAdvanced = computed(() => advancedOpen.value || !!query.value.trim() || !isPrimary(store.settingsSection));
watch(() => store.settingsSection, () => { showDetails.value = false; });
function toggleAdvanced() {
  if (showAdvanced.value) {
    advancedOpen.value = false;
    query.value = "";
    if (!isPrimary(store.settingsSection)) void store.openSettings("common");
  } else advancedOpen.value = true;
}
const modelSummary = computed(() => {
  const model = String(vals.value["dandelion.defaultModel"] ?? "").trim();
  const backend = String(vals.value["dandelion.defaultBackend"] ?? "openai_compat");
  if (backend === "sidecar") {
    const active = store.localModels.find((item) => item.active);
    if (model && model !== active?.id) return "模型设置不一致 · 请检查";
    return active ? `${active.name} · 本机模型` : "尚未选择本机模型";
  }
  return model ? `${model} · 模型服务` : "尚未配置模型";
});
const permissionSummary = computed(() => {
  const mode = String(vals.value["dandelion.permissionMode"] ?? "ask");
  const roots = store.sandbox ? ` · ${store.sandbox.extra.length + 1} 个可访问目录` : "";
  return `${mode === "auto" ? "自动批准敏感操作" : mode === "deny" ? "拒绝敏感操作" : "敏感操作先询问"} · 终端${vals.value["dandelion.allowShell"] === false ? "关闭" : "开启"}${roots}`;
});

function visibleFields(g: SettingsGroup) {
  const q = store.settingsQuery.trim().toLowerCase();
  return g.fields.filter((f) => q
    ? [f.key, f.label, f.note].some((text) => text?.toLowerCase().includes(q))
    : !f.advanced || showDetails.value);
}

function strVal(key: string) {
  const v = vals.value[key];
  return v == null ? "" : String(v);
}

function numVal(key: string) {
  const v = vals.value[key];
  return typeof v === "number" ? v : Number(v ?? 0);
}

function boolVal(key: string) {
  return vals.value[key] === true;
}

function linesVal(key: string) {
  const v = vals.value[key];
  return Array.isArray(v) ? v.map(String).join("\n") : "";
}

function onString(key: string, ev: Event) {
  const v = (ev.target as HTMLInputElement | HTMLSelectElement).value;
  void store.patchSettings({ [key]: v });
}

function onNumber(key: string, ev: Event) {
  const n = Number((ev.target as HTMLInputElement).value);
  if (!Number.isFinite(n)) return;
  void store.patchSettings({ [key]: n });
}

function onBool(key: string, ev: Event) {
  void store.patchSettings({ [key]: (ev.target as HTMLInputElement).checked });
}

function onLines(key: string, ev: Event) {
  const lines = (ev.target as HTMLTextAreaElement).value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  void store.patchSettings({ [key]: lines });
}

function onJump(g: SettingsGroup) {
  if (!g.jump) return;
  if (g.jump.dock === "skills" || g.jump.dock === "mcp") store.openPlugins();
  else if (g.jump.dock === "corpus") store.openCorpus();
  else if (g.jump.dock) store.openDock(g.jump.dock);
  if (g.jump.section) store.openSettings(g.jump.section);
}

function iconFor(id: string) {
  const icons: Record<string, string> = { common: "⌂", updates: "↻", models: "◇", providers: "◇", security: "⊙", generation: "✳", loop: "↻", files: "▤", skills: "✦", mcp: "⌬", corpus: "▣", json: "{}" };
  return icons[id] ?? "·";
}
</script>
