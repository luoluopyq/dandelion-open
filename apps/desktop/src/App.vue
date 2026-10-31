<template>
  <n-config-provider :theme="naiveTheme" :theme-overrides="themeOverrides">
    <n-message-provider>
      <div class="shell" :class="{ detached: session.detached }">
        <TitleBar />
        <KnowledgeSourceDialog :locator="linkLocator" @close="linkLocator = null" />
        <div class="body">
          <template v-if="session.detached">
            <main class="main">
              <SetupForm v-if="session.setupOpen" />
              <template v-else>
                <ConfigBar />
                <ChatPane />
                <TerminalPane />
              </template>
            </main>
          </template>
          <template v-else>
            <Dock />
            <!-- 左栏整块收进 .sidebar-slot：宽度由 --sidebar-w 统一给（五种左栏面板
                 都吃这一个变量，拖一次全都跟着变），拖拽条贴着它的右边界放。
                 没有可渲染的左栏时整块 display:none，拖拽条跟着消失 —— 用 :has()
                 而不是再写一遍 dockPanel/mainView 的组合条件，免得两处判断漂移。 -->
            <div class="sidebar-slot" :style="{ '--sidebar-w': `${session.sidebarWidth}px` }">
              <ConversationSidebar v-if="session.dockPanel === 'tasks' && session.mainView === 'chat'" />
              <SkillPanel v-else-if="session.dockPanel === 'skills'" />
              <McpPanel v-else-if="session.dockPanel === 'mcp'" />
              <SandboxPanel v-else-if="session.dockPanel === 'sandbox'" />
              <PaneResizer
                class="sidebar-resizer"
                :model-value="session.sidebarWidth"
                :min="SIDEBAR_MIN_WIDTH"
                :max="sidebarMax"
                :reset="SIDEBAR_DEFAULT_WIDTH"
                label="调整左栏宽度"
                @update:model-value="session.setSidebarWidth($event, false)"
                @commit="session.setSidebarWidth($event)"
              />
            </div>
            <main class="main">
              <FeatureNavigation
                v-if="session.mainView === 'cron' || session.mainView === 'plugins' || session.mainView === 'memory' || session.mainView === 'knowledge' || session.mainView === 'corpus' || session.mainView === 'spaces'"
                @back="session.returnFromFeature()"
              />
              <template v-if="session.mainView === 'settings'">
                <SettingsEditor />
              </template>
              <GitReviewPane v-else-if="session.mainView === 'gitReview'" />
              <CronPanel v-else-if="session.mainView === 'cron'" />
              <PluginManagerPanel v-else-if="session.mainView === 'plugins'" />
              <MemoryManagerPanel v-else-if="session.mainView === 'memory'" />
              <KnowledgeHubPanel v-else-if="session.mainView === 'knowledge'" />
              <CorpusManagerPanel v-else-if="session.mainView === 'corpus'" />
              <WorkspaceManagerPanel v-else-if="session.mainView === 'spaces'" />
              <SetupForm v-else-if="session.setupOpen" />
              <template v-else>
                <SessionTabs />
                <ConfigBar />
                <ChatPane />
                <TerminalPane />
              </template>
            </main>
            <!-- 工作台与主区并排：◧ 只开合它，不再替换主区内容，
                 所以边看文件边问是成立的。 -->
            <TaskWorkbench />
          </template>
        </div>
        <StatusBar />
        <!-- 空间清理这类自动动作必须报一声：它会带走对话，不能悄悄做。
             提示条压在状态栏上方，任何页面都看得见。 -->
        <div v-if="session.notice" class="app-notice" role="status">
          <span>{{ session.notice }}</span>
          <button type="button" aria-label="关闭提示" @click="session.notice = null">×</button>
        </div>
        <n-modal
          :show="!!session.permission"
          preset="dialog"
          title="操作需要授权"
          :mask-closable="false"
          :close-on-esc="false"
        >
          <div class="permission-request-detail">
            <span>来自任务</span><strong>{{ permissionTaskTitle }}</strong>
            <span>请求内容</span><p>{{ session.permission?.title }}</p>
          </div>
          <div v-if="permissionArgumentText" class="permission-request-args">
            <strong>工具参数</strong><pre>{{ permissionArgumentText }}</pre>
            <p v-if="permissionArgumentsTruncated">参数过长，仅显示前 12,000 个字符。请确认请求内容后再决定是否允许。</p>
          </div>
          <p class="permission-request-note">未回答或等待超时时，本次操作会被拒绝。</p>
          <p v-if="session.permissionQueueLength > 1" class="muted">
            还有 {{ session.permissionQueueLength - 1 }} 个权限请求正在等待处理。
          </p>
          <template #action>
            <!-- 三档平级：仅这一次 / 本会话全部放行 / 拒绝。allow_turn 的后端
                 作用范围是根会话（含后续消息与子代理，gate-1 硬拒绝除外），
                 按钮文案与真实作用范围一致。 -->
            <button type="button" class="button-quiet button-danger" @click="session.answerPermission('deny')">拒绝</button>
            <button type="button" class="button-primary" @click="session.answerPermission('allow_turn')">本次会话不再询问</button>
            <button type="button" class="button-primary" @click="session.answerPermission('allow')">仅允许这一次</button>
          </template>
        </n-modal>
        <n-modal
          :show="!!session.deleteTarget"
          preset="dialog"
          title="删除任务"
          positive-text="删除"
          negative-text="取消"
          @positive-click="session.confirmDelete()"
          @negative-click="session.deleteTarget = null"
        >
          <p>关闭 Tab 不会删除任务。删除不可恢复，会停该路推理并删掉会话树，不会删全局 Skill / MCP。</p>
          <p v-if="session.deleteTarget">将删除：{{ session.deleteTarget.title || "未命名任务" }} ({{ session.deleteTarget.id }})</p>
          <!-- 后端 session_delete 是级联的，连子任务及其消息一起删。数量必须写出来，
               否则用户会以为只删了右键那一条。 -->
          <p v-if="deleteChildCount" class="danger">
            连带删除 {{ deleteChildCount }} 个子任务及其消息记录。
          </p>
        </n-modal>
        <n-modal
          :show="!!session.bulkDeleteTargets.length"
          preset="dialog"
          :title="`批量删除 ${session.bulkDeleteTargets.length} 个任务`"
          positive-text="全部删除"
          negative-text="取消"
          @positive-click="session.confirmBulkDelete()"
          @negative-click="session.bulkDeleteTargets = []"
        >
          <p>删除不可恢复，会停这些任务的推理并删掉各自的会话树，不会删全局 Skill / MCP。</p>
          <!-- 逐条列出来，长了就截断加计数：让用户看清到底选中了什么再确认。 -->
          <ul class="bulk-list">
            <li v-for="row in session.bulkDeleteTargets.slice(0, 8)" :key="row.id">
              {{ row.title || "未命名任务" }}
            </li>
            <li v-if="session.bulkDeleteTargets.length > 8" class="muted">
              …另外 {{ session.bulkDeleteTargets.length - 8 }} 个
            </li>
          </ul>
          <p v-if="bulkChildCount" class="danger">
            连带删除 {{ bulkChildCount }} 个子任务及其消息记录。
          </p>
        </n-modal>
        <n-modal
          :show="!!session.spaceDeleteTarget"
          preset="dialog"
          title="删除项目"
          positive-text="删除项目及其对话"
          negative-text="取消"
          @positive-click="session.confirmDeleteProject()"
          @negative-click="session.spaceDeleteTarget = null"
        >
          <p>删除项目会<b>连同归属到它的所有对话一起删除</b>，不可恢复。磁盘目录不会被删除。</p>
          <p v-if="session.spaceDeleteTarget">
            将删除：<b>{{ session.spaceDeleteTarget.name }}</b><br /><span class="project-delete-path">{{ displayWorkspace(session.spaceDeleteTarget.workspace) }}</span>
          </p>
          <p v-if="spaceDeleteCount" class="danger">
            连带删除该空间下最近记录的 {{ spaceDeleteCount }} 个对话及其消息。
          </p>
        </n-modal>
        <n-modal
          :show="!!session.projectEditTarget"
          preset="card"
          class="project-edit-modal"
          title="编辑项目"
          style="width: min(680px, calc(100vw - 40px))"
          @close="session.projectEditTarget = null"
        >
          <label class="project-name-field">
            <span aria-hidden="true">▱</span>
            <input v-model="projectEditName" aria-label="项目名称" @keydown.enter.prevent="saveProjectEdit" />
          </label>
          <p class="project-source-label">源文件夹</p>
          <div class="project-source-row" :title="session.projectEditTarget?.workspace">
            <span aria-hidden="true">▱</span>
            <span>{{ session.projectEditTarget?.workspace }}</span>
            <button type="button" title="在文件管理器中打开" aria-label="在文件管理器中打开" @click="session.projectEditTarget && session.revealProject(session.projectEditTarget.workspace)">↗</button>
          </div>
          <template #footer>
            <div class="project-edit-actions">
              <button type="button" class="project-remove" @click="requestDeleteFromEditor">移除项目及其对话</button>
              <span />
              <button type="button" class="project-cancel" @click="session.projectEditTarget = null">取消</button>
              <button type="button" class="project-save" :disabled="!projectEditName.trim()" @click="saveProjectEdit">保存</button>
            </div>
          </template>
        </n-modal>
        <n-modal
          :show="!!session.emptySpaceTarget"
          preset="dialog"
          title="清理空空间"
          positive-text="清理这些空间"
          negative-text="取消"
          @positive-click="session.confirmPruneEmptyProjects()"
          @negative-click="session.emptySpaceTarget = null"
        >
          <p>下面这些空间名下<b>一个对话都没有</b>，删掉的只是空间本身，磁盘目录不受影响。</p>
          <ul>
            <li v-for="item in (session.emptySpaceTarget ?? []).slice(0, 8)" :key="item.id">
              <b>{{ item.name }}</b>
              <span class="muted"> · {{ item.workspace }}</span>
            </li>
            <li v-if="(session.emptySpaceTarget?.length ?? 0) > 8">
              …另外 {{ (session.emptySpaceTarget?.length ?? 0) - 8 }} 个
            </li>
          </ul>
        </n-modal>
        <n-modal
          :show="session.contextOpen"
          preset="card"
          title="项目须知已注入"
          style="width: 480px"
          @close="session.contextOpen = false"
        >
          <p class="hint">只读。改须知请去工作区编辑文件，不会注入本仓开发用 AGENTS.md。</p>
          <p v-if="!session.contextStatus?.injected" class="muted">当前工作区没有发现可注入的项目须知。</p>
          <ul v-else>
            <li>类型：{{ session.contextStatus.kind }}</li>
            <li v-for="f in session.contextStatus.files" :key="f.rel">{{ f.rel }}</li>
          </ul>
          <template #footer>
            <button type="button" @click="session.contextOpen = false">关闭</button>
          </template>
        </n-modal>
        <n-modal
          :show="session.sidecarFail?.kind === 'start'"
          preset="dialog"
          title="sidecar 启动失败（11a）"
          positive-text="改用 Ollama"
          negative-text="查看日志"
          @positive-click="session.useOllamaInstead()"
          @negative-click="session.refreshSidecarLogs()"
        >
          <p>内置推理不可用。会话还在，不会踢当前任务。</p>
          <p class="err">{{ session.sidecarFail?.message }}</p>
          <pre v-if="session.sidecarLogs" class="json logs">{{ session.sidecarLogs }}</pre>
          <template #action>
            <button type="button" @click="session.dismissSidecarFail()">关闭</button>
          </template>
        </n-modal>
        <n-modal
          :show="session.sidecarFail?.kind === 'vram'"
          preset="dialog"
          title="显存不足（11b）"
          positive-text="改用推荐量化"
          negative-text="取消加载"
          @positive-click="session.applyRecommendQuant()"
          @negative-click="session.dismissSidecarFail()"
        >
          <p>不会为抢显存杀掉其他 Tab。禁止强行加载。</p>
          <p>{{ session.sidecarFail?.message }}</p>
        </n-modal>
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { darkTheme, lightTheme, NConfigProvider, NMessageProvider, NModal } from "naive-ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ChatPane from "./components/ChatPane.vue";
import ConversationSidebar from "./components/ConversationSidebar.vue";
import CronPanel from "./components/CronPanel.vue";
import ConfigBar from "./components/ConfigBar.vue";
import GitReviewPane from "./components/GitReviewPane.vue";
import Dock from "./components/Dock.vue";
import McpPanel from "./components/McpPanel.vue";
import PaneResizer from "./components/PaneResizer.vue";
import PluginManagerPanel from "./components/PluginManagerPanel.vue";
import SandboxPanel from "./components/SandboxPanel.vue";
import SessionTabs from "./components/SessionTabs.vue";
import SettingsEditor from "./components/SettingsEditor.vue";
import SetupForm from "./components/SetupForm.vue";
import SkillPanel from "./components/SkillPanel.vue";
import MemoryManagerPanel from "./components/MemoryManagerPanel.vue";
import KnowledgeHubPanel from "./components/KnowledgeHubPanel.vue";
import KnowledgeSourceDialog from "./components/KnowledgeSourceDialog.vue";
import type { SourceLocator } from "./lib/knowledge-citations";
import { handleAppLink } from "./lib/links";
import FeatureNavigation from "./components/FeatureNavigation.vue";
import CorpusManagerPanel from "./components/CorpusManagerPanel.vue";
import StatusBar from "./components/StatusBar.vue";
import TaskWorkbench from "./components/TaskWorkbench.vue";
import TerminalPane from "./components/TerminalPane.vue";
import TitleBar from "./components/TitleBar.vue";
import WorkspaceManagerPanel from "./components/WorkspaceManagerPanel.vue";
import { useSessionStore, sidebarWidthLimit, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH } from "./stores/session";
import * as ipc from "./lib/ipc";
import { theme } from "./lib/theme";

const session = useSessionStore();
const linkLocator = ref<SourceLocator | null>(null);
function onAppLink(event: MouseEvent) {
  handleAppLink(event, {
    knowledge: locator => { linkLocator.value = locator; },
    page: page => {
      const inChat = event.target instanceof Element && event.target.closest(".bubble.assistant");
      if (inChat && session.selectedFolder) linkLocator.value = { workspace: session.selectedFolder, page };
      else session.notice = "此文章链接缺少所属知识库，请从知识页面打开。";
    },
    external: ipc.openExternalUrl,
    notice: message => { session.notice = message; },
  });
}
const permissionTaskTitle = computed(() => {
  const id = session.permission?.sessionId;
  if (!id) return "当前任务";
  return session.records[id]?.title || session.rows.find((row) => row.id === id)?.title || `任务 ${id.slice(0, 8)}`;
});
const permissionArguments = computed(() => {
  const req = session.permission;
  if (!req?.toolCallId) return null;
  const input = session.permissionToolInputs[req.toolCallId];
  return input?.sessionId === req.sessionId ? input.args : null;
});
function redactPermissionArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPermissionArgs);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /token|secret|password|api[_-]?key|authorization|cookie|credential|^env$/i.test(key) ? "已隐藏" : redactPermissionArgs(item),
    ]));
  }
  return value;
}
const permissionArgumentsJson = computed(() => permissionArguments.value == null ? "" : JSON.stringify(redactPermissionArgs(permissionArguments.value), null, 2) ?? "");
const permissionArgumentsTruncated = computed(() => permissionArgumentsJson.value.length > 12_000);
const permissionArgumentText = computed(() => permissionArgumentsTruncated.value ? `${permissionArgumentsJson.value.slice(0, 12_000)}\n…` : permissionArgumentsJson.value);
const projectEditName = ref("");
watch(() => session.projectEditTarget, (project) => { projectEditName.value = project?.name ?? ""; });
async function saveProjectEdit() {
  const project = session.projectEditTarget;
  const name = projectEditName.value.trim();
  if (!project || !name) return;
  await session.renameProject(project.id, name);
  if (!session.error) session.projectEditTarget = null;
}
function requestDeleteFromEditor() {
  const project = session.projectEditTarget;
  session.projectEditTarget = null;
  if (project) session.requestDeleteProject(project);
}

// Naive UI 只用在 7 个 modal / 3 个 input / 2 个 button 上，但它自带一套色板，
// 必须跟着 <html>.dark 一起切，否则浅色下会冒出深色弹窗。
const naiveTheme = computed(() => (theme.value === "dark" ? darkTheme : lightTheme));

// 删除是级联的，先数出待删目标下挂了多少子任务，好在确认弹窗里写清楚。
// 直接数 rows 里 parentId 指向它的行，不依赖 tree（归档项不在 tree 里）。
const deleteChildCount = computed(() => {
  const target = session.deleteTarget;
  if (!target) return 0;
  return session.rows.filter((row) => row.parentId === target.id).length;
});

// 批量删除的连带子任务数。只数「父不在待删列表里」的子任务，否则同时选中父与子时
// 会把同一条既算进列表又算进连带数，数字虚高。
const bulkChildCount = computed(() => {
  const ids = new Set(session.bulkDeleteTargets.map((row) => row.id));
  if (!ids.size) return 0;
  return session.rows.filter((row) => row.parentId && ids.has(row.parentId) && !ids.has(row.id)).length;
});

// 删除空间是级联的（后端连同名下的会话树一起删），确认弹窗必须写出数量，
// 否则用户以为只是把目录从列表里移走。
// 只数已加载的那批：更早的对话不在 rows 里，报一个偏小的确定数字好过含糊其辞。
const spaceDeleteCount = computed(() => {
  const target = session.spaceDeleteTarget;
  if (!target) return 0;
  return session.rows.filter((row) => row.workspace === target.workspace).length;
});
function displayWorkspace(path: string) { return path.replace(/^\\\\\?\\/, ""); }
// Naive 的默认圆角/主色与 Dyad token 不一致，这里对齐过去。
// 注意：Naive 会对 primaryColor 做颜色运算（算 hover/pressed 派生色），
// 传 var(--accent) 会让它拿到空字符串。所以这里写与 token 同值的实色。
const themeOverrides = computed(() => {
  const accent = theme.value === "dark" ? "#b39df5" : "#7857d4";
  return {
    common: {
      borderRadius: "8px",
      fontFamily: '"Geist", "PingFang SC", "Microsoft YaHei", sans-serif',
      fontFamilyMono: '"Geist Mono", "Cascadia Code", ui-monospace, monospace',
      primaryColor: accent,
      primaryColorHover: theme.value === "dark" ? "#c3b1f8" : "#8a6ce0",
      primaryColorPressed: theme.value === "dark" ? "#a389f0" : "#6746c4",
      primaryColorSuppl: accent,
    },
  };
});

// 窗口变窄后要把拖出来的左栏宽度收回来：store 的 clamp 按当前窗口算上限，
// 这里负责在尺寸变化时再过一遍。persist=false —— 用户拖出来的意图留在
// localStorage 里，下次在宽窗口打开还是他自己那个值，不会被这次收缩改掉。
const viewportWidth = ref(window.innerWidth);
// 拖拽条的上限跟着窗口走：它和 store 里的写入口共用 sidebarWidthLimit，
// 否则窄窗口下组件以为自己拖到了 600，实际被 store 收到 220，
// aria-valuenow 就会报一个并不存在的宽度。
const sidebarMax = computed(() => sidebarWidthLimit(viewportWidth.value));

function onViewportResize() {
  viewportWidth.value = window.innerWidth;
  session.setSidebarWidth(session.sidebarWidth, false);
}

onMounted(() => {
  document.addEventListener("click", onAppLink);
  document.addEventListener("auxclick", onAppLink);
  // Work-order §二: first-paint mark. performance.now() base is webview
  // navigation start, so "app:first-paint" minus the backend "setup entered"
  // phase is the webview-side gap, kept separate from process/window numbers.
  ipc.bootMark("app:first-paint", `url=${location.hash || "main"}`);
  // Safety valve: flush what we have even if boot() hangs on some await —
  // the mark sequence then shows exactly which boot step stalled. One extra
  // batched IPC at t+5s, then boot's own flush still ships the rest.
  setTimeout(() => void ipc.flushBootMarks(), 5000);
  window.addEventListener("resize", onViewportResize);
  // Dandelion Open：无登录门禁，挂载即启动主界面。
  void session.boot().catch(err=>{session.error=err instanceof Error?err.message:String(err);});
});

// Work-order §二: knowledge-page visits (first and re-entry) get their own
// mark + IPC ledger — the digest flushed at the boundary attributes those
// requests to this visit only. Measurement only; changes no behavior.
watch(
  () => session.mainView,
  (v, old) => {
    if (v === "knowledge") {
      ipc.bootMark("ui:knowledge-open", ipc.ipcStatsDigest(10));
    } else if (old === "knowledge") {
      ipc.bootMark("ui:knowledge-close");
    }
    if (v === "knowledge" || old === "knowledge") {
      void ipc.flushBootMarks();
      ipc.resetIpcStats();
    }
  },
);

onBeforeUnmount(() => {
  document.removeEventListener("click", onAppLink);
  document.removeEventListener("auxclick", onAppLink);
  window.removeEventListener("resize", onViewportResize);
});
</script>
