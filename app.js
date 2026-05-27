require('dotenv').config();
const os = require('os');
const expandHome = p => p.replace(/^~/, os.homedir());
const defaultProjectsDir = "~/Documents/projects,~/Documents".split(',').map(expandHome);
const WDS = (process.env.projects_dir ? process.env.projects_dir.split(',') : defaultProjectsDir).map(expandHome);
const WORKSPACE_DIRS = (process.env.workspaces_dir ? process.env.workspaces_dir.split(',') : []).map(expandHome);
const SPECIFIC_PROJECTS = (process.env.specific_projects ? process.env.specific_projects.split(',') : []).map(expandHome);
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

const WORKSPACE_BASE = '/Users/marcotten/Documents/projects/vsc-workspaces';

function searchFolders(directoryPath, searchTerm) {
  return fsPromises.readdir(directoryPath)
    .then(items => {
      return Promise.all(items.map(item => {
        const itemPath = path.join(directoryPath, item);
        return fsPromises.stat(itemPath)
          .then(stats => ({ item, stats }))
          .catch(error => {
            if (error.code === 'ENOENT') {
              return null;
            } else if (error.code === 'ENXIO') {
              return null;
            } else {
              throw error;
            }
          });
      }))
        .then(results => results.filter(result => result !== null && result.stats.isDirectory()))
        .then(folders => {
          const filteredFolders = folders.filter(folder => folder.item.includes(searchTerm));
          const folderDetails = filteredFolders.map(folder => ({
            title: folder.item,
            fullPath: path.join(directoryPath, folder.item)
          }));
          return folderDetails;
        });
    });
}

function searchWorkspaces(directoryPath, searchTerm) {
  return fsPromises.readdir(directoryPath)
    .then(items => {
      const workspaceFiles = items.filter(item => item.endsWith('.code-workspace'));
      const filtered = workspaceFiles.filter(file => {
        const name = file.replace('.code-workspace', '');
        return name.includes(searchTerm);
      });
      return filtered.map(file => ({
        title: file.replace('.code-workspace', ''),
        fullPath: path.join(directoryPath, file)
      }));
    })
    .catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENXIO') {
        return [];
      }
      throw error;
    });
}

function readWorkspaceProjects(workspaceFilePath) {
  return fsPromises.readFile(workspaceFilePath, 'utf8')
    .then(content => {
      // Strip trailing commas before } or ] (common in .code-workspace files)
      const cleaned = content.replace(/,(\s*[}\]])/g, '$1');
      const parsed = JSON.parse(cleaned);
      const workspaceDir = path.dirname(workspaceFilePath);
      return (parsed.folders || []).map(folder =>
        path.resolve(workspaceDir, folder.path)
      );
    });
}

function runSearch(searchTerm) {
  const folderSearches = WDS.map(directoryPath => searchFolders(directoryPath, searchTerm));
  const workspaceSearches = WORKSPACE_DIRS.map(directoryPath => searchWorkspaces(directoryPath, searchTerm));

  const specificItems = SPECIFIC_PROJECTS
    .filter(p => p && path.basename(p).toLowerCase().includes(searchTerm.toLowerCase()))
    .map(p => ({
      title: path.basename(p),
      subtitle: `Open project ...`,
      valid: true,
      arg: p,
      icon: { path: "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/AlertCautionIcon.icns" }
    }));

  Promise.all([...folderSearches, ...workspaceSearches])
    .then(allResults => {
      const flatFolders = [].concat(...allResults.slice(0, folderSearches.length));
      const flatWorkspaces = [].concat(...allResults.slice(folderSearches.length));

      const folderItems = flatFolders.map(folder => ({
        title: folder.title,
        subtitle: `Open folder ...`,
        valid: true,
        arg: `${folder.fullPath}`,
        icon: { path: "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/AlertCautionIcon.icns" }
      }));

      const workspaceItems = flatWorkspaces.map(ws => ({
        title: ws.title,
        subtitle: `Open workspace ...`,
        valid: true,
        arg: `${ws.fullPath}`,
        icon: { path: "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/SidebarDocumentsFolder.icns" }
      }));

      console.log(JSON.stringify({ "items": [...specificItems, ...workspaceItems, ...folderItems] }));
    })
    .catch(err => {
      console.error('Error:', err.message);
    });
}

function runWorkspaceSearch(searchTerm) {
  searchWorkspaces(WORKSPACE_BASE, searchTerm)
    .then(results => {
      const items = results.map(ws => ({
        title: ws.title,
        subtitle: `Open workspace ...`,
        valid: true,
        arg: ws.fullPath,
        icon: { path: "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/SidebarDocumentsFolder.icns" }
      }));
      console.log(JSON.stringify({ items }));
    })
    .catch(err => {
      console.error('Error:', err.message);
    });
}

function runSymlink(workspaceFilePath) {
  const workspaceName = path.basename(workspaceFilePath, '.code-workspace');
  const claudeStorageDir = path.join(WORKSPACE_BASE, workspaceName, '.claude');

  fs.mkdirSync(claudeStorageDir, { recursive: true });

  readWorkspaceProjects(workspaceFilePath)
    .then(projectPaths => {
      for (const projectPath of projectPaths) {
        const symlinkPath = path.join(projectPath, '.claude');
        let stat;
        try {
          stat = fs.lstatSync(symlinkPath);
        } catch (err) {
          if (err.code === 'ENOENT') {
            // Does not exist — create symlink
            try {
              fs.symlinkSync(claudeStorageDir, symlinkPath);
            } catch (symlinkErr) {
              process.stderr.write(`Warning: could not symlink ${symlinkPath}: ${symlinkErr.message}\n`);
            }
            continue;
          }
          process.stderr.write(`Warning: could not stat ${symlinkPath}: ${err.message}\n`);
          continue;
        }

        if (stat.isSymbolicLink()) {
          const existing = fs.readlinkSync(symlinkPath);
          if (existing !== claudeStorageDir) {
            fs.unlinkSync(symlinkPath);
            fs.symlinkSync(claudeStorageDir, symlinkPath);
          }
          // else already correct — skip
        } else if (stat.isDirectory()) {
          // Real directory — skip per user preference
          process.stderr.write(`Info: ${symlinkPath} is a real directory, skipping.\n`);
        } else {
          process.stderr.write(`Warning: ${symlinkPath} is not a directory or symlink, skipping.\n`);
        }
      }
    })
    .catch(err => {
      process.stderr.write(`Error reading workspace: ${err.message}\n`);
    });
}

function runWorkspaceNewSearch(searchTerm) {
  const folderSearches = WDS.map(directoryPath => searchFolders(directoryPath, searchTerm));

  Promise.all(folderSearches)
    .then(allResults => {
      const flatFolders = [].concat(...allResults);
      const items = flatFolders.map(folder => ({
        title: folder.title,
        subtitle: `Create workspace from ${folder.title}`,
        valid: true,
        arg: folder.fullPath,
        icon: { path: "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/AlertCautionIcon.icns" }
      }));
      console.log(JSON.stringify({ items }));
    })
    .catch(err => {
      console.error('Error:', err.message);
    });
}

function runCreate(projectPath) {
  const workspaceName = path.basename(projectPath);
  const workspaceDir  = path.join(WORKSPACE_BASE, workspaceName);
  const workspaceFile = path.join(WORKSPACE_BASE, workspaceName + '.code-workspace');
  const claudeDir     = path.join(workspaceDir, '.claude');

  fs.mkdirSync(claudeDir, { recursive: true });

  const workspaceContent = JSON.stringify({ folders: [{ path: projectPath }], settings: {} }, null, 2);
  fs.writeFileSync(workspaceFile, workspaceContent);

  // Set up symlink for the project folder immediately
  const symlinkPath = path.join(projectPath, '.claude');
  try {
    const stat = fs.lstatSync(symlinkPath);
    if (stat.isSymbolicLink()) {
      const existing = fs.readlinkSync(symlinkPath);
      if (existing !== claudeDir) {
        fs.unlinkSync(symlinkPath);
        fs.symlinkSync(claudeDir, symlinkPath);
      }
    }
    // real directory — skip
  } catch (err) {
    if (err.code === 'ENOENT') {
      fs.symlinkSync(claudeDir, symlinkPath);
    }
  }

  process.stdout.write(workspaceFile);
}

// --- Dispatcher ---
const KNOWN_MODES = ['workspace', 'workspace-new', 'symlink', 'create'];
const mode = process.argv[2];
const arg  = process.argv[3] || '';

if (!KNOWN_MODES.includes(mode)) {
  // Backward compat: mode is actually the searchTerm
  runSearch(mode || '');
} else if (mode === 'workspace') {
  runWorkspaceSearch(arg);
} else if (mode === 'workspace-new') {
  runWorkspaceNewSearch(arg);
} else if (mode === 'symlink') {
  runSymlink(arg);
} else if (mode === 'create') {
  runCreate(arg);
}
