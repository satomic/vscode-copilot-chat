/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../util/vs/base/common/uri';
import { AgentFileChangeTracker } from '../agentFileChangeTracker';
import { AgentSessionManager } from '../agentSessionManager';

describe('AgentFileChangeTracker', () => {
	let tracker: AgentFileChangeTracker;
	let mockWorkspaceService: any;
	let mockFileSystemService: any;
	let mockTelemetryService: any;
	let mockInstantiationService: any;

	beforeEach(() => {
		mockWorkspaceService = {
			getWorkspaceFolder: () => ({ uri: URI.file('/test/workspace') })
		};
		mockFileSystemService = {
			createDirectory: jest.fn(),
			writeFile: jest.fn()
		};
		mockTelemetryService = {
			sendMSFTTelemetryEvent: jest.fn()
		};
		mockInstantiationService = {};

		tracker = new AgentFileChangeTracker(
			mockInstantiationService,
			mockWorkspaceService,
			mockFileSystemService,
			mockTelemetryService
		);
	});

	describe('trackFileChange', () => {
		it('should track file addition correctly', async () => {
			const uri = URI.file('/test/file.js');
			const newContent = 'console.log("Hello World");\nconst x = 1;';

			const result = await tracker.trackFileChange(uri, 'add', undefined, newContent);

			expect(result.filePath).toBe('/test/file.js');
			expect(result.addedLines).toBe(2);
			expect(result.removedLines).toBe(0);
			expect(result.operation).toBe('add');
		});

		it('should track file deletion correctly', async () => {
			const uri = URI.file('/test/file.js');
			const oldContent = 'console.log("Hello World");\nconst x = 1;\nconst y = 2;';

			const result = await tracker.trackFileChange(uri, 'delete', oldContent, undefined);

			expect(result.filePath).toBe('/test/file.js');
			expect(result.addedLines).toBe(0);
			expect(result.removedLines).toBe(3);
			expect(result.operation).toBe('delete');
		});

		it('should track file update correctly', async () => {
			const uri = URI.file('/test/file.js');
			const oldContent = 'console.log("Hello");\nconst x = 1;';
			const newContent = 'console.log("Hello World");\nconst x = 1;\nconst y = 2;';

			const result = await tracker.trackFileChange(uri, 'update', oldContent, newContent);

			expect(result.filePath).toBe('/test/file.js');
			expect(result.addedLines).toBe(1);
			expect(result.removedLines).toBe(0);
			expect(result.operation).toBe('update');
		});
	});

	describe('getSessionStats', () => {
		it('should return correct session statistics', async () => {
			const uri1 = URI.file('/test/file1.js');
			const uri2 = URI.file('/test/file2.js');

			await tracker.trackFileChange(uri1, 'add', undefined, 'line1\nline2');
			await tracker.trackFileChange(uri2, 'update', 'old1\nold2', 'new1\nnew2\nnew3');

			const stats = tracker.getSessionStats();

			expect(stats.totalFilesChanged).toBe(2);
			expect(stats.totalAddedLines).toBe(5); // 2 from add + 3 from update
			expect(stats.totalRemovedLines).toBe(2); // 2 from update
			expect(stats.fileChanges).toHaveLength(2);
		});
	});

	describe('printSessionStats', () => {
		it('should print statistics when files are modified', async () => {
			const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

			const uri = URI.file('/test/file.js');
			await tracker.trackFileChange(uri, 'add', undefined, 'line1\nline2');

			tracker.printSessionStats();

			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Agent File Changes Summary'));
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Total Files Changed: 1'));
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Total Lines Added: +2'));

			consoleSpy.mockRestore();
		});

		it('should print no files message when no files are modified', () => {
			const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

			tracker.printSessionStats();

			expect(consoleSpy).toHaveBeenCalledWith('No files were modified in this agent session.');

			consoleSpy.mockRestore();
		});
	});

	describe('saveSessionStats', () => {
		it('should save statistics to JSON file when files are modified', async () => {
			const uri = URI.file('/test/file.js');
			await tracker.trackFileChange(uri, 'add', undefined, 'line1\nline2');

			await tracker.saveSessionStats();

			expect(mockFileSystemService.createDirectory).toHaveBeenCalled();
			expect(mockFileSystemService.writeFile).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: expect.stringContaining('agent-session-') }),
				expect.any(Buffer)
			);
		});

		it('should not save when no files are modified', async () => {
			await tracker.saveSessionStats();

			expect(mockFileSystemService.createDirectory).not.toHaveBeenCalled();
			expect(mockFileSystemService.writeFile).not.toHaveBeenCalled();
		});
	});
});

describe('AgentSessionManager', () => {
	let sessionManager: AgentSessionManager;
	let mockWorkspaceService: any;
	let mockFileSystemService: any;
	let mockTelemetryService: any;
	let mockInstantiationService: any;

	beforeEach(() => {
		mockWorkspaceService = {
			getWorkspaceFolder: () => ({ uri: URI.file('/test/workspace') })
		};
		mockFileSystemService = {
			createDirectory: jest.fn(),
			writeFile: jest.fn()
		};
		mockTelemetryService = {
			sendMSFTTelemetryEvent: jest.fn()
		};
		mockInstantiationService = {};

		sessionManager = new AgentSessionManager(
			mockInstantiationService,
			mockWorkspaceService,
			mockFileSystemService,
			mockTelemetryService
		);
	});

	describe('startNewSession', () => {
		it('should start a new session with custom session ID', () => {
			const customSessionId = 'custom-session-123';
			sessionManager.startNewSession(customSessionId);

			const stats = sessionManager.getCurrentSessionStats();
			expect(stats).not.toBeNull();
			expect(stats!.sessionId).toBe(customSessionId);
		});

		it('should start a new session with generated session ID', () => {
			sessionManager.startNewSession();

			const stats = sessionManager.getCurrentSessionStats();
			expect(stats).not.toBeNull();
			expect(stats!.sessionId).toMatch(/^agent-session-\d+-[a-z0-9]+$/);
		});
	});

	describe('isAgentMode', () => {
		it('should return false initially', () => {
			expect(sessionManager.isAgentMode()).toBe(false);
		});

		it('should return true after starting session', () => {
			sessionManager.startNewSession();
			expect(sessionManager.isAgentMode()).toBe(true);
		});
	});

	describe('setAgentMode', () => {
		it('should set agent mode and start session if needed', () => {
			sessionManager.setAgentMode(true);

			expect(sessionManager.isAgentMode()).toBe(true);
			expect(sessionManager.getCurrentSessionStats()).not.toBeNull();
		});

		it('should set agent mode to false', () => {
			sessionManager.startNewSession();
			sessionManager.setAgentMode(false);

			expect(sessionManager.isAgentMode()).toBe(false);
		});
	});

	describe('endCurrentSession', () => {
		it('should end session and save statistics', async () => {
			sessionManager.startNewSession();
			const tracker = sessionManager.getCurrentSessionTracker();

			// Add some file changes
			await tracker.trackFileChange(URI.file('/test/file.js'), 'add', undefined, 'line1\nline2');

			await sessionManager.endCurrentSession();

			expect(sessionManager.isAgentMode()).toBe(false);
			expect(sessionManager.getCurrentSessionStats()).toBeNull();
			expect(mockTelemetryService.sendMSFTTelemetryEvent).toHaveBeenCalledWith('agentSessionEnd', expect.any(Object), expect.any(Object));
		});
	});
});