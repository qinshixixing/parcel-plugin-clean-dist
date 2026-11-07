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

function relativeToDeepest(filePath, distDirs) {
  let relativePath = null;
  let deepestLength = -1;
  for (const distDir of distDirs) {
    const relative = path.relative(distDir, filePath);
    if (relative === '' || escapesDirectory(relative)) {
      continue;
    }
    if (distDir.length > deepestLength) {
      relativePath = relative;
      deepestLength = distDir.length;
    }
  }
  return relativePath;
}

// Enough to overlap disk latency, and low enough that a large output
// directory does not open thousands of files at once.
const FS_CONCURRENCY = 32;

function createLimiter(limit) {
  let active = 0;
  let head = 0;
  const queue = [];

  function pump() {
    while (active < limit && head < queue.length) {
      const job = queue[head];
      queue[head] = undefined;
      head += 1;
      active += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
    if (head > 0 && head === queue.length) {
      queue.length = 0;
      head = 0;
    }
  }

  return function run(task) {
    return new Promise((resolve, reject) => {
      queue.push({fn: task, resolve, reject});
      pump();
    });
  };
}

// Compile once per build: picomatch.isMatch would rebuild the regular
// expression for every file it is asked about.
// A pattern such as "static/**" also records the directory it covers, so the
// walk can leave that tree alone after a single listing.
function compileExcludes(patterns) {
  const matchers = [];
  const coveredDirs = [];
  for (const pattern of patterns) {
    const posix = pattern.split('\\').join('/');
    matchers.push(
      picomatch(posix, {
        dot: true,
        nonegate: true,
      }),
    );
    const prefix = coveredDirPrefix(posix);
    if (prefix) {
      coveredDirs.push(prefix);
    }
  }
  return {matchers, coveredDirs};
}

function coveredDirPrefix(posixPattern) {
  const match = /^(.*?)\/\*\*(?:\/\*)?$/.exec(posixPattern);
  if (!match) {
    return null;
  }
  const prefix = match[1];
  if (prefix === '' || prefix === '.' || /[*?[\]{}]/.test(prefix)) {
    return null;
  }
  return prefix;
}

function isExcluded(filePath, distDirs, matchers) {
  if (matchers.length === 0) {
    return false;
  }
  const relativePath = relativeToDeepest(filePath, distDirs);
  if (relativePath == null) {
    return false;
  }
  const posixPath = relativePath.split(path.sep).join('/');
  return matchers.some((matcher) => matcher(posixPath));
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

function isCoveredDirectory(fullPath, distDirs, coveredDirs) {
  if (coveredDirs.length === 0) {
    return false;
  }
  const relativePath = relativeToDeepest(fullPath, distDirs);
  if (relativePath == null) {
    return false;
  }
  const posixPath = relativePath.split(path.sep).join('/');
  return coveredDirs.some(
    (prefix) => posixPath === prefix || posixPath.startsWith(prefix + '/'),
  );
}

// A target directory nested inside another is cleaned while walking the
// parent. Starting at the nested directory as well would read that tree twice.
function outermostDirs(dirs) {
  const ordered = [...dirs].sort(
    (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  const roots = [];
  for (const dir of ordered) {
    const nested = roots.some(
      (root) => dir === root || dir.startsWith(root + path.sep),
    );
    if (!nested) {
      roots.push(dir);
    }
  }
  return roots;
}

// Follows no intermediate link. A path inside the project can still point
// outside it when a parent directory is a symbolic link, and readdir would
// follow that link.
async function inspectDistDir(outputFS, distDir, projectRoot, limit) {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(distDir));
  let current = path.resolve(projectRoot);
  let finalStat = null;
  for (const part of relative.split(path.sep)) {
    if (part === '' || part === '.') {
      continue;
    }
    current = path.join(current, part);
    let stat;
    try {
      stat = await limit(() => outputFS.lstat(current));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {kind: 'missing'};
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      return {kind: 'symlink', linkPath: current};
    }
    finalStat = stat;
  }
  if (finalStat == null) {
    return {kind: 'missing'};
  }
  return {kind: finalStat.isDirectory() ? 'directory' : 'other'};
}

async function cleanDirectory(
  outputFS,
  distDir,
  distDirs,
  keep,
  compiled,
  protectedLinks,
  limit,
) {
  const {matchers, coveredDirs} = compiled;

  // Returns how many files were removed and whether anything is left here.
  async function walk(directory) {
    let entries;
    try {
      entries = await limit(() =>
        outputFS.readdir(directory, {withFileTypes: true}),
      );
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return {removed: 0, empty: true};
      }
      throw error;
    }

    const settled = await Promise.allSettled(
      entries.map((entry) =>
        visit(directory, entry),
      ),
    );

    let removed = 0;
    let remaining = 0;
    let failure = null;
    for (const item of settled) {
      if (item.status === 'rejected') {
        if (failure == null) {
          failure = item.reason;
        }
        continue;
      }
      removed += item.value.removed;
      remaining += item.value.remaining;
    }
    if (failure) {
      throw failure;
    }
    return {removed, empty: remaining === 0};
  }

  async function visit(directory, entry) {
    const fullPath = path.resolve(directory, entryName(entry));
    let kind = entryKind(entry);
    if (kind == null) {
      let stat;
      try {
        stat = await limit(() => outputFS.lstat(fullPath));
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          return {removed: 0, remaining: 0};
        }
        throw error;
      }
      kind = statKind(stat);
    }

    // A symlink can point outside the output directory. Never walk the
    // target. A link that is itself an output directory stays, and so does
    // a link the build emitted or an exclude pattern kept.
    if (kind === 'symlink') {
      if (
        protectedLinks.has(fullPath) ||
        keep.has(fullPath) ||
        isExcluded(fullPath, distDirs, matchers)
      ) {
        return {removed: 0, remaining: 1};
      }
      await limit(() => outputFS.unlink(fullPath));
      return {removed: 1, remaining: 0};
    }

    if (kind === 'directory') {
      if (!distDirs.has(fullPath) && isCoveredDirectory(fullPath, distDirs, coveredDirs)) {
        const kept = await coveredDirectoryRemains(fullPath);
        return kept
          ? {removed: 0, remaining: 1}
          : {removed: 0, remaining: 0};
      }
      const child = await walk(fullPath);
      // An output directory of a target stays, even when it is empty.
      if (!child.empty || distDirs.has(fullPath)) {
        return {removed: child.removed, remaining: 1};
      }
      await limit(() => outputFS.rimraf(fullPath));
      return {removed: child.removed, remaining: 0};
    }

    if (keep.has(fullPath) || isExcluded(fullPath, distDirs, matchers)) {
      return {removed: 0, remaining: 1};
    }
    await limit(() => outputFS.unlink(fullPath));
    return {removed: 1, remaining: 0};
  }

  // One listing is enough: the exclude pattern covers every nested path, so
  // either the directory is empty and can be removed, or the whole tree stays.
  async function coveredDirectoryRemains(directory) {
    let names;
    try {
      names = await limit(() => outputFS.readdir(directory));
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return false;
      }
      throw error;
    }
    if (names.length === 0) {
      await limit(() => outputFS.rimraf(directory));
      return false;
    }
    return true;
  }

  const result = await walk(distDir);
  return result.removed;
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
  const compiled = compileExcludes(exclude);
  const refusals = [];
  const candidates = [];

  for (const distDir of distDirs) {
    const reason = unsafeReason(distDir, projectRoot);
    if (reason) {
      refusals.push(`Refusing to clean ${distDir}: ${reason}.`);
      continue;
    }
    candidates.push(distDir);
  }

  const limit = createLimiter(FS_CONCURRENCY);
  const inspections = await Promise.all(
    candidates.map(async (distDir) => ({
      distDir,
      inspection: await inspectDistDir(outputFS, distDir, projectRoot, limit),
    })),
  );

  const safeDirs = new Set();
  const protectedLinks = new Set();
  for (const {distDir, inspection} of inspections) {
    if (inspection.kind === 'symlink') {
      const reason =
        inspection.linkPath === distDir
          ? 'it is a symbolic link'
          : 'it is reached through a symbolic link';
      refusals.push(`Refusing to clean ${distDir}: ${reason}.`);
      protectedLinks.add(inspection.linkPath);
      continue;
    }
    if (inspection.kind === 'directory') {
      safeDirs.add(distDir);
    }
  }

  const counts = await Promise.all(
    outermostDirs(safeDirs).map((distDir) =>
      cleanDirectory(
        outputFS,
        distDir,
        safeDirs,
        keep,
        compiled,
        protectedLinks,
        limit,
      ),
    ),
  );

  let removed = 0;
  for (const count of counts) {
    removed += count;
  }
  return {removed, refusals};
}

module.exports = {
  CONFIG_KEY,
  cleanDist,
  loadConfig,
  unsafeReason,
};
