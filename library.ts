// The durable half of the library workbench.
//
// Everything the page shows comes from committed state:
//
//   Catalog          every book, its total copies and its shelf stock
//   Ledger           loans and a short activity log
//   ImportProgress   committed progress of the long-running import
//   Reservations     the queue, including who took a returned copy
//   Purchases        requests waiting for a human decision and their results
//
// Five tasks make the recovery story concrete:
//
//   Loan         check -> reserve -> deliver, with a five-second window between
//                "the copy is taken" and "the loan is confirmed". Killing the
//                worker inside that window cannot take the copy twice, because
//                reserve is one commit and deliver resumes from the checkpoint.
//   Import       one commit per imported book. Killing it mid-run keeps every
//                book already committed and resumes at the next one.
//   Reservation  waits for a copy to come back. The committed queue entry and
//                the task checkpoint are the wait; a restart keeps waiting, and
//                the copy is handed to the reader in one atomic commit.
//   Purchase     waits for a human decision. Approving is a commit; the task
//                then adds the books in one commit. A restart while waiting
//                keeps the request pending and still applies it once approved.
//   Batch loan   one parent task, one child per book, joined with failFast. If
//                one book has no copy, the other children are aborted and their
//                abort handlers release the copies they reserved.
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";
import {
	type ConversationId,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type Harness,
	section,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";

// ── Documents ───────────────────────────────────────────────────────────────

export type Book = {
	isbn: string;
	title: string;
	author: string;
	category: string;
	total: number;
	available: number;
};

export type CatalogState = { books: Book[] };

export const Catalog = defineDoc<CatalogState>({
	kind: "library.catalog",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ books: [] }),
});

export type LoanStatus = "borrowing" | "active" | "returned" | "cancelled";

export type Loan = {
	/** Stable for the UI; matches the loan task that produced it. */
	id: string;
	taskId: number;
	isbn: string;
	title: string;
	borrower: string;
	borrowedAt: number;
	dueAt: number;
	returnedAt?: number;
	status: LoanStatus;
};

export type Activity = { at: number; kind: string; text: string };

export type LedgerState = { loans: Loan[]; events: Activity[] };

export const Ledger = defineDoc<LedgerState>({
	kind: "library.ledger",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ loans: [], events: [] }),
});

export type ImportState = {
	taskId: number | null;
	running: boolean;
	done: number;
	total: number;
	current: string | null;
};

export const ImportProgress = defineDoc<ImportState>({
	kind: "library.import-progress",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ taskId: null, running: false, done: 0, total: 0, current: null }),
});

export type ReservationStatus = "waiting" | "fulfilled" | "cancelled";

export type Reservation = {
	id: string;
	taskId: TaskId;
	isbn: string;
	title: string;
	reader: string;
	createdAt: number;
	status: ReservationStatus;
	fulfilledAt?: number;
	cancelledAt?: number;
	loanId?: string;
};

export type ReservationsState = { items: Reservation[] };

export const Reservations = defineDoc<ReservationsState>({
	kind: "library.reservations",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ items: [] }),
});

export type PurchaseStatus = "pending" | "approved" | "rejected" | "cancelled";

export type Purchase = {
	id: string;
	taskId: TaskId;
	title: string;
	author: string;
	category: string;
	copies: number;
	requester: string;
	reason?: string;
	createdAt: number;
	status: PurchaseStatus;
	decidedAt?: number;
	/** Set when the approved request has been added to the catalog. */
	bookIsbn?: string;
};

export type PurchasesState = { items: Purchase[] };

export const Purchases = defineDoc<PurchasesState>({
	kind: "library.purchases",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ items: [] }),
});

const DAY = 24 * 60 * 60 * 1000;
export const LOAN_DAYS = 14;
export const RESERVATION_POLL_MS = 2000;
export const PURCHASE_POLL_MS = 1200;
const BATCH_ITEM_DELAY_MS = 1800;

/** A loan that still holds a copy: being confirmed, or confirmed and not yet returned. */
export function isOpenLoan(loan: Loan): boolean {
	return loan.status === "borrowing" || loan.status === "active";
}

function pushActivity(ledger: LedgerState, kind: string, text: string, at: number): void {
	ledger.events.push({ at, kind, text });
	if (ledger.events.length > 100) ledger.events.splice(0, ledger.events.length - 100);
}

// ── Seed catalog ────────────────────────────────────────────────────────────

type SeedBook = Omit<Book, "available">;

const SEED_BOOKS: readonly SeedBook[] = [
	{ isbn: "978-7-115-001", title: "深入理解计算机系统", author: "Randal E. Bryant", category: "计算机", total: 3 },
	{ isbn: "978-7-115-002", title: "设计数据密集型应用", author: "Martin Kleppmann", category: "计算机", total: 2 },
	{ isbn: "978-7-115-003", title: "重构:改善既有代码的设计", author: "Martin Fowler", category: "软件工程", total: 3 },
	{ isbn: "978-7-115-004", title: "代码大全", author: "Steve McConnell", category: "软件工程", total: 2 },
	{ isbn: "978-7-115-005", title: "人月神话", author: "Frederick P. Brooks", category: "软件工程", total: 1 },
	{ isbn: "978-7-115-006", title: "计算机程序的构造和解释", author: "Harold Abelson", category: "计算机", total: 2 },
	{ isbn: "978-7-115-007", title: "算法导论", author: "Thomas H. Cormen", category: "计算机", total: 2 },
	{ isbn: "978-7-115-008", title: "设计模式", author: "Erich Gamma", category: "软件工程", total: 2 },
	{ isbn: "978-7-115-009", title: "百年孤独", author: "Gabriel García Márquez", category: "文学", total: 4 },
	{ isbn: "978-7-115-010", title: "活着", author: "余华", category: "文学", total: 3 },
	{ isbn: "978-7-115-011", title: "人类简史", author: "尤瓦尔·赫拉利", category: "历史", total: 2 },
	{ isbn: "978-7-115-012", title: "思考,快与慢", author: "Daniel Kahneman", category: "心理", total: 2 },
];

/** Seed once. A second start must not duplicate the shelf or the loans. */
export async function seedIfEmpty(harness: Harness, conversationId: ConversationId, context: Context): Promise<void> {
	const current = await harness.snapshot(Catalog, conversationId, context);
	if ((current?.books.length ?? 0) > 0) return;
	await harness.commit(async (tx) => {
		const now = Date.now();
		const catalog = await tx.doc(Catalog, conversationId);
		const ledger = await tx.doc(Ledger, conversationId);
		catalog.books = SEED_BOOKS.map((book) => ({ ...book, available: book.total }));

		// Two loans, so the tables are not empty on the first screen. One is
		// overdue, which exercises the computed status in the page.
		const borrowed: { isbn: string; borrower: string; daysAgo: number; dueInDays: number }[] = [
			{ isbn: "978-7-115-003", borrower: "张三", daysAgo: 5, dueInDays: 9 },
			{ isbn: "978-7-115-005", borrower: "李四", daysAgo: 20, dueInDays: -6 },
		];
		for (const item of borrowed) {
			const book = catalog.books.find((entry) => entry.isbn === item.isbn);
			if (book === undefined) continue;
			book.available -= 1;
			ledger.loans.push({
				id: `seed-${item.isbn}-${item.borrower}`,
				taskId: -1,
				isbn: book.isbn,
				title: book.title,
				borrower: item.borrower,
				borrowedAt: now - item.daysAgo * DAY,
				dueAt: now + item.dueInDays * DAY,
				status: "active",
			});
		}

		// One reader is already waiting for the only copy of a borrowed title.
		// Returning 李四's copy later lets the reservation task fulfill itself.
		const reserved = catalog.books.find((entry) => entry.isbn === "978-7-115-005");
		if (reserved !== undefined) {
			const reservations = await tx.doc(Reservations, conversationId);
			const taskId = await tx.createTask(
				ReservationTask,
				{ isbn: reserved.isbn, reader: "王五" },
				{ ownership: { kind: "conversation" }, conversationId, background: true },
			);
			reservations.items.push({
				id: `reservation-${taskId}`,
				taskId,
				isbn: reserved.isbn,
				title: reserved.title,
				reader: "王五",
				createdAt: now,
				status: "waiting",
			});
		}

		pushActivity(ledger, "seed", `馆藏初始化:${catalog.books.length} 种图书,2 条借阅记录,1 条预约`, now);
	}, context);
}

// ── Loan task ───────────────────────────────────────────────────────────────

export type LoanInput = { isbn: string; borrower: string };
export type LoanCheckpoint = { phase: "check" | "reserve" | "deliver" };
/** A completed loan, or a short explanation when the shelf ran out. */
export type LoanResult = { isbn: string; title: string; borrower: string } | string;

export const LoanTask = defineTask<LoanInput, LoanCheckpoint, LoanResult>({
	name: "library.loan",
	version: 1,
	initial: () => ({ phase: "check" }),

	phases: {
		check: async (task, runtime, context) => {
			const catalog = await runtime.snapshot(Catalog, runtime.conversationId, context);
			const book = catalog?.books.find((entry) => entry.isbn === task.input.isbn);
			if (book === undefined || book.available <= 0) {
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: `《${book?.title ?? task.input.isbn}》没有可借的副本` },
					}),
					context,
				);
				return;
			}
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "reserve" } }), context);
		},

		// One commit takes the copy, records the borrower and moves the loan to
		// "borrowing". There is no kill point between those three facts.
		reserve: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const catalog = await tx.doc(Catalog, runtime.conversationId);
				const ledger = await tx.doc(Ledger, runtime.conversationId);
				const book = catalog.books.find((entry) => entry.isbn === task.input.isbn);
				if (book === undefined || book.available <= 0) {
					return {
						status: "terminal",
						outcome: { status: "completed", result: "库存已在这一刻被借完" },
					} as const;
				}
				const now = runtime.now();
				book.available -= 1;
				ledger.loans.push({
					id: `loan-${task.id}`,
					taskId: task.id,
					isbn: book.isbn,
					title: book.title,
					borrower: task.input.borrower,
					borrowedAt: now,
					dueAt: now + LOAN_DAYS * DAY,
					status: "borrowing",
				});
				pushActivity(ledger, "loan", `${task.input.borrower} 借出《${book.title}》,正在确认`, now);
				return { status: "running", checkpoint: { phase: "deliver" } } as const;
			}, context);

			// The copy is already committed. This wait is the demonstration
			// window: kill the worker now and restart, and deliver resumes.
			await runtime.sleep(runtime.now() + 5000, context);
		},

		deliver: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const catalog = await tx.doc(Catalog, runtime.conversationId);
				const ledger = await tx.doc(Ledger, runtime.conversationId);
				const book = catalog.books.find((entry) => entry.isbn === task.input.isbn);
				const loan = ledger.loans.find((entry) => entry.taskId === task.id);
				if (loan !== undefined && loan.status === "borrowing") {
					loan.status = "active";
					pushActivity(
						ledger,
						"loan",
						`${task.input.borrower} 借阅完成:《${book?.title ?? task.input.isbn}》,${LOAN_DAYS} 天后归还`,
						runtime.now(),
					);
				}
				return {
					status: "terminal",
					outcome: {
						status: "completed",
						result: {
							isbn: task.input.isbn,
							title: book?.title ?? task.input.isbn,
							borrower: task.input.borrower,
						},
					},
				} as const;
			}, context);
		},
	},

	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

// ── Import task ─────────────────────────────────────────────────────────────

export type ImportSeed = { isbn: string; title: string; author: string; category: string; copies: number };
export type ImportInput = { books: readonly ImportSeed[]; delayMs: number };
export type ImportCheckpoint = { phase: "work"; index: number };
export type ImportResult = { imported: number };

export const ImportTask = defineTask<ImportInput, ImportCheckpoint, ImportResult>({
	name: "library.import",
	version: 1,
	initial: () => ({ phase: "work", index: 0 }),

	phases: {
		work: async (task, runtime, context) => {
			const { index } = task.state.checkpoint;
			const seed = task.input.books[index];

			if (seed === undefined) {
				await runtime.commit(async (tx) => {
					const progress = await tx.doc(ImportProgress, runtime.conversationId);
					const ledger = await tx.doc(Ledger, runtime.conversationId);
					progress.running = false;
					progress.current = null;
					pushActivity(ledger, "import", `批量入库完成:${task.input.books.length} 本`, runtime.now());
					return {
						status: "terminal",
						outcome: { status: "completed", result: { imported: task.input.books.length } },
					} as const;
				}, context);
				return;
			}

			// Real time passes before the commit, so a kill here simply loses the
			// book in flight; every earlier book is already stored.
			await runtime.sleep(runtime.now() + task.input.delayMs, context);

			await runtime.commit(async (tx) => {
				const catalog = await tx.doc(Catalog, runtime.conversationId);
				const progress = await tx.doc(ImportProgress, runtime.conversationId);
				const existing = catalog.books.find((entry) => entry.isbn === seed.isbn);
				if (existing === undefined) {
					catalog.books.push({
						isbn: seed.isbn,
						title: seed.title,
						author: seed.author,
						category: seed.category,
						total: seed.copies,
						available: seed.copies,
					});
				} else {
					existing.total += seed.copies;
					existing.available += seed.copies;
				}
				progress.done = index + 1;
				progress.current = task.input.books[index + 1]?.title ?? null;
				return { status: "running", checkpoint: { phase: "work", index: index + 1 } } as const;
			}, context);
		},
	},

	abort: async (_task, runtime, context) => {
		await runtime.commit(async (tx) => {
			const progress = await tx.doc(ImportProgress, runtime.conversationId);
			progress.running = false;
			progress.current = null;
			return { status: "terminal", outcome: { status: "aborted" } } as const;
		}, context);
	},
});

// ── Reservation task ────────────────────────────────────────────────────────

export type ReservationInput = { isbn: string; reader: string };
export type ReservationResult = { isbn: string; title: string; reader: string; loanId: string };

/**
 * The wait is committed, not timed in memory. The task re-checks the shelf every
 * couple of seconds; a killed worker leaves the task running in storage, and the
 * next process resumes the same wait. When a copy appears, the stock decrement,
 * the loan record, and the queue entry's `fulfilled` status land in one commit,
 * so two waiting readers can never take the same copy.
 */
export const ReservationTask = defineTask<ReservationInput, { phase: "watch" }, ReservationResult>({
	name: "library.reservation",
	version: 1,
	initial: () => ({ phase: "watch" }),

	phases: {
		watch: async (task, runtime, context) => {
			for (;;) {
				const catalog = await runtime.snapshot(Catalog, runtime.conversationId, context);
				const book = catalog?.books.find((entry) => entry.isbn === task.input.isbn);
				if (book === undefined) {
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: { status: "failed", error: { message: "这本书已经不在馆藏里" } },
						}),
						context,
					);
					return;
				}

				if (book.available > 0) {
					const now = runtime.now();
					let result: ReservationResult | undefined;
					await runtime.commit(async (tx) => {
						const currentCatalog = await tx.doc(Catalog, runtime.conversationId);
						const ledger = await tx.doc(Ledger, runtime.conversationId);
						const reservations = await tx.doc(Reservations, runtime.conversationId);
						const target = currentCatalog.books.find((entry) => entry.isbn === task.input.isbn);
						const reservation = reservations.items.find((entry) => entry.taskId === task.id);
						// Another waiter may have taken the copy between the read and
						// this commit. Leaving the state unchanged loops and waits again.
						if (target === undefined || target.available <= 0) return undefined;
						if (reservation === undefined || reservation.status !== "waiting") return undefined;
						// Queue order is part of the commit: only the oldest waiting entry
						// for this title may take a returned copy.
						const earlier = reservations.items.some(
							(entry) =>
								entry.status === "waiting" &&
								entry.isbn === reservation.isbn &&
								(entry.createdAt < reservation.createdAt ||
									(entry.createdAt === reservation.createdAt && entry.taskId < reservation.taskId)),
						);
						if (earlier) return undefined;

						target.available -= 1;
						const loanId = `loan-${task.id}`;
						ledger.loans.push({
							id: loanId,
							taskId: task.id,
							isbn: target.isbn,
							title: target.title,
							borrower: task.input.reader,
							borrowedAt: now,
							dueAt: now + LOAN_DAYS * DAY,
							status: "active",
						});
						reservation.status = "fulfilled";
						reservation.fulfilledAt = now;
						reservation.loanId = loanId;
						const fulfilled: ReservationResult = {
							isbn: target.isbn,
							title: target.title,
							reader: task.input.reader,
							loanId,
						};
						result = fulfilled;
						pushActivity(
							ledger,
							"reserve",
							`${task.input.reader} 预约的《${target.title}》已到馆,自动转为借阅`,
							now,
						);
						return {
							status: "terminal",
							outcome: { status: "completed", result: fulfilled },
						} as const;
					}, context);
					if (result !== undefined) return;
				}

				await runtime.sleep(runtime.now() + RESERVATION_POLL_MS, context);
			}
		},
	},

	abort: async (task, runtime, context) => {
		await runtime.commit(async (tx) => {
			const reservations = await tx.doc(Reservations, runtime.conversationId);
			const ledger = await tx.doc(Ledger, runtime.conversationId);
			const reservation = reservations.items.find((entry) => entry.taskId === task.id);
			if (reservation !== undefined && reservation.status === "waiting") {
				reservation.status = "cancelled";
				reservation.cancelledAt = runtime.now();
				pushActivity(ledger, "reserve", `${reservation.reader} 取消预约《${reservation.title}》`, runtime.now());
			}
			return { status: "terminal", outcome: { status: "aborted" } } as const;
		}, context);
	},
});

// ── Purchase task ───────────────────────────────────────────────────────────

export type PurchaseInput = {
	title: string;
	author: string;
	category: string;
	copies: number;
	requester: string;
	reason?: string;
};
export type PurchaseState = { phase: "review" } | { phase: "apply" };
export type PurchaseResult = { title: string; copies: number; outcome: "shelved" | "rejected" };

/**
 * `review` polls the purchase document until a person approves or rejects the
 * request. The decision is a normal commit; the task then applies it. A crash
 * while review is pending loses nothing: the request stays `pending`, and on
 * restart the task resumes polling. Approval and shelving are separate commits,
 * so a crash between them applies the purchase exactly once on resume.
 */
export const PurchaseTask = defineTask<PurchaseInput, PurchaseState, PurchaseResult>({
	name: "library.purchase",
	version: 1,
	initial: () => ({ phase: "review" }),

	phases: {
		review: async (task, runtime, context) => {
			for (;;) {
				const purchases = await runtime.snapshot(Purchases, runtime.conversationId, context);
				const request = purchases?.items.find((entry) => entry.taskId === task.id);
				if (request === undefined) {
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: { status: "failed", error: { message: "采购申请记录不存在" } },
						}),
						context,
					);
					return;
				}
				if (request.status === "approved") {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "apply" } }), context);
					return;
				}
				if (request.status === "rejected" || request.status === "cancelled") {
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: {
								status: "completed",
								result: { title: request.title, copies: request.copies, outcome: "rejected" },
							},
						}),
						context,
					);
					return;
				}
				await runtime.sleep(runtime.now() + PURCHASE_POLL_MS, context);
			}
		},

		apply: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const catalog = await tx.doc(Catalog, runtime.conversationId);
				const ledger = await tx.doc(Ledger, runtime.conversationId);
				const purchases = await tx.doc(Purchases, runtime.conversationId);
				const request = purchases.items.find((entry) => entry.taskId === task.id);
				if (request === undefined) {
					return {
						status: "terminal",
						outcome: { status: "failed", error: { message: "采购申请记录不存在" } },
					} as const;
				}
				const existing = catalog.books.find((entry) => entry.title === request.title);
				let isbn: string;
				if (existing !== undefined) {
					existing.total += request.copies;
					existing.available += request.copies;
					isbn = existing.isbn;
				} else {
					isbn = `PO-${task.id}`;
					catalog.books.push({
						isbn,
						title: request.title,
						author: request.author,
						category: request.category,
						total: request.copies,
						available: request.copies,
					});
				}
				request.bookIsbn = isbn;
				pushActivity(ledger, "purchase", `采购入库:《${request.title}》${request.copies} 本`, runtime.now());
				return {
					status: "terminal",
					outcome: {
						status: "completed",
						result: { title: request.title, copies: request.copies, outcome: "shelved" },
					},
				} as const;
			}, context);
		},
	},

	abort: async (task, runtime, context) => {
		await runtime.commit(async (tx) => {
			const purchases = await tx.doc(Purchases, runtime.conversationId);
			const request = purchases.items.find((entry) => entry.taskId === task.id);
			if (request !== undefined && request.status === "pending") {
				request.status = "cancelled";
				request.decidedAt = runtime.now();
			}
			return { status: "terminal", outcome: { status: "aborted" } } as const;
		}, context);
	},
});

// ── Batch loan tasks ────────────────────────────────────────────────────────

export type BatchLoanInput = { borrower: string; isbns: readonly string[] };
export type BatchLoanState = { phase: "prepare" } | { phase: "decide"; items: readonly TaskId<BatchItemResult>[] };
export type BatchLoanResult = { borrowed: number };

export type BatchItemInput = { isbn: string; borrower: string };
export type BatchItemState = { phase: "check" } | { phase: "reserve" } | { phase: "finish" };
export type BatchItemResult = { isbn: string; title: string };

/**
 * One book of a batch loan. It reserves its copy in one commit, waits, then
 * confirms. The wait after reserve is the window in which a sibling failure can
 * abort it; `abort` puts the copy back, so a failed batch leaves no held stock.
 */
export const BatchLoanItemTask = defineTask<BatchItemInput, BatchItemState, BatchItemResult>({
	name: "library.batch-loan-item",
	version: 1,
	initial: () => ({ phase: "check" }),

	phases: {
		check: async (task, runtime, context) => {
			const catalog = await runtime.snapshot(Catalog, runtime.conversationId, context);
			const book = catalog?.books.find((entry) => entry.isbn === task.input.isbn);
			if (book === undefined || book.available <= 0) {
				const message = `《${book?.title ?? task.input.isbn}》没有可借副本`;
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "failed", error: { message } } }),
					context,
				);
				return;
			}
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "reserve" } }), context);
		},

		reserve: async (task, runtime, context) => {
			const now = runtime.now();
			await runtime.commit(async (tx) => {
				const catalog = await tx.doc(Catalog, runtime.conversationId);
				const ledger = await tx.doc(Ledger, runtime.conversationId);
				const book = catalog.books.find((entry) => entry.isbn === task.input.isbn);
				if (book === undefined || book.available <= 0) {
					const message = `《${book?.title ?? task.input.isbn}》没有可借副本`;
					return { status: "terminal", outcome: { status: "failed", error: { message } } } as const;
				}
				book.available -= 1;
				ledger.loans.push({
					id: `loan-${task.id}`,
					taskId: task.id,
					isbn: book.isbn,
					title: book.title,
					borrower: task.input.borrower,
					borrowedAt: now,
					dueAt: now + LOAN_DAYS * DAY,
					status: "borrowing",
				});
				return { status: "running", checkpoint: { phase: "finish" } } as const;
			}, context);

			// A sibling can fail while this copy is already taken. The abort
			// handler below is the compensation for that window.
			await runtime.sleep(runtime.now() + BATCH_ITEM_DELAY_MS, context);
		},

		finish: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const catalog = await tx.doc(Catalog, runtime.conversationId);
				const ledger = await tx.doc(Ledger, runtime.conversationId);
				const loan = ledger.loans.find((entry) => entry.taskId === task.id);
				const book = catalog.books.find((entry) => entry.isbn === task.input.isbn);
				if (loan !== undefined) loan.status = "active";
				return {
					status: "terminal",
					outcome: {
						status: "completed",
						result: { isbn: task.input.isbn, title: book?.title ?? task.input.isbn },
					},
				} as const;
			}, context);
		},
	},

	abort: async (task, runtime, context) => {
		await runtime.commit(async (tx) => {
			const catalog = await tx.doc(Catalog, runtime.conversationId);
			const ledger = await tx.doc(Ledger, runtime.conversationId);
			const loan = ledger.loans.find((entry) => entry.taskId === task.id);
			if (loan !== undefined && loan.status === "borrowing") {
				loan.status = "cancelled";
				const book = catalog.books.find((entry) => entry.isbn === loan.isbn);
				if (book !== undefined) book.available = Math.min(book.total, book.available + 1);
				pushActivity(ledger, "batch", `${loan.borrower} 的批量借阅未完成,已释放《${loan.title}》`, runtime.now());
			}
			return { status: "terminal", outcome: { status: "aborted" } } as const;
		}, context);
	},
});

/**
 * The parent creates one child per book and waits with `failFast`. The first
 * failed child aborts the rest, and their abort handlers run before the parent
 * resumes in `decide`, so the parent reports a batch that left no copy held.
 */
export const BatchLoanTask = defineTask<BatchLoanInput, BatchLoanState, BatchLoanResult>({
	name: "library.batch-loan",
	version: 1,
	initial: () => ({ phase: "prepare" }),

	phases: {
		prepare: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const items: TaskId<BatchItemResult>[] = [];
				for (const isbn of task.input.isbns) {
					items.push(
						await tx.createTask(
							BatchLoanItemTask,
							{ isbn, borrower: task.input.borrower },
							{ ownership: { kind: "task", taskId: task.id } },
						),
					);
				}
				const ledger = await tx.doc(Ledger, runtime.conversationId);
				pushActivity(ledger, "batch", `${task.input.borrower} 批量借阅 ${items.length} 本,开始办理`, runtime.now());
				return {
					status: "waiting",
					checkpoint: { phase: "decide", items },
					on: items,
					policy: "failFast",
				} as const;
			}, context);
		},

		decide: async (task, runtime, context) => {
			const outcomes = await runtime.outcomes(task.state.checkpoint.items, context);
			await runtime.commit(async (tx) => {
				const ledger = await tx.doc(Ledger, runtime.conversationId);
				const failed = outcomes.filter((outcome) => outcome.status !== "completed");
				if (failed.length > 0) {
					const reasons = failed
						.filter((outcome) => outcome.status === "failed")
						.map((outcome) => (outcome.status === "failed" ? outcome.error.message : ""))
						.filter((message) => message.length > 0);
					pushActivity(
						ledger,
						"batch",
						`${task.input.borrower} 的批量借阅失败:${reasons[0] ?? `${failed.length} 本没有借成`},已借副本全部退回`,
						runtime.now(),
					);
					return {
						status: "terminal",
						outcome: {
							status: "failed",
							error: {
								message: `${reasons[0] ?? "有图书没有可借副本"},这一批已取消,已登记的副本已退回`,
							},
						},
					} as const;
				}
				pushActivity(ledger, "batch", `${task.input.borrower} 批量借阅完成:${outcomes.length} 本`, runtime.now());
				return {
					status: "terminal",
					outcome: { status: "completed", result: { borrowed: outcomes.length } },
				} as const;
			}, context);
		},
	},

	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/** The shelf of books the bulk import walks through. */
const BULK_TITLES: readonly { title: string; author: string; category: string }[] = [
	{ title: "Effective TypeScript", author: "Dan Vanderkam", category: "计算机" },
	{ title: "领域驱动设计", author: "Eric Evans", category: "软件工程" },
	{ title: "持续交付", author: "Jez Humble", category: "软件工程" },
	{ title: "SRE:Google 运维解密", author: "Betsy Beyer", category: "运维" },
	{ title: "数据库系统概念", author: "Abraham Silberschatz", category: "计算机" },
	{ title: "编译原理", author: "Alfred V. Aho", category: "计算机" },
	{ title: "操作系统导论", author: "Remzi H. Arpaci-Dusseau", category: "计算机" },
	{ title: "计算机网络:自顶向下方法", author: "James F. Kurose", category: "计算机" },
	{ title: "Head First 设计模式", author: "Eric Freeman", category: "软件工程" },
	{ title: "凤凰项目", author: "Gene Kim", category: "运维" },
	{ title: "独角兽项目", author: "Gene Kim", category: "运维" },
	{ title: "架构整洁之道", author: "Robert C. Martin", category: "软件工程" },
	{ title: "修改代码的艺术", author: "Michael Feathers", category: "软件工程" },
	{ title: "编程珠玑", author: "Jon Bentley", category: "计算机" },
	{ title: "代码整洁之道", author: "Robert C. Martin", category: "软件工程" },
	{ title: "图解 HTTP", author: "上野宣", category: "计算机" },
	{ title: "黑客与画家", author: "Paul Graham", category: "随笔" },
	{ title: "沉默的大多数", author: "王小波", category: "文学" },
	{ title: "围城", author: "钱钟书", category: "文学" },
	{ title: "平凡的世界", author: "路遥", category: "文学" },
	{ title: "枪炮、病菌与钢铁", author: "Jared Diamond", category: "历史" },
	{ title: "万历十五年", author: "黄仁宇", category: "历史" },
	{ title: "影响力", author: "Robert B. Cialdini", category: "心理" },
	{ title: "心流", author: "Mihaly Csikszentmihalyi", category: "心理" },
];

export function bulkSeeds(count: number): ImportSeed[] {
	const total = Math.max(1, Math.min(count, BULK_TITLES.length));
	return Array.from({ length: total }, (_, index) => {
		const template = BULK_TITLES[index]!;
		return {
			isbn: `BULK-${String(index + 1).padStart(2, "0")}`,
			title: template.title,
			author: template.author,
			category: template.category,
			copies: 1 + (index % 3),
		};
	});
}

export const IMPORT_DELAY_MS = 450;

// ── Operations shared by the worker and the agent's tools ───────────────────

export type OperationResult = { ok: boolean; text: string };

export function findBook(books: readonly Book[], query: string): Book | undefined {
	const needle = query.trim().toLowerCase();
	return books.find(
		(book) =>
			book.isbn.toLowerCase() === needle ||
			book.title.toLowerCase().includes(needle) ||
			book.author.toLowerCase().includes(needle),
	);
}

export async function createLoanTask(
	harness: Harness,
	conversationId: ConversationId,
	input: LoanInput,
	context: Context,
): Promise<TaskId<LoanResult>> {
	return harness.commit(
		(tx) => tx.createTask(LoanTask, input, { ownership: { kind: "conversation" }, conversationId }),
		context,
	);
}

function createImportInTx(tx: Tx, conversationId: ConversationId, count: number): Promise<TaskId<ImportResult>> {
	return (async () => {
		const books = bulkSeeds(count);
		const ledger = await tx.doc(Ledger, conversationId);
		const taskId = await tx.createTask(
			ImportTask,
			{ books, delayMs: IMPORT_DELAY_MS },
			{ ownership: { kind: "conversation" }, conversationId },
		);
		const progress = await tx.doc(ImportProgress, conversationId);
		progress.taskId = taskId;
		progress.running = true;
		progress.done = 0;
		progress.total = books.length;
		progress.current = books[0]?.title ?? null;
		pushActivity(ledger, "import", `开始批量入库:${books.length} 本`, Date.now());
		return taskId;
	})();
}

export async function startImport(
	harness: Harness,
	conversationId: ConversationId,
	count: number,
	context: Context,
): Promise<TaskId<ImportResult>> {
	return harness.commit((tx) => createImportInTx(tx, conversationId, count), context);
}

// ── Reservations, purchases, batch loans ────────────────────────────────────

export type CreateResult = OperationResult & { taskId?: number };

function createReservationInTx(
	tx: Tx,
	conversationId: ConversationId,
	query: string,
	reader: string,
): Promise<CreateResult> {
	return (async () => {
		const catalog = await tx.doc(Catalog, conversationId);
		const ledger = await tx.doc(Ledger, conversationId);
		const reservations = await tx.doc(Reservations, conversationId);
		const book = findBook(catalog.books, query);
		if (book === undefined) return { ok: false, text: `馆藏里没有"${query}"` };
		if (book.available > 0) {
			return { ok: false, text: `《${book.title}》还有 ${book.available} 本可借,可以直接借出` };
		}
		const duplicate = reservations.items.find(
			(item) => item.isbn === book.isbn && item.reader === reader && item.status === "waiting",
		);
		if (duplicate !== undefined) return { ok: false, text: `${reader} 已经在等待《${book.title}》` };

		const taskId = await tx.createTask(
			ReservationTask,
			{ isbn: book.isbn, reader },
			{ ownership: { kind: "conversation" }, conversationId, background: true },
		);
		reservations.items.push({
			id: `reservation-${taskId}`,
			taskId,
			isbn: book.isbn,
			title: book.title,
			reader,
			createdAt: Date.now(),
			status: "waiting",
		});
		pushActivity(ledger, "reserve", `${reader} 预约《${book.title}》,排队等待可借副本`, Date.now());
		return { ok: true, text: `${reader} 已预约《${book.title}》,有副本归还时自动转借`, taskId };
	})();
}

export async function createReservation(
	harness: Harness,
	conversationId: ConversationId,
	query: string,
	reader: string,
	context: Context,
): Promise<CreateResult> {
	return harness.commit((tx) => createReservationInTx(tx, conversationId, query, reader), context);
}

export async function cancelReservation(
	harness: Harness,
	conversationId: ConversationId,
	taskId: number,
	context: Context,
): Promise<OperationResult> {
	const current = await harness.snapshot(Reservations, conversationId, context);
	const reservation = current?.items.find((item) => item.taskId === taskId);
	if (reservation === undefined) return { ok: false, text: "没有找到这条预约" };
	if (reservation.status !== "waiting") return { ok: false, text: "这条预约已经结束" };
	const result = await harness.abortTask(reservation.taskId, context);
	return result === "marked"
		? { ok: true, text: `${reservation.reader} 的预约已取消` }
		: { ok: false, text: "这条预约已经结束" };
}

export type PurchaseInputDraft = {
	title: string;
	author: string;
	category: string;
	copies: number;
	requester: string;
	reason?: string;
};

function createPurchaseInTx(tx: Tx, conversationId: ConversationId, input: PurchaseInputDraft): Promise<CreateResult> {
	return (async () => {
		const purchases = await tx.doc(Purchases, conversationId);
		const ledger = await tx.doc(Ledger, conversationId);
		const now = Date.now();
		const taskId = await tx.createTask(
			PurchaseTask,
			{
				title: input.title,
				author: input.author,
				category: input.category,
				copies: input.copies,
				requester: input.requester,
				...(input.reason === undefined ? {} : { reason: input.reason }),
			},
			{ ownership: { kind: "conversation" }, conversationId, background: true },
		);
		purchases.items.push({
			id: `purchase-${taskId}`,
			taskId,
			title: input.title,
			author: input.author,
			category: input.category,
			copies: input.copies,
			requester: input.requester,
			...(input.reason === undefined ? {} : { reason: input.reason }),
			createdAt: now,
			status: "pending",
		});
		pushActivity(
			ledger,
			"purchase",
			`${input.requester} 提交采购申请:《${input.title}》${input.copies} 本,等待审批`,
			now,
		);
		return { ok: true, text: `采购申请 #${taskId} 已提交:《${input.title}》${input.copies} 本,等待批准`, taskId };
	})();
}

export async function createPurchase(
	harness: Harness,
	conversationId: ConversationId,
	input: PurchaseInputDraft,
	context: Context,
): Promise<CreateResult> {
	return harness.commit((tx) => createPurchaseInTx(tx, conversationId, input), context);
}

function decidePurchaseInTx(
	tx: Tx,
	conversationId: ConversationId,
	taskId: number,
	approve: boolean,
	actor: string,
): Promise<OperationResult> {
	return (async () => {
		const purchases = await tx.doc(Purchases, conversationId);
		const ledger = await tx.doc(Ledger, conversationId);
		const request = purchases.items.find((item) => item.taskId === taskId);
		if (request === undefined) return { ok: false, text: "没有找到这条采购申请" };
		if (request.status !== "pending") return { ok: false, text: "这条申请已经处理过" };
		request.status = approve ? "approved" : "rejected";
		request.decidedAt = Date.now();
		pushActivity(ledger, "purchase", `${actor} ${approve ? "批准" : "驳回"}采购申请《${request.title}》`, Date.now());
		return {
			ok: true,
			text: approve ? `已批准《${request.title}》,正在办理入库` : `已驳回《${request.title}》的采购申请`,
		};
	})();
}

export async function decidePurchase(
	harness: Harness,
	conversationId: ConversationId,
	taskId: number,
	approve: boolean,
	actor: string,
	context: Context,
): Promise<OperationResult> {
	return harness.commit((tx) => decidePurchaseInTx(tx, conversationId, taskId, approve, actor), context);
}

function createBatchLoanInTx(
	tx: Tx,
	conversationId: ConversationId,
	borrower: string,
	queries: readonly string[],
): Promise<CreateResult> {
	return (async () => {
		const catalog = await tx.doc(Catalog, conversationId);
		const isbns: string[] = [];
		for (const query of queries) {
			const book = findBook(catalog.books, query);
			if (book !== undefined && !isbns.includes(book.isbn)) isbns.push(book.isbn);
		}
		if (isbns.length === 0) return { ok: false, text: "没有找到要借的图书" };
		const taskId = await tx.createTask(
			BatchLoanTask,
			{ borrower, isbns },
			{ ownership: { kind: "conversation" }, conversationId },
		);
		return { ok: true, text: `批量借阅任务 #${taskId} 已提交:${borrower} 借 ${isbns.length} 本`, taskId };
	})();
}

export async function createBatchLoan(
	harness: Harness,
	conversationId: ConversationId,
	borrower: string,
	queries: readonly string[],
	context: Context,
): Promise<CreateResult> {
	return harness.commit((tx) => createBatchLoanInTx(tx, conversationId, borrower, queries), context);
}

function returnBookInTx(
	tx: Tx,
	conversationId: ConversationId,
	query: string,
	borrower: string | undefined,
): Promise<OperationResult> {
	return (async () => {
		const catalog = await tx.doc(Catalog, conversationId);
		const ledger = await tx.doc(Ledger, conversationId);
		const book = findBook(catalog.books, query);
		const active = ledger.loans
			.filter(isOpenLoan)
			.filter((loan) => (book === undefined ? false : loan.isbn === book.isbn))
			.filter((loan) => borrower === undefined || loan.borrower === borrower)
			.at(-1);
		if (active === undefined) {
			return { ok: false, text: `没有找到${borrower ?? "读者"}对《${book?.title ?? query}》的未还借阅` };
		}
		active.status = "returned";
		active.returnedAt = Date.now();
		const target = catalog.books.find((entry) => entry.isbn === active.isbn);
		if (target !== undefined) target.available = Math.min(target.total, target.available + 1);
		pushActivity(ledger, "return", `${active.borrower} 归还《${active.title}》`, Date.now());
		return { ok: true, text: `${active.borrower} 已归还《${active.title}》` };
	})();
}

export async function returnBook(
	harness: Harness,
	conversationId: ConversationId,
	query: string,
	borrower: string | undefined,
	context: Context,
): Promise<OperationResult> {
	return harness.commit((tx) => returnBookInTx(tx, conversationId, query, borrower), context);
}

function addBookInTx(
	tx: Tx,
	conversationId: ConversationId,
	input: { title: string; author: string; category: string; copies: number },
): Promise<OperationResult> {
	return (async () => {
		const catalog = await tx.doc(Catalog, conversationId);
		const ledger = await tx.doc(Ledger, conversationId);
		const existing = catalog.books.find((entry) => entry.title === input.title);
		if (existing !== undefined) {
			existing.total += input.copies;
			existing.available += input.copies;
			pushActivity(ledger, "catalog", `《${input.title}》补货 ${input.copies} 本`, Date.now());
			return { ok: true, text: `《${input.title}》补货 ${input.copies} 本` };
		}
		catalog.books.push({
			isbn: `ADD-${Date.now().toString(36)}`,
			title: input.title,
			author: input.author,
			category: input.category,
			total: input.copies,
			available: input.copies,
		});
		pushActivity(ledger, "catalog", `新书上架:《${input.title}》`, Date.now());
		return { ok: true, text: `已上架《${input.title}》` };
	})();
}

export async function addBook(
	harness: Harness,
	conversationId: ConversationId,
	input: { title: string; author: string; category: string; copies: number },
	context: Context,
): Promise<OperationResult> {
	return harness.commit((tx) => addBookInTx(tx, conversationId, input), context);
}

/** Queue position per waiting reservation, counted per title from the oldest. */
export function reservationPositions(items: readonly Reservation[]): Map<number, number> {
	const counts = new Map<string, number>();
	const positions = new Map<number, number>();
	const waiting = items.filter((item) => item.status === "waiting").slice();
	waiting.sort((left, right) => left.createdAt - right.createdAt);
	for (const item of waiting) {
		const next = (counts.get(item.isbn) ?? 0) + 1;
		counts.set(item.isbn, next);
		positions.set(item.taskId, next);
	}
	return positions;
}

export function statsOf(books: readonly Book[], loans: readonly Loan[], now: number) {
	const active = loans.filter(isOpenLoan);
	return {
		titles: books.length,
		copies: books.reduce((sum, book) => sum + book.total, 0),
		available: books.reduce((sum, book) => sum + book.available, 0),
		active: active.length,
		overdue: active.filter((loan) => loan.dueAt < now).length,
	};
}

// ── Agent tools ─────────────────────────────────────────────────────────────

const say = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const searchBooks = defineTool({
	name: "search_books",
	description: "按书名、作者或 ISBN 搜索馆藏,返回库存和可借数量。",
	parameters: Type.Object({ query: Type.String({ description: "书名、作者或 ISBN" }) }),
	async execute(args, api, context) {
		const catalog = await api.snapshot(Catalog, api.conversationId, context);
		const needle = args.query.trim().toLowerCase();
		const found = (catalog?.books ?? []).filter(
			(book) =>
				book.title.toLowerCase().includes(needle) ||
				book.author.toLowerCase().includes(needle) ||
				book.isbn.toLowerCase() === needle,
		);
		if (found.length === 0) return say(`没有找到与"${args.query}"匹配的图书。`);
		return say(
			found
				.slice(0, 10)
				.map(
					(book) =>
						`${book.title}(ISBN ${book.isbn})作者 ${book.author},共 ${book.total} 本,可借 ${book.available} 本`,
				)
				.join("\n"),
		);
	},
});

const bookStats = defineTool({
	name: "library_stats",
	description: "统计馆藏、在借和逾期数量,并列出逾期借阅。",
	parameters: Type.Object({}),
	async execute(_args, api, context) {
		const catalog = await api.snapshot(Catalog, api.conversationId, context);
		const ledger = await api.snapshot(Ledger, api.conversationId, context);
		const now = Date.now();
		const stats = statsOf(catalog?.books ?? [], ledger?.loans ?? [], now);
		const overdue = (ledger?.loans ?? [])
			.filter((loan) => isOpenLoan(loan) && loan.dueAt < now)
			.map((loan) => `${loan.borrower}《${loan.title}》逾期 ${Math.ceil((now - loan.dueAt) / DAY)} 天`);
		const head = `馆藏 ${stats.titles} 种共 ${stats.copies} 本,可借 ${stats.available} 本,在借 ${stats.active} 条,逾期 ${stats.overdue} 条`;
		return say(overdue.length === 0 ? head : `${head}\n逾期明细:\n${overdue.join("\n")}`);
	},
});

const lendBook = defineTool({
	name: "lend_book",
	description: "为一位读者创建借阅任务。库存不足时会说明原因。",
	parameters: Type.Object({
		title: Type.String({ description: "书名、作者或 ISBN" }),
		borrower: Type.String({ description: "读者姓名" }),
	}),
	async execute(args, api, context) {
		const catalog = await api.snapshot(Catalog, api.conversationId, context);
		const book = findBook(catalog?.books ?? [], args.title);
		if (book === undefined) return say(`馆藏里没有"${args.title}"。`);
		if (book.available <= 0) return say(`《${book.title}》当前没有可借副本。`);
		const taskId = await api.createTask(
			LoanTask,
			{ isbn: book.isbn, borrower: args.borrower },
			{ ownership: { kind: "conversation" } },
			context,
		);
		return say(`已为 ${args.borrower} 创建借阅任务 #${taskId}:《${book.title}》,处理后会自动确认。`);
	},
});

const returnBookTool = defineTool({
	name: "return_book",
	description: "为一位读者归还一本书,库存会增加一本。",
	parameters: Type.Object({
		title: Type.String({ description: "书名、作者或 ISBN" }),
		borrower: Type.Optional(Type.String({ description: "读者姓名;省略时归还最近一条未还记录" })),
	}),
	async execute(args, api, context) {
		const result = await api.commit(
			(tx) => returnBookInTx(tx, api.conversationId, args.title, args.borrower),
			context,
		);
		return say(result.text);
	},
});

const addBookTool = defineTool({
	name: "add_book",
	description: "上架一本新书或给已有图书补货。",
	parameters: Type.Object({
		title: Type.String(),
		author: Type.String(),
		category: Type.Optional(Type.String()),
		copies: Type.Optional(Type.Number({ description: "数量,默认 1" })),
	}),
	async execute(args, api, context) {
		const result = await api.commit(
			(tx) =>
				addBookInTx(tx, api.conversationId, {
					title: args.title,
					author: args.author,
					category: args.category ?? "其他",
					copies: args.copies ?? 1,
				}),
			context,
		);
		return say(result.text);
	},
});

const importBooksTool = defineTool({
	name: "import_books",
	description: "启动批量入库任务。这个过程会持续一段时间,进程重启后会从断点继续。",
	parameters: Type.Object({
		count: Type.Optional(Type.Number({ description: "入库数量,默认 24,最多 24" })),
	}),
	async execute(args, api, context) {
		const progress = await api.snapshot(ImportProgress, api.conversationId, context);
		if (progress?.running === true) {
			return say(`已经有一个批量入库任务在跑,进度 ${progress.done}/${progress.total}。`);
		}
		const taskId = await api.commit((tx) => createImportInTx(tx, api.conversationId, args.count ?? 24), context);
		return say(`批量入库任务 #${taskId} 已启动。`);
	},
});

const reserveBookTool = defineTool({
	name: "reserve_book",
	description: "为读者预约一本已借完的书。有副本归还时,预约任务会自动把它转为借阅;进程重启后预约仍然有效。",
	parameters: Type.Object({
		title: Type.String({ description: "书名、作者或 ISBN" }),
		reader: Type.String({ description: "读者姓名" }),
	}),
	async execute(args, api, context) {
		const result = await api.commit(
			(tx) => createReservationInTx(tx, api.conversationId, args.title, args.reader),
			context,
		);
		return say(result.text);
	},
});

const listReservationsTool = defineTool({
	name: "list_reservations",
	description: "列出预约队列,包括等待中、已转借阅和已取消的预约。",
	parameters: Type.Object({
		status: Type.Optional(Type.String({ description: "waiting、fulfilled 或 cancelled;省略时列出全部" })),
	}),
	async execute(args, api, context) {
		const reservations = await api.snapshot(Reservations, api.conversationId, context);
		const positions = reservationPositions(reservations?.items ?? []);
		const items = (reservations?.items ?? []).filter(
			(item) => args.status === undefined || item.status === args.status,
		);
		if (items.length === 0) return say("(没有预约)");
		return say(
			items
				.slice()
				.reverse()
				.slice(0, 15)
				.map((item) => {
					const position = positions.get(item.taskId);
					const status =
						item.status === "waiting"
							? `等待中${position === undefined ? "" : `,第 ${position} 位`}`
							: item.status === "fulfilled"
								? "已转借阅"
								: "已取消";
					return `${item.reader}《${item.title}》${status}`;
				})
				.join("\n"),
		);
	},
});

const requestPurchaseTool = defineTool({
	name: "request_purchase",
	description: "提交一条采购申请。申请进入待审批状态,人工批准之前不会入库;进程重启不会丢掉待审批的申请。",
	parameters: Type.Object({
		title: Type.String(),
		author: Type.String(),
		copies: Type.Optional(Type.Number({ description: "册数,默认 1" })),
		category: Type.Optional(Type.String({ description: "分类,默认其他" })),
		reason: Type.Optional(Type.String({ description: "采购理由" })),
	}),
	async execute(args, api, context) {
		const result = await api.commit(
			(tx) =>
				createPurchaseInTx(tx, api.conversationId, {
					title: args.title,
					author: args.author,
					category: args.category ?? "其他",
					copies: args.copies ?? 1,
					requester: "AI 助手",
					...(args.reason === undefined ? {} : { reason: args.reason }),
				}),
			context,
		);
		return say(result.text);
	},
});

const listPurchasesTool = defineTool({
	name: "list_purchases",
	description: "列出采购申请及其审批状态。待审批的申请需要人工批准或驳回。",
	parameters: Type.Object({
		status: Type.Optional(Type.String({ description: "pending、approved、rejected;省略时列出全部" })),
	}),
	async execute(args, api, context) {
		const purchases = await api.snapshot(Purchases, api.conversationId, context);
		const items = (purchases?.items ?? []).filter((item) => args.status === undefined || item.status === args.status);
		if (items.length === 0) return say("(没有采购申请)");
		return say(
			items
				.slice()
				.reverse()
				.slice(0, 15)
				.map(
					(item) => `#${item.taskId}《${item.title}》${item.copies} 本,${item.requester} 申请,状态 ${item.status}`,
				)
				.join("\n"),
		);
	},
});

const decidePurchaseTool = defineTool({
	name: "decide_purchase",
	description: "批准或驳回一条待审批的采购申请。批准后由采购任务完成入库。",
	parameters: Type.Object({
		taskId: Type.Number({ description: "采购申请的任务编号,来自 list_purchases" }),
		approve: Type.Boolean({ description: "true 批准,false 驳回" }),
	}),
	async execute(args, api, context) {
		const result = await api.commit(
			(tx) => decidePurchaseInTx(tx, api.conversationId, args.taskId, args.approve, "AI 助手"),
			context,
		);
		return say(result.text);
	},
});

const batchLendTool = defineTool({
	name: "batch_lend",
	description: "为一位读者一次借多本书。每本书是一个子任务;任何一本借不到,其他已登记的副本会自动退回。",
	parameters: Type.Object({
		borrower: Type.String({ description: "读者姓名" }),
		titles: Type.Array(Type.String(), { description: "书名、作者或 ISBN 列表" }),
	}),
	async execute(args, api, context) {
		const result = await api.commit(
			(tx) => createBatchLoanInTx(tx, api.conversationId, args.borrower, args.titles),
			context,
		);
		return say(result.text);
	},
});

const recentEvents = defineTool({
	name: "recent_events",
	description: "读取最近的馆务动态。",
	parameters: Type.Object({ limit: Type.Optional(Type.Number({ description: "默认 10" })) }),
	async execute(args, api, context) {
		const ledger = await api.snapshot(Ledger, api.conversationId, context);
		const events = (ledger?.events ?? []).slice(-(args.limit ?? 10)).reverse();
		if (events.length === 0) return say("(暂无动态)");
		return say(events.map((event) => `${new Date(event.at).toLocaleString("zh-CN")} ${event.text}`).join("\n"));
	},
});

const IDENTITY = `你是图书管理工作台里的 AI 助手。
你可以查询馆藏、统计借阅、上架图书、办理借还、预约、批量借阅、提交采购申请和审批采购。
借还、预约、批量借阅、采购和入库都是 durable 任务:动作提交后立即写进存储,进程重启也会接着执行。
预约任务会一直等待可借副本;采购任务会等待人工审批。
回答直接、简短,先给结论;需要数据时先调用工具,不要猜。`;

export const LibraryExtension = defineExtension({
	name: "library",
	tasks: [LoanTask, ImportTask, ReservationTask, PurchaseTask, BatchLoanTask, BatchLoanItemTask],
	tools: [
		searchBooks,
		bookStats,
		lendBook,
		returnBookTool,
		addBookTool,
		importBooksTool,
		reserveBookTool,
		listReservationsTool,
		requestPurchaseTool,
		listPurchasesTool,
		decidePurchaseTool,
		batchLendTool,
		recentEvents,
	],
	sections: [
		section("identity", () => IDENTITY, { tag: false }),
		section("catalog", async (input, context) => {
			const catalog = await input.read.snapshot(Catalog, input.conversationId, context);
			const books = catalog?.books ?? [];
			if (books.length === 0) return undefined;
			const lines = books
				.slice(0, 12)
				.map((book) => `${book.title}/${book.author}(可借 ${book.available}/${book.total})`);
			return `共 ${books.length} 种图书\n${lines.join("\n")}`;
		}),
		section("loans", async (input, context) => {
			const ledger = await input.read.snapshot(Ledger, input.conversationId, context);
			const now = Date.now();
			const active = (ledger?.loans ?? []).filter(isOpenLoan).slice(-10);
			if (active.length === 0) return undefined;
			return active
				.map(
					(loan) => `${loan.borrower}《${loan.title}》${loan.dueAt < now ? "已逾期" : "在借"},状态 ${loan.status}`,
				)
				.join("\n");
		}),
		section("reservations", async (input, context) => {
			const reservations = await input.read.snapshot(Reservations, input.conversationId, context);
			const waiting = (reservations?.items ?? []).filter((item) => item.status === "waiting");
			if (waiting.length === 0) return undefined;
			const positions = reservationPositions(waiting);
			return waiting
				.slice(-10)
				.map((item) => `${item.reader}《${item.title}》排队第 ${positions.get(item.taskId) ?? 1} 位`)
				.join("\n");
		}),
		section("purchases", async (input, context) => {
			const purchases = await input.read.snapshot(Purchases, input.conversationId, context);
			const pending = (purchases?.items ?? []).filter((item) => item.status === "pending");
			if (pending.length === 0) return undefined;
			return pending
				.map((item) => `采购申请 #${item.taskId}《${item.title}》${item.copies} 本,${item.requester} 申请,等待审批`)
				.join("\n");
		}),
		section("import", async (input, context) => {
			const progress = await input.read.snapshot(ImportProgress, input.conversationId, context);
			if (progress?.running !== true) return undefined;
			return `批量入库进行中:${progress.done}/${progress.total},当前《${progress.current ?? ""}》`;
		}),
	],
});
