const fs = require("fs");
const path = require("path");
const rimraf = require("rimraf");

const Bundler = require("parcel-bundler");
const wrapperPlugin = require("../index");

const fixtureDir = path.join(__dirname, "fixtures", "basic");
const entryFilename = path.join(fixtureDir, "index.html");
const outDirname = path.join(__dirname, "dist");

describe(
  "clean-dist plugin",
  () => {
    beforeEach(() => {
      rimraf.sync(outDirname);
      fs.mkdirSync(outDirname);
    });

    afterAll(() => {
      rimraf.sync(outDirname);
    });

    it("should clear a file", async () => {
      const filename = path.join(outDirname, "someFile.js");

      fs.writeFileSync(filename);

      const bundler = createBundler();
      await bundler.bundle();

      const files = fs.readdirSync(outDirname);
      expect(files).toEqual(["index.html"]);
    });

    it("should clear a non-empty directory", async () => {
      const subDirname = path.join(outDirname, "sub");
      const filename = path.join(subDirname, "someFile.js");

      fs.mkdirSync(subDirname);
      fs.writeFileSync(filename);

      const bundler = createBundler();
      await bundler.bundle();

      const files = fs.readdirSync(outDirname);
      expect(files).toEqual(["index.html"]);
    });

    it("should clear a hidden file (filename starts with a dot)", async () => {
      fs.writeFileSync(path.join(outDirname, ".someFile.js"));

      const bundler = createBundler();
      await bundler.bundle();

      const files = fs.readdirSync(outDirname);
      expect(files).toEqual(["index.html"]);
    });
  },
  0
);

function createBundler() {
  const bundler = new Bundler(entryFilename, {
    outDir: outDirname,
    production: true,
    watch: false,
    cache: false,
    hmr: false,
    logLevel: 0
  });

  // Register plugin
  wrapperPlugin(bundler);

  return bundler;
}
