const path = require('path');
const picomatch = require('picomatch');

const CONFIG_KEY = 'parcel-plugin-clean-dist';

// Source maps and compressor output are written next to the bundle.
// Keep those siblings even when the bundle graph lists only the main file.
const SIDECAR_SUFFIXES = [
  '.map',
  '.gz',
  '.br',
  '.gz.map',
  '.br.map',
  '.map.gz',
  '.map.br',
];

function defaultConfig() {
  return {watch: false, exclude: []};
}

function configError(message) {
  const error = new Error(message);
  error.code = 'PLUGIN_CONFIG';
  return error;
}

async function loadConfig(inputFS, projectRoot) {
  const packagePath = path.join(projectRoot, 'package.json');
  let raw;
  try {
    raw = await inputFS.readFile(packagePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return defaultConfig();
    }
    throw error;
  }

  if (Buffer.isBuffer(raw)) {
    raw = raw.toString('utf8');
  }

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (error) {
    throw configError(
      `Cannot read ${CONFIG_KEY} config because package.json is not valid JSON.`,
    );
  }

  const userConfig = pkg[CONFIG_KEY];
  if (userConfig == null) {
    return defaultConfig();
  }
  if (typeof userConfig !== 'object' || Array.isArray(userConfig)) {
    throw configError(`${CONFIG_KEY} must be an object.`);
  }

  const watch = userConfig.watch == null ? false : userConfig.watch;
  if (typeof watch !== 'boolean') {
    throw configError(`${CONFIG_KEY}.watch must be a boolean.`);
  }

  const exclude = userConfig.exclude == null ? [] : userConfig.exclude;
  if (
    !Array.isArray(exclude) ||
    exclude.some((pattern) => typeof pattern !== 'string' || pattern === '')
  ) {
    throw configError(
      `${CONFIG_KEY}.exclude must be an array of non-empty strings.`,
    );
  }

  return {watch, exclude: exclude.slice()};
}

function toAbsolute(filePath, projectRoot) {
  return path.resolve(projectRoot, filePath);
}

// A relative path leaves its base directory only when a whole '..' segment
// does. A name like '..backup' starts with the same characters but stays
// inside, so it must not be treated as escaping.
function escapesDirectory(relative) {
  return (
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  );
}

function unsafeReason(distDir, projectRoot) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(distDir);
  if (target === path.parse(target).root) {
    return 'it is the filesystem root';
  }
  if (target === root) {
    return 'it is the project root';
  }
  const relative = path.relative(root, target);
  if (escapesDirectory(relative)) {
    return 'it is outside the project root';
  }
  return null;
}

function collectOutputs(bundles, projectRoot) {
  const keep = new Set();
  const distDirs = new Set();

  for (const bundle of bundles) {
    const files = bundle.files || [];
    for (const file of files) {
      if (!file || !file.filePath) {
        continue;
      }
      const filePath = toAbsolute(file.filePath, projectRoot);
      keep.add(filePath);
      for (const suffix of SIDECAR_SUFFIXES) {
        keep.add(filePath + suffix);
      }
    }

    if (bundle.target && bundle.target.distDir) {
      distDirs.add(toAbsolute(bundle.target.distDir, projectRoot));
    }
  }

  return {keep, distDirs: [...distDirs]};
}

// One matcher for the whole build. An array of patterns compiles each glob
// once and returns true when any of them matches.
function compileExcludes(patterns) {
  if (patterns == null || patterns.length === 0) {
    return null;
  }
  return picomatch(
    patterns.map((pattern) => pattern.split('\\').join('/')),
    {dot: true, nonegate: true},
  );
}

// Patterns are relative to the target directory being cleaned. Nested
// targets are not visited from their parent, so this does not have to
// search for a deeper directory.
function isExcluded(filePath, distDir, matcher) {
  if (matcher == null) {
    return false;
  }
  const relative = path.relative(distDir, filePath);
  if (relative === '' || escapesDirectory(relative)) {
    return false;
  }
  return matcher(relative.split(path.sep).join('/'));
}

// Parcel's NodeFS.realpath returns the original path when the file is
// missing, while Node's own realpath rejects with ENOENT. null means there
// is nothing on disk to clean.
async function canonical(outputFS, filePath) {
  const resolved = path.resolve(filePath);
  if (typeof outputFS.realpath !== 'function') {
    return resolved;
  }
  try {
    return path.resolve(await outputFS.realpath(resolved));
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return null;
    }
    throw error;
  }
}

function refusalMessage(distDir, realDist, reason) {
  const logical = path.resolve(distDir);
  const where = realDist === logical ? logical : `${logical} -> ${realDist}`;
  return `Refusing to clean ${where}: ${reason}.`;
}

// The kind of a directory entry, or null when the filesystem returned plain
// names and the caller has to fall back to lstat.
function entryKind(entry) {
  if (entry && typeof entry.isSymbolicLink === 'function') {
    if (entry.isSymbolicLink()) {
      return 'symlink';
    }
    return entry.isDirectory() ? 'directory' : 'file';
  }
  return null;
}

function statKind(stat) {
  if (stat.isSymbolicLink()) {
    return 'symlink';
  }
  return stat.isDirectory() ? 'directory' : 'file';
}

async function removeFile(outputFS, filePath) {
  try {
    await outputFS.unlink(filePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function cleanDirectory(outputFS, distDir, protectedDirs, keep, matcher) {
  let removed = 0;

  // Returns true when nothing is left inside the directory.
  async function walk(directory) {
    let entries;
    try {
      entries = await outputFS.readdir(directory, {withFileTypes: true});
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return true;
      }
      throw error;
    }

    let remaining = 0;

    for (const entry of entries) {
      const fullPath = path.resolve(directory, entryName(entry));
      // Another target owns this path and is cleaned on its own. Leaving
      // the entry in place also keeps a symlink that is itself a target;
      // unlinking that link would drop the output directory.
      if (protectedDirs.has(fullPath)) {
        remaining += 1;
        continue;
      }

      let kind = entryKind(entry);
      if (kind == null) {
        let stat;
        try {
          stat = await outputFS.lstat(fullPath);
        } catch (error) {
          if (error && error.code === 'ENOENT') {
            continue;
          }
          throw error;
        }
        kind = statKind(stat);
      }

      // A symlink can point outside the output directory. Delete the link
      // itself and do not walk the target.
      if (kind === 'symlink') {
        if (keep.has(fullPath) || isExcluded(fullPath, distDir, matcher)) {
          remaining += 1;
        } else if (await removeFile(outputFS, fullPath)) {
          removed += 1;
        }
        continue;
      }

      if (kind === 'directory') {
        const empty = await walk(fullPath);
        if (!empty) {
          remaining += 1;
        } else {
          try {
            await outputFS.rimraf(fullPath);
          } catch (error) {
            if (!error || error.code !== 'ENOENT') {
              throw error;
            }
          }
        }
        continue;
      }

      if (keep.has(fullPath) || isExcluded(fullPath, distDir, matcher)) {
        remaining += 1;
        continue;
      }
      if (await removeFile(outputFS, fullPath)) {
        removed += 1;
      }
    }

    return remaining === 0;
  }

  await walk(distDir);
  return removed;
}

function entryName(entry) {
  if (typeof entry === 'string') {
    return entry;
  }
  if (Buffer.isBuffer(entry)) {
    return entry.toString();
  }
  if (entry && typeof entry.name === 'string') {
    return entry.name;
  }
  return String(entry);
}

async function cleanDist({bundles, outputFS, projectRoot, exclude}) {
  const {keep, distDirs} = collectOutputs(bundles, projectRoot);
  const matcher = compileExcludes(exclude);
  const refusals = [];
  // Every target path stays, including ones we refuse to clean. A parent
  // directory must not unlink a nested target while it is being walked.
  const protectedDirs = new Set(distDirs);
  const safeDirs = [];
  const rootForCheck =
    (await canonical(outputFS, projectRoot)) ?? path.resolve(projectRoot);

  for (const distDir of distDirs) {
    const realDist = await canonical(outputFS, distDir);
    if (realDist == null) {
      continue;
    }
    const reason = unsafeReason(realDist, rootForCheck);
    if (reason) {
      refusals.push(refusalMessage(distDir, realDist, reason));
      continue;
    }
    safeDirs.push(distDir);
  }

  let removed = 0;
  for (const distDir of safeDirs) {
    removed += await cleanDirectory(
      outputFS,
      distDir,
      protectedDirs,
      keep,
      matcher,
    );
  }

  return {removed, refusals};
}

module.exports = {
  CONFIG_KEY,
  cleanDist,
  loadConfig,
  unsafeReason,
};
