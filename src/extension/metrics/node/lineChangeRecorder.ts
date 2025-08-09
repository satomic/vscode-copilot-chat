/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatResponseStream } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IDiffService } from '../../../platform/diff/common/diffService';
import { IEnvService } from '../../../platform/env/common/envService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { getWorkspaceFileDisplayPath, IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { VSBuffer } from '../../../util/vs/base/common/buffer';
import * as path from '../../../util/vs/base/common/path';
import { URI } from '../../../util/vs/base/common/uri';
import { ChatResponseTextEditPart, Uri } from '../../../vscodeTypes';

interface FileDelta { file: string; language: string; added: number; removed: number }
interface TurnRecord {
	version: 1;
	timestamp: string;
	sessionId: string;
	responseId: string;
	agentId?: string;
	command?: string;
	githubUsername?: string;
	gitUrl?: string;
	vscodeVersion?: string;
	model?: string;
	totals: { added: number; removed: number };
	files: FileDelta[];
}

/**
 * Wraps a ChatResponseStream to observe text edits and, at stream finalization, compute added/removed lines
 * and persist them into a workspace-local JSON file (.vscode/lineEdits.json).
 *
 * Minimal footprint: no global state; everything is scoped to a single turn/stream.
 */
export function wireLineChangeRecorder(
	stream: ChatResponseStream,
	workspaceService: IWorkspaceService,
	fileSystemService: IFileSystemService,
	diffService: IDiffService,
	logService: ILogService,
	sessionId: string,
	getResponseId: () => string,
	agentId?: string,
	command?: string,
	envService?: IEnvService,
	authService?: IAuthenticationService,
	getModelName?: () => Promise<string | undefined>,
): ChatResponseStream {
	// Capture original text per file on first edit seen
	const originals = new Map<string, string>();
	const touched = new Map<string, Uri>();

	const spy = ChatResponseStreamImpl.spy(
		stream,
		(part) => {
			// Only track text edits; capture original content once per URI
			if (part instanceof ChatResponseTextEditPart && !part.isDone) {
				const uri = part.uri as unknown as Uri;
				const key = uri.toString();
				touched.set(key, uri);
				if (!originals.has(key)) {
					// Fire and forget; snapshot may be slightly behind live, but good enough for per-turn accounting
					workspaceService.openTextDocumentAndSnapshot(uri as any).then(s => {
						try { originals.set(key, s.getText()); } catch { /* ignore */ }
					}).catch(() => {/* ignore */ });
				}
			}
		},
		async () => {
			try {
				const files = await computePerFileDeltas([...touched.values()], originals, workspaceService, diffService);
				if (files.length === 0) { return; }

				const totals = files.reduce((acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }), { added: 0, removed: 0 });
				const timestamp = new Date().toISOString();
				const record: TurnRecord = {
					version: 1,
					timestamp,
					sessionId,
					responseId: getResponseId(),
					agentId,
					command,
					githubUsername: getGithubUsername(authService),
					gitUrl: await getGitUrlOrWorkspacePath(workspaceService, fileSystemService),
					vscodeVersion: envService?.getEditorInfo().version,
					model: (await getModelName?.()) ?? undefined,
					totals,
					files,
				};

				await writePerSessionRecord(workspaceService, fileSystemService, record);
			} catch (err) {
				// Avoid surfacing errors to user; just log for diagnostics
				try { logService.debug(`[lineChangeRecorder] Failed to persist line edits: ${String(err)}`); } catch { }
			}
		}
	);

	return spy;
}

async function computePerFileDeltas(
	uris: Uri[],
	originals: Map<string, string>,
	workspaceService: IWorkspaceService,
	diffService: IDiffService,
): Promise<FileDelta[]> {
	const results: FileDelta[] = [];
	for (const uri of uris) {
		const key = uri.toString();
		let original = originals.get(key) ?? '';
		let modified = '';
		try {
			const snap = await workspaceService.openTextDocumentAndSnapshot(uri as any);
			modified = snap.getText();
			const displayPath = getWorkspaceFileDisplayPath(workspaceService, URI.parse(key));
			const fileName = path.posix.basename(displayPath);
			const language = snap.languageId ?? '';
			const { addedLines, removedLines } = await computeAdditionsAndDeletions(diffService, original, modified);
			results.push({ file: fileName, language, added: addedLines, removed: removedLines });
			continue;
		} catch {
			continue; // skip files we can't read
		}
	}
	// Filter out entries where nothing changed
	return results.filter(r => r.added !== 0 || r.removed !== 0);
}

async function writePerSessionRecord(
	workspaceService: IWorkspaceService,
	fileSystemService: IFileSystemService,
	record: TurnRecord,
): Promise<void> {
	const workspaceFolders = workspaceService.getWorkspaceFolders();
	if (!workspaceFolders.length) { return; }
	const root = workspaceFolders[0];
	const dir = URI.joinPath(root, '.vscode');
	const tsCompact = compactTimestamp(record.timestamp);
	const file = URI.joinPath(dir, `lineEdits-${tsCompact}-${record.sessionId}.json`);

	try { await fileSystemService.createDirectory(dir); } catch { /* ignore */ }
	const payload = VSBuffer.fromString(JSON.stringify(record, undefined, 2)).buffer;
	await fileSystemService.writeFile(file, payload);
}

async function computeAdditionsAndDeletions(diffService: IDiffService, original: string, modified: string): Promise<{ addedLines: number; removedLines: number }> {
	const diff = await diffService.computeDiff(original, modified, {
		ignoreTrimWhitespace: true,
		maxComputationTimeMs: 10000,
		computeMoves: false
	});
	let addedLines = 0;
	let removedLines = 0;
	for (const change of diff.changes) {
		removedLines += change.original.endLineNumberExclusive - change.original.startLineNumber;
		addedLines += change.modified.endLineNumberExclusive - change.modified.startLineNumber;
	}
	return { addedLines, removedLines };
}

function compactTimestamp(iso: string): string {
	// 2025-08-08T13:52:44.328Z -> 20250808-135244
	const d = new Date(iso);
	const pad = (n: number) => n.toString().padStart(2, '0');
	const yyyy = d.getUTCFullYear();
	const mm = pad(d.getUTCMonth() + 1);
	const dd = pad(d.getUTCDate());
	const hh = pad(d.getUTCHours());
	const mi = pad(d.getUTCMinutes());
	const ss = pad(d.getUTCSeconds());
	return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function getGithubUsername(authService?: IAuthenticationService): string | undefined {
	try {
		const tokenUser = authService?.copilotToken?.username?.trim();
		if (tokenUser) { return tokenUser; }
		const session = authService?.anyGitHubSession;
		const label = session?.account?.label?.trim();
		if (label) { return label; }
		return session?.account?.id;
	} catch {
		return undefined;
	}
}

async function getGitUrlOrWorkspacePath(workspaceService: IWorkspaceService, fileSystemService: IFileSystemService): Promise<string | undefined> {
	try {
		const folders = workspaceService.getWorkspaceFolders();
		if (!folders.length) { return undefined; }
		const root = folders[0];
		const gitConfig = URI.joinPath(root, '.git', 'config');
		try {
			const data = await fileSystemService.readFile(gitConfig);
			const text = new TextDecoder().decode(data);
			const urlMatch = parseGitRemoteUrl(text);
			if (urlMatch) { return urlMatch; }
		} catch {
			// no git or cannot read
		}
		return root.toString(true);
	} catch {
		return undefined;
	}
}

function parseGitRemoteUrl(configText: string): string | undefined {
	// naive INI-ish parse: look for [remote "origin"] then url = ...
	const lines = configText.split(/\r?\n/);
	let inOrigin = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (/^\[remote\s+"origin"\]/i.test(trimmed)) {
			inOrigin = true;
			continue;
		}
		if (/^\[/.test(trimmed)) {
			inOrigin = false;
		}
		if (inOrigin) {
			const m = /^url\s*=\s*(.+)$/i.exec(trimmed);
			if (m) {
				return m[1].trim();
			}
		}
	}
	return undefined;
}
