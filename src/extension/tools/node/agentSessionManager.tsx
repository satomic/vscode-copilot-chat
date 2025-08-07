/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { AgentFileChangeTracker, IAgentFileChangeTracker, IAgentSessionStats } from './agentFileChangeTracker';

export interface IAgentSessionManager {
	/**
	 * 获取当前会话的文件变化跟踪器
	 */
	getCurrentSessionTracker(): IAgentFileChangeTracker;

	/**
	 * 开始新的agent会话
	 */
	startNewSession(sessionId?: string): void;

	/**
	 * 结束当前会话并保存统计信息
	 */
	endCurrentSession(): Promise<void>;

	/**
	 * 获取当前会话统计信息
	 */
	getCurrentSessionStats(): IAgentSessionStats | null;

	/**
	 * 检查是否在agent模式下
	 */
	isAgentMode(): boolean;

	/**
	 * 设置agent模式状态
	 */
	setAgentMode(isAgent: boolean): void;
}

export class AgentSessionManager implements IAgentSessionManager {
	private currentTracker: IAgentFileChangeTracker | null = null;
	private isAgentModeActive: boolean = false;
	private sessionId: string | null = null;

	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILogService private readonly logService: ILogService,
	) { }

	getCurrentSessionTracker(): IAgentFileChangeTracker {
		if (!this.currentTracker) {
			this.currentTracker = new AgentFileChangeTracker(
				this.workspaceService,
				this.fileSystemService,
				this.telemetryService,
				this.logService
			);
		}
		return this.currentTracker;
	}

	startNewSession(sessionId?: string): void {
		this.sessionId = sessionId || this.generateSessionId();
		this.currentTracker = new AgentFileChangeTracker(
			this.workspaceService,
			this.fileSystemService,
			this.telemetryService,
			this.logService
		);
		this.currentTracker.resetSession(this.sessionId);
		this.isAgentModeActive = true;
	}

	async endCurrentSession(): Promise<void> {
		if (this.currentTracker && this.isAgentModeActive) {
			// 打印最终统计信息
			this.currentTracker.printSessionStats();

			// 保存统计信息到JSON文件
			await this.currentTracker.saveSessionStats();

			// 发送会话结束遥测
			this.sendSessionEndTelemetry();
		}

		this.currentTracker = null;
		this.isAgentModeActive = false;
		this.sessionId = null;
	}

	getCurrentSessionStats(): IAgentSessionStats | null {
		return this.currentTracker ? this.currentTracker.getSessionStats() : null;
	}

	isAgentMode(): boolean {
		// 目前先假设所有操作都在agent模式下，这样我们能看到跟踪效果
		// 在真正的实现中，可能需要根据实际的agent上下文来判断
		return true; // 临时设置为true来启用跟踪
	}

	setAgentMode(isAgent: boolean): void {
		this.isAgentModeActive = isAgent;
		if (isAgent && !this.currentTracker) {
			this.startNewSession();
		}
	}

	private generateSessionId(): string {
		return `agent-session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	}

	private sendSessionEndTelemetry(): void {
		if (!this.currentTracker) return;

		const stats = this.currentTracker.getSessionStats();

		/* __GDPR__
			"agentSessionEnd" : {
				"owner": "roblourens",
				"comment": "Tracks agent session completion",
				"sessionId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the agent session" },
				"totalFilesChanged": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of files changed in the session" },
				"totalAddedLines": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of lines added in the session" },
				"totalRemovedLines": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of lines removed in the session" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('agentSessionEnd', {
			sessionId: stats.sessionId,
		}, {
			totalFilesChanged: stats.totalFilesChanged,
			totalAddedLines: stats.totalAddedLines,
			totalRemovedLines: stats.totalRemovedLines
		});
	}
}