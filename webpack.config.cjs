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
  module: {
    rules: [
      {
        test: /\.jsx$/,
        loader: "esbuild-loader",
        options: {
          // JSX compiles to the lazy h()/Frag helpers from onboarding-ui.jsx
          // (window.React resolved at render time — never bundled).
          loader: "jsx",
          jsx: "transform",
          jsxFactory: "h",
          jsxFragment: "Frag",
          target: "es2020",
        },
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
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