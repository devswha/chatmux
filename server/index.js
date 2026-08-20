#!/usr/bin/env node
// Load environment variables before other imports execute
import './load-env.js';
import { randomUUID } from 'node:crypto';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import Database from 'better-sqlite3';

import { AppError, getOpenCodeDatabasePath } from '@/shared/utils.js';
import {
    assertFreshLocalAgentTmuxTarget,
    assertTmuxPaneIdentity,
    attachCapabilityService,
    closeSessionsWatcher,
    createProviderToolApprovals,
    createDiscoveryCollector,
    createPaneOutputStream,
    createTmuxOutputActivityMonitor,
    getCurrentTmuxPaneIdentity,
    getCurrentTmuxPaneIdentityState,
    initializeSessionsWatcher,
    onTranscriptChanged,
    readTmuxPaneIdentity,
    runTmux,
    createTmuxRuntimeAdapter,
} from '@/modules/providers/index.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';
import {
    HerdrAdmissionService,
    HerdrControlBridgeService,
    HerdrRuntimeAdapter,
    RuntimeOperationPolicyService,
    RuntimeRegistryService,
    readHerdrRuntimeConfig,
} from '@/modules/terminal-runtimes/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { findAppRoot, getModuleDir } from './utils/runtime-paths.js';
import { createSystemRouter, detectInstallMode, exactUpdateRequestGuard } from './self-update.js';
import {
    queryClaudeSDK,
    abortClaudeSDKSession,
    getPendingApprovalsForSession,
    resolveToolApproval,
} from './claude-sdk.js';
import {
    spawnCursor,
    abortCursorSession,
} from './cursor-cli.js';
import {
    queryCodex,
    abortCodexSession,
} from './openai-codex.js';
import {
    spawnOpenCode,
    abortOpenCodeSession,
} from './opencode-cli.js';
import {
    spawnGjc,
    abortGjcSession,
    getPendingGjcApprovalsForSession,
    resolveGjcToolApproval,
    shutdownGjcWorker,
} from './gjc-worker-client.js';
import {
    spawnOmp,
    abortOmpSession,
} from './omp-cli.js';
import {
    spawnOmo,
    abortOmoSession,
} from './omo-cli.js';
import { findLiveTmuxSpawnBlock } from './modules/providers/services/live-spawn-guard.service.js';
import {
    stripAnsiSequences,
    normalizeDetectedUrl,
    extractUrlsFromText,
    shouldAutoOpenUrlFromOutput,
} from './utils/url-detection.js';
import gitRoutes from './routes/git.js';
import authRoutes from './routes/auth.js';
import cursorRoutes from './routes/cursor.js';
import commandsRoutes from './routes/commands.js';
import settingsRoutes from './routes/settings.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import userRoutes from './routes/user.js';
import providerRoutes from './modules/providers/provider.routes.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { buildExternalCliRuntimePath } from './modules/providers/services/external-cli-sessions.service.js';
import { assetsRoutes } from './modules/assets/index.js';
import { initializeDatabase, projectsDb, sessionsDb, userDb } from './modules/database/index.js';
import {
    notifyTmuxInputRequiredIfWatched,
    startCompletionOutboxDispatcher,
    startExternalTurnMonitor,
    startLiveTurnMonitor,
} from './modules/notifications/index.js';
import { filesRoutes } from './modules/files/index.js';
import { configureWebPush } from './services/vapid-keys.js';
import { authenticateToken, authenticateWebSocket, AUTH_MODE } from './middleware/auth.js';
import { c } from './utils/colors.js';
import { evaluateExposure } from './utils/exposure-guard.js';

const __dirname = getModuleDir(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findAppRoot(__dirname);
// Version of the server process, captured once for the health endpoint.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
// Fresh per server process — the self-update flow polls /health for a change
// of this id to learn that the restarted process is serving (version alone is
// not enough: a source update may not bump package.json).
const SERVER_BOOT_ID = randomUUID();
// How this install was deployed — decides whether one-click self-update is offered.
const INSTALL_MODE = detectInstallMode(APP_ROOT);
// Under systemd the user service inherits a minimal PATH that misses
// user-installed agent CLIs (~/.local/bin, ~/.bun/bin, ~/.cargo/bin). The
// release updater restarts the server via `systemctl --user restart`, so a
// server that worked from an interactive shell would suddenly fail every
// provider spawn with `spawn gjc ENOENT`. Normalize the process PATH once so
// spawns resolve the same binaries regardless of how the server was launched.
process.env.PATH = buildExternalCliRuntimePath();

console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

function readUsageNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
const {
    getPendingProviderApprovalsForSession,
    resolveProviderToolApproval,
} = createProviderToolApprovals({
    getPendingApprovalsForSession,
    getPendingGjcApprovalsForSession,
    resolveGjcToolApproval,
    resolveToolApproval,
});


const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const herdrConfig = readHerdrRuntimeConfig();
const terminalRuntimeRegistry = new RuntimeRegistryService();
terminalRuntimeRegistry.register(createTmuxRuntimeAdapter());
const herdrPolicy = new RuntimeOperationPolicyService(
    herdrConfig.startupCapabilities,
    herdrConfig.sources.map((source) => source.sourceId),
    herdrConfig.policyPath,
);
const herdrAdmissions = new HerdrAdmissionService();
const herdrAdapter = herdrConfig.enabled
    ? new HerdrRuntimeAdapter(
        herdrConfig,
        herdrPolicy,
        undefined,
        undefined,
        () => randomUUID(),
    )
    : null;
if (herdrAdapter) terminalRuntimeRegistry.register(herdrAdapter);
const herdrControl = new HerdrControlBridgeService(terminalRuntimeRegistry, herdrAdmissions);
let herdrRevocation = Promise.resolve();
herdrPolicy.onReduction(() => {
    herdrRevocation = herdrControl.releaseAll();
    discoveryCollector?.forceRefresh?.();
});
app.locals.terminalRuntimeRegistry = terminalRuntimeRegistry;
app.locals.herdrAdmissions = herdrAdmissions;
app.locals.herdrConfig = herdrConfig;
app.locals.runtimeOperationPolicy = herdrPolicy;
// The collector is inert until the first authenticated discovery subscription.
const discoveryCollector = createDiscoveryCollector({ runtimeRegistry: terminalRuntimeRegistry });
app.locals.discoveryCollector = discoveryCollector;
const paneOutputStream = createPaneOutputStream({ runtimeRegistry: terminalRuntimeRegistry });
const tmuxOutputActivityMonitor = createTmuxOutputActivityMonitor(discoveryCollector, {
    onInputRequired: process.env.CHATMUX_LIVE_NOTIFY === '0'
        ? undefined
        : notifyTmuxInputRequiredIfWatched,
});
tmuxOutputActivityMonitor.start();
const stopTranscriptDiscoveryRefresh = onTranscriptChanged(() => {
    discoveryCollector.forceRefresh();
});

// Single WebSocket server for chat and shell paths.
const wss = createWebSocketServer(server, {
    verifyClient: {
        authenticateWebSocket,
    },
    serverInfo: {
        version: RUNNING_VERSION,
        bootId: SERVER_BOOT_ID,
    },
    chat: {
        spawnFns: {
            claude: queryClaudeSDK,
            cursor: spawnCursor,
            codex: queryCodex,
            opencode: spawnOpenCode,
            gjc: spawnGjc,
            omp: spawnOmp,
            // Safe to register because findLiveTmuxSpawnBlock below refuses to
            // spawn on a session that is currently live in a tmux pane (#44):
            // a second headless omo on the same --session-id would otherwise
            // append to one transcript the live agent never sees.
            omo: spawnOmo,
        },
        abortFns: {
            claude: abortClaudeSDKSession,
            cursor: abortCursorSession,
            codex: abortCodexSession,
            opencode: abortOpenCodeSession,
            gjc: abortGjcSession,
            omp: abortOmpSession,
            omo: abortOmoSession,
        },
        resolveToolApproval: resolveProviderToolApproval,
        getPendingApprovalsForSession: getPendingProviderApprovalsForSession,
        // #44 guard: chat.send refuses to fork a session that a live tmux pane
        // owns, for every provider that resumes by provider-native session id.
        findLiveTmuxSpawnBlock,
    },
    shell: {
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            if (dbSession) {
                return dbSession.provider_session_id ?? null;
            }

            return null;
        },
        stripAnsiSequences,
        normalizeDetectedUrl,
        extractUrlsFromText,
        shouldAutoOpenUrlFromOutput,
        // Terminal attach must authorize BOTH discovery lanes: external CLIs
        // (claude/codex/...) and live gjc panes. The lane-combined verifier
        // keeps the exact 4-tuple + process-generation match in each lane.
        assertFreshExternalTmuxTarget: assertFreshLocalAgentTmuxTarget,
        assertTmuxPaneIdentity,
        attachCapabilities: attachCapabilityService,
        getCurrentTmuxPaneIdentity,
        getCurrentTmuxPaneIdentityState,
        readTmuxPaneIdentity,
        runTmux,
    },
    discovery: discoveryCollector,
    panes: paneOutputStream,
    herdrControl,
});

// Make WebSocket server available to routes
app.locals.wss = wss;

// The update mutation is rejected before CORS/body parsing, so malformed cross-site
// requests cannot reach authentication, discovery, durable state, or launchers.
app.use('/api/system/update', exactUpdateRequestGuard);
app.use((req, res, next) => {
    if (req.path === '/health' || req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
    }
    next();
});
app.use(cors());

// Compress API responses (the project index alone is multi-megabyte JSON).
// Event streams are excluded because compression buffering breaks incremental
// delivery.
app.use(compression({
    filter: (req, res) => {
        const contentType = String(res.getHeader('Content-Type') || '');
        if (contentType.includes('text/event-stream')) {
            return false;
        }
        return compression.filter(req, res);
    },
}));
// Credential endpoints are public and never need the large upload payload budget.
app.use('/api/auth', express.json({
    limit: '64kb',
    type: (req) => (req.headers['content-type'] || '').includes('json')
}));
app.use('/api/auth', express.urlencoded({ limit: '64kb', extended: true }));

app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        product: 'chatmux',
        protocolVersion: 1,
        timestamp: new Date().toISOString(),
        version: RUNNING_VERSION,
        bootId: SERVER_BOOT_ID,
        installMode: INSTALL_MODE
    });
});

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Chat image asset upload/serving (global ~/.chatmux/assets store, protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// Cursor API Routes (protected)
app.use('/api/cursor', authenticateToken, cursorRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);

// System routes (self-update trigger + status, protected)
app.use('/api/system', authenticateToken, createSystemRouter({
    appRoot: APP_ROOT,
    serverPort: Number(process.env.SERVER_PORT || 3001),
    bootId: SERVER_BOOT_ID,
    runningVersion: RUNNING_VERSION,
    authMode: AUTH_MODE,
}));

// The service worker is intentionally dynamic: its running-version revision forces
// browser update checks across an atomic release cutover.
app.get('/sw.js', (_req, res) => {
    const source = fs.readFileSync(path.join(APP_ROOT, 'public', 'sw.js'), 'utf8')
        .replaceAll('__CHATMUX_RUNNING_VERSION__', String(RUNNING_VERSION || 'unknown'));
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(source);
});
// Serve public files
app.use(express.static(path.join(APP_ROOT, 'public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs


app.use(filesRoutes);

// Chat image uploads moved to POST /api/assets/images (server/modules/assets),
// which stores them in the global ~/.chatmux/assets folder.

// Get token usage for a specific session. `projectId` is the DB primary key;
// the Claude branch below resolves it to an absolute path via the DB.
app.get('/api/projects/:projectId/sessions/:sessionId/token-usage', authenticateToken, async (req, res) => {
    try {
        const { projectId, sessionId } = req.params;
        const homeDir = os.homedir();

        // Allow only safe characters in sessionId
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }

        // Provider artifacts on disk (JSONL file names, OpenCode sqlite rows)
        // are keyed by the provider-native session id, while the caller sends
        // the app-facing id. Resolve provider and id mapping from the indexed
        // session row so the frontend does not choose provider-specific paths.
        const sessionRow = sessionsDb.getSessionById(safeSessionId);
        if (!sessionRow) {
            return res.status(404).json({ error: 'Session not found', sessionId: safeSessionId });
        }

        const provider = sessionRow.provider || 'claude';
        const providerNativeSessionId = sessionRow?.provider_session_id || safeSessionId;

        // Handle Cursor sessions - they use SQLite and don't have token usage info
        if (provider === 'cursor') {
            return res.json({
                used: 0,
                total: 0,
                inputTokens: 0,
                outputTokens: 0,
                breakdown: { input: 0, output: 0 },
                unsupported: true,
                message: 'Token usage tracking not available for Cursor sessions'
            });
        }

        if (provider === 'opencode') {
            const dbPath = getOpenCodeDatabasePath();
            if (!fs.existsSync(dbPath)) {
                return res.status(404).json({ error: 'OpenCode database not found' });
            }

            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            try {
                const columns = db.prepare('PRAGMA table_info(session)').all();
                const columnNames = new Set(columns.map((column) => column.name));
                const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
                if (!requiredColumns.every((column) => columnNames.has(column))) {
                    return res.json({
                        used: 0,
                        inputTokens: 0,
                        outputTokens: 0,
                        breakdown: { input: 0, output: 0 },
                        unsupported: true,
                        message: 'Token usage tracking is not available in this OpenCode database schema'
                    });
                }

                const row = db.prepare(`
                    SELECT
                        tokens_input AS inputTokens,
                        tokens_output AS outputTokens,
                        tokens_reasoning AS reasoningTokens,
                        tokens_cache_read AS cacheReadTokens,
                        tokens_cache_write AS cacheWriteTokens
                    FROM session
                    WHERE id = ?
                `).get(providerNativeSessionId);

                if (!row) {
                    return res.status(404).json({ error: 'OpenCode session not found', sessionId: safeSessionId });
                }

                const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
                const outputTokens = Number(row.outputTokens || 0);
                const totalUsed = Number(row.inputTokens || 0)
                    + outputTokens
                    + Number(row.reasoningTokens || 0)
                    + Number(row.cacheReadTokens || 0)
                    + Number(row.cacheWriteTokens || 0);

                return res.json({
                    used: totalUsed,
                    inputTokens,
                    outputTokens,
                    breakdown: {
                        input: inputTokens,
                        output: outputTokens
                    }
                });
            } finally {
                db.close();
            }
        }

        // Handle Codex sessions
        if (provider === 'codex') {
            if (!sessionRow.provider_session_id || !sessionRow.jsonl_path) {
                return res.status(404).json({ error: 'Codex transcript not found', sessionId: safeSessionId });
            }

            const history = await sessionsService.fetchHistory(safeSessionId, {
                limit: 0,
                offset: 0,
            });
            if (history.sourceStatus === 'missing') {
                return res.status(404).json({ error: 'Codex transcript not found', sessionId: safeSessionId });
            }
            if (history.sourceStatus === 'unreadable') {
                return res.status(500).json({ error: 'Failed to read Codex transcript', sessionId: safeSessionId });
            }
            const tokenUsage = history.tokenUsage && typeof history.tokenUsage === 'object'
                ? history.tokenUsage
                : {};
            const inputTokens = readUsageNumber(tokenUsage.inputTokens);
            const outputTokens = readUsageNumber(tokenUsage.outputTokens);
            const totalTokens = readUsageNumber(tokenUsage.used) || inputTokens + outputTokens;
            const contextWindow = readUsageNumber(tokenUsage.total) || 200000;

            return res.json({
                used: totalTokens,
                total: contextWindow,
                inputTokens,
                outputTokens,
                breakdown: {
                    input: inputTokens,
                    output: outputTokens
                }
            });
        }

        // Handle Claude sessions (default)
        // Resolve the project path through the DB using the caller-supplied
        // `projectId`. Legacy code here called extractProjectDirectory with a
        // folder-encoded project name; the migration centralizes that lookup
        // in the projects table.
        const projectPath = await projectsDb.getProjectPathById(projectId);
        if (!projectPath) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Construct the JSONL file path
        // Claude stores session files in ~/.claude/projects/[encoded-project-path]/[session-id].jsonl
        // The encoding replaces any non-alphanumeric character (except -) with -
        const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

        // Prefer the indexed transcript path (already produced by the trusted
        // session synchronizer); fall back to the conventional location
        // derived from the provider-native session id.
        let jsonlPath = sessionRow?.jsonl_path;
        if (!jsonlPath) {
            jsonlPath = path.join(projectDir, `${providerNativeSessionId}.jsonl`);

            // Constrain the constructed path to projectDir (the id is
            // caller-influenced in this fallback branch).
            const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
                return res.status(400).json({ error: 'Invalid path' });
            }
        }

        // Read and parse the JSONL file
        let fileContent;
        try {
            fileContent = await fsPromises.readFile(jsonlPath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'Session file not found', path: jsonlPath });
            }
            throw error; // Re-throw other errors to be caught by outer try-catch
        }
        const lines = fileContent.trim().split('\n');

        const parsedContextWindow = parseInt(process.env.CONTEXT_WINDOW, 10);
        const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160000;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;

        // Find the latest assistant message with usage data (scan from end)
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);

                // Only count assistant messages which have usage data
                if (entry.type === 'assistant' && entry.message?.usage) {
                    const usage = entry.message.usage;

                    // Use token counts from latest assistant message only
                    const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
                    cacheReadTokens = readUsageNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens);
                    cacheCreationTokens = readUsageNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens);
                    inputTokens = directInputTokens + cacheReadTokens + cacheCreationTokens;
                    outputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);

                    break; // Stop after finding the latest assistant message
                }
            } catch (parseError) {
                // Skip lines that can't be parsed
                continue;
            }
        }

        const totalUsed = inputTokens + outputTokens;
        const cacheTokens = cacheReadTokens + cacheCreationTokens;

        res.json({
            used: totalUsed,
            total: contextWindow,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            cacheTokens,
            breakdown: {
                input: inputTokens,
                output: outputTokens
            }
        });
    } catch (error) {
        console.error('Error reading session token usage:', error);
        res.status(500).json({ error: 'Failed to read session token usage' });
    }
});

// Unknown API routes must fail loudly as JSON. Without this guard they fall
// through to the SPA catch-all below and return index.html with HTTP 200,
// which turns every client/server version skew into an opaque JSON parse
// error instead of a diagnosable 404.
app.all('/api/*', (req, res) => {
    res.status(404).json({
        success: false,
        error: {
            code: 'NOT_FOUND',
            message: `Unknown API route: ${req.method} ${req.path}`,
        },
    });
});

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});


const SERVER_PORT = process.env.SERVER_PORT || 3001;
// Loopback by default (fail-closed): this UI can run shell commands, so network
// exposure must be an explicit choice (HOST env / --host) — see utils/exposure-guard.js.
const HOST = process.env.HOST || '127.0.0.1';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;
const LOCAL_SERVER_MARKER_PATH = path.join(os.homedir(), '.chatmux', 'local-server.json');

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means the process exists but belongs to another user.
        return error.code === 'EPERM';
    }
}

async function writeLocalServerMarker() {
    // Several instances can serve at once (e.g. a systemd release install plus
    // a dev checkout). First live writer keeps the marker: never overwrite a
    // marker whose recorded pid is a different, still-running process. A stale
    // marker (dead pid) is reclaimed.
    try {
        const raw = await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8');
        const existing = JSON.parse(raw);
        if (existing.pid && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
            console.log(`${c.info('[INFO]')} Local server marker already owned by running pid ${existing.pid} (${existing.url || 'unknown url'}); keeping it.`);
            return;
        }
    } catch {
        // Missing or unreadable marker: claim it below.
    }

    const marker = {
        pid: process.pid,
        host: HOST,
        port: Number.parseInt(String(SERVER_PORT), 10),
        url: `http://${DISPLAY_HOST}:${SERVER_PORT}`,
        appRoot: APP_ROOT,
        updatedAt: new Date().toISOString(),
    };

    await fsPromises.mkdir(path.dirname(LOCAL_SERVER_MARKER_PATH), { recursive: true });
    await fsPromises.writeFile(LOCAL_SERVER_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

async function removeLocalServerMarker() {
    try {
        const raw = await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8');
        const marker = JSON.parse(raw);
        if (marker.pid && marker.pid !== process.pid) return;
    } catch {
        return;
    }

    try {
        await fsPromises.unlink(LOCAL_SERVER_MARKER_PATH);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[WARN] Could not remove local server marker:', error.message);
        }
    }
}

// Initialize database and start server
async function startServer() {
    try {
        if (herdrConfig.policyPath) {
            const policyReload = await herdrPolicy.reload();
            if (policyReload.errorCode) {
                console.warn(`[WARN] Herdr policy disabled all Herdr capabilities: ${policyReload.errorCode}`);
            }
        }
        // Initialize authentication database
        await initializeDatabase();

        // Fail-closed exposure guard: refuse non-loopback listen while no
        // account exists (first /register would be claimable network-wide) or
        // while CHATMUX_AUTH=none leaves the port without any login at all.
        const exposure = evaluateExposure({
            host: HOST,
            hasUsers: userDb.hasUsers(),
            allowRemoteSetup: process.env.ALLOW_REMOTE_SETUP === '1',
            authMode: AUTH_MODE,
            allowUnauthRemote: process.env.CHATMUX_ALLOW_UNAUTH_REMOTE === '1',
        });
        if (exposure.level === 'block') {
            console.error(`${c.warn('[SECURITY]')} ${exposure.message}`);
            process.exit(1);
        }
        if (exposure.level === 'warn') {
            console.warn(`${c.warn('[SECURITY]')} ${exposure.message}`);
        }

        // Configure Web Push (VAPID keys)
        configureWebPush();
        // This drain is independent of discovery and monitors: committed
        // completion deliveries recover even when those services never start.
        const completionOutboxDispatcher = startCompletionOutboxDispatcher();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${c.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${c.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);            
        }

        console.log(`${c.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);
   
        server.listen(SERVER_PORT, HOST, async () => {
            const appRoot = APP_ROOT;
            await writeLocalServerMarker().catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            console.log('');
            console.log(c.dim('═'.repeat(63)));
            console.log(`  ${c.bright('ChatMux Server - Ready')}`);
            console.log(c.dim('═'.repeat(63)));
            console.log('');
            console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${c.info('[INFO]')} App root: ${c.dim(appRoot)}`);
            console.log(`${c.tip('[TIP]')}  Run "chatmux status" for full configuration details`);
            console.log('');

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();

            // Notify on tmux-driven GJC and external CLI turn completions.
            // Server-side so web push works with every tab closed.
            // Shared kill switch: CHATMUX_LIVE_NOTIFY=0.
            const ensureSharedDiscovery = async () => {
                await discoveryCollector.ensureFresh(2_000, true);
                return discoveryCollector.currentDetailed();
            };
            startLiveTurnMonitor(2_000, async () => {
                const latest = await ensureSharedDiscovery();
                return latest.live
                    ? {
                        ...latest.live,
                        transcriptPaths: latest.live.transcriptPaths ?? new Map(),
                    }
                    : { ok: false, sessions: [], transcriptPaths: new Map() };
            });
            startExternalTurnMonitor(2_000, async () => {
                const latest = await ensureSharedDiscovery();
                return latest.external ?? { ok: false, sessions: [] };
            });

        });

        await closeSessionsWatcher();
        let shutdownStarted = false;
        const shutdownRuntimeServices = async () => {
            if (shutdownStarted) {
                return;
            }
            shutdownStarted = true;
            stopTranscriptDiscoveryRefresh();
            tmuxOutputActivityMonitor.dispose();
            discoveryCollector.dispose();

            // Stop new HTTP/WebSocket work before permanently gating GJC starts.
            server.close();
            await herdrControl.releaseAll();
            for (const client of wss.clients) {
                client.terminate();
            }
            wss.close();
            server.closeAllConnections?.();
            discoveryCollector.dispose();
            terminalRuntimeRegistry.dispose();

            try {
                await completionOutboxDispatcher.stop();
            } catch (err) {
                console.error('[Completion Outbox] Error stopping dispatcher during shutdown:', err?.message || err);
            }
            try {
                await shutdownGjcWorker();
            } catch (err) {
                console.error('[GJC Worker] Error stopping worker during shutdown:', err?.message || err);
            }
            try {
                await removeLocalServerMarker();
            } catch (err) {
                console.error('[Local Server] Error removing server marker during shutdown:', err?.message || err);
            }
            process.exit(0);
        };
        process.on('SIGHUP', () => {
            void (async () => {
                const { errorCode } = await herdrPolicy.reload();
                await herdrRevocation;
                discoveryCollector.forceRefresh();
                if (errorCode) console.warn(`[WARN] Herdr policy disabled all Herdr capabilities: ${errorCode}`);
            })();
        });
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
