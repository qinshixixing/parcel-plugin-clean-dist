const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {cleanDist, loadConfig, unsafeReason} = require('../lib/clean');

function nodeFS() {
  return {
    readFile: (filePath, encoding) => fsp.readFile(filePath, encoding),
    readdir: (directory) => fsp.readdir(directory),
    lstat: (filePath) => fsp.lstat(filePath),
    unlink: (filePath) => fsp.unlink(filePath),
    rimraf: (filePath) => fsp.rm(filePath, {recursive: true, force: true}),
  };
}

async function makeProject() {
  const projectRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'clean-dist-unit-'),
  );
  const distDir = path.join(projectRoot, 'dist');
  await fsp.mkdir(distDir, {recursive: true});
  return {projectRoot, distDir, outputFS: nodeFS()};
}

test('refuses to clean the project root, filesystem root, or outside paths', () => {
  const projectRoot = path.resolve('/work/app');
  assert.equal(unsafeReason(path.join(projectRoot, 'dist'), projectRoot), null);
  assert.match(unsafeReason(projectRoot, projectRoot), /project root/);
  assert.match(unsafeReason(path.parse(projectRoot).root, projectRoot), /filesystem root/);
  assert.match(
    unsafeReason(path.resolve(projectRoot, '../other'), projectRoot),
    /outside the project root/,
  );
});

test('loadConfig reads watch and exclude, and rejects bad values', async () => {
  const {projectRoot, outputFS} = await makeProject();
  try {
    assert.deepEqual(await loadConfig(outputFS, projectRoot), {
      watch: false,
      exclude: [],
    });

    await fsp.writeFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        'parcel-plugin-clean-dist': {
          watch: true,
          exclude: ['static/**'],
        },
      }),
    );
    assert.deepEqual(await loadConfig(outputFS, projectRoot), {
      watch: true,
      exclude: ['static/**'],
    });

    await fsp.writeFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({'parcel-plugin-clean-dist': {watch: 'yes'}}),
    );
    await assert.rejects(loadConfig(outputFS, projectRoot), /watch must be a boolean/);

    await fsp.writeFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({'parcel-plugin-clean-dist': {exclude: ['']}}),
    );
    await assert.rejects(loadConfig(outputFS, projectRoot), /exclude/);
  } finally {
    await fsp.rm(projectRoot, {recursive: true, force: true});
  }
});

test('deletes stale files, keeps bundles and sidecars, and removes empty directories', async () => {
  const {projectRoot, distDir, outputFS} = await makeProject();
  try {
    const bundlePath = path.join(distDir, 'app.js');
    await fsp.writeFile(bundlePath, 'bundle');
    await fsp.writeFile(bundlePath + '.map', 'map');
    await fsp.writeFile(bundlePath + '.gz', 'gzip');
    await fsp.mkdir(path.join(distDir, 'nested'), {recursive: true});
    await fsp.writeFile(path.join(distDir, 'nested', 'old.js'), 'old');
    await fsp.writeFile(path.join(distDir, 'orphan.js.map'), 'orphan map');

    const result = await cleanDist({
      bundles: [
        {
          files: [{filePath: bundlePath}],
          target: {distDir},
        },
      ],
      outputFS,
      projectRoot,
      exclude: [],
    });

    assert.equal(result.removed, 2);
    assert.deepEqual(result.refusals, []);
    assert.equal(fs.existsSync(bundlePath), true);
    assert.equal(fs.existsSync(bundlePath + '.map'), true);
    assert.equal(fs.existsSync(bundlePath + '.gz'), true);
    assert.equal(fs.existsSync(path.join(distDir, 'nested', 'old.js')), false);
    assert.equal(fs.existsSync(path.join(distDir, 'nested')), false);
    assert.equal(fs.existsSync(path.join(distDir, 'orphan.js.map')), false);
    assert.equal(fs.existsSync(distDir), true);
  } finally {
    await fsp.rm(projectRoot, {recursive: true, force: true});
  }
});

test('exclude patterns are relative to the deepest output directory', async () => {
  const {projectRoot, outputFS} = await makeProject();
  const modernDir = path.join(projectRoot, 'dist', 'modern');
  const legacyDir = path.join(projectRoot, 'dist', 'legacy');
  try {
    await fsp.mkdir(path.join(modernDir, 'static'), {recursive: true});
    await fsp.mkdir(legacyDir, {recursive: true});
    await fsp.writeFile(path.join(modernDir, 'app.js'), 'app');
    await fsp.writeFile(path.join(modernDir, 'static', 'keep.txt'), 'keep');
    await fsp.writeFile(path.join(modernDir, 'drop.txt'), 'drop');
    await fsp.writeFile(path.join(legacyDir, 'app.js'), 'legacy');
    await fsp.writeFile(path.join(legacyDir, '.gitkeep'), 'keep');
    await fsp.writeFile(path.join(projectRoot, 'dist', 'untouched.txt'), 'parent');

    const result = await cleanDist({
      bundles: [
        {
          files: [{filePath: path.join(modernDir, 'app.js')}],
          target: {distDir: modernDir},
        },
        {
          files: [{filePath: path.join(legacyDir, 'app.js')}],
          target: {distDir: legacyDir},
        },
      ],
      outputFS,
      projectRoot,
      exclude: ['static/**', '**/.gitkeep'],
    });

    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(path.join(modernDir, 'static', 'keep.txt')), true);
    assert.equal(fs.existsSync(path.join(modernDir, 'drop.txt')), false);
    assert.equal(fs.existsSync(path.join(legacyDir, '.gitkeep')), true);
    assert.equal(fs.existsSync(path.join(projectRoot, 'dist', 'untouched.txt')), true);
  } finally {
    await fsp.rm(projectRoot, {recursive: true, force: true});
  }
});

test('does not follow a symlink out of the output directory', async () => {
  const {projectRoot, distDir, outputFS} = await makeProject();
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'clean-dist-outside-'));
  try {
    const precious = path.join(outside, 'precious.txt');
    await fsp.writeFile(precious, 'safe');
    await fsp.symlink(outside, path.join(distDir, 'linked'));
    await fsp.writeFile(path.join(distDir, 'app.js'), 'bundle');

    await cleanDist({
      bundles: [
        {
          files: [{filePath: path.join(distDir, 'app.js')}],
          target: {distDir},
        },
      ],
      outputFS,
      projectRoot,
      exclude: [],
    });

    assert.equal(await fsp.readFile(precious, 'utf8'), 'safe');
    assert.equal(fs.existsSync(path.join(distDir, 'linked')), false);
    assert.equal(fs.existsSync(path.join(distDir, 'app.js')), true);
  } finally {
    await fsp.rm(projectRoot, {recursive: true, force: true});
    await fsp.rm(outside, {recursive: true, force: true});
  }
});

test('refuses to clean a directory outside the project', async () => {
  const {projectRoot, outputFS} = await makeProject();
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'clean-dist-outside-'));
  try {
    const stale = path.join(outside, 'stale.txt');
    await fsp.writeFile(stale, 'stay');

    const result = await cleanDist({
      bundles: [
        {
          files: [{filePath: path.join(outside, 'app.js')}],
          target: {distDir: outside},
        },
      ],
      outputFS,
      projectRoot,
      exclude: [],
    });

    assert.equal(result.removed, 0);
    assert.equal(result.refusals.length, 1);
    assert.match(result.refusals[0], /outside the project root/);
    assert.equal(await fsp.readFile(stale, 'utf8'), 'stay');
  } finally {
    await fsp.rm(projectRoot, {recursive: true, force: true});
    await fsp.rm(outside, {recursive: true, force: true});
  }
});
