const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {describe, test} = require('node:test');
const {Parcel} = require('@parcel/core');

// Node's test runner copies its own flags into process.execArgv. Parcel
// forwards that list to workers, and workers reject several of those flags.
process.execArgv.splice(0, process.execArgv.length);

const pluginEntry = path.join(__dirname, '..', 'index.js');

async function writeProject(dir, pkg, source) {
  await fsp.mkdir(path.join(dir, 'src'), {recursive: true});
  await fsp.writeFile(
    path.join(dir, 'src/index.html'),
    '<!doctype html><script type="module" src="./index.js"></script>\n',
  );
  await fsp.writeFile(path.join(dir, 'src/index.js'), source);
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await fsp.writeFile(
    path.join(dir, 'package-lock.json'),
    '{"name":"fixture","lockfileVersion":3}\n',
  );
  await fsp.writeFile(
    path.join(dir, 'reporter.js'),
    `module.exports = require(${JSON.stringify(pluginEntry)});\n`,
  );
}

function basePackage(extra) {
  return {
    name: 'fixture',
    version: '1.0.0',
    private: true,
    ...extra,
  };
}

async function createProject(extra, source = "console.log('one');\n") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clean-dist-parcel-'));
  await writeProject(dir, basePackage(extra), source);
  return dir;
}

async function runParcel(dir, mode = 'production') {
  const bundler = new Parcel({
    entries: path.join(dir, 'src/index.html'),
    defaultConfig: require.resolve('@parcel/config-default'),
    mode,
    shouldAutoInstall: false,
    logLevel: 'error',
    // Each run builds from scratch. Parcel's incremental cache can miss a
    // source edit that lands between two runs in the same process and serve
    // the previous output again, which made these tests flaky.
    shouldDisableCache: true,
    defaultTargetOptions: {
      distDir: path.join(dir, 'dist'),
      shouldOptimize: false,
      sourceMaps: true,
    },
    additionalReporters: [
      {
        packageName: './reporter.js',
        resolveFrom: path.join(dir, 'package.json'),
      },
    ],
  });
  return bundler.run();
}

async function listFiles(directory) {
  const files = [];
  async function walk(current) {
    let names;
    try {
      names = await fsp.readdir(current);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const name of names) {
      const fullPath = path.join(current, name);
      const stat = await fsp.lstat(fullPath);
      if (stat.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }
  await walk(directory);
  return files.sort();
}

describe('parcel builds', {concurrency: 1}, () => {
  test('removes stale output and keeps the files from the latest build', async () => {
    const dir = await createProject();
    try {
      await runParcel(dir);
      const first = await listFiles(path.join(dir, 'dist'));
      assert.ok(first.some((file) => file.endsWith('.js')));
      assert.ok(first.some((file) => file.endsWith('.map')));

      await fsp.mkdir(path.join(dir, 'dist', 'nested'), {recursive: true});
      await fsp.writeFile(path.join(dir, 'dist', 'nested', 'old.js'), 'old');
      await fsp.writeFile(path.join(dir, 'dist', 'stale.txt'), 'stale');

      await fsp.writeFile(path.join(dir, 'src/index.js'), "console.log('two');\n");
      await runParcel(dir);

      const second = await listFiles(path.join(dir, 'dist'));
      assert.equal(
        second.some((file) => file.endsWith(path.join('nested', 'old.js'))),
        false,
      );
      assert.equal(second.some((file) => file.endsWith('stale.txt')), false);
      assert.ok(second.some((file) => file.endsWith('.js')));
      assert.ok(second.some((file) => file.endsWith('.map')));
      const firstScripts = first.filter((file) => file.endsWith('.js'));
      const secondScripts = second.filter((file) => file.endsWith('.js'));
      assert.ok(firstScripts.length > 0);
      assert.ok(secondScripts.length > 0);
      assert.notDeepEqual(firstScripts, secondScripts);
    } finally {
      await fsp.rm(dir, {recursive: true, force: true});
    }
  });

  test('keeps excluded files and cleans each target directory', async () => {
    const dir = await createProject({
      targets: {
        modern: {
          distDir: 'dist/modern',
          engines: {browsers: 'last 1 Chrome version'},
        },
        legacy: {
          distDir: 'dist/legacy',
          engines: {browsers: 'chrome 60'},
        },
      },
      'parcel-plugin-clean-dist': {
        exclude: ['static/**'],
      },
    });
    try {
      await runParcel(dir);
      await fsp.mkdir(path.join(dir, 'dist', 'modern', 'static'), {recursive: true});
      await fsp.writeFile(path.join(dir, 'dist', 'modern', 'static', 'keep.txt'), 'keep');
      await fsp.writeFile(path.join(dir, 'dist', 'modern', 'drop.txt'), 'drop');
      await fsp.writeFile(path.join(dir, 'dist', 'legacy', 'drop.txt'), 'drop');
      await fsp.writeFile(path.join(dir, 'dist', 'parent.txt'), 'parent');

      await runParcel(dir);

      assert.equal(
        await fsp.readFile(path.join(dir, 'dist', 'modern', 'static', 'keep.txt'), 'utf8'),
        'keep',
      );
      await assert.rejects(fsp.stat(path.join(dir, 'dist', 'modern', 'drop.txt')));
      await assert.rejects(fsp.stat(path.join(dir, 'dist', 'legacy', 'drop.txt')));
      assert.equal(await fsp.readFile(path.join(dir, 'dist', 'parent.txt'), 'utf8'), 'parent');
    } finally {
      await fsp.rm(dir, {recursive: true, force: true});
    }
  });

  test('development builds do not clean unless watch is enabled', async () => {
    const dir = await createProject();
    try {
      await fsp.mkdir(path.join(dir, 'dist'), {recursive: true});
      await fsp.writeFile(path.join(dir, 'dist', 'stale.txt'), 'stay');
      await runParcel(dir, 'development');
      assert.equal(await fsp.readFile(path.join(dir, 'dist', 'stale.txt'), 'utf8'), 'stay');

      const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
      pkg['parcel-plugin-clean-dist'] = {watch: true};
      await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
      await runParcel(dir, 'development');
      await assert.rejects(fsp.stat(path.join(dir, 'dist', 'stale.txt')));
    } finally {
      await fsp.rm(dir, {recursive: true, force: true});
    }
  });

  test('a failed build leaves existing output in place', async () => {
    const dir = await createProject();
    try {
      await runParcel(dir);
      await fsp.writeFile(path.join(dir, 'dist', 'stale.txt'), 'stay');
      await fsp.writeFile(path.join(dir, 'src/index.js'), 'const = ;\n');
      await assert.rejects(runParcel(dir));
      assert.equal(await fsp.readFile(path.join(dir, 'dist', 'stale.txt'), 'utf8'), 'stay');
    } finally {
      await fsp.rm(dir, {recursive: true, force: true});
    }
  });

  test('invalid config fails the build before deleting output', async () => {
    const dir = await createProject({
      'parcel-plugin-clean-dist': {watch: 'yes'},
    });
    try {
      await fsp.mkdir(path.join(dir, 'dist'), {recursive: true});
      await fsp.writeFile(path.join(dir, 'dist', 'stale.txt'), 'stay');
      await assert.rejects(runParcel(dir), /watch must be a boolean/);
      assert.equal(await fsp.readFile(path.join(dir, 'dist', 'stale.txt'), 'utf8'), 'stay');
    } finally {
      await fsp.rm(dir, {recursive: true, force: true});
    }
  });

  test('does not delete an output directory outside the project', async () => {
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'clean-dist-parent-'));
    const dir = path.join(parent, 'app');
    const outside = path.join(parent, 'outside');
    try {
      await fsp.mkdir(outside, {recursive: true});
      await writeProject(
        dir,
        basePackage({
          targets: {
            default: {
              distDir: '../outside',
            },
          },
        }),
        "console.log('one');\n",
      );
      await fsp.writeFile(path.join(outside, 'stale.txt'), 'stay');
      await runParcel(dir);
      assert.equal(await fsp.readFile(path.join(outside, 'stale.txt'), 'utf8'), 'stay');
      const output = await listFiles(outside);
      assert.ok(output.some((file) => file.endsWith('.js') || file.endsWith('.html')));
    } finally {
      await fsp.rm(parent, {recursive: true, force: true});
    }
  });
});
