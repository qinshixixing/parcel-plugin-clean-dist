const path = require('path');
const fs = require('fs');

module.exports = (bundler) => {
    const outDir = bundler.options.outDir;
    try {
        if (fs.statSync(outDir).isDirectory()) {
            const files = fs.readdirSync(outDir);
            files.forEach((file, index) => {
                const filePath = `${outDir}/${file}`;
                fs.unlinkSync(filePath);
            });
        }
    }
    catch (err) {}
};
