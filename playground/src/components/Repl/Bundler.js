import { create_worker } from "./utils.js";

const workers = new Map();

let uid = 1;

function worker_fn() {
  self.window = self; // egregious hack to get magic-string to work in a worker

  let svelteUrl;

  let fulfil;
  let ready = new Promise(f => (fulfil = f));

  self.addEventListener("message", async event => {
    switch (event.data.type) {
      case "init":
        svelteUrl = event.data.svelteUrl;

        importScripts(`${svelteUrl}/compiler.js`, event.data.rollupUrl);
        fulfil();

        break;

      case "bundle":
        if (event.data.components.length === 0) return;

        await ready;
        const result = await bundle(event.data);
        if (result) {
          postMessage(result);
        }

        break;
    }
  });

  const common_options = {
    dev: true
  };

  let cached = {
    dom: {},
    ssr: {}
  };

  const cache = new Map();
  function fetch_if_uncached(url) {
    if (!cache.has(url)) {
      cache.set(
        url,
        fetch(url)
          .then(r => r.text())
          .catch(err => {
            console.error(err);
            cache.delete(url);
          })
      );
    }

    return cache.get(url);
  }

  async function get_bundle(mode, cache, lookup) {
    let bundle;
    const all_warnings = [];

    const new_cache = {};

    try {
      bundle = await rollup.rollup({
        input: "./App.svexy",
        external: id => {
          if (id === "smelte") return true;

          return false;
        },
        plugins: [
          {
            resolveId(importee, importer) {
              // v3 hack
              if (importee === `svelte`) return `${svelteUrl}/index.mjs`;
              if (importee.startsWith(`svelte/`))
                return `${svelteUrl}/${importee.slice(7)}/index.mjs`;

              if (
                importer &&
                (importer.startsWith(`https://`) ||
                  importer.startsWith(`http://`))
              ) {
                return new URL(`${importee}/index.mjs`, importer).href;
              }

              if (importee.endsWith(".html"))
                importee = importee.replace(/\.html$/, ".svelte");

              if (importee in lookup) return importee;

              throw new Error(
                `Could not resolve "${importee}" from "${importer}"`
              );
            },
            load(id) {
              if (id.startsWith(`https://`) || id.startsWith(`http://`))
                return fetch_if_uncached(id);
              if (id in lookup) return lookup[id].source;
            },
            transform(code, id) {
              if (!/\.svelte$|\.svexy$|svelte-image/.test(id)) return null;
              let name = id
                .replace(/^\.\//, "")
                .replace(/^components\//, "")
                .replace(/\.svelte$|\.svexy$/, "");

              if (id === "svelte-image") {
                name = "Image";
              }

              const result =
                cache[id] && cache[id].code === code
                  ? cache[id].result
                  : svelte.compile(
                      code,
                      Object.assign(
                        {
                          generate: mode,
                          format: "esm",
                          name,

                          filename: name + ".svelte"
                        },
                        common_options
                      )
                    );

              new_cache[id] = { code, result };

              (result.warnings || result.stats.warnings).forEach(warning => {
                // TODO remove stats post-launch
                all_warnings.push({
                  message: warning.message,
                  filename: warning.filename,
                  start: warning.start,
                  end: warning.end
                });
              });

              return result.js;
            }
          }
        ],
        inlineDynamicImports: true,
        onwarn(warning) {
          all_warnings.push({
            message: warning.message
          });
        }
      });
    } catch (error) {
      return { error, bundle: null, cache: new_cache, warnings: all_warnings };
    }

    return { bundle, cache: new_cache, error: null, warnings: all_warnings };
  }

  async function bundle({ id, components }) {
    // console.clear();
    console.log(
      `running Svelte compiler version %c${svelte.VERSION}`,
      "font-weight: bold"
    );

    const lookup = {};
    components.forEach(component => {
      if (component.name === "svelte-image") {
        lookup["svelte-image"] = component;
        return;
      }

      if (component.name === "App") {
        lookup[`./${component.name}.${component.type}`] = component;
        return;
      }

      const path = `components/${component.name}.${component.type}`;
      lookup[path] = component;
    });

    const import_map = new Map();
    let dom;
    let error;

    try {
      dom = await get_bundle("dom", cached.dom, lookup);
      if (dom.error) {
        throw dom.error;
      }

      cached.dom = dom.cache;

      let uid = 1;

      const dom_result = (await dom.bundle.generate({
        format: "iife",
        name: "SvelteComponent",
        globals: id => {
          const name = `import_${uid++}`;
          import_map.set(id, name);
          return name;
        },
        exports: "named",
        sourcemap: true
      })).output[0];

      const ssr = false // TODO how can we do SSR?
        ? await get_bundle("ssr", cached.ssr, lookup)
        : null;

      if (ssr) {
        cached.ssr = ssr.cache;
        if (ssr.error) {
          throw ssr.error;
        }
      }

      const ssr_result = ssr
        ? (await ssr.bundle.generate({
            format: "iife",
            name: "SvelteComponent",
            globals: id => import_map.get(id),
            exports: "named",
            sourcemap: true
          })).output[0]
        : null;

      return {
        id,
        imports: dom_result.imports,
        import_map,
        dom: dom_result,
        ssr: ssr_result,
        warnings: dom.warnings,
        error: null
      };
    } catch (err) {
      const e = error || err;
      delete e.toString;

      return {
        id,
        imports: [],
        import_map,
        dom: null,
        ssr: null,
        warnings: dom.warnings,
        error: Object.assign({}, e, {
          message: e.message,
          stack: e.stack
        })
      };
    }
  }
}

export default class Bundler {
  constructor(svelteUrl, rollupUrl) {
    if (!workers.has(svelteUrl)) {
      const worker = create_worker(worker_fn);
      worker.postMessage({ type: "init", svelteUrl, rollupUrl });
      workers.set(svelteUrl, worker);
    }

    this.worker = workers.get(svelteUrl);

    this.handlers = new Map();

    this.worker.addEventListener("message", event => {
      const handler = this.handlers.get(event.data.id);

      if (handler) {
        // if no handler, was meant for a different REPL
        handler(event.data);
        this.handlers.delete(event.data.id);
      }
    });
  }

  bundle(components) {
    return new Promise(fulfil => {
      const id = uid++;

      this.handlers.set(id, fulfil);

      this.worker.postMessage({
        id,
        type: "bundle",
        components
      });
    });
  }

  destroy() {
    this.worker.terminate();
  }
}
