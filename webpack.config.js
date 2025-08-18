// webpack.config.js
var webpack = require("webpack"),
  path = require("path"),
  fileSystem = require("fs-extra"),
  env = require("./webpack-build-utils/env"),
  CopyWebpackPlugin = require("copy-webpack-plugin"),
  HtmlWebpackPlugin = require("html-webpack-plugin"),
  TerserPlugin = require("terser-webpack-plugin");
var ReactRefreshWebpackPlugin = require("@pmmmwh/react-refresh-webpack-plugin");
var NodePolyfillPlugin = require("node-polyfill-webpack-plugin");

const ASSET_PATH = process.env.ASSET_PATH || "/";
const isDevelopment = process.env.NODE_ENV !== "production";

var alias = {};
var secretsPath = path.join(__dirname, "secrets." + env.NODE_ENV + ".js");
if (fileSystem.existsSync(secretsPath)) alias["secrets"] = secretsPath;

var fileExtensions = ["jpg", "jpeg", "png", "gif", "eot", "otf", "svg", "ttf", "woff", "woff2"];

const commonRules = [
  {
    test: /\.(css|scss)$/,
    use: [
      { loader: "style-loader" },
      { loader: "css-loader", options: { importLoaders: 1 } },
      { loader: "postcss-loader" },
      {
        loader: "sass-loader",
        options: { sourceMap: true, sassOptions: { silenceDeprecations: ["legacy-js-api"] } },
      },
    ],
  },
  {
    test: new RegExp(".(" + fileExtensions.join("|") + ")$"),
    type: "asset/resource",
    exclude: /node_modules/,
  },
  { test: /\.html$/, loader: "html-loader", exclude: /node_modules/ },
  {
    test: /\.(ts|tsx)$/,
    exclude: /node_modules/,
    use: [{ loader: require.resolve("ts-loader"), options: { transpileOnly: isDevelopment } }],
  },
  {
    test: /\.(js|jsx)$/,
    use: [
      { loader: "source-map-loader" },
      {
        loader: require.resolve("babel-loader"),
        options: {
          plugins: [isDevelopment && require.resolve("react-refresh/babel")].filter(Boolean),
        },
      },
    ],
    exclude: /node_modules/,
  },
  {
    test: /\.wasm$/,
    type: "webassembly/async",
    generator: { filename: "wasm/[name][ext]" },
  },
];

const commonResolve = {
  alias: {
    ...alias,
    koffi: false,
    re2: false,
    worker_threads: path.resolve(__dirname, "src/utils/mocks/worker-threads-mock.js"),
    "node:url": require.resolve("url/"),
    "react-native-tcp-socket": false,
    "process/browser": require.resolve("process/browser.js"),
    canvas: false,
    jsdom: path.resolve(__dirname, "src/utils/mocks/jsdom-mock.js"),
    ws: path.resolve(__dirname, "src/utils/websocket-polyfill.js"),
  },
  extensions: fileExtensions.map((e) => "." + e).concat([".js", ".jsx", ".ts", ".tsx", ".css"]),
  fallback: {
    stream: require.resolve("stream-browserify"),
    buffer: require.resolve("buffer/"),
    crypto: require.resolve("crypto-browserify"),
    https: require.resolve("https-browserify"),
    http: require.resolve("stream-http"),
    path: require.resolve("path-browserify"),
    zlib: require.resolve("browserify-zlib"),
    assert: require.resolve("assert/"),
    url: require.resolve("url/"),
    util: require.resolve("util/"),
    os: require.resolve("os-browserify/browser"),
    vm: require.resolve("vm-browserify"),
    constants: require.resolve("constants-browserify"),
    fs: false,
    net: false,
    tls: false,
    child_process: false,
    worker_threads: false,
    readline: false,
    koffi: false,
    re2: false,
  },
};

const DROP_CONSOLE = process.env.DROP_CONSOLE === "false";

const commonOptimization = {
  minimize: true,
  minimizer: [
    new TerserPlugin({
      extractComments: false,
      terserOptions: { compress: { drop_console: DROP_CONSOLE } },
    }),
  ],
  splitChunks: false,
};

const commonPlugins = [
  new webpack.ProgressPlugin(),
  new webpack.EnvironmentPlugin(["NODE_ENV"]),
  new webpack.DefinePlugin({
    "process.env.NODE_ENV": JSON.stringify(env.NODE_ENV),
    "process.env.DEBUG": JSON.stringify(process.env.DEBUG || false),
    "process.env.EXTENSION_ID": JSON.stringify(env.EXTENSION_ID),
  }),
  new NodePolyfillPlugin(),
  new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"], process: "process/browser.js" }),
  new webpack.IgnorePlugin({ resourceRegExp: /^node:url$/ }),
];

/**
 * 1) EXTENSION CONFIG (content: UMD, interceptor/offscreen: IIFE-like)
 *    - Builds everything EXCEPT background and SDK.
 */
const extensionConfig = {
  name: "extension-classic",
  mode: process.env.NODE_ENV || "development",
  devtool: isDevelopment ? "cheap-module-source-map" : "source-map",
  ignoreWarnings: [
    /Circular dependency between chunks with runtime/,
    /ResizeObserver loop completed with undelivered notifications/,
    /Should not import the named export/,
    /Sass @import rules/,
    /Global built-in functions are deprecated/,
    /repetitive deprecation warnings omitted/,
    /Critical dependency: the request of a dependency is an expression/,
    /Module parse failed: Unexpected character/,
    /Can't resolve 'worker_threads'/,
    /Can't resolve '\.node'/,
    /Can't resolve 'fs'/,
    /Can't resolve 'child_process'/,
    /node:url/,
  ],
  entry: {
    // UMD for content
    "content/content": {
      import: path.join(__dirname, "src", "content", "content.js"),
      library: { type: "umd", name: "ReclaimContent" },
    },
    // No library → classic script (IIFE-like)
    "interceptor/network-interceptor": path.join(
      __dirname,
      "src",
      "interceptor",
      "network-interceptor.js",
    ),
    "interceptor/injection-scripts": path.join(
      __dirname,
      "src",
      "interceptor",
      "injection-scripts.js",
    ),
    offscreen: path.join(__dirname, "src", "offscreen", "offscreen.js"),
  },
  output: {
    filename: (pathData) => {
      const name = pathData.chunk?.name;
      if (name === "offscreen") {
        return "offscreen/offscreen.bundle.js"; // folder + filename
      }
      return "[name].bundle.js";
    },
    path: path.resolve(__dirname, "build"),
    clean: false, // clean only once (here)
    publicPath: ASSET_PATH,
    assetModuleFilename: "[name][ext]",
    chunkFilename: "[name].bundle.js",
  },
  module: { rules: commonRules },
  experiments: { asyncWebAssembly: true, syncWebAssembly: true, topLevelAwait: true }, // no outputModule here
  resolve: commonResolve,
  optimization: commonOptimization,
  plugins: [
    ...commonPlugins,
    new CopyWebpackPlugin({
      patterns: [
        { from: "public", to: path.join(__dirname, "build"), force: true, noErrorOnMissing: true },
        {
          from: "src/content/components/reclaim-provider-verification-popup.css",
          to: path.join(__dirname, "build", "content", "components"),
          force: true,
        },
        {
          from: "src/content/components/reclaim-provider-verification-popup.html",
          to: path.join(__dirname, "build", "content", "components"),
          force: true,
        },
        {
          from: "src/scripts/download-circuits.js",
          to: path.join(__dirname, "build", "scripts"),
          force: true,
        },
        {
          from: "src/scripts/install-assets.js",
          to: path.join(__dirname, "build", "scripts"),
          force: true,
        },
      ],
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, "src", "offscreen", "offscreen.html"),
      filename: "offscreen/offscreen.html",
      inject: false,
      minify: false,
      templateParameters: {
        scriptPath: "./offscreen.bundle.js",
      },
      templateContent: ({ htmlWebpackPlugin, plugin }) => {
        const fs = require("fs");
        const ejs = require("ejs");
        const raw = fs.readFileSync(
          path.join(__dirname, "src", "offscreen", "offscreen.html"),
          "utf8",
        );
        return ejs.render(raw, {
          scriptPath: "./offscreen.bundle.js",
        });
      },
    }),
  ].filter(Boolean),
  infrastructureLogging: { level: "info" },
  devServer: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
};

/**
 * 2) BACKGROUND + SDK ESM CONFIG (ES modules) - MV3
 *    - background as ES module
 *    - SDK as ES module library
 */
const backgroundEsmConfig = {
  name: "background-esm-mv3",
  mode: process.env.NODE_ENV || "development",
  devtool: isDevelopment ? "cheap-module-source-map" : "source-map",
  entry: {
    "background/background": { import: path.join(__dirname, "src", "background", "background.js") },
    ReclaimExtensionSDK: {
      import: path.join(__dirname, "src", "ReclaimExtensionSDK.js"),
      library: { type: "module" },
    },
  },
  output: {
    filename: "[name].bundle.js",
    path: path.resolve(__dirname, "build"),
    clean: false, // don't wipe out files from the first build
    publicPath: ASSET_PATH,
    assetModuleFilename: "[name][ext]",
    chunkFilename: "[name].bundle.js",
    module: true,
  },
  module: { rules: commonRules },
  experiments: {
    asyncWebAssembly: true,
    syncWebAssembly: true,
    topLevelAwait: true,
    outputModule: true,
  },
  resolve: commonResolve,
  optimization: commonOptimization,
  plugins: [...commonPlugins].filter(Boolean),
  infrastructureLogging: { level: "info" },
};

/**
 * 3) BACKGROUND + SDK COMMONJS CONFIG (CommonJS) - MV2/Firefox
 *    - background as CommonJS
 *    - SDK as CommonJS library
 */
const backgroundCommonJsConfig = {
  name: "background-commonjs-mv2",
  mode: process.env.NODE_ENV || "development",
  devtool: isDevelopment ? "cheap-module-source-map" : "source-map",
  entry: {
    "background/background-mv2": {
      import: path.join(__dirname, "src", "background", "background.js"),
    },
    "ReclaimExtensionSDK-mv2": {
      import: path.join(__dirname, "src", "ReclaimExtensionSDK.js"),
      library: { type: "commonjs2" },
    },
  },
  output: {
    filename: "[name].bundle.js",
    path: path.resolve(__dirname, "build"),
    clean: false,
    publicPath: ASSET_PATH,
    assetModuleFilename: "[name][ext]",
    chunkFilename: "[name].bundle.js",
  },
  module: { rules: commonRules },
  experiments: { asyncWebAssembly: true, syncWebAssembly: true },
  resolve: commonResolve,
  optimization: commonOptimization,
  plugins: [...commonPlugins].filter(Boolean),
  infrastructureLogging: { level: "info" },
};

module.exports = [extensionConfig, backgroundEsmConfig, backgroundCommonJsConfig];
