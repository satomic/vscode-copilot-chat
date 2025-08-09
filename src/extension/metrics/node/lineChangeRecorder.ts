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

// New single-file record format
interface SingleFileRecord {
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
	file: string;
	language: string;
	added: number;
	removed: number;
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
	const originalPromises = new Map<string, Promise<string>>();
	const touched = new Map<string, Uri>();
	const persisted = new Set<string>();

	const spy = ChatResponseStreamImpl.spy(
		stream,
		(part) => {
			// Track text edits; capture original once and persist on per-file completion
			if (part instanceof ChatResponseTextEditPart) {
				const uri = part.uri as unknown as Uri;
				const key = uri.toString();
				touched.set(key, uri);
				if (!originals.has(key) && !originalPromises.has(key)) {
					// Capture the 'original' snapshot as soon as we first see this file being edited
					const p = workspaceService.openTextDocumentAndSnapshot(uri as any)
						.then(s => {
							const text = s.getText();
							try { originals.set(key, text); } catch { /* ignore */ }
							return text;
						})
						.catch(() => '');
					originalPromises.set(key, p);
				}

				// When this file's edit is done, compute and persist a single-file record
				if (part.isDone && !persisted.has(key)) {
					// Defer actual I/O work off the event path
					queueMicrotask(async () => {
						try {
							const single = await computeSingleFileDelta(uri, originals, workspaceService, diffService, originalPromises);
							if (!single) { return; }
							const timestamp = new Date().toISOString();
							const record: SingleFileRecord = {
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
								file: single.file,
								language: single.language,
								added: single.added,
								removed: single.removed,
							};

							await writeSingleFileRecord(workspaceService, fileSystemService, record, uri);
							persisted.add(key);
						} catch (err) {
							try { logService.debug(`[lineChangeRecorder] Failed to persist file edit: ${String(err)}`); } catch { }
						}
					});
				}
			}
		},
		async () => {
			// No aggregated write at stream finalization. Optionally flush any files not yet persisted.
			try {
				const remaining: Uri[] = [...touched.values()].filter(u => !persisted.has(u.toString()));
				for (const uri of remaining) {
					const single = await computeSingleFileDelta(uri, originals, workspaceService, diffService, originalPromises);
					if (!single) { continue; }
					const timestamp = new Date().toISOString();
					const record: SingleFileRecord = {
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
						file: single.file,
						language: single.language,
						added: single.added,
						removed: single.removed,
					};
					await writeSingleFileRecord(workspaceService, fileSystemService, record, uri);
					persisted.add(uri.toString());
				}
			} catch (err) {
				try { logService.debug(`[lineChangeRecorder] Finalize flush failed: ${String(err)}`); } catch { }
			}
		}
	);

	return spy;
}

// (old computePerFileDeltas removed; migrated to computeSingleFileDelta)

// Compute delta for a single URI and return FileDelta or undefined if no change
async function computeSingleFileDelta(
	uri: Uri,
	originals: Map<string, string>,
	workspaceService: IWorkspaceService,
	diffService: IDiffService,
	originalPromises?: Map<string, Promise<string>>,
): Promise<FileDelta | undefined> {
	const key = uri.toString();
	let original = originals.get(key);
	if (original === undefined) {
		const p = originalPromises?.get(key);
		if (p) {
			try { original = await p; } catch { original = ''; }
		} else {
			original = '';
		}
	}
	try {
		// Wait for edits to be fully applied to the document before diffing
		const { text: modified, languageId } = await getStableSnapshot(uri, workspaceService);
		const displayPath = getWorkspaceFileDisplayPath(workspaceService, URI.parse(key));
		const fileName = path.posix.basename(displayPath);
		const language = languageId ?? '';
		const { addedLines, removedLines } = await computeAdditionsAndDeletions(diffService, original ?? '', modified);
		if (addedLines === 0 && removedLines === 0) { return undefined; }
		return { file: fileName, language, added: addedLines, removed: removedLines };
	} catch {
		return undefined;
	}
}

async function writeSingleFileRecord(
	workspaceService: IWorkspaceService,
	fileSystemService: IFileSystemService,
	record: SingleFileRecord,
	uri: Uri,
): Promise<void> {
	const workspaceFolders = workspaceService.getWorkspaceFolders();
	if (!workspaceFolders.length) { return; }
	const root = workspaceFolders[0];
	const dir = URI.joinPath(root, '.vscode');
	const tsCompact = compactTimestamp(record.timestamp);
	const displayPath = getWorkspaceFileDisplayPath(workspaceService, URI.parse(uri.toString()));
	const fileBase = path.posix.basename(displayPath).replace(/[^a-zA-Z0-9._-]/g, '_');
	const out = URI.joinPath(dir, `lineEdits-${tsCompact}-${record.sessionId}-${fileBase}.json`);

	try { await fileSystemService.createDirectory(dir); } catch { /* ignore */ }
	const payload = VSBuffer.fromString(JSON.stringify(record, undefined, 2)).buffer;
	await fileSystemService.writeFile(out, payload);
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

// --- helpers ---

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Try to read a stable snapshot of a document by polling until two consecutive reads are equal or a timeout is reached
async function getStableSnapshot(uri: Uri, workspaceService: IWorkspaceService): Promise<{ text: string; languageId?: string }> {
	const read = async () => {
		const snap = await workspaceService.openTextDocumentAndSnapshot(uri as any);
		return { text: snap.getText(), languageId: snap.languageId } as const;
	};
	let last = await read();
	const maxTries = 10; // ~1s with 100ms interval
	for (let i = 0; i < maxTries; i++) {
		await sleep(100);
		const next = await read();
		if (next.text === last.text) {
			return next;
		}
		last = next;
	}
	return last;
}
