const path = require('path');
const fs = require('fs');

module.exports = () => {
    let distDirName;
    let outDirIndex = process.argv.indexOf('--out-dir');
    if (outDirIndex > -1) {
        distDirName = process.argv[outDirIndex + 1];
    }
    else {
        distDirName = 'dist';
    }
    const absDistDirName = path.resolve(process.cwd(), distDirName);
    try {
        if (fs.statSync(absDistDirName).isDirectory()) {
            const files = fs.readdirSync(absDistDirName);
            files.forEach((file, index) => {
                const filePath = `${absDistDirName}/${file}`;
                fs.unlinkSync(filePath);
            });
        }
    }
    catch (err) {}
};
