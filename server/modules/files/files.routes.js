import { randomUUID } from 'node:crypto';
import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Router } from 'express';
import mime from 'mime-types';

import { WORKSPACES_ROOT, validateWorkspacePath } from '@/shared/utils.js';
import {
    openProjectFileForWrite,
    resolveProjectEntryForMutation,
    resolveProjectFileForRead,
    resolveProjectFileForWrite
} from '@/shared/project-file-containment.js';
import { projectsDb } from '@/modules/database/index.js';
import { authenticateToken } from '@/middleware/auth.js';

const router = Router();
const MAX_FILE_UPLOAD_SIZE_MB = 200;
const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_FILE_UPLOAD_COUNT = 20;

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

const expandWorkspacePath = (inputPath) => {
    if (!inputPath) return inputPath;
    if (inputPath === '~') {
        return WORKSPACES_ROOT;
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(WORKSPACES_ROOT, inputPath.slice(2));
    }
    return inputPath;
};

// Browse filesystem endpoint for project suggestions - uses existing getFileTree
router.get('/api/browse-filesystem', authenticateToken, async (req, res) => {
    try {
        const { path: dirPath } = req.query;

        console.log('[API] Browse filesystem request for path:', dirPath);
        console.log('[API] WORKSPACES_ROOT is:', WORKSPACES_ROOT);
        // Default to home directory if no path provided
        const defaultRoot = WORKSPACES_ROOT;
        let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;

        // Resolve and normalize the path
        targetPath = path.resolve(targetPath);

        // Security check - ensure path is within allowed workspace root
        const validation = await validateWorkspacePath(targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolvedPath = validation.resolvedPath || targetPath;

        // Security check - ensure path is accessible
        try {
            await fs.promises.access(resolvedPath);
            const stats = await fs.promises.stat(resolvedPath);

            if (!stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }
        } catch (err) {
            return res.status(404).json({ error: 'Directory not accessible' });
        }

        // Use existing getFileTree function with shallow depth (only direct children)
        const fileTree = await getFileTree(resolvedPath, 1, 0, false); // maxDepth=1, showHidden=false

        // Filter only directories and format for suggestions
        const directories = fileTree
            .filter(item => item.type === 'directory')
            .map(item => ({
                path: item.path,
                name: item.name,
                type: 'directory'
            }))
            .sort((a, b) => {
                const aHidden = a.name.startsWith('.');
                const bHidden = b.name.startsWith('.');
                if (aHidden && !bHidden) return 1;
                if (!aHidden && bHidden) return -1;
                return a.name.localeCompare(b.name);
            });

        // Add common directories if browsing home directory
        const suggestions = [];
        let resolvedWorkspaceRoot = defaultRoot;
        try {
            resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
        } catch (error) {
            // Use default root as-is if realpath fails
        }
        if (resolvedPath === resolvedWorkspaceRoot) {
            const commonDirs = ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'];
            const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
            const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));

            suggestions.push(...existingCommon, ...otherDirs);
        } else {
            suggestions.push(...directories);
        }

        res.json({
            path: resolvedPath,
            suggestions: suggestions
        });

    } catch (error) {
        console.error('Error browsing filesystem:', error);
        res.status(500).json({ error: 'Failed to browse filesystem' });
    }
});

router.post('/api/create-folder', authenticateToken, async (req, res) => {
    try {
        const { path: folderPath } = req.body;
        if (!folderPath) {
            return res.status(400).json({ error: 'Path is required' });
        }
        const expandedPath = expandWorkspacePath(folderPath);
        const resolvedInput = path.resolve(expandedPath);
        const validation = await validateWorkspacePath(resolvedInput);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const targetPath = validation.resolvedPath || resolvedInput;
        const parentDir = path.dirname(targetPath);
        try {
            await fs.promises.access(parentDir);
        } catch (err) {
            return res.status(404).json({ error: 'Parent directory does not exist' });
        }
        try {
            await fs.promises.access(targetPath);
            return res.status(409).json({ error: 'Folder already exists' });
        } catch (err) {
            // Folder doesn't exist, which is what we want
        }
        try {
            await fs.promises.mkdir(targetPath, { recursive: false });
            res.json({ success: true, path: targetPath });
        } catch (mkdirError) {
            if (mkdirError.code === 'EEXIST') {
                return res.status(409).json({ error: 'Folder already exists' });
            }
            throw mkdirError;
        }
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

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

// ============================================================================
// FILE OPERATIONS API ENDPOINTS
// ============================================================================

/**
 * Validate that a path is within the project root
 * @param {string} projectRoot - The project root path
 * @param {string} targetPath - The path to validate
 * @returns {{ valid: boolean, resolved?: string, error?: string }}
 */
async function validatePathInProject(projectRoot, targetPath) {
    const resolved = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(projectRoot, targetPath);
    const canonicalPath = await resolveProjectFileForWrite(projectRoot, resolved);
    if (!canonicalPath) {
        return { valid: false, error: 'Path must be under project root' };
    }
    return { valid: true, resolved: canonicalPath };
}

/**
 * Validate filename - check for invalid characters
 * @param {string} name - The filename to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFilename(name) {
    if (!name || !name.trim()) {
        return { valid: false, error: 'Filename cannot be empty' };
    }
    // Check for invalid characters (Windows + Unix)
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(name)) {
        return { valid: false, error: 'Filename contains invalid characters' };
    }
    // Check for reserved names (Windows)
    const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reserved.test(name)) {
        return { valid: false, error: 'Filename is a reserved name' };
    }
    // Check for dots only
    if (/^\.+$/.test(name)) {
        return { valid: false, error: 'Filename cannot be only dots' };
    }
    return { valid: true };
}

// POST /api/projects/:projectId/files/create - Create new file or directory
router.post('/api/projects/:projectId/files/create', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: parentPath, type, name } = req.body;

        // Validate input
        if (!name || !type) {
            return res.status(400).json({ error: 'Name and type are required' });
        }

        if (!['file', 'directory'].includes(type)) {
            return res.status(400).json({ error: 'Type must be "file" or "directory"' });
        }

        const nameValidation = validateFilename(name);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Build and validate target path
        const targetDir = parentPath || '';
        const targetPath = targetDir ? path.join(targetDir, name) : name;
        const validation = await validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Check if already exists
        try {
            await fsPromises.access(resolvedPath);
            return res.status(409).json({ error: `${type === 'file' ? 'File' : 'Directory'} already exists` });
        } catch {
            // Doesn't exist, which is what we want
        }

        // Create file or directory
        if (type === 'directory') {
            await fsPromises.mkdir(resolvedPath, { recursive: false });
        } else {
            // Ensure parent directory exists
            const parentDir = path.dirname(resolvedPath);
            try {
                await fsPromises.access(parentDir);
            } catch {
                await fsPromises.mkdir(parentDir, { recursive: true });
            }
            const fileHandle = await fsPromises.open(resolvedPath, 'wx');
            await fileHandle.close();
        }

        res.json({
            success: true,
            path: resolvedPath,
            name,
            type,
            message: `${type === 'file' ? 'File' : 'Directory'} created successfully`
        });
    } catch (error) {
        console.error('Error creating file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'Parent directory not found' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// PUT /api/projects/:projectId/files/rename - Rename file or directory
router.put('/api/projects/:projectId/files/rename', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { oldPath, newName } = req.body;

        // Validate input
        if (!oldPath || !newName) {
            return res.status(400).json({ error: 'oldPath and newName are required' });
        }

        const nameValidation = validateFilename(newName);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Canonicalize the parent while preserving the leaf, so an in-project
        // symlink is renamed rather than its target.
        const resolvedOldPath = await resolveProjectEntryForMutation(projectRoot, oldPath);
        if (!resolvedOldPath) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        try {
            await fsPromises.lstat(resolvedOldPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'File or directory not found' });
            }
            throw error;
        }

        // Build and validate new path
        const parentDir = path.dirname(resolvedOldPath);
        const resolvedNewPath = path.join(parentDir, newName);
        const newValidation = await resolveProjectEntryForMutation(projectRoot, resolvedNewPath);
        if (resolvedOldPath === await fsPromises.realpath(projectRoot)) {
            return res.status(403).json({ error: 'Cannot rename project root directory' });
        }
        if (!newValidation) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Check if the destination entry already exists without following it.
        try {
            await fsPromises.lstat(newValidation);
            return res.status(409).json({ error: 'A file or directory with this name already exists' });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        // Rename
        await fsPromises.rename(resolvedOldPath, newValidation);

        res.json({
            success: true,
            oldPath: resolvedOldPath,
            newPath: newValidation,
            newName,
            message: 'Renamed successfully'
        });
    } catch (error) {
        console.error('Error renaming file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EXDEV') {
            res.status(400).json({ error: 'Cannot move across different filesystems' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// DELETE /api/projects/:projectId/files - Delete file or directory
router.delete('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: targetPath } = req.body;

        // Validate input
        if (!targetPath) {
            return res.status(400).json({ error: 'Path is required' });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Preserve the final directory entry so deleting an in-project symlink
        // removes only the link, never the target it references.
        const resolvedPath = await resolveProjectEntryForMutation(projectRoot, targetPath);
        if (!resolvedPath) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        let stats;
        try {
            stats = await fsPromises.lstat(resolvedPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'File or directory not found' });
            }
            throw error;
        }

        // Prevent deleting the project root itself
        if (resolvedPath === await fsPromises.realpath(projectRoot)) {
            return res.status(403).json({ error: 'Cannot delete project root directory' });
        }

        // Delete based on type
        if (stats.isDirectory() && !stats.isSymbolicLink()) {
            await fsPromises.rm(resolvedPath, { recursive: true, force: true });
        } else {
            await fsPromises.unlink(resolvedPath);
        }

        res.json({
            success: true,
            path: resolvedPath,
            type: stats.isDirectory() ? 'directory' : 'file',
            message: 'Deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'ENOTEMPTY') {
            res.status(400).json({ error: 'Directory is not empty' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// POST /api/projects/:projectId/files/upload - Upload files
// Dynamic import of multer for file uploads
const uploadFilesHandler = async (req, res) => {
    // Dynamic import of multer
    const multer = (await import('multer')).default;
    const uploadStagingRoot = path.join(os.tmpdir(), 'chatmux-uploads');
    await fsPromises.mkdir(uploadStagingRoot, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(uploadStagingRoot, 0o700);
    const stagingDir = await fsPromises.mkdtemp(path.join(uploadStagingRoot, 'request-'));
    await fsPromises.chmod(stagingDir, 0o700);

    const uploadMiddleware = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                cb(null, stagingDir);
            },
            filename: (req, file, cb) => {
                // Use a unique temp name, but preserve original name in file.originalname
                // Note: file.originalname may contain path separators for folder uploads
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                // For temp file, just use a safe unique name without the path
                cb(null, `upload-${uniqueSuffix}`);
            }
        }),
        limits: {
            fileSize: MAX_FILE_UPLOAD_SIZE_BYTES,
            files: MAX_FILE_UPLOAD_COUNT
        }
    });

    // Await the middleware callback so the private staging directory always has
    // a single cleanup owner, including parser and validation failures.
    await new Promise((resolve) => {
        uploadMiddleware.array('files', MAX_FILE_UPLOAD_COUNT)(req, res, async (err) => {
        try {
            if (err) {
                console.error('Multer error:', err);
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_UPLOAD_SIZE_MB}MB.` });
                }
                if (err.code === 'LIMIT_FILE_COUNT') {
                    return res.status(400).json({ error: `Too many files. Maximum is ${MAX_FILE_UPLOAD_COUNT} files.` });
                }
                return res.status(500).json({ error: err.message });
            }
            const { projectId } = req.params;
            const { targetPath, relativePaths, requestedFileCount: requestedFileCountRaw } = req.body;

            // Parse relative paths if provided (for folder uploads)
            let filePaths = [];
            if (relativePaths) {
                try {
                    filePaths = JSON.parse(relativePaths);
                } catch (e) {
                    console.log('[DEBUG] Failed to parse relativePaths:', relativePaths);
                }
            }

            console.log('[DEBUG] File upload request:', {
                projectId,
                targetPath: JSON.stringify(targetPath),
                targetPathType: typeof targetPath,
                filesCount: req.files?.length,
                relativePaths: filePaths
            });

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files provided' });
            }

            const parsedRequestedFileCount = Number.parseInt(requestedFileCountRaw, 10);
            const requestedFileCount = Number.isFinite(parsedRequestedFileCount) && parsedRequestedFileCount > 0
                ? parsedRequestedFileCount
                : req.files.length;

            // Resolve the project directory through the DB using the new projectId.
            const projectRoot = await projectsDb.getProjectPathById(projectId);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            console.log('[DEBUG] Project root:', projectRoot);

            // Validate and resolve target path
            // If targetPath is empty or '.', use project root directly
            const targetDir = targetPath || '';
            let resolvedTargetDir;

            console.log('[DEBUG] Target dir:', JSON.stringify(targetDir));

            if (!targetDir || targetDir === '.' || targetDir === './') {
                // Empty path means upload to project root
                resolvedTargetDir = await resolveProjectFileForWrite(projectRoot, projectRoot);
                console.log('[DEBUG] Using project root as target:', resolvedTargetDir);
            } else {
                const validation = await validatePathInProject(projectRoot, targetDir);
                if (!validation.valid) {
                    console.log('[DEBUG] Path validation failed:', validation.error);
                    return res.status(403).json({ error: validation.error });
                }
                resolvedTargetDir = validation.resolved;
                console.log('[DEBUG] Resolved target dir:', resolvedTargetDir);
            }
            if (!resolvedTargetDir) {
                return res.status(403).json({ error: 'Path must be under project root' });
            }

            // Ensure target directory exists
            try {
                await fsPromises.access(resolvedTargetDir);
            } catch {
                await fsPromises.mkdir(resolvedTargetDir, { recursive: true });
            }
            resolvedTargetDir = await resolveProjectFileForWrite(projectRoot, resolvedTargetDir);
            if (!resolvedTargetDir) {
                return res.status(403).json({ error: 'Path must be under project root' });
            }

            // Move uploaded files from temp to target directory
            const uploadedFiles = [];
            console.log('[DEBUG] Processing files:', req.files.map(f => ({ originalname: f.originalname, path: f.path })));
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                // Use relative path if provided (for folder uploads), otherwise use originalname
                const fileName = (filePaths && filePaths[i]) ? filePaths[i] : file.originalname;
                console.log('[DEBUG] Processing file:', fileName, '(originalname:', file.originalname + ')');
                const destPath = path.join(resolvedTargetDir, fileName);

                // Validate destination path
                const destValidation = await validatePathInProject(projectRoot, destPath);
                if (!destValidation.valid) {
                    console.log('[DEBUG] Destination validation failed for:', destPath);
                    continue;
                }

                // Ensure parent directory exists (for nested files from folder upload)
                const parentDir = path.dirname(destValidation.resolved);
                try {
                    await fsPromises.access(parentDir);
                } catch {
                    await fsPromises.mkdir(parentDir, { recursive: true });
                }

                // Move file (copy + unlink to handle cross-device scenarios)
                const canonicalDestination = await resolveProjectFileForWrite(projectRoot, destValidation.resolved);
                if (!canonicalDestination) {
                    continue;
                }
                await fsPromises.copyFile(file.path, canonicalDestination, fs.constants.COPYFILE_EXCL);
                await fsPromises.unlink(file.path);

                uploadedFiles.push({
                    name: fileName,
                    path: canonicalDestination,
                    size: file.size,
                    mimeType: file.mimetype
                });
            }

            res.json({
                success: true,
                files: uploadedFiles,
                uploadedCount: uploadedFiles.length,
                requestedFileCount,
                targetPath: resolvedTargetDir,
                message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`
            });
        } catch (error) {
            console.error('Error uploading files:', error);
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else {
                res.status(500).json({ error: error.message });
            }
        } finally {
            try {
                await fsPromises.rm(stagingDir, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('Failed to clean upload staging directory:', cleanupError);
            }
            resolve();
        }
        });
    });
};

router.post('/api/projects/:projectId/files/upload', authenticateToken, uploadFilesHandler);

export default router;
