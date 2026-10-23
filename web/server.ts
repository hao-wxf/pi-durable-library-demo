// The supervisor for the library workbench. It serves the page and owns the
// worker process; it never opens the storage itself.
//
// durable's storage contract is one process at a time. The supervisor talks to
// the worker over stdout/stdin, and once the worker is dead it reads the disk
// with a short-lived `inspect` worker. Killing and restarting a process is host
// work, not durable's; everything the page shows about durability comes from
// the worker's commits.
//
//   node --experimental-strip-types web/server.ts [--port 8791] [--dir .library-web]
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, "worker.ts");
const htmlPath = join(here, "index.html");
// The project root, and the cwd the worker is spawned from.
const projectRoot = resolve(here, "..");

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = argv.indexOf(`--${name}`);
	return at === -1 ? undefined : argv[at + 1];
};

const port = Number(flag("port") ?? 8791);
const directory = resolve(flag("dir") ?? ".library-web");
const modelId = flag("model");
const databasePath = join(directory, "library.sqlite");

// ── State mirrored from the worker ──────────────────────────────────────────

type WorkerEvent = { readonly type: string; readonly [key: string]: unknown };
type Note = { readonly text: string; readonly at: number; readonly level: "info" | "warn" | "error" };
type Config = {
	readonly pid: number;
	readonly provider: string;
	readonly modelId: string;
	readonly source: string;
	readonly directory: string;
	readonly databasePath: string;
};

let worker: ChildProcessWithoutNullStreams | undefined;
let inspecting = false;
let killing = false;
let closing = false;
let config: Config | null = null;
let state: unknown = null;
let agentText = "";
let busy = false;
let lastExit: { code: number | null; signal: string | null; killed: boolean; at: number } | null = null;

const notes: Note[] = [];
const clients = new Set<ServerResponse>();

function broadcast(message: unknown): void {
	const frame = `data: ${JSON.stringify(message)}\n\n`;
	for (const client of clients) client.write(frame);
}

/** A lifecycle line for the page's process card; not every turn line belongs here. */
function note(text: string, level: Note["level"] = "info"): void {
	const entry = { text, at: Date.now(), level };
	notes.push(entry);
	if (notes.length > 80) notes.splice(0, notes.length - 80);
	broadcast({ type: "note", ...entry });
}

function snapshot(): Record<string, unknown> {
	return {
		type: "snapshot",
		running: worker !== undefined,
		inspecting,
		pid: worker?.pid ?? null,
		directory,
		databasePath,
		config,
		state,
		agentText,
		busy,
		lastExit,
		notes,
	};
}

// ── Running the worker ──────────────────────────────────────────────────────

function spawnWorker(mode: "run" | "inspect"): void {
	const args = ["--experimental-strip-types", workerPath, mode, "--dir", directory];
	if (modelId !== undefined) args.push("--model", modelId);

	const child = spawn(process.execPath, args, { cwd: projectRoot });
	if (mode === "run") {
		worker = child;
		killing = false;
	} else {
		inspecting = true;
	}

	let buffered = "";
	child.stdout.on("data", (chunk: Buffer) => {
		buffered += chunk.toString("utf8");
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim().length === 0) continue;
			let event: WorkerEvent;
			try {
				event = JSON.parse(line) as WorkerEvent;
			} catch {
				continue;
			}
			handleWorkerEvent(event);
		}
	});

	child.stderr.on("data", (chunk: Buffer) => {
		note(`工作进程错误输出:${chunk.toString("utf8").trimEnd()}`, "error");
	});

	child.on("error", (error) => {
		note(`无法启动工作进程:${error.message}`, "error");
		if (mode === "inspect") inspecting = false;
		else worker = undefined;
	});

	child.on("close", (code, signal) => {
		child.stdout.removeAllListeners();
		child.stderr.removeAllListeners();
		if (mode === "inspect") {
			inspecting = false;
			if (code !== 0) note(`读盘进程异常退出(退出码 ${code})`, "error");
			return;
		}
		worker = undefined;
		busy = false;
		agentText = "";
		lastExit = { code, signal, killed: killing, at: Date.now() };
		killing = false;
		broadcast({ type: "exit", ...lastExit });
		note(
			lastExit.killed ? "工作进程被 SIGKILL 杀掉,没有运行任何清理" : `工作进程结束(退出码 ${code})`,
			lastExit.killed ? "warn" : "info",
		);
		// The worker is gone, so the storage is free. Read what survived through
		// a process that never resumes anything.
		if (!closing) setTimeout(() => spawnInspect(), 150);
	});
}

function handleWorkerEvent(event: WorkerEvent): void {
	switch (event.type) {
		case "hello": {
			if (
				typeof event.pid !== "number" ||
				typeof event.provider !== "string" ||
				typeof event.modelId !== "string" ||
				typeof event.source !== "string" ||
				typeof event.directory !== "string" ||
				typeof event.databasePath !== "string"
			) {
				return;
			}
			config = {
				pid: event.pid,
				provider: event.provider,
				modelId: event.modelId,
				source: event.source,
				directory: event.directory,
				databasePath: event.databasePath,
			};
			note(`工作进程启动 pid ${event.pid},模型 ${event.provider}/${event.modelId}(${event.source})`);
			broadcast({ type: "hello", config });
			return;
		}
		case "state":
			state = event.value;
			broadcast(event);
			return;
		case "agent":
			if (typeof event.text === "string") agentText = event.text;
			broadcast(event);
			return;
		case "busy":
			busy = event.value === true;
			if (busy) agentText = "";
			broadcast(event);
			return;
		case "recovering":
			if (event.value === true) note("存储里有上一进程没做完的工作,正在恢复");
			broadcast(event);
			return;
		case "recovered":
			note("恢复完成:上一进程留下的任务已经从断点跑完");
			// The client commits the resumed answer on this event; a later
			// connection should not see it as an answer without its question.
			agentText = "";
			broadcast(event);
			return;
		case "turn":
			if (event.status === "done") note("AI 助手已答复");
			else note(`AI 助手没有给出答复:${String(event.reason ?? "未知原因")}`, "warn");
			// The client commits the streamed text on this event, so a page that
			// connects later starts from the welcome message instead of showing
			// an answer whose question it no longer has.
			agentText = "";
			broadcast(event);
			return;
		case "inspect":
			state = event.state;
			broadcast(event);
			note(
				event.inFlight === true
					? "读盘完成:存储里还有没做完的任务,重启会从断点继续"
					: "读盘完成:进程不在,馆藏、借阅和入库进度都还在",
				event.inFlight === true ? "warn" : "info",
			);
			return;
		case "notice":
			note(String(event.text ?? ""), event.level === "warn" || event.level === "error" ? event.level : "info");
			broadcast(event);
			return;
		case "error":
			note(`工作进程报告:${String(event.text ?? "未知错误")}`, "error");
			broadcast(event);
			return;
		default:
			broadcast(event);
	}
}

function spawnInspect(): void {
	if (worker !== undefined || inspecting || closing) return;
	spawnWorker("inspect");
}

function startWorker(): void {
	if (worker !== undefined || inspecting || closing) return;
	spawnWorker("run");
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function readBody(request: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) {
		body += chunk.toString();
		if (body.length > 64 * 1024) throw new Error("request body too large");
	}
	return body;
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

const server = createServer((request, response) => {
	void handle(request, response).catch((error: unknown) => {
		json(response, 500, { error: error instanceof Error ? error.message : String(error) });
	});
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const url = new URL(request.url ?? "/", `http://localhost:${port}`);

	if (request.method === "GET" && url.pathname === "/") {
		const html = await readFile(htmlPath, "utf8");
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
		response.end(html);
		return;
	}

	if (request.method === "GET" && url.pathname === "/api/events") {
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		clients.add(response);
		response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
		request.on("close", () => clients.delete(response));
		return;
	}

	if (request.method === "POST" && url.pathname === "/api/start") {
		if (worker !== undefined) {
			json(response, 409, { error: "服务已在运行" });
			return;
		}
		if (inspecting) {
			json(response, 409, { error: "正在同步数据,稍后再试" });
			return;
		}
		note("重新启动工作进程,接着存储里的工作继续");
		startWorker();
		json(response, 202, { ok: true });
		return;
	}

	if (request.method === "POST" && url.pathname === "/api/kill") {
		if (worker === undefined) {
			json(response, 409, { error: "服务未运行" });
			return;
		}
		killing = true;
		worker.kill("SIGKILL");
		json(response, 202, { ok: true });
		return;
	}

	if (request.method === "POST" && url.pathname === "/api/inspect") {
		if (worker !== undefined) {
			json(response, 409, { error: "服务运行中,无需同步" });
			return;
		}
		if (inspecting) {
			json(response, 409, { error: "正在同步数据" });
			return;
		}
		spawnInspect();
		json(response, 202, { ok: true });
		return;
	}

	if (request.method === "POST" && url.pathname === "/api/command") {
		if (worker === undefined) {
			json(response, 409, { error: "服务暂时不可用" });
			return;
		}
		let body: unknown;
		try {
			body = JSON.parse(await readBody(request));
		} catch {
			json(response, 400, { error: "请求不是合法的 JSON" });
			return;
		}
		if (typeof body !== "object" || body === null || !("type" in body)) {
			json(response, 400, { error: "命令需要一个 type" });
			return;
		}
		worker.stdin.write(`${JSON.stringify(body)}\n`);
		json(response, 202, { ok: true });
		return;
	}

	// Start over. Deletes named files one at a time; never a recursive wipe.
	if (request.method === "POST" && url.pathname === "/api/reset") {
		if (worker !== undefined || inspecting) {
			json(response, 409, { error: "先停止服务,再清空" });
			return;
		}
		await mkdir(directory, { recursive: true });
		for (const name of ["library.sqlite", "library.sqlite-wal", "library.sqlite-shm"]) {
			await rm(join(directory, name), { force: true });
		}
		state = null;
		agentText = "";
		busy = false;
		config = null;
		lastExit = null;
		notes.length = 0;
		broadcast({ type: "cleared" });
		note("存储已清空,启动新的工作进程");
		startWorker();
		json(response, 200, { ok: true });
		return;
	}

	json(response, 404, { error: "not found" });
}

await mkdir(directory, { recursive: true });

server.listen(port, () => {
	console.log("durable 图书管理工作台");
	console.log(`  打开    http://localhost:${port}`);
	console.log(`  存储    ${databasePath}`);
	console.log("");
	console.log("杀掉 = 对工作进程发 SIGKILL,Windows 上是 TerminateProcess,不跑任何清理。");
	console.log("监督者不属于 durable,它是宿主必须自己提供的那一部分。");
	startWorker();
});

// Take the worker down with the server, so no orphan keeps the storage open.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		closing = true;
		worker?.kill("SIGKILL");
		server.close();
		process.exit(0);
	});
}
