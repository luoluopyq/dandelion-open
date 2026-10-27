import { acceptHMRUpdate, defineStore, getActivePinia } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  AgentPluginInfo,
  BackgroundProcess,
  BusFrame,
  ChatMessage,
  ContextStatus,
  CronJobRow,
  HardwareProbe,
  LiveTerminal,
  LocalModel,
  MemoryFiles,
  McpListItem,
  CorpusDoc,
  PermissionEvent,
  ProjectRow,
  ProviderProfile,
  RuntimeInfo,
  SandboxRoots,
  SessionBindings,
  SessionExport,
  SessionPrefs,
  SessionRow,
  SessionSearchHit,
  SettingsGet,
  SidecarFail,
  SidecarStatus,
  SkillListItem,
  TaskNode,
  WikiDraft,
  WikiDraftOutcome,
} from "../lib/types";
import * as ipc from "../lib/ipc";
import { buildTaskTree, type RunState } from "../lib/task-tree";
import { estimateOutputTokenUnits } from "../lib/output-rate";
import { createWikiGate, runWikiBuild } from "../lib/wiki-identity";

export const MAIN_SURFACE = "main";
export const WINDOW_09_SURFACE = "window-09";
const WIN09_PREFIX = "win09-";

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

// 已保存的模型服务连接（历史 API 地址）列表存放在 settings 的扩展键里：
// core 对未知键原样保留（settings.extra），所以不需要新的后端命令就能持久化。
// API 密钥不在这个列表里，按 profile id 各自存在 CredentialStore。
export const PROVIDER_PROFILES_KEY = "dandelion.provider.profiles";
export const SERVICE_BACKENDS = ["openai_compat", "openai_responses", "ollama", "vllm"];
export const SERVICE_BACKEND_LABELS: Record<string, string> = {
  openai_compat: "兼容 OpenAI 的 API",
  openai_responses: "OpenAI Responses API",
  ollama: "Ollama",
  vllm: "vLLM",
};

export function providerBackendLabel(backend: string): string {
  return SERVICE_BACKEND_LABELS[backend] ?? backend;
}

function parseProviderProfiles(values: Record<string, unknown>): ProviderProfile[] {
  const raw = values[PROVIDER_PROFILES_KEY];
  if (!Array.isArray(raw)) return [];
  const out: ProviderProfile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const id = String(p.id ?? "").trim();
    const baseUrl = String(p.baseUrl ?? "").trim();
    const model = String(p.model ?? "").trim();
    if (!id || !baseUrl || !model) continue;
    const backend = String(p.backend ?? "openai_compat");
    out.push({
      id,
      name: String(p.name ?? "").trim() || model,
      backend: SERVICE_BACKENDS.includes(backend) ? backend : "openai_compat",
      baseUrl,
      model,
    });
  }
  return out;
}

// 左栏不再有「空间列表」这一格：工作空间不是一个与对话平级的导航页，而是对话
// 列表自己的**分组**（见 spaceGroups）。所以这里没有 "spaces"。
export type DockId = "tasks" | "git" | "plugins" | "skills" | "corpus" | "mcp" | "sandbox";

export interface TabRecord {
  id: string;
  title: string;
  kind: string;
  parentId: string | null;
  workspace: string;
  messages: ChatMessage[];
  /** Number of persisted messages not currently mounted in the transcript. */
  historyRemaining: number;
  loadingHistory: boolean;
  running: boolean;
  stopping: boolean;
  stopReason: string | null;
  prefs: SessionPrefs;
  skillIds: string[];
  mcpIds: string[];
  corpusIds: string[];
  knowledgeIds: string[];
}

interface FailedAttempt {
  prompt: string;
  error: string;
  engineId: string;
  mode: "ask" | "plan" | "auto";
  imageUrls: string[];
}

interface ToolGenerationProgress {
  name: string;
  argumentBytes: number;
}

export interface GitReviewTarget {
  root: string;
  view: "diff" | "commit" | "history";
  path?: string;
  staged?: boolean;
}

export interface ProjectExplorerTarget {
  id: string;
  name: string;
  workspace: string;
}

/**
 * 空间列表里的一行。
 *
 * 空间＝用户在 `projects` 里登记过的目录。列表只列这些，不列「会话里出现过
 * 的目录」—— 后者会让浏览过的每个文件夹都变成一个空间，列表就不再是用户
 * 自己建的东西。没登记过的目录下那批会话统一落进「未归属」那一组。
 */
export interface SpaceGroup {
  /** 已登记空间的 id；未归属组没有对应记录，用 null 表示。 */
  id: string | null;
  name: string;
  workspace: string;
  /** 空间自身的建立时间。组序只按它排，见 `spaceGroups` 里那段注释。 */
  createdAt: string;
  /** 可导航的会话（不含归档，已按父子关系建树）。 */
  sessions: TaskNode[];
  /** 这个空间名下全部会话数（含归档、含子任务）。计数用它，归档不该让数字变小。 */
  total: number;
  /** 未归属：没有登记成空间的目录下的对话，含完全没有工作目录的。 */
  unassigned: boolean;
}

// 右侧工作台承载的工具。资源管理器排第一：它是用户从「项目文件夹」时期
// 就一直在用的那个入口，其余三个是工作台自带的本地工具。
export type WorkbenchTool = "explorer" | "review" | "terminal" | "browser";
const WORKBENCH_TOOL_KEY = "dandelion.workbench.tool";
const WORKBENCH_WIDTH_KEY = "dandelion.workbench.width";

// 工具选择跨会话记住：日常几乎只用其中一两个，每次开面板都从空列表重选
// 等于每次白白多一次点击。入口页仍然可达（面板头部的「全部工具」）。
function readStoredWorkbenchTool(): WorkbenchTool | null {
  try {
    const saved = window.localStorage.getItem(WORKBENCH_TOOL_KEY);
    return saved === "explorer" || saved === "review" || saved === "terminal" || saved === "browser" ? saved : null;
  } catch {
    // localStorage 不可用（隐私模式等）时退化成仅当前会话记忆，不影响功能。
    return null;
  }
}

// 面板宽度同样跨会话记住。下限 320 保住文件树的可读性，上限 680 与
// .codex-workspace 的既有约束一致，避免把对话区挤没。
export const WORKBENCH_MIN_WIDTH = 320;
export const WORKBENCH_MAX_WIDTH = 680;
export const WORKBENCH_DEFAULT_WIDTH = 380;

function clampWorkbenchWidth(width: number): number {
  return Math.round(Math.min(WORKBENCH_MAX_WIDTH, Math.max(WORKBENCH_MIN_WIDTH, width)));
}

function readStoredWorkbenchWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(WORKBENCH_WIDTH_KEY));
    return Number.isFinite(saved) ? clampWorkbenchWidth(saved) : WORKBENCH_DEFAULT_WIDTH;
  } catch {
    return WORKBENCH_DEFAULT_WIDTH;
  }
}

// 左栏宽度（对话列表 / 空间列表 / 各种面板共用一条分栏）。同样跨会话记住：
// 会去拖它通常是因为路径或对话名太长，下次启动又缩回 272px 等于每次白拖一遍。
const SIDEBAR_WIDTH_KEY = "dandelion.sidebar.width";
// 220 与 .sidebar 既有的 min-width 对齐（再窄标题只剩省略号）；600 是绝对上限。
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 600;
export const SIDEBAR_DEFAULT_WIDTH = 280;

// 上限还得看窗口：给 dock + 主区 + 可能打开的工作台留下这么多像素之后再压左栏，
// 否则在窄窗口里能拖出一个把对话区挤成一条缝的左栏。
const SIDEBAR_RESERVED = 620;

// 有效上限。store 的写入口和界面上的拖拽条共用这一个算法 —— 两边各算一份的话，
// 窄窗口下组件会以为自己拖到了 600，而实际被 store 收到 220。
export function sidebarWidthLimit(viewport: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, viewport - SIDEBAR_RESERVED));
}

function clampSidebarWidth(width: number): number {
  const viewport = typeof window === "undefined" ? SIDEBAR_MAX_WIDTH : window.innerWidth;
  return Math.round(Math.min(sidebarWidthLimit(viewport), Math.max(SIDEBAR_MIN_WIDTH, width)));
}

function readStoredSidebarWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

/** 取路径最后一段作为显示名，和 `project_create` 的命名规则保持一致。 */
export function workspaceLabel(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() || workspace || "未命名空间";
}

// "project" 已从主视图里移除：资源管理器搬进了右侧工作台（workbenchTool），
// 它不再是「替换主区」的整页视图。主视图只管真正的整页特性。
type MainView =
  | "chat"
  | "settings"
  | "cron"
  | "gitReview"
  | "plugins"
  | "corpus"
  | "memory"
  | "knowledge"
  | "spaces";
type FeatureView = "cron" | "plugins" | "memory" | "knowledge" | "corpus" | "spaces";
type FeatureReturn = { dock: DockId | null };

function emptyBindings(): SessionBindings {
  return { skill: [], mcp: [], corpus: [], knowledge: [] };
}

function messagesFromExport(exp: SessionExport): ChatMessage[] {
  const next: ChatMessage[] = [];
  let i = 0;
  for (const row of exp.messages) {
    i += 1;
    const id = row.id === undefined ? `hist_${i}` : `hist_${row.id}`;
    if (row.role === "user") {
      next.push({
        id,
        role: "user",
        text: row.content,
        ...(row.attachments && row.attachments.length ? { imagePaths: row.attachments } : {}),
      });
    } else if (row.role === "assistant") {
      // A tool-call turn can persist an assistant row with no visible text.
      // Its following tool messages already represent the action in the UI.
      if (!row.content.trim() && row.toolCalls) continue;
      next.push({ id, role: "assistant", text: row.content, engineId: row.engineId || undefined });
    } else if (row.role === "tool") {
      next.push({
        id,
        role: "tool",
        text: row.content,
        toolCallId: row.toolCallId ?? undefined,
      });
    }
  }
  return next;
}

export const useSessionStore = defineStore("session", () => {
  const info = shallowRef<RuntimeInfo | null>(null);
  const settings = shallowRef<SettingsGet | null>(null);
  const error = ref<string | null>(null);
  const failedAttempts = ref<Record<string, FailedAttempt>>({});
  const toolGeneration = ref<Record<string, ToolGenerationProgress>>({});
  // The local echo bridges IPC/preflight latency. ACP's user event replaces its
  // identity in place so it stays ahead of status/output without a second bubble.
  const pendingPrompts = new Map<string, { id: string; text: string }>();
  const permissionQueue = ref<PermissionEvent[]>([]);
  const permission = computed(() => permissionQueue.value[0] ?? null);
  const permissionQueueLength = computed(() => permissionQueue.value.length);
  const permissionToolInputs = shallowRef<Record<string, { sessionId: string; args: unknown }>>({});
  const finishedPermissionCalls = new Set<string>();
  const records = ref<Record<string, TabRecord>>({});
  const openIds = ref<string[]>([]);
  const activeId = ref("");
  // 正在打开、还没到首帧的目标会话。UI 从点击那一刻就能给出「正在打开这个
  // 对话」的加载态，而不是等 occupy/消息两轮 IPC 回来才有反应。
  const pendingOpenId = ref("");
  // 会话切换的顺序号：tryOpenSession 每被调一次自增一次，async 步骤之间用
  // `seq === openSeq` 判断"我还是不是最后一次点击"。快速连点 A→B 时，晚回来的
  // A 会就此让位，不会覆盖 B。
  let openSeq = 0;
  const rows = ref<SessionRow[]>([]);
  const projects = ref<ProjectRow[]>([]);
  const runState = ref<Record<string, RunState>>({});
  const searchQuery = ref("");
  const searchHits = ref<SessionSearchHit[]>([]);
  const configOpen = ref(false);
  const deleteTarget = ref<SessionRow | null>(null);
  // 多选批量删除。selectMode 开着时侧栏行前出现复选框，点击行不再打开会话。
  const selectMode = ref(false);
  const selectedIds = ref<string[]>([]);
  // 批量删除的确认弹窗与单条共用一套流程，但要携带整份 id 列表。
  const bulkDeleteTargets = ref<SessionRow[]>([]);
  const skills = ref<SkillListItem[]>([]);
  const agentPlugins = ref<AgentPluginInfo[]>([]);
  const mcpServers = ref<McpListItem[]>([]);
  // Registry results are a browse buffer, kept apart from the installed
  // catalogs so a search can never be mistaken for something installed.
  const registryResults = ref<import("../lib/types").McpRegistryEntry[]>([]);
  const registryCursor = ref<string | null>(null);
  const registryBusy = ref(false);
  const registryQuery = ref("");
  const installNotes = ref<string[]>([]);
  const corpusDocs = ref<CorpusDoc[]>([]);
  const knowledgeSpaces = ref<{ id: string; name: string; externalPolicy: string }[]>([]);
  const wikiStatus = shallowRef<import("../lib/types").WikiStatus | null>(null);
  // 无项目会话里 Agent 提交 Wiki 知识产生的引导草稿。以后端磁盘为准：
  // bus 事件只负责实时追加，打开会话时 wikiDrafts() 全量恢复，重启不丢。
  const wikiDrafts = ref<Record<string, WikiDraft[]>>({});
  // Wiki 编译进度（bus `_wiki_update`）：驱动 WikiPanel 的
  // 「已保存，页面更新中」与「编译失败可重试」反馈，不把未完成说成完成。
  // `workspace` 标记正在编译的项目，多项目打开时面板只认领自己那条。
  // 快速扫描走 started/finished/error；深度构建走 build_started/build_plan/
  // build_article/build_finished/build_error（message 带阶段详情）。
  const wikiCompile = ref<{ phase: string; message?: string | null; workspace?: string } | null>(null);
  // 最近一次深度构建的结果报告（发布清单/被保护跳过的文章），成功横幅用。
  const wikiBuildReport = ref<import("../lib/types").WikiBuildReport | null>(null);
  // 扫描覆盖的真实故事（只读；从未扫描 = null）。根目录选错时它给建议，
  // 面板只提示并让用户自己选，绝不静默切换项目。
  const wikiCoverage = ref<import("../lib/types").WikiCoverage | null>(null);
  // The conversation list is the default navigation surface in chat mode.
  // Project Explorer replaces it with the resource tree instead of stacking
  // two sidebars.
  const dockPanel = ref<DockId | null>("tasks");
  const mainView = ref<MainView>("chat");
  // Feature workspaces are temporary. Keep the user's actual work surface so
  // opening a plugin, memory, or knowledge page cannot strand navigation.
  // 迁移到工作台后主视图只剩 chat 一种来源，于是这里只需记住用哪块侧栏回去。
  const featureReturn = ref<FeatureReturn>({ dock: "tasks" });
  // Settings is an overlay workspace: it must return to the surface that
  // opened it, instead of always dumping the user into an unrelated chat.
  const settingsReturnView = ref<Exclude<MainView, "settings">>("chat");
  const gitReview = ref<GitReviewTarget | null>(null);
  const projectExplorer = ref<ProjectExplorerTarget | null>(null);
  // 删除空间会连它名下的对话一起删，必须让用户先看清影响范围再确认。
  const spaceDeleteTarget = ref<ProjectRow | null>(null);
  // 项目详情卡的“编辑项目”入口使用独立的目标，不能复用删除确认目标；编辑是可逆
  // 的元数据操作，而删除会级联会话，二者的确认语义必须分开。
  const projectEditTarget = ref<ProjectRow | null>(null);
  // 「清理空空间」的待确认名单。由后端空跑一次给出（前端的 rows 只有最近一页，
  // 用它判断「这个空间有没有对话」会把超出窗口的对话当成不存在），非空即弹确认。
  const emptySpaceTarget = ref<ProjectRow[] | null>(null);
  // 自动动作（目前只有孤儿空间清理）留下来的提示。这类事发生了就必须说一声，
  // 不能默默把用户的对话清掉。
  const notice = ref<string | null>(null);
  // 右侧工作台与主区并行存在，不再替换主区：点 ◧ 时对话留在原地，
  // 所以它的开合状态与当前工具必须各自独立于 mainView / dockPanel。
  const workbenchVisible = ref(false);
  const workbenchTool = ref<WorkbenchTool | null>(readStoredWorkbenchTool());
  const workbenchWidth = ref(readStoredWorkbenchWidth());
  // 左栏宽度。App.vue 把它写成 .body 上的 --sidebar-w，五种左栏面板都吃这个
  // 变量，所以拖动一次对所有左栏视图同时生效，不用逐个面板传 prop。
  const sidebarWidth = ref(readStoredSidebarWidth());
  const surface = ref(MAIN_SURFACE);
  const detachedIds = ref<string[]>([]);
  const detached = computed(() => surface.value === WINDOW_09_SURFACE);
  const settingsTabOpen = ref(false);
  const settingsSection = ref("common");
  const settingsQuery = ref("");
  const treeFocusSeq = ref(0);
  const jsonDraft = ref("");
  const jsonDirty = ref(false);
  const jsonError = ref<string | null>(null);
  const contextOpen = ref(false);
  const contextStatus = shallowRef<ContextStatus | null>(null);
  const sandbox = shallowRef<SandboxRoots | null>(null);
  const panelError = ref<string | null>(null);
  const cronJobs = ref<CronJobRow[]>([]);
  const memoryFiles = shallowRef<MemoryFiles | null>(null);
  const terminals = ref<Record<string, LiveTerminal>>({});
  const liveOpenId = ref<string | null>(null);
  const workspaceOpen = ref(false);
  const hardware = shallowRef<HardwareProbe | null>(null);
  const localModels = ref<LocalModel[]>([]);
  const sidecar = shallowRef<SidecarStatus | null>(null);
  const sidecarLogs = ref("");
  const sidecarFail = ref<SidecarFail | null>(null);
  const setupOpen = computed(() => info.value != null && !info.value.loopReady &&
    !agentPlugins.value.some((plugin) => plugin.id !== "native" && plugin.ready));

  const listLimit = computed(() => {
    const n = Number(settings.value?.values["dandelion.session.listLimit"]);
    if (!Number.isFinite(n) || n < 1) return 50;
    return Math.min(200, Math.max(1, Math.floor(n)));
  });

  const active = computed(() => (activeId.value ? records.value[activeId.value] : undefined));
  const failedAttempt = computed(() => activeId.value ? failedAttempts.value[activeId.value] ?? null : null);
  const activeToolGeneration = computed(() => activeId.value ? toolGeneration.value[activeId.value] ?? null : null);

  /*
   * 「当前工作目录」不是一份独立状态，而是**当前打开的那条会话的属性**。
   *
   * 会话自己带 workspace（后端 sessions 表的 workspace 列，每条会话一个），所以
   * 目录永远跟着会话走：同时开着上海和北京两个目录的对话是常态，不存在「整个
   * 软件只有一个工作目录」。这也正是 codex 的做法——它的 SessionMeta 里带 cwd，
   * `get_active_project(resolved_cwd, repo_root)` 是拿 cwd 当入参**推导**出来的
   * 纯函数，而不是存下来的一份全局态。
   *
   * 以前这里是一个写进 localStorage 的 ref，左栏按它过滤。代价是：打开任何一条
   * 属于别的空间的会话都会把它改掉（左栏整列在光标底下换掉）、新对话的目录跟着
   * 它走（于是没法把某个空间当默认工作目录）、搜索也被它收窄。更糟的是它和每条
   * 会话自己的 workspace 是**两份真相**，只能靠 normalize / 孤儿清理 / 清理空空间
   * 反复对齐。派生之后只剩一份真相，漂移不了。
   *
   * 归一化仍要过一道：目录没登记成空间时，当前目录记作 null（＝未归属），与侧栏
   * 分组里的落点保持同一套取值。
   */
  const activeWorkspace = computed(() =>
    normalizeWorkspace(active.value?.prefs.workspace || active.value?.workspace || ""),
  );
  /** 当前会话的工作目录（未归一化，原样路径）。输入框那个工作区 chip 显示的是它。 */
  const selectedFolder = computed<string | null>(
    () => active.value?.prefs.workspace || active.value?.workspace || null,
  );
  const sessionId = computed(() => active.value?.id ?? "");
  const sessionTitle = computed(() => active.value?.title ?? "未命名任务");
  const messages = computed(() => active.value?.messages ?? []);
  const running = computed(() => active.value?.running ?? false);
  const queued = computed(() => !!(activeId.value && runState.value[activeId.value]?.queued));
  const stopping = computed(() => active.value?.stopping ?? false);
  const stopReason = computed(() => active.value?.stopReason ?? null);
  // 只读只针对子代理会话：它有父会话，回复应该发给父（docs/g4-g5-desktop-plan.md:138
  // 「单击孩子：只读状态，发给父用 21」，那条规格说的就是任务树里的子代理孩子）。
  //
  // cron 会话不在此列。规格只要求它「要能点开」（同文件 :140），从没说不可写；
  // 它到期时走的就是同一个 Runtime::prompt、同一个 agent_loop（g3-harness.md:256），
  // 且 parent_id 为空——原先按 kind !== "user" 一并判成只读，是实现扩大了范围，
  // 结果历史定时任务对话没法继续聊，提示还叫用户「发给父」而它根本没有父。
  const readOnly = computed(() => !!active.value && active.value.kind === "subagent");
  const activeEngineReady = computed(() => {
    const id = active.value?.prefs.agentEngine || "native";
    return id === "native" ? !!info.value?.loopReady : agentPlugins.value.some((plugin) => plugin.id === id && plugin.ready);
  });
  const canSend = computed(
    () =>
      activeEngineReady.value &&
      !!active.value &&
      !readOnly.value &&
      !active.value.running &&
      !active.value.stopping,
  );

  // 左栏列**全部**会话，分组交给 spaceGroups（按会话自己归属的空间分）。这里不再
  // 有任何「当前空间」的过滤：一条会话的工作目录是它的属性，不是列表的范围。
  //
  // 「未归属」那个桶仍然存在，但它现在是分组里的一格，而不是一个被选中的过滤
  // 状态：它收容「有工作目录但那个目录没登记成空间」的会话（服务给新会话的默认
  // 目录、composer 里临时选的目录都是这种）以及完全没有工作目录的会话。
  const tree = computed(() => buildTaskTree(rows.value.filter((row) => !row.archived), runState.value));
  // 后端给的是最近 listLimit 条。取满了才说明「可能还有更早的没读进来」，值得提示
  // 一句；取不满就是全部，不必提示。
  //
  // （以前是「树里的根节点数 > listLimit」：那会把归档项和挂在根上的子代理会话一起
  // 数进去，于是明明已经把 50 条全读完了，侧栏还在下面写着「仅显示最近 50 个」。）
  const hasMore = computed(() => rows.value.length >= listLimit.value);

  // 归档的对话被 tree 过滤掉了，需要一条独立的数据源才能列出来，否则归档就是
  // 单向操作：写进了数据库，但界面上再也找不到、也无法取消归档。
  // 归档项按归档动作发生的时间（updatedAt）倒序，最近归档的排在最前。
  const archivedRoots = computed(() =>
    buildTaskTree(rows.value.filter((row) => row.archived), runState.value)
      .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)),
  );

  /** 空间组内排序：置顶的浮到最前，其余按最近活动倒序（与侧栏原来的日期分组同一口径）。 */
  function rankInSpace(rows: SessionRow[]): TaskNode[] {
    return buildTaskTree(rows, runState.value).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
    });
  }

  /**
   * 侧栏的分组数据源：全部会话按自己的空间分格，一格一个空间。
   *
   * 这里**不是**一个可以选中的「当前空间」，而是侧栏列全部会话时的分组依据。
   * 一条会话的工作目录是它自己的属性（后端 sessions 表的 workspace 列），所以
   * 上海和北京两个目录的对话可以同时在列表里 —— 没有「整个软件只有一个工作
   * 目录」这回事。
   *
   * 分格只有 `projects` 里登记过的目录加上一个「未归属」。之前是「projects ∪
   * 会话里出现过的目录」，结果是每开一次「打开文件夹」或每给对话选一次目录，
   * 列表里就多出一行 —— 空间看起来像系统默认塞给你的，而不是自己建的。
   *
   * 指针指向一个没登记过的目录（或为空）的会话统一进「未归属」：列表要列全，
   * 那批对话就得有个落点，否则它们等于没有入口。
   */
  const spaceGroups = computed<SpaceGroup[]>(() => {
    const groups: SpaceGroup[] = projects.value.map((project) => ({
      id: project.id,
      name: project.name,
      workspace: project.workspace,
      createdAt: project.createdAt,
      sessions: [],
      total: 0,
      unassigned: false,
    }));
    const byWorkspace = new Map(groups.map((group) => [group.workspace, group]));
    const buckets = new Map<string, SessionRow[]>();
    const orphans: SessionRow[] = [];
    for (const row of rows.value) {
      const group = row.workspace ? byWorkspace.get(row.workspace) : undefined;
      if (!group) {
        orphans.push(row);
        continue;
      }
      group.total += 1;
      if (row.archived) continue;
      if (!buckets.has(group.workspace)) buckets.set(group.workspace, []);
      buckets.get(group.workspace)!.push(row);
    }
    for (const group of groups) {
      group.sessions = rankInSpace(buckets.get(group.workspace) ?? []);
    }
    // 组序**固定**：按空间自己的建立时间，新空间追加在末尾。
    //
    // 原来按「组内第一条会话的 updatedAt」倒序，看起来像「最近用过的空间浮上来」，
    // 实际上那不是用户在排序，而是写副作用在排序：`set_session_prefs` 每写一次都把
    // 那条会话的 updated_at（以及它所在项目的 updated_at）顶到 now，而侧栏里点一次
    // 分组头的「＋」、清一次工作区、换个模型都会写 prefs。于是在第二个目录里新建
    // 一条对话，整份列表换了个位置，用户读到的是「我明明在上面那格点的新建，它却
    // 跑下去了」。排序要能被预期，就不能拿会被无关写入污染的时间戳当唯一依据。
    groups.sort((a, b) => {
      const at = Date.parse(a.createdAt) || 0;
      const bt = Date.parse(b.createdAt) || 0;
      if (at !== bt) return at - bt;
      // 同秒建立（或时间戳缺失）时按名字收口，纯为了确定性，不表达任何语义。
      return a.name.localeCompare(b.name, "zh") || a.workspace.localeCompare(b.workspace);
    });
    // 「未归属」排最前，和 hermes 的 Home 一样：它是没有归属的对话唯一的落点，
    // 被一堆空间压到列表底部就等于丢了。一个这样的对话都没有时整格不出现，
    // 免得一个空桶天天占着列表第一行。
    const unassigned = orphans.filter((row) => !row.archived);
    if (unassigned.length) {
      groups.unshift({
        id: null,
        name: "收件箱",
        workspace: "",
        createdAt: "",
        sessions: rankInSpace(unassigned),
        total: orphans.length,
        unassigned: true,
      });
    }
    return groups;
  });

  let unlistenUpdate: UnlistenFn | undefined;
  let unlistenLagged: UnlistenFn | undefined;
  let unlistenPerm: UnlistenFn | undefined;
  let unlistenPermResolved: UnlistenFn | undefined;
  let unlistenDetachedOpen: UnlistenFn | undefined;
  let unlistenDetachedClose: UnlistenFn | undefined;

  function textOf(content: { type: string; text?: string }): string {
    return content.type === "text" ? content.text ?? "" : "";
  }

  function upsert(
    rec: TabRecord,
    role: ChatMessage["role"],
    id: string,
    chunk: string,
    append = false,
  ) {
    const existing = rec.messages.find((m) => m.id === id);
    if (existing) {
      existing.text = append ? existing.text + chunk : existing.text || chunk;
      if (role === "assistant") {
        existing.streaming = true;
        if (chunk) recordOutputChunk(existing, chunk);
      }
    } else if (chunk && chunk.trim()) {
      // 只对「有实际内容」的 chunk 新建消息。
      // 否则后端在工具轮次发出的空文本 agent_message_chunk 会各自新建一条
      // 空助手消息，屏幕上出现一堆「⌀」空气泡，看不到真正的输出内容。
      rec.messages.push({ id, role, text: chunk, ...(role === "assistant" ? { streaming: true, engineId: rec.prefs.agentEngine || "native" } : {}) });
      if (role === "assistant") recordOutputChunk(rec.messages[rec.messages.length - 1], chunk);
    }
  }

  function recordOutputChunk(message: ChatMessage, chunk: string) {
    if (!chunk) return;
    const now = Date.now();
    const prev = message.outputMetrics;
    message.outputMetrics = {
      estimatedTokens: (prev?.estimatedTokens ?? 0) + estimateOutputTokenUnits(chunk),
      startedAt: prev?.startedAt ?? now,
      lastChunkAt: now,
      samples: (prev?.samples ?? 0) + 1,
    };
  }

  function decodeB64(data: string): string {
    try {
      const bin = atob(data);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return "";
    }
  }

  function upsertTerminal(sessionId: string, terminalId: string): LiveTerminal {
    const cur = terminals.value[terminalId] ?? {
      terminalId,
      sessionId,
      command: "",
      cwd: "",
      text: "",
      exited: false,
      exitCode: null,
    };
    cur.sessionId = sessionId;
    terminals.value = { ...terminals.value, [terminalId]: cur };
    return cur;
  }

  // 工作单 2026-10-19 第二版·条目 7：后台终端能挂几个小时不停输出，前端不许
  // 无界累积 —— 内存、每次 terminals 反应式拷贝、所有全文渲染都按输出总量
  // 付费。只留尾部：任务栏和抽屉里人看的都是尾巴。重复调用是稳定的 —— 上一次的
  // 标记会被尾巴窗口挤掉，标记始终只有一份、始终在头。
  const TERMINAL_TEXT_CAP = 128_000;
  const TERMINAL_TRUNCATION_MARK = "…[早期输出已截断]\n";
  function capTerminalText(text: string): string {
    const hadMark = text.startsWith(TERMINAL_TRUNCATION_MARK);
    const body = hadMark ? text.slice(TERMINAL_TRUNCATION_MARK.length) : text;
    if (body.length <= TERMINAL_TEXT_CAP) return text;
    return TERMINAL_TRUNCATION_MARK + body.slice(body.length - TERMINAL_TEXT_CAP);
  }

  function applyLiveUpdate(sessionId: string, update: BusFrame["params"]["update"]) {
    if (update.sessionUpdate === "terminal_update") {
      const rec = upsertTerminal(sessionId, update.terminalId);
      if (update.command) rec.command = update.command;
      if (update.cwd) rec.cwd = update.cwd;
      if (update.background !== undefined && update.background !== null) {
        rec.background = update.background;
        rec.startedAt ??= Date.now();
        rec.status = "running";
      }
      if (update.output?.data) rec.text = capTerminalText(decodeB64(update.output.data));
      if (update.exitStatus) {
        rec.exited = true;
        rec.exitCode = update.exitStatus.exitCode ?? null;
        rec.status = rec.status === "killed" ? "killed" : "exited";
      }
      terminals.value = { ...terminals.value, [rec.terminalId]: { ...rec } };
      return;
    }
    if (update.sessionUpdate === "terminal_output_chunk") {
      const rec = upsertTerminal(sessionId, update.terminalId);
      rec.text = capTerminalText(rec.text + decodeB64(update.data));
      terminals.value = { ...terminals.value, [rec.terminalId]: { ...rec } };
    }
  }

  async function refreshBackgroundProcesses(sessionId: string) {
    if (!sessionId) return;
    try {
      const processes: BackgroundProcess[] = await ipc.backgroundProcesses(sessionId);
      const next = { ...terminals.value };
      for (const process of processes) {
        const previous = next[process.id];
        const status = previous?.exited && process.status === "running"
          ? previous.status ?? "exited"
          : process.status;
        next[process.id] = {
          terminalId: process.id,
          sessionId,
          command: process.command,
          cwd: process.cwd,
          text: capTerminalText(previous?.text || process.output),
          background: true,
          startedAt: previous?.startedAt ?? Date.now() - process.elapsedMs,
          status,
          exited: status !== "running",
          exitCode: process.exitCode ?? previous?.exitCode ?? null,
        };
      }
      terminals.value = next;
    } catch (err) {
      error.value = errText(err);
    }
  }

  function applyFrame(frame: BusFrame) {
    const sid = frame.params.sessionId;
    const update = frame.params.update;
    if (update.sessionUpdate === "_tool_call_progress") {
      const next = { ...toolGeneration.value };
      if (update.name) next[sid] = { name: update.name, argumentBytes: update.argumentBytes };
      else delete next[sid];
      toolGeneration.value = next;
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      if (update.status === "pending") {
        const next = { ...toolGeneration.value };
        delete next[sid];
        toolGeneration.value = next;
      }
      const id = update.toolCallId;
      if (["completed", "failed", "cancelled"].includes(update.status ?? "")) {
        finishedPermissionCalls.add(id);
        if (finishedPermissionCalls.size > 512) {
          const oldest = finishedPermissionCalls.values().next().value;
          if (oldest) finishedPermissionCalls.delete(oldest);
        }
        const next = { ...permissionToolInputs.value };
        delete next[id];
        permissionToolInputs.value = next;
        permissionQueue.value = permissionQueue.value.filter((request) => request.toolCallId !== id);
      } else if (update.rawInput !== undefined) {
        finishedPermissionCalls.delete(id);
        permissionToolInputs.value = { ...permissionToolInputs.value, [id]: { sessionId: sid, args: update.rawInput } };
      }
    }
    if (
      update.sessionUpdate === "terminal_update" ||
      update.sessionUpdate === "terminal_output_chunk"
    ) {
      applyLiveUpdate(sid, update);
    }
    if (update.sessionUpdate === "state_update") {
      const prev = runState.value[sid] ?? { running: false, stopReason: null };
      if (update.state === "queued") {
        runState.value = {
          ...runState.value,
          [sid]: { running: true, queued: true, stopReason: null },
        };
      } else if (update.state === "running") {
        runState.value = {
          ...runState.value,
          [sid]: {
            running: true,
            queued: false,
            stopReason: null,
            startedAt: prev.running && !prev.queued ? prev.startedAt ?? Date.now() : Date.now(),
          },
        };
      } else {
        const next = { ...toolGeneration.value };
        delete next[sid];
        toolGeneration.value = next;
        runState.value = {
          ...runState.value,
          [sid]: { running: false, queued: false, stopReason: update.stopReason ?? prev.stopReason },
        };
      }
    }
    if (update.sessionUpdate === "_job_update") {
      void refreshList();
      void refreshCron();
    }
    if (update.sessionUpdate === "_wiki_draft") {
      // 草稿已在后端落盘（账本没有条目、也没有任何写入）；这里只做展示态追加。
      const list = wikiDrafts.value[sid] ?? [];
      if (!list.some((draft) => draft.draftId === update.draftId)) {
        wikiDrafts.value = {
          ...wikiDrafts.value,
          [sid]: [...list, {
            draftId: update.draftId,
            sessionId: sid,
            kind: update.kind,
            content: update.content,
            mode: update.mode,
            createdAt: new Date().toISOString(),
          }],
        };
      }
      return;
    }
    if (update.sessionUpdate === "_wiki_update") {
      wikiCompile.value = { phase: update.phase, message: update.message ?? null, workspace: update.workspace };
      return;
    }
    const rec = records.value[sid];
    if (!rec) return;
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        const pending = pendingPrompts.get(sid);
        if (pending && textOf(update.content) === pending.text) {
          const local = rec.messages.find((message) => message.id === pending.id);
          if (local) local.id = update.messageId;
          pendingPrompts.delete(sid);
        }
        upsert(rec, "user", update.messageId, textOf(update.content));
        break;
      }
      case "_user_images": {
        // Paths only; the component lazily renders previews.
        const target = rec.messages.find((m) => m.id === update.messageId);
        if (target) {
          target.imagePaths = update.files;
          target.images = undefined;
        }
        break;
      }
      case "agent_message_chunk": {
        upsert(rec, "assistant", update.messageId, textOf(update.content), true);
        break;
      }
      case "_reasoning_delta": {
        const existing = rec.messages.find((m) => m.id === update.messageId);
        if (existing) {
          existing.reasoningText = (existing.reasoningText ?? "") + update.text;
          existing.streaming = true;
          recordOutputChunk(existing, update.text);
        } else if (update.text) {
          const message: ChatMessage = {
            id: update.messageId,
            role: "assistant",
            text: "",
            reasoningText: update.text,
            streaming: true,
            engineId: rec.prefs.agentEngine || "native",
          };
          recordOutputChunk(message, update.text);
          rec.messages.push(message);
        }
        break;
      }
      case "tool_call_update": {
        const id = update.toolCallId;
        const piece =
          update.content
            ?.map((c) => (c.type === "content" ? c.content.text : ""))
            .filter(Boolean)
            .join("\n") ?? "";
        let terminalId: string | undefined;
        for (const c of update.content ?? []) {
          if (c.type === "terminal") terminalId = c.terminalId;
        }
        const title = update.title ?? update.kind ?? "tool";
        const status = update.status ?? "";
        const existing = rec.messages.find((m) => m.id === id);
        if (existing) {
          existing.status = status || existing.status;
          if (piece) existing.text += piece;
          if (update.title) existing.text = `${title}\n${existing.text}`.trim();
          if (terminalId) existing.terminalId = terminalId;
        } else {
          rec.messages.push({
            id,
            role: "tool",
            text: piece ? `${title}\n${piece}` : title,
            toolCallId: id,
            status,
            kind: update.kind,
            terminalId,
          });
        }
        break;
      }
      case "state_update": {
        if (update.state === "queued") {
          rec.running = true;
        }
        if (update.state === "running") {
          rec.running = true;
          rec.stopReason = null;
        }
        if (update.state === "idle") {
          rec.running = false;
          rec.stopping = false;
          rec.stopReason = update.stopReason ?? null;
          for (const message of rec.messages) {
            if (message.role === "assistant") message.streaming = false;
          }
          void refreshList();
          if (!openIds.value.includes(sid) && !rec.running) {
            const next = { ...records.value };
            delete next[sid];
            records.value = next;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // 解绑所有 Tauri 事件监听。这些 unlisten 句柄存在闭包里，store 被丢弃时不会
  // 自动清理，所以热更新重建 store 前必须显式调用，否则旧监听会残留下来、
  // 和新 store 的监听一起触发（每次热更新累积一层，同一个 frame 被处理多次）。
  function teardownListeners() {
    unlistenUpdate?.(); unlistenUpdate = undefined;
    unlistenLagged?.(); unlistenLagged = undefined;
    unlistenPerm?.(); unlistenPerm = undefined;
    unlistenPermResolved?.(); unlistenPermResolved = undefined;
    unlistenDetachedOpen?.(); unlistenDetachedOpen = undefined;
    unlistenDetachedClose?.(); unlistenDetachedClose = undefined;
    window.removeEventListener("focus", syncPendingPermissions);
  }

  async function listenBus() {
    if (!unlistenUpdate) {
      unlistenUpdate = await listen<BusFrame>("session-update", (ev) => {
        applyFrame(ev.payload);
      });
    }
    if (!unlistenLagged) {
      // 后端转发订阅队列 Lagged 时不再静默丢帧：它会带着丢失条数发
      // "bus-lagged"，这里以持久化状态为准把显示重建回来。
      unlistenLagged = await listen<{ missed: number; total: number }>("bus-lagged", (ev) => {
        void resyncAfterLag(ev.payload);
      });
    }
    if (!unlistenPerm) {
      // 后端现在向所有窗口广播审批：审批必须可达，不管任务占用哪个窗口。
      // 弹窗自带“来自任务”标注；任一窗口应答后 permission-resolved 关掉其余镜像。
      unlistenPerm = await listen<PermissionEvent>("permission-request", (ev) => {
        if (ev.payload.toolCallId && finishedPermissionCalls.has(ev.payload.toolCallId)) return;
        if (!permissionQueue.value.some((req) => req.requestId === ev.payload.requestId)) {
          permissionQueue.value = [...permissionQueue.value, ev.payload];
        }
      });
    }
    if (!unlistenPermResolved) {
      unlistenPermResolved = await listen<{ requestId: string }>("permission-resolved", (ev) => {
        permissionQueue.value = permissionQueue.value.filter(
          (request) => request.requestId !== ev.payload.requestId,
        );
      });
    }
    // 一次性事件错过（窗口不可见/尚未监听）就等于永久错过，直到超时静默拒。
    // focus 时向后端拉一次未决快照重放，把这个静默窗口关掉。
    window.addEventListener("focus", syncPendingPermissions);
    void syncPendingPermissions();
  }

  let lagResyncing = false;
  let lagAgain = false;

  async function resyncAfterLag(payload: { missed: number; total: number }) {
    notice.value = `任务事件太快，界面错过了 ${payload.missed} 帧（累计 ${payload.total}），已从保存的状态重新同步。`;
    // 同步进行中又来 lag：不并发拉两份，等这轮收尾后再来一轮，
    // 保证最后一次重建看到的是最新落库状态。
    if (lagResyncing) {
      lagAgain = true;
      return;
    }
    lagResyncing = true;
    try {
      do {
        lagAgain = false;
        await resyncOpenSessions();
      } while (lagAgain);
    } finally {
      lagResyncing = false;
    }
  }

  async function resyncOpenSessions() {
    for (const id of [...openIds.value]) {
      try {
        const exp = await ipc.sessionExportWindow(id);
        const rec = records.value[id];
        if (!rec) continue;
        const running = exp.lastRun?.status === "running";
        // 还在跑的会话：尾部有尚未落库的直播内容，覆盖消息窗口反而会丢
        // 已看到的输出；等这轮结束落库后，持久化状态才是完整口径。
        if (!running) {
          rec.messages = messagesFromExport(exp);
          rec.historyRemaining = Math.max(0, (exp.totalMessages ?? exp.messages.length) - exp.messages.length);
        }
        const prev = runState.value[id] ?? { running: false, stopReason: null };
        if (prev.running !== running) {
          runState.value = {
            ...runState.value,
            [id]: {
              running,
              queued: false,
              stopReason: running ? null : exp.lastRun?.stopReason ?? prev.stopReason,
            },
          };
        }
        if (!running) markTerminalsUnverified(id);
      } catch {
        // 重同步失败维持现状，等下一次 lag 或用户重新打开；这里不许雪上加霜。
      }
    }
  }

  function markTerminalsUnverified(sessionId: string) {
    // 后端没有可重放的终端快照：运行已结束而终端记录还没收到退出帧，
    // 说明这段状态可能正是丢掉的那批 —— 标注「未确认」，不许继续显示成
    // 好像一切正常。
    const next = { ...terminals.value };
    let changed = false;
    for (const [terminalId, rec] of Object.entries(next)) {
      if (rec.sessionId === sessionId && !rec.exited) {
        next[terminalId] = { ...rec, unverified: true };
        changed = true;
      }
    }
    if (changed) terminals.value = next;
  }

  async function syncPendingPermissions() {
    try {
      const pending = await ipc.hostPermissionPending();
      for (const req of pending) {
        if (req.toolCallId && finishedPermissionCalls.has(req.toolCallId)) continue;
        if (!permissionQueue.value.some((item) => item.requestId === req.requestId)) {
          permissionQueue.value = [...permissionQueue.value, req];
        }
      }
    } catch {
      // 启动早期 Runtime/命令尚未就绪，focus 事件下次会再拉。
    }
  }

  async function listenDetachedEvents() {
    if (surface.value === WINDOW_09_SURFACE) return;
    if (!unlistenDetachedOpen) {
      unlistenDetachedOpen = await listen<string>("detached-opened", (ev) => {
        markDetached(ev.payload);
        dropMainTab(ev.payload, false);
      });
    }
    if (!unlistenDetachedClose) {
      unlistenDetachedClose = await listen<string>("detached-closed", (ev) => {
        detachedIds.value = detachedIds.value.filter((id) => id !== ev.payload);
      });
    }
  }

  function markDetached(id: string) {
    if (!detachedIds.value.includes(id)) {
      detachedIds.value = [...detachedIds.value, id];
    }
  }

  function dropMainTab(id: string, releaseMain: boolean) {
    if (releaseMain) {
      void ipc.sessionRelease(id, MAIN_SURFACE).catch(() => undefined);
    }
    openIds.value = openIds.value.filter((x) => x !== id);
    const next = { ...records.value };
    delete next[id];
    records.value = next;
    if (activeId.value === id) {
      activeId.value = openIds.value[openIds.value.length - 1] ?? "";
      void refreshContext();
    }
  }

  async function refreshList() {
    const previous = new Set(rows.value.filter((row) => row.archived).map((row) => row.id));
    const list = await ipc.sessionsList(200, 0);
    rows.value = list;
    // 「不在这一页里」分两种情况，处理方式相反：
    // - 页没装满 200 条 → 这页就是全部，不在 = 真没了（被删），该关；
    // - 页装满 200 条 → 会话数可能超过窗口，不在 = 只是被截断，**不能关**，
    //   否则对话攒过 200 条以后，旧标签页会被每次刷新莫名关掉一个。
    const truncated = list.length >= 200;
    const byId = new Map(list.map((row) => [row.id, row]));
    const keep = (id: string) => {
      const row = byId.get(id);
      if (!row) return truncated;
      // 归档一个对话要顺手关掉它的标签页，但从归档区主动打开的对话必须留得住。
      // 只按 archived 过滤会把后者也踢掉（每次 refreshList 都踢一遍，标签页会自己
      // 消失），所以这里只清理"这一次刷新中新变为归档"的那些。
      return !row.archived || previous.has(id);
    };
    openIds.value = openIds.value.filter(keep);
    if (activeId.value && !keep(activeId.value)) activeId.value = openIds.value[openIds.value.length - 1] ?? "";
  }

  async function refreshProjects() {
    projects.value = await ipc.projectsList();
  }

  // ---- 工作空间（会话的归属单位） -------------------------------------------

  /**
   * 把任意工作目录收敛成「未归属」能接受的形式：已登记空间的目录，或 null。
   *
   * 侧栏的分组与「当前目录」的显示都按这个口径：目录没登记成空间时算 null，落进
   * 「未归属」那一格。用户想让它成为空间，走「打开文件夹作为新空间」。
   */
  function normalizeWorkspace(workspace: string | null | undefined): string | null {
    if (!workspace) return null;
    return projects.value.some((project) => project.workspace === workspace) ? workspace : null;
  }

  /**
   * 在指定空间里开一条新对话（侧栏每个空间分组头 hover 出的 ＋ 走这里）。
   *
   * 没有它，一个刚建好的空空间就开不了第一句话：新对话继承的是**当前打开的那条
   * 会话**的目录，而空空间里没有会话可继承。
   *
   * 只给登记过的空间挂这个入口，「未归属」那个桶不挂：它不是一个空间，给它一个 ＋
   * 会让它长得像空间 —— 这正是我们前两轮才诊断掉的病。要在一个目录里开新对话，
   * 先把那个目录变成空间。
   */
  async function newTaskIn(workspace: string): Promise<string | null> {
    error.value = null;
    try {
      const current = active.value;
      // 复用空白草稿，理由同 newTask：一句没说过就再开一条，退出时侧栏会积一堆空壳。
      //
      // 但**只在这个草稿已经在目标空间里**时才复用。否则「在 B 空间点 ＋」会把 A 空间
      // 那条没说过话的草稿改改目录搬到 B —— 用户看到的是：我明明要在另一个空间开一条，
      // 结果标签页数没变，刚才那条被挪走了。跨空间开对话拿不到第二个 tab，正是这个
      // 「搬草稿」造成的。目标不同就正经开一条新的。
      const draftHere =
        current &&
        current.kind === "user" &&
        current.title === "未命名任务" &&
        current.messages.length === 0 &&
        !current.running &&
        !current.stopping &&
        (current.prefs.workspace || current.workspace) === workspace;
      if (draftHere && current) {
        mainView.value = "chat";
        dockPanel.value = "tasks";
        return current.id;
      }
      const id = await ipc.sessionNew();
      // 先写目录再打开，中途不会先以别的目录出现在另一格里再跳过去。
      await ipc.sessionPrefsSet(id, { workspace }).catch(() => undefined);
      await refreshList();
      await openSession(id);
      return id;
    } catch (err) {
      error.value = errText(err);
      return null;
    }
  }

  /**
   * 兼容旧菜单入口：项目只是对话的目录归属，不再打开独立管理页；直接选择目录
   * 新增项目，始终留在当前对话工作面。
   */
  function openSpacesPage() {
    void newProject();
  }

  /**
   * 启动/刷新后检查一遍：有没有目录暂时读不到的空间，有就提示，**什么都不删**。
   *
   * 旧实现在这里调 projectsPruneMissing：目录当前不在就连空间带对话物理删除。
   * 但「读不到」最常见的原因是移动盘没插、网络盘没连、盘符晚到 —— 目录回来时
   * 对话已经没了，恢复不回来。数据保留、界面标灰、用户自己决定删不删，才是
   * 这个场景该有的行为。真删只走侧栏右键的 project_delete（显式用户动作）。
   */
  async function notifyInaccessibleProjects() {
    try {
      const missing = projects.value.filter((project) => project.accessible === false);
      if (!missing.length) return;
      const names = missing.map((project) => project.name).join("、");
      notice.value = `${missing.length} 个工作空间的目录暂时访问不到（${names}）。对话已原样保留，接上磁盘/网络后会自动恢复；确认不再需要再手动删除该空间。`;
    } catch {
      // 只是提示，坏了不拦启动。
    }
  }

  /**
   * 「清理空空间」的第一步：让后端空跑一次，把「一个对话都没有的空间」列出来。
   *
   * 判据必须由后端算 —— 前端的 rows 只是最近一页，用它筛会把超出窗口的对话
   * 当成不存在，进而删掉一个有对话的空间。空跑拿到名单后弹确认，用户看过名字
   * 再决定删不删。
   */
  async function previewEmptyProjects() {
    error.value = null;
    try {
      const doomed = await ipc.projectsPruneEmpty(true);
      if (!doomed.length) {
        notice.value = "没有需要清理的空间：每个空间名下都有对话。";
        return;
      }
      emptySpaceTarget.value = doomed;
    } catch (err) {
      error.value = errText(err);
    }
  }

  /** 确认清理。真删一次，和后端返回的名单对得上才报数（防止期间状态变了）。 */
  async function confirmPruneEmptyProjects() {
    const preview = emptySpaceTarget.value ?? [];
    emptySpaceTarget.value = null;
    if (!preview.length) return;
    try {
      const removed = await ipc.projectsPruneEmpty(false);
      await refreshProjects();
      const names = removed.map((item) => item.name).join("、");
      notice.value = removed.length
        ? `已清理 ${removed.length} 个没有对话的空间：${names}`
        : "这些空间刚刚有了对话，已全部保留。";
    } catch (err) {
      error.value = errText(err);
    }
  }

  async function refreshCatalog() {
    // 可选清单：每一项只对它自己的功能要紧。旧实现里 skillsList/mcpList/
    // sandboxRoots 不接异常，任何一项抛错整个 refreshCatalog 就 reject，
    // boot() 连带失败 —— 明明有能打开的会话，界面却停在空白页。现在
    // allSettled 逐项兜底：失败只影响对应功能，聚合成一条看得懂的提示。
    const [plugins, skillsList, mcpList, corpus, spaces, sandboxRoots] = await Promise.allSettled([
      ipc.agentPluginsList(),
      ipc.skillsList(),
      ipc.mcpList(),
      ipc.corpusList(),
      ipc.knowledgeLocalSpaces(),
      ipc.sandboxRoots(),
    ]);
    const failed: string[] = [];
    if (plugins.status === "fulfilled") agentPlugins.value = plugins.value;
    else { agentPlugins.value = []; failed.push("Agent 插件"); }
    if (skillsList.status === "fulfilled") skills.value = skillsList.value;
    else failed.push("Skills");
    if (mcpList.status === "fulfilled") mcpServers.value = mcpList.value;
    else failed.push("MCP 服务");
    if (corpus.status === "fulfilled") corpusDocs.value = corpus.value;
    else { corpusDocs.value = []; failed.push("资料库"); }
    if (spaces.status === "fulfilled") knowledgeSpaces.value = spaces.value;
    else { knowledgeSpaces.value = []; failed.push("知识库"); }
    if (sandboxRoots.status === "fulfilled") sandbox.value = sandboxRoots.value;
    else failed.push("沙箱目录");
    if (failed.length) {
      notice.value = `部分功能清单加载失败（${failed.join("、")}），不影响对话使用；重新打开对应面板会再次尝试加载。`;
    }
  }

  async function refreshAgentPlugins() {
    agentPlugins.value = await ipc.agentPluginsList();
  }

  async function installAgentPlugin(id: string) {
    await ipc.agentPluginInstall(id);
    await refreshAgentPlugins();
  }

  async function connectAgentPlugin(id: string, path?: string) {
    await ipc.agentPluginConnect(id, path);
    await refreshAgentPlugins();
  }

  async function setAgentPluginModel(id: string, model?: string) {
    await ipc.agentPluginSetModel(id, model);
    await refreshAgentPlugins();
  }

  async function uninstallAgentPlugin(id: string) {
    await ipc.agentPluginUninstall(id);
    await refreshAgentPlugins();
  }

  async function stopAgentPlugin(id: string) {
    await ipc.agentPluginStop(id);
  }

  async function refreshKnowledgeSpaces() {
    knowledgeSpaces.value = await ipc.knowledgeLocalSpaces().catch(() => []);
  }

  async function refreshContext() {
    const id = activeId.value || undefined;
    contextStatus.value = await ipc.contextStatus(id);
  }

  async function loadRecord(id: string): Promise<TabRecord> {
    // Do not deserialize an unbounded transcript before first paint. The
    // remaining history stays in SQLite until the user asks to see it.
    void refreshWikiDrafts(id);
    const exp = await ipc.sessionExportWindow(id);
    const unfinishedPreviousRun = exp.lastRun?.status === "running" && !runState.value[id]?.running;
    if ((exp.lastRun?.status === "failed" || unfinishedPreviousRun) && !failedAttempts.value[id]) {
      const lastPrompt = [...exp.messages].reverse().find((message) => message.role === "user")?.content;
      if (lastPrompt) {
        failedAttempts.value = {
          ...failedAttempts.value,
          [id]: {
            prompt: lastPrompt,
            engineId: exp.lastRun?.kind?.startsWith("engine:") ? exp.lastRun.kind.slice(7) : "native",
            error: unfinishedPreviousRun
              ? "上次运行没有完成记录，可能在程序关闭时中断。请先检查输出，再决定是否重试。"
              : exp.lastRun?.errorMessage || "上次执行失败。可以复制原始任务，或按原任务重试。",
            mode: "auto",
            imageUrls: [],
          },
        };
      }
    }
    let prefs: SessionPrefs = exp.prefs ?? {};
    let binds = emptyBindings();
    // 两者互不依赖，并行拿，各少一轮 IPC 等待；allSettled 保住旧语义——
    // 任何一个失败只丢它自己那份（新会话没 prefs、没绑定的会话 bindings 报错），
    // 不影响另一个，也不让打开流程因此失败。
    const [prefsRes, bindsRes] = await Promise.allSettled([
      ipc.sessionPrefsGet(id),
      ipc.sessionTaskBindings(id),
    ]);
    if (prefsRes.status === "fulfilled") prefs = prefsRes.value;
    if (bindsRes.status === "fulfilled") binds = bindsRes.value;
    return {
      id: exp.id,
      title: exp.title || "未命名任务",
      kind: exp.kind || "user",
      parentId: exp.parentId ?? null,
      workspace: exp.workspace,
      messages: messagesFromExport(exp),
      historyRemaining: Math.max(0, (exp.totalMessages ?? exp.messages.length) - exp.messages.length),
      loadingHistory: false,
      running: runState.value[id]?.running ?? false,
      stopping: false,
      stopReason: runState.value[id]?.stopReason ?? ((exp.lastRun?.status === "failed" || unfinishedPreviousRun) ? "error" : null),
      prefs,
      skillIds: binds.skill ?? [],
      mcpIds: binds.mcp ?? [],
      corpusIds: binds.corpus ?? [],
      knowledgeIds: binds.knowledge ?? [],
    };
  }

  async function loadOlderMessages() {
    const rec = active.value;
    if (!rec || rec.loadingHistory || rec.historyRemaining <= 0) return;
    rec.loadingHistory = true;
    try {
      const exp = await ipc.sessionExportWindow(rec.id, rec.messages.length);
      const older = messagesFromExport(exp);
      const existing = new Set(rec.messages.map((message) => message.id));
      rec.messages = [...older.filter((message) => !existing.has(message.id)), ...rec.messages];
      rec.historyRemaining = Math.max(0, (exp.totalMessages ?? rec.messages.length) - rec.messages.length);
    } catch (err) {
      error.value = errText(err);
    } finally {
      rec.loadingHistory = false;
    }
  }

  async function openSession(id: string) {
    await tryOpenSession(id);
  }

  async function tryOpenSession(id: string): Promise<boolean> {
    const seq = ++openSeq;
    ipc.bootMark("open:click", `session=${id}`);
    error.value = null;
    if (openIds.value.includes(id)) {
      activeId.value = id;
      mainView.value = "chat";
      dockPanel.value = "tasks";
      void refreshContext();
      return true;
    }
    // 点击即亮加载态：目标对话立刻显示「正在打开」，后面几步慢也不至于是黑盒。
    pendingOpenId.value = id;
    const settle = () => {
      if (seq === openSeq) pendingOpenId.value = "";
    };
    try {
      await ipc.sessionOccupy(id, MAIN_SURFACE);
    } catch (err) {
      const msg = errText(err);
      const focused = await ipc.sessionFocusDetached(id).catch(() => false);
      if (focused || msg.includes("window-09")) {
        if (seq === openSeq) error.value = `无法在主窗打开：该任务已在独立窗口占用（${id}）`;
        markDetached(id);
        settle();
        return false;
      }
      if (seq === openSeq) error.value = msg;
      settle();
      return false;
    }
    // occupy 期间用户可能又点了别的对话：这一次已被更晚的点击取代，刚占到手
    // 就归还，让最后一次点击赢。没有这道闸，晚回来的 A 会把界面从 B 抢回去。
    if (seq !== openSeq) {
      void ipc.sessionRelease(id, MAIN_SURFACE).catch(() => undefined);
      return false;
    }
    ipc.bootMark("open:occupied", `session=${id}`);
    try {
      if (!records.value[id]) {
        records.value = { ...records.value, [id]: await loadRecord(id) };
      }
    } catch (err) {
      // 读消息失败必须归还刚拿到的占用并把原因摆出来。旧实现不接这个异常：
      // 一次失败点击把会话永久占在主窗，重试一直报占用，用户两头都够不着。
      await ipc.sessionRelease(id, MAIN_SURFACE).catch(() => undefined);
      if (seq === openSeq) error.value = `打开对话失败：${errText(err)}`;
      settle();
      return false;
    }
    if (seq !== openSeq) {
      void ipc.sessionRelease(id, MAIN_SURFACE).catch(() => undefined);
      return false;
    }
    ipc.bootMark("open:messages", `session=${id}`);
    if (!openIds.value.includes(id)) openIds.value = [...openIds.value, id];
    activeId.value = id;
    mainView.value = "chat";
    dockPanel.value = "tasks";
    settle();
    void refreshContext();
    // 首帧：状态提交后下一帧再落计时，量到的是用户真正看见内容的时刻。
    const paint = () => {
      ipc.bootMark("open:painted", `session=${id}`);
      void ipc.flushBootMarks().catch(() => undefined);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(paint);
    else setTimeout(paint, 0);
    return true;
  }

  async function closeTab(id: string) {
    await ipc.sessionRelease(id, MAIN_SURFACE).catch(() => undefined);
    openIds.value = openIds.value.filter((x) => x !== id);
    const rec = records.value[id];
    if (rec && !rec.running) {
      const next = { ...records.value };
      delete next[id];
      records.value = next;
    }
    if (activeId.value === id) {
      activeId.value = openIds.value[openIds.value.length - 1] ?? "";
      void refreshContext();
    }
  }

  async function detachSession(id: string) {
    error.value = null;
    try {
      await ipc.sessionDetach(id);
      dropMainTab(id, false);
      markDetached(id);
    } catch (err) {
      error.value = errText(err);
    }
  }

  async function refreshDetached() {
    try {
      detachedIds.value = await ipc.sessionDetachedIds();
    } catch {
      detachedIds.value = [];
    }
  }

  async function readSurface(): Promise<{ surface: string; detachedId: string | null }> {
    try {
      const label = getCurrentWindow().label;
      if (label.startsWith(WIN09_PREFIX)) {
        return { surface: WINDOW_09_SURFACE, detachedId: label.slice(WIN09_PREFIX.length) };
      }
    } catch {
      /* vite without tauri */
    }
    return { surface: MAIN_SURFACE, detachedId: null };
  }

  async function bootDetached(id: string) {
    dockPanel.value = null;
    mainView.value = "chat";
    settingsTabOpen.value = false;
    try {
      await ipc.sessionOccupy(id, WINDOW_09_SURFACE);
      records.value = { [id]: await loadRecord(id) };
      openIds.value = [id];
      activeId.value = id;
      await refreshCatalog().catch(() => undefined);
      await refreshContext().catch(() => undefined);
      await getCurrentWindow().onCloseRequested(async () => {
        await ipc.sessionRelease(id, WINDOW_09_SURFACE).catch(() => undefined);
      });
    } catch (err) {
      error.value = errText(err);
    }
  }

  async function boot() {
    // Work-order §二: per-phase boot marks (local clock, one batched flush in
    // App.vue). Marks only record, they never reorder or gate anything.
    ipc.bootMark("boot:start");
    const current = await readSurface();
    surface.value = current.surface;
    ipc.bootMark("boot:surface", `surface=${current.surface}`);
    info.value = await ipc.runtimeInfo();
    settings.value = await ipc.settingsGet();
    // 老单一服务地址 → profile 列表的一次性引导；异步补，不阻塞启动。
    void ensureProviderProfilesSeeded().catch(() => undefined);
    await listenBus();
    ipc.bootMark("boot:runtime+settings+bus", ipc.ipcStatsDigest(6));
    if (current.surface === WINDOW_09_SURFACE && current.detachedId) {
      await bootDetached(current.detachedId);
      ipc.bootMark("boot:detached-session-ready");
      ipc.flushBootMarks();
      return;
    }
    await refreshList();
    await refreshProjects();
    // 目录当前读不到的空间：只提示、不动数据（旧实现在这里连空间带对话删除，
    // 移动盘/网络盘没就位就会误删，已移除）。排在 refreshProjects 之后，
    // 提示里才拿得到刚拉回来的空间列表。
    await notifyInaccessibleProjects();
    await refreshDetached();
    ipc.bootMark("boot:list+projects", ipc.ipcStatsDigest(6));
    // 会话优先：插件/Skills/MCP/资料库/边车这些都是可选清单，一项挂掉
    // 只该挂掉那项功能，旧实现却把它们排在打开会话之前串行 await ——
    // 慢的一直不回来，界面就一直不开。现在候选会话先开，其余随后异步补。
    void Promise.allSettled([
      refreshCatalog(),
      refreshSidecar().catch(() => undefined),
      listenDetachedEvents().catch(() => undefined),
      refreshContext().catch(() => undefined),
    ]).then(() => {
      ipc.bootMark("boot:optional-manifests");
      void ipc.flushBootMarks().catch(() => undefined);
    });
    const available = rows.value.filter((r) => !r.archived);
    const users = available.filter((r) => r.kind === "user");
    const candidates = users.length ? users : available;
    for (const row of candidates) {
      // 单个会话打开时的意外异常不该中断回退链：记下来，继续试下一个。
      let opened = false;
      try {
        opened = await tryOpenSession(row.id);
      } catch {
        opened = false;
      }
      if (opened) {
        ipc.bootMark("boot:session-ready", `session=${row.id}`);
        ipc.flushBootMarks();
        return;
      }
    }
    // The empty screen is intentional: the first composer submission creates
    // the task, just like Codex's new-task flow.
    ipc.bootMark("boot:empty-screen");
    ipc.flushBootMarks();
  }

  async function newTask(): Promise<string> {
    error.value = null;
    // 「新对话」= 白纸，**不带工作目录**。
    //
    // 工作目录是用户为这条对话选的属性，只有显式指定它的动作才写：分组头的
    // 「＋」→ `newTaskIn(workspace)`，或者输入框那个 chip 自己加/清。反过来，
    // 「新建」这个动作本身不该替用户挑目录 —— 以前它继承当前对话的目录，再往前
    // 继承的是一个全局「当前空间」，用户看到的都是刚建的空对话自带一个自己没选过的
    // 目录名，还得先点 × 才能开始。（后端那一侧同样不再拿运行时兜底目录盖章，
    // 见 `Runtime::create_session`。）
    //
    // A blank task is a composer draft, not a resource that should be
    // duplicated every time the user presses "New chat".  Reuse it until a
    // first message makes it a real conversation.
    const current = active.value;
    if (
      current &&
      current.kind === "user" &&
      current.title === "未命名任务" &&
      current.messages.length === 0 &&
      !current.running &&
      !current.stopping
    ) {
      // 复用草稿时不动它已有的目录：那是用户自己加上的，不是这里该顺手丢掉的东西。
      mainView.value = "chat";
      dockPanel.value = "tasks";
      return current.id;
    }
    const id = await ipc.sessionNew();
    await refreshList();
    await openSession(id);
    return id;
  }

  function returnToConversation() {
    // Project Explorer is a tool surface over the active task's workspace.
    // Leaving it must restore that task rather than creating a second one.
    mainView.value = "chat";
    dockPanel.value = "tasks";
    void refreshContext();
  }

  async function newProject() {
    error.value = null;
    const workspace = await selectFolder();
    if (!workspace) return;
    try {
      const project = await ipc.projectCreate(workspace);
      await refreshProjects();
      // 建完把这个目录交给右侧工作台；同时直接在这个空间里开出第一条对话。
      // 用户刚说的是「这个目录是一个空间，我要在里面干活」—— 如果只建空间不
      // 开对话，他接下来按顶部「新对话」得到的是一条没归属的白纸（那个按钮只
      // 认侧栏里被点选的项目），对话会掉进「最近」，正是被抱怨过的断链。
      projectExplorer.value = project;
      await newTaskIn(project.workspace);
    } catch (err) {
      error.value = errText(err);
    }
  }

  /** 面板头部的「选择文件夹」：选完直接落在右侧工作台上，不碰主区与当前空间。 */
  async function pickWorkbenchFolder() {
    const workspace = await selectFolder();
    if (!workspace) return;
    openProjectFolder(workspace);
  }

  /** 删除空间前的确认目标。删空间会连对话一起删，必须先让用户看到范围。 */
  function requestDeleteProject(project: { id: string; name: string; workspace: string }) {
    spaceDeleteTarget.value = { ...project, createdAt: "", updatedAt: "" };
  }

  function requestEditProject(project: ProjectRow) {
    projectEditTarget.value = { ...project };
  }

  async function confirmDeleteProject() {
    const project = spaceDeleteTarget.value;
    if (!project) return;
    spaceDeleteTarget.value = null;
    await deleteProject(project.id);
  }

  /**
   * 改空间的显示名。
   *
   * 只改 `projects.name`：目录不动，所以会话归在哪个空间里不受影响，改完刷一下
   * 空间列表就够了，不用碰 rows / openIds。
   */
  async function renameProject(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    error.value = null;
    try {
      await ipc.projectRename(id, trimmed);
      await refreshProjects();
    } catch (err) {
      error.value = errText(err);
    }
  }

  /**
   * 把空间从列表里撤掉，留下它的对话。
   *
   * 和 `deleteProject` 的分工见 IPC 注释。这里只刷两个列表：会话一行都没动，所以
   * 不需要关标签页 —— 开着的对话照旧开着，只是它现在归在「未归属」那一格。
   */
  async function unlistProject(id: string) {
    error.value = null;
    const project = projects.value.find((item) => item.id === id);
    try {
      await ipc.projectUnlist(id);
      if (projectExplorer.value?.id === id) projectExplorer.value = null;
      await refreshProjects();
      await refreshList();
      // 会话是留着的，只是换了落点。不说这一句，用户会以为它们被删了。
      if (project) {
        notice.value = `已把「${project.name}」从空间列表移除，它的对话保留在「未归属」里。`;
      }
    } catch (err) {
      error.value = errText(err);
    }
  }

  /** 在系统文件管理器里打开目录。目录没了要报一声，不然点了没反应像坏了。 */
  async function revealProject(workspace: string) {
    error.value = null;
    try {
      await ipc.projectReveal(workspace);
    } catch (err) {
      error.value = errText(err);
    }
  }

  /**
   * 删除工作空间，连同它名下的会话。
   *
   * 后端 `project_delete` 会整棵删掉该空间的会话（含子代理会话与消息），所以
   * 这里只需把界面上的痕迹收干净：关掉相关标签页、把当前空间让开。
   */
  async function deleteProject(id: string) {
    const project = projects.value.find((item) => item.id === id);
    if (!project) return;
    error.value = null;
    try {
      await ipc.projectDelete(id, true);
      // 标签页可能开着该空间的会话，包括不在最近 200 条里的那些，所以要按
      // 记录本身判断，而不是按 rows 判断。
      for (const sessionId of [...openIds.value]) {
        const record = records.value[sessionId];
        if (!record) continue;
        if (record.workspace === project.workspace || record.prefs.workspace === project.workspace) {
          await closeTab(sessionId).catch(() => undefined);
        }
      }
      if (projectExplorer.value?.id === id) {
        // 只清掉当前工作空间，面板不关：资源管理器标签会自然退回「选择工作空间」引导。
        projectExplorer.value = null;
      }
      await refreshList();
      await refreshProjects();
    } catch (err) {
      error.value = errText(err);
    }
  }

  async function duplicateTask(id: string) {
    error.value = null;
    const copy = await ipc.sessionDuplicate(id);
    await refreshList();
    await openSession(copy);
  }

  async function send(text: string, mode: "ask" | "plan" | "auto" = "auto", imageUrls: string[] = []): Promise<boolean> {
    const rec = active.value;
    if (!rec || !canSend.value) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    error.value = null;
    const previousUsers = new Set(rec.messages.filter((message) => message.role === "user").map((message) => message.id));
    const localId = `pending_${crypto.randomUUID()}`;
    pendingPrompts.set(rec.id, { id: localId, text: trimmed });
    rec.messages.push({ id: localId, role: "user", text: trimmed, ...(imageUrls.length ? { images: [...imageUrls] } : {}) });
    rec.running = true;
    const beforeMessageTotal = await ipc.sessionExportWindow(rec.id, 0, 1)
      .then((snapshot) => snapshot.totalMessages ?? null)
      .catch(() => null);
    const nextFailures = { ...failedAttempts.value };
    delete nextFailures[rec.id];
    failedAttempts.value = nextFailures;
    const nextProgress = { ...toolGeneration.value };
    delete nextProgress[rec.id];
    toolGeneration.value = nextProgress;
    try {
      if (rec.title === "未命名任务") {
        const title = summarizeTaskTitle(trimmed);
        await ipc.sessionSetTitle(rec.id, title);
        rec.title = title;
      }
      await ipc.sessionPrompt(rec.id, trimmed, mode, imageUrls);
      return true;
    } catch (err) {
      rec.running = false;
      let message = errText(err);
      if (
        rec.prefs.agentEngine === "claude_code"
        && message.includes("502")
        && message.includes("上游连接失败")
        && settings.value?.values["dandelion.defaultBackend"] === "sidecar"
        && settings.value?.values["dandelion.sidecar.listenPort"]
      ) {
        const status = await ipc.sidecarStatus().catch(() => null);
        if (status) sidecar.value = status;
        if (status?.kind === "stopped" || status?.kind === "failed") {
          message += `\n蒲公英本机模型服务未运行（端口 ${settings.value.values["dandelion.sidecar.listenPort"]}）。如果 CC Switch 的上游指向这里，请先到“模型”页面启动服务，再重试任务。`;
        }
      }
      let accepted = rec.messages.some((item) => item.role === "user" && item.id !== localId && item.text === trimmed && !previousUsers.has(item.id));
      if (!accepted && beforeMessageTotal !== null) {
        const snapshot = await ipc.sessionExportWindow(rec.id).catch(() => null);
        accepted = !!snapshot && (snapshot.totalMessages ?? 0) > beforeMessageTotal
          && snapshot.messages.some((item) => item.role === "user" && item.content === trimmed);
      }
      if (accepted) {
        rec.stopReason = "error";
        failedAttempts.value = { ...failedAttempts.value, [rec.id]: { prompt: trimmed, error: message, engineId: rec.prefs.agentEngine || "native", mode, imageUrls } };
        error.value = null;
      } else {
        rec.messages = rec.messages.filter((item) => item.id !== localId);
        if (pendingPrompts.get(rec.id)?.id === localId) pendingPrompts.delete(rec.id);
        error.value = message;
      }
      noteSidecarFail(message);
      if (message.includes("not configured")) {
        info.value = await ipc.runtimeInfo();
      }
      return accepted;
    }
  }

  async function retryFailedPrompt(): Promise<boolean> {
    const failed = failedAttempt.value;
    if (!failed || !canSend.value || running.value || queued.value) return false;
    if (failed.engineId === "claude_code" && failed.error.includes("蒲公英本机模型服务未运行")) {
      try {
        if ((await ipc.sidecarStatus()).kind !== "ready") await ipc.sidecarStart();
        sidecar.value = await ipc.sidecarStatus();
      } catch (err) {
        error.value = errText(err);
        return false;
      }
    }
    return send(failed.prompt, failed.mode, failed.imageUrls);
  }

  async function stop() {
    const rec = active.value;
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    try {
      await ipc.sessionCancel(rec.id);
    } catch (err) {
      rec.stopping = false;
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  function openLiveTerminal(terminalId: string) {
    liveOpenId.value = terminalId;
  }

  function closeLivePane() {
    liveOpenId.value = null;
  }

  async function killLiveTerminal(terminalId: string) {
    const term = terminals.value[terminalId];
    if (!term) return;
    try {
      await ipc.terminalKill(terminalId);
      const current = terminals.value[terminalId];
      if (current) {
        terminals.value = {
          ...terminals.value,
          [terminalId]: { ...current, exited: true, status: "killed" },
        };
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  function summarizeTaskTitle(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    const withoutLead = normalized.replace(/^(请|帮我|麻烦|我要|我想|能否|可以)\s*/u, "");
    const sentence = withoutLead.split(/[。！？!?\n]/u)[0] || withoutLead;
    return Array.from(sentence).slice(0, 24).join("") || "未命名任务";
  }

  async function sendOrCreate(text: string, mode: "ask" | "plan" | "auto" = "auto", imageUrls: string[] = []): Promise<boolean> {
    if (!text.trim() && !imageUrls.length) return false;
    if (!active.value) await newTask();
    return send(text || "请分析附图。", mode, imageUrls);
  }

  async function setPinned(id: string, pinned: boolean) {
    error.value = null;
    try { await ipc.sessionSetPinned(id, pinned); await refreshList(); } catch (err) { error.value = errText(err); }
  }

  async function setArchived(id: string, archived: boolean) {
    error.value = null;
    try { await ipc.sessionSetArchived(id, archived); await refreshList(); } catch (err) { error.value = errText(err); }
  }

  async function selectFolder() {
    try {
      return await ipc.folderPick();
    } catch (err) {
      error.value = errText(err);
      return null;
    }
  }

  /**
   * 给**当前这条对话**指定工作目录。
   *
   * 这里做的事只有一件：改这条对话自己带的工作目录（prefs.workspace）。界面上的
   * 「当前目录」是从当前会话派生出来的，所以这次写入会自然反映到输入框那个 chip
   * 和侧栏它所在的分组上，不需要另外去同步什么状态。
   *
   * 以前这里会顺手 setActiveWorkspace，于是用户在输入框里选个目录，左栏整列对话
   * 会在光标底下被换掉 —— 看起来像「选了个文件夹结果整个界面跳走了」。那个全局态
   * 已经不在了（现在列的是全部会话），这一整类副作用随之消失。
   *
   * 当前会话选择目录就是明确的“归属到项目”操作：目录尚未登记时同步创建项目，
   * 从而让输入框、最近对话标签与项目目录册始终指向同一个对象。
   */
  async function setTaskWorkspace(path: string) {
    let project = projects.value.find((item) => item.workspace === path);
    if (!project) {
      project = await ipc.projectCreate(path);
      await refreshProjects();
    }
    projectExplorer.value = project;
    // 回写一律用项目登记后的规范拼写，而不是目录选择器返回的原始字符串 ——
    // 后端 set_session_prefs 也会再收敛一次，这里是前端能对齐的第一道。
    const workspace = project.workspace;
    // 空屏（还没有活跃会话）里选目录，就是明说「下一条对话在这个目录里开」：
    // 先把空白草稿建出来再落目录，归属才不会静默丢掉。草稿没说过话之前照旧被复用。
    if (!active.value) await newTask();
    if (active.value) await savePrefs({ workspace });
  }

  /** 清掉当前对话的工作目录。同样只动这条对话，不动任何全局的东西。 */
  async function clearTaskWorkspace() {
    if (active.value) await savePrefs({ workspace: "" });
  }

  async function answerPermission(optionId: string) {
    const req = permission.value;
    if (!req) return;
    permissionQueue.value = permissionQueue.value.filter((item) => item.requestId !== req.requestId);
    try {
      await ipc.hostPermissionRespond(req.requestId, optionId);
    } catch (err) {
      permissionQueue.value = [req, ...permissionQueue.value];
      error.value = errText(err);
    }
  }

  async function saveSetup(baseUrl: string, model: string, apiKey: string) {
    const patch: Record<string, unknown> = {
      "dandelion.baseUrl": baseUrl.trim(),
      "dandelion.defaultModel": model.trim(),
    };
    if (apiKey.trim()) {
      patch["dandelion.apiKey"] = apiKey.trim();
    }
    info.value = await ipc.settingsPatch(patch);
    settings.value = await ipc.settingsGet();
  }

  // 工作单 2026-10-19 第二版·条目 6：搜索是异步的，连续敲关键词时先发的那条
  // 可能后回来。没有序号护栏的话，慢的旧查询会把新查询的结果覆盖掉 —— 列表
  // 显示的是用户早就删掉的输入。每次调用领一个号，回来只对号入座。
  let searchSeq = 0;

  async function search(query: string) {
    searchQuery.value = query;
    const q = query.trim();
    const seq = ++searchSeq;
    if (!q) {
      searchHits.value = [];
      return;
    }
    // 搜索全库，不按空间收窄。侧栏现在列的是**全部**会话，搜索要是只搜一格，用户
    // 明明看着列表里的那条却搜不出来。命中项自带 title/snippet，归属从它所在的分组
    // 看得出来，不需要靠收窄搜索来表达。
    try {
      const hits = await ipc.sessionsSearch(q);
      if (seq !== searchSeq) return; // 更新的查询已经发出（或已清空），这份过期
      searchHits.value = hits;
    } catch (err) {
      if (seq !== searchSeq) return;
      error.value = errText(err);
      searchHits.value = [];
    }
  }

  async function confirmDelete() {
    const target = deleteTarget.value;
    if (!target) return;
    deleteTarget.value = null;
    await ipc.sessionDelete(target.id);
    await closeTab(target.id);
    await refreshList();
    await refreshDetached();
  }

  function toggleSelectMode() {
    selectMode.value = !selectMode.value;
    if (!selectMode.value) selectedIds.value = [];
  }

  function toggleSelected(id: string) {
    selectedIds.value = selectedIds.value.includes(id)
      ? selectedIds.value.filter((x) => x !== id)
      : [...selectedIds.value, id];
  }

  function selectAll(ids: string[]) {
    // 全选/全不选按当前可见集合判断，而不是全库 —— 归档区折叠时不该被牵连。
    const every = ids.length > 0 && ids.every((id) => selectedIds.value.includes(id));
    selectedIds.value = every ? [] : [...new Set([...selectedIds.value, ...ids])];
  }

  function requestBulkDelete() {
    const chosen = rows.value.filter((row) => selectedIds.value.includes(row.id));
    if (!chosen.length) return;
    bulkDeleteTargets.value = chosen;
  }

  async function confirmBulkDelete() {
    const targets = bulkDeleteTargets.value;
    if (!targets.length) return;
    bulkDeleteTargets.value = [];
    error.value = null;
    // 没有批量 IPC，逐个调 session_delete。后端本身是级联删除（delete_session_tree），
    // 所以先删父再删子时，子可能已随父消失 —— 那种 SessionNotFound 不算失败，跳过即可。
    const failed: string[] = [];
    for (const target of targets) {
      try {
        await ipc.sessionDelete(target.id);
      } catch (err) {
        const msg = errText(err);
        if (!/not\s*found|不存在/i.test(msg)) failed.push(target.title || target.id);
        continue;
      }
      await closeTab(target.id).catch(() => undefined);
    }
    selectedIds.value = [];
    selectMode.value = false;
    await refreshList();
    await refreshDetached();
    if (failed.length) error.value = `以下任务删除失败：${failed.join("、")}`;
  }

  async function savePrefs(patch: SessionPrefs) {
    const rec = active.value;
    if (!rec) return;
    rec.prefs = { ...rec.prefs, ...patch };
    // `rec.workspace` 是 `prefs.workspace` 的镜像 —— 后端 `set_session_prefs` 会把列同步
    // 写成 prefs 的值，本地这份记录却是从 export 里读的**列**。改了 prefs 不同步它，
    // 界面就会继续按旧列值渲染（`selectedFolder` 有 `|| rec.workspace` 的兜底）：
    // 清工作区那次正是这样，prefs 清了、列没清，点 × 看着没反应。
    if (patch.workspace !== undefined) rec.workspace = patch.workspace;
    await ipc.sessionPrefsSet(rec.id, rec.prefs);
    await refreshList();
    if (patch.workspace !== undefined) {
      void refreshContext();
    }
  }

  async function setSkillIds(ids: string[]) {
    const rec = active.value;
    if (!rec) return;
    const available = skills.value.filter((item) => ids.includes(item.id) && item.enabled && !item.framework);
    const cap = Number(settings.value?.values["dandelion.skills.maxInjectBytes"] ?? 32768);
    const bytes = available.reduce((sum, item) => sum + item.sizeBytes, 0)
      + Math.max(0, available.length - 1) * 2
      + (available.length ? new TextEncoder().encode("已启用技能全文：\n").length : 0);
    if (bytes > cap) {
      panelError.value = `所选技能合计约 ${Math.ceil(bytes / 1024)} KB，超过当前容量。请减少技能或在设置中调整容量。`;
      return;
    }
    const next = available.map((item) => item.id);
    await ipc.sessionReplaceBindings(rec.id, "skill", next);
    rec.skillIds = next;
    panelError.value = null;
  }

  async function setMcpIds(ids: string[]) {
    const rec = active.value;
    if (!rec) return;
    rec.mcpIds = ids;
    await ipc.sessionReplaceBindings(rec.id, "mcp", ids);
  }

  async function setCorpusIds(ids: string[]) {
    const rec = active.value;
    if (!rec) return;
    rec.corpusIds = ids;
    await ipc.sessionReplaceBindings(rec.id, "corpus", ids);
  }

  async function setKnowledgeIds(ids: string[]) {
    const rec = active.value;
    if (!rec) return;
    await ipc.sessionReplaceBindings(rec.id, "knowledge", ids);
    rec.knowledgeIds = ids;
  }

  async function importCorpus() {
    panelError.value = null;
    try {
      const row = await ipc.corpusImportPick();
      if (row) await refreshCatalog();
    } catch (err) {
      panelError.value = errText(err);
    }
  }

  async function deleteCorpus(id: string) {
    panelError.value = null;
    try {
      await ipc.corpusDelete(id);
      const rec = active.value;
      if (rec) {
        rec.corpusIds = rec.corpusIds.filter((x) => x !== id);
        await ipc.sessionReplaceBindings(rec.id, "corpus", rec.corpusIds);
      }
      await refreshCatalog();
    } catch (err) {
      panelError.value = errText(err);
    }
  }

  // Wiki 回写身份闸门：所有异步回写在请求发起时领取 (workspace, 代次, 请求)
  // 三元组，响应时校验；换项目升代次即在途旧请求全体作废（见 lib/wiki-identity）。
  const wikiGate = createWikiGate();

  async function refreshWiki(workspace?: string) {
    const ws = wikiWorkspaceArg(workspace);
    const id = wikiGate.claim(ws ?? "", "status");
    panelError.value = null;
    wikiStatus.value = null;
    try {
      const status = await ipc.wikiStatus(ws);
      if (wikiGate.isCurrent(id)) wikiStatus.value = status;
    } catch (err) {
      if (wikiGate.isCurrent(id)) panelError.value = errText(err);
    }
    void refreshWikiCoverage(workspace);
  }

  function wikiWorkspaceArg(workspace?: string): string | undefined {
    return workspace ?? selectedFolder.value ?? undefined;
  }

  /** `useModel=true` → 深度模型构建（概览＋分主题文章，core 全成或全败）；
   *  false → 确定性快速扫描。构建阶段进度由 bus `_wiki_update` 推送。 */
  async function compileWiki(useModel = true, workspace?: string, incremental = false) {
    panelError.value = null;
    const ws = wikiWorkspaceArg(workspace);
    // 身份在编排开头统一领取，收尾（状态/覆盖刷新）只沿用这些身份校验；
    // 绝不在响应到达时重新领取——晚到的旧构建不能靠"再领一个号"越过
    // 用户的新动作重新获得回写资格。
    await runWikiBuild(wikiGate, ws ?? "", useModel, {
      build: () => ipc.wikiBuildDeep(ws, incremental),
      scan: async () => { await ipc.wikiCompile(ws); },
      status: () => ipc.wikiStatus(ws),
      coverage: () => ipc.wikiCoverage(ws),
      writeReport: (report) => { wikiBuildReport.value = report; },
      // 失败/取消：core 已记录具体阶段和原因（status.lastBuildError），
      // 上一版文章保持可读——这里只做展示，不掩盖真实错误。
      writeError: (err) => { panelError.value = errText(err); },
      writeStatus: (status) => { wikiStatus.value = status; },
      writeCoverage: (coverage) => { wikiCoverage.value = coverage; },
    });
  }

  /** 叫停本项目进行中的深度构建；true = 请求已送达（构建在下一个边界停下）。 */
  async function cancelWikiBuild(workspace?: string): Promise<boolean> {
    return ipc.wikiBuildCancel(wikiWorkspaceArg(workspace));
  }

  // 覆盖报告独立 kind：切项目连点时，先发的旧项目请求可能后到，
  // 没有身份守卫就会把旧项目的覆盖数据盖在新项目头上。
  async function refreshWikiCoverage(workspace?: string) {
    const ws = wikiWorkspaceArg(workspace);
    const id = wikiGate.claim(ws ?? "", "coverage");
    try {
      const cov = await ipc.wikiCoverage(ws);
      if (wikiGate.isCurrent(id)) wikiCoverage.value = cov;
    } catch { if (wikiGate.isCurrent(id)) wikiCoverage.value = null; }
  }

  // —— Wiki 草稿引导（无项目会话）——
  // 后端是草稿的唯一真相：resolve/cancel 都走 Runtime 命令（目录校验、项目
  // 登记、会话绑定、重新提交全在宿主侧完成，且幂等）。前端只管展示与失效。

  async function refreshWikiDrafts(id: string) {
    try {
      const drafts = await ipc.wikiDrafts(id);
      wikiDrafts.value = { ...wikiDrafts.value, [id]: drafts };
    } catch {
      /* 没有草稿目录是常态 */
    }
  }

  function dropWikiDraft(sessionId: string, draftId: string) {
    wikiDrafts.value = {
      ...wikiDrafts.value,
      [sessionId]: (wikiDrafts.value[sessionId] ?? []).filter((draft) => draft.draftId !== draftId),
    };
  }

  /** 完成引导：成功后草稿从展示态移除，会话工作区就地更新。失败抛错文本由卡片展示。 */
  async function resolveWikiDraft(
    draft: WikiDraft,
    payload: { mode: "project" | "directory" | "new"; projectId?: string; path?: string; parent?: string; name?: string; publish?: boolean },
  ): Promise<WikiDraftOutcome> {
    const outcome = await ipc.wikiResolveDraft({ draftId: draft.draftId, ...payload });
    dropWikiDraft(draft.sessionId, draft.draftId);
    notice.value = outcome.status === "accepted" ? "项目已绑定，知识已写入 Wiki，可在知识页面查看。" : "知识已提交到项目 Wiki，等待审核。";
    const rec = records.value[draft.sessionId];
    if (rec) {
      rec.workspace = outcome.workspace;
      void refreshProjects();
      void refreshList();
    }
    return outcome;
  }

  async function cancelWikiDraft(draft: WikiDraft) {
    try {
      await ipc.wikiCancelDraft(draft.draftId);
    } catch {
      /* 可能已被另一个窗口处理；展示态照样移除，下次打开以后端为准 */
    }
    dropWikiDraft(draft.sessionId, draft.draftId);
  }

  async function openWikiDir(workspace?: string) {
    panelError.value = null;
    try {
      await ipc.wikiOpenDir(workspace ?? selectedFolder.value ?? undefined);
    } catch (err) {
      panelError.value = errText(err);
    }
  }

  /** 从一条对话中提炼知识条目进 Wiki；后端会自动重编译,这里只刷新状态。返回新增条数。 */
  async function distillWiki(sessionId: string, workspace?: string) {
    panelError.value = null;
    const ws = wikiWorkspaceArg(workspace);
    const id = wikiGate.claim(ws ?? "", "status");
    try {
      const added = await ipc.wikiDistill(sessionId, ws);
      const status = await ipc.wikiStatus(ws);
      if (wikiGate.isCurrent(id)) wikiStatus.value = status;
      return added;
    } catch (err) {
      if (wikiGate.isCurrent(id)) panelError.value = errText(err);
      return null;
    }
  }

  async function setWikiProfile(profile: import("../lib/types").WikiProfile, workspace?: string) {
    panelError.value = null;
    try {
      await ipc.wikiSetProfile(profile, workspace ?? selectedFolder.value ?? undefined);
      return true;
    } catch (err) {
      panelError.value = errText(err);
      return false;
    }
  }

  async function wikiShow(page?: string, workspace?: string) {
    panelError.value = null;
    try {
      return await ipc.wikiShow(page, workspace ?? selectedFolder.value ?? undefined);
    } catch (err) {
      panelError.value = errText(err);
      return [];
    }
  }

  async function wikiSearch(query: string) {
    panelError.value = null;
    try {
      return await ipc.wikiSearch(query, selectedFolder.value ?? undefined);
    } catch (err) {
      panelError.value = errText(err);
      return [];
    }
  }

  async function wikiAsk(question: string, workspace?: string) {
    panelError.value = null;
    try {
      return await ipc.wikiAsk(question, workspace ?? selectedFolder.value ?? undefined);
    } catch (err) {
      panelError.value = errText(err);
      return null;
    }
  }

  async function specStart(mode: string, text: string, sessionId?: string) {
    panelError.value = null;
    try {
      return await ipc.specStart(mode, text, sessionId);
    } catch (err) {
      panelError.value = errText(err);
      return null;
    }
  }

  async function specShow(specId: string) {
    panelError.value = null;
    try {
      return await ipc.specShow(specId);
    } catch (err) {
      panelError.value = errText(err);
      return null;
    }
  }

  async function specDiff(specId: string) {
    panelError.value = null;
    try {
      return await ipc.specDiff(specId);
    } catch (err) {
      panelError.value = errText(err);
      return null;
    }
  }

  async function specApprove(specId: string) {
    panelError.value = null;
    try {
      return await ipc.specApprove(specId);
    } catch (err) {
      panelError.value = errText(err);
      return null;
    }
  }

  async function specRevise(specId: string, text: string) {
    panelError.value = null;
    try {
      return await ipc.specRevise(specId, text);
    } catch (err) {
      panelError.value = errText(err);
      return null;
    }
  }

  async function specRun(specId: string, text?: string) {
    panelError.value = null;
    try {
      return await ipc.specRun(specId, text);
    } catch (err) {
      panelError.value = errText(err);
      return "";
    }
  }

  function toggleDock(id: DockId) {
    panelError.value = null;
    dockPanel.value = dockPanel.value === id ? null : id;
    if (dockPanel.value) mainView.value = "chat";
  }

  function openDock(id: DockId) {
    panelError.value = null;
    dockPanel.value = id;
    mainView.value = "chat";
  }

  function openGit() {
    panelError.value = null;
    dockPanel.value = "git";
    mainView.value = "chat";
  }

  function openFeature(view: FeatureView) {
    // 只有从对话主区打开才值得记返回点：已经在特性页里互相跳时，
    // 再记一次当前特性页会让「返回」原地打转。
    if (mainView.value === "chat") {
      featureReturn.value = {
        dock: dockPanel.value,
      };
    }
    panelError.value = null;
    dockPanel.value = null;
    mainView.value = view;
  }

  function returnFromFeature() {
    // 资源管理器已不在 mainView 里，特性页只需还原打开它的那块侧栏。
    mainView.value = "chat";
    dockPanel.value = featureReturn.value.dock ?? "tasks";
    void refreshContext();
  }

  function openPlugins() {
    openFeature("plugins");
    void refreshCatalog();
  }

  function openCorpus() {
    // Task materials are a task-configuration workflow, not a second
    // top-level knowledge product. They remain reachable from that config.
    openFeature("corpus");
    void refreshCatalog();
  }

  function openMemory() {
    openFeature("memory");
  }
  function openKnowledge() {
    openFeature("knowledge");
  }

  function openGitReview(target: GitReviewTarget) {
    gitReview.value = target;
    mainView.value = "gitReview";
  }

  // 工作台开关。工具选择写回 localStorage，下次开面板直接回到上次那个。
  function selectWorkbenchTool(tool: WorkbenchTool | null) {
    workbenchTool.value = tool;
    try {
      if (tool) window.localStorage.setItem(WORKBENCH_TOOL_KEY, tool);
      else window.localStorage.removeItem(WORKBENCH_TOOL_KEY);
    } catch {
      // 记不住就只活在本次会话，不影响开关本身。
    }
  }

  // persist=false 给拖拽过程用：一次拖拽会触发上百次宽度变化，
  // 每次都写 localStorage 是白费；松手时再以默认参数写一次即可。
  function setWorkbenchWidth(width: number, persist = true) {
    workbenchWidth.value = clampWorkbenchWidth(width);
    if (!persist) return;
    try {
      window.localStorage.setItem(WORKBENCH_WIDTH_KEY, String(workbenchWidth.value));
    } catch {
      // 同上：宽度记不住只影响下次启动的初始值。
    }
  }

  // 左栏分栏宽度。与工作台同理：拖动过程 persist=false，松手才落盘。
  // 这里比工作台多一层 clamp —— 窗口变窄后要把旧的宽度收回来，光靠 CSS 的
  // flex 收缩会让「拖出来的宽度」和「记下来的宽度」对不上。
  function setSidebarWidth(width: number, persist = true) {
    const next = clampSidebarWidth(width);
    sidebarWidth.value = next;
    if (!persist) return;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
    } catch {
      // 同上：宽度记不住只影响下次启动的初始值。
    }
  }

  function openWorkbench(tool: WorkbenchTool | null = workbenchTool.value) {
    if (tool) selectWorkbenchTool(tool);
    workbenchVisible.value = true;
  }

  function closeWorkbench() {
    workbenchVisible.value = false;
  }

  function toggleWorkbench() {
    if (workbenchVisible.value) closeWorkbench();
    else openWorkbench();
  }

  function openProjectExplorer(project: ProjectExplorerTarget) {
    projectExplorer.value = project;
    // 资源管理器从整页搬进右侧工作台：主区对话必须留在原地，
    // 否则「边看文件边问」这个用法就断了。
    openWorkbench("explorer");
  }

  /**
   * 打开某个目录的资源管理器视图。
   *
   * **不建空间。** 「文件菜单 → 打开文件夹」「工作台 → 选择工作区」「资源管理器
   * → 添加文件夹」都走这里，它们要的是一个能看文件的目录，不是一个归属单位。
   * 之前这里会 projectCreate，于是这些入口每用一次就在空间列表里留下一个目录，
   * 空间列表变成了「浏览记录」。
   */
  function openProjectFolder(workspace: string) {
    const existing = projects.value.find((project) => project.workspace === workspace);
    // 资源管理器只用到 workspace 路径，id 与名称纯显示，所以没有项目记录时用
    // 一个无 id 的临时目标，不落库。
    openProjectExplorer(existing ?? { id: "", name: workspaceLabel(workspace), workspace });
  }

  function closeGitReview() {
    gitReview.value = null;
    mainView.value = "chat";
  }

  function openCron() {
    openFeature("cron");
    void refreshCron();
  }

  async function openSettings(section = "common") {
    panelError.value = null;
    if (section === "models" && (mainView.value !== "settings" || !["models", "providers"].includes(settingsSection.value))) {
      const backend = String(settings.value?.values["dandelion.defaultBackend"] ?? "sidecar");
      if (backend !== "sidecar") section = "providers";
    }
    if (mainView.value !== "settings") settingsReturnView.value = mainView.value;
    settingsSection.value = section;
    settingsTabOpen.value = true;
    mainView.value = "settings";
    // Settings is an exclusive main workspace. It must not leave an unrelated
    // settings summary beside a chat after the user returns to a feature.
    dockPanel.value = null;
    if (section === "json" && !jsonDirty.value) {
      await loadSettingsJson();
    }
  }

  function focusSettings() {
    mainView.value = "settings";
    dockPanel.value = null;
  }

  function closeSettings() {
    settingsTabOpen.value = false;
    dockPanel.value = null;
    const target = settingsReturnView.value;
    mainView.value = target === "gitReview" && !gitReview.value ? "chat" : target;
    if (mainView.value === "chat") void refreshContext();
  }

  function focusSession(id: string) {
    activeId.value = id;
    mainView.value = "chat";
    dockPanel.value = "tasks";
    void refreshContext();
  }

  async function loadSettingsJson() {
    jsonError.value = null;
    jsonDraft.value = await ipc.settingsJson();
    jsonDirty.value = false;
  }

  async function patchSettings(patch: Record<string, unknown>) {
    panelError.value = null;
    try {
      const next = { ...patch };
      const current = settings.value?.values ?? {};
      const currentBackend = String(current["dandelion.defaultBackend"] ?? "");
      if (next["dandelion.defaultBackend"] === "sidecar" && ["openai_compat", "openai_responses", "ollama", "vllm"].includes(currentBackend)) {
        if (!current["dandelion.service.backend"] && next["dandelion.service.backend"] === undefined) next["dandelion.service.backend"] = currentBackend;
        if (!current["dandelion.service.model"] && next["dandelion.service.model"] === undefined && current["dandelion.defaultModel"]) next["dandelion.service.model"] = current["dandelion.defaultModel"];
      }
      info.value = await ipc.settingsPatch(next);
      settings.value = await ipc.settingsGet();
      if (mainView.value === "settings" && !jsonDirty.value) {
        jsonDraft.value = await ipc.settingsJson();
      }
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function saveSettingsJson() {
    jsonError.value = null;
    panelError.value = null;
    try {
      info.value = await ipc.settingsPutJson(jsonDraft.value);
      settings.value = await ipc.settingsGet();
      jsonDraft.value = await ipc.settingsJson();
      jsonDirty.value = false;
    } catch (err) {
      jsonError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function probeProvider(baseUrl?: string, apiKey?: string) {
    return ipc.providerProbe(baseUrl, apiKey);
  }

  // —— 模型服务 profile：历史地址的增删改与切换（地址列表存 settings，密钥各自存 CredentialStore）——

  const providerProfiles = computed(() => parseProviderProfiles(settings.value?.values ?? {}));

  /** 当前新任务默认正在使用哪条已保存的服务连接（本机模型默认时为 null）。 */
  const activeProviderProfile = computed(() => {
    const values = settings.value?.values ?? {};
    if (String(values["dandelion.defaultBackend"] ?? "") === "sidecar") return null;
    const backend = String(values["dandelion.defaultBackend"] ?? "");
    const model = String(values["dandelion.defaultModel"] ?? "").trim();
    const baseUrl = String(values["dandelion.baseUrl"] ?? "").trim();
    if (!model || !baseUrl) return null;
    return providerProfiles.value.find(
      (p) => p.backend === backend && p.model === model && p.baseUrl === baseUrl,
    ) ?? null;
  });

  async function writeProviderProfiles(profiles: ProviderProfile[]) {
    await patchSettings({ [PROVIDER_PROFILES_KEY]: profiles });
  }

  /** 新增或更新一条服务连接；历史列表只增改不隐式清空。 */
  async function upsertProviderProfile(profile: ProviderProfile): Promise<boolean> {
    panelError.value = null;
    const list = [...providerProfiles.value];
    const index = list.findIndex((p) => p.id === profile.id);
    if (index >= 0) list[index] = profile;
    else list.push(profile);
    await writeProviderProfiles(list);
    return !panelError.value;
  }

  async function removeProviderProfile(id: string): Promise<boolean> {
    panelError.value = null;
    await writeProviderProfiles(providerProfiles.value.filter((p) => p.id !== id));
    if (panelError.value) return false;
    try {
      await ipc.providerKeyForget(id);
    } catch {
      // 地址已删，残留密钥不再被引用；不反删一次不阻塞删除操作。
    }
    return true;
  }

  /** 把新任务默认切到这条服务连接：热应用全局设置，并把它保存的密钥放进生效配置。 */
  async function applyProviderProfile(id: string): Promise<boolean> {
    panelError.value = null;
    const profile = providerProfiles.value.find((p) => p.id === id);
    if (!profile) return false;
    let key: string | null = null;
    try {
      key = await ipc.providerKeyReveal(id);
    } catch (err) {
      panelError.value = errText(err);
      return false;
    }
    await patchSettings({
      "dandelion.defaultBackend": profile.backend,
      "dandelion.defaultModel": profile.model,
      "dandelion.baseUrl": profile.baseUrl,
      "dandelion.service.backend": profile.backend,
      "dandelion.service.model": profile.model,
      "dandelion.apiKey": key?.trim() ? key.trim() : null,
    });
    return !panelError.value;
  }

  /** 把新任务默认切到某个本机模型；推理服务原本在跑时跟随重启生效。 */
  async function switchToLocalModel(id: string): Promise<boolean> {
    panelError.value = null;
    const model = localModels.value.find((m) => m.id === id);
    if (!model) return false;
    const wasActive = !!model.active;
    const wasRunning = sidecar.value?.kind === "ready";
    if (!wasActive) {
      await activateModel(id);
      if (panelError.value) return false;
    }
    await patchSettings({ "dandelion.defaultBackend": "sidecar", "dandelion.defaultModel": id });
    if (!wasActive && wasRunning && !panelError.value) await startSidecar();
    return !panelError.value;
  }

  /** 老版本只有一个服务地址：首次进入时把它登记为 profile，历史配置不丢。 */
  async function ensureProviderProfilesSeeded() {
    const values = settings.value?.values ?? {};
    if (providerProfiles.value.length) return;
    const baseUrl = String(values["dandelion.baseUrl"] ?? "").trim();
    const defaultBackend = String(values["dandelion.defaultBackend"] ?? "openai_compat");
    const model = String(values["dandelion.service.model"] ?? (defaultBackend === "sidecar" ? "" : values["dandelion.defaultModel"] ?? "")).trim();
    if (!baseUrl || !model) return;
    const backendRaw = String(values["dandelion.service.backend"] ?? (defaultBackend === "sidecar" ? "" : defaultBackend));
    if (!SERVICE_BACKENDS.includes(backendRaw)) return;
    const profile: ProviderProfile = { id: "default", name: model, backend: backendRaw, baseUrl, model };
    await writeProviderProfiles([profile]);
    if (panelError.value) return;
    if (settings.value?.apiKeySet) {
      try {
        const key = await ipc.settingsApiKeyReveal();
        if (key) await ipc.providerKeyPut(profile.id, key);
      } catch {
        // 旧密钥没能复制过来时，用户在编辑里重填一次即可；不阻塞引导。
      }
    }
  }

  async function openContextBadge() {
    await refreshContext();
    contextOpen.value = true;
  }

  async function importSkill(folder: boolean) {
    panelError.value = null;
    try {
      const item = await ipc.skillsImportPick(folder);
      if (item) await refreshCatalog();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function setSkillEnabled(id: string, enabled: boolean) {
    panelError.value = null;
    try {
      await ipc.skillsSetEnabled(id, enabled);
      await refreshCatalog();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function openSkill(id: string) {
    panelError.value = null;
    try {
      await ipc.skillsOpen(id);
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function removeSkill(id: string) {
    panelError.value = null;
    try {
      await ipc.skillsRemove(id);
      await refreshCatalog();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function installSkillFromUrl(url: string) {
    panelError.value = null;
    installNotes.value = [];
    try {
      const report = await ipc.skillsInstallUrl(url);
      installNotes.value = [
        ...report.notes,
        `${report.items.map((i) => i.id).join(", ")} 已安装但未启用：看过正文后再启用`,
      ];
      await refreshCatalog();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function installSkillFromGit(url: string, subdir?: string | null) {
    panelError.value = null;
    installNotes.value = [];
    try {
      const report = await ipc.skillsInstallGit(url, subdir);
      installNotes.value = [
        ...report.notes,
        `${report.items.map((i) => i.id).join(", ")} 已安装但未启用：看过正文后再启用`,
      ];
      await refreshCatalog();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function searchRegistry(query: string, append = false) {
    panelError.value = null;
    registryBusy.value = true;
    try {
      const cursor = append ? registryCursor.value : null;
      const page = await ipc.registryMcpSearch(query, cursor);
      registryQuery.value = query;
      registryResults.value = append
        ? [...registryResults.value, ...page.entries]
        : page.entries;
      registryCursor.value = page.nextCursor ?? null;
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    } finally {
      registryBusy.value = false;
    }
  }

  async function installFromRegistry(name: string, version?: string | null) {
    panelError.value = null;
    installNotes.value = [];
    registryBusy.value = true;
    try {
      const plan = await ipc.registryMcpInstall(name, version);
      const needs = plan.missingEnv.map(
        (e) => `${e.name}${e.secret ? "（密钥）" : ""}：${e.description}`,
      );
      installNotes.value = [...plan.notes, ...needs];
      await refreshCatalog();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    } finally {
      registryBusy.value = false;
    }
  }

  async function exportSkill(id: string) {
    panelError.value = null;
    try {
      await ipc.skillsExportPick(id);
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function addSandboxRoot() {
    panelError.value = null;
    try {
      await ipc.sandboxAddPick();
      sandbox.value = await ipc.sandboxRoots();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function addSandboxPath(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return;
    panelError.value = null;
    try {
      await ipc.sandboxAddRoot(trimmed);
      sandbox.value = await ipc.sandboxRoots();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function removeSandboxRoot(path: string) {
    panelError.value = null;
    await ipc.sandboxRemoveRoot(path);
    sandbox.value = await ipc.sandboxRoots();
  }

  async function applySandboxToTask(path: string) {
    await savePrefs({ workspace: path });
  }

  async function startMcp(id: string) {
    panelError.value = null;
    try {
      await ipc.mcpStart(id);
      await refreshCatalog();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function stopMcp(id: string) {
    panelError.value = null;
    try {
      await ipc.mcpStop(id);
      await refreshCatalog();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function upsertMcp(server: import("../lib/types").McpServerConfig) {
    panelError.value = null;
    try {
      await ipc.mcpUpsert(server);
      await refreshCatalog();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function removeMcp(id: string) {
    panelError.value = null;
    try {
      await ipc.mcpRemove(id);
      await refreshCatalog();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function refreshCron() {
    try {
      cronJobs.value = await ipc.cronList();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function addCron(input: { expr: string; prompt: string; missedPolicy?: string }) {
    panelError.value = null;
    try {
      await ipc.cronAdd(input);
      await refreshCron();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  /** 每次执行开一条独立会话，跑完直接打开它——否则点了「立即运行」界面毫无反应。 */
  async function runCron(id: string) {
    panelError.value = null;
    try {
      const sessionId = await ipc.cronRunNow(id);
      await refreshCron();
      await refreshList();
      if (sessionId) await openSession(sessionId);
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function cronRuns(id: string, limit = 20) {
    return ipc.cronRuns(id, limit);
  }

  async function stopCron(id: string) {
    panelError.value = null;
    try {
      await ipc.cronStopCurrent(id);
      await refreshList();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function pauseCron(id: string) {
    await ipc.cronPause(id);
    await refreshCron();
  }

  async function resumeCron(id: string) {
    await ipc.cronResume(id);
    await refreshCron();
  }

  async function removeCron(id: string) {
    await ipc.cronRemove(id);
    await refreshCron();
  }

  async function refreshMemory() {
    panelError.value = null;
    try {
      memoryFiles.value = await ipc.memoryFiles();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function saveMemory(kind: "soul" | "user" | "memory", body: string) {
    panelError.value = null;
    try {
      await ipc.memorySet(kind, body);
      await refreshMemory();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function openMemoryDir() {
    panelError.value = null;
    try {
      await ipc.memoryOpenDir();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function openHooksDir() {
    panelError.value = null;
    try {
      await ipc.hooksOpenDir();
    } catch (err) {
      panelError.value = err instanceof Error ? err.message : String(err);
    }
  }

  function viewTree() {
    openDock("tasks");
    treeFocusSeq.value += 1;
  }

  async function promptParent(id: string) {
    const row = rows.value.find((r) => r.id === id);
    const parent = row?.parentId || id;
    await openSession(parent);
    mainView.value = "chat";
  }

  async function stopTree(id: string) {
    const row = rows.value.find((r) => r.id === id);
    const rootId = row?.parentId || id;
    error.value = null;
    try {
      await ipc.sessionCancel(rootId);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function exportActive() {
    const rec = active.value;
    if (!rec) return null;
    return ipc.sessionExportSave(rec.id);
  }

  function noteSidecarFail(msg: string) {
    if (msg.includes("sidecar vram:")) {
      const recommend = msg.match(/recommend (\S+)/)?.[1];
      sidecarFail.value = { kind: "vram", message: msg, recommend };
      void openSettings("models");
      return;
    }
    if (msg.includes("sidecar start:")) {
      sidecarFail.value = { kind: "start", message: msg };
      void openSettings("models");
      void refreshSidecarLogs();
    }
  }

  async function refreshSidecar() {
    try {
      sidecar.value = await ipc.sidecarStatus();
      localModels.value = await ipc.localModels();
    } catch (err) {
      panelError.value = errText(err);
    }
  }

  async function refreshHardware() {
    try {
      hardware.value = await ipc.hardwareProbe();
    } catch (err) {
      panelError.value = errText(err);
    }
  }

  async function refreshSidecarLogs() {
    try {
      sidecarLogs.value = await ipc.sidecarLogs();
    } catch {
      sidecarLogs.value = "";
    }
  }

  async function startSidecar() {
    panelError.value = null;
    sidecarFail.value = null;
    try {
      await ipc.sidecarStart();
      await refreshSidecar();
      const activeModel = localModels.value.find((model) => model.active);
      await patchSettings({ "dandelion.defaultBackend": "sidecar", ...(activeModel ? { "dandelion.defaultModel": activeModel.id } : {}) });
      info.value = await ipc.runtimeInfo();
      await refreshSidecar();
    } catch (err) {
      const msg = errText(err);
      panelError.value = msg;
      noteSidecarFail(msg);
      await refreshSidecar();
      await refreshSidecarLogs();
    }
  }

  async function stopSidecar() {
    await ipc.sidecarStop();
    await refreshSidecar();
  }

  async function restartSidecar() {
    panelError.value = null;
    try {
      await ipc.sidecarRestart();
      await refreshSidecar();
    } catch (err) {
      const msg = errText(err);
      panelError.value = msg;
      noteSidecarFail(msg);
      await refreshSidecarLogs();
    }
  }

  async function importGguf() {
    panelError.value = null;
    try {
      const row = await ipc.localModelImportPick();
      if (row) await refreshSidecar();
    } catch (err) {
      panelError.value = errText(err);
    }
  }

  async function importMlx() {
    panelError.value = null;
    try {
      const row = await ipc.localModelImportMlxPick();
      if (row) await refreshSidecar();
    } catch (err) {
      panelError.value = errText(err);
    }
  }

  async function importMlxPath(path: string): Promise<boolean> {
    panelError.value = null;
    try {
      await ipc.localModelImportMlxPath(path);
      await refreshSidecar();
      return true;
    } catch (err) {
      panelError.value = errText(err);
      return false;
    }
  }

  async function installMlxRunner() {
    panelError.value = null;
    try {
      await ipc.mlxRunnerInstall();
      await refreshSidecar();
    } catch (err) {
      panelError.value = errText(err);
    }
  }

  async function downloadModelscope(repoId: string, filePath: string) {
    panelError.value = null;
    try {
      await ipc.localModelDownloadModelscope(repoId, filePath);
      await refreshSidecar();
      settings.value = await ipc.settingsGet();
    } catch (err) {
      panelError.value = errText(err);
    }
  }

  async function deleteModel(id: string) {
    panelError.value = null;
    try {
      await ipc.localModelDelete(id);
      await refreshSidecar();
    } catch (err) {
      panelError.value = errText(err);
    }
  }

  async function verifyModel(id: string) {
    panelError.value = null;
    try {
      await ipc.localModelVerify(id);
      await refreshSidecar();
    } catch (err) {
      panelError.value = errText(err);
    }
  }

  async function activateModel(id: string) {
    panelError.value = null;
    try {
      const current = settings.value?.values ?? {};
      const currentBackend = String(current["dandelion.defaultBackend"] ?? "");
      if (["openai_compat", "openai_responses", "ollama", "vllm"].includes(currentBackend) && (!current["dandelion.service.backend"] || !current["dandelion.service.model"])) {
        await patchSettings({
          ...(!current["dandelion.service.backend"] ? { "dandelion.service.backend": currentBackend } : {}),
          ...(!current["dandelion.service.model"] && current["dandelion.defaultModel"] ? { "dandelion.service.model": current["dandelion.defaultModel"] } : {}),
        });
        if (panelError.value) return;
      }
      await ipc.localModelActivate(id);
      settings.value = await ipc.settingsGet();
      await refreshSidecar();
    } catch (err) {
      panelError.value = errText(err);
    }
  }

  async function useOllamaInstead() {
    sidecarFail.value = null;
    await patchSettings({ "dandelion.defaultBackend": "ollama" });
    await openSettings("providers");
  }

  function dismissSidecarFail() {
    sidecarFail.value = null;
  }

  function quantNorm(q: string): string {
    return q.replace(/-/g, "_").toUpperCase();
  }

  function modelMatchesQuant(model: LocalModel, rec: string): boolean {
    const a = quantNorm(model.quant);
    const b = quantNorm(rec);
    return a === b || a.includes(b) || b.includes(a);
  }

  async function applyRecommendQuant() {
    const rec = sidecarFail.value?.recommend;
    sidecarFail.value = null;
    await openSettings("models");
    if (!rec) {
      panelError.value = "没有推荐量化档。请导入更小的 GGUF。不会杀掉其他 Tab。";
      return;
    }
    await patchSettings({ "dandelion.recommendQuant": rec });
    await refreshSidecar();
    const hit = localModels.value.find((m) => m.sha256Ok && modelMatchesQuant(m, rec));
    if (!hit) {
      panelError.value = `没有已导入的 ${rec} 权重。请在本页导入该量化档后再启动 sidecar。不会杀掉其他 Tab。`;
      return;
    }
    await activateModel(hit.id);
    await startSidecar();
  }

  return {
    info,
    settings,
    error,
    failedAttempt,
    activeToolGeneration,
    permission,
    permissionQueueLength,
    permissionToolInputs,
    records,
    openIds,
    activeId,
    pendingOpenId,
    rows,
    projects,
    searchQuery,
    searchHits,
    configOpen,
    deleteTarget,
    selectMode,
    selectedIds,
    bulkDeleteTargets,
    toggleSelectMode,
    toggleSelected,
    selectAll,
    requestBulkDelete,
    confirmBulkDelete,
    skills,
    agentPlugins,
    mcpServers,
    registryResults,
    registryCursor,
    registryBusy,
    registryQuery,
    installNotes,
    corpusDocs,
    knowledgeSpaces,
    wikiStatus,
    dockPanel,
    mainView,
    gitReview,
    projectExplorer,
    activeWorkspace,
    spaceDeleteTarget,
    emptySpaceTarget,
    notice,
    workbenchVisible,
    workbenchTool,
    workbenchWidth,
    sidebarWidth,
    surface,
    detached,
    detachedIds,
    settingsTabOpen,
    settingsSection,
    settingsQuery,
    treeFocusSeq,
    jsonDraft,
    jsonDirty,
    jsonError,
    contextOpen,
    contextStatus,
    sandbox,
    panelError,
    cronJobs,
    memoryFiles,
    terminals,
    liveOpenId,
    selectedFolder,
    workspaceOpen,
    hardware,
    localModels,
    sidecar,
    sidecarLogs,
    sidecarFail,
    runState,
    setupOpen,
    listLimit,
    active,
    sessionId,
    sessionTitle,
    messages,
    running,
    queued,
    stopping,
    stopReason,
    readOnly,
    canSend,
    tree,
    archivedRoots,
    spaceGroups,
    hasMore,
    boot,
    newTask,
    returnToConversation,
    returnFromFeature,
    newProject,
    newTaskIn,
    deleteProject,
    renameProject,
    unlistProject,
    revealProject,
    requestDeleteProject,
    projectEditTarget,
    requestEditProject,
    confirmDeleteProject,
    pickWorkbenchFolder,
    openSpacesPage,
    notifyInaccessibleProjects,
    previewEmptyProjects,
    confirmPruneEmptyProjects,
    openSession,
    // 带成功/失败返回值的打开入口（openSession 是它的 void 包装）：宿主与测试
    // 需要知道这次点击最终有没有赢。
    tryOpenSession,
    loadOlderMessages,
    closeTab,
    detachSession,
    duplicateTask,
    setPinned,
    setArchived,
    sendOrCreate,
    send,
    retryFailedPrompt,
    stop,
    openLiveTerminal,
    refreshBackgroundProcesses,
    // 条目 7 的回归入口：测试直接喂 terminal_output_chunk，验证长时间输出下
    // rec.text 有上限。生产路径仍只由 applyFrame 调用。
    applyLiveUpdate,
    closeLivePane,
    killLiveTerminal,
    selectFolder,
    setTaskWorkspace,
    clearTaskWorkspace,
    answerPermission,
    saveSetup,
    search,
    confirmDelete,
    savePrefs,
    setSkillIds,
    setMcpIds,
    setCorpusIds,
    setKnowledgeIds,
    toggleDock,
    openDock,
    openGit,
    openPlugins,
    openCorpus,
    openMemory,
    openKnowledge,
    openGitReview,
    openProjectExplorer,
    selectWorkbenchTool,
    setWorkbenchWidth,
    setSidebarWidth,
    openWorkbench,
    closeWorkbench,
    toggleWorkbench,
    openProjectFolder,
    closeGitReview,
    openCron,
    openSettings,
    closeSettings,
    focusSettings,
    focusSession,
    patchSettings,
    saveSettingsJson,
    loadSettingsJson,
    probeProvider,
    providerProfiles,
    activeProviderProfile,
    upsertProviderProfile,
    removeProviderProfile,
    applyProviderProfile,
    switchToLocalModel,
    ensureProviderProfilesSeeded,
    openContextBadge,
    refreshContext,
    importSkill,
    setSkillEnabled,
    openSkill,
    exportSkill,
    removeSkill,
    installSkillFromUrl,
    installSkillFromGit,
    searchRegistry,
    installFromRegistry,
    addSandboxRoot,
    addSandboxPath,
    removeSandboxRoot,
    applySandboxToTask,
    startMcp,
    stopMcp,
    upsertMcp,
    removeMcp,
    exportActive,
    refreshList,
    refreshProjects,
    refreshCatalog,
    // 暴露给测试与诊断：lag 事件到重同步的接线（listenBus 里的
    // "bus-lagged" 监听）以外，重同步本身也要可独立驱动。
    resyncAfterLag,
    refreshAgentPlugins,
    installAgentPlugin,
    connectAgentPlugin,
    setAgentPluginModel,
    uninstallAgentPlugin,
    stopAgentPlugin,
    refreshKnowledgeSpaces,
    refreshCron,
    addCron,
    runCron,
    cronRuns,
    stopCron,
    pauseCron,
    resumeCron,
    removeCron,
    refreshMemory,
    saveMemory,
    openMemoryDir,
    openHooksDir,
    viewTree,
    promptParent,
    stopTree,
    refreshSidecar,
    refreshHardware,
    refreshSidecarLogs,
    startSidecar,
    stopSidecar,
    restartSidecar,
    importGguf,
    importMlx,
    importMlxPath,
    installMlxRunner,
    downloadModelscope,
    deleteModel,
    verifyModel,
    activateModel,
    importCorpus,
    deleteCorpus,
    refreshWiki,
    compileWiki,
    cancelWikiBuild,
    refreshWikiCoverage,
    wikiBuildReport,
    wikiCoverage,
    wikiDrafts,
    wikiCompile,
    refreshWikiDrafts,
    resolveWikiDraft,
    cancelWikiDraft,
    openWikiDir,
    distillWiki,
    setWikiProfile,
    wikiShow,
    wikiSearch,
    wikiAsk,
    specStart,
    specShow,
    specDiff,
    specApprove,
    specRevise,
    specRun,
    useOllamaInstead,
    dismissSidecarFail,
    applyRecommendQuant,
    teardownListeners,
  };
});

// 开发期热更新。
//
// 必须用 Pinia 的 acceptHMRUpdate，不能用裸 import.meta.hot.accept：裸 accept 只是
// 换掉模块，不会把新的 store 定义应用到**已经存在的** store 实例上，于是页面上的
// 组件继续持有旧实例 —— 旧的 computed 配上新的模板，会拼出前后矛盾的界面
// （实测：cron 会话仍走旧的 readOnly 逻辑被判只读，却显示新文案「子代理会话只读」）。
// acceptHMRUpdate 会就地替换 actions/getters 并保留 state，实例不换。
//
// 另外热更新前要解绑 Tauri 事件监听：那些 unlisten 句柄存在闭包里，不解绑会每次
// 热更新累积一层，同一个 bus frame 被处理多次。
// 生产构建里 import.meta.hot 为 undefined，整段会被 tree-shake 掉。
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    try {
      const pinia = getActivePinia();
      if (pinia) useSessionStore(pinia).teardownListeners();
    } catch {
      /* store 还没实例化过，没有需要解绑的东西 */
    }
  });
  import.meta.hot.accept(acceptHMRUpdate(useSessionStore, import.meta.hot));
}
