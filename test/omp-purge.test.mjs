import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 扩展不写任何状态文件；仍然隔离 agent dir，用来证明「跑完目录还是空的」
const AGENT_DIR = mkdtempSync(join(tmpdir(), "omp-purge-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
// 默认源在模块加载时求值：清掉 shell 里可能导出的环境变量，保证本套件跑内嵌源
delete process.env.OMP_PURGE_SOURCE;
delete process.env.PI_PURGE_SOURCE;

// omp src/prompts/system/system-prompt.md 渲染后的真实形态：array of blocks
const REAL_OMP_PROMPT = [
	`<system-conventions>
RFC 2119: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.
</system-conventions>

ROLE
==============
You are a helpful assistant the team trusts with load-bearing changes, operating in the Oh My Pi coding harness.

# Engineering Principles
- Optimize for correctness first, then for the next maintainer six months out.
- You are not alone in this repo. Treat unexpected changes as the user's work and adapt.

RUNTIME
==============

# Internal URLs
Special URLs for internal resources; with most FS/bash tools they auto-resolve to FS paths.
- \`skill://<name>\`: skill instructions; \`/<path>\` = file within
- \`omp://\`: harness docs; AVOID unless the user asks about the harness itself.

# Tool Inventory
- read
- bash`,
	`<project>
## Context
<instructions>
<file path="AGENTS.md"># Rules</file>
</instructions>
</project>

Current working directory: H:/WorkSpace`,
];

const events = new Map();
const commands = new Map();
const notes = [];
const statuses = [];

const pi = {
	on: (name, handler) => events.set(name, handler),
	registerCommand: (name, options) => commands.set(name, options),
};

const mod = await import(pathToFileURL(join(import.meta.dirname, "..", "extensions", "omp-purge.ts")).href);
mod.default(pi);

const ctx = {
	ui: {
		setStatus: (key, text) => statuses.push(text),
		notify: (text, level) => notes.push([level ?? "info", text]),
	},
	cwd: "H:\\WorkSpace",
};
const cmd = commands.get("purge");
const before = events.get("before_agent_start");
const start = events.get("session_start");
const lastNote = () => notes.at(-1)?.[1] ?? "";
const inject = (prompt = REAL_OMP_PROMPT, commandCtx = ctx) => before({ systemPrompt: prompt }, commandCtx);
const textOf = (result) => (result?.systemPrompt ?? []).join("\n");

try {
	// 1. 内嵌人设：不需要任何外部文件就能开
	await start({ reason: "startup" }, ctx);
	assert.equal(await inject(), undefined, "默认关闭，不碰系统提示词");
	await cmd.handler("status", ctx);
	assert.match(lastNote(), /人设: 内嵌/, "默认人设来自内嵌常量");
	assert.match(lastNote(), /状态: 关闭/);
	assert.match(lastNote(), /仅本会话/);

	await cmd.handler("on", ctx);
	assert.equal(statuses.at(-1), "PURGE ON", "footer 显示 PURGE ON");
	const strict = textOf(await inject());
	assert.ok(strict.includes("helpful assistant"), "内嵌人设已注入");
	assert.ok(strict.endsWith("Current working directory: H:/WorkSpace"), "strict 保留 ctx.cwd");
	assert.ok(!strict.includes("Oh My Pi coding harness"), "strict 丢掉 omp 宿主身份句");
	assert.ok(!strict.includes("# Tool Inventory"), "strict 丢掉宿主结构");
	assert.ok(Array.isArray((await inject()).systemPrompt), "omp 原生返回 string[]");

	// 2. 会话级独立：新会话必须归零
	await start({ reason: "new" }, ctx);
	assert.equal(statuses.at(-1), undefined, "新会话 footer 清空状态");
	assert.equal(await inject(), undefined, "新会话不继承上一会话的开启状态");

	// 3. resume 同样归零：状态不落盘，退出即失
	await cmd.handler("on", ctx);
	await start({ reason: "resume" }, ctx);
	assert.equal(await inject(), undefined, "resume 也不继承");

	// 4. 三种模式
	await cmd.handler("on", ctx);

	await cmd.handler("mode replace", ctx);
	const replaced = textOf(await inject());
	assert.ok(!replaced.includes("Oh My Pi coding harness"), "replace 切除 omp 身份句");
	assert.ok(!replaced.includes("- `omp://`: harness docs"), "replace 切除 omp:// 文档段");
	for (const keep of ["# Engineering Principles", "# Tool Inventory", "<project>", "<file path=\"AGENTS.md\">"]) {
		assert.ok(replaced.includes(keep), `replace 保留宿主结构: ${keep}`);
	}
	await cmd.handler("status", ctx);
	assert.match(lastNote(), /身份段 已切除 \/ 宿主文档段 已切除/, "status 反映切除实况");

	await cmd.handler("mode append", ctx);
	const appended = textOf(await inject());
	assert.ok(appended.includes("Oh My Pi coding harness"), "append 不动宿主身份句");
	assert.ok(appended.includes("- `omp://`: harness docs"), "append 不动 omp:// 文档段");
	assert.ok(appended.includes("<project>"), "append 不动项目上下文");

	// 数组块之间必须用空行拼接，不能退化成逗号串
	assert.ok(appended.includes("# Tool Inventory\n- read\n- bash\n\n<project>"), "omp 数组按块拼接，不用逗号");
	assert.ok(!appended.includes("bash,<project>"), "omp 数组不得退化为逗号串");

	// replace 的 pi 旧锚点仍然生效（跨宿主兼容）
	const piPrompt = [
		"You are an expert coding assistant operating inside pi, a coding agent harness.\n\nPi documentation (read only when the user asks about pi itself):\n- docs\n- e.g. (e.g., tui.md for TUI API details)\n\n# Guidelines\n- be concise",
	];
	await cmd.handler("mode replace", ctx);
	const piReplaced = textOf(await inject(piPrompt));
	assert.ok(!piReplaced.includes("expert coding assistant"), "replace 兼容 pi 身份句");
	assert.ok(!piReplaced.includes("Pi documentation"), "replace 兼容 pi 文档段");
	assert.ok(piReplaced.includes("# Guidelines"), "replace 保留 pi 宿主结构");

	await cmd.handler("mode strict", ctx);
	const strictAgain = textOf(await inject());
	for (const gone of ["# Tool Inventory", "# Engineering Principles", "<project>", "`omp://`"]) {
		assert.ok(!strictAgain.includes(gone), `strict 丢掉宿主段: ${gone}`);
	}
	assert.ok(strictAgain.endsWith("Current working directory: H:/WorkSpace"), "strict 只留 cwd");

	// omp 事件不带 cwd：优先 ctx.cwd，缺失时退回进程工作目录
	const ompStrictCtx = await before({ systemPrompt: ["HOST IDENTITY"] }, { ui: ctx.ui });
	assert.ok(
		textOf(ompStrictCtx).endsWith(`Current working directory: ${process.cwd().replace(/\\/g, "/")}`),
		"ctx.cwd 缺失时用 process.cwd() 兜底",
	);

	// 5. 换源失败：报错带原因 + 回滚到内嵌
	await cmd.handler("source C:/definitely/not/here.md", ctx);
	assert.equal(notes.at(-1)[0], "error", "不存在的源报 error");
	assert.match(lastNote(), /文件不存在/, "错误信息带具体原因");
	const afterFail = textOf(await inject());
	assert.ok(afterFail.includes("helpful assistant"), "回滚后仍注入完整内嵌人设");

	// 6. 显式切回内嵌 + reload
	await cmd.handler("source embedded", ctx);
	assert.match(lastNote(), /人设: 内嵌/, "source embedded 切回内嵌");
	await cmd.handler("reload", ctx);
	assert.match(lastNote(), /重新读取/, "reload 重新读取内嵌正文");

	// 7. 自定义 SYSTEM.md（没有身份句/文档段）不能切坏
	const custom = "You are my own assistant.\n\nCurrent working directory: H:/WorkSpace";
	await cmd.handler("mode append", ctx);
	const customOut = textOf(await inject([custom]));
	assert.ok(customOut.includes("You are my own assistant."), "无身份句时原样保留");

	// 8. off
	await cmd.handler("off", ctx);
	assert.equal(await inject(), undefined, "关闭后不再注入");
	assert.equal(statuses.at(-1), undefined, "footer 清空");

	// 9. 无盘副作用：全程没写状态文件
	assert.deepEqual(readdirSync(AGENT_DIR), [], "不写任何状态文件");

	console.log("OK — omp-purge 9 组断言全部通过");
	console.log("内嵌人设注入后:", strict.length, "字符");
} finally {
	rmSync(AGENT_DIR, { recursive: true, force: true });
}
