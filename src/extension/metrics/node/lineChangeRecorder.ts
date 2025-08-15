/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import type { ChatResponseStream } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IDiffService } from '../../../platform/diff/common/diffService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IEnvService } from '../../../platform/env/common/envService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IGitService, normalizeFetchUrl } from '../../../platform/git/common/gitService';
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
	token: string; // hash(timestamp truncated to minute)
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
	gitService?: IGitService,
	capiClientService?: ICAPIClientService,
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
								token: computeMinuteToken(timestamp),
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

							// decide persistence strategy (local file vs remote post)
							const remoteUrl = await getMetricsRemoteUrl(authService, logService, workspaceService, gitService, capiClientService);
							if (remoteUrl) {
								await postSingleFileRecord(remoteUrl, record, logService);
							} else {
								// await writeSingleFileRecord(workspaceService, fileSystemService, record, uri);
							}
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
						token: computeMinuteToken(timestamp),
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
					const remoteUrl = await getMetricsRemoteUrl(authService, logService, workspaceService, gitService, capiClientService);
					if (remoteUrl) {
						await postSingleFileRecord(remoteUrl, record, logService);
					} else {
						// await writeSingleFileRecord(workspaceService, fileSystemService, record, uri);
					}
					persisted.add(uri.toString());
				}
			} catch (err) {
				try { logService.debug(`[lineChangeRecorder] Finalize flush failed: ${String(err)}`); } catch { }
			}
		}
	);

	return spy;
}

// --- remote metrics posting via content exclusion pseudo-rule ---
// We piggy-back on the authentication service token metadata which already contains
// organization content exclusion settings. We look for a Repository rule named 'copilot-metrics'
// and take its first path entry; if it looks like an http/https URL we use it as the endpoint.
let _cachedMetricsUrl: string | null | undefined; // undefined=unknown, null=no valid rule, string=endpoint
async function getMetricsRemoteUrl(
	authService: IAuthenticationService | undefined,
	logService: ILogService | undefined,
	workspaceService: IWorkspaceService,
	gitService: IGitService | undefined,
	capiClientService: ICAPIClientService | undefined,
): Promise<string | undefined> {
	if (_cachedMetricsUrl !== undefined) {
		return _cachedMetricsUrl || undefined;
	}
	try {
		const start = Date.now();
		if (!capiClientService || !gitService) {
			_cachedMetricsUrl = null;
			return undefined;
		}
		const ghToken = (await authService?.getAnyGitHubSession({ silent: true }))?.accessToken;
		// Collect repo fetch URLs for current workspace (user now expects repo-based wildcard resolution "*")
		const folders = workspaceService.getWorkspaceFolders();
		const fetchUrls: string[] = [];
		for (const folder of folders) {
			try {
				const repo = await gitService.getRepositoryFetchUrls(folder);
				for (const u of (repo?.remoteFetchUrls || [])) {
					if (!u) { continue; }
					try { fetchUrls.push(normalizeFetchUrl(u)); } catch { fetchUrls.push(u); }
				}
			} catch { }
		}
		if (fetchUrls.length === 0) {
			_cachedMetricsUrl = null;
			return undefined;
		}
		// Batch up to 10 (API limit pattern) and look for matching rules
		let chosen: { url: string; reason: string } | undefined;
		for (let i = 0; i < fetchUrls.length && !chosen; i += 10) {
			const batch = fetchUrls.slice(i, i + 10);
			try { logService?.info?.(`[lineChangeRecorder] querying repo-level content exclusion for: ${JSON.stringify(batch)}`); } catch { }
			try {
				const resp = await capiClientService.makeRequest<{ ok: boolean; json(): Promise<any> }>({
					headers: ghToken ? { 'Authorization': `token ${ghToken}` } : undefined,
				}, { type: RequestType.ContentExclusion, repos: batch });
				if (!resp || !resp.ok) { continue; }
				const data = await resp.json();
				// try { logService?.info?.(`[lineChangeRecorder] raw repo-level content exclusion batch: ${JSON.stringify(data)}`); } catch { }
				for (const repoRules of data) {
					for (const rule of (repoRules.rules || [])) {
						const name = String(rule?.source?.name ?? '').trim().toLowerCase();
						if (!Array.isArray(rule?.paths) || rule.paths.length === 0) { continue; }
						const first = String(rule.paths[0] ?? '').trim();
						if (!/^https?:\/\//i.test(first)) { continue; }
						if (name === 'copilot-metrics') {
							chosen = { url: first, reason: 'explicit-name' }; break;
						}
						if (name === '*') {
							chosen = { url: first, reason: 'wildcard-name' }; break;
						}
						// fallback capture (only if nothing chosen yet)
						if (!chosen) {
							chosen = { url: first, reason: 'fallback-first-url' };
						}
					}
					if (chosen) { break; }
				}
			} catch { /* ignore this batch */ }
		}
		if (chosen) {
			_cachedMetricsUrl = chosen.url;
			logService?.info?.(`[lineChangeRecorder] remote metrics endpoint (${chosen.reason}): ${chosen.url}`);
			logService?.info?.(`[lineChangeRecorder] repo-level content exclusion scan in ${Date.now() - start}ms`);
			return chosen.url;
		}
		logService?.info?.(`[lineChangeRecorder] repo-level content exclusion scan in ${Date.now() - start}ms (no URL rule found)`);
		_cachedMetricsUrl = null;
		return undefined;
	} catch (e) {
		logService?.debug?.(`[lineChangeRecorder] repo-level content exclusion fetch error: ${String(e)}`);
		_cachedMetricsUrl = null;
		return undefined;
	}
}

async function postSingleFileRecord(url: string, record: SingleFileRecord, logService: ILogService | undefined) {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(record),
			signal: controller.signal,
		});
		clearTimeout(timeout);
	} catch (err) {
		logService?.debug?.(`[lineChangeRecorder] Failed POST to metrics endpoint ${url}: ${String(err)}`);
	}
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

// Generate a deterministic token based on timestamp truncated to minute (YYYY-MM-DDTHH:MM) using a lightweight hash.
function computeMinuteToken(timestamp: string): string {
	try {
		// Extract the first 16 chars of ISO string: 'YYYY-MM-DDTHH:MM'
		const minutePart = timestamp.slice(0, 16);
		// FNV-1a 32-bit hash
		let hash = 0x811c9dc5;
		for (let i = 0; i < minutePart.length; i++) {
			hash ^= minutePart.charCodeAt(i);
			hash = (hash >>> 0) * 0x01000193; // overflow via uint32
		}
		// Return as hex (8 chars) plus minutePart length for minor variation
		return (hash >>> 0).toString(16).padStart(8, '0');
	} catch {
		return '00000000';
	}
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
