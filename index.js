const path = require('path');
const fs = require('fs');
const rimraf = require('rimraf');

module.exports = (bundler) => {
    const outDir = bundler.options.outDir;
    try {
        if (fs.statSync(outDir).isDirectory()) {
                rimraf.sync(`${outDir}/{*,.*}`);
        }
    } catch (err) {
        console.error(`couldn't clean directory: ${outDir}`);
        console.error(err);
    }
};
