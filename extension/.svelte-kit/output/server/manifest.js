export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "app",
	appPath: "app",
	assets: new Set(["background.js","content.js","favicon.svg","icons/icon-128.png","icons/icon-16.png","icons/icon-48.png","inject-intercept.js","manifest.json","offscreen.html","offscreen.js","robots.txt","sites/instagram.js","sites/mediafire.js","sites/omnisave.js","sites/registry.js","sites/youtube.js"]),
	mimeTypes: {".js":"text/javascript",".svg":"image/svg+xml",".png":"image/png",".json":"application/json",".html":"text/html",".txt":"text/plain"},
	_: {
		client: {start:"app/immutable/entry/start.c_jiycmS.js",app:"app/immutable/entry/app.BcxZmrdw.js",imports:["app/immutable/entry/start.c_jiycmS.js","app/immutable/chunks/vozIe2Te.js","app/immutable/chunks/DExilm0R.js","app/immutable/chunks/D2gDu4pI.js","app/immutable/entry/app.BcxZmrdw.js","app/immutable/chunks/DExilm0R.js","app/immutable/chunks/CV77j2BA.js","app/immutable/chunks/xihTtKlq.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js')),
			__memo(() => import('./nodes/1.js'))
		],
		remotes: {
			
		},
		routes: [
			
		],
		prerendered_routes: new Set(["/"]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();
