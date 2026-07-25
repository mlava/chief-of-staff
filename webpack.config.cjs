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
  // React comes from Roam at runtime: `import React from "react"` in source
  // resolves to window.React in the bundle (same pattern as RoamJS extensions).
  // The react/react-dom devDependencies exist only for node tests and editor
  // tooling — nothing React ships in extension.js.
  externals: {
    react: "React",
    "react-dom": "ReactDOM",
    "react-dom/client": "ReactDOM",
  },
  externalsType: "window",
  module: {
    rules: [
      {
        test: /\.jsx$/,
        loader: "esbuild-loader",
        options: {
          // Classic JSX transform: React.createElement / React.Fragment
          // (esbuild defaults), with React imported per file.
          loader: "jsx",
          jsx: "transform",
          target: "es2020",
        },
      },
    ],
  },
  resolve: {
    extensions: [".js", ".jsx"],
    fallback: {
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
  mode: "production"
};