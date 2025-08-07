/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { AgentSessionManager, IAgentSessionManager } from './agentSessionManager';

/**
 * 单例模式的AgentSessionManager，确保所有工具共享同一个实例
 */
export class AgentSessionSingleton {
	private static instance: IAgentSessionManager | undefined;

	public static getInstance(
		workspaceService: IWorkspaceService,
		fileSystemService: IFileSystemService,
		telemetryService: ITelemetryService,
		logService: ILogService
	): IAgentSessionManager {
		if (!AgentSessionSingleton.instance) {
			AgentSessionSingleton.instance = new AgentSessionManager(
				workspaceService,
				fileSystemService,
				telemetryService,
				logService
			);
		}
		return AgentSessionSingleton.instance;
	}

	public static reset(): void {
		AgentSessionSingleton.instance = undefined;
	}
}
