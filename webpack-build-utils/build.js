// Do this as the first thing so that any code reading it knows the right env.
process.env.BABEL_ENV = "production";
process.env.NODE_ENV = "production";
process.env.ASSET_PATH = "/";

console.log("Building for production...");
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("BABEL_ENV:", process.env.BABEL_ENV);

var webpack = require("webpack"),
  path = require("path"),
  fs = require("fs"),
  config = require("../webpack.config"),
  ZipPlugin = require("zip-webpack-plugin");

fs.rmSync(path.resolve(__dirname, "../build"), { recursive: true, force: true });
console.log({ config });

delete config.chromeExtensionBoilerplate;

config.mode = "production";

var packageInfo = JSON.parse(fs.readFileSync("package.json", "utf-8"));

config.plugins = (config.plugins || []).concat(
  new ZipPlugin({
    filename: `${packageInfo.name}-${packageInfo.version}.zip`,
    path: path.join(__dirname, "../", "zip"),
  }),
);

webpack(config, function (err, stats) {
  if (stats) {
    console.log(stats.toString({ colors: true }));
  }
  if (err) throw err;
});
