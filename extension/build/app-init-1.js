
				{
					window.__sveltekit_6ws708 = {
						base: ""
					};

					const element = document.querySelector('body > div');

					Promise.all([
						import("/app/immutable/entry/start.CixMQgJc.js"),
						import("/app/immutable/entry/app.C-r9y0es.js")
					]).then(([kit, app]) => {
						kit.start(app, element);
					});
				}
			