<template>
  <article class="bubble" :class="[msg.role, todoItems ? 'todo-card' : '', isTool ? 'tool-msg' : '']">
    <header v-if="!isTool" class="meta">
      <span>{{ label }}</span>
      <span v-if="msg.status" class="status">{{ msg.status }}</span>
      <span v-if="outputMetricsLabel" class="message-output-metrics" title="按收到的正文和推理文本估算；不含输入和隐藏推理，不代表模型计费用量">{{ outputMetricsLabel }}</span>
      <span v-if="msg.role === 'user'" class="message-actions">
        <button type="button" @click="copyUserPrompt">{{ copied ? "已复制" : "复制" }}</button>
        <button type="button" :disabled="store.running || store.queued || !store.canSend" @click="emit('retry', msg.text)">重试</button>
      </span>
    </header>
    <ul v-if="todoItems" class="todo-list">
      <li v-for="item in todoItems" :key="item.id" :class="item.status">
        <span class="mark">{{ mark(item.status) }}</span>
        <span class="todo-body">{{ item.content }}</span>
        <small class="muted">{{ item.id }}</small>
      </li>
    </ul>
    <template v-else-if="msg.role === 'assistant'">
      <details v-if="msg.reasoningText" class="reasoning-panel">
        <summary>{{ msg.streaming ? "模型推理中…" : "模型推理过程" }} · {{ msg.reasoningText.length }} 字符</summary>
        <pre class="plain reasoning-text">{{ msg.reasoningText }}</pre>
      </details>
      <div class="md" @click="onCopy" v-html="shownHtml" />
    </template>
    <div v-else-if="isTool" class="tool-card" :class="{ open }">
      <button type="button" class="tool-head" :title="open ? '点击收起' : '点击展开'" @click="open = !open">
        <span class="tool-chev">{{ open ? "▾" : "▸" }}</span>
        <span class="tool-name">{{ toolName }}</span>
        <span v-if="msg.status" class="tool-status" :class="statusKind">{{ msg.status }}</span>
        <span class="tool-size muted">{{ toolSize }}</span>
        <button
          v-if="msg.terminalId"
          type="button"
          class="tool-action"
          title="在终端打开"
          @click.stop="store.openLiveTerminal(msg.terminalId)"
        >终端</button>
      </button>
      <pre v-if="open" class="plain tool-body">{{ msg.text }}</pre>
    </div>
    <template v-else>
      <!-- 用户附带的图片：数据 URL 按 imagePaths 懒加载，点击放大。 -->
      <div v-if="userImages.length" class="bubble-images">
        <button v-for="(src, i) in userImages" :key="i" type="button" class="bubble-image" title="点击放大" @click="lightbox = src">
          <img :src="src" :alt="`用户图片 ${i + 1}`" loading="lazy" />
        </button>
      </div>
      <pre class="plain">{{ msg.text }}</pre>
    </template>
    <Teleport to="body">
      <div v-if="lightbox" class="image-lightbox" role="dialog" aria-label="图片预览" @click="lightbox = ''">
        <img :src="lightbox" alt="图片预览" @click.stop />
        <button type="button" class="image-lightbox-close" aria-label="关闭" @click="lightbox = ''">×</button>
      </div>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { renderMarkdown } from "../lib/markdown";
import { outputRate } from "../lib/output-rate";
import type { ChatMessage } from "../lib/types";
import * as ipc from "../lib/ipc";
import { useSessionStore } from "../stores/session";

interface TodoRow {
  id: string;
  content: string;
  status: string;
}

const props = defineProps<{ msg: ChatMessage }>();
const emit = defineEmits<{ retry: [text: string] }>();
const store = useSessionStore();
const copied = ref(false);
const lightbox = ref("");

// 用户消息图片：imagePaths 是应用数据目录里的持久化路径，渲染时按需换回
// data URL（一次性取好缓存在消息上，避免重渲染反复读盘）。
const userImages = ref<string[]>([]);
watch(
  () => [props.msg.imagePaths?.join("|") ?? "", props.msg.images?.length ?? -1] as const,
  () => { void syncImages(); },
  { immediate: true },
);
async function syncImages() {
  const paths = props.msg.imagePaths ?? [];
  if (props.msg.role !== "user" || !paths.length) { userImages.value = []; return; }
  if (props.msg.images) { userImages.value = props.msg.images; return; }
  const urls = await Promise.all(paths.map((path) => ipc.attachmentDataUrl(path).catch(() => "")));
  const ok = urls.filter(Boolean);
  props.msg.images = ok;
  userImages.value = ok;
}

async function copyUserPrompt() {
  try {
    await navigator.clipboard.writeText(props.msg.text);
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    store.error = "复制失败，请手动选中提示词复制。";
  }
}

const todoItems = computed(() => parseTodo(props.msg));
const isTool = computed(() => props.msg.role === "tool" && !todoItems.value);

const label = computed(() => {
  if (todoItems.value) return "待办";
  if (props.msg.role === "user") return "你";
  if (props.msg.role === "tool") return "工具";
  return ({ native: "蒲公英原生 Agent", claude_code: "Claude Code", opencode: "OpenCode", pi: "Pi" } as Record<string, string>)[props.msg.engineId || "native"] || "助手";
});

const outputMetricsLabel = computed(() => {
  if (props.msg.role !== "assistant" || !props.msg.outputMetrics) return "";
  const metrics = props.msg.outputMetrics;
  const tokens = Math.max(1, Math.round(metrics.estimatedTokens));
  const rate = outputRate(metrics.estimatedTokens, metrics.startedAt, metrics.lastChunkAt, metrics.samples);
  return rate === null ? `约 ${tokens} token` : `约 ${tokens} token · ${rate < 10 ? rate.toFixed(1) : Math.round(rate)} token/s`;
});

const html = computed(() => renderMarkdown(props.msg.text || ""));

// 兜底：空文本的助手消息显示一个可读占位，而不是光秃秃的「⌀」空框。
const shownHtml = computed(() => {
  if ((props.msg.text || "").trim()) return html.value;
  if (props.msg.streaming && props.msg.reasoningText) return "";
  const streaming = !!props.msg.streaming;
  const idle = streaming ? "" : " md-ph-idle";
  const placeholder = streaming
    ? (props.msg.reasoningText ? "模型正在推理…" : "正在生成…")
    : (props.msg.reasoningText ? "模型只返回了推理内容，续答后仍未生成正文。" : "（本条无文本输出）");
  return `<span class="md-ph${idle}">${placeholder}</span>`;
});

// 工具消息：默认折叠；用户/助手消息的最终结果始终展开
const open = ref(false);

const toolName = computed(() => {
  // text 第一行是 title（store 里 "title\npiece" 形式）
  const t = props.msg.text || "";
  const i = t.indexOf("\n");
  return (i >= 0 ? t.slice(0, i) : t).trim() || "tool";
});

const toolSize = computed(() => {
  const bytes = (props.msg.text || "").length;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
});

const statusKind = computed(() => {
  const s = (props.msg.status || "").toLowerCase();
  if (s.includes("done") || s === "completed" || s === "success" || s === "ok") return "ok";
  if (s.includes("error") || s.includes("fail")) return "err";
  if (s.includes("running") || s === "in_progress") return "run";
  return "idle";
});

function mark(status: string) {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[>]";
  if (status === "cancelled") return "[~]";
  return "[ ]";
}

function parseTodo(msg: ChatMessage): TodoRow[] | null {
  if (msg.role !== "tool") return null;
  const text = msg.text || "";
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start)) as { todos?: TodoRow[] };
    if (!Array.isArray(parsed.todos)) return null;
    return parsed.todos.filter((t) => t && typeof t.content === "string");
  } catch {
    return null;
  }
}

function onCopy(ev: MouseEvent) {
  const btn = (ev.target as HTMLElement).closest(".copy-btn") as HTMLButtonElement | null;
  if (!btn) return;
  const raw = btn.dataset.copy;
  if (!raw) return;
  void navigator.clipboard.writeText(decodeURIComponent(raw));
  btn.textContent = "已复制";
  window.setTimeout(() => {
    btn.textContent = "复制";
  }, 1200);
}
</script>
