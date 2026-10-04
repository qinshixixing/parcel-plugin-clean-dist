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
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
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
    if (
      relative === '' ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    if (distDir.length > deepestLength) {
      relativePath = relative;
      deepestLength = distDir.length;
    }
  }
  return relativePath;
}

function isExcluded(filePath, distDirs, patterns) {
  if (patterns.length === 0) {
    return false;
  }
  const relativePath = relativeToDeepest(filePath, distDirs);
  if (relativePath == null) {
    return false;
  }
  const posixPath = relativePath.split(path.sep).join('/');
  return patterns.some((pattern) =>
    picomatch.isMatch(posixPath, pattern.split('\\').join('/'), {
      dot: true,
      nonegate: true,
    }),
  );
}

async function cleanDirectory(outputFS, distDir, distDirs, keep, exclude) {
  let removed = 0;

  async function walk(directory) {
    let names;
    try {
      names = await outputFS.readdir(directory);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return;
      }
      throw error;
    }

    for (const name of names) {
      const fullPath = path.resolve(directory, entryName(name));
      let stat;
      try {
        stat = await outputFS.lstat(fullPath);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          continue;
        }
        throw error;
      }

      // A symlink can point outside the output directory. Delete the link
      // itself and do not walk the target.
      if (stat.isSymbolicLink()) {
        if (
          !keep.has(fullPath) &&
          !isExcluded(fullPath, distDirs, exclude)
        ) {
          await outputFS.unlink(fullPath);
          removed += 1;
        }
        continue;
      }

      if (stat.isDirectory()) {
        await walk(fullPath);
        const remaining = await outputFS.readdir(fullPath);
        if (remaining.length === 0) {
          await outputFS.rimraf(fullPath);
        }
        continue;
      }

      if (keep.has(fullPath) || isExcluded(fullPath, distDirs, exclude)) {
        continue;
      }
      await outputFS.unlink(fullPath);
      removed += 1;
    }
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
  const refusals = [];
  const safeDirs = [];

  for (const distDir of distDirs) {
    const reason = unsafeReason(distDir, projectRoot);
    if (reason) {
      refusals.push(`Refusing to clean ${distDir}: ${reason}.`);
      continue;
    }
    safeDirs.push(distDir);
  }

  let removed = 0;
  for (const distDir of safeDirs) {
    removed += await cleanDirectory(
      outputFS,
      distDir,
      safeDirs,
      keep,
      exclude,
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
