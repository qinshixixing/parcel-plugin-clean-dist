
module.exports = {
  setupTestFrameworkScriptFile: require("path").join(__dirname, "test-setup.js"),
  testEnvironment: "node",
  testMatch: [
    "**/__tests__/**/*.test.js",
  ],
};
