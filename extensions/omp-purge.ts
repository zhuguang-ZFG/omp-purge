/**
 * omp-purge — 会话级系统提示词开关（omp 原生移植版）
 *
 * 移植自 ZiChuanLan/pi-purge（机制又源自 dsh-purge）：
 * 宿主身份段不是被压住，而是被**清掉**。strict 模式整段丢弃宿主提示词，
 * 只发人设 + 工作目录；replace 模式只切身份句与宿主文档段。
 *
 * 相对 pi-purge 的 omp 适配：
 *  1. 类型来自 @oh-my-pi/pi-coding-agent，包清单用 omp.extensions；
 *  2. before_agent_start 的 systemPrompt 是 string[]，按块拼接后处理，返回 string[]；
 *  3. cwd 优先取 ExtensionContext.cwd（omp 事件不带 systemPromptOptions）；
 *  4. 新增 omp 宿主身份句与 `omp://` 文档段的切除锚点，同时保留 pi 旧锚点；
 *  5. 补齐 README 承诺的 /purge reload。
 *
 * 三个设计约束（与上游一致）：
 *  1. 默认不启用 —— 不输入 /purge，omp 与未安装本扩展时完全一致。
 *  2. 会话级独立 —— 状态只在内存里，每次 session_start 归零，退出即失，不落盘。
 *  3. 自带人设 —— 默认用内嵌正文；/purge source <路径> 可换成本地文件。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** 内嵌的示例提示词（默认源）。真用时用 `/purge source <路径>` 换掉。 */
const EMBEDDED_PERSONA = [
	"# Persona (example)",
	"",
	"You are a helpful assistant running inside omp. Answer the user's request directly",
	"and keep responses concise.",
	"",
	"This text is only a placeholder bundled with omp-purge, so that a fresh install",
	"works immediately: /purge swaps the system prompt for this text plus the working",
	"directory, and /purge off restores omp's own prompt.",
	"",
	"To run your own instructions instead:",
	"",
	"    /purge source C:/path/to/your-prompt.md",
	"",
	"and /purge source embedded comes back to this example.",
].join("\n");

/** 内嵌源的标识值；也可 `/purge source embedded` 切回来。 */
const EMBEDDED = "embedded";
/** 常见的外部人设位置，仅在用户显式切换时使用。 */
const HINT_SOURCE = join(homedir(), ".omp", "agent", "prompt-inject.md");

/**
 * 默认源的初始值：由 OMP_PURGE_SOURCE 显式指定绝对路径，未设置时保持内嵌示例。
 * 兼容旧变量名 PI_PURGE_SOURCE。只读一次、不落盘、不自动探测。
 */
const ENV_SOURCE = (process.env.OMP_PURGE_SOURCE ?? process.env.PI_PURGE_SOURCE ?? "").trim();

type Mode = "strict" | "replace" | "append";

// 会话级状态：只活在内存里，omp 退出即失，绝不跨会话 / 跨进程泄漏
let enabled = false;
let mode: Mode = "strict";
let source = ENV_SOURCE || EMBEDDED;
let body = EMBEDDED_PERSONA;
let loadError = "";
// 上一轮实际切除情况，/purge status 用它回答"到底生效了没有"
let lastCut = { identity: false, docs: false, at: 0 };

/**
 * 宿主身份句。omp 在前，pi 旧文案保留：同一份代码在两种宿主上都能切。
 * 匹配不到就原样保留，绝不猜边界。
 */
const HOST_IDENTITIES = [
	"You are a helpful assistant the team trusts with load-bearing changes, operating in the Oh My Pi coding harness.",
	"You are an expert coding assistant operating inside pi, a coding agent harness.",
];

/** omp 的宿主文档入口（单行 bullet，位于 # Internal URLs）。 */
const OMP_DOCS_BULLET = "- `omp://`: harness docs";
/** pi 的宿主文档段起止标记。 */
const PI_DOCS_START = "Pi documentation (read only when the user asks about pi itself";
const PI_DOCS_END = "(e.g., tui.md for TUI API details)";

/**
 * omp 的 before_agent_start 给 string[]；pi 给 string。
 * 统一成一块文本。直接拼接数组会走 Array.toString()，把每段之间变成逗号。
 */
function systemText(value: unknown): string {
	if (Array.isArray(value))
		return value.filter((block): block is string => typeof block === "string").join("\n\n");
	return typeof value === "string" ? value : "";
}

/** 删除包含 index 的整行（含行尾换行）。 */
function cutLine(text: string, index: number): string {
	const lineStart = text.lastIndexOf("\n", index - 1) + 1;
	const lineEnd = text.indexOf("\n", index);
	if (lineEnd === -1) return text.slice(0, lineStart);
	return text.slice(0, lineStart) + text.slice(lineEnd + 1);
}

/**
 * 从系统提示词里切掉宿主身份句和宿主文档段。
 * 全部用固定文案定位，匹配不到就原样返回 —— 宿主升级改文案时退化为 append，
 * 而不是把整段提示词切坏。
 */
function stripHostPersona(systemPrompt: string): { text: string; identity: boolean; docs: boolean } {
	let text = systemPrompt;
	let identity = false;
	let docs = false;

	for (const identityText of HOST_IDENTITIES) {
		const at = text.indexOf(identityText);
		if (at !== -1) {
			text = cutLine(text, at);
			identity = true;
		}
	}

	// omp：单行 `omp://` 文档 bullet
	const bulletAt = text.indexOf(OMP_DOCS_BULLET);
	if (bulletAt !== -1) {
		text = cutLine(text, bulletAt);
		docs = true;
	}

	// pi：整段宿主文档
	const docsAt = text.indexOf(PI_DOCS_START);
	if (docsAt !== -1) {
		const docsEndAt = text.indexOf(PI_DOCS_END, docsAt + PI_DOCS_START.length);
		if (docsEndAt !== -1) {
			let start = docsAt;
			while (start > 0 && text[start - 1] === "\n") start -= 1;
			const lineEnd = text.indexOf("\n", docsEndAt);
			const end = lineEnd === -1 ? text.length : lineEnd + 1;
			text = text.slice(0, start) + text.slice(end);
			docs = true;
		}
	}

	return { text, identity, docs };
}

export default function ompPurge(pi: ExtensionAPI) {
	const reload = (): boolean => {
		if (source === EMBEDDED) {
			body = EMBEDDED_PERSONA;
			loadError = body.length > 0 ? "" : "内嵌人设为空";
			return body.length > 0;
		}
		try {
			if (!existsSync(source)) throw new Error(`文件不存在: ${source}`);
			const text = readFileSync(source, "utf8").trim();
			if (text.length === 0) throw new Error(`文件为空: ${source}`);
			body = text;
			loadError = "";
			return true;
		} catch (error) {
			body = "";
			loadError = error instanceof Error ? error.message : String(error);
			return false;
		}
	};

	const paint = (ctx: { ui?: { setStatus?: (key: string, text?: string) => void } }) => {
		// -p / --mode json 没有 footer，setStatus 不能把会话搞挂
		try {
			ctx.ui?.setStatus?.("omp-purge", enabled ? "PURGE ON" : undefined);
		} catch {
			/* 非交互模式忽略 */
		}
	};

	// 每个会话独立：新会话 / 恢复会话 / 热重载都从"关闭"开始
	pi.on("session_start", async (_event, ctx) => {
		enabled = false;
		lastCut = { identity: false, docs: false, at: 0 };
		reload();
		paint(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled || body.length === 0) return;

		const hostText = systemText(event.systemPrompt);
		let host = hostText;
		if (mode === "strict") {
			// 等价 dsh 的 strict baseline：宿主提示词整段丢掉，只留工作目录。
			// 工具 schema 走 API 的 tools 参数，不依赖这段文字。
			const cwd = ctx?.cwd ?? process.cwd();
			const cut = stripHostPersona(hostText);
			lastCut = { identity: cut.identity, docs: cut.docs, at: Date.now() };
			return {
				systemPrompt: [
					[body, cwd ? `Current working directory: ${String(cwd).replace(/\\/g, "/")}` : ""]
						.filter(Boolean)
						.join("\n\n"),
				],
			};
		}
		if (mode === "replace") {
			const cut = stripHostPersona(host);
			host = cut.text;
			lastCut = { identity: cut.identity, docs: cut.docs, at: Date.now() };
		}
		return { systemPrompt: [host.length > 0 ? `${body}\n\n${host}` : body] };
	});

	pi.registerCommand("purge", {
		description: "会话级提示词开关：清掉宿主身份段并把人设挂到系统提示词头部（omp）",
		getArgumentCompletions: (prefix: string) =>
			["on", "off", "status", "mode", "source", "reload"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args: string, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = (parts[0] ?? "").toLowerCase();
			const arg = parts.slice(1).join(" ").trim();

			const notify = (text: string, level: "info" | "error" = "info") => ctx.ui.notify(text, level);

			if ((cmd === "status" || cmd === "") && body.length === 0) reload();

			const describe = () => {
				const cut =
					lastCut.at === 0
						? "尚未运行过一轮"
						: `身份段 ${lastCut.identity ? "已切除" : "未匹配"} / 宿主文档段 ${lastCut.docs ? "已切除" : "未匹配"}`;
				const modeLabel =
					mode === "strict"
						? "strict（只留人设+工作目录）"
						: mode === "replace"
							? "replace（清宿主身份段）"
							: "append（只挂头部）";
				return [
					`状态: ${enabled ? "开启" : "关闭"}（仅本会话）`,
					`模式: ${modeLabel}`,
					`人设: ${source === EMBEDDED ? "内嵌" : source}${body.length > 0 ? `  ${body.length} 字符` : `  未加载${loadError ? `（${loadError}）` : ""}`}`,
					`上轮切除: ${cut}`,
				].join("\n");
			};

			const turnOn = () => {
				if (!reload()) return notify(`无法开启：${loadError}`, "error");
				enabled = true;
				paint(ctx);
				notify(`已开启（${mode}，仅本会话），每轮注入 ${body.length} 字符。\n${describe()}`);
			};

			const turnOff = () => {
				enabled = false;
				paint(ctx);
				notify("已关闭，恢复 omp 原始系统提示词。");
			};

			switch (cmd) {
				case "":
					if (enabled) turnOff();
					else turnOn();
					return;
				case "on":
				case "enable":
					return turnOn();
				case "off":
				case "disable":
					return turnOff();
				case "status":
					return notify(describe());
				case "reload": {
					if (!reload()) return notify(`重新读取失败：${loadError}`, "error");
					return notify(`人设已重新读取，正文 ${body.length} 字符。\n${describe()}`);
				}
				case "mode": {
					const wanted = arg.toLowerCase();
					if (wanted !== "strict" && wanted !== "replace" && wanted !== "append") {
						return notify(
							`当前模式: ${mode}\n用法: /purge mode strict|replace|append\nstrict  = 只发人设 + 工作目录（隔离最彻底）\nreplace = 清 omp 身份句与 omp:// 文档段\nappend  = 只把人设挂头部`,
							"error",
						);
					}
					mode = wanted as Mode;
					return notify(`模式已切换为 ${wanted}（仅本会话）。\n${describe()}`);
				}
				case "source": {
					if (!arg) {
						return notify(
							`当前人设: ${source === EMBEDDED ? "内嵌" : source}\n用法: /purge source <绝对路径|embedded>\n提示: 常见外部位置 ${HINT_SOURCE}`,
							"error",
						);
					}
					const previous = source;
					source = arg.replace(/^["']|["']$/g, "");
					if (source.toLowerCase() === EMBEDDED) source = EMBEDDED;
					if (!reload()) {
						// 回滚会清掉 loadError，先存下来再恢复，否则报错信息变成空
						const reason = loadError;
						source = previous;
						reload();
						return notify(`切换失败：${reason}`, "error");
					}
					return notify(`人设已切换，正文 ${body.length} 字符。\n${describe()}`);
				}
				default:
					return notify(`未知子命令: ${cmd}\n用法: /purge [on|off|status|mode|source|reload]`);
			}
		},
	});
}
