import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderForkVersionModule, resolveForkCommit } from "../scripts/stamp-fork-commit";
import { formatDisplayVersion } from "../src/version-display";

describe("formatDisplayVersion", () => {
	it("appends the stamped fork commit hash", () => {
		expect(formatDisplayVersion("17.2.9", "abc1234")).toBe("17.2.9 (abc1234)");
	});

	it("renders the plain version without a stamped hash", () => {
		expect(formatDisplayVersion("17.2.9", "")).toBe("17.2.9");
	});
});

describe("renderForkVersionModule", () => {
	it("renders an importable module with the hash", () => {
		expect(renderForkVersionModule("abc1234")).toContain('export const FORK_COMMIT: string = "abc1234";');
	});

	it("renders the empty placeholder", () => {
		expect(renderForkVersionModule("")).toContain('export const FORK_COMMIT: string = "";');
	});

	it("matches the committed placeholder byte-for-byte", async () => {
		const committed = await Bun.file(path.join(import.meta.dir, "..", "src", "fork-version.ts")).text();
		expect(committed).toBe(renderForkVersionModule(""));
	});
});

describe("resolveForkCommit", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-version-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("resolves empty outside a VCS checkout", async () => {
		expect(await resolveForkCommit(tmpDir)).toBe("");
	});

	it("resolves the short git HEAD in a plain git clone", async () => {
		const git = async (...args: string[]): Promise<void> => {
			const proc = Bun.spawn(["git", ...args], { cwd: tmpDir, stdout: "ignore", stderr: "ignore" });
			expect(await proc.exited).toBe(0);
		};
		await git("init");
		await git("config", "user.email", "test@example.com");
		await git("config", "user.name", "Test");
		await Bun.write(path.join(tmpDir, "file.txt"), "x");
		await git("add", ".");
		await git("commit", "-m", "init");

		const revParse = Bun.spawn(["git", "rev-parse", "--short=7", "HEAD"], { cwd: tmpDir, stdout: "pipe" });
		const expected = (await new Response(revParse.stdout).text()).trim();
		expect(await revParse.exited).toBe(0);
		expect(expected).not.toBe("");

		expect(await resolveForkCommit(tmpDir)).toBe(expected);
	});
});
