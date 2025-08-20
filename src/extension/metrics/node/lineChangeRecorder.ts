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

// Interface for the line change recorder stream wrapper
interface LineChangeRecorderStream extends ChatResponseStream {
	finishSession: () => Promise<void>;
}

/**
 * Wraps a ChatResponseStream to observe text edits and accumulate changes,
 * then send HTTP POST messages at the end of the session for all modified files.
 *
 * Each modified file gets one POST message with the final line change delta.
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
): LineChangeRecorderStream {
	// Capture original text per file on first edit seen
	const originals = new Map<string, string>();
	const originalPromises = new Map<string, Promise<string>>();
	const touched = new Map<string, Uri>();
	const accumulatedChanges = new Map<string, { uri: Uri; original: string }>();

	// Function to process all accumulated changes at session end
	const processAccumulatedChanges = async (): Promise<void> => {
		try {
			logService.info(`[lineChangeRecorder] Session explicitly finishing, processing accumulated changes for ${accumulatedChanges.size} files`);

			if (accumulatedChanges.size === 0) {
				// logService.info(`[lineChangeRecorder] No files were modified during this session`);
				return;
			}

			// Try the direct API approach first
			let remoteUrl = await getMetricsRemoteUrl(authService, logService, workspaceService, gitService, capiClientService);

			// If direct approach failed, try to use the existing RemoteContentExclusion service as fallback
			if (!remoteUrl) {
				// logService.info(`[lineChangeRecorder] Direct API approach failed, trying fallback via existing content exclusion service`);
				try {
					// Import and use the existing RemoteContentExclusion service
					const { RemoteContentExclusion } = await import('../../../platform/ignore/node/remoteContentExclusion');
					if (authService && capiClientService && fileSystemService && gitService) {
						const remoteContentExclusion = new RemoteContentExclusion(
							gitService,
							logService,
							authService,
							capiClientService,
							fileSystemService,
							workspaceService
						);
						// Get patterns using the existing service
						const patterns = await remoteContentExclusion.asMinimatchPatterns();
						// logService.info(`[lineChangeRecorder] Fallback service returned ${patterns.length} patterns: ${JSON.stringify(patterns)}`);

						// Look for HTTP URLs in the patterns
						for (const pattern of patterns) {
							if (/^https?:\/\//i.test(pattern)) {
								remoteUrl = pattern;
								// logService.info(`[lineChangeRecorder] Found HTTP URL in fallback patterns: ${pattern}`);
								break;
							}
						}

						remoteContentExclusion.dispose();
					}
				} catch (fallbackError) {
					// logService.warn(`[lineChangeRecorder] Fallback approach also failed: ${String(fallbackError)}`);
				}
			}

			if (!remoteUrl) {
				// logService.info(`[lineChangeRecorder] No remote URL configured, skipping metrics upload for ${accumulatedChanges.size} files`);
				return;
			}

			// logService.info(`[lineChangeRecorder] Sending POST requests to: ${remoteUrl}`);

			// Process each file that was modified during the session
			let successCount = 0;
			for (const [key, changeData] of accumulatedChanges) {
				try {
					// Wait for any pending original text capture
					const originalPromise = originalPromises.get(key);
					if (originalPromise) {
						await originalPromise;
					}

					// Compute final delta for this file
					const single = await computeSingleFileDelta(changeData.uri, originals, workspaceService, diffService, originalPromises);
					if (!single) {
						// logService.debug(`[lineChangeRecorder] No net changes detected for file: ${key}`);
						continue;
					}

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

					// Send POST for this file
					await postSingleFileRecord(remoteUrl, record, logService);
					successCount++;
					// logService.info(`[lineChangeRecorder] Successfully sent final changes for file: ${single.file} (+${single.added}/-${single.removed})`);

				} catch (err) {
					// logService.warn(`[lineChangeRecorder] Failed to process file ${key}: ${String(err)}`);
				}
			}

			// logService.info(`[lineChangeRecorder] Session-end processing completed: ${successCount}/${accumulatedChanges.size} files processed successfully`);
		} catch (err) {
			// logService.error(`[lineChangeRecorder] Session-end processing failed: ${String(err)}`);
		}
	};

	const spy = ChatResponseStreamImpl.spy(
		stream,
		(part) => {
			// Track text edits; capture original text on first edit for accumulation
			if (part instanceof ChatResponseTextEditPart) {
				const uri = part.uri as unknown as Uri;
				const key = uri.toString();
				touched.set(key, uri);
				if (!originals.has(key) && !originalPromises.has(key)) {
					// Capture the 'original' snapshot as soon as we first see this file being edited
					const p = workspaceService.openTextDocumentAndSnapshot(uri as any)
						.then(s => {
							const text = s.getText();
							try {
								originals.set(key, text);
								accumulatedChanges.set(key, { uri, original: text });
								// logService.debug(`[lineChangeRecorder] Captured original text for file: ${key} (${text.length} chars)`);
							} catch { /* ignore */ }
							return text;
						})
						.catch(err => {
							// File doesn't exist yet (new file) - start with empty content
							try {
								originals.set(key, '');
								accumulatedChanges.set(key, { uri, original: '' });
								// logService.debug(`[lineChangeRecorder] File doesn't exist yet, starting with empty content: ${key}`);
							} catch { /* ignore */ }
							return '';
						});
					originalPromises.set(key, p);
				}
			}
		},
		async () => {
			// DO NOT send any POST messages during stream finalization
			// Only log that the stream is ending - actual POST sending happens via explicit finishSession() call
			// logService.debug(`[lineChangeRecorder] Stream finalized, but not sending POST messages yet. Waiting for explicit session finish.`);
		}
	);

	// Add the explicit session finish method to the spy
	(spy as any).finishSession = processAccumulatedChanges;

	return spy as any as LineChangeRecorderStream;
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

		// Always try to fetch policies, even if there are no git repositories
		// This is important for non-git files to get organization-level wildcard policies like "*"
		// logService?.info?.(`[lineChangeRecorder] Starting content exclusion policy lookup...`);
		// logService?.info?.(`[lineChangeRecorder] GitHub token available: ${!!ghToken}`);
		// logService?.info?.(`[lineChangeRecorder] Found ${fetchUrls.length} git repository URLs, will also query organization/enterprise-level policies`);

		// Batch up to 10 (API limit pattern) and look for matching rules
		let chosen: { url: string; reason: string } | undefined;

		// First, if we have git repositories, query them
		if (fetchUrls.length > 0) {
			for (let i = 0; i < fetchUrls.length && !chosen; i += 10) {
				const batch = fetchUrls.slice(i, i + 10);
				// try { logService?.info?.(`[lineChangeRecorder] querying repo-level content exclusion for: ${JSON.stringify(batch)}`); } catch { }
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
								chosen = { url: first, reason: 'explicit-name-from-git-repo' }; break;
							}
							if (name === '*') {
								chosen = { url: first, reason: 'wildcard-name-from-git-repo' }; break;
							}
							// fallback capture (only if nothing chosen yet)
							if (!chosen) {
								chosen = { url: first, reason: 'fallback-first-url-from-git-repo' };
							}
						}
						if (chosen) { break; }
					}
				} catch { /* ignore this batch */ }
			}
		}

		// If no URL found from git repositories, or if there are no git repositories,
		// query organization/enterprise-level policies. Since empty repo array returns 404,
		// we'll use a fake repository URL to trigger enterprise policy lookup
		if (!chosen) {
			// logService?.info?.(`[lineChangeRecorder] No URL found from git repos (or no git repos), querying organization/enterprise-level policies`);

			// First try with empty array (in case it works in some environments)
			try {
				// logService?.info?.(`[lineChangeRecorder] Making API request with empty repos array...`);
				const resp = await capiClientService.makeRequest<{ ok: boolean; json(): Promise<any>; status?: number }>({
					headers: ghToken ? { 'Authorization': `token ${ghToken}` } : undefined,
				}, { type: RequestType.ContentExclusion, repos: [] });

				// logService?.info?.(`[lineChangeRecorder] Empty array API request completed. Response ok: ${resp?.ok}, status: ${resp?.status || 'unknown'}`);

				if (resp && resp.ok) {
					// Process successful response (same logic as before)
					// logService?.info?.(`[lineChangeRecorder] Empty array response is OK, parsing JSON...`);
					const data = await resp.json();
					chosen = await processContentExclusionData(data, logService, 'empty-array-query');
				}
			} catch (e) {
				// logService?.info?.(`[lineChangeRecorder] Empty array API request failed: ${String(e)}`);
			}

			// If empty array failed, try with a fake repository URL to get enterprise policies
			if (!chosen) {
				// logService?.info?.(`[lineChangeRecorder] Empty array approach failed (404), trying with fake repository URL...`);
				const fakeRepo = 'https://github.com/fake/fake.git';
				try {
					const resp = await capiClientService.makeRequest<{ ok: boolean; json(): Promise<any>; status?: number }>({
						headers: ghToken ? { 'Authorization': `token ${ghToken}` } : undefined,
					}, { type: RequestType.ContentExclusion, repos: [fakeRepo] });

					// logService?.info?.(`[lineChangeRecorder] Fake repo API request completed. Response ok: ${resp?.ok}, status: ${resp?.status || 'unknown'}`);

					if (resp && resp.ok) {
						// logService?.info?.(`[lineChangeRecorder] Fake repo response is OK, parsing JSON...`);
						const data = await resp.json();
						// logService?.info?.(`[lineChangeRecorder] Fake repo content exclusion response: ${JSON.stringify(data)}`);
						chosen = await processContentExclusionData(data, logService, 'fake-repo-query');
					} else {
						// logService?.warn?.(`[lineChangeRecorder] Fake repo content exclusion request failed: status=${resp?.status}, ok=${resp?.ok}`);
					}
				} catch (e) {
					// logService?.error?.(`[lineChangeRecorder] Failed to query with fake repository: ${String(e)}`);
					if (e instanceof Error) {
						// logService?.error?.(`[lineChangeRecorder] Error details: ${e.name}, message: ${e.message}`);
					}
				}
			}
		}
		if (chosen) {
			_cachedMetricsUrl = chosen.url;
			// logService?.info?.(`[lineChangeRecorder] remote metrics endpoint (${chosen.reason}): ${chosen.url}`);
			// logService?.info?.(`[lineChangeRecorder] repo-level content exclusion scan in ${Date.now() - start}ms`);
			return chosen.url;
		}
		// logService?.info?.(`[lineChangeRecorder] repo-level content exclusion scan in ${Date.now() - start}ms (no URL rule found)`);
		_cachedMetricsUrl = null;
		return undefined;
	} catch (e) {
		// logService?.debug?.(`[lineChangeRecorder] repo-level content exclusion fetch error: ${String(e)}`);
		_cachedMetricsUrl = null;
		return undefined;
	}
}

async function postSingleFileRecord(url: string, record: SingleFileRecord, logService: ILogService | undefined) {
	try {
		logService?.info?.(`[lineChangeRecorder] Sending POST request to ${url} for file: ${record.file} (+${record.added}/-${record.removed})`);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(record),
			signal: controller.signal,
		});
		clearTimeout(timeout);
		// logService?.info?.(`[lineChangeRecorder] POST request completed with status: ${response.status} for file: ${record.file}`);
	} catch (err) {
		// logService?.error?.(`[lineChangeRecorder] Failed POST to metrics endpoint ${url} for file: ${record.file}: ${String(err)}`);
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
		let displayPath: string;
		try {
			displayPath = getWorkspaceFileDisplayPath(workspaceService, URI.parse(key));
		} catch {
			// Fallback - use URI path
			displayPath = URI.parse(key).path;
		}
		const fileName = displayPath; // Use full relative path instead of just basename
		const language = languageId ?? '';

		// Handle case where original is empty (completely new file)
		if (original === '' && modified !== '') {
			// New file: count all lines as added
			const lines = modified.split(/\r?\n/).length;
			// Don't count empty last line if file ends with newline
			const addedLines = modified.endsWith('\n') ? Math.max(0, lines - 1) : lines;
			return { file: fileName, language, added: addedLines, removed: 0 };
		}

		// Handle case where modified is empty (file deleted)
		if (original !== '' && modified === '') {
			// File deleted: count all lines as removed
			const lines = original.split(/\r?\n/).length;
			// Don't count empty last line if file ends with newline
			const removedLines = original.endsWith('\n') ? Math.max(0, lines - 1) : lines;
			return { file: fileName, language, added: 0, removed: removedLines };
		}

		const { addedLines, removedLines } = await computeAdditionsAndDeletions(diffService, original ?? '', modified);
		if (addedLines === 0 && removedLines === 0) { return undefined; }
		return { file: fileName, language, added: addedLines, removed: removedLines };
	} catch (error) {
		// Log the error for debugging but still try to handle it gracefully
		// logService?.warn?.(`[lineChangeRecorder] Error computing delta for ${key}: ${String(error)}`);

		// For new files that don't exist yet, we can still try to calculate based on the original content
		if (original !== undefined && original !== '') {
			try {
				const displayPath = getWorkspaceFileDisplayPath(workspaceService, URI.parse(key));
				const fileName = displayPath; // Use full relative path instead of just basename
				// Try to determine language from file extension
				const ext = path.posix.extname(fileName).toLowerCase();
				let language = '';
				if (ext === '.ts' || ext === '.tsx') language = 'typescript';
				else if (ext === '.js' || ext === '.jsx') language = 'javascript';
				else if (ext === '.py') language = 'python';
				else if (ext === '.java') language = 'java';
				else if (ext === '.go') language = 'go';
				else if (ext === '.rs') language = 'rust';
				else if (ext === '.cpp' || ext === '.cc' || ext === '.cxx') language = 'cpp';
				else if (ext === '.c') language = 'c';
				else if (ext === '.cs') language = 'csharp';
				else if (ext === '.php') language = 'php';
				else if (ext === '.rb') language = 'ruby';
				else if (ext === '.swift') language = 'swift';
				else if (ext === '.kt') language = 'kotlin';
				else if (ext === '.scala') language = 'scala';
				else if (ext === '.html') language = 'html';
				else if (ext === '.css') language = 'css';
				else if (ext === '.scss' || ext === '.sass') language = 'scss';
				else if (ext === '.json') language = 'json';
				else if (ext === '.xml') language = 'xml';
				else if (ext === '.yaml' || ext === '.yml') language = 'yaml';
				else if (ext === '.md') language = 'markdown';
				else if (ext === '.sh') language = 'shellscript';
				else if (ext === '.sql') language = 'sql';
				else language = 'plaintext';

				// If file was deleted (error likely due to file not existing), count original lines as removed
				const lines = original.split(/\r?\n/).length;
				const removedLines = original.endsWith('\n') ? Math.max(0, lines - 1) : lines;
				return { file: fileName, language, added: 0, removed: removedLines };
			} catch {
				// If all else fails, return undefined
				return undefined;
			}
		}
		return undefined;
	}
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

// Helper function to process content exclusion response data
async function processContentExclusionData(
	data: any,
	logService: ILogService | undefined,
	queryType: string
): Promise<{ url: string; reason: string } | undefined> {
	// logService?.info?.(`[lineChangeRecorder] Processing content exclusion data from ${queryType}: ${JSON.stringify(data)}`);

	if (!Array.isArray(data)) {
		// logService?.warn?.(`[lineChangeRecorder] Unexpected response format: expected array, got ${typeof data}`);
		return undefined;
	}

	if (data.length === 0) {
		// logService?.info?.(`[lineChangeRecorder] Empty response array - no policies found in ${queryType}`);
		return undefined;
	}

	// logService?.info?.(`[lineChangeRecorder] Processing ${data.length} policy groups from ${queryType}...`);
	for (const repoRules of data) {
		// logService?.debug?.(`[lineChangeRecorder] Processing policy group: ${JSON.stringify(repoRules)}`);
		if (!repoRules || !repoRules.rules || !Array.isArray(repoRules.rules)) {
			// logService?.debug?.(`[lineChangeRecorder] No rules in policy group or invalid format`);
			continue;
		}
		// logService?.info?.(`[lineChangeRecorder] Found ${repoRules.rules.length} rules in policy group`);
		for (const rule of repoRules.rules) {
			// logService?.debug?.(`[lineChangeRecorder] Processing rule: ${JSON.stringify(rule)}`);
			const name = String(rule?.source?.name ?? '').trim().toLowerCase();
			// logService?.info?.(`[lineChangeRecorder] Rule name: '${name}', paths: ${JSON.stringify(rule?.paths)}`);
			if (!Array.isArray(rule?.paths) || rule.paths.length === 0) {
				// logService?.debug?.(`[lineChangeRecorder] Rule has no paths, skipping`);
				continue;
			}
			const first = String(rule.paths[0] ?? '').trim();
			// logService?.info?.(`[lineChangeRecorder] First path: '${first}', is HTTP URL: ${/^https?:\/\//i.test(first)}`);
			if (!/^https?:\/\//i.test(first)) {
				// logService?.debug?.(`[lineChangeRecorder] First path is not HTTP URL, skipping`);
				continue;
			}
			if (name === 'copilot-metrics') {
				// logService?.info?.(`[lineChangeRecorder] Found explicit 'copilot-metrics' rule from ${queryType}: ${first}`);
				return { url: first, reason: `explicit-name-from-${queryType}` };
			}
			if (name === '*') {
				// logService?.info?.(`[lineChangeRecorder] Found wildcard '*' rule from ${queryType}: ${first}`);
				return { url: first, reason: `wildcard-name-from-${queryType}` };
			}
			// fallback capture
			// logService?.info?.(`[lineChangeRecorder] Using fallback rule from ${queryType}: ${first}`);
			return { url: first, reason: `fallback-first-url-from-${queryType}` };
		}
	}
	return undefined;
}
