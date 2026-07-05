import * as universal from '../entries/pages/_layout.ts.js';

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_layout.svelte.js')).default;
export { universal };
export const universal_id = "src/routes/+layout.ts";
export const imports = ["app/immutable/nodes/0.DNCkt-3f.js","app/immutable/chunks/DExilm0R.js","app/immutable/chunks/xihTtKlq.js","app/immutable/chunks/Cv4cjtV8.js","app/immutable/chunks/D2gDu4pI.js"];
export const stylesheets = ["app/immutable/assets/0.CnWHPfMU.css"];
export const fonts = [];
