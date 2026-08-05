import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { LOCK_STALE_MS, TeamBoard, type TeamBoardOutcome } from "../src/teams/board";

let temp: TempDir;
let board: TeamBoard;

beforeEach(async () => {
	temp = await TempDir.create("omp-team-board-");
	board = new TeamBoard(temp.join("tasks"));
});

afterEach(async () => {
	await temp.remove();
});

async function createTask(title: string, blockedBy?: string[]): Promise<string> {
	const outcome = await board.create({ title, blockedBy, createdBy: "test" });
	if (!outcome.ok) throw new Error(`create failed: ${outcome.message}`);
	return outcome.task.id;
}

function expectOk(outcome: TeamBoardOutcome): asserts outcome is Extract<TeamBoardOutcome, { ok: true }> {
	expect(outcome.ok).toBe(true);
}

describe("claim atomicity", () => {
	it("exactly one of N parallel claimers wins", async () => {
		const taskId = await createTask("contended");
		const outcomes = await Promise.all(Array.from({ length: 16 }, (_, i) => board.claim(taskId, `agent-${i}`)));
		const winners = outcomes.filter(outcome => outcome.ok);
		const losers = outcomes.filter(outcome => !outcome.ok);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(15);
		for (const loser of losers) {
			expect(loser.code).toBe("already_claimed");
		}
		const tasks = await board.list();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.status).toBe("claimed");
		expect(tasks[0]!.claimedBy).toBe(winners[0]!.task.claimedBy);
	});
});

describe("blockedBy gating", () => {
	it("dependent is not claimable until predecessor completes; completion auto-unblocks", async () => {
		const predId = await createTask("predecessor");
		const depId = await createTask("dependent", [predId]);

		const earlyClaim = await board.claim(depId, "agent-a");
		expect(earlyClaim.ok).toBe(false);
		if (!earlyClaim.ok) {
			expect(earlyClaim.code).toBe("blocked");
			expect(earlyClaim.pendingBlockers).toEqual([predId]);
		}

		expectOk(await board.claim(predId, "agent-b"));
		expectOk(await board.complete(predId));

		// Completion cleared the dependency from the dependent's persisted file.
		const stored = await board.list();
		expect(stored.find(task => task.id === depId)?.blockedBy).toEqual([]);

		expectOk(await board.claim(depId, "agent-a"));
	});

	it("blockedBy on an already-done task does not gate the claim", async () => {
		const predId = await createTask("done-first");
		expectOk(await board.claim(predId, "agent-b"));
		expectOk(await board.complete(predId));

		// Created after the predecessor finished: its blockedBy entry is never
		// cleared by a completion, so the claim gate must honor dep status.
		const depId = await createTask("late-dependent", [predId]);
		expectOk(await board.claim(depId, "agent-a"));
	});

	it("create rejects blockedBy ids that do not exist", async () => {
		const outcome = await board.create({
			title: "orphan",
			blockedBy: ["0f3a9c1e2b4d5678"],
			createdBy: "test",
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.code).toBe("invalid_input");
	});
});

describe("release", () => {
	it("returns a claimed task to pending so another agent can claim it", async () => {
		const taskId = await createTask("handoff");
		expectOk(await board.claim(taskId, "agent-a"));

		expectOk(await board.release(taskId));
		const stored = (await board.list())[0]!;
		expect(stored.status).toBe("pending");
		expect(stored.claimedBy).toBeUndefined();
		expect(stored.claimedAt).toBeUndefined();

		expectOk(await board.claim(taskId, "agent-b"));
		expect((await board.list())[0]!.claimedBy).toBe("agent-b");
	});

	it("rejects releasing a task that is not claimed", async () => {
		const taskId = await createTask("pending-task");
		const outcome = await board.release(taskId);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.code).toBe("invalid_state");
	});
});

describe("persistence", () => {
	it("round-trips tasks across board instances", async () => {
		const predId = await createTask("pred");
		const depId = await createTask("dep", [predId]);
		const described = await board.create({
			title: "described",
			description: "with a description",
			createdBy: "test",
		});
		expectOk(described);
		expectOk(await board.claim(predId, "agent-a"));
		expectOk(await board.complete(predId, "shipped"));

		const reloaded = new TeamBoard(temp.join("tasks"));
		const tasks = await reloaded.list();
		expect(tasks.map(task => task.id).sort()).toEqual([predId, depId, described.task.id].sort());

		const pred = tasks.find(task => task.id === predId)!;
		expect(pred.status).toBe("done");
		expect(pred.claimedBy).toBe("agent-a");
		expect(pred.result).toBe("shipped");
		expect(typeof pred.completedAt).toBe("number");
		expect(typeof pred.createdAt).toBe("number");

		const dep = tasks.find(task => task.id === depId)!;
		expect(dep.blockedBy).toEqual([]);

		expect(tasks.find(task => task.id === described.task.id)?.description).toBe("with a description");
	});

	it("skips corrupt and invalid task files and ignores stray files", async () => {
		const goodId = await createTask("good");
		await Bun.write(path.join(temp.join("tasks"), "corrupt.json"), "{ not json");
		await Bun.write(path.join(temp.join("tasks"), "invalid.json"), JSON.stringify({ id: "also-bad", nope: true }));
		await Bun.write(path.join(temp.join("tasks"), "notes.txt"), "not a task");
		await Bun.write(path.join(temp.join("tasks"), `${goodId}.json.123.tmp`), "{}");

		const tasks = await board.list();
		expect(tasks.map(task => task.id)).toEqual([goodId]);
	});
});

describe("stale lock recovery", () => {
	it("breaks a lock older than the stale threshold by mtime", async () => {
		const taskId = await createTask("stale-locked");
		const lockPath = path.join(temp.join("tasks"), `${taskId}.json.lock`);
		await Bun.write(lockPath, "99999 0");
		const staleTime = new Date(Date.now() - LOCK_STALE_MS - 5_000);
		await fs.utimes(lockPath, staleTime, staleTime);

		const outcome = await board.claim(taskId, "agent-a");
		expectOk(outcome);
		expect(outcome.task.claimedBy).toBe("agent-a");
		// The lock was released after the op.
		await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
