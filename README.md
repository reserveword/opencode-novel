# opencode-novel

`opencode-novel` 是一个面向中文小说创作流程的 OpenCode 插件。  
它通过 `/novel-*` 命令把「初始化 → 导入 → 索引 → 巡检 → 写作 → 导出」串成可重复执行的工程化流程。

> 当前版本面向 **OpenCode 2.x**，基于 `@opencode/plugin` 的 V2 插件 API。OpenCode 1.x 请使用 `0.0.x` 版本。

## 核心能力

- 命令式写作工作流：`/novel-*`
- 可复现工具链：`novel_*` tools（索引、连续性、伏笔、风格、导出等）
- 受控落盘机制：支持 `dryRun`、候选应用、快照
- 多格式导出：`md` / `html` / `epub` / `docx`
- 导出前预检：可在导出前执行质量门禁（continuity/style 等）

## 快速开始

### 1) 安装依赖并构建

```bash
bun install
bun run build
```

### 2) 安装到 OpenCode

```bash
bun run script/install-opencode.ts -- --target=global
```

安装后执行 `opencode reload`（或重启 OpenCode）使插件生效。

### 3) 常用命令顺序

```text
/novel-init "书名"
/novel-config-check
/novel-index
/novel-chapter-plan ch0001
/novel-chapter-draft ch0001
/novel-continuity-check
/novel-export docx
```

## 安装指南（npm 全局）

适用于“直接使用发布包”的场景（不从源码构建）。

### 1) 安装 Bun（必需）

`opencode-novel` 的 CLI 通过 `bun` 运行，请先安装 Bun 并确保终端可执行：

```bash
bun --version
```

Windows 建议使用官方安装方式（确保有 `bun.exe`），安装后重启终端。

### 2) 全局安装插件 CLI

```bash
npm i -g opencode-novel
```

验证命令可用：

```bash
opencode-novel --help
```

### 3) 安装到 OpenCode（全局配置）

```bash
opencode-novel install --target=global
```

成功后会输出 `install done`，并写入以下目录：

- `~/.config/opencode/plugins/opencode-novel/index.js`
- `~/.config/opencode/commands`
- `~/.config/opencode/skill`
- `~/.config/opencode/novel.jsonc`

OpenCode 2.x 会自动加载 `plugins/` 目录下的插件，因此不需要在 `opencode.json(c)` 中额外添加 `plugins` 条目。安装器会同时清理旧版本遗留的：

- `~/.config/opencode/plugins/opencode-novel.js`（1.x 文件入口）
- `opencode.json(c)` 中指向该文件或插件目录的 `plugin` / `plugins` 条目

安装完成后执行 `opencode reload`（或重启 OpenCode）。

### 4) 卸载（可选）

先从 OpenCode 配置中移除：

```bash
opencode-novel uninstall --target=global
```

再卸载全局 npm 包：

```bash
npm uninstall -g opencode-novel
```

### 5) 常见问题（Windows）

- **PowerShell 提示 `bun.exe` 找不到**：通常是 Bun 安装方式导致 PATH 中只有 `bun.cmd`。请安装官方 Bun 并重启终端。
- **命令执行后看起来“卡住”**：若输出已出现 `[opencode-novel] install done`，通常已完成；按一次回车确认提示符是否返回。
- **`cmd` 正常、PowerShell 异常**：可先使用 `opencode-novel.cmd install --target=global` 作为临时方案。

## 输出协议（对接方）

所有 `/novel-*` 工具命令统一输出四段：

1. `Summary`
2. `Result (JSON)`
3. `Diagnostics`
4. `Next Steps`

其中 `Result (JSON)` 会包含：

- `version`
- `schemaVersion`（当前与 `version` 值一致）

建议对接程序优先按 `schemaVersion` 做兼容分支，缺失时回退到 `version`。

## 项目目录（简版）

```text
src/                    # 插件与工具实现
script/                 # 构建/安装/性能脚本
assets/                 # 模板资源（bible/chapter 等）
dist/                   # 构建产物
.opencode/              # 命令/技能/派生输出目录（运行时）
manuscript/             # 小说事实源（运行时）
```

## 配置说明

配置按以下顺序合并（后者覆盖前者）：

1. 内置默认配置
2. 用户级配置（以下路径命中其一即可）
   - `~/.config/opencode/novel.jsonc`
   - `%USERPROFILE%\\.config\\opencode\\novel.jsonc`
   - `%APPDATA%\\opencode\\novel.jsonc`
3. 项目级配置：`<project>/.opencode/novel.jsonc`

构建后会生成配置 schema：

- `dist/novel.schema.json`

### 代理（Agent）覆盖（OpenCode 2.x）

`novel.jsonc` 的 `agents` 段仍可覆盖内置代理：

- `model` / `variant`：解析为 `provider/model#variant`；省略时继承当前会话模型
- `prompt` / `prompt_append`：替换或追加系统提示词
- `permission`：映射为 OpenCode 2.x 的权限规则，动作名使用 V2 名称（`edit`、`shell`、`subagent`、`read`、`webfetch` 等）
  - 支持简写 `edit: "deny"`，也支持资源模式表，例如 `shell: { "*": "ask", "git log *": "allow" }`，会展开成按顺序匹配的资源级规则（后匹配者生效）
- `temperature` / `topP` / `maxTokens`：通过会话 `context` 钩子写入模型请求的生成参数
- `steps`：单代理步数上限

采样参数只通过 `context` 钩子生效，且只作用于本插件注册的代理，不会影响用户自己定义的同名代理（除非设置 `agents_force_override: true`）。

默认不会覆盖已存在的同名代理；如需强制覆盖，设置 `agents_force_override: true`。

## 开发命令

- `bun run lint`：静态检查
- `bun run typecheck`：类型检查
- `bun test`：运行测试
- `bun run check`：完整检查（lint + code-rules + typecheck + test + build）
- `bun run benchmark:index`：索引性能基准测试

## npm 发布（自动流）

仓库已配置 GitHub Actions 发布流程。触发方式：

1. 确保 `package.json` 版本号正确
2. 推送匹配版本的标签（格式：`v<version>`）
3. 仓库 Secret 中配置 `NPM_TOKEN`

示例：

```bash
bun pm version patch
git push --follow-tags
```

## 许可证

如需开源发布，请补充 `LICENSE` 文件并在此声明许可证类型。
