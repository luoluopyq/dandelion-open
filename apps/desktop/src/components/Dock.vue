<template>
  <nav class="dock" aria-label="主导航">
    <template v-for="(item, i) in items" :key="i">
      <div v-if="item.id === 'rule'" class="dock-rule" />
      <div v-else-if="item.id === 'spacer'" class="dock-spacer" />
      <button
        v-else
        type="button"
        class="dock-btn"
        :class="{ on: item.active }"
        :aria-label="item.label"
        @click="item.run()"
        @mouseenter="showTip(i, $event)"
        @mouseleave="hideTip"
        @focus="showTip(i, $event)"
        @blur="hideTip"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path v-for="(d, k) in item.paths" :key="k" :d="d" /><circle v-if="item.circle" :cx="item.circle.cx" :cy="item.circle.cy" :r="item.circle.r" /><ellipse v-if="item.ellipse" :cx="item.ellipse.cx" :cy="item.ellipse.cy" :rx="item.ellipse.rx" :ry="item.ellipse.ry" /></svg>
        <span v-if="item.short" class="dock-label">{{ item.short }}</span>
      </button>
    </template>
  </nav>
  <!-- 自绘 tooltip。原先只靠原生 title：约 1 秒延迟，且在 Tauri 无边框窗口里
       经常根本不出现，等于这排图标没有任何说明。这里即时显示并带上快捷键。 -->
  <div v-if="tip" class="dock-tip" :style="{ top: tip.y + 'px' }">
    <strong>{{ tip.label }}</strong>
    <kbd v-if="tip.keys">{{ tip.keys }}</kbd>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useSessionStore } from "../stores/session";

const store = useSessionStore();

type Circle = { cx: number; cy: number; r: number };
type Ellipse = { cx: number; cy: number; rx: number; ry: number };
interface DockItem {
  id: string;
  label: string;
  short?: string;
  keys?: string;
  active?: boolean;
  paths: string[];
  circle?: Circle;
  ellipse?: Ellipse;
  run: () => void;
}

const items = computed<DockItem[]>(() => {
  return [
    // 对话入口只开合左侧的任务小页；中间的 Tab/对话区一直留作主展示区。
    { id: "chat", label: "对话", short: "对话", active: store.mainView === "chat" && store.dockPanel === "tasks", paths: ["M5 6.5h14M5 12h9M5 17.5h11"], run: () => store.toggleDock("tasks") },
    { id: "cron", label: "定时任务", short: "定时", active: store.mainView === "cron", paths: ["M12 8v4l3 2"], circle: { cx: 12, cy: 12, r: 7 }, run: () => store.openCron() },
    { id: "plugins", label: "插件", short: "插件", active: store.mainView === "plugins", paths: ["M10 4v4H6a2 2 0 0 0-2 2v2h4v4h2a2 2 0 1 1 4 0h2v-4h4v-2a2 2 0 0 0-2-2h-4V4z"], run: () => store.openPlugins() },
    { id: "memory", label: "项目记忆", short: "记忆", active: store.mainView === "memory", paths: ["M6 6v6c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6M6 12v6c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-6"], ellipse: { cx: 12, cy: 6, rx: 6, ry: 2.5 }, run: () => store.openMemory() },
    { id: "knowledge", label: "知识", short: "知识", active: store.mainView === "knowledge", paths: ["M5 5.5A2.5 2.5 0 0 1 7.5 3H19v16H7.5A2.5 2.5 0 0 0 5 21zM5 5.5V21M9 7h6M9 11h6"], run: () => store.openKnowledge() },
    { id: "rule", label: "", paths: [], run: () => {} },
    // 这里原本还有一项「工作空间」。它打开的是左栏的空间列表 —— 一个与「对话」
    // 平级的导航页。但工作空间不是一个"地方"，而是对话的一个维度：左栏顶部的
    // 切换器已经能切空间、新建空间、进空间管理，再多一个平级的入口只会让
    //「空间列表」和「对话列表」两套口径同时存在。所以它并进了对话栏。
    { id: "spacer", label: "", paths: [], run: () => {} },
    { id: "rule", label: "", paths: [], run: () => {} },
    { id: "updates", label: "关于与更新", short: "更新", active: store.mainView === "settings" && store.settingsSection === "updates", paths: ["M12 4v10", "m7 10 5 5 5-5", "M5 20h14"], run: () => void store.openSettings("updates") },
    { id: "models", label: "模型", short: "模型", paths: ["M12 3v2M12 19v2M21 12h-2M5 12H3M18.4 5.6 17 7M7 17l-1.4 1.4M18.4 18.4 17 17M7 7 5.6 5.6"], circle: { cx: 12, cy: 12, r: 3 }, run: () => void store.openSettings("models") },
  ] as DockItem[];
});

const tip = ref<{ label: string; keys?: string; y: number } | null>(null);

function showTip(index: number, ev: Event) {
  const item = items.value[index];
  if (!item || !item.label) return;
  const el = ev.currentTarget as HTMLElement | null;
  if (!el) return;
  const box = el.getBoundingClientRect();
  // 垂直居中对齐按钮；tooltip 自身高度约 30px。
  tip.value = { label: item.label, keys: item.keys, y: box.top + box.height / 2 - 15 };
}

function hideTip() {
  tip.value = null;
}
</script>
