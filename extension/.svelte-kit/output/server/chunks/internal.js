//#region node_modules/.pnpm/@sveltejs+kit@2.68.0_@sveltejs+vite-plugin-svelte@7.1.2_svelte@5.56.4_vite@8.1.0_jiti@2_1f3daca056e583d22d1f7fd8c32e2f82/node_modules/@sveltejs/kit/src/runtime/app/paths/internal/server.js
var base = "";
var assets = base;
var initial = {
	base,
	assets
};
initial.base;
/**
* @param {{ base: string, assets: string }} paths
*/
function override(paths) {
	base = paths.base;
	assets = paths.assets;
}
function reset() {
	base = initial.base;
	assets = initial.assets;
}
/** @param {string} path */
function set_assets(path) {
	assets = initial.assets = path;
}
/**
* `$env/dynamic/public`
* @type {Record<string, string>}
*/
var public_env = {};
/** @type {(environment: Record<string, string>) => void} */
function set_private_env(environment) {}
/** @type {(environment: Record<string, string>) => void} */
function set_public_env(environment) {
	public_env = environment;
}
//#endregion
//#region node_modules/.pnpm/@sveltejs+kit@2.68.0_@sveltejs+vite-plugin-svelte@7.1.2_svelte@5.56.4_vite@8.1.0_jiti@2_1f3daca056e583d22d1f7fd8c32e2f82/node_modules/@sveltejs/kit/src/runtime/app/env/internal.js
var version = "1783204309042";
var prerendering = false;
function set_building() {}
function set_prerendering() {
	prerendering = true;
}
//#endregion
export { public_env as a, assets as c, reset as d, set_assets as f, version as i, base as l, set_building as n, set_private_env as o, set_prerendering as r, set_public_env as s, prerendering as t, override as u };
