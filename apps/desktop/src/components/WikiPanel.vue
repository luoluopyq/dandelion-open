<template>
  <section class="wiki-page" :class="{ embedded }">
    <div v-if="!embedded" class="wiki-controls">
      <label class="memory-scope"><span>所属项目</span><select v-model="projectPath" aria-label="Wiki 所属项目" :disabled="!!busy"><option value="" disabled>选择项目</option><option v-for="project in projectOptions" :key="project.workspace" :value="project.workspace">{{ project.name }}</option></select></label>
      <button type="button" class="button-quiet wiki-refresh" :disabled="!!busy || !projectPath" @click="refresh">刷新</button>
    </div>
    <!-- 深度构建失败有专属横幅（含阶段与原因），顶部通用错误不重复刷屏。 -->
    <p v-if="store.panelError && !deepErrorHere" class="corpus-error" role="alert">{{ store.panelError }}</p>

    <div v-if="!projectPath" class="wiki-empty"><strong>先选择项目</strong><p>Wiki 按项目分别构建，选择项目后可查看或生成页面。</p></div>

    <template v-else>
      <!-- 顶栏：项目、状态与主要动作。阅读区始终紧随其后。 -->
      <header class="wiki-bar">
        <div class="wiki-bar-id">
          <h2>{{ projectName }}</h2>
          <p class="wiki-bar-meta">
            <template v-if="store.wikiStatus?.hasCompiled">已扫描 {{ store.wikiStatus.sourceFiles ?? 0 }} 个文件 · {{ pages.length }} 个页面 · {{ compiledAt }}<template v-if="(store.wikiStatus.buildVersion ?? 0) > 0"> · 模型构建第 {{ store.wikiStatus.buildVersion }} 版</template></template>
            <template v-else>这个项目还没有 Wiki</template>
            <span v-if="profile" class="wiki-domain-tag">类型：{{ profile.label }}<button type="button" class="wiki-domain-switch" :disabled="!!busy" @click="switchDomain">{{ profile.domain === "code" ? "切换为资料/业务" : "切换为软件项目" }}</button></span>
          </p>
        </div>
        <div class="wiki-bar-actions">
          <button type="button" class="button-quiet" :disabled="!!busy || !store.wikiStatus?.hasCompiled" @click="manageOpen = !manageOpen" :aria-expanded="manageOpen">知识管理<template v-if="pendingCount">（{{ pendingCount }} 待审核）</template></button>
          <button type="button" class="button-quiet" :disabled="!!busy" @click="build(false)">快速扫描</button>
          <button v-if="store.wikiStatus?.hasCompiled" type="button" class="button-quiet" :disabled="!!busy" title="只重写证据文件已变化或尚未发布的文章" @click="build(true, true)">增量重建</button>
          <button type="button" class="button-primary" :disabled="!!busy" @click="build(true)">{{ busy === "build" ? "正在构建…" : store.wikiStatus?.hasCompiled ? "模型构建" : "构建 Wiki" }}</button>
        </div>
      </header>
      <p class="wiki-scope-note">仅整理 <code>{{ projectPath }}</code> 中的项目文件与对话。</p>

      <!-- 扫描覆盖（core CoverageReport，只读）：构建前就能看清项目根选没选对、
           哪些文件被排除。rootSuggestion 只提供显式按钮，绝不静默切换项目。 -->
      <details v-if="coverageHere" class="wiki-coverage">
        <summary>扫描覆盖：候选 {{ coverageHere.candidateFiles }} 个文件 · 纳入 {{ coverageHere.includedFiles }} 个{{ coverageHere.budgetHit ? " · 已触达预算上限" : "" }}</summary>
        <ul>
          <li v-if="coverageHere.tooLarge">单文件过大未纳入：{{ coverageHere.tooLarge }} 个<template v-if="coverageHere.tooLargeExamples.length">（如 <code v-for="ex in coverageHere.tooLargeExamples.slice(0, 3)" :key="ex" class="wiki-cov-path">{{ ex }}</code>）</template></li>
          <li v-if="coverageHere.unreadable">无法读取：{{ coverageHere.unreadable }} 个</li>
          <li v-if="coverageHere.overBudget">超出总量预算未纳入：{{ coverageHere.overBudget }} 个<template v-if="coverageHere.overBudgetExamples.length">（如 <code v-for="ex in coverageHere.overBudgetExamples.slice(0, 3)" :key="ex" class="wiki-cov-path">{{ ex }}</code>）</template></li>
          <li v-if="coverageHere.ignoredDirs.length">按规则忽略的目录：{{ coverageHere.ignoredDirs.join("、") }}</li>
          <li v-if="coverageHere.childRepos.length">检测到子仓库：<code v-for="repo in coverageHere.childRepos" :key="repo.dir" class="wiki-cov-path">{{ repo.dir }}</code>（{{ coverageHere.rootManifest ? "根目录本身也有项目清单" : "根目录没有项目清单" }}）</li>
        </ul>
        <p v-if="coverageHere.rootSuggestion" class="wiki-root-suggest">
          根目录没有项目清单，实际仓库可能是子目录 <code>{{ coverageHere.rootSuggestion }}</code>。
          <button type="button" class="wiki-domain-switch" :disabled="!!busy" @click="applyRootSuggestion(coverageHere.rootSuggestion)">改用 {{ coverageHere.rootSuggestion }} 作为项目目录</button>
          （不会自动切换，构建按你选的目录进行）
        </p>
      </details>

      <!-- 深度模型构建进度（bus `_wiki_update` deep 词表），按项目认领。
           失败显示 core 记录的具体阶段和原因；上一版文章此时仍完整可读。 -->
      <div v-if="deepBusy" class="wiki-notice wiki-build-progress" role="status">
        <span>{{ deepLabel }}</span>
        <button type="button" class="wiki-domain-switch" :disabled="cancelling" @click="cancelBuild">{{ cancelling ? "正在取消…" : "取消构建" }}</button>
      </div>
      <p v-else-if="deepErrorHere" class="corpus-error" role="alert">{{ deepFailureNotice }}</p>
      <p v-else-if="store.wikiBuildReport" class="wiki-notice wiki-build-report" role="status">
        <template v-if="store.wikiBuildReport.published.length">构建完成：发布 {{ store.wikiBuildReport.published.length }} 篇文章（第 {{ store.wikiBuildReport.build }} 版<template v-if="store.wikiBuildReport.modelCalls != null"> · {{ store.wikiBuildReport.modelCalls }} 次模型调用</template><template v-if="store.wikiBuildReport.elapsedMs != null"> · 用时 {{ fmtElapsed(store.wikiBuildReport.elapsedMs) }}</template>）<template v-if="store.wikiBuildReport.skippedUserEdited.length">；你手动编辑过的 {{ store.wikiBuildReport.skippedUserEdited.length }} 篇已保留、未被覆盖</template>。</template>
        <template v-else>构建完成：没有过期内容，本次未重写任何文章。</template>
        <template v-if="store.wikiBuildReport.pending?.length"><br />以下文章你编辑过的版本被完整保留，本次新写的文本没有覆盖它们，等你手动合并（新文本在 <code>wiki/builds/pending/</code> 下）：<br /><template v-for="(f, i) in store.wikiBuildReport.pending" :key="i">· {{ f }}<br /></template></template>
        <template v-if="store.wikiBuildReport.warnings?.length"><br />本次修复（引用无法校验，已显式标注，不静默）：<br /><template v-for="(w, i) in store.wikiBuildReport.warnings" :key="i">· {{ w }}<br /></template></template>
        <button type="button" class="wiki-domain-switch" @click="store.wikiBuildReport = null">知道了</button>
      </p>
      <div v-else-if="store.wikiStatus?.lastBuildError" class="corpus-error" role="alert">
        {{ buildFailureNotice(store.wikiStatus.lastBuildError.stage, store.wikiStatus.lastBuildError.reason, (store.wikiStatus.buildVersion ?? 0) > 0) }}
        <details><summary>上次构建详情</summary>{{ store.wikiStatus.lastBuildError.stage }}：{{ store.wikiStatus.lastBuildError.reason }}（{{ store.wikiStatus.lastBuildError.at.slice(0, 16).replace("T", " ") }}）</details>
      </div>

      <!-- 快速扫描进度来自 bus（`_wiki_update` 旧词表），按项目认领：保存≠页面已更新，失败绝不粉饰。 -->
      <p v-if="readState === 'compiling'" class="wiki-notice" role="status">{{ store.wikiStatus?.hasCompiled ? "已保存，页面更新中…" : "正在生成页面…" }}</p>
      <p v-else-if="readState === 'error'" class="corpus-error" role="alert">
        页面编译失败：{{ compileErrorHere }}。条目已保留，不受影响。
        <button type="button" class="wiki-domain-switch" :disabled="!!busy" @click="retryCompile">重试编译</button>
      </p>

      <!-- 目录 + 正文 + 知识管理抽屉。后台编译/失败时正文保持可见（顶部横幅
           提示），未构建/无页面时中央列显示空态；抽屉任何状态下都能打开。 -->
      <div class="wiki-layout" :class="{ 'has-toc': hasReader, 'has-manage': manageOpen }">
        <nav v-show="hasReader" class="wiki-toc" :class="{ open: tocOpen }" aria-label="Wiki 页面目录">
          <div class="wiki-toc-head">
            <span>页面</span>
            <button type="button" class="wiki-toc-toggle" :aria-expanded="tocOpen" :aria-label="tocOpen ? '收起页面目录' : '展开页面目录'" @click="tocOpen = !tocOpen">{{ tocOpen ? "«" : "»" }}</button>
          </div>
          <!-- 目录结构完全来自后端页面注册表（title/group/role），不猜文件名。 -->
          <div v-for="group in tocGroups" :key="group.group" class="wiki-toc-group">
            <p>{{ group.group }}</p>
            <button
              v-for="entry in group.pages"
              :key="entry.file"
              type="button"
              class="wiki-toc-item"
              :class="{ selected: page === entry.file }"
              :aria-current="page === entry.file ? 'page' : undefined"
              @click="showPage(entry.file); if (narrow) tocOpen = false"
            >{{ entry.title }}<span v-if="entry.stale" class="wiki-stale" title="证据文件已变化，本页待增量重建">已过期</span></button>
          </div>
          <button type="button" class="button-quiet wiki-open-dir" @click="store.openWikiDir(projectPath)">在文件夹中查看</button>
        </nav>

        <div class="wiki-center">
          <!-- 未构建：明确空态与两条构建路径。 -->
          <div v-if="readState === 'unbuilt'" class="wiki-empty">
            <strong>这个项目还没有 Wiki</strong>
            <p>快速扫描不调用模型，只索引项目里确实存在的文件；模型构建会在此基础上整理出项目概览与分主题文章，并为文章标注源码出处。也可以先打开「知识管理」从对话提炼知识。</p>
            <div class="wiki-input-row"><button type="button" class="button-quiet" :disabled="!!busy" @click="build(false)">快速扫描</button><button type="button" class="button-primary" :disabled="!!busy" @click="build(true)">模型构建</button></div>
            <!-- 首建前覆盖预览（spec 五/七）：跑构建扫描同一趟索引、不调模型，
                 先看清根目录选没选对、哪些文件会被纳入；之后的构建复用这份索引。 -->
            <div class="wiki-input-row"><button type="button" class="button-quiet" :disabled="!!busy || previewing" @click="previewCoverage">{{ previewing ? "正在扫描…" : "预览扫描覆盖" }}</button><span class="wiki-bar-meta">不调用模型；扫描后上方可展开覆盖详情</span></div>
          </div>
          <div v-else-if="readState === 'empty'" class="wiki-empty">
            <strong>还没有生成的页面</strong>
            <p>条目都在「知识管理」里，但没有一条通过审核进入页面；通过一条或重新构建后这里就有内容了。</p>
          </div>
          <article v-show="hasReader" class="wiki-article">
          <header class="wiki-article-head">
            <h3>{{ selectedPage?.title || page }}</h3>
            <p v-if="provenanceHint" class="wiki-provenance">{{ provenanceHint }}</p>
            <!-- 文章级过期横幅：目录里的"已过期"角标之外，正在读的这篇也要说清楚。 -->
            <p v-if="selectedPage?.stale" class="wiki-notice" role="status">这篇文章的依据文件在构建后发生过变化，内容可能已过期——只能作线索、不作当前事实；可用上方「增量重建」刷新它。</p>
            <button v-if="!hideAsk" type="button" class="wiki-ask-toggle" :aria-expanded="askOpen" @click="askOpen = !askOpen">{{ askOpen ? "收起提问" : "向项目提问" }}</button>
          </header>
          <div v-if="!hideAsk && askOpen" class="wiki-ask">
            <div class="wiki-input-row"><input id="wiki-question" v-model="question" aria-label="向项目 Wiki 提问" placeholder="例如：这个项目主要在做什么？" :disabled="!!busy" @keydown.enter="ask" /><button type="button" class="button-primary" :disabled="!!busy || !question.trim()" @click="ask">{{ busy === "ask" ? "正在查找…" : "提问" }}</button></div>
            <div v-if="answer" class="wiki-answer" aria-live="polite">
              <div class="wiki-answer-text" v-html="linkifyCitations(renderMarkdown(answer.answer))" @click="onBodyClick" @auxclick="onBodyClick"></div>
              <details v-if="answer.sources.length"><summary>查看依据（{{ answer.sources.length }}，原始源码证据优先）</summary><ol><li v-for="(source, i) in answer.sources" :key="i"><button class="wiki-source-link" type="button" @click="openEvidence(evidenceTarget(source))">{{ source.kind === "raw" ? `${source.page}:L${source.start ?? "?"}${source.end && source.end !== source.start ? `-L${source.end}` : ""}` : source.page }}</button>：{{ source.excerpt }}<span v-if="source.stale" class="wiki-stale" title="依据文件已变化，本页待重建">可能过期</span></li></ol></details>
            </div>
          </div>
          <div v-if="pendingCount" class="wiki-pending-hint" role="status">
            {{ pendingCount }} 条知识待审核，通过后才会进入页面。
            <button type="button" class="wiki-domain-switch" @click="manageOpen = true">去审核</button>
          </div>
          <div v-if="body" class="wiki-article-body" v-html="linkifyCitations(renderMarkdown(body))" @click="onBodyClick" @auxclick="onBodyClick"></div>
          <p v-else-if="page" class="wiki-notice">这个页面暂时没有内容。</p>
          </article>

          <!-- 源码证据卡：raw 依据/正文引用点击后在页内展开。core 已校验路径
               属于当前绑定项目；打不开（文件已删/移出项目）如实提示。 -->
          <div v-if="evidence" class="wiki-evidence" role="region" :aria-label="`源码证据 ${evidence.rel}`">
            <header class="wiki-evidence-head">
              <strong>{{ evidence.rel }}<template v-if="evidence.start">:L{{ evidence.start }}<template v-if="evidence.end && evidence.end !== evidence.start">-L{{ evidence.end }}</template></template></strong>
              <button type="button" class="wiki-toc-toggle" aria-label="关闭源码证据" @click="evidence = null">×</button>
            </header>
            <p v-if="evidence.error" class="corpus-error" role="alert">这条引用现在打不开：{{ evidence.error }}</p>
            <template v-else-if="evidence.window">
              <pre class="wiki-evidence-code"><code v-for="(line, i) in evidence.window.lines" :key="i">{{ (evidence.window.start + i) + "\t" + line }}</code></pre>
              <p v-if="evidence.window.truncated" class="wiki-notice">窗口已截断（该文件共 {{ evidence.window.totalLines }} 行）。</p>
            </template>
            <p v-else class="wiki-notice">正在读取源码…</p>
            <p class="wiki-provenance">行号能打开只说明引用可追溯；结论是否成立仍需结合上下文判断，证据文件变化后本页会标记过期。</p>
          </div>
        </div>

        <!-- 知识管理抽屉：提炼、待审核与历史条目。阅读区不再混排这些维护卡片。 -->
        <aside v-if="manageOpen" class="wiki-manage" aria-label="知识管理">
          <div class="wiki-manage-head">
            <h3>知识管理</h3>
            <button type="button" class="wiki-toc-toggle" aria-label="关闭知识管理" @click="manageOpen = false">×</button>
          </div>
          <section class="wiki-manage-block">
            <h4>从对话提炼知识</h4>
            <p>选择一条对话，提炼其中值得长期保留的流程、决策、经验和术语。条目会整理进对应页面并标注来源对话，只在 Wiki 中展示，不会进入模型提示词。</p>
            <div class="wiki-input-row"><select v-model="distillSession" :disabled="!!busy" aria-label="选择要提炼的对话"><option value="" disabled>选择要提炼的对话</option><option v-for="row in distillOptions" :key="row.id" :value="row.id">{{ row.title || "未命名对话" }}</option></select><button type="button" class="button-primary" :disabled="!!busy || !distillSession" @click="distill">{{ busy === "distill" ? "正在提炼…" : "提炼知识" }}</button></div>
            <p v-if="notice" class="wiki-notice" role="status">{{ notice }}</p>
          </section>
          <section class="wiki-manage-block">
            <h4>知识条目<span v-if="pendingCount" class="wiki-entry-badge">{{ pendingCount }} 条待审核</span></h4>
            <p>对话中 Agent 提议或你要求写入的知识。待审核条目在你通过之前不会出现在 Wiki 页面上；撤销后页面会自动重新编译。</p>
            <button type="button" class="button-quiet" :disabled="!!busy" @click="loadEntries">刷新条目</button>
            <p v-if="!entries.length" class="wiki-notice">还没有条目——在对话里让 Agent 记录知识，或用上面的“提炼知识”。</p>
            <ul v-else class="wiki-entry-list">
              <li v-for="entry in entries" :key="entry.id" class="wiki-entry" :class="`is-${entry.status}`">
                <div class="wiki-entry-head">
                  <span class="wiki-entry-kind">{{ KIND_LABELS[entry.kind] }}</span>
                  <span class="wiki-entry-status">{{ STATUS_LABELS[entry.status] }}</span>
                  <span class="wiki-entry-src">来自对话 {{ shortId(entry.sessionId) }}{{ entry.turn ? ` · 第 ${entry.turn} 轮` : "" }} · {{ entry.createdAt.slice(0, 10) }}</span>
                </div>
                <template v-if="editing === entry.id">
                  <textarea v-model="editContent" rows="3" aria-label="编辑知识条目"></textarea>
                  <div class="wiki-input-row">
                    <select v-model="editKind" aria-label="条目类型"><option value="flow">流程</option><option value="decision">决策</option><option value="pitfall">坑</option><option value="term">术语</option></select>
                    <button type="button" class="button-primary" :disabled="!!busy || !editContent.trim()" @click="saveEdit(entry.id)">保存</button>
                    <button type="button" class="button-quiet" @click="editing = ''">取消</button>
                  </div>
                </template>
                <p v-else class="wiki-entry-content">{{ entry.content }}</p>
                <div v-if="editing !== entry.id" class="wiki-entry-actions">
                  <template v-if="entry.status === 'pending'">
                    <button type="button" class="button-primary" :disabled="!!busy" @click="review(entry, 'approve')">通过</button>
                    <button type="button" class="button-quiet" :disabled="!!busy" @click="review(entry, 'reject')">拒绝</button>
                  </template>
                  <button type="button" class="button-quiet" :disabled="!!busy" @click="startEdit(entry)">编辑</button>
                  <button type="button" class="button-quiet" :disabled="!!busy" @click="review(entry, 'undo')">撤销</button>
                </div>
              </li>
            </ul>
            <p v-if="entryNotice" class="wiki-notice" role="status">{{ entryNotice }}</p>
          </section>
        </aside>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { WikiAnswer, WikiEntry, WikiPageEntry, WikiProfile, WikiSourceWindow } from "../lib/types";
import * as ipc from "../lib/ipc";
import { renderMarkdown } from "../lib/markdown";
import { relativeWikiPage } from "../lib/links";
import { citationTarget, evidenceTarget, joinWorkspacePath, linkifyCitations, type EvidenceTarget } from "../lib/wiki-evidence";
import { createWikiGate } from "../lib/wiki-identity";
import { buildFailureNotice, groupPages, pageProvenanceHint, readState as computeReadState, resolveSelectedPage, samePath } from "../lib/wiki-view";
import { useSessionStore } from "../stores/session";

const { embedded = false, hideAsk = false, projectPath: selectedProjectPath } = defineProps<{ embedded?: boolean; hideAsk?: boolean; projectPath?: string }>();
const store = useSessionStore();
const projectPath = ref(selectedProjectPath ?? "");
const projectOptions = computed(() => {
  const rows = store.projects.map(project => ({ name: project.name, workspace: project.workspace }));
  const current = store.activeWorkspace;
  if (current && !rows.some(row => row.workspace === current)) rows.unshift({ name: `${current.split("/").pop()}（当前对话）`, workspace: current });
  // 采纳"建议子仓库"后目录可能尚未登记为项目：把它本身列进选项，
  // 选择框才显示得出来、也不会被下方 watch 弹回旧目录。
  const selected = projectPath.value;
  if (selected && !rows.some(row => row.workspace === selected)) rows.unshift({ name: selected.split(/[\\/]/).filter(Boolean).pop() || selected, workspace: selected });
  return rows;
});
const projectName = computed(() => (projectPath.value.split(/[\\/]/).filter(Boolean).pop() || "项目 Wiki"));
// 页面集合、顺序、标题与分组完全由后端页面注册表（wiki pages.json）决定，
// 前端不认识任何具体页面名——新的领域画像可以直接给出自己的页面。
const pages = computed<WikiPageEntry[]>(() => store.wikiStatus?.pages ?? []);
const tocGroups = computed(() => groupPages(pages.value));
const compiledAt = computed(() => {
  const value = store.wikiStatus?.compiledAt;
  if (!value) return "刚刚更新";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `更新于 ${date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })}`;
});
const question = ref("");
const page = ref("");
const body = ref("");
const answer = ref<WikiAnswer | null>(null);
const busy = ref<"build" | "ask" | "distill" | "entry" | "">("");
const profile = ref<WikiProfile | null>(null);
const distillSession = ref("");
const notice = ref("");
const tocOpen = ref(true);
const manageOpen = ref(false);
const askOpen = ref(false);
const narrow = ref(typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches);
function onResize() { narrow.value = window.matchMedia("(max-width: 900px)").matches; }
function onKeydown(event: KeyboardEvent) { if (event.key === "Escape" && manageOpen.value) manageOpen.value = false; }
onMounted(() => { window.addEventListener("resize", onResize); window.addEventListener("keydown", onKeydown); });
onBeforeUnmount(() => { window.removeEventListener("resize", onResize); window.removeEventListener("keydown", onKeydown); });
const selectedPage = computed(() => pages.value.find(entry => entry.file === page.value) ?? null);
const provenanceHint = computed(() => pageProvenanceHint(selectedPage.value));
// —— 知识条目审核区（对话写入 wiki_propose + 手动提炼共用同一账本）——
const entries = ref<WikiEntry[]>([]);
const entryNotice = ref("");
const editing = ref("");
const editContent = ref("");
const editKind = ref<WikiEntry["kind"]>("term");
const KIND_LABELS: Record<WikiEntry["kind"], string> = { flow: "流程", decision: "决策", pitfall: "坑", term: "术语" };
const STATUS_LABELS: Record<WikiEntry["status"], string> = { pending: "待审核", accepted: "已写入", rejected: "已拒绝" };
const pendingCount = computed(() => entries.value.filter(entry => entry.status === "pending").length);

// —— 编译状态（store 转发 bus `_wiki_update`）——
// 事件带 workspace；面板只认领当前项目的编译。老事件缺 workspace 时不显示，
// 宁可不提示也不把别的项目的进度安在这个项目头上。
const compilingHere = computed(() => {
  const c = store.wikiCompile;
  return !!c && c.phase === "started" && !!c.workspace && samePath(c.workspace, projectPath.value);
});
const compileErrorHere = computed(() => {
  const c = store.wikiCompile;
  return c?.phase === "error" && !!c.workspace && samePath(c.workspace, projectPath.value) ? c.message || "未知错误" : "";
});

// —— 深度模型构建（core `wiki_build_llm`，bus deep 词表）——
// 与快速扫描共用 `_wiki_update`：deep 阶段 build_started/build_plan/build_article/
// build_finished/build_error；build_article 的 message 是当前文章标题。
// 同样按项目认领：workspace 不匹配的事件一律不显示在这个项目头上。
const DEEP_PHASES = new Set(["build_started", "build_plan", "build_article", "build_finished", "build_error"]);
const deepEvent = computed(() => {
  const c = store.wikiCompile;
  return c && DEEP_PHASES.has(c.phase) && !!c.workspace && samePath(c.workspace, projectPath.value) ? c : null;
});
const deepBusy = computed(() => !!deepEvent.value && ["build_started", "build_plan", "build_article"].includes(deepEvent.value.phase));
const deepErrorHere = computed(() => (deepEvent.value?.phase === "build_error" ? deepEvent.value.message || "未知错误" : ""));
const deepFailureNotice = computed(() => {
  const message = deepErrorHere.value;
  const separator = message.indexOf("：");
  return buildFailureNotice(separator < 0 ? "build" : message.slice(0, separator), separator < 0 ? message : message.slice(separator + 1), (store.wikiStatus?.buildVersion ?? 0) > 0);
});
const deepLabel = computed(() => {
  const c = deepEvent.value;
  if (!c) return "";
  if (c.phase === "build_article") return `正在撰写《${c.message || "文章"}》…`;
  return c.phase === "build_plan" ? "扫描完成，正在规划文章目录…" : "正在扫描项目并准备构建…";
});
const cancelling = ref(false);
async function cancelBuild() {
  if (cancelling.value) return;
  cancelling.value = true;
  try { await store.cancelWikiBuild(projectPath.value); } finally { cancelling.value = false; }
}

// —— 扫描覆盖（spec 二）：只显示本项目的问题，workspace 不匹配视为无数据 ——
const coverageHere = computed(() => {
  const c = store.wikiCoverage;
  return c && projectPath.value && samePath(c.workspace, projectPath.value) ? c : null;
});
// 建议子仓库由用户显式点击后才切换目录，绝不静默。切换必须真正生效：目录
// 尚未登记时同步创建项目（与 setTaskWorkspace 同一模式），并用后端登记后的
// 规范拼写回写——否则选择框里只是个临时字符串，构建/问答找不到项目绑定。
async function applyRootSuggestion(suggestion: string) {
  if (busy.value) return;
  const next = joinWorkspacePath(projectPath.value, suggestion);
  if (store.projects.some(p => p.workspace === next)) { projectPath.value = next; return; }
  try {
    const project = await ipc.projectCreate(next);
    await store.refreshProjects();
    projectPath.value = project.workspace;
  } catch (err) {
    store.panelError = `登记项目目录失败：${String(err)}`;
  }
}

// 首建前覆盖预览：core 跑与构建扫描阶段同一趟索引（持久化证据索引，
// 之后的构建按哈希复用），不调模型、不生成页面。
const previewing = ref(false);
async function previewCoverage() {
  if (previewing.value || busy.value || !projectPath.value) return;
  previewing.value = true;
  const id = uiGate.claim(projectPath.value, "preview");
  try {
    const cov = await ipc.wikiCoveragePreview(projectPath.value);
    if (uiGate.isCurrent(id)) store.wikiCoverage = cov;
  }
  catch (err) { if (uiGate.isCurrent(id)) store.panelError = `预览扫描覆盖失败：${String(err)}`; }
  finally { previewing.value = false; }
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

// —— 证据跳转（spec 三）：raw 源码证据/正文引用 → 页内源码卡 ——
// 读取走 core 的 wiki_read_source（ws=当前绑定项目，越界路径在 core 侧拒绝），
// 前端不拼绝对路径、不跨项目读取。
const evidence = ref<{ rel: string; start: number | null; end: number | null; window?: WikiSourceWindow; error?: string } | null>(null);
// 面板侧回写身份闸门（与 store 同一套三元组规则）：连点引用时先发的请求
// 可能后到，切项目时代次升级——旧点击/旧问答/旧预览的晚到响应一律作废，
// 不把上一个项目的证据、答案、正文盖在当前项目头上。
const uiGate = createWikiGate();
async function openEvidence(target: EvidenceTarget) {
  if (target.mode === "page") { await openSource(target.page); return; }
  const id = uiGate.claim(projectPath.value, "evidence");
  evidence.value = { rel: target.rel, start: target.start, end: target.end };
  try {
    const win = await ipc.wikiReadSource(target.rel, target.start ?? 1, target.end ?? target.start ?? 1, projectPath.value);
    if (!uiGate.isCurrent(id)) return;
    evidence.value = { rel: win.rel, start: win.start, end: win.end, window: win };
  } catch (err) {
    if (!uiGate.isCurrent(id)) return;
    evidence.value = { rel: target.rel, start: target.start, end: target.end, error: String(err) };
  }
}
// 阅读区状态单一出口（互斥，失败不显示成功）：noProject/unbuilt/compiling/error/reading/empty。
const readState = computed(() => computeReadState({
  hasProject: !!projectPath.value,
  hasCompiled: !!store.wikiStatus?.hasCompiled,
  compiling: compilingHere.value,
  compileError: compileErrorHere.value,
  pageCount: pages.value.length,
}));
// 有页可读（或后台编译/失败但旧页仍在）时显示目录与正文。
const hasReader = computed(() => ["reading", "compiling", "error"].includes(readState.value));
watch(() => store.wikiCompile, c => {
  // 后台编译/深度构建完成：刷新页面时间戳并清掉这条已完成的状态，避免下次进页面还挂着。
  // build_finished 的 message 可能是"没有过期内容，无需重建"之类的说明，成功报告由
  // wikiBuildReport 横幅展示，这里只负责刷新与清理。
  if ((c?.phase === "finished" || c?.phase === "build_finished") && c.workspace && samePath(c.workspace, projectPath.value)) {
    store.wikiCompile = null;
    void refresh();
  }
});
async function retryCompile() {
  if (busy.value) return;
  busy.value = "build";
  try { await store.compileWiki(false, projectPath.value); store.wikiCompile = null; }
  finally { busy.value = ""; }
}

async function loadEntries() {
  entries.value = projectPath.value ? await ipc.wikiEntries(projectPath.value).catch(() => []) : [];
}

function shortId(id: string) { return id.length > 8 ? id.slice(0, 8) : id; }

async function review(entry: WikiEntry, action: "approve" | "reject" | "undo") {
  if (busy.value) return;
  busy.value = "entry";
  entryNotice.value = "";
  try {
    await ipc.wikiReviewEntry(entry.id, action, projectPath.value);
    entryNotice.value = action === "approve" ? "已通过，正在重新编译页面。"
      : action === "reject" ? "已拒绝，该条目不会进入页面。"
      : "已撤销，页面正在重新编译。";
    await loadEntries();
    await refresh();
  } catch (err) {
    entryNotice.value = `操作失败：${String(err)}`;
  } finally {
    busy.value = "";
  }
}

function startEdit(entry: WikiEntry) {
  editing.value = entry.id;
  editContent.value = entry.content;
  editKind.value = entry.kind;
}

async function saveEdit(id: string) {
  if (busy.value) return;
  busy.value = "entry";
  try {
    await ipc.wikiEditEntry(id, editContent.value.trim(), editKind.value, projectPath.value);
    editing.value = "";
    entryNotice.value = "已保存修改，页面正在重新编译。";
    await loadEntries();
    await refresh();
  } catch (err) {
    entryNotice.value = `保存失败：${String(err)}`;
  } finally {
    busy.value = "";
  }
}
const distillOptions = computed(() => {
  const group = store.spaceGroups.find(row => row.workspace === projectPath.value);
  return (group?.sessions ?? []).filter(row => row.kind !== "wiki");
});

watch(projectOptions, options => {
  if (!options.some(option => option.workspace === projectPath.value)) projectPath.value = options.find(option => option.workspace === store.activeWorkspace)?.workspace || options[0]?.workspace || "";
}, { immediate: true });
watch(() => selectedProjectPath, value => { if (value !== undefined) projectPath.value = value; });
watch(projectPath, () => {
  // 切项目先升代次：在途的证据/问答/预览/正文旧响应立刻全体失去回写资格，
  // 哪怕新方向还没有发起任何请求（晚到 ≠ 最新）。
  uiGate.bind(projectPath.value);
  answer.value = null;
  page.value = "";
  body.value = "";
  notice.value = "";
  distillSession.value = "";
  manageOpen.value = false;
  askOpen.value = false;
  store.wikiStatus = null;
  entries.value = [];
  entryNotice.value = "";
  editing.value = "";
  store.wikiBuildReport = null;
  evidence.value = null;
  cancelling.value = false;
  void loadProfile();
  if (projectPath.value) void refresh();
}, { immediate: true });

async function refresh() { await store.refreshWiki(projectPath.value); await loadEntries(); }

async function loadProfile() {
  const id = uiGate.claim(projectPath.value, "profile");
  const next = projectPath.value ? await ipc.wikiProfile(projectPath.value).catch(() => null) : null;
  if (uiGate.isCurrent(id)) profile.value = next;
}

async function switchDomain() {
  if (busy.value || !projectPath.value) return;
  const next: WikiProfile = profile.value?.domain === "code"
    ? { domain: "generic", label: "资料与业务" }
    : { domain: "code", label: "软件项目" };
  busy.value = "build";
  try {
    if (await store.setWikiProfile(next, projectPath.value)) {
      profile.value = next;
      await store.compileWiki(false, projectPath.value);
    }
  } finally {
    busy.value = "";
  }
}

async function distill() {
  if (!distillSession.value || busy.value) return;
  busy.value = "distill";
  notice.value = "";
  try {
    const added = await store.distillWiki(distillSession.value, projectPath.value);
    if (added !== null) notice.value = added > 0 ? `已提炼 ${added} 条知识并更新页面。` : "这段对话里没有出现值得长期保留的内容。";
    await loadEntries();
  } finally {
    busy.value = "";
  }
}

async function build(useModel: boolean, incremental = false) {
  busy.value = "build";
  answer.value = null;
  page.value = "";
  body.value = "";
  evidence.value = null;
  store.wikiBuildReport = null;
  try { await store.compileWiki(useModel, projectPath.value, incremental); }
  finally { busy.value = ""; }
}

async function ask() {
  if (!question.value.trim() || busy.value) return;
  busy.value = "ask";
  const id = uiGate.claim(projectPath.value, "ask");
  try {
    const result = await store.wikiAsk(question.value.trim(), projectPath.value);
    if (uiGate.isCurrent(id)) answer.value = result;
  } finally { busy.value = ""; }
}

async function showPage(name: string) {
  const id = uiGate.claim(projectPath.value, "page");
  page.value = name;
  const shown = await store.wikiShow(name, projectPath.value);
  // 身份守卫管项目和最新点击，page.value === name 管同项目内连续切页：
  // 构建/切项目后旧请求可能后到，正文只认最后一次选中且未换项目的页。
  if (uiGate.isCurrent(id) && page.value === name) body.value = shown[0]?.body ?? "";
}

// 选页唯一入口：默认打开注册表标记的概览页（无则第一页）；当前页因撤销
// 等原因消失时自动回落；审核后新页出现不抢占当前页，但重新拉取当前页正文。
watch(() => store.wikiStatus, status => {
  if (!status) return;
  const next = resolveSelectedPage(status.pages, page.value);
  if (next) void showPage(next);
  else { page.value = ""; body.value = ""; }
});

async function openSource(source: string) {
  const base = source.split(":")[0] ?? "";
  const entry = pages.value.find(p => p.file === source || p.file === base);
  await showPage(entry?.file ?? base);
}

// 正文/答案的委托点击：站内文章链接（概览的学习顺序等）页内切页 +
// 代码块复制按钮 + `路径:Lx-Ly` 引用跳源码证据。
function onBodyClick(event: MouseEvent) {
  if (event.type === "auxclick" && event.button !== 1) return;
  // 文章正文里的相对 .md 链接指向本 Wiki 的页面（marked 渲染出的 <a>），
  // 不拦会让 webview 直接导航离开；其余链接由应用统一处理。
  const link = (event.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
  if (link) {
    const page = relativeWikiPage(link.getAttribute("href") ?? "");
    if (page) {
      event.preventDefault();
      void openSource(page);
    }
    return;
  }
  const cite = (event.target as HTMLElement).closest(".wiki-cite") as HTMLElement | null;
  if (cite) {
    const target = citationTarget(cite.dataset);
    if (target) void openEvidence(target);
    return;
  }
  const button = (event.target as HTMLElement).closest(".copy-btn") as HTMLButtonElement | null;
  if (!button?.dataset.copy) return;
  void navigator.clipboard.writeText(decodeURIComponent(button.dataset.copy));
  button.textContent = "已复制";
  window.setTimeout(() => { button.textContent = "复制"; }, 1200);
}
</script>

<style scoped>
.wiki-page { flex: 1; box-sizing: border-box; padding: 34px clamp(32px, 8vw, 150px) 52px; overflow: auto; }
.wiki-page.embedded { padding: 0; margin-top: 22px; overflow: visible; }
.wiki-controls { display: flex; align-items: center; gap: 10px; min-height: 52px; margin: 18px 0 12px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--accent) 8%, var(--bg-2)); }
.wiki-refresh { margin-left: auto; }
.wiki-bar { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 18px 0 12px; border-bottom: 1px solid var(--border); }
.wiki-bar-id h2 { margin: 0 0 4px; font-size: var(--fs-lg); letter-spacing: -.01em; }
.wiki-bar-meta { margin: 0; color: var(--muted); font-size: var(--fs-xs); }
.wiki-bar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wiki-scope-note { margin: 8px 0 0; color: var(--muted); font-size: var(--fs-xs); word-break: break-all; }
.wiki-scope-note code { font-size: var(--fs-xs); }
.wiki-domain-tag { margin-left: 10px; white-space: nowrap; }
.wiki-domain-switch { margin-left: 6px; border: 0; padding: 0; background: none; color: var(--accent, #7360be); text-decoration: underline; cursor: pointer; font: inherit; }
.wiki-notice { margin: 12px 0 0; color: var(--muted); font-size: var(--fs-sm); }
.wiki-empty { display: grid; gap: 12px; margin: 22px 0; padding: 26px; border: 1px dashed var(--border); border-radius: var(--radius-lg); background: var(--bg); }
.wiki-empty strong { font-size: var(--fs-base); }
.wiki-empty p { margin: 0; color: var(--muted); font-size: var(--fs-sm); line-height: 1.6; max-width: 70ch; }

.wiki-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 30px; align-items: start; margin-top: 20px; }
.wiki-layout.has-toc { grid-template-columns: 210px minmax(0, 1fr); }
.wiki-layout.has-toc.has-manage { grid-template-columns: 210px minmax(0, 1fr) 380px; }
.wiki-layout:not(.has-toc).has-manage { grid-template-columns: minmax(0, 1fr) 380px; }
.wiki-center { min-width: 0; }
.wiki-toc { position: sticky; top: 0; display: grid; gap: 12px; align-content: start; padding: 14px 8px; max-height: calc(100vh - 40px); overflow: auto; }
.wiki-toc-head { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: var(--fs-xs); letter-spacing: .08em; }
.wiki-toc-toggle { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-2); color: var(--muted); cursor: pointer; padding: 1px 8px; font: inherit; }
.wiki-toc-group { display: grid; gap: 2px; }
.wiki-toc-group p { margin: 6px 8px 2px; color: var(--muted); font-size: var(--fs-xs); }
.wiki-toc-item { text-align: left; padding: 7px 10px; border: 0; border-radius: var(--radius-md); background: none; color: var(--text); cursor: pointer; font: inherit; font-size: var(--fs-sm); }
.wiki-toc-item:hover { background: var(--bg-2); }
.wiki-toc-item:focus-visible, .wiki-toc-toggle:focus-visible, .wiki-domain-switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.wiki-toc-item.selected { background: color-mix(in srgb, var(--accent) 14%, var(--bg-2)); color: var(--accent); font-weight: 600; }
.wiki-open-dir { justify-self: start; margin-top: 6px; font-size: var(--fs-xs); }

.wiki-article { min-width: 0; max-width: 76ch; }
.wiki-article-head { margin-bottom: 10px; }
.wiki-article-head h3 { margin: 0 0 4px; font-size: var(--fs-xl, 20px); letter-spacing: -.01em; }
.wiki-provenance { margin: 0; color: var(--muted); font-size: var(--fs-xs); line-height: 1.5; }
.wiki-ask-toggle { margin-top: 8px; border: 0; padding: 0; background: none; color: var(--accent, #7360be); text-decoration: underline; cursor: pointer; font: inherit; font-size: var(--fs-xs); }
.wiki-ask { margin: 12px 0; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg); display: grid; gap: 10px; }
.wiki-pending-hint { margin: 12px 0 0; padding: 8px 12px; border-radius: var(--radius-md); background: color-mix(in srgb, #d99a2b 12%, var(--bg-2)); color: var(--text); font-size: var(--fs-xs); }
.wiki-article-body { line-height: 1.75; font-size: var(--fs-sm); }
.wiki-article-body :deep(h1), .wiki-article-body :deep(h2) { margin: 22px 0 10px; }
.wiki-article-body :deep(h1):first-child, .wiki-article-body :deep(h2):first-child { margin-top: 4px; }
.wiki-article-body :deep(h3) { margin: 18px 0 8px; }
.wiki-article-body :deep(p) { margin: 0 0 12px; }
.wiki-article-body :deep(ul), .wiki-article-body :deep(ol) { padding-left: 22px; margin: 0 0 12px; }
.wiki-article-body :deep(li) { margin: 5px 0; }
.wiki-article-body :deep(code) { padding: 1px 5px; border-radius: 4px; background: var(--bg-2); font-size: .92em; }
.wiki-article-body :deep(pre) { margin: 0 0 14px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-2); overflow: auto; font-size: .9em; line-height: 1.55; }
.wiki-article-body :deep(blockquote) { margin: 0 0 12px; padding: 2px 14px; border-left: 3px solid var(--border); color: var(--muted); }
.wiki-article-body :deep(table) { border-collapse: collapse; margin: 0 0 14px; }
.wiki-article-body :deep(th), .wiki-article-body :deep(td) { border: 1px solid var(--border); padding: 5px 10px; }
.wiki-article-body :deep(a) { color: var(--accent, #7360be); }
.wiki-answer { border-top: 1px solid var(--border); padding-top: 12px; }
.wiki-answer-text { line-height: 1.7; font-size: var(--fs-sm); }
.wiki-answer-text :deep(p) { margin: 0 0 10px; }
.wiki-answer-text :deep(ol), .wiki-answer-text :deep(ul) { padding-left: 22px; }
.wiki-answer-text :deep(li) { margin: 6px 0; }
.wiki-answer li { margin: 8px 0; line-height: 1.5; }
.wiki-source-link { border: 0; padding: 0; background: none; color: var(--accent, #7360be); text-decoration: underline; cursor: pointer; }

.wiki-coverage { margin: 10px 0 0; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); font-size: var(--fs-xs); }
.wiki-coverage summary { cursor: pointer; color: var(--muted); }
.wiki-coverage ul { margin: 8px 0 0; padding-left: 20px; }
.wiki-coverage li { margin: 4px 0; }
.wiki-cov-path { margin: 0 3px; word-break: break-all; }
.wiki-root-suggest { margin: 8px 0 0; }
.wiki-build-progress { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.wiki-build-report { color: var(--text); }
.wiki-stale { margin-left: 6px; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, #d99a2b 18%, var(--bg-2)); color: #9a6b12; font-size: 10px; }
.wiki-article-body :deep(.wiki-cite), .wiki-answer-text :deep(.wiki-cite) { border: 0; padding: 0; background: none; color: var(--accent, #7360be); text-decoration: underline dotted; text-underline-offset: 2px; cursor: pointer; font: inherit; word-break: break-all; }
.wiki-evidence { margin-top: 18px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg); }
.wiki-evidence-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; word-break: break-all; font-size: var(--fs-xs); }
.wiki-evidence-code { margin: 0; padding: 10px 12px; border-radius: var(--radius-md); background: var(--bg-2); overflow: auto; font-size: .85em; line-height: 1.55; }
.wiki-evidence-code code { display: block; white-space: pre; }

.wiki-manage { display: grid; gap: 16px; align-content: start; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg); max-height: calc(100vh - 60px); overflow: auto; }
.wiki-manage-head { display: flex; align-items: center; justify-content: space-between; }
.wiki-manage-head h3 { margin: 0; font-size: var(--fs-base); }
.wiki-manage-block { display: grid; gap: 8px; border-top: 1px solid var(--border); padding-top: 12px; }
.wiki-manage-block h4 { margin: 0; font-size: var(--fs-sm); }
.wiki-manage-block p { margin: 0; color: var(--muted); font-size: var(--fs-xs); line-height: 1.6; }
.wiki-manage-block .button-quiet { justify-self: start; }
.wiki-input-row { display: flex; align-items: center; gap: 10px; }
.wiki-input-row input, .wiki-input-row select { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-2); color: var(--text); font: inherit; }
.wiki-entry-badge { margin-left: 8px; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 16%, var(--bg-2)); color: var(--accent); font-size: var(--fs-xs); font-weight: 500; }
.wiki-entry-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.wiki-entry { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--radius-md); background: var(--bg-2); }
.wiki-entry.is-pending { border-left-color: #d99a2b; }
.wiki-entry.is-accepted { border-left-color: #3a9a5f; }
.wiki-entry.is-rejected { border-left-color: var(--border); opacity: .65; }
.wiki-entry-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--fs-xs); }
.wiki-entry-kind { padding: 1px 7px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 12%, var(--bg)); color: var(--accent); }
.wiki-entry-status { color: var(--muted); }
.wiki-entry-src { margin-left: auto; color: var(--muted); }
.wiki-entry-content { margin: 0; line-height: 1.55; white-space: pre-wrap; font-size: var(--fs-sm); }
.wiki-entry textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); color: var(--text); font: inherit; resize: vertical; }
.wiki-entry-actions { display: flex; gap: 8px; justify-content: flex-end; }

@media (max-width: 900px) {
  .wiki-reader { grid-template-columns: minmax(0, 1fr); }
  .wiki-toc { position: static; max-height: none; }
  .wiki-toc:not(.open) .wiki-toc-group, .wiki-toc:not(.open) .wiki-open-dir { display: none; }
  .wiki-manage { position: fixed; inset: 12px 12px auto auto; width: min(420px, calc(100vw - 24px)); max-height: calc(100vh - 24px); z-index: 30; box-shadow: 0 8px 32px rgb(0 0 0 / 18%); }
}
</style>
