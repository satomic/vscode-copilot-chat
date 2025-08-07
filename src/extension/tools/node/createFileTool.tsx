/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { IAlternativeNotebookContentService } from '../../../platform/notebook/common/alternativeContent';
import { IAlternativeNotebookContentEditGenerator, NotebookEditGenrationSource } from '../../../platform/notebook/common/alternativeContentEditGenerator';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { removeLeadingFilepathComment } from '../../../util/common/markdown';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { CodeBlockProcessor } from '../../codeBlocks/node/codeBlockProcessor';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { processFullRewrite, processFullRewriteNewNotebook } from '../../prompts/node/codeMapper/codeMapper';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { IToolsService } from '../common/toolsService';
import { AgentSessionSingleton } from './agentSessionSingleton';
import { ActionType } from './applyPatch/parser';
import { EditFileResult } from './editFileToolResult';
import { sendEditNotebookTelemetry } from './editNotebookTool';
import { assertFileOkForTool, formatUriForFileWidget, resolveToolInputPath } from './toolUtils';

export interface ICreateFileParams {
	filePath: string;
	content?: string;
}


export class CreateFileTool implements ICopilotTool<ICreateFileParams> {
	public static toolName = ToolName.CreateFile;

	private _promptContext: IBuildPromptContext | undefined;

	// 获取单例的AgentSessionManager实例
	private getSessionManager() {
		return AgentSessionSingleton.getInstance(
			this.workspaceService,
			this.fileSystemService,
			this.telemetryService,
			this.logService
		);
	}

	constructor(
		@IPromptPathRepresentationService protected readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IWorkspaceService protected readonly workspaceService: IWorkspaceService,
		@IToolsService protected readonly toolsService: IToolsService,
		@INotebookService protected readonly notebookService: INotebookService,
		@IAlternativeNotebookContentService protected readonly alternativeNotebookContent: IAlternativeNotebookContentService,
		@IAlternativeNotebookContentEditGenerator protected readonly alternativeNotebookEditGenerator: IAlternativeNotebookContentEditGenerator,
		@IFileSystemService protected readonly fileSystemService: IFileSystemService,
		@ITelemetryService protected readonly telemetryService: ITelemetryService,
		@IEndpointProvider protected readonly endpointProvider: IEndpointProvider,
		@ILogService protected readonly logService: ILogService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ICreateFileParams>, token: vscode.CancellationToken) {
		const uri = this.promptPathRepresentationService.resolveFilePath(options.input.filePath);
		if (!uri) {
			throw new Error(`Invalid file path`);
		}

		await this.instantiationService.invokeFunction(accessor => assertFileOkForTool(accessor, uri));

		if (!this._promptContext?.stream) {
			throw new Error('Invalid stream');
		}

		// Validate parameters
		if (!options.input.filePath || options.input.content === undefined) {
			throw new Error('Invalid input: filePath and content are required');
		}

		const fileExists = await this.fileExists(uri);
		const hasSupportedNotebooks = this.notebookService.hasSupportedNotebooks(uri);
		let doc = undefined;
		if (fileExists && hasSupportedNotebooks) {
			doc = await this.workspaceService.openNotebookDocumentAndSnapshot(uri, this.alternativeNotebookContent.getFormat(this._promptContext?.request?.model));
		} else if (fileExists && !hasSupportedNotebooks) {
			doc = await this.workspaceService.openTextDocumentAndSnapshot(uri);
		}

		if (fileExists && doc?.getText() !== '') {
			if (hasSupportedNotebooks) {
				throw new Error(`File already exists. You must use the ${ToolName.EditNotebook} tool to modify it.`);
			} else {
				throw new Error(`File already exists. You must use an edit tool to modify it.`);
			}
		} else if (!fileExists) {
			await this.fileSystemService.writeFile(uri, Buffer.from(''));
			doc = hasSupportedNotebooks
				? await this.workspaceService.openNotebookDocumentAndSnapshot(uri, this.alternativeNotebookContent.getFormat(this._promptContext?.request?.model))
				: await this.workspaceService.openTextDocumentAndSnapshot(uri);
		}

		if (hasSupportedNotebooks) {
			// Its possible we have a code block with a language id
			// Also possible we have file paths in the content.
			let content = options.input.content;
			const processor = new CodeBlockProcessor(() => undefined, () => undefined, (codeBlock) => content = codeBlock.code);
			processor.processMarkdown(options.input.content);
			processor.flush();
			content = removeLeadingFilepathComment(options.input.content, doc!.languageId, options.input.filePath);
			await processFullRewriteNewNotebook(uri, content, this._promptContext.stream, this.alternativeNotebookEditGenerator, { source: NotebookEditGenrationSource.createFile, requestId: options.chatRequestId, model: options.model ? this.endpointProvider.getChatEndpoint(options.model).then(m => m.model) : undefined }, token);
			this._promptContext.stream.notebookEdit(uri, true);
			sendEditNotebookTelemetry(this.telemetryService, this.endpointProvider, 'createFile', uri, this._promptContext.requestId, options.model ?? this._promptContext.request?.model);
		} else {
			const content = removeLeadingFilepathComment(options.input.content, doc!.languageId, options.input.filePath);
			await processFullRewrite(uri, doc as TextDocumentSnapshot, content, this._promptContext.stream, token, []);
			this._promptContext.stream.textEdit(uri, true);

			// 跟踪新创建的文件
			await this.trackNewFileCreation(uri, content);

			return new LanguageModelToolResult([
				new LanguageModelPromptTsxPart(
					await renderPromptElementJSON(
						this.instantiationService,
						EditFileResult,
						{ files: [{ operation: ActionType.ADD, uri, isNotebook: false }], diagnosticsTimeout: 2000, toolName: ToolName.CreateFile, requestId: options.chatRequestId, model: options.model },
						options.tokenizationOptions ?? {
							tokenBudget: 1000,
							countTokens: (t) => Promise.resolve(t.length * 3 / 4)
						},
						token,
					),
				)
			]);
		}

		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				`File created at ${this.promptPathRepresentationService.getFilePath(uri)}`,
			)
		]);
	}

	private async trackNewFileCreation(uri: URI, content: string): Promise<void> {
		try {
			this.logService.info(`[DEBUG] CreateFileTool trackNewFileCreation: Starting for ${uri.fsPath}`);
			this.logService.info(`[DEBUG] CreateFileTool trackNewFileCreation: content length=${content.length}`);

			// 只有在agent模式下才跟踪文件变化
			if (this.getSessionManager().isAgentMode()) {
				this.logService.info(`[DEBUG] CreateFileTool trackNewFileCreation: In agent mode`);

				const tracker = this.getSessionManager().getCurrentSessionTracker();
				this.logService.info(`[DEBUG] CreateFileTool trackNewFileCreation: Got tracker: ${!!tracker}`);

				// 新文件创建，直接使用内容计算行数
				const lines = content.split('\n');
				const addedLines = content.endsWith('\n') && lines[lines.length - 1] === ''
					? Math.max(1, lines.length - 1)
					: lines.length;

				this.logService.info(`[DEBUG] CreateFileTool trackNewFileCreation: lines array length=${lines.length}`);
				this.logService.info(`[DEBUG] CreateFileTool trackNewFileCreation: calculated addedLines=${addedLines}`);
				this.logService.info(`[DEBUG] CreateFileTool trackNewFileCreation: content ends with newline=${content.endsWith('\n')}`);

				await tracker.trackFileChangeWithExactLines(uri, 'add', addedLines, 0);

				this.logService.info(`[DEBUG] CreateFileTool trackNewFileCreation: trackFileChangeWithExactLines completed`);
			} else {
				this.logService.info(`[DEBUG] CreateFileTool trackNewFileCreation: Not in agent mode, skipping track`);
			}
		} catch (error) {
			this.logService.error(`[DEBUG] CreateFileTool trackNewFileCreation: Failed to track new file creation for ${uri.fsPath}: ${error}`);
		}
	}

	/**
	 * Don't copy this helper, this is generally not a good pattern because it's vulnerable to race conditions. But the fileSystemService doesn't give us a proper atomic method for this.
	 */
	private async fileExists(uri: URI): Promise<boolean> {
		try {
			await this.fileSystemService.stat(uri);
			return true;
		} catch (e) {
			return false;
		}
	}

	async resolveInput(input: ICreateFileParams, promptContext: IBuildPromptContext): Promise<ICreateFileParams> {
		this._promptContext = promptContext;
		return input;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ICreateFileParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const uri = resolveToolInputPath(options.input.filePath, this.promptPathRepresentationService);
		return {
			invocationMessage: new MarkdownString(l10n.t`Creating ${formatUriForFileWidget(uri)}`),
			pastTenseMessage: new MarkdownString(l10n.t`Created ${formatUriForFileWidget(uri)}`)
		};
	}
}

ToolRegistry.registerTool(CreateFileTool);