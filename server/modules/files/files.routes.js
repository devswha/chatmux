import { randomUUID } from 'node:crypto';
import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { Router } from 'express';
import mime from 'mime-types';

import {
    openProjectFileForWrite,
    resolveProjectFileForRead
} from '@/shared/project-file-containment.js';
import { projectsDb } from '@/modules/database/index.js';
import { authenticateToken } from '@/middleware/auth.js';

const router = Router();

// Helper function to convert permissions to rwx format
function permToRwx(perm) {
    const r = perm & 4 ? 'r' : '-';
    const w = perm & 2 ? 'w' : '-';
    const x = perm & 1 ? 'x' : '-';
    return r + w + x;
}

// Directories that are almost never interesting for a project tree but can
// contain tens of thousands of files. Skipping them before recursion keeps
// traversal time bounded on large monorepos and high-latency filesystems
// (NFS / SMB).
const IGNORED_DIRS = new Set([
    // JS / TS toolchains
    'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
    // VCS
    '.git', '.svn', '.hg',
    // Python
    '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
    // Rust / Go / Java / Ruby
    'target', 'vendor',
    // Build output / IDE
    '.gradle', '.idea', 'coverage', '.nyc_output'
]);

const DEFAULT_FS_CONCURRENCY = 64;
const parsedFsConcurrency = Number.parseInt(process.env.FS_CONCURRENCY || '', 10);
const FS_CONCURRENCY = Number.isFinite(parsedFsConcurrency) && parsedFsConcurrency > 0
    ? parsedFsConcurrency
    : DEFAULT_FS_CONCURRENCY;
let activeFsOperations = 0;
const pendingFsOperations = [];

async function acquire() {
    if (activeFsOperations < FS_CONCURRENCY) {
        activeFsOperations += 1;
        return;
    }

    await new Promise((resolve) => {
        pendingFsOperations.push(resolve);
    });
}

function release() {
    const next = pendingFsOperations.shift();
    if (next) {
        next();
        return;
    }

    activeFsOperations = Math.max(0, activeFsOperations - 1);
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true) {
    // Using fsPromises from import
    let entries;
    try {
        await acquire();
        try {
            entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
        } finally {
            release();
        }
    } catch (error) {
        // Only log non-permission errors to avoid spam
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
            console.error('Error reading directory:', error);
        }
        return [];
    }

    const filteredEntries = entries.filter((entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)));

    // Process every entry in parallel. On high-latency filesystems (NFS/SMB)
    // serial stat() was the real bottleneck — issuing them concurrently lets
    // the kernel pipeline the round-trips and the recursive calls overlap too.
    const items = await Promise.all(filteredEntries.map(async (entry) => {
        const itemPath = path.join(dirPath, entry.name);
        const item = {
            name: entry.name,
            path: itemPath,
            type: entry.isDirectory() ? 'directory' : 'file'
        };

        // Get file stats for additional metadata
        try {
            await acquire();
            try {
              const stats = await fsPromises.lstat(itemPath);
              item.size = stats.size;
              item.modified = stats.mtime.toISOString();

              // Mark symlinks so UI can distinguish them
              if (stats.isSymbolicLink()) {
                item.isSymlink = true;
              }

              // Convert permissions to rwx format
              const mode = stats.mode;
              const ownerPerm = (mode >> 6) & 7;
              const groupPerm = (mode >> 3) & 7;
              const otherPerm = mode & 7;
              item.permissions =
                ((mode >> 6) & 7).toString() +
                ((mode >> 3) & 7).toString() +
                (mode & 7).toString();
              item.permissionsRwx =
                permToRwx(ownerPerm) +
                permToRwx(groupPerm) +
                permToRwx(otherPerm);
            } finally {
                release();
            }
        } catch (statError) {
            // If stat fails, provide default values
            item.size = 0;
            item.modified = null;
            item.permissions = '000';
            item.permissionsRwx = '---------';
        }

        if (entry.isDirectory() && currentDepth < maxDepth) {
            // Recurse. Let readdir's own EACCES bubble up through the catch in
            // the recursive call rather than doing a separate access() probe
            // (which doubled the round-trip count on SMB without adding info).
            // The recursive call starts with a bounded readdir; holding a permit
            // for the whole subtree can deadlock when sibling directories are
            // waiting on their own children.
            item.children = await getFileTree(itemPath, maxDepth, currentDepth + 1, showHidden);
        }

        return item;
    }));

    return items.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}


// Read file content endpoint
router.get('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // Resolve the absolute project root via the DB-backed helper; the
        // caller passes the DB-assigned `projectId`, not a folder name.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Handle both absolute and relative paths.
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        const readablePath = await resolveProjectFileForRead(projectRoot, resolved);
        if (!readablePath) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        const content = await fsPromises.readFile(readablePath, 'utf8');
        res.json({ content, path: readablePath });
    } catch (error) {
        console.error('Error reading file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Serve raw file bytes for previews and downloads.
router.get('/api/projects/:projectId/files/content', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Match the text reader endpoint so callers can pass either project-relative
        // or absolute paths without changing how the bytes are served.
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        const readablePath = await resolveProjectFileForRead(projectRoot, resolved);
        if (!readablePath) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Check if file exists
        try {
            await fsPromises.access(readablePath);
        } catch (error) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Get file extension and set appropriate content type
        const mimeType = mime.lookup(readablePath) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);

        // Stream the file
        const fileStream = fs.createReadStream(readablePath);
        fileStream.pipe(res);

        fileStream.on('error', (error) => {
            console.error('Error streaming file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading file' });
            }
        });

    } catch (error) {
        console.error('Error serving binary file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Save file content endpoint
router.put('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { filePath, content } = req.body;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Content must be a string' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Handle both absolute and relative paths.
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        const writableFile = await openProjectFileForWrite(projectRoot, resolved);
        if (!writableFile) {
            return res.status(403).json({ error: 'Path must be a regular file under project root' });
        }

        let currentStats;
        try {
            currentStats = await writableFile.handle.stat();
        } finally {
            await writableFile.handle.close();
        }

        const temporaryPath = path.join(
            path.dirname(writableFile.path),
            `.${path.basename(writableFile.path)}.${randomUUID()}.tmp`
        );
        let temporaryHandle;
        try {
            temporaryHandle = await fsPromises.open(temporaryPath, 'wx', currentStats.mode);
            await temporaryHandle.writeFile(content, 'utf8');
            await temporaryHandle.sync();
            await temporaryHandle.close();
            temporaryHandle = null;
            await fsPromises.rename(temporaryPath, writableFile.path);
        } finally {
            await temporaryHandle?.close().catch(() => {});
            await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
        }

        res.json({
            success: true,
            path: writableFile.path,
            message: 'File saved successfully'
        });
    } catch (error) {
        console.error('Error saving file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

router.get('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {

        // Using fsPromises from import

        // Resolve the project's absolute path through the DB (projectId is the
        // primary key of the `projects` table after the identifier migration).
        const actualPath = await projectsDb.getProjectPathById(req.params.projectId);
        if (!actualPath) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Check if path exists
        try {
            await fsPromises.access(actualPath);
        } catch (e) {
            return res.status(404).json({ error: `Project path not found: ${actualPath}` });
        }

        const files = await getFileTree(actualPath, 10, 0, true);
        res.json(files);
    } catch (error) {
        console.error('[ERROR] File tree error:', error.message);
        res.status(500).json({ error: error.message });
    }
});


export default router;
