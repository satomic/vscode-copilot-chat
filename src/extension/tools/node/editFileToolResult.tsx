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
	) {
		super(props);
		this.sessionManager = new AgentSessionManager(
			props.instantiationService,
			this.workspaceService,
			this.fileSystemService,
			this.telemetryService
		);
	}

	override async render(state: void, sizing: PromptSizing) {
		const successfullyEditedFiles: string[] = [];
		const editingErrors: string[] = [];
		const editsWithDiagnostics: { file: string; diagnostics: PromptElement }[] = [];
		let totalNewDiagnostics = 0;
		let filesWithNewDiagnostics = 0;

		// 跟踪文件变化
		for (const file of this.props.files) {
			if (file.error) {
				editingErrors.push(file.error);
				continue;
			}

			// 获取文件修改前后的内容用于计算行数变化
			let oldContent: string | undefined;
			let newContent: string | undefined;

			try {
				if (file.operation === 'update' || file.operation === 'delete') {
					// 尝试获取修改前的内容
					const oldSnapshot = await this.workspaceService.openTextDocumentAndSnapshot(file.uri);
					oldContent = oldSnapshot.getText();
				}

				if (file.operation === 'add' || file.operation === 'update') {
					// 获取修改后的内容
					const newSnapshot = await this.workspaceService.openTextDocumentAndSnapshot(file.uri);
					newContent = newSnapshot.getText();
				}

				// 跟踪文件变化
				const tracker = this.sessionManager.getCurrentSessionTracker();
				await tracker.trackFileChange(file.uri, file.operation, oldContent, newContent);
			} catch (error) {
				console.warn(`Failed to track file change for ${file.uri.fsPath}:`, error);
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

		// 如果有文件被修改，打印统计信息并保存JSON文件
		if (successfullyEditedFiles.length > 0) {
			// 打印统计信息到OUTPUT
			const tracker = this.sessionManager.getCurrentSessionTracker();
			tracker.printSessionStats();

			// 保存统计信息到JSON文件
			await tracker.saveSessionStats();
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
