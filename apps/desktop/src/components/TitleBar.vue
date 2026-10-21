<template>
  <header class="titlebar" :class="{ 'mac-toolbar': usesNativeMacChrome }" @dblclick="onTitlebarDoubleClick">
    <!-- 品牌名已在侧栏顶部（品牌区），标题栏不再重复一次。 -->
    <span v-if="session.detached" class="brand" data-tauri-drag-region>蒲公英 · 独立窗口</span>
    <template v-if="!session.detached">
      <!-- 任务切换历史（同浏览器前进/后退，Ctrl+Shift+[ / ]）。用 v-if 而非 disabled：
           历史只存在内存里，刚启动时必然为空，常驻两个置灰按钮等于白占位置。
           能用才出现。 -->
      <button v-if="canGoBack" type="button" class="top-icon" :title="`上一任务（${shortcut('Ctrl+Shift+[')}）`" @click="moveHistory(-1)">←</button>
      <button v-if="canGoForward" type="button" class="top-icon" :title="`下一任务（${shortcut('Ctrl+Shift+]')}）`" @click="moveHistory(1)">→</button>
      <nav class="desktop-menus" aria-label="应用菜单">
        <div class="menu-root"><button type="button" :class="{ active: menuOpen === 'file' }" @click="toggleMenu('file')">文件</button><section v-if="menuOpen === 'file'" class="desktop-menu"><button type="button" @click="fileNew"><span>新对话</span><kbd>{{ shortcut('Ctrl+N') }}</kbd></button><button type="button" @click="chooseWorkspace"><span>打开文件夹</span><kbd>{{ shortcut('Ctrl+O') }}</kbd></button><hr /><button type="button" :disabled="!session.sessionId" @click="fileClose"><span>关闭任务</span><kbd>{{ shortcut('Ctrl+W') }}</kbd></button><hr /><button type="button" @click="close"><span>退出蒲公英</span><kbd>{{ isMacOS ? '⌘Q' : 'Alt+F4' }}</kbd></button></section></div>
        <div class="menu-root"><button type="button" :class="{ active: menuOpen === 'edit' }" @click="toggleMenu('edit')">编辑</button><section v-if="menuOpen === 'edit'" class="desktop-menu"><button type="button" @click="runEdit('undo')"><span>撤销</span><kbd>{{ shortcut('Ctrl+Z') }}</kbd></button><button type="button" @click="runEdit('redo')"><span>重做</span><kbd>{{ shortcut('Ctrl+Y') }}</kbd></button><hr /><button type="button" @click="runEdit('cut')"><span>剪切</span><kbd>{{ shortcut('Ctrl+X') }}</kbd></button><button type="button" @click="runEdit('copy')"><span>复制</span><kbd>{{ shortcut('Ctrl+C') }}</kbd></button><button type="button" @click="runEdit('paste')"><span>粘贴</span><kbd>{{ shortcut('Ctrl+V') }}</kbd></button><button type="button" @click="runEdit('delete')"><span>删除</span></button><hr /><button type="button" @click="runEdit('selectAll')"><span>全选</span><kbd>{{ shortcut('Ctrl+A') }}</kbd></button><hr /><button type="button" @click="openSettings"><span>设置</span><kbd>{{ shortcut('Ctrl+,') }}</kbd></button></section></div>
        <div class="menu-root"><button type="button" :class="{ active: menuOpen === 'view' }" @click="toggleMenu('view')">视图</button><section v-if="menuOpen === 'view'" class="desktop-menu wide"><button type="button" @click="viewAction('sidebar')"><span>切换侧边栏</span><kbd>{{ shortcut('Ctrl+B') }}</kbd></button><button type="button" @click="viewAction('project')"><span>打开文件夹作为项目…</span></button><button type="button" @click="viewAction('explorer')"><span>打开资源管理器</span><kbd>{{ shortcut('Ctrl+P') }}</kbd></button><button type="button" @click="viewAction('review')"><span>打开审查面板</span><kbd>{{ shortcut('Ctrl+Shift+G') }}</kbd></button><button type="button" @click="viewAction('terminal')"><span>打开终端</span><kbd>{{ shortcut('Ctrl+`') }}</kbd></button><button type="button" @click="viewAction('browser')"><span>打开浏览器</span><kbd>{{ shortcut('Ctrl+T') }}</kbd></button><hr /><button type="button" @click="openPalette"><span>查找任务</span><kbd>{{ shortcut('Ctrl+F') }}</kbd></button><button type="button" :disabled="!canGoBack" @click="moveHistory(-1)"><span>上一个聊天</span><kbd>{{ shortcut('Ctrl+Shift+[') }}</kbd></button><button type="button" :disabled="!canGoForward" @click="moveHistory(1)"><span>下一个聊天</span><kbd>{{ shortcut('Ctrl+Shift+]') }}</kbd></button><hr /><button type="button" @click="toggleFullscreen"><span>切换全屏</span><kbd>{{ isMacOS ? shortcut('Ctrl+Meta+F') : 'F11' }}</kbd></button></section></div>
        <div class="menu-root"><button type="button" :class="{ active: menuOpen === 'help' }" @click="toggleMenu('help')">帮助</button><section v-if="menuOpen === 'help'" class="desktop-menu"><button type="button" @click="helpPlaceholder('文档')"><span>文档</span></button><button type="button" @click="helpPlaceholder('键盘快捷键')"><span>显示键盘快捷键</span><kbd>{{ shortcut('Ctrl+/') }}</kbd></button><button type="button" @click="helpPlaceholder('新功能')"><span>新功能</span></button><hr /><button type="button" @click="helpPlaceholder('故障排除')"><span>故障排除</span></button><button type="button" @click="openSettings"><span>系统状态</span></button><button type="button" @click="helpPlaceholder('反馈')"><span>反馈</span></button><hr /><button type="button" @click="openUpdates"><span>检查更新…</span></button><button type="button" @click="helpPlaceholder('关于蒲公英')"><span>关于蒲公英</span></button><p v-if="helpNotice" class="menu-notice">{{ helpNotice }}</p></section></div>
      </nav>
      <!-- 这里原先有一个 250–410px 的「命令或搜索任务」长条。它调的 store.search
           与侧栏「搜索对话」是同一个函数、共用同一份 searchHits，功能重复且会互相
           干扰（在侧栏搜完再开面板，面板里会残留上次结果）。已移除，命令面板仍可
           由 Ctrl+Shift+P / Ctrl+F / 点品牌名 / 视图→查找任务 四处进入。 -->
      <!-- 只在真的选了文件夹后才出现。原先未选时也常驻一个「选择项目文件夹」按钮：
           它长得像标签却是个按钮，在标题栏里最扎眼，而空态入口本来就有三处
           （Ctrl+O / 文件→打开文件夹 / 命令面板）。选中后它退回状态显示的本分：
           弱对比、无边框、hover 才出背景。 -->
      <!-- 当前对话的工作目录，只读。以前它是个按钮，点开是「切换全局工作空间」—— 那个
           全局态已经不在了（侧栏按空间分组列出全部对话，没有可切的东西）。而且它当时显示
           的是「资源管理器打开的那个目录」，和工作目录是两回事，两个都叫 workspace，于是
           标题栏和工作台各自显示一个不同的路径。现在只留一个真相：当前这条对话的目录。 -->
      <span v-if="workspaceName" class="project-chip" :title="`当前对话的工作目录：${workspacePath}`"><span>▸</span>{{ workspaceName }}</span>
    </template>
    <span v-if="!session.detached" class="spacer" data-tauri-drag-region />
    <span v-else class="task" data-tauri-drag-region :title="session.sessionId">{{ session.sessionTitle }}</span>
    <span v-if="session.detached" class="spacer" data-tauri-drag-region />
    <!-- 搜索入口（设计稿右上角）。命令面板此前只有快捷键和菜单可进，这里补一个可见入口。 -->
    <button v-if="!session.detached" type="button" class="top-icon" :title="`搜索任务与命令（${shortcut('Ctrl+Shift+P')}）`" @click="openPalette">⌕</button>
    <button v-if="!session.detached" type="button" class="top-icon" :class="{ active: session.dockPanel === 'tasks' }" :title="`显示/隐藏任务栏（${shortcut('Ctrl+B')}）`" @click="session.toggleDock('tasks')">☰</button>
    <button v-if="!session.detached" type="button" class="workspace-toggle" :class="{ active: session.workbenchVisible }" :title="`打开/收起工作区（${shortcut('Ctrl+Shift+W')}）`" @click="session.toggleWorkbench()">◧</button>
    <button type="button" class="top-icon" :title="theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'" @click="toggleTheme()">{{ theme === 'dark' ? '☀' : '☾' }}</button>
    <button v-if="!usesNativeMacChrome" type="button" class="win" title="最小化" @click="minimize">─</button>
    <button v-if="!usesNativeMacChrome" type="button" class="win" title="最大化" @click="toggleMax">☐</button>
    <button v-if="!usesNativeMacChrome" type="button" class="win close" title="关闭" @click="close">✕</button>
  </header>
  <div v-if="paletteOpen" class="command-backdrop" @mousedown.self="closePalette">
    <section class="command-palette" role="dialog" aria-label="命令与任务搜索">
      <header><span>⌕</span><input ref="paletteInput" v-model="query" placeholder="搜索任务或输入命令…" @keydown.esc.prevent="closePalette" @keydown.enter.prevent="openFirstHit" /></header>
      <div class="command-results">
        <template v-if="!query.trim()"><p class="command-label">常用操作</p><button v-for="action in actions" :key="action.id" type="button" @click="runAction(action)"><span>{{ action.icon }}</span><b>{{ action.label }}</b><kbd v-if="action.shortcut">{{ action.shortcut }}</kbd></button></template>
        <template v-else><p class="command-label">任务</p><button v-for="hit in session.searchHits" :key="hit.id + hit.snippet" type="button" @click="openHit(hit.id)"><span>◌</span><b>{{ hit.title || '未命名任务' }}</b><small>{{ hit.snippet }}</small></button><p v-if="!session.searchHits.length" class="command-empty">没有匹配的任务</p></template>
      </div>
      <footer><span>Esc 关闭</span><span>从搜索结果打开任务</span></footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useSessionStore } from "../stores/session";
import { theme, toggleTheme } from "../lib/theme";
import { hasPrimaryModifier, isMacOS, shortcut } from "../lib/platform";

const session = useSessionStore();
const win = getCurrentWindow();
const usesNativeMacChrome = isMacOS && win.label === "main";
const paletteOpen = ref(false); const paletteInput = ref<HTMLInputElement | null>(null); const query = ref("");
const history = ref<string[]>([]); const historyIndex = ref(-1); let replayingHistory = false; let searchTimer: number | undefined;
const menuOpen = ref<"file" | "edit" | "view" | "help" | null>(null);
const helpNotice = ref("");
const canGoBack = computed(() => historyIndex.value > 0);
const canGoForward = computed(() => historyIndex.value < history.value.length - 1);

// 标题栏显示的是**当前这条对话**的工作目录。它曾经是「显式选过的目录，或者资源管理器
// 里打开的那个目录」的合取 —— 后者是右侧工作台的状态，把它顶到标题栏会得到两个都叫
// workspace 的不同路径。现在对话的目录只有一个来源（会话自己的 prefs.workspace）。
const workspacePath = computed(() => session.selectedFolder || "");
// 空字符串表示「未选文件夹」，chip 据此整个不渲染 —— 不再退化成一个
// 「选择项目文件夹」的常驻按钮。
const workspaceName = computed(() => {
  const path = workspacePath.value;
  if (!path) return "";
  return path.split(/[\\/]/).filter(Boolean).pop() || "项目文件夹";
});
// Ctrl+Shift+W 归还给右侧工作区：它一直写在 ◧ 和它的关闭按钮的 title 里，但键盘
// 处理把它给了「空间列表」，于是那个提示是假的 —— 按下去永远收不起工作区。
// 「空间管理」不占快捷键：它是低频的整页，从侧栏底部的链接或这里进就够了。
const actions = [{ id: "new", icon: "✎", label: "新对话", shortcut: shortcut("Ctrl+N") }, { id: "tasks", icon: "☰", label: "显示任务栏", shortcut: shortcut("Ctrl+B") }, { id: "project", icon: "▤", label: "打开文件夹作为项目", shortcut: "" }, { id: "workbench", icon: "◧", label: "打开右侧工作区", shortcut: shortcut("Ctrl+Shift+W") }, { id: "folder", icon: "▤", label: "选择项目文件夹", shortcut: shortcut("Ctrl+O") }, { id: "settings", icon: "⚙", label: "打开设置", shortcut: shortcut("Ctrl+,") }] as const;
watch(() => session.activeId, (id) => { if (!id || replayingHistory) return; const previous = history.value.slice(0, historyIndex.value + 1); if (previous[previous.length - 1] === id) return; history.value = [...previous, id]; historyIndex.value = history.value.length - 1; }, { immediate: true });
watch(query, (value) => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => { void session.search(value); }, 140); });
// searchHits 是和侧栏「搜索对话」共享的状态，只清本地 query 不够：侧栏搜过之后
// 再开面板，面板会直接显示上次的结果（query 是空的，却有命中项）。一起清掉。
function openPalette() { paletteOpen.value = true; query.value = ""; void session.search(""); void nextTick(() => paletteInput.value?.focus()); }
function closePalette() { paletteOpen.value = false; query.value = ""; void session.search(""); }
function toggleMenu(menu: "file" | "edit" | "view" | "help") { menuOpen.value = menuOpen.value === menu ? null : menu; helpNotice.value = ""; }
function closeMenus() { menuOpen.value = null; }
async function openHit(id: string) { await session.openSession(id); closePalette(); }
function openFirstHit() { const hit = session.searchHits[0]; if (hit) void openHit(hit.id); }
async function chooseWorkspace() { const folder = await session.selectFolder(); if (folder) session.openProjectFolder(folder); }
async function fileNew() { closeMenus(); await session.newTask(); }
async function fileClose() { const id = session.sessionId; closeMenus(); if (id) await session.closeTab(id); }
async function openSettings() { closeMenus(); await session.openSettings("common"); }
async function openUpdates() { closeMenus(); await session.openSettings("updates"); }
// 视图菜单这几项现在是「把工作区的某个工具叫出来」。它们只能让工作台切标签，
// 不能再改主区——否则点「打开文件」会把正在进行的对话顶掉。
function openWorkspaceTool(tool: "explorer" | "review" | "terminal" | "browser") { closeMenus(); window.dispatchEvent(new CustomEvent("dandelion:workspace-tool", { detail: tool })); }
function viewAction(action: "sidebar" | "project" | "terminal" | "explorer" | "review" | "browser") { if (action === "sidebar") { closeMenus(); session.toggleDock("tasks"); } else if (action === "project") { closeMenus(); void session.newProject(); } else openWorkspaceTool(action); }
async function toggleFullscreen() { closeMenus(); const fullscreen = await win.isFullscreen(); await win.setFullscreen(!fullscreen); }
function helpPlaceholder(name: string) { helpNotice.value = `${name}功能已预留，后续版本提供。`; }
async function runEdit(command: "undo" | "redo" | "cut" | "copy" | "paste" | "delete" | "selectAll") {
  closeMenus();
  const target = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
  if (command === "paste" && target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    try { const text = await navigator.clipboard.readText(); const start = target.selectionStart ?? target.value.length; const end = target.selectionEnd ?? start; target.setRangeText(text, start, end, "end"); target.dispatchEvent(new Event("input", { bubbles: true })); } catch { /* browser clipboard permission denied: keep native shortcut available */ }
    return;
  }
  document.execCommand(command === "selectAll" ? "selectAll" : command, false);
}
async function runAction(action: (typeof actions)[number]) { closePalette(); if (action.id === "new") await session.newTask(); else if (action.id === "tasks") session.toggleDock("tasks"); else if (action.id === "project") await session.newProject(); else if (action.id === "workbench") session.openWorkbench(); else if (action.id === "folder") await chooseWorkspace(); else await session.openSettings("common"); }
// 工作单 2026-10-19 第二版·条目 8：openSession 抛错（会话加载失败）时，裸的
// 「置位 → await → 复位」会把 replayingHistory 永远卡在 true —— activeId 的
// watch 从此不再记账，前进/后退历史整个冻结。finally 保证无论成败都复位，
// 失败后历史导航仍可用（openSession 自己负责报错与释放占用）。
async function moveHistory(delta: -1 | 1) { const targetIndex = historyIndex.value + delta; const id = history.value[targetIndex]; if (!id) return; replayingHistory = true; historyIndex.value = targetIndex; try { await session.openSession(id); } finally { replayingHistory = false; } }
function onKeydown(event: KeyboardEvent) { const primary = hasPrimaryModifier(event); if (event.key === "Escape") { closeMenus(); return; } if (event.metaKey && event.ctrlKey && event.key.toLowerCase() === "f") { event.preventDefault(); void toggleFullscreen(); return; } if (event.key === "F11") { event.preventDefault(); void toggleFullscreen(); return; } if (isMacOS && event.metaKey && event.key.toLowerCase() === "q") { event.preventDefault(); close(); return; } if (primary && event.shiftKey && event.key.toLowerCase() === "p") { event.preventDefault(); openPalette(); return; } if (primary && event.key.toLowerCase() === "f") { event.preventDefault(); openPalette(); return; } if (primary && event.key.toLowerCase() === "n") { event.preventDefault(); void session.newTask(); return; } if (primary && event.key.toLowerCase() === "b") { event.preventDefault(); session.toggleDock("tasks"); return; } if (primary && event.shiftKey && event.key.toLowerCase() === "w") { event.preventDefault(); session.toggleWorkbench(); return; } if (primary && event.key.toLowerCase() === "o") { event.preventDefault(); void chooseWorkspace(); return; } if (primary && event.key === ",") { event.preventDefault(); void session.openSettings("common"); } }
function minimize() { void win.minimize(); }
function toggleMax() { void win.toggleMaximize(); }
function onTitlebarDoubleClick(event: MouseEvent) { if (!usesNativeMacChrome && (event.target as HTMLElement | null)?.closest("[data-tauri-drag-region]")) toggleMax(); }
function close() { if (session.detached) void win.destroy(); else void win.close(); }
function onDocumentPointer(event: PointerEvent) { if (!(event.target as HTMLElement | null)?.closest(".menu-root")) closeMenus(); }
onMounted(() => { window.addEventListener("keydown", onKeydown); document.addEventListener("pointerdown", onDocumentPointer); });
onBeforeUnmount(() => { window.removeEventListener("keydown", onKeydown); document.removeEventListener("pointerdown", onDocumentPointer); window.clearTimeout(searchTimer); });
</script>

<style scoped>
</style>
