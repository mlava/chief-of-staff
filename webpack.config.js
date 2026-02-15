const path = require("path");

module.exports = {
    entry: "./src/index.js",
    output: {
        filename: "extension.js",
        path: __dirname,
        library: {
            type: "module",
        },
    },
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    fallback: {
      // The MCP SDK may try to import Node modules — 
      // these tell webpack to skip them or provide browser polyfills
      "child_process": false,
      "fs": false,
      "net": false,
      "tls": false,
      "path": false,
      "os": false,
      "crypto": false,
      "stream": require.resolve("stream-browserify"),
      "buffer": require.resolve("buffer/"),
      "url": require.resolve("url/"),
      "http": require.resolve("stream-http"),
      "https": require.resolve("https-browserify"),
      "zlib": require.resolve("browserify-zlib"),
    }
  },
  experiments: {
    outputModule: true,
  },
  mode: "development",
  externals: {
    // Roam APIs are available globally at runtime
    "roam-client": "roam-client",
  },
};