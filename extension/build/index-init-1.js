
				{
					window.__sveltekit_1sfd2gj = {
						base: new URL(".", location).pathname.slice(0, -1)
					};

					const element = document.querySelector('body > div');

					Promise.all([
						import("./app/immutable/entry/start.c_jiycmS.js"),
						import("./app/immutable/entry/app.BcxZmrdw.js")
					]).then(([kit, app]) => {
						kit.start(app, element, {
							node_ids: [0, 2],
							data: [null,null],
							form: null,
							error: null
						});
					});
				}
			