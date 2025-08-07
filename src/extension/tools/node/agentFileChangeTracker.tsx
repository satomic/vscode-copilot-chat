/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { URI } from '../../../util/vs/base/common/uri';

export interface IFileChangeStats {
	filePath: string;
	addedLines: number;
	removedLines: number;
	operation: 'add' | 'delete' | 'update';
}

export interface IAgentSessionStats {
	sessionId: string;
	timestamp: string;
	totalFilesChanged: number;
	totalAddedLines: number;
	totalRemovedLines: number;
	fileChanges: IFileChangeStats[];
}

export interface IAgentFileChangeTracker {
	/**
	 * 跟踪文件变化
	 */
	trackFileChange(uri: URI, operation: 'add' | 'delete' | 'update', oldContent?: string, newContent?: string): Promise<IFileChangeStats>;

	/**
	 * 使用精确的行数信息跟踪文件变化
	 */
	trackFileChangeWithExactLines(uri: URI, operation: 'add' | 'delete' | 'update', addedLines: number, removedLines: number): Promise<IFileChangeStats>;

	/**
	 * 获取当前会话的统计信息
	 */
	getSessionStats(): IAgentSessionStats;

	/**
	 * 重置会话
	 */
	resetSession(sessionId: string): void;

	/**
	 * 保存当前会话统计到文件
	 */
	saveSessionStats(): Promise<void>;

	/**
	 * 在OUTPUT中打印当前会话的修改统计
	 */
	printSessionStats(): void;
}

export class AgentFileChangeTracker implements IAgentFileChangeTracker {
	private sessionStats: IAgentSessionStats;

	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILogService private readonly logService: ILogService,
	) {
		this.sessionStats = this.createNewSession();
	}

	private createNewSession(): IAgentSessionStats {
		return {
			sessionId: this.generateSessionId(),
			timestamp: new Date().toISOString(),
			totalFilesChanged: 0,
			totalAddedLines: 0,
			totalRemovedLines: 0,
			fileChanges: []
		};
	}

	private generateSessionId(): string {
		return `agent-session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	}

	async trackFileChangeWithExactLines(uri: URI, operation: 'add' | 'delete' | 'update', addedLines: number, removedLines: number): Promise<IFileChangeStats> {
		const filePath = uri.fsPath;

		// 添加调试日志
		this.logService.info(`[DEBUG] trackFileChangeWithExactLines: ${filePath}, operation: ${operation}, +${addedLines}, -${removedLines}`);

		const fileStats: IFileChangeStats = {
			filePath,
			addedLines,
			removedLines,
			operation
		};

		// 更新会话统计
		this.sessionStats.fileChanges.push(fileStats);
		this.sessionStats.totalFilesChanged++;
		this.sessionStats.totalAddedLines += addedLines;
		this.sessionStats.totalRemovedLines += removedLines;

		// 发送遥测数据
		this.sendFileChangeTelemetry(fileStats);

		this.logService.info(`[DEBUG] Session totals now: files: ${this.sessionStats.totalFilesChanged}, +${this.sessionStats.totalAddedLines}, -${this.sessionStats.totalRemovedLines}`);

		return fileStats;
	}

	async trackFileChange(uri: URI, operation: 'add' | 'delete' | 'update', oldContent?: string, newContent?: string): Promise<IFileChangeStats> {
		const filePath = uri.fsPath;
		let addedLines = 0;
		let removedLines = 0;

		// 添加调试日志
		this.logService.info(`[DEBUG] trackFileChange: ${filePath}, operation: ${operation}`);
		this.logService.info(`[DEBUG] oldContent length: ${oldContent ? oldContent.length : 'undefined'}, newContent length: ${newContent ? newContent.length : 'undefined'}`);

		if (operation === 'add') {
			// 新文件，所有行都是新增的
			if (newContent) {
				addedLines = newContent.split('\n').length;
				this.logService.info(`[DEBUG] New file: ${addedLines} lines added`);
			}
		} else if (operation === 'delete') {
			// 删除文件，所有行都是删除的
			if (oldContent) {
				removedLines = oldContent.split('\n').length;
				this.logService.info(`[DEBUG] Deleted file: ${removedLines} lines removed`);
			}
		} else if (operation === 'update' && oldContent && newContent) {
			// 更新文件，计算差异
			const diff = this.calculateLineDiff(oldContent, newContent);
			addedLines = diff.addedLines;
			removedLines = diff.removedLines;
			this.logService.info(`[DEBUG] Updated file: +${addedLines}, -${removedLines} lines`);
		} else {
			this.logService.info(`[DEBUG] No diff calculated - operation: ${operation}, oldContent: ${!!oldContent}, newContent: ${!!newContent}`);
		}

		const fileStats: IFileChangeStats = {
			filePath,
			addedLines,
			removedLines,
			operation
		};

		// 更新会话统计
		this.sessionStats.fileChanges.push(fileStats);
		this.sessionStats.totalFilesChanged++;
		this.sessionStats.totalAddedLines += addedLines;
		this.sessionStats.totalRemovedLines += removedLines;

		// 发送遥测数据
		this.sendFileChangeTelemetry(fileStats);

		this.logService.info(`[DEBUG] Session totals now: files: ${this.sessionStats.totalFilesChanged}, +${this.sessionStats.totalAddedLines}, -${this.sessionStats.totalRemovedLines}`);

		return fileStats;
	}

	private calculateLineDiff(oldContent: string, newContent: string): { addedLines: number; removedLines: number } {
		const oldLines = oldContent.split('\n');
		const newLines = newContent.split('\n');

		let addedLines = 0;
		let removedLines = 0;

		// 使用简单的行数差异计算
		// 这里可以根据需要实现更复杂的diff算法，比如使用Myers diff算法
		const oldLineCount = oldLines.length;
		const newLineCount = newLines.length;

		if (newLineCount > oldLineCount) {
			addedLines = newLineCount - oldLineCount;
		} else if (oldLineCount > newLineCount) {
			removedLines = oldLineCount - newLineCount;
		} else {
			// 如果行数相同，检查内容变化
			let changedLines = 0;
			for (let i = 0; i < Math.min(oldLineCount, newLineCount); i++) {
				if (oldLines[i] !== newLines[i]) {
					changedLines++;
				}
			}
			// 对于内容变化但行数相同的情况，我们认为是替换了那些变化的行
			if (changedLines > 0) {
				addedLines = changedLines;
				removedLines = changedLines;
			}
		}

		return { addedLines, removedLines };
	}

	getSessionStats(): IAgentSessionStats {
		return { ...this.sessionStats };
	}

	resetSession(sessionId: string): void {
		this.sessionStats = this.createNewSession();
		this.sessionStats.sessionId = sessionId;
	}

	async saveSessionStats(): Promise<void> {
		if (this.sessionStats.totalFilesChanged === 0) {
			return; // 没有文件修改，不保存
		}

		try {
			const workspaceFolders = this.workspaceService.getWorkspaceFolders();
			if (!workspaceFolders || workspaceFolders.length === 0) {
				this.logService.warn('No workspace root found, cannot save session stats');
				return;
			}

			const workspaceRoot = workspaceFolders[0];
			const statsDir = URI.joinPath(workspaceRoot, '.vscode', 'agent-stats');

			try {
				await this.fileSystemService.createDirectory(statsDir);
			} catch (error) {
				// 目录可能已经存在，忽略错误
			}

			const statsFile = URI.joinPath(statsDir, `agent-session-${this.sessionStats.sessionId}.json`);
			const statsContent = JSON.stringify(this.sessionStats, null, 2);

			await this.fileSystemService.writeFile(statsFile, Buffer.from(statsContent, 'utf8'));

			this.logService.info(`Agent session stats saved to: ${statsFile.fsPath}`);
		} catch (error) {
			this.logService.error('Failed to save agent session stats:', error);
		}
	}

	printSessionStats(): void {
		if (this.sessionStats.totalFilesChanged === 0) {
			this.logService.info('No files were modified in this agent session.');
			return;
		}

		const statsMessage = [
			'\n=== Agent File Changes Summary ===',
			`Session ID: ${this.sessionStats.sessionId}`,
			`Timestamp: ${this.sessionStats.timestamp}`,
			`Total Files Changed: ${this.sessionStats.totalFilesChanged}`,
			`Total Lines Added: +${this.sessionStats.totalAddedLines}`,
			`Total Lines Removed: -${this.sessionStats.totalRemovedLines}`,
			`Net Change: ${this.sessionStats.totalAddedLines - this.sessionStats.totalRemovedLines > 0 ? '+' : ''}${this.sessionStats.totalAddedLines - this.sessionStats.totalRemovedLines}`,
			'',
			'File Changes:'
		];

		this.sessionStats.fileChanges.forEach(change => {
			const netChange = change.addedLines - change.removedLines;
			const changeIndicator = netChange > 0 ? '+' : netChange < 0 ? '-' : '=';
			statsMessage.push(`  ${changeIndicator} ${change.filePath} (+${change.addedLines}, -${change.removedLines}) [${change.operation}]`);
		});

		statsMessage.push('================================\n');

		// 使用logService.info输出完整的统计信息
		this.logService.info(statsMessage.join('\n'));
	}

	private sendFileChangeTelemetry(fileStats: IFileChangeStats): void {
		/* __GDPR__
			"agentFileChange" : {
				"owner": "roblourens",
				"comment": "Tracks file changes made by agent mode",
				"filePath": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The path of the file that was changed" },
				"operation": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The type of operation performed" },
				"addedLines": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of lines added" },
				"removedLines": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of lines removed" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('agentFileChange', {
			filePath: fileStats.filePath,
			operation: fileStats.operation,
		}, {
			addedLines: fileStats.addedLines,
			removedLines: fileStats.removedLines
		});
	}
}