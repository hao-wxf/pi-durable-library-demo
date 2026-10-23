// The library worker. It is the only process that opens the storage, so it is
// the process the page kills.
//
// It speaks one JSON object per line on stdout; the supervisor relays those
// lines to the browser and writes commands back on stdin:
//
//   {"type":"loan","isbn":"...","borrower":"..."}
//   {"type":"return","isbn":"...","borrower":"..."}
//   {"type":"import","count":24}
//   {"type":"ask","text":"..."}
//
// Run from the project root:
//   node --experimental-strip-types web/worker.ts run --dir .library-web
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	defineExtension,
	Harness,
	hook,
	LiveDoc,
	ROOT_CONVERSATION_ID,
	type TaskGraphState,
	ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createAssistantModels } from "../provider.ts";
import {
	Catalog,
	cancelReservation,
	createBatchLoan,
	createLoanTask,
	createPurchase,
	createReservation,
	decidePurchase,
	findBook,
	ImportProgress,
	Ledger,
	LibraryExtension,
	Purchases,
	Reservations,
	reservationPositions,
	returnBook,
	seedIfEmpty,
	startImport,
	statsOf,
} from "../library.ts";

const context = BACKGROUND_CONTEXT;
const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
	const at = argv.indexOf(`--${name}`);
	return at === -1 ? undefined : argv[at + 1];
}

const command = argv[0] ?? "run";
const directory = resolve(flag("dir") ?? ".library-web");

const { models, provider, modelId, source, faux } = createAssistantModels(
	flag("model") === undefined ? {} : { modelId: flag("model")! },
);

function emit(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** `phase` is absent on the `completing` variant, so fall back to the status word. */
function phaseOf(state: TaskGraphState): string {
	return "phase" in state ? state.phase : state.status;
}

// ── The agent's tool activity, for the assistant's tool chips ──────────────

const Reporter = defineExtension({
	name: "library-reporter",
	hooks: [
		hook(ToolTask, {
			beforeTool: (call) => {
				emit({ type: "agent-tool", phase: "start", name: call.name });
				return undefined;
			},
			afterTool: (call, result) => {
				emit({ type: "agent-tool", phase: "end", name: call.name, isError: result.isError === true });
				return undefined;
			},
		}),
	],
});

const registry = createRegistry();
registry.install(LibraryExtension);
registry.install(Reporter);

async function open(): Promise<Harness> {
	return Harness.open(
		await openNodeSqliteStorage(resolve(directory, "library.sqlite")),
		{
			models,
			registry,
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }),
		},
		context,
	);
}

// ── The state the page renders ──────────────────────────────────────────────

async function stateOf(harness: Harness, conversationId: ConversationId) {
	const [catalog, ledger, progress, reservations, purchases, graph, usage] = await Promise.all([
		harness.snapshot(Catalog, conversationId, context),
		harness.snapshot(Ledger, conversationId, context),
		harness.snapshot(ImportProgress, conversationId, context),
		harness.snapshot(Reservations, conversationId, context),
		harness.snapshot(Purchases, conversationId, context),
		harness.taskGraph(context),
		harness.usage(context),
	]);
	const books = catalog?.books ?? [];
	const loans = ledger?.loans ?? [];
	const now = Date.now();
	const live = Object.values(graph.value.tasks)
		.filter((node) => node.kind.startsWith("library."))
		.map((node) => ({
			id: node.id,
			kind: node.kind,
			status: node.state.status,
			phase: phaseOf(node.state),
			background: node.background,
		}));

	const reservationItems = reservations?.items ?? [];
	const positions = reservationPositions(reservationItems);
	const waitingReservations = reservationItems.filter((item) => item.status === "waiting");
	const reservationRows = reservationItems
		.slice()
		.reverse()
		.slice(0, 20)
		.map((item) => ({ ...item, position: positions.get(item.taskId) }));

	const purchaseItems = purchases?.items ?? [];
	const pendingPurchases = purchaseItems
		.filter((item) => item.status === "pending")
		.slice()
		.sort((left, right) => left.createdAt - right.createdAt);
	const decidedPurchases = purchaseItems
		.filter((item) => item.status !== "pending")
		.slice()
		.sort((left, right) => (right.decidedAt ?? 0) - (left.decidedAt ?? 0))
		.slice(0, 8);

	return {
		stats: {
			...statsOf(books, loans, now),
			reserved: waitingReservations.length,
			pendingPurchases: pendingPurchases.length,
		},
		books,
		loans: loans.slice().reverse().slice(0, 40),
		reservations: reservationRows,
		purchases: [...pendingPurchases, ...decidedPurchases],
		events: (ledger?.events ?? []).slice(-30).reverse(),
		live,
		import: progress ?? { taskId: null, running: false, done: 0, total: 0, current: null },
		usage: usage.models,
	};
}

let lastState = "";

async function emitState(harness: Harness, conversationId: ConversationId): Promise<void> {
	const value = await stateOf(harness, conversationId);
	const json = JSON.stringify(value);
	if (json === lastState) return;
	lastState = json;
	emit({ type: "state", value });
}

function notice(level: "info" | "warn" | "error", text: string): void {
	emit({ type: "notice", level, text });
}

// ── inspect: what survived, read without resuming anything ─────────────────

async function inspect(): Promise<void> {
	const harness = await open();
	const state = await stateOf(harness, ROOT_CONVERSATION_ID);
	const pending = (await harness.inspect(context)).submissions.length;
	const live = await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context);
	// Waiting reservations and purchase approvals are background tasks: they are
	// live, but no interrupted work is sitting in them.
	const working = state.live.some((task) => !task.background);
	const inFlight = live?.run !== undefined || working || state.import.running;
	emit({ type: "inspect", state, pending, inFlight });
	await harness.close(context);
	process.exit(0);
}

// ── run: serve commands, resume interrupted work ───────────────────────────

async function run(): Promise<void> {
	const harness = await open();
	const root = await harness.root(context, {
		agent: { model: { provider, modelId }, cwd: process.cwd() },
	});
	await seedIfEmpty(harness, root.id, context);

	emit({
		type: "hello",
		pid: process.pid,
		provider,
		modelId,
		source,
		directory,
		databasePath: resolve(directory, "library.sqlite"),
	});

	// Stream the committed partial of an in-flight answer.
	const watch = await harness.watchDoc(LiveDoc, root.id, context);
	let printed = "";
	watch?.start(async (value) => {
		const message = value?.generation?.message;
		if (message === undefined) return;
		const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		if (text.length === 0 || text === printed) return;
		emit({ type: "agent", text, reset: !text.startsWith(printed) });
		printed = text;
	});

	const polling = setInterval(() => void emitState(harness, root.id).catch(() => {}), 700);

	/** The committed answer, so the page never depends on a missed partial. */
	async function finalAnswer(conversation: Conversation): Promise<string | undefined> {
		const page = await conversation.entries({ order: "descending" }, 6, undefined, context);
		for (const entry of page.items) {
			for (const message of entry.model ?? []) {
				if (message.role !== "assistant") continue;
				const text = message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
				if (text.trim().length > 0) return text;
			}
		}
		return undefined;
	}

	await emitState(harness, root.id);

	// Anything live in storage is work a previous process did not finish: a
	// loan in its delivery wait, an import between books, or a generation.
	const live = await harness.snapshot(LiveDoc, root.id, context);
	const graph = await harness.taskGraph(context);
	const progress = await harness.snapshot(ImportProgress, root.id, context);
	const working = Object.values(graph.value.tasks).some((node) => !node.background);
	const recovering = live?.run !== undefined || working || progress?.running === true;

	if (recovering) emit({ type: "recovering", value: true });
	harness.resume();
	await harness.waitForIdle(context);
	await emitState(harness, root.id);
	if (recovering) emit({ type: "recovered" });

	// ── Commands ────────────────────────────────────────────────────────────

	let asking = false;
	const queue: string[] = [];

	async function answer(text: string): Promise<void> {
		asking = true;
		emit({ type: "busy", value: true });
		try {
			// The faux provider replays one scripted answer and then runs dry.
			if (faux !== undefined) {
				faux.setResponses([fauxAssistantMessage("(没有配置模型密钥,这是 faux 提供方的固定回答。)")]);
			}
			const submission = await root.submit({ type: "input", content: text }, context);
			const settled = await submission.wait(context);
			const final = await finalAnswer(root);
			if (final !== undefined) {
				printed = final;
				emit({ type: "agent", text: final, reset: true });
			}
			if (settled.status === "unanswered") {
				emit({ type: "turn", status: settled.status, reason: settled.reason });
			} else {
				emit({ type: "turn", status: settled.status });
			}
		} catch (error) {
			emit({ type: "error", text: error instanceof Error ? error.message : String(error) });
		} finally {
			printed = "";
			await emitState(harness, root.id);
			emit({ type: "busy", value: false });
			asking = false;
			const next = queue.shift();
			if (next !== undefined) void answer(next);
		}
	}

	async function lend(isbn: string, borrower: string): Promise<void> {
		const catalog = await harness.snapshot(Catalog, root.id, context);
		const book = findBook(catalog?.books ?? [], isbn);
		if (book === undefined) {
			notice("warn", `馆藏里没有 ${isbn}`);
			return;
		}
		if (book.available <= 0) {
			notice("warn", `《${book.title}》已经没有可借副本`);
			return;
		}
		const taskId = await createLoanTask(harness, root.id, { isbn: book.isbn, borrower }, context);
		harness.resume();
		notice("info", `借阅任务 #${taskId} 已提交:${borrower} 借《${book.title}》。`);
		await emitState(harness, root.id);
	}

	async function giveBack(isbn: string, borrower: string | undefined): Promise<void> {
		const result = await returnBook(harness, root.id, isbn, borrower, context);
		notice(result.ok ? "info" : "warn", result.text);
		await emitState(harness, root.id);
	}

	async function bulkImport(count: number): Promise<void> {
		const progress = await harness.snapshot(ImportProgress, root.id, context);
		if (progress?.running === true) {
			notice("warn", `已有批量入库任务在跑:${progress.done}/${progress.total}`);
			return;
		}
		const taskId = await startImport(harness, root.id, count, context);
		harness.resume();
		notice("info", `批量入库任务 #${taskId} 已启动。`);
		await emitState(harness, root.id);
	}

	async function reserve(isbn: string, reader: string): Promise<void> {
		const result = await createReservation(harness, root.id, isbn, reader, context);
		notice(result.ok ? "info" : "warn", result.text);
		if (result.ok) harness.resume();
		await emitState(harness, root.id);
	}

	async function cancelReservationTask(taskId: number): Promise<void> {
		const result = await cancelReservation(harness, root.id, taskId, context);
		notice(result.ok ? "info" : "warn", result.text);
		harness.resume();
		await emitState(harness, root.id);
	}

	async function submitPurchase(input: {
		title: string;
		author: string;
		category: string;
		copies: number;
		requester: string;
		reason?: string;
	}): Promise<void> {
		const result = await createPurchase(harness, root.id, input, context);
		notice(result.ok ? "info" : "warn", result.text);
		if (result.ok) harness.resume();
		await emitState(harness, root.id);
	}

	async function decidePurchaseTask(taskId: number, approve: boolean): Promise<void> {
		const result = await decidePurchase(harness, root.id, taskId, approve, "馆员", context);
		notice(result.ok ? "info" : "warn", result.text);
		harness.resume();
		await emitState(harness, root.id);
	}

	async function batchLoan(borrower: string, isbns: readonly string[]): Promise<void> {
		const result = await createBatchLoan(harness, root.id, borrower, isbns, context);
		notice(result.ok ? "info" : "warn", result.text);
		if (result.ok) harness.resume();
		await emitState(harness, root.id);
	}

	const readline = createInterface({ input: process.stdin });
	readline.on("line", (line) => {
		if (line.trim().length === 0) return;
		let message: {
			type?: unknown;
			text?: unknown;
			isbn?: unknown;
			borrower?: unknown;
			count?: unknown;
			reader?: unknown;
			taskId?: unknown;
			approve?: unknown;
			title?: unknown;
			author?: unknown;
			category?: unknown;
			copies?: unknown;
			requester?: unknown;
			reason?: unknown;
			isbns?: unknown;
		};
		try {
			message = JSON.parse(line) as typeof message;
		} catch {
			notice("error", "supervisor sent a line that is not JSON");
			return;
		}
		void (async () => {
			switch (message.type) {
				case "ask":
					if (typeof message.text !== "string" || message.text.trim().length === 0) {
						notice("error", "ask 需要 text");
						return;
					}
					if (asking) queue.push(message.text);
					else void answer(message.text);
					return;
				case "loan":
					if (typeof message.isbn !== "string" || typeof message.borrower !== "string") {
						notice("error", "loan 需要 isbn 和 borrower");
						return;
					}
					await lend(message.isbn, message.borrower.trim() || "读者");
					return;
				case "return":
					if (typeof message.isbn !== "string") {
						notice("error", "return 需要 isbn");
						return;
					}
					await giveBack(message.isbn, typeof message.borrower === "string" ? message.borrower : undefined);
					return;
				case "import":
					await bulkImport(typeof message.count === "number" ? message.count : 24);
					return;
				case "reserve":
					if (typeof message.isbn !== "string" || typeof message.reader !== "string") {
						notice("error", "reserve 需要 isbn 和 reader");
						return;
					}
					await reserve(message.isbn, message.reader.trim() || "读者");
					return;
				case "cancel-reservation":
					if (typeof message.taskId !== "number") {
						notice("error", "cancel-reservation 需要 taskId");
						return;
					}
					await cancelReservationTask(message.taskId);
					return;
				case "purchase":
					if (typeof message.title !== "string" || typeof message.author !== "string") {
						notice("error", "purchase 需要 title 和 author");
						return;
					}
					await submitPurchase({
						title: message.title.trim(),
						author: message.author.trim(),
						category:
							typeof message.category === "string" && message.category.trim() ? message.category.trim() : "其他",
						copies: typeof message.copies === "number" ? Math.max(1, Math.round(message.copies)) : 1,
						requester:
							typeof message.requester === "string" && message.requester.trim()
								? message.requester.trim()
								: "馆员",
						...(typeof message.reason === "string" && message.reason.trim()
							? { reason: message.reason.trim() }
							: {}),
					});
					return;
				case "decide-purchase":
					if (typeof message.taskId !== "number" || typeof message.approve !== "boolean") {
						notice("error", "decide-purchase 需要 taskId 和 approve");
						return;
					}
					await decidePurchaseTask(message.taskId, message.approve);
					return;
				case "batch-loan": {
					const isbns: unknown = message.isbns;
					if (
						typeof message.borrower !== "string" ||
						!Array.isArray(isbns) ||
						!isbns.every((value: unknown) => typeof value === "string")
					) {
						notice("error", "batch-loan 需要 borrower 和 isbns");
						return;
					}
					await batchLoan(message.borrower.trim() || "读者", isbns as string[]);
					return;
				}
				default:
					notice("error", "unknown command");
			}
		})().catch((error: unknown) => {
			notice("error", error instanceof Error ? error.message : String(error));
		});
	});

	// The supervisor closing stdin means it is gone; do not leave an orphan
	// holding the storage open.
	let stopping = false;
	const shutdown = (): void => {
		if (stopping) return;
		stopping = true;
		clearInterval(polling);
		void harness.close(context).finally(() => process.exit(0));
	};
	readline.on("close", shutdown);
	process.on("SIGTERM", shutdown);
}

if (command === "inspect") await inspect();
else await run();
