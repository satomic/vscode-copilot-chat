/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';

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
	 * 跟踪文件修改并计算行数变化
	 */
	trackFileChange(uri: URI, operation: 'add' | 'delete' | 'update', oldContent?: string, newContent?: string): Promise<IFileChangeStats>;

	/**
	 * 获取当前会话的统计信息
	 */
	getSessionStats(): IAgentSessionStats;

	/**
	 * 重置会话统计
	 */
	resetSession(sessionId: string): void;

	/**
	 * 保存会话统计到JSON文件
	 */
	saveSessionStats(): Promise<void>;

	/**
	 * 在OUTPUT中打印当前会话的修改统计
	 */
	printSessionStats(): void;
}

export class AgentFileChangeTracker implements IAgentFileChangeTracker {
	private sessionStats: IAgentSessionStats;
	private readonly outputChannelName = 'Agent File Changes';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
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

	async trackFileChange(uri: URI, operation: 'add' | 'delete' | 'update', oldContent?: string, newContent?: string): Promise<IFileChangeStats> {
		const filePath = uri.fsPath;
		let addedLines = 0;
		let removedLines = 0;

		if (operation === 'add') {
			// 新文件，所有行都是新增的
			if (newContent) {
				addedLines = newContent.split('\n').length;
			}
		} else if (operation === 'delete') {
			// 删除文件，所有行都是删除的
			if (oldContent) {
				removedLines = oldContent.split('\n').length;
			}
		} else if (operation === 'update' && oldContent && newContent) {
			// 更新文件，计算差异
			const diff = this.calculateLineDiff(oldContent, newContent);
			addedLines = diff.addedLines;
			removedLines = diff.removedLines;
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

		return fileStats;
	}

	private calculateLineDiff(oldContent: string, newContent: string): { addedLines: number; removedLines: number } {
		const oldLines = oldContent.split('\n');
		const newLines = newContent.split('\n');

		let addedLines = 0;
		let removedLines = 0;

		// 使用简单的行数差异计算
		// 这里可以根据需要实现更复杂的diff算法，比如使用Myers diff算法
		if (newLines.length > oldLines.length) {
			addedLines = newLines.length - oldLines.length;
		} else if (oldLines.length > newLines.length) {
			removedLines = oldLines.length - newLines.length;
		}

		// 如果行数相同，检查内容变化
		if (addedLines === 0 && removedLines === 0) {
			// 检查是否有内容变化
			for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
				if (oldLines[i] !== newLines[i]) {
					// 如果内容有变化，假设是替换了一行
					addedLines = 1;
					removedLines = 1;
					break;
				}
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
			const workspaceRoot = this.workspaceService.getWorkspaceFolder()?.uri;
			if (!workspaceRoot) {
				console.warn('No workspace root found, cannot save session stats');
				return;
			}

			const statsDir = URI.joinPath(workspaceRoot, '.vscode', 'agent-stats');
			await this.fileSystemService.createDirectory(statsDir, { recursive: true });

			const statsFile = URI.joinPath(statsDir, `agent-session-${this.sessionStats.sessionId}.json`);
			const statsContent = JSON.stringify(this.sessionStats, null, 2);

			await this.fileSystemService.writeFile(statsFile, Buffer.from(statsContent, 'utf8'));

			console.log(`Agent session stats saved to: ${statsFile.fsPath}`);
		} catch (error) {
			console.error('Failed to save agent session stats:', error);
		}
	}

	printSessionStats(): void {
		if (this.sessionStats.totalFilesChanged === 0) {
			console.log('No files were modified in this agent session.');
			return;
		}

		console.log('\n=== Agent File Changes Summary ===');
		console.log(`Session ID: ${this.sessionStats.sessionId}`);
		console.log(`Timestamp: ${this.sessionStats.timestamp}`);
		console.log(`Total Files Changed: ${this.sessionStats.totalFilesChanged}`);
		console.log(`Total Lines Added: +${this.sessionStats.totalAddedLines}`);
		console.log(`Total Lines Removed: -${this.sessionStats.totalRemovedLines}`);
		console.log(`Net Change: ${this.sessionStats.totalAddedLines - this.sessionStats.totalRemovedLines > 0 ? '+' : ''}${this.sessionStats.totalAddedLines - this.sessionStats.totalRemovedLines}`);

		console.log('\nFile Changes:');
		this.sessionStats.fileChanges.forEach(change => {
			const netChange = change.addedLines - change.removedLines;
			const changeIndicator = netChange > 0 ? '+' : netChange < 0 ? '-' : '=';
			console.log(`  ${changeIndicator} ${change.filePath} (+${change.addedLines}, -${change.removedLines}) [${change.operation}]`);
		});
		console.log('================================\n');
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