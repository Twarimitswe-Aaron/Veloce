import "../../chunks/index-server.js";
import "../../chunks/wsClient.js";
//#region src/routes/+layout.svelte
function _layout($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { children } = $$props;
		$$renderer.push(`<div class="min-h-screen flex flex-col" style="background:#001833;color:#fff"><header class="border-b border-white/25 px-4 py-3"><h1 class="text-base font-semibold tracking-wide">Veloce</h1> <p class="text-[10px] uppercase tracking-widest opacity-60 mt-0.5">Download Manager</p></header> <main class="flex-1 p-4 overflow-y-auto">`);
		children($$renderer);
		$$renderer.push(`<!----></main></div>`);
	});
}
//#endregion
export { _layout as default };
