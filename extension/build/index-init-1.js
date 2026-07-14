
				{
					window.__sveltekit_1j6t1a4 = {
						base: new URL(".", location).pathname.slice(0, -1)
					};

					const element = document.querySelector('body > div');

					Promise.all([
						import("./app/immutable/entry/start._HZ9MdEH.js"),
						import("./app/immutable/entry/app.tfp9LdxZ.js")
					]).then(([kit, app]) => {
						kit.start(app, element, {
							node_ids: [0, 2],
							data: [null,null],
							form: null,
							error: null
						});
					});
				}
			