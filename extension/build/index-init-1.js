
				{
					window.__sveltekit_1q0hkf1 = {
						base: new URL(".", location).pathname.slice(0, -1)
					};

					const element = document.querySelector('body > div');

					Promise.all([
						import("./app/immutable/entry/start.B7BustvI.js"),
						import("./app/immutable/entry/app.CQoSbg3N.js")
					]).then(([kit, app]) => {
						kit.start(app, element, {
							node_ids: [0, 2],
							data: [null,null],
							form: null,
							error: null
						});
					});
				}
			