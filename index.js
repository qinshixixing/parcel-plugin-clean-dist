const {Reporter} = require('@parcel/plugin');
const {cleanDist, loadConfig} = require('./lib/clean');

module.exports = new Reporter({
  async report({event, options, logger}) {
    if (event.type !== 'buildSuccess') {
      return;
    }

    const config = await loadConfig(options.inputFS, options.projectRoot);
    if (options.mode !== 'production' && !config.watch) {
      return;
    }

    const {removed, refusals} = await cleanDist({
      bundles: event.bundleGraph.getBundles(),
      outputFS: options.outputFS,
      projectRoot: options.projectRoot,
      exclude: config.exclude,
    });

    for (const message of refusals) {
      logger.error({message});
    }

    if (removed > 0) {
      logger.info({
        message: `Removed ${removed} stale ${
          removed === 1 ? 'file' : 'files'
        } from the output directory.`,
      });
    }
  },
});
