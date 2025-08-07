/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptElementProps, PromptSizing } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { modelNeedsStrongReplaceStringHint } from '../../../platform/endpoint/common/chatModelCapabilities';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILanguageDiagnosticsService } from '../../../platform/languages/common/languageDiagnosticsService';
import { ILogService } from '../../../platform/log/common/logService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ISimulationTestContext } from '../../../platform/simulationTestContext/common/simulationTestContext';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { getLanguage } from '../../../util/common/languages';
import { timeout } from '../../../util/vs/base/common/async';
import { URI } from '../../../util/vs/base/common/uri';
import { Diagnostic, DiagnosticSeverity } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { AgentSessionManager, IAgentSessionManager } from './agentSessionManager';
import { DiagnosticToolOutput } from './getErrorsTool';

export interface IEditedFile {
	operation: 'add' | 'delete' | 'update';
	existingDiagnostics?: Diagnostic[];
	uri: URI;
	isNotebook: boolean;
	error?: string;
}

export interface IEditFileResultProps extends BasePromptElementProps {
	files: IEditedFile[];
	diagnosticsTimeout?: number;
	toolName?: ToolName;
	requestId?: string;
	model?: vscode.LanguageModelChat;
	healed?: string;
}

export class EditFileResult extends PromptElement<IEditFileResultProps> {
	private sessionManager: IAgentSessionManager;

	constructor(
		props: PromptElementProps<IEditFileResultProps>,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILanguageDiagnosticsService private readonly languageDiagnosticsService: ILanguageDiagnosticsService,
		@ISimulationTestContext private readonly testContext: ISimulationTestContext,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IWorkspaceService protected readonly workspaceService: IWorkspaceService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ILogService private readonly logService: ILogService,
	) {
		super(props);
		this.sessionManager = new AgentSessionManager(
			this.workspaceService,
			this.fileSystemService,
			this.telemetryService,
			this.logService
		);
	}

	override async render(state: void, sizing: PromptSizing) {
		const successfullyEditedFiles: string[] = [];
		const editingErrors: string[] = [];
		const editsWithDiagnostics: { file: string; diagnostics: PromptElement }[] = [];
		let totalNewDiagnostics = 0;
		let filesWithNewDiagnostics = 0;

		// 处理文件编辑结果并跟踪文件变化
		for (const file of this.props.files) {
			if (file.error) {
				editingErrors.push(file.error);
				continue;
			}

			// 跟踪文件变化（如果在agent模式下）
			if (this.sessionManager.isAgentMode()) {
				try {
					const tracker = this.sessionManager.getCurrentSessionTracker();

					// 对于EditFileResult，我们基于operation类型进行跟踪
					// 由于我们在edit之后，无法获取编辑前的内容，所以使用简化的跟踪方式
					let newContent: string | undefined;
					if (file.operation === 'add' || file.operation === 'update') {
						try {
							const snapshot = await this.workspaceService.openTextDocumentAndSnapshot(file.uri);
							newContent = snapshot.getText();
						} catch (error) {
							this.logService.warn(`Failed to get content for ${file.operation} file ${file.uri.fsPath}: ${error}`);
						}
					}

					await tracker.trackFileChange(file.uri, file.operation, undefined, newContent);

					this.logService.info(`Tracked file change: ${file.uri.fsPath} (${file.operation})`);
				} catch (error) {
					this.logService.warn(`Failed to track file change for ${file.uri.fsPath}: ${error}`);
				}
			}

			const diagnostics = !this.testContext.isInSimulationTests && this.configurationService.getConfig(ConfigKey.AutoFixDiagnostics) && !(file.isNotebook)
				? await this.getNewDiagnostics(file)
				: [];

			if (diagnostics.length && !file.isNotebook) {
				totalNewDiagnostics += diagnostics.length;
				filesWithNewDiagnostics++;
				const newSnapshot = await this.workspaceService.openTextDocumentAndSnapshot(file.uri);
				editsWithDiagnostics.push({
					file: this.promptPathRepresentationService.getFilePath(file.uri),
					diagnostics: <DiagnosticToolOutput
						diagnosticsGroups={[{
							context: { document: newSnapshot, language: getLanguage(newSnapshot) },
							diagnostics,
							uri: file.uri,
						}]}
						maxDiagnostics={20}
					/>
				});
				continue;
			}

			successfullyEditedFiles.push(this.promptPathRepresentationService.getFilePath(file.uri));
		}

		if (this.props.toolName && this.props.requestId) {
			await this.sendEditFileResultTelemetry(totalNewDiagnostics, filesWithNewDiagnostics);
		}

		// 检查是否应该打印Agent会话统计信息
		if (successfullyEditedFiles.length > 0 && this.sessionManager.isAgentMode()) {
			const tracker = this.sessionManager.getCurrentSessionTracker();
			const sessionStats = tracker.getSessionStats();

			this.logService.info(`Agent session has modified ${sessionStats.totalFilesChanged} files so far`);

			// 如果有文件变化，打印详细统计信息并保存JSON
			if (sessionStats.totalFilesChanged > 0) {
				tracker.printSessionStats();
				await tracker.saveSessionStats();
			}
		}

		return (
			<>
				{this.props.healed && <>There was an error applying your original patch, and it was modified to the following:<br />{this.props.healed}<br /></>}
				{successfullyEditedFiles.length > 0 &&
					<>The following files were successfully edited:<br />
						{successfullyEditedFiles.join('\n')}<br /></>}
				{editingErrors.length > 0 && <>
					{editingErrors.join('\n')}
					{this.props.model && modelNeedsStrongReplaceStringHint(this.props.model) && <><br /><br />You may use the {ToolName.EditFile} tool to retry these edits.</>}
				</>}
				{editsWithDiagnostics.length > 0 &&
					editsWithDiagnostics.map(edit => {
						return <>
							The edit to {edit.file} was applied successfully.<br />
							The edit resulted in the following lint errors:<br />
							{edit.diagnostics}
						</>;
					})}
			</>
		);
	}

	private async getNewDiagnostics(editedFile: IEditedFile): Promise<Diagnostic[]> {
		await timeout(this.props.diagnosticsTimeout ?? 1000);

		const existingDiagnostics = editedFile.existingDiagnostics || [];
		const newDiagnostics: Diagnostic[] = [];

		for (const diagnostic of this.languageDiagnosticsService.getDiagnostics(editedFile.uri)) {
			if (diagnostic.severity !== DiagnosticSeverity.Error && diagnostic.severity !== DiagnosticSeverity.Warning) {
				continue;
			}

			// Won't help if edit caused lines to move around, but better than nothing
			const isDuplicate = existingDiagnostics.some(existing =>
				existing.message === diagnostic.message &&
				existing.range.start.line === diagnostic.range.start.line &&
				existing.range.start.character === diagnostic.range.start.character &&
				existing.range.end.line === diagnostic.range.end.line &&
				existing.range.end.character === diagnostic.range.end.character
			);

			if (!isDuplicate) {
				newDiagnostics.push(diagnostic);
			}
		}

		return newDiagnostics;
	}

	private async sendEditFileResultTelemetry(totalNewDiagnostics: number, filesWithNewDiagnostics: number) {
		const model = this.props.model && (await this.endpointProvider.getChatEndpoint(this.props.model)).model;

		/* __GDPR__
			"editFileResult.diagnostics" : {
				"owner": "roblourens",
				"comment": "Tracks whether new diagnostics were found after editing files",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
				"toolName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The name of the tool that performed the edit" },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that invoked the tool" },
				"totalNewDiagnostics": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of new diagnostics found across all files" },
				"filesWithNewDiagnostics": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of files that had new diagnostics" },
				"totalFilesEdited": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of files that were edited" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('editFileResult.diagnostics',
			{
				requestId: this.props.requestId!,
				toolName: this.props.toolName!,
				model,
			},
			{
				totalNewDiagnostics,
				filesWithNewDiagnostics,
				totalFilesEdited: this.props.files.length
			}
		);
	}
}
