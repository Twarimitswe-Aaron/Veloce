
				{
					window.__sveltekit_56mf85 = {
						base: ""
					};

					const element = document.querySelector('body > div');

					Promise.all([
						import("/app/immutable/entry/start.DeNnU7B2.js"),
						import("/app/immutable/entry/app.KE55LC-z.js")
					]).then(([kit, app]) => {
						kit.start(app, element);
					});
				}
			