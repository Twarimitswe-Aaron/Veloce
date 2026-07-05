
				{
					window.__sveltekit_1ftx93m = {
						base: ""
					};

					const element = document.querySelector('body > div');

					Promise.all([
						import("/app/immutable/entry/start.CFFkqP3k.js"),
						import("/app/immutable/entry/app.BTcNKsjJ.js")
					]).then(([kit, app]) => {
						kit.start(app, element);
					});
				}
			