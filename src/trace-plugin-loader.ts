/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Logger} from '@google-cloud/common';
import Module = require('module');
import * as path from 'path';
import * as semver from 'semver';
import * as shimmer from 'shimmer';
import * as util from './util';
import {TraceAgent, TraceAgentConfig} from './trace-api';
import {Patch, Intercept, Instrumentation, Plugin} from './plugin-types';

/**
 * An interface representing config options read by the plugin loader, which
 * includes TraceAgent configuration as well.
 */
export interface PluginLoaderConfig extends TraceAgentConfig {
  plugins: {[pluginName: string]: string;};
}

interface InternalPatch<T> extends Patch<T> {
  file: string;
  module?: T;
}

interface InternalIntercept<T> extends Intercept<T> {
  file: string;
  module?: T;
}

type InternalInstrumentation<T> = InternalPatch<T>|InternalIntercept<T>;

interface InternalPlugin {
  file: string;
  patches:
      {[patchName: string]: {[file: string]: InternalInstrumentation<any>;}};
  agent: TraceAgent;
}

interface PluginStore {
  [pluginName: string]: InternalPlugin;
}

// type guards

function isPatch<T>(obj: Instrumentation<T>): obj is Patch<T> {
  return !!(obj as Patch<T>).patch;
}

function isIntercept<T>(obj: Instrumentation<T>): obj is Intercept<T> {
  return !!(obj as Intercept<T>).intercept;
}

function isInternalPatch<T>(obj: InternalInstrumentation<T>):
    obj is InternalPatch<T> {
  return !!(obj as InternalPatch<T>).patch;
}

function isInternalIntercept<T>(obj: InternalInstrumentation<T>):
    obj is InternalIntercept<T> {
  return !!(obj as InternalIntercept<T>).intercept;
}

let plugins: PluginStore = Object.create(null);
let intercepts: {[moduleName: string]: {interceptedValue: any}} =
    Object.create(null);
let activated = false;
// TODO(kjin): Make plugin loader a singleton, so we can avoid shadowing.
// tslint:disable-next-line:variable-name
let logger_: Logger;

function checkLoadedModules(): void {
  for (const moduleName of Object.keys(plugins)) {
    // \\ is benign on unix and escapes \\ on windows
    const regex =
        new RegExp('node_modules\\' + path.sep + moduleName + '\\' + path.sep);
    for (const file of Object.keys(require.cache)) {
      if (file.match(regex)) {
        logger_.error(
            moduleName + ' tracing might not work as ' + file +
            ' was loaded before the trace agent was initialized.');
        break;
      }
    }
  }
  if (process._preload_modules && process._preload_modules.length > 0) {
    const first = process._preload_modules[0];
    if (first !== '@google-cloud/trace-agent') {
      logger_.error(
          'Tracing might not work as ' + first +
          ' was loaded with --require before the trace agent was initialized.');
    }
  }
}

function checkPatch<T>(patch: Instrumentation<T>) {
  if (!(patch as Patch<T>).patch && !(patch as Intercept<T>).intercept) {
    throw new Error(
        'Plugin for ' + patch.file + ' doesn\'t patch ' +
        'anything.');
  } else if ((patch as Patch<T>).patch && (patch as Intercept<T>).intercept) {
    throw new Error(
        'Plugin for ' + patch.file + ' has ' +
        'both intercept and patch functions.');
  } else if ((patch as Patch<T>).unpatch && (patch as Intercept<T>).intercept) {
    logger_.warn(
        'Plugin for ' + patch.file + ': unpatch is not compatible ' +
        'with intercept.');
  } else if ((patch as Patch<T>).patch && !(patch as Patch<T>).unpatch) {
    logger_.warn(
        'Plugin for ' + patch.file + ': patch method given without ' +
        'accompanying unpatch.');
  }
}

export function activate(logger: Logger, config: PluginLoaderConfig): void {
  if (activated) {
    logger.error('Plugins activated more than once.');
    return;
  }
  activated = true;

  logger_ = logger;

  const pluginConfig = config.plugins;
  for (const moduleName of Object.keys(pluginConfig)) {
    if (!pluginConfig[moduleName]) {
      continue;
    }
    const agent = new TraceAgent(moduleName);
    agent.enable(logger, config);
    plugins[moduleName] = {
      file: pluginConfig[moduleName],
      patches: {},
      agent: agent
    };
  }

  checkLoadedModules();

  // hook into Module._load so that we can hook into userspace frameworks
  shimmer.wrap(
      Module, '_load',
      (originalModuleLoad: typeof Module._load): typeof Module._load => {
        function loadAndPatch(
            instrumentation: InternalPlugin, moduleRoot: string,
            version: string): any {
          let patchSet = instrumentation.patches[moduleRoot];
          if (!patchSet) {
            // Load the plugin object
            const plugin: Plugin =
                originalModuleLoad(instrumentation.file, module, false);
            patchSet = {};
            if (semver.valid(version)) {
              plugin.forEach((patch) => {
                if (!patch.versions ||
                    semver.satisfies(version, patch.versions)) {
                  const file = patch.file || '';
                  if (isPatch(patch)) {
                    patchSet[file] = {
                      file: file,
                      patch: patch.patch,
                      unpatch: patch.unpatch
                    };
                  }
                  if (isIntercept(patch)) {
                    patchSet[file] = {file: file, intercept: patch.intercept};
                  }
                  // The conditionals exhaustively cover types for the patch
                  // object, but throw an error in JavaScript anyway
                  checkPatch(patch);
                }
              });
            }
            if (Object.keys(patchSet).length === 0) {
              logger.warn(
                  moduleRoot + ': version ' + version + ' not supported ' +
                  'by plugin.');
            }
            instrumentation.patches[moduleRoot] = patchSet;
          }

          for (const file of Object.keys(patchSet)) {
            const patch = patchSet[file];
            const loadPath =
                moduleRoot ? path.join(moduleRoot, patch.file) : patch.file;
            if (!patch.module) {
              patch.module = originalModuleLoad(loadPath, module, false);
            }
            if (isInternalPatch(patch)) {
              patch.patch(patch.module, instrumentation.agent);
            }
            if (isInternalIntercept(patch)) {
              patch.module =
                  patch.intercept(patch.module, instrumentation.agent);
              intercepts[loadPath] = {interceptedValue: patch.module};
            }
          }
          const rootPatch = patchSet[''];
          if (rootPatch && isInternalIntercept(rootPatch)) {
            return rootPatch.module;
          } else {
            return null;
          }
        }

        function moduleAlreadyPatched(
            instrumentation: InternalPlugin, moduleRoot: string) {
          return instrumentation.patches[moduleRoot];
        }

        // Future requires get patched as they get loaded.
        return function Module_load(
            this: any, request: string, parent?: NodeModule,
            isMain?: boolean): any {
          const instrumentation = plugins[request];
          if (instrumentation) {
            const moduleRoot = util.findModulePath(request, parent);
            const moduleVersion =
                util.findModuleVersion(moduleRoot, originalModuleLoad);
            if (moduleAlreadyPatched(instrumentation, moduleRoot)) {
              return originalModuleLoad.apply(this, arguments);
            }
            logger.info('Patching ' + request + ' at version ' + moduleVersion);
            const patchedRoot =
                loadAndPatch(instrumentation, moduleRoot, moduleVersion);
            if (patchedRoot !== null) {
              return patchedRoot;
            }
          } else {
            const modulePath =
                Module._resolveFilename(request, parent).replace('/', path.sep);
            if (intercepts[modulePath]) {
              return intercepts[modulePath].interceptedValue;
            }
          }
          return originalModuleLoad.apply(this, arguments);
        };
      });
}

export function deactivate(): void {
  if (activated) {
    activated = false;
    for (const moduleName of Object.keys(plugins)) {
      const instrumentation = plugins[moduleName];
      instrumentation.agent.disable();
      for (const moduleRoot of Object.keys(instrumentation.patches)) {
        const patchSet = instrumentation.patches[moduleRoot];
        for (const file of Object.keys(patchSet)) {
          const patch = patchSet[file];
          if (isInternalPatch(patch) && patch.unpatch !== undefined) {
            logger_.info('Unpatching ' + moduleName);
            patch.unpatch(patch.module);
          }
        }
      }
    }
    plugins = Object.create(null);
    intercepts = Object.create(null);

    // unhook module.load
    shimmer.unwrap(Module, '_load');
  }
}
