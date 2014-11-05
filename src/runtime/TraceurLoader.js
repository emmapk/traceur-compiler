// Copyright 2012 Traceur Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {isAbsolute, resolveUrl} from '../util/url';
import {Loader} from '../runtime/Loader';
import {LoaderCompiler} from '../runtime/LoaderCompiler';
import {systemjs} from '../runtime/system-map';

var version = __moduleName.slice(0, __moduleName.indexOf('/'));
var uniqueNameCount = 0;

export class TraceurLoader extends Loader {

  /**
   * @param {!Object=} loaderCompiler
   */
  constructor(fileLoader, baseURL, loaderCompiler = new LoaderCompiler()) {
    super(loaderCompiler);
    this.fileLoader_ = fileLoader;
    this.baseURL_ = baseURL && String(baseURL);

    this.moduleStore_ = $traceurRuntime.ModuleStore;
  }

  get baseURL() {
    return this.baseURL_;
  }

  set baseURL(value) {
    this.baseURL_ = String(value);
  }

  get(normalizedName) {
    return this.moduleStore_.get(normalizedName);
  }

  set(normalizedName, module) {
    this.moduleStore_.set(normalizedName, module);
  }

  normalize(name, referrerName, referrerAddress) {
    var normalizedName =
        this.moduleStore_.normalize(name, referrerName, referrerAddress);
    if (typeof systemjs !== 'undefined' && System.map)
      return systemjs.applyMap(System.map, normalizedName, referrerName);

    return normalizedName;
  }

  locate(load) {
    var normalizedModuleName = load.normalizedName;
    load.metadata.traceurOptions = load.metadata.traceurOptions || {};
    var options = load.metadata.traceurOptions;
    var asJS;
    if (options && options.script) {
      asJS = normalizedModuleName;
    } else {
      asJS = normalizedModuleName + '.js';
    }

    var baseURL = load.metadata && load.metadata.baseURL;
    baseURL = baseURL || this.baseURL;

    var referrer = options && options.referrer;
    if (referrer) {
      // eg referrer = 'traceur@0.0.67/bin', baseURL = '/work/traceur/bin'
      // We want to replace the package name part of the normalized name with
      // the root directory from the baseURL.
      var minChars = Math.min(referrer.length, baseURL.length);
      var commonChars = 0;
      for (var i = 0; i < minChars; i++) {
        var aChar = referrer[referrer.length - 1 - i];
        if (aChar === baseURL[baseURL.length - 1 - i])
          commonChars++;
        else
          break;
      }
      if (commonChars) {
        var packageName = referrer.slice(0, -commonChars);
        var rootDirectory = baseURL.slice(0, -commonChars);
        if (asJS.indexOf(packageName) === 0) {
          asJS = asJS.replace(packageName, rootDirectory);
        }
      }

    }

    if (!isAbsolute(asJS)) {
      if (baseURL) {
        load.metadata.baseURL = baseURL;
        asJS = resolveUrl(baseURL, asJS);
      }
    }
    return asJS;
  }

  // The name set into the tree, and used for sourcemaps
  sourceName(load) {
    var options = load.metadata.traceurOptions;
    var sourceName = load.address;
    if (options.sourceMaps) {
      var sourceRoot = this.baseURL;
      if (sourceName) {
        if (sourceRoot && sourceName.indexOf(sourceRoot) === 0) {
          sourceName = sourceName.substring(sourceRoot.length);
        }
      } else {
        sourceName = this.baseURL + String(uniqueNameCount++);
      }

    }
    // TODO(jjb): temp hack until we get rid of toSource
    load.metadata.sourceRoot = this.baseURL;
    return sourceName;
  }

  nameTrace(load) {
    var trace = '';
    if (load.metadata.locateMap) {
      trace += this.locateMapTrace(load);
    }
    var base = load.metadata.baseURL || this.baseURL;
    if (base) {
      trace += this.baseURLTrace(base);
    } else {
      trace += 'No baseURL\n';
    }
    return trace;
  }

  locateMapTrace(load) {
    var map = load.metadata.locateMap;
    return `locate found \'${map.pattern}\' -> \'${map.replacement}\'\n`;
  }

  baseURLTrace(base) {
    return 'locate resolved against base \'' + base + '\'\n';
  }

  fetch(load) {
    return new Promise((resolve, reject) => {
      if (!load)
        reject(new TypeError('fetch requires argument object'));
      else if (!load.address || typeof load.address !== 'string')
        reject(new TypeError('fetch({address}) missing required string.'));
      else
        this.fileLoader_.load(load.address, resolve, reject);
    });
  }

  // Synchronous
  translate(load) {
    return load.source;
  }

  instantiate({name, metadata, address, source, sourceMap}) {
    // We don't implement instantiate but return undefinded asynchronously
    // to match es6-module-loader.
    return new Promise((resolve, reject) => {
      resolve(undefined);
    });
  }

  bundledModule(name) {
    return this.moduleStore_.bundleStore[name];
  }

  /**
    * @param {Array<string>} module names
    * @param {Object} referrerName and address passed to normalize.
    * @return {Promise} fulfilled with array of evaluated modules
    */
  importAll(names, {referrerName, address, metadata} = {}) {
    return Promise.all(names.map((name) => {
      return this.import(name, {referrerName, address, metadata});
    }));
  }

  /**
   * See https://github.com/jorendorff/js-loaders/issues/92
   * loadAsScript - Asynchronously load and run a script. If the script
   * calls Loader.import(),  this can cause modules to be loaded, linked,
   * and evaluated.
   *
   * This function is the same as import(), with one exception: the text of
   * the initial load is parsed to goal 'Script' rather than 'Module'
   *
   * @param {string} name, relative path to js file.
   * @param {Object} referrerName and address passed to normalize.
   * @return {Promise} fulfilled with evaluation result.
   */
  loadAsScript(name, {referrerName, address, metadata = {}} = {}) {
    metadata.traceurOptions = metadata.traceurOptions || {};
    metadata.traceurOptions.script = true;
    return this.internalLoader_.load(name, referrerName, address, metadata).
        then((load) => load.result);
  }

  loadAsScriptAll(names, {referrerName, address, metadata} = {}) {
    return Promise.all(names.map((name) => {
      return this.loadAsScript(name, {referrerName, address, metadata});
    }));
  }

  /**
   * script - Evaluate the source as a 'script'. Same as function module(),
   * but the source is parsed as 'script' rather than 'module'.
   *
   * This function is similar to built-in eval() except that all the Loader
   * callbacks, eg translate() are applied before evaluation.
   *
   * src may import modules, but if it directly or indirectly imports a module
   * that is not already loaded, a SyntaxError is thrown.
   *
   * @param {string} source The source code to eval.
   * @param {Object} name, referrerName and address passed to normalize.
   * @return {Promise} fulfilled with evaluation result.

   */
  script(source, {name, referrerName, address, metadata} = {}) {
    return this.internalLoader_.script(source, name, referrerName, address,
        metadata);
  }

  semVerRegExp_() {
    return /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+)?$/;
  }

  /**
   * @param {string} normalizedName, eg traceur@0.0.13/...
   * @return {Object} 3 properties, eg traceur@, traceur@0, traceur@0.0,
   *   all set to the first segment of the normalizedName.
   */
  semverMap(normalizedName) {
    var slash = normalizedName.indexOf('/');
    var version = normalizedName.slice(0, slash);
    var at = version.indexOf('@');
    if (at !== -1) {
      var semver = version.slice(at + 1);
      var m = this.semVerRegExp_().exec(semver);
      if (m) {
        var major = m[1];
        var minor = m[2];
        var packageName = version.slice(0, at);
        var map = Object.create(null);
        map[packageName] = version;
        map[packageName + '@' + major] = version;
        map[packageName + '@' + major + '.' + minor] = version;
      }
    }
    return map;
  }

  get version() {
    return version;
  }

  /**
   * @param {string} filename or url, the output address.
   * @return {Sourcemap}
   */
  getSourceMap(filename) {
    return this.internalLoader_.getSourceMap(filename);
  }

  /**
   * @param {string} normalized name of module
   * @param {Array<string>} unnormalized dependency names.
   * @param {Function<Array<string>>} factory takes array of normalized names.
   */
  register(normalizedName, deps, factoryFunction) {
    $traceurRuntime.ModuleStore.register(normalizedName, deps, factoryFunction);
  }

}
